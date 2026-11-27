<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Access;
use App\Activity;
use App\Auth;
use App\Db;
use App\HttpError;
use App\Provenance;
use App\Request;
use App\Response;
use App\Sanitizer;

/**
 * The native prover (docs/PROVER.md): a campaign on a question or a project, which the clients of members work on in rounds.
 * A worker round is a long AI session with tools; a lead round sums up the state and gives the workers their lanes.
 * Facts are platform facts, created only after the prover's verifier accepts them. Notes are what workers share.
 */
final class ProverController
{
    public const NOTE_KINDS = ['conclusion', 'example', 'counterexample', 'proof_attempt', 'plan', 'dead_end', 'direction', 'obstacle', 'verification'];
    public const LEAD_EVERY = 1800;       // seconds between lead rounds, in the periodic mode
    public const LEAD_MODES = ['periodic', 'continuous'];
    private const ROUND_LIMIT = 4 * 3600; // a round still running after this is abandoned
    private const MAX_LANES = 8;

    // ----- campaigns -----

    /** Starts a campaign, or joins the active one on the same question. People and AI clients may start one. */
    public static function start(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $qid = (int)$r->input('question_id') ?: null;
        if ($qid && !Db::value('SELECT 1 FROM open_questions WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [$qid, $pid])) throw new HttpError(422, 'This question is not in the project.');
        $c = Db::one('SELECT * FROM prover_campaigns WHERE project_id = ? AND ' . ($qid ? 'question_id = ?' : 'question_id IS NULL') . " AND status = 'active' ORDER BY id DESC LIMIT 1",
            $qid ? [$pid, $qid] : [$pid]);
        $mode = $r->str('lead_mode');
        if ($mode !== '' && !in_array($mode, self::LEAD_MODES, true)) throw new HttpError(422, 'lead_mode must be periodic or continuous.');
        if (!$c) {
            $now = Db::now();
            $id = Db::insert('prover_campaigns', ['project_id' => $pid, 'question_id' => $qid, 'goal_text' => mb_substr(trim($r->str('goal')), 0, 4000) ?: null,
                'status' => 'active', 'lead_mode' => $mode ?: 'periodic', 'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now]);
            $c = Db::one('SELECT * FROM prover_campaigns WHERE id = ?', [$id]);
        } elseif ($mode !== '' && $mode !== $c['lead_mode']) {
            // Joining with another mode changes it for everyone: the campaign has one lead.
            Db::update('prover_campaigns', ['lead_mode' => $mode, 'updated_at' => Db::now()], 'id = :id', ['id' => $c['id']]);
            $c['lead_mode'] = $mode;
        }
        Response::json(self::present($c), 201);
    }

    public static function list(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        Response::json(['campaigns' => array_map([self::class, 'present'], Db::all('SELECT * FROM prover_campaigns WHERE project_id = ? ORDER BY id DESC LIMIT 100', [$pid]))]);
    }

    public static function show(Request $r): never
    {
        $c = self::campaign($r->int('id'));
        Response::json(self::present($c) + ['recent_rounds' => array_map(fn($x) => self::ints($x, ['id', 'lane', 'seconds', 'facts', 'rejected', 'notes']),
            Db::all('SELECT id, kind, lane, engine, ai_model, client_name, status, started_at, finished_at, seconds, facts, rejected, notes, summary_text FROM prover_rounds WHERE campaign_id = ? ORDER BY id DESC LIMIT 200', [$c['id']]))]);
    }

    /** A member pauses, resumes or closes a campaign. A paused campaign gives no rounds. */
    public static function setStatus(Request $r): never
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can do this.');
        $c = self::campaign($r->int('id'));
        $status = $r->str('status', $c['status']);
        if (!in_array($status, ['active', 'paused', 'done'], true)) throw new HttpError(422, 'Choose active, paused or done.');
        $mode = $r->str('lead_mode', $c['lead_mode']);
        if (!in_array($mode, self::LEAD_MODES, true)) throw new HttpError(422, 'lead_mode must be periodic or continuous.');
        Db::update('prover_campaigns', ['status' => $status, 'lead_mode' => $mode, 'updated_at' => Db::now()], 'id = :id', ['id' => $c['id']]);
        Response::json(self::present(Db::one('SELECT * FROM prover_campaigns WHERE id = ?', [$c['id']])));
    }

    // ----- rounds -----

    /**
     * The next round for a client: the lead when one is due, otherwise a worker on the lane worked least recently.
     * Continuous mode: a client that offers to lead takes a lead session whenever none runs, so that one always does.
     * Without such a client, a periodic lead still runs every 30 minutes. `session` tells the client which kind of lead to run.
     */
    public static function claim(Request $r): never
    {
        $c = self::campaign($r->int('id'));
        if ($c['status'] !== 'active') throw new HttpError(409, 'This campaign is ' . $c['status'] . '.');
        $engine = $r->str('engine');
        if (!in_array($engine, ['claude', 'codex'], true)) throw new HttpError(422, 'engine must be claude or codex.');
        $model = Provenance::agentModel($r);
        $round = Db::tx(function () use ($c, $engine, $model, $r) {
            $cid = (int)$c['id'];
            $now = Db::now();
            Db::run("UPDATE prover_rounds SET status = 'failed', finished_at = ?, summary_text = 'Abandoned: the client stopped answering.' WHERE campaign_id = ? AND status = 'running' AND started_at < ?",
                [$now, $cid, date('Y-m-d H:i:s', time() - self::ROUND_LIMIT)]);
            $leadRunning = Db::value("SELECT 1 FROM prover_rounds WHERE campaign_id = ? AND kind = 'lead' AND status = 'running'", [$cid]);
            $due = !$c['lead_at'] || strtotime((string)$c['lead_at']) < time() - self::LEAD_EVERY;
            $lanes = count(self::guidance($c)['lanes'] ?? []) ?: 1;
            $session = $c['lead_mode'] === 'continuous' && $r->input('offer_lead') === true;
            if (!$leadRunning && ($session || $due)) { $kind = 'lead'; $lane = null; }
            else {
                $kind = 'worker';
                $last = [];
                foreach (Db::all("SELECT lane, MAX(id) AS last, SUM(status = 'running') AS busy FROM prover_rounds WHERE campaign_id = ? AND kind = 'worker' GROUP BY lane", [$cid]) as $x) $last[(int)$x['lane']] = [(int)$x['busy'], (int)$x['last']];
                $order = range(0, $lanes - 1);
                usort($order, fn($a, $b) => ($last[$a] ?? [0, 0]) <=> ($last[$b] ?? [0, 0]));
                $lane = $order[0];
            }
            $id = Db::insert('prover_rounds', ['ai_user_id' => Provenance::stamp($model, null)['ai_user_id'], 'campaign_id' => $cid, 'kind' => $kind, 'lane' => $lane, 'engine' => $engine, 'ai_model' => $model,
                'user_id' => Auth::id(), 'client_name' => mb_substr($r->str('client_name'), 0, 120) ?: null, 'status' => 'running', 'started_at' => $now]);
            if ($kind === 'lead') Db::update('prover_campaigns', ['lead_at' => $now], 'id = :id', ['id' => $cid]);
            return ['id' => $id, 'kind' => $kind, 'lane' => $lane, 'session' => $kind === 'lead' && $session];
        });
        $g = self::guidance($c);
        $round['lane_task'] = $round['lane'] !== null ? ($g['lanes'][$round['lane']] ?? null) : null;
        Response::json(['round' => $round, 'campaign' => self::present($c)], 201);
    }

    public static function finish(Request $r): never
    {
        $x = self::round($r->int('id'), true);
        $failed = $r->input('error') !== null && trim((string)$r->input('error')) !== '';
        Db::update('prover_rounds', ['status' => $failed ? 'failed' : 'done', 'finished_at' => Db::now(), 'seconds' => max(0, min(86400, (int)$r->input('seconds'))),
            'summary_text' => mb_substr(trim($failed ? (string)$r->input('error') : $r->str('summary')), 0, 2000) ?: null], 'id = :id', ['id' => $x['id']]);
        // A round that added facts: the whole database is read again, with the questions they may settle.
        if (Db::value("SELECT 1 FROM facts WHERE project_id = ? AND external_id LIKE ? AND deleted_at IS NULL", [$x['project_id'], "prover-r{$x['id']}-%"])) AiTaskController::queueConsolidation((int)$x['project_id']);
        Response::json(['ok' => true]);
    }

    /** The lead's answer: its summary and guidance become the campaign's, and a revision of its strategy on the question. */
    public static function lead(Request $r): never
    {
        $x = self::round($r->int('id'), true);
        if ($x['kind'] !== 'lead') throw new HttpError(409, 'This is not a lead round.');
        $c = Db::one('SELECT * FROM prover_campaigns WHERE id = ?', [$x['campaign_id']]);
        $text = fn($k, $n) => mb_substr(trim(is_scalar($r->input($k)) ? (string)$r->input($k) : ''), 0, $n);
        $lanes = [];
        foreach (array_slice((array)$r->input('lanes', []), 0, self::MAX_LANES) as $l) {
            if (!is_array($l)) continue;
            $t = mb_substr(trim((string)($l['title'] ?? '')), 0, 200); $task = mb_substr(trim((string)($l['task'] ?? '')), 0, 4000);
            if ($t !== '' && $task !== '') $lanes[] = ['title' => $t, 'task' => $task];
        }
        if (!$lanes) throw new HttpError(422, 'Give at least one lane, with a title and a task.');
        $g = ['summary' => $text('summary', 2000), 'elaboration' => $text('elaboration', 20000), 'guidance' => $text('guidance', 20000), 'lanes' => $lanes, 'model' => $x['ai_model'], 'at' => Db::now()];
        $model = $x['ai_model'];
        $sid = $c['strategy_id'] ? (int)$c['strategy_id'] : null;
        if ($c['question_id']) {
            $html = Sanitizer::clean(Sanitizer::textToHtml("**State of the search**\n\n{$g['summary']}\n\n{$g['elaboration']}\n\n**Guidance**\n\n{$g['guidance']}\n\n**Lanes**\n\n"
                . implode("\n", array_map(fn($l) => "- **{$l['title']}**: {$l['task']}", $lanes)), (int)$c['project_id']))['html'];
            $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
            Db::tx(function () use (&$sid, $c, $html, $model, $stamp) {
                $now = Db::now();
                $s = $sid ? Db::one('SELECT * FROM proof_strategies WHERE id = ? AND deleted_at IS NULL', [$sid]) : null;
                if (!$s) {
                    $sid = Db::insert('proof_strategies', ['project_id' => $c['project_id'], 'question_id' => $c['question_id'], 'title' => 'Proof search with the native prover', 'status' => 'active',
                        'current_revision' => 1, 'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now]);
                    QuestionController::revision($sid, 1, 'Proof search with the native prover', 'active', $html, 'First state of the search', $model, $stamp);
                    Activity::touch((int)$c['project_id'], 'strategy', $sid, 'created');
                } elseif ((string)Db::value('SELECT body_html FROM strategy_revisions WHERE strategy_id = ? AND revision_no = ?', [$sid, $s['current_revision']]) !== $html) {
                    $no = (int)$s['current_revision'] + 1;
                    QuestionController::revision($sid, $no, $s['title'], $s['status'], $html, 'New state of the search', $model, $stamp);
                    Db::update('proof_strategies', ['current_revision' => $no, 'updated_at' => $now], 'id = :id', ['id' => $sid]);
                    Activity::touch((int)$c['project_id'], 'strategy', $sid, 'updated');
                }
            });
        }
        $stop = $r->input('stop') === true;
        Db::update('prover_campaigns', ['guidance_json' => json_encode($g, JSON_UNESCAPED_UNICODE), 'strategy_id' => $sid, 'status' => $stop ? 'paused' : $c['status'], 'lead_at' => Db::now(), 'updated_at' => Db::now()], 'id = :id', ['id' => $c['id']]);
        Response::json(['ok' => true, 'strategy_id' => $sid, 'paused' => $stop]);
    }

    // ----- notes and facts of a round -----

    public static function notes(Request $r): never
    {
        $c = self::campaign($r->int('id'));
        $since = (int)($r->query['since'] ?? 0);
        Response::json(['notes' => array_map(fn($n) => self::ints($n, ['id', 'round_id', 'fact_id']),
            Db::all('SELECT id, round_id, kind, claim, evidence, fact_id, ai_model, created_at FROM prover_notes WHERE campaign_id = ? AND id > ? ORDER BY id LIMIT 2000', [$c['id'], $since]))]);
    }

    public static function addNote(Request $r): never
    {
        $x = self::round($r->int('id'), true);
        $kind = $r->str('kind');
        if (!in_array($kind, self::NOTE_KINDS, true)) throw new HttpError(422, 'Unknown kind of note. Use: ' . implode(', ', self::NOTE_KINDS) . '.');
        $claim = mb_substr(trim($r->str('claim')), 0, 8000);
        if ($claim === '') throw new HttpError(422, 'A note needs a claim.');
        $id = self::note($x, $kind, $claim, mb_substr(trim($r->str('evidence')), 0, 60000), null);
        Response::json(['id' => $id], 201);
    }

    /**
     * A fact the prover's verifier accepted. It relies only on facts the prover may build on. It is created as an AI-deduced fact,
     * with the verifier's review: an independent check when the verifier is another model than the worker.
     */
    public static function addFact(Request $r): never
    {
        $x = self::round($r->int('id'), true);
        $c = Db::one('SELECT * FROM prover_campaigns WHERE id = ?', [$x['campaign_id']]);
        $pid = (int)$c['project_id'];
        $v = (array)$r->input('verifier', []);
        $vModel = Provenance::model(is_string($v['model'] ?? null) ? $v['model'] : '');
        if (!$vModel) throw new HttpError(422, 'Name the verifier\'s model.');
        $deps = array_values(array_unique(array_map('intval', (array)$r->input('depends_on', []))));
        self::assertUsable($pid, $deps);
        $n = (int)Db::value('SELECT COUNT(*) FROM facts WHERE project_id = ? AND external_id LIKE ?', [$pid, "prover-r{$x['id']}-%"]) + 1;
        $kind = in_array($r->str('kind'), ['lemma', 'proposition', 'theorem', 'corollary', 'observation', 'counterexample'], true) ? $r->str('kind') : 'lemma';
        $glossary = array_filter((array)$r->input('glossary', []), fn($v, $k) => is_string($k) && is_string($v), ARRAY_FILTER_USE_BOTH);
        $fid = FactController::addFact($pid, ['title' => $r->str('title'), 'kind' => $kind, 'labels' => [$kind === 'counterexample' ? 'counterexample' : 'conclusion'], 'method' => 'deduced',
            'statement_text' => $r->str('statement'), 'proof_text' => $r->str('proof'), 'depends_on' => array_map('strval', $deps), 'glossary' => $glossary ?: null,
            'ai_model' => $x['ai_model'], 'tool' => 'prover', 'external_id' => "prover-r{$x['id']}-$n", 'notes' => 'Found by the native prover, accepted by its verifier']);
        $f = Db::one('SELECT * FROM facts WHERE id = ?', [$fid]);
        $now = Db::now();
        Db::insert('fact_reviews', Provenance::stamp($vModel, $v['seconds'] ?? null) + ['fact_id' => $fid, 'revision_no' => (int)$f['current_revision'], 'reviewer_id' => Auth::id(),
            'reviewer_kind' => 'agent', 'ai_model' => $vModel, 'verdict' => 'correct', 'statement_verdict' => 'true',
            'body_html' => Sanitizer::clean(Sanitizer::textToHtml('The prover\'s verifier accepted this proof, assuming the facts it relies on. ' . mb_substr((string)($v['report'] ?? ''), 0, 20000), $pid))['html'],
            'created_at' => $now, 'updated_at' => $now]);
        Db::run('UPDATE prover_rounds SET facts = facts + 1 WHERE id = ?', [$x['id']]);
        self::note($x, 'conclusion', $r->str('statement'), 'Verified and recorded as ' . $f['label'], $fid, false);
        Activity::touch($pid, 'fact', $fid, 'updated');
        Response::json(['id' => $fid, 'label' => $f['label']], 201);
    }

    /** A proof the verifier rejected: shared as a verification note, so that no worker repeats it. */
    public static function rejected(Request $r): never
    {
        $x = self::round($r->int('id'), true);
        Db::run('UPDATE prover_rounds SET rejected = rejected + 1 WHERE id = ?', [$x['id']]);
        $id = self::note($x, 'verification', mb_substr(trim($r->str('statement')), 0, 8000) ?: 'A proof', 'Rejected by the verifier. ' . mb_substr(trim($r->str('hints')), 0, 30000), null, false);
        Response::json(['id' => $id], 201);
    }

    /**
     * A result of the literature, as a cited result. The client checked it against its source first; the check is recorded.
     * People still accept it; the prover may build on it once the check confirmed it.
     */
    public static function addCited(Request $r): never
    {
        $x = self::round($r->int('id'), true);
        $c = Db::one('SELECT * FROM prover_campaigns WHERE id = ?', [$x['campaign_id']]);
        $pid = (int)$c['project_id'];
        $ref = (array)$r->input('reference', []);
        $ref = array_filter(array_intersect_key($ref, array_flip(['key', 'authors', 'title', 'arxiv', 'year', 'venue', 'doi', 'url', 'cited_for'])), fn($v) => is_scalar($v) || is_array($v));
        if (!($ref['title'] ?? null) && !($ref['doi'] ?? null) && !($ref['arxiv'] ?? null)) throw new HttpError(422, 'Give the reference: at least a title, a DOI or an arXiv id.');
        $check = (array)$r->input('check', []);
        $verdict = in_array($check['verdict'] ?? null, ['confirmed', 'differs', 'not_found', 'unreadable'], true) ? $check['verdict'] : null;
        if (!$verdict) throw new HttpError(422, 'Give the source check: confirmed, differs, not_found or unreadable.');
        $fid = FactController::addFact($pid, ['title' => $r->str('title'), 'kind' => 'theorem', 'labels' => ['conclusion'], 'method' => 'extracted', 'statement_text' => $r->str('statement'),
            'external_refs' => [$ref], 'ai_model' => $x['ai_model'], 'tool' => 'prover', 'notes' => 'Cited by the native prover'], true);
        $f = Db::one('SELECT * FROM facts WHERE id = ?', [$fid]);
        $cm = Provenance::model(is_string($check['model'] ?? null) ? $check['model'] : '') ?? $x['ai_model'];
        Db::insert('fact_source_checks', Provenance::stamp($cm, $check['seconds'] ?? null) + ['fact_id' => $fid, 'revision_no' => (int)$f['current_revision'], 'verdict' => $verdict,
            'body_html' => Sanitizer::clean(Sanitizer::textToHtml(mb_substr((string)($check['explanation'] ?? ''), 0, 20000) ?: '-', $pid))['html'], 'ai_model' => $cm,
            'checked_by' => Auth::id(), 'task_id' => null, 'created_at' => Db::now()]);
        self::note($x, 'conclusion', $r->str('statement'), "Cited from the literature as {$f['label']}; the source check says: $verdict", $fid, false);
        Response::json(['id' => $fid, 'label' => $f['label'], 'verdict' => $verdict], 201);
    }

    // ----- comparison -----

    /** Danus and the native prover side by side: computing time, facts found, and what became of them. */
    public static function stats(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $byId = array_column(FactController::graph($pid)['facts'], null, 'id');
        $out = [];
        foreach (['danus' => 'danus', 'native' => 'prover'] as $engine => $tool) {
            $facts = array_filter($byId, fn($f) => $f['tool'] === $tool);
            $seconds = $engine === 'danus'
                ? (int)round((int)Db::value("SELECT COALESCE(SUM(ai_generation_ms), 0) FROM ai_tasks WHERE project_id = ? AND kind = 'derive' AND status IN ('done', 'failed')", [$pid]) / 1000)
                : (int)Db::value('SELECT COALESCE(SUM(r.seconds), 0) FROM prover_rounds r JOIN prover_campaigns c ON c.id = r.campaign_id WHERE c.project_id = ?', [$pid]);
            $count = fn(callable $p) => count(array_filter($facts, $p));
            $n = count($facts);
            $out[$engine] = ['facts' => $n, 'seconds' => $seconds, 'facts_per_hour' => $seconds ? round($n / ($seconds / 3600), 2) : null,
                'established' => $count(fn($f) => in_array($f['status'], FactController::ESTABLISHED, true)),
                'checked_by_a_person' => $count(fn($f) => in_array($f['status'], ['human_checked', 'double_checked', 'accepted'], true)),
                'disputed' => $count(fn($f) => in_array($f['status'], ['disputed', 'proof_disputed'], true)),
                'retracted' => $count(fn($f) => $f['status'] === 'retracted'),
                'used_by_other_facts' => $count(fn($f) => count($f['dependents']) > 0)];
        }
        $out['native']['rejected_by_verifier'] = (int)Db::value('SELECT COALESCE(SUM(r.rejected), 0) FROM prover_rounds r JOIN prover_campaigns c ON c.id = r.campaign_id WHERE c.project_id = ?', [$pid]);
        Response::json($out);
    }

    // ----- helpers -----

    /** Every fact a prover fact relies on must be one it may build on. */
    private static function assertUsable(int $pid, array $deps): void
    {
        if (!$deps) return;
        $byId = array_column(FactController::graph($pid)['facts'], null, 'id');
        $usable = FactController::usable($byId);
        foreach ($deps as $d) {
            $f = $byId[$d] ?? null;
            if (!$f) throw new HttpError(422, "Fact $d is not in this project.");
            if (!($usable[$d] ?? false)) throw new HttpError(422, "{$f['label']} is not usable yet: verify it, or what it relies on, before building on it.");
        }
    }

    private static function note(array $x, string $kind, string $claim, string $evidence, ?int $factId, bool $count = true): int
    {
        $id = Db::insert('prover_notes', ['campaign_id' => $x['campaign_id'], 'round_id' => $x['id'], 'kind' => $kind, 'claim' => mb_substr($claim, 0, 8000), 'evidence' => $evidence ?: null,
            'fact_id' => $factId, 'ai_model' => $x['ai_model'], 'created_at' => Db::now()]);
        if ($count) Db::run('UPDATE prover_rounds SET notes = notes + 1 WHERE id = ?', [$x['id']]);
        return $id;
    }

    private static function campaign(int $id): array
    {
        $c = Db::one('SELECT * FROM prover_campaigns WHERE id = ?', [$id]);
        if (!$c || !Access::role((int)$c['project_id'])) throw new HttpError(404, 'Campaign not found.');
        return $c;
    }

    /** A round, only for the client that holds it. */
    private static function round(int $id, bool $running): array
    {
        $x = Db::one('SELECT r.*, c.project_id FROM prover_rounds r JOIN prover_campaigns c ON c.id = r.campaign_id WHERE r.id = ?', [$id]);
        if (!$x || !Access::role((int)$x['project_id'])) throw new HttpError(404, 'Round not found.');
        if ((int)$x['user_id'] !== Auth::id()) throw new HttpError(403, 'This round belongs to another client.');
        if ($running && $x['status'] !== 'running') throw new HttpError(409, 'This round is over.');
        return $x;
    }

    private static function guidance(array $c): array
    {
        return json_decode((string)$c['guidance_json'], true) ?: [];
    }

    private static function present(array $c): array
    {
        $g = self::guidance($c);
        $stats = Db::one("SELECT COUNT(*) AS rounds, COALESCE(SUM(seconds), 0) AS seconds, COALESCE(SUM(facts), 0) AS facts, COALESCE(SUM(rejected), 0) AS rejected, SUM(status = 'running') AS running FROM prover_rounds WHERE campaign_id = ?", [$c['id']]);
        return ['id' => (int)$c['id'], 'project_id' => (int)$c['project_id'], 'question_id' => $c['question_id'] ? (int)$c['question_id'] : null, 'goal' => $c['goal_text'],
            'status' => $c['status'], 'lead_mode' => $c['lead_mode'] ?? 'periodic', 'strategy_id' => $c['strategy_id'] ? (int)$c['strategy_id'] : null, 'lead_at' => $c['lead_at'], 'created_at' => $c['created_at'],
            'guidance' => $g ?: null, 'rounds' => (int)$stats['rounds'], 'running' => (int)$stats['running'], 'seconds' => (int)$stats['seconds'], 'facts' => (int)$stats['facts'], 'rejected' => (int)$stats['rejected']];
    }

    private static function ints(array $row, array $keys): array
    {
        foreach ($keys as $k) if (array_key_exists($k, $row) && $row[$k] !== null) $row[$k] = (int)$row[$k];
        return $row;
    }
}
