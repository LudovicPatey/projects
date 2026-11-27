<?php
declare(strict_types=1);

namespace App;

use App\Controllers\AiTaskController;
use App\Controllers\FactController;
use App\Controllers\NotationController;

/**
 * Maintenance sweeps. Upkeep that no one waits for, rewriting facts in the project notation, checking the sources of cited
 * results and consolidating, is not one task per fact. A sweep is one task per kind and project: it is queued once the project
 * has been quiet for a while, at most so often, and picks what is stale when a client takes it, a batch at a time. What a sweep
 * leaves is taken by the next. The server decides this when a client asks for work: no cron.
 *
 * Three sweeps take decisions that would otherwise wait for people: "check" has a second AI compare each rewrite in the project
 * notation with the original, "second" has another AI reading the proposals of the consolidation it was not sure enough to
 * apply, applying those it agrees with and dropping the others, and "symbols" settles the symbols several facts define and the
 * project notation does not have yet: global, local, or another spelling of an entry. People can overrule all three.
 *
 * "review" referees the proofs nobody reviewed, and "symbols" also types the parameters of entries nobody typed.
 *
 * Settings, in minutes or hours, in config.php under "sweeps": quiet_minutes (30), check_minutes (5), rewrite_hours (1),
 * source_hours (1), check_hours (1), second_hours (1), symbols_hours (1), review_hours (1), review (true; false turns proof reviews off),
 * consolidate_hours (24; 0 consolidates only after extractions).
 */
final class Sweeps
{
    /** A sweep's kind of task. */
    public const KINDS = ['rewrite' => 'notation', 'source' => 'source_check', 'check' => 'rewrite_check', 'second' => 'second_reading', 'symbols' => 'consolidate', 'review' => 'proof_review', 'repair' => 'proof_repair', 'recheck' => 'repair_check', 'fix' => 'statement_fix', 'fixcheck' => 'fix_check', 'relink' => 'relink', 'relcheck' => 'relink_check'];
    /** At most this many facts in one session, and this much text to rewrite. */
    public const REWRITE_BATCH = 12;
    public const REWRITE_CHARS = 40000;
    public const SOURCE_BATCH = 10;
    /** Rewrites compared in one session, and the text they may hold, the original and the rewrite together. */
    public const CHECK_BATCH = 12;
    public const CHECK_CHARS = 60000;
    /** Proposals read again in one session. */
    public const SECOND_BATCH = 25;
    /** Symbols that several facts define, with no entry of the project notation yet, settled in one session. */
    public const SYMBOLS_BATCH = 30;
    /** Proofs refereed in one session, and the text they may hold with their dependencies. */
    public const REVIEW_BATCH = 6;
    public const REVIEW_CHARS = 50000;
    /** Entries whose parameters have no type yet, typed in the same session. */
    public const TYPES_BATCH = 30;
    private const BATCH = ['rewrite' => self::REWRITE_BATCH, 'source' => self::SOURCE_BATCH, 'check' => self::CHECK_BATCH, 'second' => self::SECOND_BATCH, 'symbols' => self::SYMBOLS_BATCH, 'review' => self::REVIEW_BATCH, 'repair' => 3, 'recheck' => 3, 'fix' => 1, 'fixcheck' => 1, 'relink' => 4, 'relcheck' => 4];

    private static function setting(string $key, float $default): float
    {
        return (float)Config::get("sweeps.$key", $default);
    }

    /**
     * Queues the sweeps that are due in a project, at most every check_minutes. Called when a client asks for work, and when the
     * AI page is opened. @return list<string> the sweeps queued
     */
    public static function due(int $pid): array
    {
        $now = time();
        $checked = Db::value('SELECT sweeps_checked_at FROM projects WHERE id = ?', [$pid]);
        if ($checked && strtotime((string)$checked . ' UTC') > $now - 60 * self::setting('check_minutes', 5)) return [];
        Db::update('projects', ['sweeps_checked_at' => Db::now()], 'id = :id', ['id' => $pid]);
        ProofRepair::ensure($pid); // flaws AI reviews found before repairs existed get theirs
        // Quiet: no fact for a while, and no extraction adding some. A large extraction then makes one sweep, not ten.
        $last = Db::value('SELECT MAX(created_at) FROM facts WHERE project_id = ?', [$pid]);
        if ($last && strtotime((string)$last . ' UTC') > $now - 60 * self::setting('quiet_minutes', 30)) return [];
        if (Db::value("SELECT 1 FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND status IN ('pending', 'running')", [$pid])) return [];
        $out = [];
        foreach (array_keys(self::KINDS) as $s) {
            if (self::open($pid, $s) || !self::rested($pid, $s) || !self::stale($pid, $s)) continue;
            AiTaskController::queueSweep($pid, $s);
            $out[] = $s;
        }
        // The whole database, read again when it changed since the last consolidation.
        $every = self::setting('consolidate_hours', 24); // 0: only after extractions
        $lastCons = Db::value("SELECT MAX(COALESCE(finished_at, created_at)) FROM ai_tasks WHERE project_id = ? AND kind = 'consolidate' AND (source_type IS NULL OR source_type <> 'sweep')", [$pid]);
        if ($every > 0 && (!$lastCons || strtotime((string)$lastCons . ' UTC') <= $now - 3600 * $every)) {
            if (AiTaskController::queueConsolidation($pid)) $out[] = 'consolidate';
        }
        return $out;
    }

    /** A sweep of this kind waits or runs. */
    public static function open(int $pid, string $sweep): ?int
    {
        $id = Db::value("SELECT id FROM ai_tasks WHERE project_id = ? AND kind = ? AND source_type = 'sweep' AND status IN ('pending', 'running')", [$pid, self::KINDS[$sweep]]);
        return $id ? (int)$id : null;
    }

    /**
     * The last sweep of this kind ended long enough ago, or it did a full batch and work is left: it carries on. A batch that stopped
     * at its size limit, long facts, is full too: the backlog after a change of notation is not taken a few facts an hour.
     */
    private static function rested(int $pid, string $sweep): bool
    {
        $last = Db::one("SELECT status, finished_at, result_json, snapshot_json FROM ai_tasks WHERE project_id = ? AND kind = ? AND source_type = 'sweep' AND status IN ('done', 'failed') ORDER BY id DESC LIMIT 1", [$pid, self::KINDS[$sweep]]);
        if (!$last) return true;
        $result = json_decode((string)$last['result_json'], true) ?: [];
        $snap = json_decode((string)$last['snapshot_json'], true) ?: [];
        if (!empty($snap['full']) && $last['status'] === 'done') return true; // a failed one rests, so that it does not fail again at once
        $did = max(count($result['fact_ids'] ?? []), count($result['suggestion_ids'] ?? []), count($snap['symbols'] ?? []), count($snap['types'] ?? []));
        if ($did >= self::BATCH[$sweep]) return true;
        return strtotime((string)$last['finished_at'] . ' UTC') <= time() - 3600 * self::setting($sweep . '_hours', 1);
    }

    private static function stale(int $pid, string $sweep): bool
    {
        return (bool)match ($sweep) {
            // Rewrites wait while the notation still has symbols to settle: a fact rewritten now would be rewritten again once they
            // are. A member who asks for the rewrites starts them at once all the same (NotationController::rephraseAll).
            'rewrite' => self::rewriteCandidates($pid) && !self::open($pid, 'symbols') && !self::symbolCandidates($pid), 'source' => self::sourceCandidates($pid),
            'check' => self::checkCandidates($pid), 'second' => self::secondCandidates($pid), 'review' => self::reviewCandidates($pid), 'symbols' => self::symbolCandidates($pid) || self::typeCandidates($pid),
            'repair' => ProofRepair::due($pid, 'repair'), 'recheck' => ProofRepair::due($pid, 'check'),
            'fix' => StatementFix::due($pid, 'revise'), 'fixcheck' => StatementFix::due($pid, 'verify'),
            'relink' => Relink::due($pid, 'relink'), 'relcheck' => Relink::due($pid, 'relcheck'),
        };
    }

    /**
     * What the notation still leaves to people: symbols that several facts define with no entry, and entries still proposed.
     * A symbol a sweep read without settling is read once more. @return list<string> their notion keys, the most used first
     */
    public static function symbolCandidates(int $pid): array
    {
        $tried = self::tried($pid, 'consolidate', null);
        $out = [];
        foreach (NotationController::shared($pid, 2, 1000) as $x) {
            $k = NotationController::notionKey($x['symbol']);
            // Wordings no sweep grouped yet, such as those read before sweeps grouped them, earn one more reading.
            $times = ($tried[$k] ?? 0) - ($x['unclassified'] && !$x['classes'] && !isset($tried['grouped:' . $k]) ? 1 : 0);
            if (($x['entry'] === null || $x['entry']['status'] === 'proposed') && $times < 2) $out[$k] = true;
        }
        foreach (Db::all("SELECT symbol FROM notations WHERE project_id = ? AND status = 'proposed' ORDER BY id", [$pid]) as $n) {
            $k = NotationController::notionKey($n['symbol']);
            if (($tried[$k] ?? 0) < 2) $out[$k] = true;
        }
        return array_keys($out);
    }

    /**
     * The AI passes a fact still waits for, so that people see it is not in its final state and do not fix by hand what an AI is about
     * to do: its rewrite in the project notation, the check of that rewrite, the check of a cited result against its source, the review
     * of its proof. `open`: a sweep of that kind waits for a client or runs. @return list<array{sweep: string, open: bool}>
     */
    public static function pendingForFact(int $pid, int $fid): array
    {
        $f = Db::one('SELECT id, deleted_at, retracted_at FROM facts WHERE id = ? AND project_id = ?', [$fid, $pid]);
        if (!$f || $f['deleted_at'] !== null || $f['retracted_at'] !== null) return [];
        $out = [];
        if (in_array($fid, array_column(self::rewriteCandidates($pid), 0), true)) $out[] = 'rewrite';
        else {
            $mine = array_map('intval', array_column(Db::all('SELECT id FROM fact_rephrasings WHERE fact_id = ?', [$fid]), 'id'));
            if (array_intersect($mine, self::checkCandidates($pid))) $out[] = 'check';
        }
        $graph = FactController::graph($pid); // read once: the project's graph is the costly part of this page
        foreach (self::sourceCandidates($pid, $graph) as $group) if (in_array($fid, array_column($group, 0), true)) { $out[] = 'source'; break; }
        if (in_array($fid, self::reviewCandidates($pid, $graph), true)) $out[] = 'review';
        $step = ProofRepair::pendingStep($fid);
        if ($step) $out[] = $step === 'repair' ? 'repair' : 'recheck';
        $fix = StatementFix::pendingStep($fid);
        if ($fix === 'revise' || $fix === 'verify') $out[] = $fix === 'revise' ? 'fix' : 'fixcheck';
        $rel = Relink::pendingStep($fid);
        if ($rel) $out[] = $rel === 'relink' ? 'relink' : 'relcheck';
        return array_map(fn($s) => ['sweep' => $s, 'open' => self::open($pid, $s) !== null], $out);
    }

    /**
     * The AI passes entries and proposals of a project wait for: the typing of an entry's parameters, the second reading of a proposal.
     * @return array{types: array<int, bool>, second: array<int, bool>} by id, whether a sweep of that kind waits or runs
     */
    public static function pendingItems(int $pid): array
    {
        $types = self::open($pid, 'symbols') !== null;
        $second = self::open($pid, 'second') !== null;
        return ['types' => array_fill_keys(self::typeCandidates($pid), $types), 'second' => array_fill_keys(self::secondCandidates($pid), $second)];
    }

    /**
     * Where each symbol without a settled entry stands with the symbols sweep: "reading" in a sweep that waits or runs, "next" in the next
     * one (the most used first, SYMBOLS_BATCH at a time), "later" in a sweep after it, "left" when two sweeps read it without settling
     * it, so that it is left to the members. @return array<string, string> by notion key
     */
    public static function symbolStates(int $pid): array
    {
        $out = [];
        foreach (self::symbolCandidates($pid) as $i => $k) $out[$k] = $i < self::SYMBOLS_BATCH ? 'next' : 'later';
        if ($open = self::open($pid, 'symbols')) {
            foreach (json_decode((string)Db::value('SELECT snapshot_json FROM ai_tasks WHERE id = ?', [$open]), true)['symbols'] ?? [] as $k) $out[(string)$k] = 'reading';
        }
        return $out;
    }

    /** How many models may read a proof without reviewing it before it is left to people. */
    public const REVIEW_READERS = 2;

    /** The models that read each proof without reviewing it, by "fact:revision", lowercased. */
    public static function reviewReaders(int $pid): array
    {
        return self::tried($pid, 'proof_review', null);
    }

    /**
     * Proved facts that still wait for an independent AI review, in the order of Verification::rank, the same as people's: what an
     * answer to a question rests on first. A proof nobody checked yet, and one only an AI of its author's company found correct,
     * while an AI of another company is around (Verification::companiesAround, and the client asking). Not one that two models read without reviewing it:
     * it is left to people. @return list<int> fact ids
     */
    public static function reviewCandidates(int $pid, ?array $graph = null, ?array $rank = null, array $alsoAround = []): array
    {
        if (!Config::get('sweeps.review', true)) return [];
        $graph ??= FactController::graph($pid);
        $rank ??= Verification::rank($pid, $graph);
        $tried = self::tried($pid, 'proof_review', null);
        $revision = array_column($graph['facts'], 'current_revision', 'id');
        $author = array_column($graph['facts'], 'ai_model', 'id');
        $around = null;
        $out = [];
        foreach ($rank as $id => $x) {
            if (!in_array($x['level'], ['none', 'same_ai'], true)) continue;
            // A model that wrote the proof was refused, not left it out: it does not count as one of the readers.
            $readers = array_filter(array_unique($tried[$id . ':' . (int)$revision[$id]] ?? []), fn($m) => !Verification::sameModel($m, $author[$id] ?? null));
            if (count($readers) >= self::REVIEW_READERS) continue;
            if ($x['level'] === 'same_ai' && !array_diff($around ??= array_merge(Verification::companiesAround($pid), $alsoAround), $x['checked_by'])) continue;
            $out[] = (int)$id;
        }
        return $out;
    }

    /**
     * The batch a model would review: the candidates, most important first, that it may review. Never a proof it wrote, nor one it
     * already read and left out, nor one an AI of its own company already found correct: that one waits for another company's.
     * @return array{0: list<array{0: int, 1: int}>, 1: bool} the facts at their revision, and whether more was left
     */
    public static function reviewBatch(int $pid, string $model): array
    {
        $graph = FactController::graph($pid);
        $rank = Verification::rank($pid, $graph);
        $byId = array_column($graph['facts'], null, 'id');
        $model = mb_strtolower(trim($model));
        $company = Verification::company($model);
        $readers = self::reviewReaders($pid);
        $batch = []; $chars = 0; $full = false;
        // The client asking is around too: its model may be the first of its company here.
        foreach (self::reviewCandidates($pid, $graph, $rank, array_filter([$company])) as $fid) {
            $f = $byId[$fid]; $rev = (int)$f['current_revision'];
            if ($model !== '' && Verification::sameModel((string)$f['ai_model'], $model)) continue; // "opus" wrote what claude-opus-5-5 wrote
            if ($model !== '' && in_array($model, $readers[$fid . ':' . $rev] ?? [], true)) continue;
            if ($company !== null && in_array($company, $rank[$fid]['checked_by'], true)) continue;
            $size = (int)Db::value('SELECT LENGTH(statement_html) + LENGTH(COALESCE(proof_html, \'\')) FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$fid, $rev]);
            if ($batch && ($chars + $size > self::REVIEW_CHARS || count($batch) >= self::REVIEW_BATCH)) { $full = true; break; }
            $batch[] = [$fid, $rev]; $chars += $size;
        }
        return [$batch, $full];
    }

    /** The first of a client's models that has proofs to review here, in the client's order: another company's model first. */
    public static function reviewModel(int $pid, array $models): ?string
    {
        foreach ($models as $m) if (is_string($m) && $m !== '' && self::reviewBatch($pid, $m)[0]) return $m;
        return null;
    }

    /** The same for any procedure that must run on a model independent of the work it answers. */
    public static function modelFor(string $kind, int $pid, array $models): ?string
    {
        if ($kind === 'proof_review') return self::reviewModel($pid, $models);
        if (in_array($kind, ['relink', 'relink_check'], true)) {
            foreach ($models as $m) if (is_string($m) && $m !== '' && Relink::batch($pid, $kind === 'relink' ? 'relink' : 'relcheck', $m)[0]) return $m;
            return null;
        }
        if (in_array($kind, ['statement_fix', 'fix_check'], true)) {
            foreach ($models as $m) if (is_string($m) && $m !== '' && StatementFix::batch($pid, $kind === 'statement_fix' ? 'revise' : 'verify', $m)[0]) return $m;
            return null;
        }
        $step = ['proof_repair' => 'repair', 'repair_check' => 'check'][$kind] ?? null;
        if ($step === null) return null;
        foreach ($models as $m) if (is_string($m) && $m !== '' && ProofRepair::batch($pid, $step, $m)[0]) return $m;
        return null;
    }

    /**
     * Agreed and local entries written with parameters that nobody typed: the symbols sweep says what each parameter stands for, so
     * that an entry applies to those objects only. An entry a sweep read without typing it is not read again. @return list<int> entry ids
     */
    public static function typeCandidates(int $pid): array
    {
        $tried = self::tried($pid, 'consolidate', null);
        $out = [];
        foreach (Db::all("SELECT id, symbol, params_json FROM notations WHERE project_id = ? AND status IN ('agreed', 'local') ORDER BY status = 'agreed' DESC, id", [$pid]) as $n) {
            $params = NotationController::paramsOf($n);
            if ($params && !array_filter($params, fn($p) => trim($p['type']) !== '') && !isset($tried['type:' . $n['id']])) $out[] = (int)$n['id'];
        }
        return $out;
    }

    /**
     * Rewrites in the current notation, of the current revision of their fact, that nobody checked and that no check tried yet.
     * A person's verdict is never asked of an AI. @return list<int> rephrasing ids
     */
    public static function checkCandidates(int $pid): array
    {
        $tried = self::tried($pid, 'rewrite_check', null);
        $hashes = NotationController::factHashes($pid); // each rewrite against the notation its own fact uses
        $ids = [];
        foreach (Db::all("SELECT x.id, x.fact_id, x.notation_hash FROM fact_rephrasings x JOIN facts f ON f.id = x.fact_id AND x.revision_no = f.current_revision
            WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL AND x.unchanged = 0 AND x.check_verdict IS NULL ORDER BY x.id", [$pid]) as $x) {
            if ($x['notation_hash'] === ($hashes[(int)$x['fact_id']] ?? null) && !isset($tried[(int)$x['id']])) $ids[] = (int)$x['id'];
        }
        return $ids;
    }

    /**
     * Proposals of the consolidation waiting for people, that no second reading has seen, when the project lets the AI apply
     * changes on its own. @return list<int> suggestion ids
     */
    public static function secondCandidates(int $pid): array
    {
        if (!Db::value('SELECT consolidation_auto FROM projects WHERE id = ?', [$pid])) return [];
        $tried = self::tried($pid, 'second_reading', null);
        $ids = array_map('intval', array_column(Db::all("SELECT id FROM fact_suggestions WHERE project_id = ? AND status = 'proposed' AND second_verdict IS NULL ORDER BY id", [$pid]), 'id'));
        return array_values(array_filter($ids, fn($id) => !isset($tried[$id])));
    }

    /**
     * Facts not written in the current notation, or whose rewrite was found unfaithful, and that no sweep of this notation tried
     * yet: a fact a model left out is not taken again and again. A rewrite found unfaithful is tried once more, with what was wrong.
     * @return list<array{0: int, 1: int}> [fact, revision]
     */
    public static function rewriteCandidates(int $pid): array
    {
        if (NotationController::isEmptyHash(NotationController::hash($pid))) return [];
        $tried = self::tried($pid, 'notation', null);
        $out = [];
        foreach (NotationController::states($pid) as $fid => $s) {
            $times = $tried["$fid:{$s['revision']}"] ?? 0;
            if (in_array($s['state'], ['none', 'stale'], true) && !$times || $s['state'] === 'unfaithful' && $times < 2) $out[] = [(int)$fid, (int)$s['revision']];
        }
        return $out;
    }

    /**
     * Cited results nobody accepted and no AI checked, at their current revision, by the source they were found in. A result whose
     * last check had no text of its source and could not find or read it is checked once more, when its source can now be read.
     * @return array<string, list<array{0: int, 1: int}>>
     */
    public static function sourceCandidates(int $pid, ?array $graph = null): array
    {
        $tried = self::tried($pid, 'source_check', null);
        $blind = [];
        foreach (Db::all('SELECT c.fact_id, c.revision_no, c.verdict, c.had_source FROM fact_source_checks c JOIN facts f ON f.id = c.fact_id WHERE f.project_id = ? ORDER BY c.id', [$pid]) as $c) {
            $k = $c['fact_id'] . ':' . $c['revision_no'];
            $tried[$k] = true;
            // The last check decides: one made with the source, or one that found the result, needs no other.
            $blind[$k] = in_array($c['verdict'], ['not_found', 'unreadable'], true) && !(int)$c['had_source'] ? ($blind[$k] ?? 0) + 1 : -1;
        }
        foreach ($blind as $k => $n) {
            if ($n === 1 && AiTaskController::readableSource((int)explode(':', $k)[0])) unset($tried[$k]); // once only
        }
        $groups = [];
        foreach (($graph ?? FactController::graph($pid))['facts'] as $f) {
            if ($f['basis'] !== 'cited' || $f['status'] !== 'unchecked' || $f['retracted_at'] !== null) continue;
            $rev = (int)$f['current_revision'];
            if (isset($tried[$f['id'] . ':' . $rev])) continue;
            $src = Db::one("SELECT source_type, source_id FROM fact_sources WHERE fact_id = ? AND revision_no = ? AND covers <> 'context' ORDER BY source_type = 'document' DESC, id LIMIT 1", [$f['id'], $rev]);
            $groups[$src ? $src['source_type'] . ':' . $src['source_id'] : ''][] = [(int)$f['id'], $rev];
        }
        uasort($groups, fn($a, $b) => count($b) <=> count($a));
        return $groups;
    }

    /** What finished tasks of this kind already covered: one fact (a person's request, or before sweeps) or a batch. */
    private static function tried(int $pid, string $kind, ?string $hash): array
    {
        $done = [];
        foreach (Db::all("SELECT source_type, dedupe_key, snapshot_json, status, ai_model FROM ai_tasks WHERE project_id = ? AND kind = ? AND status IN ('done', 'failed')", [$pid, $kind]) as $t) {
            $snap = json_decode((string)$t['snapshot_json'], true) ?: [];
            if ($kind === 'notation') {
                // A rewrite tried in this notation, by a sweep that finished: failed sweeps are tried again.
                // Each fact against the notation it uses: a sweep of before the per-fact fingerprints recorded one for the project.
                if ($t['source_type'] === 'sweep' && $t['status'] === 'done') {
                    foreach ($snap['facts'] ?? [] as [$f, $rev]) {
                        $then = $snap['hashes'][$f] ?? $snap['hash'] ?? null;
                        if ($then !== null && $then === NotationController::hashFor($pid, (int)$f)) $done["$f:$rev"] = ($done["$f:$rev"] ?? 0) + 1;
                    }
                }
                continue;
            }
            if ($t['status'] !== 'done') continue;
            if (in_array($kind, ['rewrite_check', 'second_reading'], true)) { foreach ($snap['items'] ?? [] as $id) $done[(int)$id] = true; continue; }
            // A proof read at one revision: a new revision is read again.
            // The models that read it, at its revision: one that left it out, unable to check it, hands it to another model once.
            if ($kind === 'proof_review') { foreach ($snap['facts'] ?? [] as [$f, $rev]) $done["$f:$rev"][] = mb_strtolower(trim((string)$t['ai_model'])); continue; }
            if ($kind === 'consolidate') {
                if ($t['source_type'] === 'sweep') {
                    foreach ($snap['symbols'] ?? [] as $k) {
                        $done[(string)$k] = ($done[(string)$k] ?? 0) + 1;
                        if (!empty($snap['grouping'])) $done['grouped:' . $k] = true; // read by a sweep asked to group its wordings
                    }
                    foreach ($snap['types'] ?? [] as $id) $done['type:' . (int)$id] = 1;
                }
                continue;
            }
            if ($t['source_type'] !== 'fact') foreach ($snap['facts'] ?? [] as [$f, $rev]) $done["$f:$rev"] = true;
            elseif (preg_match('/^srcchk:(\d+):(\d+)$/', (string)$t['dedupe_key'], $m)) $done["$m[1]:$m[2]"] = true;
        }
        return $done;
    }

    /**
     * When a client takes a sweep: the batch it works on, recorded on the task. Nothing left: null, and the task is finished.
     * @return ?array the task with its batch
     */
    public static function take(array $t): ?array
    {
        $pid = (int)$t['project_id'];
        if ($t['kind'] === 'notation') {
            $batch = []; $chars = 0; $full = false;
            foreach (self::rewriteCandidates($pid) as [$f, $rev]) {
                $size = (int)Db::value('SELECT LENGTH(statement_html) + LENGTH(COALESCE(proof_html, \'\')) FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$f, $rev]);
                if ($batch && ($chars + $size > self::REWRITE_CHARS || count($batch) >= self::REWRITE_BATCH)) { $full = true; break; }
                $batch[] = [$f, $rev]; $chars += $size;
            }
            // Full: more was left than this batch could hold. The facts it holds count as tried, so none is taken again and again.
            $snap = ['facts' => $batch, 'hashes' => array_combine(array_column($batch, 0), array_map(fn($x) => NotationController::hashFor($pid, (int)$x[0]), $batch)) ?: [], 'full' => $full];
        } elseif ($t['kind'] === 'rewrite_check') {
            $batch = []; $chars = 0; $full = false;
            foreach (self::checkCandidates($pid) as $id) {
                $size = (int)Db::value('SELECT LENGTH(x.statement_html) + LENGTH(COALESCE(x.proof_html, \'\')) + LENGTH(r.statement_html) + LENGTH(COALESCE(r.proof_html, \'\'))
                    FROM fact_rephrasings x JOIN fact_revisions r ON r.fact_id = x.fact_id AND r.revision_no = x.revision_no WHERE x.id = ?', [$id]);
                if ($batch && ($chars + $size > self::CHECK_CHARS || count($batch) >= self::CHECK_BATCH)) { $full = true; break; }
                $batch[] = $id; $chars += $size;
            }
            $snap = ['items' => $batch, 'full' => $full];
        } elseif ($t['kind'] === 'consolidate') {
            $allSymbols = self::symbolCandidates($pid); $allTypes = self::typeCandidates($pid);
            $symbols = array_slice($allSymbols, 0, self::SYMBOLS_BATCH);
            $types = array_slice($allTypes, 0, self::TYPES_BATCH);
            $batch = array_merge($symbols, $types);
            // The wordings of each symbol as the AI sees them, numbered from 1: its groups name them by number, and a fact added
            // before the answer must not shift them.
            $wordings = [];
            $mine = array_flip($symbols);
            foreach (NotationController::shared($pid, 2, 1000) as $x) {
                $k = NotationController::notionKey($x['symbol']);
                if (isset($mine[$k])) $wordings[$k] = array_column($x['meanings'], 'key');
            }
            $full = count($allSymbols) > self::SYMBOLS_BATCH || count($allTypes) > self::TYPES_BATCH;
            $snap = ['symbols' => $symbols, 'types' => $types, 'grouping' => true, 'wordings' => $wordings, 'full' => $full];
        } elseif ($t['kind'] === 'proof_review') {
            // A model never reviews what it wrote, nor what its own company already found correct: those proofs wait for a client
            // running another model, instead of being refused and then counted as read.
            [$batch, $full] = self::reviewBatch($pid, (string)($t['ai_model'] ?? ''));
            if (!$batch && self::reviewCandidates($pid)) {
                // Proofs are left, for another company's model: the sweep waits for its client rather than ending.
                Db::run("UPDATE ai_tasks SET status = 'pending', lease_hash = NULL, lease_until = NULL, claimed_by = NULL, client_name = NULL, ai_model = NULL, attempts = attempts - 1, started_at = NULL, updated_at = ? WHERE id = ?", [Db::now(), $t['id']]);
                return null;
            }
            $snap = ['facts' => $batch, 'full' => $full];
        } elseif (in_array($t['kind'], ['relink', 'relink_check'], true)) {
            $step = $t['kind'] === 'relink' ? 'relink' : 'relcheck';
            [$batch, $full] = Relink::batch($pid, $step, (string)($t['ai_model'] ?? ''));
            if (!$batch && Relink::due($pid, $step)) {
                Db::run("UPDATE ai_tasks SET status = 'pending', lease_hash = NULL, lease_until = NULL, claimed_by = NULL, client_name = NULL, ai_model = NULL, attempts = attempts - 1, started_at = NULL, updated_at = ? WHERE id = ?", [Db::now(), $t['id']]);
                return null;
            }
            $snap = ['items' => $batch, 'full' => $full];
        } elseif (in_array($t['kind'], ['statement_fix', 'fix_check'], true)) {
            $step = $t['kind'] === 'statement_fix' ? 'revise' : 'verify';
            [$batch, $full] = StatementFix::batch($pid, $step, (string)($t['ai_model'] ?? ''));
            if (!$batch && StatementFix::due($pid, $step)) {
                Db::run("UPDATE ai_tasks SET status = 'pending', lease_hash = NULL, lease_until = NULL, claimed_by = NULL, client_name = NULL, ai_model = NULL, attempts = attempts - 1, started_at = NULL, updated_at = ? WHERE id = ?", [Db::now(), $t['id']]);
                return null;
            }
            $snap = ['items' => $batch, 'full' => $full];
        } elseif (in_array($t['kind'], ['proof_repair', 'repair_check'], true)) {
            $step = $t['kind'] === 'proof_repair' ? 'repair' : 'check';
            [$batch, $full] = ProofRepair::batch($pid, $step, (string)($t['ai_model'] ?? ''));
            if (!$batch && ProofRepair::due($pid, $step)) {
                // Repairs are left, for a model of another company: the sweep waits for its client rather than ending.
                Db::run("UPDATE ai_tasks SET status = 'pending', lease_hash = NULL, lease_until = NULL, claimed_by = NULL, client_name = NULL, ai_model = NULL, attempts = attempts - 1, started_at = NULL, updated_at = ? WHERE id = ?", [Db::now(), $t['id']]);
                return null;
            }
            $snap = ['items' => $batch, 'full' => $full];
        } elseif ($t['kind'] === 'second_reading') {
            $all = self::secondCandidates($pid);
            $batch = array_slice($all, 0, self::SECOND_BATCH);
            $snap = ['items' => $batch, 'full' => count($all) > self::SECOND_BATCH];
        } else {
            // One source at a time, so that the client reads it once. Other sources, or more of this one, carry on at once.
            $groups = self::sourceCandidates($pid);
            $batch = array_slice((array)(reset($groups) ?: []), 0, self::SOURCE_BATCH);
            $snap = ['facts' => $batch, 'full' => array_sum(array_map('count', $groups)) > count($batch)];
        }
        if (!$batch) {
            $now = Db::now();
            Db::run("UPDATE ai_tasks SET status = 'done', summary_text = 'Nothing left to do.', lease_hash = NULL, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ?", [$now, $now, $t['id']]);
            return null;
        }
        Db::update('ai_tasks', ['snapshot_json' => json_encode($snap)], 'id = :id', ['id' => $t['id']]);
        return ['snapshot_json' => json_encode($snap)] + $t;
    }
}
