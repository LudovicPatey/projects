<?php
declare(strict_types=1);

namespace App;

use App\Controllers\AiTaskController;
use App\Controllers\FactController;

/**
 * Correction of a fact whose statement is wrong, which a member asks for: "the base system should be RCA, which allows full induction".
 * A corrected statement is another claim, so it never edits the fact: it supersedes it.
 *
 * An AI proposes up to three corrected statements, each with a proof (the one its source states, and variants that also hold, such as
 * the old base system with an extra hypothesis), or answers that the statement is right as it is. An AI of another company checks
 * each proposal against the request, the source and its proof. Rounds go on, as for a repair of a proof (src/ProofRepair.php, whose
 * table it shares with kind "statement"), until at least one proposal is accepted, both sides agree the statement stands, or ROUNDS run
 * out. A member then chooses which accepted proposals replace the fact: each becomes a new fact, the old one is retracted as
 * "superseded by" them (FactController::supersede), and each fact that rested on it is checked again (src/Relink.php).
 *
 * States: "revise" and "verify" wait for an AI step (the sweeps statement_fix and fix_check); "decide" waits for a member; "applied",
 * "kept", "gap", "disagree", "undone", "closed" are settled. Nothing changes the fact before a member decides.
 */
final class StatementFix
{
    public const ROUNDS = 3;
    public const PROPOSALS = 3;
    public const OPEN = ['revise', 'verify'];

    // ----- starting -----

    /** A member asks for a correction, saying what is wrong. @return int the correction */
    public static function ask(int $fid, int $by, string $request): int
    {
        $request = trim($request);
        if (mb_strlen($request) < 10) throw new HttpError(422, 'Say what is wrong with the statement, and what it should say.');
        $f = Db::one('SELECT * FROM facts WHERE id = ? AND deleted_at IS NULL', [$fid]);
        if (!$f || $f['retracted_at'] !== null) throw new HttpError(422, 'This fact is retracted.');
        if (Db::value("SELECT 1 FROM proof_repairs WHERE kind = 'statement' AND fact_id = ? AND state IN ('revise', 'verify', 'decide')", [$fid])) {
            throw new HttpError(409, 'A correction of this statement is already under way: follow it on the fact.');
        }
        $who = (string)Db::value('SELECT name FROM users WHERE id = ?', [$by]);
        $now = Db::now();
        $id = Db::insert('proof_repairs', ['kind' => 'statement', 'project_id' => $f['project_id'], 'fact_id' => $fid, 'revision_no' => $f['current_revision'], 'review_id' => 0,
            'state' => 'revise', 'round' => 1, 'steps_json' => json_encode([['step' => 'request', 'person' => $who, 'text' => mb_substr($request, 0, 4000), 'at' => $now]]),
            'asked_by' => $by, 'created_at' => $now, 'updated_at' => $now]);
        Activity::touch((int)$f['project_id'], 'fact', $fid, 'correction', $id);
        self::queue((int)$f['project_id'], 'revise');
        return $id;
    }

    private static function queue(int $pid, string $step): void
    {
        AiTaskController::queueSweep($pid, $step === 'revise' ? 'fix' : 'fixcheck', true);
    }

    // ----- what is due, and for whom -----

    /** Corrections waiting for this step, on facts not edited since. */
    public static function due(int $pid, string $step): array
    {
        Db::run("UPDATE proof_repairs SET state = 'closed', updated_at = ? WHERE project_id = ? AND kind = 'statement' AND state IN ('revise', 'verify', 'decide')
                 AND fact_id IN (SELECT id FROM facts WHERE project_id = ? AND (deleted_at IS NOT NULL OR retracted_at IS NOT NULL OR current_revision <> proof_repairs.revision_no))", [Db::now(), $pid, $pid]);
        return Db::all("SELECT * FROM proof_repairs WHERE project_id = ? AND kind = 'statement' AND state = ? ORDER BY id", [$pid, $step]);
    }

    /** The reviser: any model but the fact's author. The checker: another company than the reviser, or another model when none is around. */
    public static function mayTake(array $r, string $model, array $around): bool
    {
        if ($r['state'] === 'revise') return !Verification::sameModel((string)Db::value('SELECT ai_model FROM facts WHERE id = ?', [$r['fact_id']]), $model);
        $reviser = null;
        foreach (array_reverse(json_decode((string)$r['steps_json'], true) ?: []) as $s) if ($s['step'] === 'revise') { $reviser = $s['model'] ?? null; break; }
        if ($reviser === null) return true;
        if (Verification::company($model) !== Verification::company($reviser)) return true;
        if (array_diff($around, [Verification::company($reviser)])) return false;
        return !Verification::sameModel($model, $reviser);
    }

    /** The correction a model would take: one at a time, with its source. @return array{0: list<int>, 1: bool} */
    public static function batch(int $pid, string $step, string $model): array
    {
        $around = array_values(array_unique(array_filter(array_merge(Verification::companiesAround($pid), [Verification::company($model)]))));
        $due = self::due($pid, $step);
        foreach ($due as $r) if (self::mayTake($r, $model, $around)) return [[(int)$r['id']], count($due) > 1];
        return [[], false];
    }

    // ----- what the AI reads -----

    public static function context(int $pid, array $ids): array
    {
        $out = []; $doc = null;
        foreach ($ids as $id) {
            $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND project_id = ? AND kind = 'statement'", [$id, $pid]);
            if (!$r) continue;
            $f = Db::one('SELECT f.id, f.label, f.title, f.kind, r.statement_html, r.proof_html FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = ? WHERE f.id = ?', [$r['revision_no'], $r['fact_id']]);
            $deps = Db::all('SELECT f.label, f.title, r.statement_html FROM fact_deps d JOIN facts f ON f.id = d.depends_on_id JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE d.fact_id = ? LIMIT 50', [$r['fact_id']]);
            $users = Db::all('SELECT f.label, f.title, r.statement_html FROM fact_deps d JOIN facts f ON f.id = d.fact_id AND f.deleted_at IS NULL JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE d.depends_on_id = ? LIMIT 30', [$r['fact_id']]);
            $sources = array_values(array_map(fn($s) => ['label' => $s['label'] ?? $s['type'], 'page' => $s['page'] ?? null, 'quote' => $s['quote']],
                array_filter(FactController::presentSources((int)$r['fact_id'], (int)$r['revision_no']), fn($s) => !$s['hidden'] && $s['covers'] !== 'context')));
            $p = json_decode((string)$r['proposal_json'], true) ?: [];
            $text = fn($h) => Sanitizer::toText((string)$h);
            $out[] = ['correction_id' => (int)$r['id'], 'round' => (int)$r['round'], 'rounds_at_most' => self::ROUNDS, 'proposals_at_most' => self::PROPOSALS,
                'fact' => ['fact_id' => (int)$f['id'], 'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['kind'], 'statement' => $text($f['statement_html']), 'proof' => $text($f['proof_html']),
                    'definitions' => FactController::definitions($pid, (int)$f['id'], (int)$r['revision_no']), 'sources' => $sources],
                'dependencies' => array_map(fn($d) => ['label' => $d['label'], 'title' => $d['title'], 'statement' => $text($d['statement_html'])], $deps),
                'used_by' => array_map(fn($d) => ['label' => $d['label'], 'title' => $d['title'], 'statement' => $text($d['statement_html'])], $users),
                'proposals' => array_map(fn($x, $i) => ['index' => $i, 'title' => $x['title'] ?? '', 'statement' => $x['statement'], 'proof' => $x['proof'], 'from_source' => !empty($x['from_source'])], $p['proposals'] ?? [], array_keys($p['proposals'] ?? [])),
                'steps' => array_map(fn($s) => array_intersect_key($s, array_flip(['step', 'model', 'person', 'outcome', 'text', 'verdicts'])), json_decode((string)$r['steps_json'], true) ?: [])];
            $doc ??= AiTaskController::factSourceDocument((int)$r['fact_id']);
        }
        return ['corrections' => $out] + ($doc ? ['document' => $doc] : []);
    }

    // ----- applying the answers -----

    /** The reviser's answers: up to PROPOSALS corrected statements with proofs, the statement is right as it is, or none can be written. */
    public static function applyRevisions(array $t, array $answers, ?string $model, mixed $seconds): array
    {
        $mine = array_flip(self::items($t)); $facts = []; $said = [];
        foreach ($answers as $a) {
            $id = (int)$a['correction_id'];
            if (!isset($mine[$id])) continue;
            unset($mine[$id]);
            $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND kind = 'statement' AND state = 'revise'", [$id]);
            if (!$r) continue;
            $outcome = (string)$a['outcome']; $text = trim((string)$a['explanation']);
            if ($text === '') continue;
            $proposals = [];
            foreach ((array)($a['proposals'] ?? []) as $x) {
                $st = trim((string)($x['statement'] ?? '')); $pr = trim((string)($x['proof'] ?? ''));
                if ($st !== '' && $pr !== '') $proposals[] = ['title' => mb_substr(trim((string)($x['title'] ?? '')), 0, 240), 'statement' => mb_substr($st, 0, 20000), 'proof' => mb_substr($pr, 0, 60000), 'from_source' => !empty($x['from_source']), 'why' => mb_substr(trim((string)($x['why'] ?? '')), 0, 2000)];
            }
            $proposals = array_slice($proposals, 0, self::PROPOSALS);
            if ($outcome === 'corrected' && !$proposals) continue; // a correction comes with a statement and a proof
            $steps = json_decode((string)$r['steps_json'], true) ?: [];
            $steps[] = ['step' => 'revise', 'model' => $model, 'outcome' => $outcome, 'text' => $text, 'count' => count($proposals), 'at' => Db::now()];
            $state = $outcome === 'impossible' ? 'gap' : 'verify';
            Db::update('proof_repairs', ['state' => $state, 'steps_json' => json_encode($steps), 'updated_at' => Db::now(),
                'proposal_json' => json_encode(['proposals' => $outcome === 'corrected' ? $proposals : [], 'model' => $model, 'user' => Auth::id(), 'seconds' => $seconds])], 'id = :id', ['id' => $id]);
            Activity::touch((int)$r['project_id'], 'fact', (int)$r['fact_id'], 'correction', $id);
            if ($state === 'verify') self::queue((int)$r['project_id'], 'verify');
            $facts[] = (int)$r['fact_id'];
            $said[] = ['corrected' => count($proposals) . ' proposal' . (count($proposals) === 1 ? '' : 's'), 'keep' => 'right as it is', 'impossible' => 'no correct statement found'][$outcome] ?? $outcome;
        }
        return ['summary' => count($facts) . ' statement' . (count($facts) === 1 ? '' : 's') . ' answered' . ($said ? ' (' . implode(', ', $said) . ')' : '') . '.', 'fact_ids' => $facts];
    }

    /**
     * The checker's answers, one per proposal ("proposal": its index), or one with "proposal" null on "right as it is". A proposal found
     * correct is accepted; at least one accepted waits for a member's decision. "correct" on "right as it is" keeps the statement.
     * Otherwise another round, up to ROUNDS.
     */
    public static function applyChecks(array $t, array $answers, ?string $model, mixed $seconds): array
    {
        $mine = array_flip(self::items($t)); $by = []; $facts = []; $said = [];
        foreach ($answers as $a) if (isset($mine[(int)$a['correction_id']])) $by[(int)$a['correction_id']][] = $a;
        foreach ($by as $id => $list) {
            $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND kind = 'statement' AND state = 'verify'", [$id]);
            if (!$r) continue;
            $p = json_decode((string)$r['proposal_json'], true) ?: ['proposals' => []];
            $verdicts = [];
            foreach ($list as $a) {
                $text = trim((string)$a['explanation']);
                if ($text === '') continue;
                $i = $a['proposal'] === null ? null : (int)$a['proposal'];
                if ($i !== null && !isset($p['proposals'][$i])) continue;
                $verdicts[] = ['proposal' => $i, 'verdict' => (string)$a['verdict'], 'text' => $text];
                if ($i !== null) { $p['proposals'][$i]['verdict'] = (string)$a['verdict']; $p['proposals'][$i]['check'] = $text; $p['proposals'][$i]['checked_by'] = $model; }
            }
            if (!$verdicts) continue;
            $steps = json_decode((string)$r['steps_json'], true) ?: [];
            $steps[] = ['step' => 'verify', 'model' => $model, 'verdicts' => $verdicts, 'text' => implode("\n\n", array_map(fn($v) => ($v['proposal'] === null ? '' : 'Proposal ' . ($v['proposal'] + 1) . ': ') . $v['verdict'] . '. ' . $v['text'], $verdicts)), 'at' => Db::now()];
            $accepted = array_filter($p['proposals'], fn($x) => ($x['verdict'] ?? '') === 'correct');
            if ($accepted) $state = 'decide';
            elseif (!$p['proposals'] && ($verdicts[0]['verdict'] ?? '') === 'correct') $state = 'kept';
            elseif ((int)$r['round'] >= self::ROUNDS) $state = 'disagree';
            else $state = 'revise';
            Db::update('proof_repairs', ['state' => $state, 'round' => $state === 'revise' ? (int)$r['round'] + 1 : (int)$r['round'], 'proposal_json' => json_encode($p),
                'steps_json' => json_encode($steps), 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
            Activity::touch((int)$r['project_id'], 'fact', (int)$r['fact_id'], 'correction', $id);
            if ($state === 'revise') self::queue((int)$r['project_id'], 'revise');
            if ($state === 'decide' && $r['asked_by'] && Access::isMember((int)$r['project_id'], (int)$r['asked_by'])) {
                Notify::send((int)$r['asked_by'], (int)$r['project_id'], 'fact_correction', ['link' => ['view' => 'facts', 'id' => (int)$r['fact_id']], 'excerpt' => count($accepted) . ' corrected statement' . (count($accepted) === 1 ? '' : 's') . ' accepted by both AIs: choose which replace the fact']);
            }
            $facts[] = (int)$r['fact_id']; $said[] = $state;
        }
        return ['summary' => count($facts) . ' correction' . (count($facts) === 1 ? '' : 's') . ' checked' . ($said ? ' (' . implode(', ', $said) . ')' : '') . '.', 'fact_ids' => $facts];
    }

    private static function items(array $t): array
    {
        return array_map('intval', json_decode((string)($t['snapshot_json'] ?? ''), true)['items'] ?? []);
    }

    // ----- the member's decision, and undoing it -----

    /**
     * A member chooses which accepted proposals replace the fact (`$chosen`: their indexes). Each becomes a new fact; the old one is
     * retracted as superseded by them, and each fact that rested on it is checked again (Relink). @return list<int> the new facts
     */
    public static function decide(int $id, array $chosen, int $by): array
    {
        $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND kind = 'statement'", [$id]);
        if (!$r) throw new HttpError(404, 'No such correction.');
        Access::member((int)$r['project_id']);
        if ($r['state'] !== 'decide') throw new HttpError(422, 'This correction is not waiting for a decision.');
        $p = json_decode((string)$r['proposal_json'], true) ?: ['proposals' => []];
        $variants = [];
        foreach (array_unique(array_map('intval', $chosen)) as $i) {
            $x = $p['proposals'][$i] ?? null;
            if (!$x || ($x['verdict'] ?? '') !== 'correct') throw new HttpError(422, 'Choose among the proposals both AIs accepted.');
            $variants[] = ['title' => $x['title'] ?? '', 'statement' => $x['statement'], 'proof' => $x['proof'], 'model' => $p['model'] ?? null, 'user' => $p['user'] ?? null, 'seconds' => $p['seconds'] ?? null, 'from_source' => !empty($x['from_source'])];
        }
        if (!$variants) throw new HttpError(422, 'Choose at least one statement.');
        usort($variants, fn($a, $b) => $b['from_source'] <=> $a['from_source']); // the source's statement first
        $request = json_decode((string)$r['steps_json'], true)[0]['text'] ?? '';
        $ids = FactController::supersede((int)$r['fact_id'], $variants, $id, $request);
        $who = (string)Db::value('SELECT name FROM users WHERE id = ?', [$by]);
        $steps = json_decode((string)$r['steps_json'], true) ?: [];
        $steps[] = ['step' => 'decide', 'person' => $who, 'text' => count($ids) . ' new fact' . (count($ids) === 1 ? '' : 's') . ' replace this one.', 'facts' => $ids, 'at' => Db::now()];
        Db::update('proof_repairs', ['state' => 'applied', 'steps_json' => json_encode($steps), 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
        Relink::start((int)$r['fact_id'], $ids);
        return $ids;
    }

    /** A member undoes an applied correction: the new facts are retracted and the old one comes back. Nothing is deleted. */
    public static function undo(int $id, int $by): void
    {
        $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND kind = 'statement'", [$id]);
        if (!$r) throw new HttpError(404, 'No such correction.');
        Access::member((int)$r['project_id']);
        if ($r['state'] !== 'applied') throw new HttpError(422, 'Only an applied correction can be undone.');
        $who = (string)Db::value('SELECT name FROM users WHERE id = ?', [$by]);
        FactController::undoSupersede($id, $who);
        Relink::closeFor((int)$r['fact_id']);
        $steps = json_decode((string)$r['steps_json'], true) ?: [];
        $steps[] = ['step' => 'undo', 'person' => $who, 'text' => 'The new facts were retracted and this one is back.', 'at' => Db::now()];
        Db::update('proof_repairs', ['state' => 'undone', 'steps_json' => json_encode($steps), 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
    }

    /** The corrections of a fact, newest first, with their proposals and verdicts. */
    public static function forFact(int $fid): array
    {
        return array_map(function ($r) {
            $p = json_decode((string)$r['proposal_json'], true) ?: [];
            return ['id' => (int)$r['id'], 'state' => $r['state'], 'round' => (int)$r['round'], 'rounds' => self::ROUNDS, 'revision_no' => (int)$r['revision_no'],
                'asked_by' => $r['asked_by'] ? (string)Db::value('SELECT name FROM users WHERE id = ?', [$r['asked_by']]) : null,
                'proposals' => array_map(fn($x) => array_intersect_key($x, array_flip(['title', 'statement', 'proof', 'from_source', 'why', 'verdict', 'check', 'checked_by'])), $p['proposals'] ?? []),
                'by' => $p['model'] ?? null, 'steps' => json_decode((string)$r['steps_json'], true) ?: [], 'updated_at' => $r['updated_at']];
        }, Db::all("SELECT * FROM proof_repairs WHERE kind = 'statement' AND fact_id = ? ORDER BY id DESC LIMIT 5", [$fid]));
    }

    /** The step a fact waits for: "revise", "verify" (an AI) or "decide" (a member). */
    public static function pendingStep(int $fid): ?string
    {
        $s = Db::value("SELECT r.state FROM proof_repairs r JOIN facts f ON f.id = r.fact_id AND f.current_revision = r.revision_no WHERE r.fact_id = ? AND r.kind = 'statement' AND r.state IN ('revise', 'verify', 'decide') LIMIT 1", [$fid]);
        return $s ? (string)$s : null;
    }
}
