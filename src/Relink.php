<?php
declare(strict_types=1);

namespace App;

use App\Controllers\AiTaskController;
use App\Controllers\FactController;

/**
 * The facts that rested on a superseded fact (src/StatementFix.php), checked again one by one. A corrected statement is often weaker
 * (over RCA rather than RCA_0), so a proof that used the old one may or may not survive. An AI reads each dependent's proof with the
 * new statements and answers that it works with one of them, which is then its dependency, or that it needed the old statement. An
 * AI of another company checks the answer. Agreed on a new fact, the dependent gets a revision that relies on it, its text unchanged.
 * Agreed that it needed the old statement, the checker records a review that finds a gap, which starts a repair of the dependent's
 * proof (src/ProofRepair.php). Disagreeing after ROUNDS, it is left to people. Shares proof_repairs, with kind "relink".
 *
 * States: "relink" and "relcheck" wait for an AI step (the sweeps relink and relink_check); "relinked", "needs_old", "disagree",
 * "closed" are settled.
 */
final class Relink
{
    public const ROUNDS = 2;

    /** After a supersession: one pass per fact that rested on the old one. */
    public static function start(int $oldId, array $newIds): void
    {
        $old = Db::one('SELECT project_id FROM facts WHERE id = ?', [$oldId]);
        $now = Db::now(); $any = false;
        foreach (Db::all('SELECT f.id, f.current_revision FROM fact_deps d JOIN facts f ON f.id = d.fact_id AND f.deleted_at IS NULL AND f.retracted_at IS NULL WHERE d.depends_on_id = ?', [$oldId]) as $d) {
            if (in_array((int)$d['id'], $newIds, true)) continue;
            Db::insert('proof_repairs', ['kind' => 'relink', 'project_id' => $old['project_id'], 'fact_id' => $d['id'], 'revision_no' => $d['current_revision'], 'review_id' => 0,
                'state' => 'relink', 'round' => 1, 'proposal_json' => json_encode(['old' => $oldId, 'new' => array_values($newIds)]), 'steps_json' => '[]', 'created_at' => $now, 'updated_at' => $now]);
            $any = true;
        }
        if ($any) AiTaskController::queueSweep((int)$old['project_id'], 'relink', true);
    }

    /** A correction undone: its passes no longer apply. */
    public static function closeFor(int $oldId): void
    {
        foreach (Db::all("SELECT id, proposal_json FROM proof_repairs WHERE kind = 'relink' AND state IN ('relink', 'relcheck')") as $r) {
            if ((json_decode((string)$r['proposal_json'], true)['old'] ?? 0) === $oldId) Db::update('proof_repairs', ['state' => 'closed', 'updated_at' => Db::now()], 'id = :id', ['id' => $r['id']]);
        }
    }

    public static function due(int $pid, string $step): array
    {
        Db::run("UPDATE proof_repairs SET state = 'closed', updated_at = ? WHERE project_id = ? AND kind = 'relink' AND state IN ('relink', 'relcheck')
                 AND fact_id IN (SELECT id FROM facts WHERE project_id = ? AND (deleted_at IS NOT NULL OR retracted_at IS NOT NULL OR current_revision <> proof_repairs.revision_no))", [Db::now(), $pid, $pid]);
        return Db::all("SELECT * FROM proof_repairs WHERE project_id = ? AND kind = 'relink' AND state = ? ORDER BY id", [$pid, $step]);
    }

    /** Any model reads the proof; the checker is of another company than the reader, or another model when none is around. */
    public static function mayTake(array $r, string $model, array $around): bool
    {
        if ($r['state'] === 'relink') return true;
        $reader = null;
        foreach (array_reverse(json_decode((string)$r['steps_json'], true) ?: []) as $s) if ($s['step'] === 'relink') { $reader = $s['model'] ?? null; break; }
        if ($reader === null) return true;
        if (Verification::company($model) !== Verification::company($reader)) return true;
        if (array_diff($around, [Verification::company($reader)])) return false;
        return !Verification::sameModel($model, $reader);
    }

    /** Up to 4 passes at a time. @return array{0: list<int>, 1: bool} */
    public static function batch(int $pid, string $step, string $model): array
    {
        $around = array_values(array_unique(array_filter(array_merge(Verification::companiesAround($pid), [Verification::company($model)]))));
        $out = []; $full = false;
        foreach (self::due($pid, $step) as $r) {
            if (!self::mayTake($r, $model, $around)) continue;
            if (count($out) >= 4) { $full = true; break; }
            $out[] = (int)$r['id'];
        }
        return [$out, $full];
    }

    public static function context(int $pid, array $ids): array
    {
        $fact = function (int $id, bool $proof) use ($pid) {
            $f = Db::one('SELECT f.id, f.label, f.title, f.current_revision, r.statement_html, r.proof_html FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE f.id = ?', [$id]);
            return $f ? ['fact_id' => (int)$f['id'], 'label' => $f['label'], 'title' => $f['title'], 'statement' => Sanitizer::toText((string)$f['statement_html'])]
                + ($proof ? ['proof' => Sanitizer::toText((string)$f['proof_html']), 'definitions' => FactController::definitions($pid, (int)$f['id'], (int)$f['current_revision'])] : []) : null;
        };
        $out = [];
        foreach ($ids as $id) {
            $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND project_id = ? AND kind = 'relink'", [$id, $pid]);
            if (!$r) continue;
            $p = json_decode((string)$r['proposal_json'], true) ?: [];
            $out[] = ['relink_id' => (int)$r['id'], 'round' => (int)$r['round'], 'fact' => $fact((int)$r['fact_id'], true), 'superseded' => $fact((int)$p['old'], false),
                'replacements' => array_values(array_filter(array_map(fn($n) => $fact((int)$n, true), $p['new'] ?? []))),
                'steps' => array_map(fn($s) => array_intersect_key($s, array_flip(['step', 'model', 'outcome', 'new_fact_id', 'verdict', 'text'])), json_decode((string)$r['steps_json'], true) ?: [])];
        }
        return ['relinks' => $out];
    }

    public static function applyReadings(array $t, array $answers, ?string $model): array
    {
        $mine = array_flip(self::items($t)); $facts = [];
        foreach ($answers as $a) {
            $id = (int)$a['relink_id'];
            if (!isset($mine[$id])) continue;
            unset($mine[$id]);
            $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND kind = 'relink' AND state = 'relink'", [$id]);
            $text = trim((string)$a['explanation']);
            if (!$r || $text === '') continue;
            $p = json_decode((string)$r['proposal_json'], true) ?: [];
            $new = $a['new_fact_id'] === null ? null : (int)$a['new_fact_id'];
            if ($a['outcome'] === 'use' && !in_array($new, array_map('intval', $p['new'] ?? []), true)) continue; // one of the replacements
            $steps = json_decode((string)$r['steps_json'], true) ?: [];
            $steps[] = ['step' => 'relink', 'model' => $model, 'outcome' => (string)$a['outcome'], 'new_fact_id' => $a['outcome'] === 'use' ? $new : null, 'text' => $text, 'at' => Db::now()];
            Db::update('proof_repairs', ['state' => 'relcheck', 'steps_json' => json_encode($steps), 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
            AiTaskController::queueSweep((int)$r['project_id'], 'relcheck', true);
            $facts[] = (int)$r['fact_id'];
        }
        return ['summary' => count($facts) . ' dependent fact' . (count($facts) === 1 ? '' : 's') . ' read with the corrected statements.', 'fact_ids' => $facts];
    }

    public static function applyChecks(array $t, array $answers, ?string $model, mixed $seconds): array
    {
        $mine = array_flip(self::items($t)); $facts = []; $said = [];
        foreach ($answers as $a) {
            $id = (int)$a['relink_id'];
            if (!isset($mine[$id])) continue;
            unset($mine[$id]);
            $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND kind = 'relink' AND state = 'relcheck'", [$id]);
            $text = trim((string)$a['explanation']);
            if (!$r || $text === '') continue;
            $p = json_decode((string)$r['proposal_json'], true) ?: [];
            $steps = json_decode((string)$r['steps_json'], true) ?: [];
            $last = end($steps);
            $steps[] = ['step' => 'relcheck', 'model' => $model, 'verdict' => (string)$a['verdict'], 'text' => $text, 'at' => Db::now()];
            if ($a['verdict'] === 'correct' && ($last['outcome'] ?? '') === 'use') {
                FactController::replaceDependency((int)$r['fact_id'], (int)$p['old'], (int)$last['new_fact_id'], "Relies on the corrected statement instead of the superseded one, checked by $model.");
                $state = 'relinked';
            } elseif ($a['verdict'] === 'correct') {
                // Both sides agree the proof needed the old, stronger statement: a review finds the gap, and a repair of the proof starts.
                $label = (string)Db::value('SELECT label FROM facts WHERE id = ?', [$p['old']]);
                try {
                    FactController::recordReview(Request::internal(['verdict' => 'gap', 'body_text' => "The proof relies on $label, whose statement was wrong and was superseded; the corrected statements do not give what it uses. $text", 'ai_model' => $model, 'generation_seconds' => $seconds], ['id' => (int)$r['fact_id']]));
                } catch (HttpError $e) { if ($e->status !== 403) throw $e; }
                $state = 'needs_old';
            } elseif ((int)$r['round'] >= self::ROUNDS) {
                $state = 'disagree';
            } else {
                $state = 'relink';
            }
            Db::update('proof_repairs', ['state' => $state, 'round' => $state === 'relink' ? (int)$r['round'] + 1 : (int)$r['round'], 'steps_json' => json_encode($steps), 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
            if ($state === 'relink') AiTaskController::queueSweep((int)$r['project_id'], 'relink', true);
            $facts[] = (int)$r['fact_id']; $said[] = $state;
        }
        return ['summary' => count($facts) . ' dependent fact' . (count($facts) === 1 ? '' : 's') . ' checked' . ($said ? ' (' . implode(', ', $said) . ')' : '') . '.', 'fact_ids' => $facts];
    }

    private static function items(array $t): array
    {
        return array_map('intval', json_decode((string)($t['snapshot_json'] ?? ''), true)['items'] ?? []);
    }

    /** The passes of a fact that rested on a superseded one, newest first. */
    public static function forFact(int $fid): array
    {
        return array_map(function ($r) {
            $p = json_decode((string)$r['proposal_json'], true) ?: [];
            $old = Db::one('SELECT id, label, title FROM facts WHERE id = ?', [$p['old'] ?? 0]);
            return ['id' => (int)$r['id'], 'state' => $r['state'], 'round' => (int)$r['round'], 'rounds' => self::ROUNDS,
                'superseded' => $old ? ['id' => (int)$old['id'], 'label' => $old['label'], 'title' => $old['title']] : null,
                'steps' => json_decode((string)$r['steps_json'], true) ?: [], 'updated_at' => $r['updated_at']];
        }, Db::all("SELECT * FROM proof_repairs WHERE kind = 'relink' AND fact_id = ? ORDER BY id DESC LIMIT 5", [$fid]));
    }

    public static function pendingStep(int $fid): ?string
    {
        $s = Db::value("SELECT r.state FROM proof_repairs r JOIN facts f ON f.id = r.fact_id AND f.current_revision = r.revision_no WHERE r.fact_id = ? AND r.kind = 'relink' AND r.state IN ('relink', 'relcheck') LIMIT 1", [$fid]);
        return $s ? (string)$s : null;
    }
}
