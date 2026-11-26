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
 * Two sweeps take decisions that would otherwise wait for people: "check" has a second AI compare each rewrite in the project
 * notation with the original, and "second" has another AI reading the proposals of the consolidation it was not sure enough to
 * apply, applying those it agrees with and dropping the others. People can overrule both.
 *
 * Settings, in minutes or hours, in config.php under "sweeps": quiet_minutes (30), check_minutes (5), rewrite_hours (1),
 * source_hours (1), check_hours (1), second_hours (1), consolidate_hours (24; 0 consolidates only after extractions).
 */
final class Sweeps
{
    /** A sweep's kind of task. */
    public const KINDS = ['rewrite' => 'notation', 'source' => 'source_check', 'check' => 'rewrite_check', 'second' => 'second_reading'];
    /** At most this many facts in one session, and this much text to rewrite. */
    public const REWRITE_BATCH = 12;
    public const REWRITE_CHARS = 40000;
    public const SOURCE_BATCH = 10;
    /** Rewrites compared in one session, and the text they may hold, the original and the rewrite together. */
    public const CHECK_BATCH = 12;
    public const CHECK_CHARS = 60000;
    /** Proposals read again in one session. */
    public const SECOND_BATCH = 25;
    private const BATCH = ['rewrite' => self::REWRITE_BATCH, 'source' => self::SOURCE_BATCH, 'check' => self::CHECK_BATCH, 'second' => self::SECOND_BATCH];

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
        $lastCons = Db::value("SELECT MAX(COALESCE(finished_at, created_at)) FROM ai_tasks WHERE project_id = ? AND kind = 'consolidate'", [$pid]);
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

    /** The last sweep of this kind ended long enough ago, or it did a full batch and work is left: it carries on. */
    private static function rested(int $pid, string $sweep): bool
    {
        $last = Db::one("SELECT finished_at, result_json FROM ai_tasks WHERE project_id = ? AND kind = ? AND source_type = 'sweep' AND status IN ('done', 'failed') ORDER BY id DESC LIMIT 1", [$pid, self::KINDS[$sweep]]);
        if (!$last) return true;
        $result = json_decode((string)$last['result_json'], true) ?: [];
        $did = max(count($result['fact_ids'] ?? []), count($result['suggestion_ids'] ?? []));
        if ($did >= self::BATCH[$sweep]) return true;
        return strtotime((string)$last['finished_at'] . ' UTC') <= time() - 3600 * self::setting($sweep . '_hours', 1);
    }

    private static function stale(int $pid, string $sweep): bool
    {
        return (bool)match ($sweep) {
            'rewrite' => self::rewriteCandidates($pid), 'source' => self::sourceCandidates($pid),
            'check' => self::checkCandidates($pid), 'second' => self::secondCandidates($pid),
        };
    }

    /**
     * Rewrites in the current notation, of the current revision of their fact, that nobody checked and that no check tried yet.
     * A person's verdict is never asked of an AI. @return list<int> rephrasing ids
     */
    public static function checkCandidates(int $pid): array
    {
        $tried = self::tried($pid, 'rewrite_check', null);
        $ids = array_map('intval', array_column(Db::all("SELECT x.id FROM fact_rephrasings x JOIN facts f ON f.id = x.fact_id AND x.revision_no = f.current_revision
            WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL AND x.notation_hash = ? AND x.unchanged = 0 AND x.check_verdict IS NULL ORDER BY x.id",
            [$pid, NotationController::hash($pid)]), 'id'));
        return array_values(array_filter($ids, fn($id) => !isset($tried[$id])));
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
        $hash = NotationController::hash($pid);
        if ($hash === sha1('')) return [];
        $tried = self::tried($pid, 'notation', $hash);
        $out = [];
        foreach (NotationController::states($pid) as $fid => $s) {
            $times = $tried["$fid:{$s['revision']}"] ?? 0;
            if (in_array($s['state'], ['none', 'stale'], true) && !$times || $s['state'] === 'unfaithful' && $times < 2) $out[] = [(int)$fid, (int)$s['revision']];
        }
        return $out;
    }

    /** Cited results nobody accepted and no AI checked, at their current revision, by the source they were found in. @return array<string, list<array{0: int, 1: int}>> */
    public static function sourceCandidates(int $pid): array
    {
        $tried = self::tried($pid, 'source_check', null);
        foreach (Db::all('SELECT c.fact_id, c.revision_no FROM fact_source_checks c JOIN facts f ON f.id = c.fact_id WHERE f.project_id = ?', [$pid]) as $c) $tried[$c['fact_id'] . ':' . $c['revision_no']] = true;
        $groups = [];
        foreach (FactController::graph($pid)['facts'] as $f) {
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
        foreach (Db::all("SELECT source_type, dedupe_key, snapshot_json, status FROM ai_tasks WHERE project_id = ? AND kind = ? AND status IN ('done', 'failed')", [$pid, $kind]) as $t) {
            $snap = json_decode((string)$t['snapshot_json'], true) ?: [];
            if ($kind === 'notation') {
                // A rewrite tried in this notation, by a sweep that finished: failed sweeps are tried again.
                if ($t['source_type'] === 'sweep' && $t['status'] === 'done' && ($snap['hash'] ?? null) === $hash) foreach ($snap['facts'] ?? [] as [$f, $rev]) $done["$f:$rev"] = ($done["$f:$rev"] ?? 0) + 1;
                continue;
            }
            if ($t['status'] !== 'done') continue;
            if (in_array($kind, ['rewrite_check', 'second_reading'], true)) { foreach ($snap['items'] ?? [] as $id) $done[(int)$id] = true; continue; }
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
            $batch = []; $chars = 0;
            foreach (self::rewriteCandidates($pid) as [$f, $rev]) {
                $size = (int)Db::value('SELECT LENGTH(statement_html) + LENGTH(COALESCE(proof_html, \'\')) FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$f, $rev]);
                if ($batch && ($chars + $size > self::REWRITE_CHARS || count($batch) >= self::REWRITE_BATCH)) break;
                $batch[] = [$f, $rev]; $chars += $size;
            }
            $snap = ['facts' => $batch, 'hash' => NotationController::hash($pid)];
        } elseif ($t['kind'] === 'rewrite_check') {
            $batch = []; $chars = 0;
            foreach (self::checkCandidates($pid) as $id) {
                $size = (int)Db::value('SELECT LENGTH(x.statement_html) + LENGTH(COALESCE(x.proof_html, \'\')) + LENGTH(r.statement_html) + LENGTH(COALESCE(r.proof_html, \'\'))
                    FROM fact_rephrasings x JOIN fact_revisions r ON r.fact_id = x.fact_id AND r.revision_no = x.revision_no WHERE x.id = ?', [$id]);
                if ($batch && ($chars + $size > self::CHECK_CHARS || count($batch) >= self::CHECK_BATCH)) break;
                $batch[] = $id; $chars += $size;
            }
            $snap = ['items' => $batch];
        } elseif ($t['kind'] === 'second_reading') {
            $batch = array_slice(self::secondCandidates($pid), 0, self::SECOND_BATCH);
            $snap = ['items' => $batch];
        } else {
            $groups = self::sourceCandidates($pid);
            $batch = array_slice((array)(reset($groups) ?: []), 0, self::SOURCE_BATCH);
            $snap = ['facts' => $batch];
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
