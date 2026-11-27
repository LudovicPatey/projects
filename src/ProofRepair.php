<?php
declare(strict_types=1);

namespace App;

use App\Controllers\FactController;

/**
 * Repair of a proof an AI review found flawed: an AI of another company than the reviewer repairs it, or says why the review is
 * wrong, or that the gap cannot be fixed; an AI of the reviewer's side then checks the repair, or reads the answer. Rounds go on
 * until both agree on a proof, both agree on a gap neither can fix, or ROUNDS run out, when it is left to people with both sides.
 *
 * States: "repair" and "check" wait for an AI step (the sweeps proof_repair and repair_check); "proof", "gap" and "disagree" are
 * settled; "closed" when the fact changed meanwhile. A repaired proof is another proof of the fact: the reviewed text never changes.
 * A loop whose sides agreed on a proof, or whose reviewer side accepted the answer, resolves the review that started it: that review
 * no longer counts in the fact's status (FactController::graph), though it stays shown.
 */
final class ProofRepair
{
    public const ROUNDS = 3;
    public const OPEN = ['repair', 'check'];
    private const BATCH = 3;
    private const CHARS = 40000;

    // ----- starting -----

    /** An AI review found a gap or an error: a repair starts, unless one already runs on this revision. */
    public static function onReview(int $reviewId): void
    {
        $v = Db::one("SELECT v.*, f.project_id, f.current_revision, f.retracted_at FROM fact_reviews v JOIN facts f ON f.id = v.fact_id WHERE v.id = ?", [$reviewId]);
        if (!$v || $v['reviewer_kind'] === 'human' || $v['verdict'] === 'correct' || (int)$v['revision_no'] !== (int)$v['current_revision'] || $v['retracted_at'] !== null) return;
        if (!Config::get('sweeps.repair', true)) return;
        self::start($v, null);
    }

    /**
     * A member asks for a repair of the proof of a fact, from its latest review that found a flaw, a person's included.
     * @return int the repair, new or already running
     */
    public static function ask(int $fid, int $by): int
    {
        $v = Db::one("SELECT v.*, f.project_id, f.current_revision FROM fact_reviews v JOIN facts f ON f.id = v.fact_id
                      WHERE v.fact_id = ? AND v.revision_no = f.current_revision AND v.verdict <> 'correct' ORDER BY v.updated_at DESC, v.id DESC LIMIT 1", [$fid]);
        if (!$v) throw new HttpError(422, 'No review of this revision found a gap or an error: there is nothing to repair.');
        return self::start($v, $by);
    }

    private static function start(array $v, ?int $by): int
    {
        $open = Db::value("SELECT id FROM proof_repairs WHERE fact_id = ? AND revision_no = ? AND state IN ('repair', 'check')", [$v['fact_id'], $v['revision_no']]);
        if ($open) return (int)$open;
        // One repair per review: a settled one is not started again by the same review.
        $done = Db::value('SELECT id FROM proof_repairs WHERE review_id = ? AND revision_no = ?', [$v['id'], $v['revision_no']]);
        if ($done && $by === null) return (int)$done;
        $who = $v['reviewer_kind'] === 'human' ? (string)Db::value('SELECT name FROM users WHERE id = ?', [$v['reviewer_id']]) : null;
        $first = ['step' => 'review', 'model' => $v['reviewer_kind'] === 'human' ? null : $v['ai_model'], 'person' => $who, 'verdict' => $v['verdict'],
            'text' => Sanitizer::toText((string)$v['body_html']), 'at' => Db::now()];
        $now = Db::now();
        $id = Db::insert('proof_repairs', ['project_id' => $v['project_id'], 'fact_id' => $v['fact_id'], 'revision_no' => $v['revision_no'], 'review_id' => $v['id'],
            'state' => 'repair', 'round' => 1, 'steps_json' => json_encode([$first]), 'asked_by' => $by, 'created_at' => $now, 'updated_at' => $now]);
        self::queue((int)$v['project_id'], 'repair');
        return $id;
    }

    /** The sweep of a step that is now due, queued at once: a repair goes on round after round without waiting for a quiet project. */
    private static function queue(int $pid, string $step): void
    {
        Controllers\AiTaskController::queueSweep($pid, $step === 'repair' ? 'repair' : 'recheck', true);
    }

    /** Reviews that AI found flawed before this existed, or while it was off: each gets its repair. Called by the sweeps. */
    public static function ensure(int $pid): void
    {
        if (!Config::get('sweeps.repair', true)) return;
        foreach (Db::all("SELECT v.id FROM fact_reviews v JOIN facts f ON f.id = v.fact_id AND v.revision_no = f.current_revision
                          WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL AND v.reviewer_kind <> 'human' AND v.verdict <> 'correct'
                            AND NOT EXISTS (SELECT 1 FROM proof_repairs r WHERE r.review_id = v.id AND r.revision_no = v.revision_no)", [$pid]) as $v) {
            self::onReview((int)$v['id']);
        }
        // A fact edited or retracted since: its repair no longer applies.
        Db::run("UPDATE proof_repairs SET state = 'closed', updated_at = ? WHERE project_id = ? AND state IN ('repair', 'check')
                 AND fact_id IN (SELECT id FROM facts WHERE project_id = ? AND (deleted_at IS NOT NULL OR retracted_at IS NOT NULL OR current_revision <> proof_repairs.revision_no))", [Db::now(), $pid, $pid]);
    }

    // ----- what is due, and for whom -----

    /** The model whose word the step answers: the last one that objected (for a repair), or that repaired (for a check). */
    private static function lastBy(array $steps, string $step): ?string
    {
        for ($i = count($steps) - 1; $i >= 0; $i--) {
            $s = $steps[$i];
            if ($step === 'repair' && in_array($s['step'], ['review', 'check'], true)) return $s['model'] ?? null;
            if ($step === 'check' && $s['step'] === 'repair') return $s['model'] ?? null;
        }
        return null;
    }

    /**
     * The repairs waiting for this step, in the order of the facts to verify first. @return list<array> rows of proof_repairs
     */
    public static function due(int $pid, string $step): array
    {
        $rows = Db::all("SELECT r.* FROM proof_repairs r JOIN facts f ON f.id = r.fact_id AND f.current_revision = r.revision_no AND f.deleted_at IS NULL AND f.retracted_at IS NULL
                         WHERE r.project_id = ? AND r.state = ? ORDER BY r.id", [$pid, $step]);
        if (count($rows) < 2) return $rows;
        $rank = array_flip(array_keys(Verification::rank($pid)));
        usort($rows, fn($a, $b) => [$rank[(int)$a['fact_id']] ?? PHP_INT_MAX, (int)$a['id']] <=> [$rank[(int)$b['fact_id']] ?? PHP_INT_MAX, (int)$b['id']]);
        return $rows;
    }

    /**
     * Whether a model may take this step: another company than the side it answers, or, when no other company is around, at least
     * another model. A human reviewer's objection can be answered by any model.
     */
    public static function mayTake(array $r, string $model, array $around): bool
    {
        $other = self::lastBy(json_decode((string)$r['steps_json'], true) ?: [], (string)$r['state']);
        if ($other === null) return true;
        $mine = Verification::company($model); $theirs = Verification::company($other);
        if ($mine !== $theirs) return true;
        if (array_diff($around, [$theirs])) return false; // another company is around: the step waits for it
        return !Verification::sameModel($model, $other);
    }

    /** The repairs a model would take in one task of this step. @return array{0: list<int>, 1: bool} ids, and whether more was left */
    public static function batch(int $pid, string $step, string $model): array
    {
        $around = array_values(array_unique(array_filter(array_merge(Verification::companiesAround($pid), [Verification::company($model)]))));
        $out = []; $chars = 0; $full = false;
        foreach (self::due($pid, $step) as $r) {
            if (!self::mayTake($r, $model, $around)) continue;
            $size = strlen((string)$r['steps_json']) + (int)Db::value('SELECT LENGTH(statement_html) + LENGTH(COALESCE(proof_html, \'\')) FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$r['fact_id'], $r['revision_no']]);
            if ($out && (count($out) >= self::BATCH || $chars + $size > self::CHARS)) { $full = true; break; }
            $out[] = (int)$r['id']; $chars += $size;
        }
        return [$out, $full];
    }

    // ----- what the AI reads -----

    /** For a task: each repair with the fact, the proof under discussion, what it may rely on, and every step so far. */
    public static function context(int $pid, array $ids): array
    {
        $graph = array_column(FactController::graph($pid)['facts'], null, 'id');
        $usable = FactController::usable($graph);
        $out = [];
        foreach ($ids as $id) {
            $r = Db::one('SELECT * FROM proof_repairs WHERE id = ? AND project_id = ?', [$id, $pid]);
            if (!$r) continue;
            $f = Db::one('SELECT f.id, f.label, f.title, f.kind, r.statement_html, r.proof_html FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = ? WHERE f.id = ?', [$r['revision_no'], $r['fact_id']]);
            $proof = $r['proof_id'] ? Db::value('SELECT body_html FROM fact_proofs WHERE id = ?', [$r['proof_id']]) : null;
            $deps = Db::all('SELECT f.id, f.label, f.title, r.statement_html FROM fact_deps d JOIN facts f ON f.id = d.depends_on_id JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE d.fact_id = ? LIMIT 50', [$r['fact_id']]);
            $out[] = ['repair_id' => (int)$r['id'], 'round' => (int)$r['round'], 'rounds_at_most' => self::ROUNDS,
                'fact' => ['fact_id' => (int)$f['id'], 'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['kind'], 'statement' => Sanitizer::toText((string)$f['statement_html']),
                    'definitions' => FactController::definitions($pid, (int)$f['id'], (int)$r['revision_no'])],
                'original_proof' => Sanitizer::toText((string)$f['proof_html']),
                'proof_under_discussion' => $proof !== null ? Sanitizer::toText((string)$proof) : null,
                'dependencies' => array_map(fn($d) => ['label' => $d['label'], 'title' => $d['title'], 'statement' => Sanitizer::toText((string)$d['statement_html']),
                    'basis' => $graph[(int)$d['id']]['basis'] ?? null, 'usable' => $usable[(int)$d['id']] ?? false], $deps),
                'steps' => array_map(fn($s) => array_intersect_key($s, array_flip(['step', 'model', 'person', 'verdict', 'outcome', 'text'])), json_decode((string)$r['steps_json'], true) ?: [])];
        }
        return ['repairs' => $out];
    }

    // ----- applying the answers -----

    /** A repairer's answers: a repaired proof, the review is wrong, or a gap it cannot fix. @return array{summary: string, fact_ids: list<int>} */
    public static function applyRepairs(array $t, array $answers, ?string $model, mixed $seconds): array
    {
        $mine = array_flip(self::taskItems($t)); $facts = []; $by = ['repaired' => 0, 'review_wrong' => 0, 'real_gap' => 0];
        $each = is_numeric($seconds) ? $seconds / max(1, count($answers)) : null;
        foreach ($answers as $a) {
            $id = (int)$a['repair_id'];
            if (!isset($mine[$id])) continue;
            unset($mine[$id]); // once each
            $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND state = 'repair'", [$id]);
            if (!$r) continue;
            $text = trim((string)$a['explanation']);
            $outcome = (string)$a['outcome'];
            $steps = json_decode((string)$r['steps_json'], true) ?: [];
            $step = ['step' => 'repair', 'model' => $model, 'outcome' => $outcome, 'text' => $text, 'at' => Db::now()];
            $row = ['updated_at' => Db::now()];
            if ($outcome === 'repaired') {
                $proof = trim((string)($a['proof'] ?? ''));
                if ($proof === '') continue; // a repair without a proof is not one: the step stays due
                $step['proof_id'] = $row['proof_id'] = self::addProof($r, $proof, $text, $model, $each);
                $row['state'] = 'check';
            } elseif ($outcome === 'review_wrong') {
                $row['state'] = 'check';
            } else {
                $row['state'] = 'gap'; // the objection stands and its other side cannot fix it: both see a gap
            }
            $steps[] = $step;
            Db::update('proof_repairs', $row + ['steps_json' => json_encode($steps)], 'id = :id', ['id' => $id]);
            if ($row['state'] === 'check') self::queue((int)$r['project_id'], 'check');
            Activity::touch((int)$r['project_id'], 'fact', (int)$r['fact_id'], 'repair', $id);
            $facts[] = (int)$r['fact_id']; $by[$outcome]++;
        }
        $what = implode(', ', array_filter([$by['repaired'] ? "{$by['repaired']} repaired" : '', $by['review_wrong'] ? "{$by['review_wrong']} where the review is wrong" : '', $by['real_gap'] ? "{$by['real_gap']} with a gap it cannot fix" : '']));
        $n = count($facts);
        return ['summary' => "$n proof" . ($n === 1 ? '' : 's') . ' answered' . ($what ? " ($what)" : '') . '.', 'fact_ids' => $facts];
    }

    /** A checker's answers on the repaired proof, or on the answer that the review was wrong. */
    public static function applyChecks(array $t, array $answers, ?string $model, mixed $seconds): array
    {
        $mine = array_flip(self::taskItems($t)); $facts = []; $by = ['agreed' => 0, 'again' => 0, 'left' => 0];
        $each = is_numeric($seconds) ? $seconds / max(1, count($answers)) : null;
        foreach ($answers as $a) {
            $id = (int)$a['repair_id'];
            if (!isset($mine[$id])) continue;
            unset($mine[$id]);
            $r = Db::one("SELECT * FROM proof_repairs WHERE id = ? AND state = 'check'", [$id]);
            if (!$r) continue;
            $verdict = (string)$a['verdict']; $text = trim((string)$a['explanation']);
            if ($verdict !== 'correct' && $text === '') continue; // a flaw must be explained
            $steps = json_decode((string)$r['steps_json'], true) ?: [];
            $last = end($steps);
            if (($last['outcome'] ?? '') === 'repaired' && $r['proof_id']) self::reviewProof($r, $verdict, $text, $model, $each);
            elseif ($verdict === 'correct') self::reviewOriginal($r, $text, $model, $each); // convinced: the original proof holds
            $steps[] = ['step' => 'check', 'model' => $model, 'verdict' => $verdict, 'text' => $text, 'at' => Db::now()];
            if ($verdict === 'correct') { $state = 'proof'; $by['agreed']++; }
            elseif ((int)$r['round'] >= self::ROUNDS) { $state = 'disagree'; $by['left']++; }
            else { $state = 'repair'; $by['again']++; }
            Db::update('proof_repairs', ['state' => $state, 'round' => $state === 'repair' ? (int)$r['round'] + 1 : (int)$r['round'], 'steps_json' => json_encode($steps), 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
            if ($state === 'repair') self::queue((int)$r['project_id'], 'repair');
            Activity::touch((int)$r['project_id'], 'fact', (int)$r['fact_id'], 'repair', $id);
            $facts[] = (int)$r['fact_id'];
        }
        $what = implode(', ', array_filter([$by['agreed'] ? "{$by['agreed']} agreed on a proof" : '', $by['again'] ? "{$by['again']} back for another round" : '', $by['left'] ? "{$by['left']} left to people after " . self::ROUNDS . ' rounds' : '']));
        $n = count($facts);
        return ['summary' => "$n repair" . ($n === 1 ? '' : 's') . ' checked' . ($what ? " ($what)" : '') . '.', 'fact_ids' => $facts];
    }

    private static function taskItems(array $t): array
    {
        return array_map('intval', json_decode((string)($t['snapshot_json'] ?? ''), true)['items'] ?? []);
    }

    /** The repaired proof, as another proof of the fact by the repairing model, under the key that ran it. */
    private static function addProof(array $r, string $proof, string $changes, ?string $model, mixed $seconds): int
    {
        $pid = (int)$r['project_id'];
        $html = Sanitizer::clean(Sanitizer::textToHtml($proof, $pid))['html'];
        $now = Db::now();
        $id = Db::insert('fact_proofs', Provenance::stamp($model, $seconds) + ['fact_id' => $r['fact_id'], 'revision_no' => $r['revision_no'], 'author_id' => Auth::id(),
            'author_kind' => 'agent', 'ai_model' => $model, 'body_html' => $html, 'created_at' => $now, 'updated_at' => $now]);
        Activity::touch($pid, 'fact', (int)$r['fact_id'], 'proof', $id);
        return $id;
    }

    /** The checker's verdict on the repaired proof, as a review of that proof. */
    private static function reviewProof(array $r, string $verdict, string $text, ?string $model, mixed $seconds): void
    {
        $html = $text !== '' ? Sanitizer::clean(Sanitizer::textToHtml($text, (int)$r['project_id']))['html'] : null;
        $now = Db::now();
        $old = Db::value("SELECT id FROM fact_proof_reviews WHERE proof_id = ? AND reviewer_id = ? AND reviewer_kind = 'agent'", [$r['proof_id'], Auth::id()]);
        $row = Provenance::stamp($model, $seconds) + ['verdict' => $verdict, 'ai_model' => $model, 'body_html' => $html, 'updated_at' => $now];
        if ($old) Db::update('fact_proof_reviews', $row, 'id = :id', ['id' => $old]);
        else Db::insert('fact_proof_reviews', $row + ['proof_id' => $r['proof_id'], 'reviewer_id' => Auth::id(), 'reviewer_kind' => 'agent', 'created_at' => $now]);
    }

    /** Convinced that the review was wrong: the checker's own review of the original proof says so. */
    private static function reviewOriginal(array $r, string $text, ?string $model, mixed $seconds): void
    {
        try {
            FactController::recordReview(Request::internal(['verdict' => 'correct', 'body_text' => $text ?: 'Convinced by the answer to the review: the proof holds.', 'ai_model' => $model, 'generation_seconds' => $seconds], ['id' => (int)$r['fact_id']]));
        } catch (HttpError $e) {
            if ($e->status !== 403) throw $e; // the model that wrote the fact: the agreement is still recorded in the repair
        }
    }

    // ----- what people see -----

    /** The repairs of a fact's current revision, newest first, as the fact page shows them. */
    public static function forFact(int $fid, int $revision): array
    {
        return array_map(fn($r) => ['id' => (int)$r['id'], 'state' => $r['state'], 'round' => (int)$r['round'], 'rounds' => self::ROUNDS, 'proof_id' => $r['proof_id'] ? (int)$r['proof_id'] : null,
            'asked_by' => $r['asked_by'] ? (string)Db::value('SELECT name FROM users WHERE id = ?', [$r['asked_by']]) : null, 'review_id' => (int)$r['review_id'],
            'steps' => json_decode((string)$r['steps_json'], true) ?: [], 'updated_at' => $r['updated_at']],
            Db::all('SELECT * FROM proof_repairs WHERE fact_id = ? AND revision_no = ? ORDER BY id DESC', [$fid, $revision]));
    }

    /** The step a fact waits for, if any: "repair" or "check". */
    public static function pendingStep(int $fid): ?string
    {
        $s = Db::value("SELECT r.state FROM proof_repairs r JOIN facts f ON f.id = r.fact_id AND f.current_revision = r.revision_no WHERE r.fact_id = ? AND r.state IN ('repair', 'check') LIMIT 1", [$fid]);
        return $s ? (string)$s : null;
    }

    /** The reviews a repair settled, by id: both sides agreed on a proof, or the reviewer's side was convinced. */
    public static function resolvedReviews(int $pid): array
    {
        return array_fill_keys(array_map('intval', array_column(Db::all("SELECT review_id FROM proof_repairs WHERE project_id = ? AND state = 'proof'", [$pid]), 'review_id')), true);
    }
}
