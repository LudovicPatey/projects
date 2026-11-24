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

/**
 * Consolidation: an AI reads the whole facts database and proposes changes that no single extraction can see.
 * Two facts that state the same result, a dependency between facts from different sources, a wrong kind,
 * a remark that is really an open question, and free subject tags. People accept or reject each proposal.
 */
final class ConsolidationController
{
    public const KINDS = ['same', 'depends', 'kind', 'question', 'topics'];
    public const MAX_TOPICS = 8;
    private const MAX_TOPIC_LENGTH = 40;
    private const MAX_PER_POST = 200;

    // ----- for people -----

    public static function list(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        self::obsolete($pid);
        $rows = Db::all(
            "SELECT s.*, u.name AS ai_user_name, d.name AS decided_by_name FROM fact_suggestions s LEFT JOIN users u ON u.id = s.ai_user_id LEFT JOIN users d ON d.id = s.decided_by
             WHERE s.project_id = ? ORDER BY CASE s.status WHEN 'proposed' THEN 0 ELSE 1 END, s.id DESC LIMIT 1000", [$pid]);
        $ids = [];
        foreach ($rows as $s) { $ids[(int)$s['fact_id']] = true; if ($s['other_fact_id']) $ids[(int)$s['other_fact_id']] = true; }
        $facts = [];
        if ($ids) {
            [$in, $p] = Db::in(array_keys($ids));
            foreach (Db::all("SELECT f.id, f.label, f.title, f.kind, f.deleted_at, f.merged_into, f.topics_json, r.statement_html FROM facts f
                              JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE f.id IN $in", $p) as $f) {
                $facts[(int)$f['id']] = ['id' => (int)$f['id'], 'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['kind'], 'deleted' => $f['deleted_at'] !== null,
                    'merged_into' => $f['merged_into'] ? (int)$f['merged_into'] : null, 'topics' => self::decode($f['topics_json']),
                    'excerpt' => mb_substr(\App\Sanitizer::toText((string)$f['statement_html']), 0, 400)];
            }
        }
        $counts = array_fill_keys(self::KINDS, 0);
        foreach ($rows as $s) if ($s['status'] === 'proposed') $counts[$s['kind']]++;
        $task = Db::one("SELECT id, status, created_at FROM ai_tasks WHERE project_id = ? AND kind = 'consolidate' AND status IN ('pending', 'running') ORDER BY id DESC LIMIT 1", [$pid]);
        Response::json(['suggestions' => array_map([self::class, 'present'], $rows), 'facts' => (object)$facts, 'counts' => $counts,
            'topics' => self::topics($pid), 'waiting' => $task ? ['id' => (int)$task['id'], 'status' => $task['status'], 'created_at' => $task['created_at']] : null]);
    }

    /** Every subject tag used in the project, most used first. */
    public static function topics(int $pid): array
    {
        $n = [];
        foreach (Db::all('SELECT topics_json FROM facts WHERE project_id = ? AND deleted_at IS NULL AND topics_json IS NOT NULL', [$pid]) as $f) {
            foreach (self::decode($f['topics_json']) as $t) $n[$t] = ($n[$t] ?? 0) + 1;
        }
        arsort($n);
        return array_map(fn($k, $v) => ['topic' => (string)$k, 'facts' => $v], array_keys($n), array_values($n));
    }

    public static function accept(Request $r): never
    {
        self::humanOnly();
        $s = self::proposed($r->int('sid'));
        $result = Db::tx(fn() => self::apply($s, Auth::id()));
        Response::json(['ok' => true] + $result);
    }

    public static function reject(Request $r): never
    {
        self::humanOnly();
        $s = self::proposed($r->int('sid'));
        Db::update('fact_suggestions', ['status' => 'rejected', 'decided_by' => Auth::id(), 'decided_at' => Db::now()], 'id = :id', ['id' => $s['id']]);
        Response::json(['ok' => true]);
    }

    /** Accepts or rejects several at once. Each one is applied on its own: one that fails does not stop the others. */
    public static function bulk(Request $r): never
    {
        self::humanOnly();
        $pid = $r->int('id');
        Access::member($pid);
        $decision = $r->str('decision');
        if (!in_array($decision, ['accept', 'reject'], true)) throw new HttpError(422, 'Choose accept or reject.');
        $ids = array_slice(array_values(array_unique(array_map('intval', (array)$r->input('ids', [])))), 0, 500);
        $done = 0; $failed = [];
        foreach ($ids as $sid) {
            $s = Db::one("SELECT * FROM fact_suggestions WHERE id = ? AND project_id = ? AND status = 'proposed'", [$sid, $pid]);
            if (!$s) continue;
            try {
                if ($decision === 'reject') Db::update('fact_suggestions', ['status' => 'rejected', 'decided_by' => Auth::id(), 'decided_at' => Db::now()], 'id = :id', ['id' => $sid]);
                else { self::mayDecide($s); Db::tx(fn() => self::apply($s, Auth::id())); }
                $done++;
            } catch (HttpError $e) {
                $failed[] = ['id' => $sid, 'error' => $e->getMessage()];
            }
        }
        Response::json(['done' => $done, 'failed' => $failed]);
    }

    /** A person sets the subject tags of a fact. */
    public static function setTopics(Request $r): never
    {
        self::humanOnly();
        $f = Access::fact($r->int('id'));
        $topics = self::clean((array)$r->input('topics', []));
        Db::update('facts', ['topics_json' => $topics ? json_encode($topics, JSON_UNESCAPED_UNICODE) : null, 'updated_at' => Db::now()], 'id = :id', ['id' => $f['id']]);
        Response::json(['topics' => $topics]);
    }

    // ----- for AI clients -----

    public static function suggest(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        if (!Auth::isAi()) throw new HttpError(403, 'This is for AI clients.');
        $items = $r->input('suggestions');
        if (!is_array($items) || !array_is_list($items) || count($items) > self::MAX_PER_POST) throw new HttpError(422, 'suggestions must be a list of at most ' . self::MAX_PER_POST . ' proposals.');
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $taskId = (int)$r->input('task_id') ?: null;
        if ($taskId && (int)Db::value('SELECT project_id FROM ai_tasks WHERE id = ?', [$taskId]) !== $pid) $taskId = null;
        Response::json(self::store($pid, $items, $model, $stamp, $taskId), 201);
    }

    /** Records the proposals that are valid and new. @return array{created: list<int>, skipped: list<array>} */
    public static function store(int $pid, array $items, ?string $model, array $stamp, ?int $taskId): array
    {
        $created = []; $skipped = [];
        foreach ($items as $i => $x) {
            try {
                $s = self::cleanSuggestion($pid, $x);
            } catch (HttpError $e) {
                $skipped[] = ['index' => $i, 'reason' => $e->getMessage()];
                continue;
            }
            if ($why = self::known($pid, $s)) { $skipped[] = ['index' => $i, 'reason' => $why]; continue; }
            $created[] = Db::insert('fact_suggestions', $s + $stamp + ['project_id' => $pid, 'task_id' => $taskId, 'status' => 'proposed', 'ai_model' => $model, 'created_at' => Db::now()]);
        }
        return ['created' => $created, 'skipped' => $skipped];
    }

    /** What the AI reads: every fact in short, with its source, its dependencies and its tags, and what was already proposed. */
    public static function context(int $pid): array
    {
        $deps = [];
        foreach (Db::all('SELECT d.fact_id, d.depends_on_id FROM fact_deps d JOIN facts f ON f.id = d.fact_id WHERE f.project_id = ? AND f.deleted_at IS NULL', [$pid]) as $e) {
            $deps[(int)$e['fact_id']][] = (int)$e['depends_on_id'];
        }
        $facts = array_map(fn($f) => [
            'id' => (int)$f['id'], 'label' => $f['label'], 'kind' => $f['kind'], 'title' => $f['title'],
            'statement' => mb_substr(\App\Sanitizer::toText((string)$f['statement_html']), 0, 900),
            'has_proof' => trim((string)$f['proof_html']) !== '',
            'source' => Db::value("SELECT COALESCE(b.cite_key, d.title, s.source_type) FROM fact_sources s LEFT JOIN bib_entries b ON s.source_type = 'bib' AND b.id = s.source_id
                                   LEFT JOIN documents d ON s.source_type = 'document' AND d.id = s.source_id WHERE s.fact_id = ? AND s.revision_no = ? AND s.covers <> 'context' LIMIT 1", [$f['id'], $f['current_revision']]),
            'depends_on' => $deps[(int)$f['id']] ?? [], 'topics' => self::decode($f['topics_json']),
        ], Db::all('SELECT f.id, f.label, f.kind, f.title, f.current_revision, f.topics_json, r.statement_html, r.proof_html FROM facts f
                    JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
                    WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL ORDER BY f.id LIMIT 600', [$pid]));
        $decided = array_map(fn($s) => ['kind' => $s['kind'], 'fact_id' => (int)$s['fact_id'], 'other_fact_id' => $s['other_fact_id'] ? (int)$s['other_fact_id'] : null,
            'data' => json_decode((string)$s['data_json'], true), 'status' => $s['status']],
            Db::all("SELECT kind, fact_id, other_fact_id, data_json, status FROM fact_suggestions WHERE project_id = ? AND status IN ('proposed', 'rejected') ORDER BY id DESC LIMIT 600", [$pid]));
        return ['fact_texts' => $facts, 'topics' => self::topics($pid), 'earlier_suggestions' => $decided,
            'omitted_facts' => max(0, (int)Db::value('SELECT COUNT(*) FROM facts WHERE project_id = ? AND deleted_at IS NULL AND retracted_at IS NULL', [$pid]) - count($facts))];
    }

    // ----- applying a suggestion -----

    /** @return array<string, mixed> what changed */
    public static function apply(array $s, int $me): array
    {
        $pid = (int)$s['project_id'];
        $fid = (int)$s['fact_id'];
        $other = $s['other_fact_id'] ? (int)$s['other_fact_id'] : null;
        $data = json_decode((string)$s['data_json'], true) ?: [];
        $f = self::live($pid, $fid);
        $out = [];
        switch ($s['kind']) {
            case 'same':
                $out = self::merge($pid, $f, self::live($pid, (int)$other), $me);
                break;
            case 'depends':
                $o = self::live($pid, (int)$other);
                if (!Db::value('SELECT 1 FROM fact_deps WHERE fact_id = ? AND depends_on_id = ?', [$fid, $o['id']])) {
                    self::assertAcyclic($pid, $fid, (int)$o['id']);
                    Db::insert('fact_deps', ['fact_id' => $fid, 'depends_on_id' => $o['id']]);
                    // The revision keeps the list of what it relies on: the text did not change, so its reviews stand.
                    $deps = array_map('intval', array_column(Db::all('SELECT depends_on_id FROM fact_deps WHERE fact_id = ? ORDER BY depends_on_id', [$fid]), 'depends_on_id'));
                    Db::update('fact_revisions', ['deps_json' => json_encode($deps)], 'fact_id = :f AND revision_no = :n', ['f' => $fid, 'n' => $f['current_revision']]);
                    Activity::touch($pid, 'fact', $fid, 'updated');
                }
                $out = ['fact_id' => $fid];
                break;
            case 'kind':
                $kind = (string)($data['kind'] ?? '');
                if (!in_array($kind, FactController::kinds(), true)) throw new HttpError(422, 'Unknown kind.');
                Db::update('facts', ['kind' => $kind, 'updated_at' => Db::now()], 'id = :id', ['id' => $fid]);
                Activity::touch($pid, 'fact', $fid, 'updated');
                $out = ['fact_id' => $fid];
                break;
            case 'question':
                $out = self::toQuestion($pid, $f, $s, $data, $me);
                break;
            case 'topics':
                $topics = self::clean(array_merge(self::decode($f['topics_json']), (array)($data['topics'] ?? [])));
                Db::update('facts', ['topics_json' => $topics ? json_encode($topics, JSON_UNESCAPED_UNICODE) : null, 'updated_at' => Db::now()], 'id = :id', ['id' => $fid]);
                $out = ['fact_id' => $fid, 'topics' => $topics];
                break;
            default:
                throw new HttpError(422, 'Unknown suggestion.');
        }
        Db::update('fact_suggestions', ['status' => 'accepted', 'decided_by' => $me, 'decided_at' => Db::now()], 'id = :id', ['id' => $s['id']]);
        return $out;
    }

    /**
     * Two facts state the same result: the duplicate goes, and everything that pointed to it points to the kept fact.
     * Its sources join the kept fact's, and its proof becomes another proof of it.
     */
    private static function merge(int $pid, array $keep, array $dup, int $me): array
    {
        $k = (int)$keep['id']; $d = (int)$dup['id'];
        if ($k === $d) throw new HttpError(422, 'A fact cannot be merged into itself.');
        if (QuestionController::hasRatifiedAnswer($d)) throw new HttpError(409, "{$dup['label']} supports a ratified answer: merge the other way, or revoke the ratification first.");
        // What relied on the duplicate now relies on the kept fact. Refuse when that closes a cycle.
        $dependents = array_map('intval', array_column(Db::all('SELECT fact_id FROM fact_deps WHERE depends_on_id = ?', [$d]), 'fact_id'));
        foreach ($dependents as $x) {
            if ($x === $k) continue;
            self::assertAcyclic($pid, $x, $k, $d);
        }
        foreach ($dependents as $x) {
            Db::run('DELETE FROM fact_deps WHERE fact_id = ? AND depends_on_id = ?', [$x, $d]);
            if ($x !== $k && !Db::value('SELECT 1 FROM fact_deps WHERE fact_id = ? AND depends_on_id = ?', [$x, $k])) Db::insert('fact_deps', ['fact_id' => $x, 'depends_on_id' => $k]);
            $deps = array_map('intval', array_column(Db::all('SELECT depends_on_id FROM fact_deps WHERE fact_id = ? ORDER BY depends_on_id', [$x]), 'depends_on_id'));
            Db::run('UPDATE fact_revisions SET deps_json = ? WHERE fact_id = ? AND revision_no = (SELECT current_revision FROM facts WHERE id = ?)', [json_encode($deps), $x, $x]);
        }
        Db::run('DELETE FROM fact_deps WHERE fact_id = ?', [$d]);
        // Sources: where else the result is stated.
        $have = [];
        foreach (Db::all('SELECT source_type, source_id, quote FROM fact_sources WHERE fact_id = ? AND revision_no = ?', [$k, $keep['current_revision']]) as $x) $have[$x['source_type'] . ':' . $x['source_id'] . ':' . $x['quote']] = true;
        foreach (Db::all('SELECT * FROM fact_sources WHERE fact_id = ? AND revision_no = ?', [$d, $dup['current_revision']]) as $x) {
            if (isset($have[$x['source_type'] . ':' . $x['source_id'] . ':' . $x['quote']])) continue;
            unset($x['id']);
            // Only the statement is shared: the duplicate's proof is kept as another proof below.
            if (in_array($x['covers'], ['proof', 'both'], true)) $x['covers'] = 'statement';
            Db::insert('fact_sources', ['fact_id' => $k, 'revision_no' => $keep['current_revision']] + $x);
        }
        $rev = Db::one('SELECT * FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$d, $dup['current_revision']]);
        $proofId = null;
        if ($rev && trim((string)$rev['proof_html']) !== '') {
            $now = Db::now();
            $note = '<p><em>Proof of ' . htmlspecialchars((string)$dup['label']) . ', merged into this fact as the same result.</em></p>';
            $proofId = Db::insert('fact_proofs', ['fact_id' => $k, 'revision_no' => $keep['current_revision'], 'author_id' => (int)$rev['author_id'],
                'author_kind' => $rev['ai_model'] !== null ? 'agent' : 'human', 'ai_model' => $rev['ai_model'], 'ai_user_id' => $rev['ai_user_id'], 'ai_generation_ms' => $rev['ai_generation_ms'],
                'body_html' => $note . $rev['proof_html'], 'created_at' => $now, 'updated_at' => $now]);
        }
        // Answers to questions, question links and stars follow.
        Db::run("UPDATE question_answers SET fact_id = ?, fact_revision = ? WHERE fact_id = ? AND state = 'proposed'", [$k, $keep['current_revision'], $d]);
        foreach (Db::all("SELECT id, question_id, strategy_id FROM question_links WHERE target_type = 'fact' AND target_id = ?", [$d]) as $l) {
            if (Db::value("SELECT 1 FROM question_links WHERE question_id = ? AND strategy_id = ? AND target_type = 'fact' AND target_id = ?", [$l['question_id'], $l['strategy_id'], $k])) Db::run('DELETE FROM question_links WHERE id = ?', [$l['id']]);
            else Db::run('UPDATE question_links SET target_id = ? WHERE id = ?', [$k, $l['id']]);
        }
        foreach (Db::all('SELECT user_id, created_at FROM fact_stars WHERE fact_id = ?', [$d]) as $st) {
            if (!Db::value('SELECT 1 FROM fact_stars WHERE fact_id = ? AND user_id = ?', [$k, $st['user_id']])) Db::insert('fact_stars', ['fact_id' => $k, 'user_id' => $st['user_id'], 'created_at' => $st['created_at']]);
        }
        Db::run('DELETE FROM fact_stars WHERE fact_id = ?', [$d]);
        $topics = self::clean(array_merge(self::decode($keep['topics_json']), self::decode($dup['topics_json'])));
        Db::update('facts', ['topics_json' => $topics ? json_encode($topics, JSON_UNESCAPED_UNICODE) : null, 'updated_at' => Db::now()], 'id = :id', ['id' => $k]);
        Db::update('facts', ['deleted_at' => Db::now(), 'merged_into' => $k], 'id = :id', ['id' => $d]);
        // Proposals about the duplicate now concern the kept fact, or nothing.
        Db::run("UPDATE fact_suggestions SET status = 'obsolete' WHERE status = 'proposed' AND (fact_id = ? OR other_fact_id = ?)", [$d, $d]);
        Activity::touch($pid, 'fact', $k, 'updated');
        return ['fact_id' => $k, 'merged' => $d, 'proof_id' => $proofId];
    }

    /** A remark that asks something nobody has answered becomes an open question, linked to where it was found. */
    private static function toQuestion(int $pid, array $f, array $s, array $data, int $me): array
    {
        $fid = (int)$f['id'];
        if (Db::value('SELECT 1 FROM fact_deps d JOIN facts a ON a.id = d.fact_id WHERE d.depends_on_id = ? AND a.deleted_at IS NULL', [$fid])) {
            throw new HttpError(409, "Other facts depend on {$f['label']}: it stays a fact.");
        }
        if (QuestionController::hasRatifiedAnswer($fid)) throw new HttpError(409, "{$f['label']} supports a ratified answer: it stays a fact.");
        $title = mb_substr(trim((string)($data['title'] ?? '')), 0, 255) ?: mb_substr((string)$f['title'], 0, 255);
        $html = (string)Db::value('SELECT statement_html FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$fid, $f['current_revision']]);
        $now = Db::now();
        $qid = Db::insert('open_questions', ['project_id' => $pid, 'parent_id' => null, 'title' => $title, 'statement_html' => $html, 'status' => 'open', 'priority' => 'normal',
            'ai_model' => $s['ai_model'], 'ai_user_id' => $s['ai_user_id'], 'ai_generation_ms' => $s['ai_generation_ms'],
            'created_by' => $me, 'updated_by' => $me, 'created_at' => $now, 'updated_at' => $now]);
        foreach (Db::all("SELECT DISTINCT source_type, source_id FROM fact_sources WHERE fact_id = ? AND revision_no = ? AND source_type IN ('bib', 'document')", [$fid, $f['current_revision']]) as $src) {
            Db::insert('question_links', ['project_id' => $pid, 'question_id' => $qid, 'strategy_id' => 0, 'target_type' => $src['source_type'], 'target_id' => (int)$src['source_id'], 'created_by' => $me, 'created_at' => $now]);
        }
        Db::run('DELETE FROM fact_deps WHERE fact_id = ?', [$fid]);
        Db::update('facts', ['deleted_at' => $now], 'id = :id', ['id' => $fid]);
        Db::run("UPDATE fact_suggestions SET status = 'obsolete' WHERE status = 'proposed' AND id <> ? AND (fact_id = ? OR other_fact_id = ?)", [$s['id'], $fid, $fid]);
        Activity::touch($pid, 'oquestion', $qid, 'created');
        return ['question_id' => $qid, 'removed_fact' => $fid];
    }

    // ----- helpers -----

    /** Free subject tags: trimmed, single spaces, at most 40 characters, no duplicates whatever the case, at most 8. */
    public static function clean(array $topics): array
    {
        $out = [];
        foreach ($topics as $t) {
            if (!is_scalar($t)) continue;
            $t = mb_substr(trim(preg_replace('/\s+/u', ' ', (string)$t) ?? ''), 0, self::MAX_TOPIC_LENGTH);
            $t = trim($t, " ,;#");
            if ($t === '') continue;
            $out[mb_strtolower($t)] ??= $t;
        }
        return array_slice(array_values($out), 0, self::MAX_TOPICS);
    }

    private static function decode(?string $json): array
    {
        $v = json_decode((string)$json, true);
        return is_array($v) ? array_values(array_filter($v, 'is_string')) : [];
    }

    private static function cleanSuggestion(int $pid, mixed $x): array
    {
        if (!is_array($x)) throw new HttpError(422, 'Each suggestion must be an object.');
        $kind = is_string($x['kind'] ?? null) ? $x['kind'] : '';
        if (!in_array($kind, self::KINDS, true)) throw new HttpError(422, 'Unknown suggestion kind.');
        $reason = mb_substr(trim(is_scalar($x['reason'] ?? null) ? (string)$x['reason'] : ''), 0, 2000);
        if ($reason === '') throw new HttpError(422, 'A suggestion must explain itself in "reason".');
        $fid = self::factId($pid, $x['fact'] ?? null);
        $other = null; $data = null;
        if (in_array($kind, ['same', 'depends'], true)) {
            $other = self::factId($pid, $x['other_fact'] ?? null);
            if ($other === $fid) throw new HttpError(422, 'A suggestion needs two different facts.');
        }
        if ($kind === 'kind') {
            $k = is_string($x['new_kind'] ?? null) ? $x['new_kind'] : '';
            if (!in_array($k, FactController::kinds(), true)) throw new HttpError(422, 'Unknown kind.');
            if ($k === (string)Db::value('SELECT kind FROM facts WHERE id = ?', [$fid])) throw new HttpError(422, 'The fact already has this kind.');
            $data = ['kind' => $k];
        }
        if ($kind === 'question') {
            $title = mb_substr(trim(is_scalar($x['title'] ?? null) ? (string)$x['title'] : ''), 0, 255);
            if ($title === '') throw new HttpError(422, 'A question needs a title.');
            $data = ['title' => $title];
        }
        if ($kind === 'topics') {
            $topics = self::clean((array)($x['topics'] ?? []));
            $have = array_map('mb_strtolower', self::decode(Db::value('SELECT topics_json FROM facts WHERE id = ?', [$fid])));
            $topics = array_values(array_filter($topics, fn($t) => !in_array(mb_strtolower($t), $have, true)));
            if (!$topics) throw new HttpError(422, 'The fact already has these topics.');
            $data = ['topics' => $topics];
        }
        return ['kind' => $kind, 'fact_id' => $fid, 'other_fact_id' => $other, 'data_json' => $data ? json_encode($data, JSON_UNESCAPED_UNICODE) : null, 'reason_text' => $reason];
    }

    /** A fact named by its id or its label. */
    private static function factId(int $pid, mixed $ref): int
    {
        if (!is_scalar($ref) || (string)$ref === '') throw new HttpError(422, 'Name the fact by its id or label.');
        $key = (string)$ref;
        $id = ctype_digit($key) ? Db::value('SELECT id FROM facts WHERE project_id = ? AND id = ? AND deleted_at IS NULL', [$pid, (int)$key]) : null;
        $id = $id ?: Db::value('SELECT id FROM facts WHERE project_id = ? AND label = ? AND deleted_at IS NULL', [$pid, $key]);
        if (!$id) throw new HttpError(422, 'Unknown fact: ' . mb_substr($key, 0, 80));
        return (int)$id;
    }

    /** The same proposal already waits, or people already rejected it. */
    private static function known(int $pid, array $s): ?string
    {
        $pair = $s['other_fact_id'] === null ? 'other_fact_id IS NULL' : '((fact_id = ? AND other_fact_id = ?) OR (fact_id = ? AND other_fact_id = ? AND kind = \'same\'))';
        $params = $s['other_fact_id'] === null ? [] : [$s['fact_id'], $s['other_fact_id'], $s['other_fact_id'], $s['fact_id']];
        $rows = Db::all("SELECT status, data_json FROM fact_suggestions WHERE project_id = ? AND kind = ? AND status IN ('proposed', 'rejected') AND "
            . ($s['other_fact_id'] === null ? 'fact_id = ? AND ' : '') . $pair, array_merge([$pid, $s['kind']], $s['other_fact_id'] === null ? [$s['fact_id']] : [], $params));
        foreach ($rows as $r) {
            if ($s['kind'] === 'topics') {
                $old = array_map('mb_strtolower', (array)(json_decode((string)$r['data_json'], true)['topics'] ?? []));
                $new = array_map('mb_strtolower', (array)(json_decode((string)$s['data_json'], true)['topics'] ?? []));
                if (array_diff($new, $old)) continue;
            } elseif ($s['kind'] === 'kind' && $r['data_json'] !== $s['data_json']) continue;
            return $r['status'] === 'rejected' ? 'People already rejected this proposal.' : 'The same proposal is already waiting.';
        }
        if ($s['kind'] === 'depends' && Db::value('SELECT 1 FROM fact_deps WHERE fact_id = ? AND depends_on_id = ?', [$s['fact_id'], $s['other_fact_id']])) return 'This dependency is already recorded.';
        return null;
    }

    /** $from would depend on $to: refuse if $to already depends on $from. $ignore is a fact about to disappear. */
    private static function assertAcyclic(int $pid, int $from, int $to, ?int $ignore = null): void
    {
        $next = [];
        foreach (Db::all('SELECT d.fact_id, d.depends_on_id FROM fact_deps d JOIN facts f ON f.id = d.fact_id WHERE f.project_id = ? AND f.deleted_at IS NULL', [$pid]) as $e) {
            if ((int)$e['depends_on_id'] === $ignore) continue;
            $next[(int)$e['fact_id']][] = (int)$e['depends_on_id'];
        }
        $stack = [$to]; $seen = [];
        while ($stack) {
            $x = array_pop($stack);
            if ($x === $from) throw new HttpError(409, 'This dependency would create a cycle.');
            if (isset($seen[$x])) continue;
            $seen[$x] = true;
            array_push($stack, ...($next[$x] ?? []));
        }
    }

    private static function live(int $pid, int $id): array
    {
        $f = Db::one('SELECT * FROM facts WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [$id, $pid]);
        if (!$f) throw new HttpError(409, 'A fact of this proposal is no longer in the database.');
        return $f;
    }

    private static function proposed(int $sid): array
    {
        $s = Db::one('SELECT * FROM fact_suggestions WHERE id = ?', [$sid]);
        if (!$s || !Access::role((int)$s['project_id'])) throw new HttpError(404, 'Suggestion not found.');
        if ($s['status'] !== 'proposed') throw new HttpError(409, 'This suggestion was already handled.');
        self::mayDecide($s);
        return $s;
    }

    /** Merging two facts or removing a remark takes a fact away: an owner decides. */
    private static function mayDecide(array $s): void
    {
        if (in_array($s['kind'], ['same', 'question'], true)) Access::owner((int)$s['project_id']);
    }

    /** Proposals whose facts disappeared since. */
    private static function obsolete(int $pid): void
    {
        Db::run("UPDATE fact_suggestions SET status = 'obsolete' WHERE project_id = ? AND status = 'proposed'
                 AND (fact_id IN (SELECT id FROM facts WHERE deleted_at IS NOT NULL) OR other_fact_id IN (SELECT id FROM facts WHERE deleted_at IS NOT NULL))", [$pid]);
    }

    private static function present(array $s): array
    {
        foreach (['id', 'project_id', 'task_id', 'fact_id', 'other_fact_id', 'decided_by', 'ai_user_id', 'ai_generation_ms'] as $k) $s[$k] = $s[$k] === null ? null : (int)$s[$k];
        $s['data'] = json_decode((string)$s['data_json'], true);
        unset($s['data_json']);
        return $s;
    }

    private static function humanOnly(): void
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can do this.');
    }
}
