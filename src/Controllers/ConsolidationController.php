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
 * Consolidation: an AI reads the whole facts database and proposes changes that no single extraction can see.
 * Two facts that state the same result, a dependency between facts from different sources, a wrong kind,
 * a remark that is really an open question, free subject tags, and the cited result behind an outside reference that a proof
 * uses directly (so that the proof relies only on facts of the database). People accept or reject each proposal.
 */
final class ConsolidationController
{
    public const KINDS = ['same', 'depends', 'kind', 'question', 'topics', 'cite', 'progress', 'notation'];
    private const NOTATION_ACTIONS = ['adopt', 'local', 'reject'];
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
            "SELECT s.*, u.name AS ai_user_name, d.name AS decided_by_name, ub.name AS undone_by_name FROM fact_suggestions s LEFT JOIN users u ON u.id = s.ai_user_id LEFT JOIN users d ON d.id = s.decided_by LEFT JOIN users ub ON ub.id = s.undone_by
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
            'auto' => (bool)Db::value('SELECT consolidation_auto FROM projects WHERE id = ?', [$pid]),
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

    /** An owner chooses whether the consolidation applies on its own the changes it is highly confident about. */
    public static function settings(Request $r): never
    {
        self::humanOnly();
        $pid = $r->int('id');
        Access::owner($pid);
        Db::update('projects', ['consolidation_auto' => $r->input('auto') === true ? 1 : 0], 'id = :id', ['id' => $pid]);
        Response::json(['auto' => $r->input('auto') === true]);
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

    /** What the AI may apply on its own when it is confident and the project allows it. Turning a remark into an open question stays with people. */
    public const AUTO_KINDS = ['same', 'depends', 'kind', 'topics', 'cite', 'progress', 'notation'];

    /** Cheap to undo and changing no result: applied when the AI finds them probable too, so that people decide as little as possible. */
    public const AUTO_MEDIUM_KINDS = ['notation', 'topics'];

    public static function autoApplies(array $s): bool
    {
        if (!in_array($s['kind'], self::AUTO_KINDS, true)) return false;
        return $s['confidence'] === 'high' || ($s['confidence'] === 'medium' && in_array($s['kind'], self::AUTO_MEDIUM_KINDS, true));
    }

    /**
     * Records the proposals that are valid and new. Those the AI is highly confident about are applied at once when the project
     * allows it, and stay listed with what they changed, so that anyone can undo them. One that fails waits for people instead.
     * @return array{created: list<int>, skipped: list<array>, applied: list<int>}
     */
    public static function store(int $pid, array $items, ?string $model, array $stamp, ?int $taskId): array
    {
        $created = []; $skipped = []; $applied = [];
        $auto = (bool)Db::value('SELECT consolidation_auto FROM projects WHERE id = ?', [$pid]);
        foreach ($items as $i => $x) {
            try {
                $s = self::cleanSuggestion($pid, $x);
            } catch (HttpError $e) {
                $skipped[] = ['index' => $i, 'reason' => $e->getMessage()];
                continue;
            }
            if ($why = self::known($pid, $s)) { $skipped[] = ['index' => $i, 'reason' => $why]; continue; }
            $created[] = $sid = Db::insert('fact_suggestions', $s + $stamp + ['project_id' => $pid, 'task_id' => $taskId, 'status' => 'proposed', 'ai_model' => $model, 'created_at' => Db::now()]);
            if ($auto && self::autoApplies($s)) {
                try {
                    Db::tx(fn() => self::apply(Db::one('SELECT * FROM fact_suggestions WHERE id = ?', [$sid]), Auth::id(), true));
                    $applied[] = $sid;
                } catch (HttpError) { /* a cycle, a ratified answer...: people decide */ }
            }
        }
        return ['created' => $created, 'skipped' => $skipped, 'applied' => $applied];
    }

    /** What the AI reads: every fact in short, with its source, its dependencies and its tags, and what was already proposed. */
    public static function context(int $pid): array
    {
        $deps = []; $usedBy = [];
        foreach (Db::all('SELECT d.fact_id, d.depends_on_id FROM fact_deps d JOIN facts f ON f.id = d.fact_id WHERE f.project_id = ? AND f.deleted_at IS NULL', [$pid]) as $e) {
            $deps[(int)$e['fact_id']][] = (int)$e['depends_on_id'];
            $usedBy[(int)$e['depends_on_id']] = ($usedBy[(int)$e['depends_on_id']] ?? 0) + 1;
        }
        $graph = array_column(FactController::graph($pid)['facts'], null, 'id');
        $facts = array_map(fn($f) => [
            'id' => (int)$f['id'], 'label' => $f['label'], 'kind' => $f['kind'], 'title' => $f['title'],
            'statement' => mb_substr(\App\Sanitizer::toText((string)$f['statement_html']), 0, 900),
            'has_proof' => trim((string)$f['proof_html']) !== '',
            'source' => Db::value("SELECT COALESCE(b.cite_key, d.title, s.source_type) FROM fact_sources s LEFT JOIN bib_entries b ON s.source_type = 'bib' AND b.id = s.source_id
                                   LEFT JOIN documents d ON s.source_type = 'document' AND d.id = s.source_id WHERE s.fact_id = ? AND s.revision_no = ? AND s.covers <> 'context' LIMIT 1", [$f['id'], $f['current_revision']]),
            'depends_on' => $deps[(int)$f['id']] ?? [], 'used_by' => $usedBy[(int)$f['id']] ?? 0, 'topics' => self::decode($f['topics_json']),
            'basis' => $graph[(int)$f['id']]['basis'] ?? null, 'status' => $graph[(int)$f['id']]['status'] ?? null, 'worth_reading' => $f['highlight_at'] !== null,
            'outside_refs' => array_values(array_map(fn($x) => ['key' => $x['key'], 'label' => $x['label']], array_filter($graph[(int)$f['id']]['outside_refs'] ?? [], fn($x) => !$x['resolved']))),
        ], Db::all('SELECT f.id, f.label, f.kind, f.title, f.current_revision, f.topics_json, f.highlight_at, r.statement_html, r.proof_html FROM facts f
                    JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
                    WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL ORDER BY f.id LIMIT 600', [$pid]));
        $decided = array_map(fn($s) => ['kind' => $s['kind'], 'fact_id' => (int)$s['fact_id'], 'other_fact_id' => $s['other_fact_id'] ? (int)$s['other_fact_id'] : null,
            'data' => json_decode((string)$s['data_json'], true), 'status' => $s['status']],
            Db::all("SELECT kind, fact_id, other_fact_id, data_json, status FROM fact_suggestions WHERE project_id = ? AND status IN ('proposed', 'rejected', 'undone') ORDER BY id DESC LIMIT 600", [$pid]));
        return ['fact_texts' => $facts, 'topics' => self::topics($pid), 'earlier_suggestions' => $decided,
            // The project's notation, and the symbols several facts define for themselves: what to normalize.
            'notation' => NotationController::forTask($pid, false), 'local_notation' => NotationController::shared($pid, 2, 80),
            'omitted_facts' => max(0, (int)Db::value('SELECT COUNT(*) FROM facts WHERE project_id = ? AND deleted_at IS NULL AND retracted_at IS NULL', [$pid]) - count($facts))];
    }

    // ----- the second reading -----

    /** What the second reader reads: each proposal waiting for people, with the full text of its facts. */
    public static function secondContext(int $pid, array $ids): array
    {
        $fact = function (?int $id) use ($pid) {
            if (!$id) return null;
            $f = Db::one('SELECT f.id, f.label, f.kind, f.title, f.topics_json, r.statement_html, r.proof_html FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
                          WHERE f.id = ? AND f.project_id = ? AND f.deleted_at IS NULL', [$id, $pid]);
            return $f ? ['id' => (int)$f['id'], 'label' => $f['label'], 'kind' => $f['kind'], 'title' => $f['title'], 'topics' => self::decode($f['topics_json']),
                'statement' => Sanitizer::toText((string)$f['statement_html']), 'proof' => $f['proof_html'] ? mb_substr(Sanitizer::toText((string)$f['proof_html']), 0, 8000) : null] : null;
        };
        $out = []; $notation = false;
        foreach ($ids as $sid) {
            $s = Db::one("SELECT * FROM fact_suggestions WHERE id = ? AND project_id = ? AND status = 'proposed'", [$sid, $pid]);
            if (!$s) continue;
            $notation = $notation || $s['kind'] === 'notation';
            $out[] = ['suggestion_id' => (int)$s['id'], 'kind' => $s['kind'], 'fact' => $fact((int)$s['fact_id']), 'other_fact' => $fact($s['other_fact_id'] ? (int)$s['other_fact_id'] : null),
                'data' => json_decode((string)$s['data_json'], true), 'reason' => $s['reason_text'], 'confidence' => $s['confidence']];
        }
        return ['proposals' => $out, 'topics' => self::topics($pid)] + ($notation ? ['notation' => NotationController::forTask($pid, false)] : []);
    }

    /**
     * A second AI reading of a proposal waiting for people: "apply" applies it as the AI's own change, which any member undoes;
     * "drop" sets it aside, and any member brings it back; "unsure" leaves it to people, with the reason.
     * @return ?string applied, dropped, unsure or failed; null when the proposal is no longer waiting
     */
    public static function second(int $sid, string $verdict, string $reason, ?string $model): ?string
    {
        $s = Db::one("SELECT * FROM fact_suggestions WHERE id = ? AND status = 'proposed'", [$sid]);
        if (!$s || !in_array($verdict, ['apply', 'drop', 'unsure'], true)) return null;
        $now = Db::now();
        Db::update('fact_suggestions', ['second_verdict' => $verdict, 'second_reason' => mb_substr(trim($reason), 0, 2000) ?: null, 'second_ai_model' => $model, 'second_at' => $now], 'id = :id', ['id' => $sid]);
        if ($verdict === 'unsure') return 'unsure';
        if ($verdict === 'drop') {
            Db::update('fact_suggestions', ['status' => 'rejected', 'decided_by' => null, 'decided_at' => $now], 'id = :id', ['id' => $sid]);
            return 'dropped';
        }
        try {
            Db::tx(fn() => self::apply(Db::one('SELECT * FROM fact_suggestions WHERE id = ?', [$sid]), Auth::id(), true));
            return 'applied';
        } catch (HttpError) {
            return 'failed'; // a cycle, a decision of a person since...: it waits for people
        }
    }

    /** A member brings back a proposal the second reading dropped: it waits for people again, and no AI reads it again. */
    public static function restore(Request $r): never
    {
        self::humanOnly();
        $s = Db::one('SELECT * FROM fact_suggestions WHERE id = ?', [$r->int('sid')]);
        if (!$s || !Access::role((int)$s['project_id'])) throw new HttpError(404, 'Suggestion not found.');
        Access::member((int)$s['project_id']);
        if ($s['status'] !== 'rejected' || $s['second_verdict'] !== 'drop') throw new HttpError(409, 'Only a proposal the second reading dropped can be brought back.');
        Db::update('fact_suggestions', ['status' => 'proposed', 'second_verdict' => 'kept', 'decided_by' => null, 'decided_at' => null], 'id = :id', ['id' => $s['id']]);
        Response::json(['ok' => true]);
    }

    // ----- applying a suggestion -----

    /**
     * Applies a proposal and records what it changed, so that it can be undone (an unmerge for a merge).
     * $auto: the AI applied it on its own, being confident, without a person. @return array<string, mixed> what changed
     */
    public static function apply(array $s, int $me, bool $auto = false): array
    {
        $pid = (int)$s['project_id'];
        $fid = (int)$s['fact_id'];
        $other = $s['other_fact_id'] ? (int)$s['other_fact_id'] : null;
        $data = json_decode((string)$s['data_json'], true) ?: [];
        $f = self::live($pid, $fid);
        $out = []; $undo = [];
        switch ($s['kind']) {
            case 'same':
                [$out, $undo] = self::merge($pid, $f, self::live($pid, (int)$other), $me);
                break;
            case 'depends':
                $to = (int)self::live($pid, (int)$other)['id'];
                $undo = ['dep_added' => self::addDependency($pid, $f, $to) ? $to : null];
                $out = ['fact_id' => $fid];
                break;
            case 'progress':
                // Real progress, worth a person's reading: it appears in the members' reading suggestions.
                $undo = ['before' => array_intersect_key($f, array_flip(['highlight_reason', 'highlight_at', 'highlight_model', 'highlight_activity']))];
                Activity::touch($pid, 'fact', $fid, 'updated');
                Db::update('facts', ['highlight_reason' => $s['reason_text'], 'highlight_at' => Db::now(), 'highlight_model' => $s['ai_model'],
                    'highlight_activity' => Activity::latest($pid, 'fact', $fid)], 'id = :id', ['id' => $fid]);
                $out = ['fact_id' => $fid];
                break;
            case 'cite':
                // The outside reference becomes a dependency on the fact that states its result, created if needed.
                $ref = (string)($data['ref'] ?? '');
                $cid = $other ? (int)self::live($pid, $other)['id']
                    : FactController::createCited($pid, $f, $ref, (string)($data['title'] ?? ''), (string)($data['statement'] ?? ''), (string)($data['kind'] ?? 'theorem'), $s['ai_model'], $s['ai_generation_ms'] !== null ? (int)$s['ai_generation_ms'] / 1000 : null);
                $undo = ['created' => $other ? null : $cid, 'dep_added' => self::addDependency($pid, $f, $cid) ? $cid : null, 'ref' => $ref,
                    'link_before' => Db::one('SELECT ref_key, cited_fact_id, created_by, created_at FROM fact_ref_links WHERE fact_id = ? AND ref_key = ?', [$fid, $ref])];
                Db::run('DELETE FROM fact_ref_links WHERE fact_id = ? AND ref_key = ?', [$fid, $ref]);
                Db::insert('fact_ref_links', ['fact_id' => $fid, 'ref_key' => $ref, 'cited_fact_id' => $cid, 'created_by' => $me, 'created_at' => Db::now()]);
                $out = ['fact_id' => $fid, 'cited_fact_id' => $cid, 'created' => !$other];
                break;
            case 'kind':
                $kind = (string)($data['kind'] ?? '');
                if (!in_array($kind, FactController::kinds(), true)) throw new HttpError(422, 'Unknown kind.');
                $undo = ['kind' => $f['kind'], 'new' => $kind];
                Db::update('facts', ['kind' => $kind, 'updated_at' => Db::now()], 'id = :id', ['id' => $fid]);
                Activity::touch($pid, 'fact', $fid, 'updated');
                $out = ['fact_id' => $fid];
                break;
            case 'question':
                [$out, $undo] = self::toQuestion($pid, $f, $s, $data, $me);
                break;
            case 'notation':
                [$out, $undo] = self::notation($pid, $s, $data, $me);
                break;
            case 'topics':
                $topics = self::clean(array_merge(self::decode($f['topics_json']), (array)($data['topics'] ?? [])));
                $json = $topics ? json_encode($topics, JSON_UNESCAPED_UNICODE) : null;
                $undo = ['before' => $f['topics_json'], 'after' => $json];
                Db::update('facts', ['topics_json' => $json, 'updated_at' => Db::now()], 'id = :id', ['id' => $fid]);
                $out = ['fact_id' => $fid, 'topics' => $topics];
                break;
            default:
                throw new HttpError(422, 'Unknown suggestion.');
        }
        Db::update('fact_suggestions', ['status' => 'accepted', 'decided_by' => $me, 'decided_at' => Db::now(), 'auto_applied' => $auto ? 1 : 0,
            'undo_json' => json_encode($undo, JSON_UNESCAPED_UNICODE)], 'id = :id', ['id' => $s['id']]);
        return $out;
    }

    /** Undoes an applied proposal: unmerges two facts, removes a dependency, gives back a kind, tags, or a remark. */
    public static function undo(Request $r): never
    {
        self::humanOnly();
        $s = Db::one('SELECT * FROM fact_suggestions WHERE id = ?', [$r->int('sid')]);
        if (!$s || !Access::role((int)$s['project_id'])) throw new HttpError(404, 'Suggestion not found.');
        if ($s['status'] !== 'accepted') throw new HttpError(409, 'Only an applied change can be undone.');
        if ($s['undo_json'] === null) throw new HttpError(409, 'This change was applied before changes could be undone.');
        // What the AI did on its own, any member undoes. A decision of a person on a merge or a question, an owner.
        if (!$s['auto_applied']) self::mayDecide($s);
        $out = Db::tx(fn() => self::revert($s, Auth::id()));
        Response::json(['ok' => true] + $out);
    }

    /** @return array<string, mixed> what was restored */
    public static function revert(array $s, int $me): array
    {
        $pid = (int)$s['project_id'];
        $fid = (int)$s['fact_id'];
        $u = json_decode((string)$s['undo_json'], true) ?: [];
        $now = Db::now();
        $out = ['fact_id' => $fid];
        switch ($s['kind']) {
            case 'same':
                $out = self::unmerge($pid, $u);
                break;
            case 'depends':
                if ($u['dep_added'] ?? null) self::removeDependency($pid, $fid, (int)$u['dep_added']);
                break;
            case 'kind':
                if ((string)Db::value('SELECT kind FROM facts WHERE id = ?', [$fid]) === ($u['new'] ?? null)) Db::update('facts', ['kind' => $u['kind'], 'updated_at' => $now], 'id = :id', ['id' => $fid]);
                break;
            case 'topics':
                // Unless people changed the tags since: then only the tags it added are removed.
                $cur = Db::value('SELECT topics_json FROM facts WHERE id = ?', [$fid]);
                $added = array_diff(self::decode($u['after'] ?? null), self::decode($u['before'] ?? null));
                $topics = $cur === ($u['after'] ?? null) ? self::decode($u['before'] ?? null) : array_values(array_diff(self::decode($cur), $added));
                Db::update('facts', ['topics_json' => $topics ? json_encode($topics, JSON_UNESCAPED_UNICODE) : null, 'updated_at' => $now], 'id = :id', ['id' => $fid]);
                break;
            case 'progress':
                Db::update('facts', ['highlight_reason' => null, 'highlight_at' => null, 'highlight_model' => null, 'highlight_activity' => null] + ($u['before'] ?? []), 'id = :id', ['id' => $fid]);
                break;
            case 'cite':
                Db::run('DELETE FROM fact_ref_links WHERE fact_id = ? AND ref_key = ?', [$fid, $u['ref'] ?? '']);
                if ($u['link_before'] ?? null) Db::insert('fact_ref_links', ['fact_id' => $fid] + $u['link_before']);
                if ($u['dep_added'] ?? null) self::removeDependency($pid, $fid, (int)$u['dep_added']);
                // A cited result written for this link goes too, unless other facts rely on it now.
                if (($c = $u['created'] ?? null) && !Db::value('SELECT 1 FROM fact_deps d JOIN facts f ON f.id = d.fact_id WHERE d.depends_on_id = ? AND f.deleted_at IS NULL', [$c])) {
                    Db::update('facts', ['deleted_at' => $now], 'id = :id', ['id' => $c]);
                    Db::run("UPDATE ai_tasks SET status = 'cancelled', updated_at = ? WHERE kind = 'source_check' AND source_type = 'fact' AND source_id = ? AND status = 'pending'", [$now, $c]);
                    $out['removed_fact'] = (int)$c;
                }
                break;
            case 'question':
                $qid = (int)($u['question_id'] ?? 0);
                if (Db::value('SELECT 1 FROM question_answers WHERE question_id = ?', [$qid]) || Db::value('SELECT 1 FROM proof_strategies WHERE question_id = ?', [$qid])) {
                    throw new HttpError(409, 'People worked on this open question since: it stays.');
                }
                Db::update('open_questions', ['deleted_at' => $now], 'id = :id', ['id' => $qid]);
                Db::update('facts', ['deleted_at' => null, 'updated_at' => $now], 'id = :id', ['id' => $fid]);
                foreach ($u['deps'] ?? [] as $to) if (self::alive($pid, (int)$to)) self::addDependency($pid, Db::one('SELECT * FROM facts WHERE id = ?', [$fid]), (int)$to);
                $out['question_removed'] = $qid;
                break;
            case 'notation':
                $out['notation_id'] = self::revertNotation($u, (int)$s['id']);
                break;
        }
        if ($u['obsoleted'] ?? null) {
            [$in, $p] = Db::in(array_map('intval', $u['obsoleted']));
            Db::run("UPDATE fact_suggestions SET status = 'proposed' WHERE status = 'obsolete' AND id IN $in", $p);
        }
        Db::update('fact_suggestions', ['status' => 'undone', 'undone_by' => $me, 'undone_at' => $now], 'id = :id', ['id' => $s['id']]);
        Activity::touch($pid, 'fact', $fid, 'updated');
        return $out;
    }

    /**
     * The consolidation decides a notation entry: adopts it as the project's notation, keeps it local to the facts, or rejects it.
     * It never changes what a person decided. @return array{0: array, 1: array} what changed, and what undoing it needs
     */
    private static function notation(int $pid, array $s, array $data, int $me): array
    {
        $action = (string)($data['action'] ?? '');
        $status = ['adopt' => 'agreed', 'local' => 'local', 'reject' => 'rejected'][$action] ?? throw new HttpError(422, 'Unknown notation action.');
        $now = Db::now();
        $stamp = ['status' => $status, 'decided_by' => $me, 'decided_at' => $now, 'auto_suggestion_id' => (int)$s['id'], 'updated_at' => $now];
        $entry = ($data['entry'] ?? null) ? Db::one('SELECT * FROM notations WHERE id = ? AND project_id = ?', [(int)$data['entry'], $pid]) : null;
        if (($data['entry'] ?? null) && !$entry) throw new HttpError(409, 'This notation entry is no longer in the project.');
        if ($entry && self::personDecided($entry)) throw new HttpError(409, "A person decided {$entry['symbol']}: it stays as they chose.");
        $key = NotationController::key($entry ? (string)$entry['symbol'] : (string)$data['symbol']);
        if ($status === 'agreed' && Db::value("SELECT 1 FROM notations WHERE project_id = ? AND symbol_key = ? AND status = 'agreed' AND id <> ?", [$pid, $key, $entry['id'] ?? 0])) {
            throw new HttpError(409, 'This symbol already has an agreed meaning.');
        }
        if ($entry) {
            $undo = ['entry' => (int)$entry['id'], 'before' => array_intersect_key($entry, array_flip(['status', 'decided_by', 'decided_at', 'auto_suggestion_id']))];
            Db::update('notations', $stamp, 'id = :id', ['id' => $entry['id']]);
            return [['notation_id' => (int)$entry['id']], $undo];
        }
        $html = fn($t) => Sanitizer::clean(Sanitizer::textToHtml((string)$t, $pid))['html'];
        $id = Db::insert('notations', $stamp + [
            'project_id' => $pid, 'symbol' => $data['symbol'], 'symbol_key' => $key, 'meaning_html' => $html($data['meaning']),
            'note_html' => ($data['note'] ?? '') !== '' ? $html($data['note']) : null, 'variants_json' => ($data['variants'] ?? []) ? json_encode($data['variants'], JSON_UNESCAPED_UNICODE) : null,
            // A local entry applies to the paper of the fact named with it, where it takes precedence over the project's meaning.
            'definition_fact_id' => $status === 'local' ? (int)$s['fact_id'] : null,
            'author_id' => (int)($s['ai_user_id'] ?: $me), 'author_kind' => 'agent', 'ai_model' => $s['ai_model'], 'ai_user_id' => $s['ai_user_id'], 'ai_generation_ms' => $s['ai_generation_ms'], 'created_at' => $now,
        ]);
        return [['notation_id' => $id, 'created' => true], ['created' => $id]];
    }

    /** Gives the entry back as it was. People who decided it since keep their decision. */
    private static function revertNotation(array $u, int $sid): int
    {
        $id = (int)($u['created'] ?? $u['entry'] ?? 0);
        $n = Db::one('SELECT * FROM notations WHERE id = ?', [$id]);
        if (!$n) return $id;
        if ((int)$n['auto_suggestion_id'] !== $sid) throw new HttpError(409, 'People decided this notation entry since: it stays as they chose.');
        if ($u['created'] ?? null) {
            // Written by the consolidation: it goes, unless members discussed it, then it stays as a rejected entry with its discussion.
            if (Db::value("SELECT 1 FROM comments WHERE target_type = 'notation' AND target_id = ?", [$id])) Db::update('notations', ['status' => 'rejected', 'auto_suggestion_id' => null, 'updated_at' => Db::now()], 'id = :id', ['id' => $id]);
            else Db::run('DELETE FROM notations WHERE id = ?', [$id]);
        } else {
            Db::update('notations', ($u['before'] ?? []) + ['updated_at' => Db::now()], 'id = :id', ['id' => $id]);
        }
        return $id;
    }

    /** Agreed, local or rejected by a person, not by the consolidation. */
    private static function personDecided(array $n): bool
    {
        return NotationController::decidedBy($n) === 'person';
    }

    /** A merge undone: the duplicate is back with its dependencies, sources, proof, links and stars, and the kept fact as it was. */
    private static function unmerge(int $pid, array $u): array
    {
        $k = (int)$u['keep']; $d = (int)$u['dup'];
        if ((int)Db::value('SELECT merged_into FROM facts WHERE id = ?', [$d]) !== $k) throw new HttpError(409, 'This merge was already undone.');
        $now = Db::now();
        Db::update('facts', ['deleted_at' => null, 'merged_into' => null, 'updated_at' => $now], 'id = :id', ['id' => $d]);
        $dup = Db::one('SELECT * FROM facts WHERE id = ?', [$d]);
        foreach ($u['dup_deps'] ?? [] as $to) {
            if (!self::alive($pid, (int)$to)) continue;
            try { self::addDependency($pid, $dup, (int)$to); } catch (HttpError) { /* a cycle made since: left out */ }
        }
        foreach ($u['dependents'] ?? [] as [$x, $addedK]) {
            if (!self::alive($pid, (int)$x)) continue;
            $fx = Db::one('SELECT * FROM facts WHERE id = ?', [$x]);
            if ($addedK) self::removeDependency($pid, (int)$x, $k);
            try { self::addDependency($pid, $fx, $d); } catch (HttpError) { /* a cycle made since */ }
        }
        if ($u['sources'] ?? null) { [$in, $p] = Db::in($u['sources']); Db::run("DELETE FROM fact_sources WHERE fact_id = ? AND id IN $in", array_merge([$k], $p)); }
        if ($pr = $u['proof_id'] ?? null) {
            Db::run('DELETE FROM fact_proof_reviews WHERE proof_id = ?', [$pr]);
            Db::run('DELETE FROM fact_proofs WHERE id = ? AND fact_id = ?', [$pr, $k]);
        }
        foreach ($u['answers'] ?? [] as [$a, $rev]) Db::run('UPDATE question_answers SET fact_id = ?, fact_revision = ? WHERE id = ? AND fact_id = ?', [$d, $rev, $a, $k]);
        foreach ($u['links_moved'] ?? [] as $l) Db::run("UPDATE question_links SET target_id = ? WHERE id = ? AND target_type = 'fact' AND target_id = ?", [$d, $l, $k]);
        foreach ($u['links_deleted'] ?? [] as $row) { unset($row['id']); Db::insert('question_links', $row); }
        foreach ($u['stars_added'] ?? [] as $uid) Db::run('DELETE FROM fact_stars WHERE fact_id = ? AND user_id = ?', [$k, $uid]);
        foreach ($u['stars_dup'] ?? [] as [$uid, $at]) if (!Db::value('SELECT 1 FROM fact_stars WHERE fact_id = ? AND user_id = ?', [$d, $uid])) Db::insert('fact_stars', ['fact_id' => $d, 'user_id' => $uid, 'created_at' => $at]);
        if (Db::value('SELECT topics_json FROM facts WHERE id = ?', [$k]) === ($u['topics_after'] ?? null)) Db::update('facts', ['topics_json' => $u['topics_before'] ?? null], 'id = :id', ['id' => $k]);
        if ($u['ref_links'] ?? null) { [$in, $p] = Db::in($u['ref_links']); Db::run("UPDATE fact_ref_links SET cited_fact_id = ? WHERE cited_fact_id = ? AND id IN $in", array_merge([$d, $k], $p)); }
        Activity::touch($pid, 'fact', $d, 'updated');
        return ['fact_id' => $k, 'unmerged' => $d];
    }

    private static function alive(int $pid, int $id): bool
    {
        return (bool)Db::value('SELECT 1 FROM facts WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [$id, $pid]);
    }

    /** $from no longer relies on $to. Its revision keeps the list of what it relies on. */
    public static function removeDependency(int $pid, int $from, int $to): void
    {
        Db::run('DELETE FROM fact_deps WHERE fact_id = ? AND depends_on_id = ?', [$from, $to]);
        $deps = array_map('intval', array_column(Db::all('SELECT depends_on_id FROM fact_deps WHERE fact_id = ? ORDER BY depends_on_id', [$from]), 'depends_on_id'));
        Db::run('UPDATE fact_revisions SET deps_json = ? WHERE fact_id = ? AND revision_no = (SELECT current_revision FROM facts WHERE id = ?)', [json_encode($deps), $from, $from]);
        Activity::touch($pid, 'fact', $from, 'updated');
    }

    /**
     * Two facts state the same result: the duplicate goes, and everything that pointed to it points to the kept fact.
     * Its sources join the kept fact's, and its proof becomes another proof of it.
     */
    /** @return array{0: array, 1: array} what changed, and what undoing it needs */
    private static function merge(int $pid, array $keep, array $dup, int $me): array
    {
        $k = (int)$keep['id']; $d = (int)$dup['id'];
        $u = ['keep' => $k, 'dup' => $d, 'dup_deps' => array_map('intval', array_column(Db::all('SELECT depends_on_id FROM fact_deps WHERE fact_id = ?', [$d]), 'depends_on_id')),
            'dependents' => [], 'sources' => [], 'answers' => [], 'links_moved' => [], 'links_deleted' => [], 'stars_added' => [], 'topics_before' => $keep['topics_json']];
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
            $addK = $x !== $k && !Db::value('SELECT 1 FROM fact_deps WHERE fact_id = ? AND depends_on_id = ?', [$x, $k]);
            $u['dependents'][] = [$x, $addK];
            if ($addK) Db::insert('fact_deps', ['fact_id' => $x, 'depends_on_id' => $k]);
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
            $u['sources'][] = Db::insert('fact_sources', ['fact_id' => $k, 'revision_no' => $keep['current_revision']] + $x);
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
        $u['proof_id'] = $proofId;
        // Answers to questions, question links and stars follow.
        foreach (Db::all("SELECT id, fact_revision FROM question_answers WHERE fact_id = ? AND state = 'proposed'", [$d]) as $a) $u['answers'][] = [(int)$a['id'], $a['fact_revision']];
        Db::run("UPDATE question_answers SET fact_id = ?, fact_revision = ? WHERE fact_id = ? AND state = 'proposed'", [$k, $keep['current_revision'], $d]);
        foreach (Db::all("SELECT * FROM question_links WHERE target_type = 'fact' AND target_id = ?", [$d]) as $l) {
            if (Db::value("SELECT 1 FROM question_links WHERE question_id = ? AND strategy_id = ? AND target_type = 'fact' AND target_id = ?", [$l['question_id'], $l['strategy_id'], $k])) { $u['links_deleted'][] = $l; Db::run('DELETE FROM question_links WHERE id = ?', [$l['id']]); }
            else { $u['links_moved'][] = (int)$l['id']; Db::run('UPDATE question_links SET target_id = ? WHERE id = ?', [$k, $l['id']]); }
        }
        $u['stars_dup'] = array_map(fn($st) => [(int)$st['user_id'], $st['created_at']], Db::all('SELECT user_id, created_at FROM fact_stars WHERE fact_id = ?', [$d]));
        foreach (Db::all('SELECT user_id, created_at FROM fact_stars WHERE fact_id = ?', [$d]) as $st) {
            if (!Db::value('SELECT 1 FROM fact_stars WHERE fact_id = ? AND user_id = ?', [$k, $st['user_id']])) { $u['stars_added'][] = (int)$st['user_id']; Db::insert('fact_stars', ['fact_id' => $k, 'user_id' => $st['user_id'], 'created_at' => $st['created_at']]); }
        }
        // A proof that took a result from the duplicate now takes it from the kept fact.
        $u['ref_links'] = array_map('intval', array_column(Db::all('SELECT id FROM fact_ref_links WHERE cited_fact_id = ?', [$d]), 'id'));
        Db::run('UPDATE fact_ref_links SET cited_fact_id = ? WHERE cited_fact_id = ?', [$k, $d]);
        Db::run('DELETE FROM fact_stars WHERE fact_id = ?', [$d]);
        $topics = self::clean(array_merge(self::decode($keep['topics_json']), self::decode($dup['topics_json'])));
        $u['topics_after'] = $topics ? json_encode($topics, JSON_UNESCAPED_UNICODE) : null;
        Db::update('facts', ['topics_json' => $u['topics_after'], 'updated_at' => Db::now()], 'id = :id', ['id' => $k]);
        Db::update('facts', ['deleted_at' => Db::now(), 'merged_into' => $k], 'id = :id', ['id' => $d]);
        // Proposals about the duplicate now concern the kept fact, or nothing. An unmerge brings them back.
        $u['obsoleted'] = array_map('intval', array_column(Db::all("SELECT id FROM fact_suggestions WHERE status = 'proposed' AND (fact_id = ? OR other_fact_id = ?)", [$d, $d]), 'id'));
        Db::run("UPDATE fact_suggestions SET status = 'obsolete' WHERE status = 'proposed' AND (fact_id = ? OR other_fact_id = ?)", [$d, $d]);
        Activity::touch($pid, 'fact', $k, 'updated');
        return [['fact_id' => $k, 'merged' => $d, 'proof_id' => $proofId], $u];
    }

    /** $f now relies on $to. The revision keeps the list of what it relies on: the text did not change, so its reviews stand. */
    public static function addDependency(int $pid, array $f, int $to): bool
    {
        $fid = (int)$f['id'];
        if (Db::value('SELECT 1 FROM fact_deps WHERE fact_id = ? AND depends_on_id = ?', [$fid, $to])) return false;
        self::assertAcyclic($pid, $fid, $to);
        Db::insert('fact_deps', ['fact_id' => $fid, 'depends_on_id' => $to]);
        $deps = array_map('intval', array_column(Db::all('SELECT depends_on_id FROM fact_deps WHERE fact_id = ? ORDER BY depends_on_id', [$fid]), 'depends_on_id'));
        Db::update('fact_revisions', ['deps_json' => json_encode($deps)], 'fact_id = :f AND revision_no = :n', ['f' => $fid, 'n' => $f['current_revision']]);
        Activity::touch($pid, 'fact', $fid, 'updated');
        return true;
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
        $u = ['question_id' => $qid, 'deps' => array_map('intval', array_column(Db::all('SELECT depends_on_id FROM fact_deps WHERE fact_id = ?', [$fid]), 'depends_on_id')),
            'obsoleted' => array_map('intval', array_column(Db::all("SELECT id FROM fact_suggestions WHERE status = 'proposed' AND id <> ? AND (fact_id = ? OR other_fact_id = ?)", [$s['id'], $fid, $fid]), 'id'))];
        Db::run('DELETE FROM fact_deps WHERE fact_id = ?', [$fid]);
        Db::update('facts', ['deleted_at' => $now], 'id = :id', ['id' => $fid]);
        Db::run("UPDATE fact_suggestions SET status = 'obsolete' WHERE status = 'proposed' AND id <> ? AND (fact_id = ? OR other_fact_id = ?)", [$s['id'], $fid, $fid]);
        Activity::touch($pid, 'oquestion', $qid, 'created');
        return [['question_id' => $qid, 'removed_fact' => $fid], $u];
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
        if (in_array($kind, ['same', 'depends'], true) || ($kind === 'cite' && ($x['other_fact'] ?? null) !== null)) {
            $other = self::factId($pid, $x['other_fact'] ?? null);
            if ($other === $fid) throw new HttpError(422, 'A suggestion needs two different facts.');
        }
        if ($kind === 'cite') {
            $ref = is_string($x['ref'] ?? null) ? $x['ref'] : '';
            $f = FactController::graphFact($pid, $fid);
            $match = array_values(array_filter($f['outside_refs'] ?? [], fn($r) => $r['key'] === $ref))[0] ?? null;
            if (!$match) throw new HttpError(422, 'Name in "ref" an outside reference that this proof uses, from "outside_refs".');
            if ($match['resolved']) throw new HttpError(422, 'This reference is already settled.');
            $data = ['ref' => $ref, 'ref_label' => $match['label']];
            if ($other === null) {
                $title = mb_substr(trim(is_scalar($x['title'] ?? null) ? (string)$x['title'] : ''), 0, 255);
                $statement = mb_substr(trim(is_scalar($x['statement'] ?? null) ? (string)$x['statement'] : ''), 0, 6000);
                if ($title === '' || $statement === '') throw new HttpError(422, 'A new cited result needs a title and a statement.');
                $k = is_string($x['new_kind'] ?? null) && in_array($x['new_kind'], ['lemma', 'proposition', 'theorem', 'corollary'], true) ? $x['new_kind'] : 'theorem';
                $data += ['title' => $title, 'statement' => $statement, 'kind' => $k];
            }
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
        if ($kind === 'notation') $data = self::cleanNotation($pid, $x['notation'] ?? null);
        $confidence = in_array($x['confidence'] ?? null, ['high', 'medium', 'low'], true) ? $x['confidence'] : null;
        return ['kind' => $kind, 'fact_id' => $fid, 'other_fact_id' => $other, 'data_json' => $data ? json_encode($data, JSON_UNESCAPED_UNICODE) : null, 'reason_text' => $reason, 'confidence' => $confidence];
    }

    /**
     * A decision on the project's notation: {action, entry, symbol, meaning, note, variants}. "entry" names an entry already proposed;
     * without it, "adopt" writes a new entry, or takes the entry of the same notion when there is one.
     */
    private static function cleanNotation(int $pid, mixed $n): array
    {
        if (!is_array($n)) throw new HttpError(422, 'A notation proposal needs "notation": {action, entry, symbol, meaning}.');
        $action = is_string($n['action'] ?? null) ? $n['action'] : '';
        if (!in_array($action, self::NOTATION_ACTIONS, true)) throw new HttpError(422, 'The notation action must be adopt, local or reject.');
        $str = fn($k, $max) => mb_substr(trim(is_scalar($n[$k] ?? null) ? (string)$n[$k] : ''), 0, $max);
        $symbol = trim(preg_replace('/^\$+|\$+$/', '', $str('symbol', 160)) ?? '');
        $entry = null;
        if (is_numeric($n['entry'] ?? null)) {
            $entry = Db::one('SELECT * FROM notations WHERE id = ? AND project_id = ?', [(int)$n['entry'], $pid]);
            if (!$entry) throw new HttpError(422, 'Unknown notation entry: ' . (int)$n['entry']);
        } elseif ($symbol !== '') {
            foreach (Db::all("SELECT * FROM notations WHERE project_id = ? AND status <> 'rejected' ORDER BY status = 'agreed' DESC, id", [$pid]) as $e) {
                if (NotationController::notionKey($e['symbol']) === NotationController::notionKey($symbol)) { $entry = $e; break; }
            }
        }
        if ($entry) {
            if (self::personDecided($entry)) throw new HttpError(422, "A person decided {$entry['symbol']}: the consolidation leaves it.");
            if ($entry['status'] === ['adopt' => 'agreed', 'local' => 'local', 'reject' => 'rejected'][$action]) throw new HttpError(422, "{$entry['symbol']} is already " . $entry['status'] . '.');
            return ['action' => $action, 'entry' => (int)$entry['id'], 'symbol' => $entry['symbol'], 'meaning' => mb_substr(Sanitizer::toText((string)$entry['meaning_html']), 0, 1000)];
        }
        if ($action !== 'adopt') throw new HttpError(422, 'Name in "entry" the notation entry to keep local or to reject.');
        $meaning = $str('meaning', 4000);
        if ($symbol === '' || $meaning === '') throw new HttpError(422, 'A new notation entry needs a "symbol" and a "meaning".');
        $variants = [];
        foreach (array_slice(is_array($n['variants'] ?? null) ? $n['variants'] : [], 0, 20) as $v) {
            if (!is_array($v)) continue;
            $vs = fn($k, $max) => mb_substr(trim(is_scalar($v[$k] ?? null) ? (string)$v[$k] : ''), 0, $max);
            if ($vs('symbol', 160) === '' || $vs('meaning', 1000) === '') continue;
            $variants[] = ['symbol' => $vs('symbol', 160), 'meaning' => $vs('meaning', 1000), 'where' => $vs('where', 300), 'relation' => ($v['relation'] ?? '') === 'instance' ? 'instance' : 'clash'];
        }
        return ['action' => 'adopt', 'entry' => null, 'symbol' => $symbol, 'meaning' => $meaning, 'note' => $str('note', 2000), 'variants' => $variants];
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
        $rows = Db::all("SELECT status, data_json FROM fact_suggestions WHERE project_id = ? AND kind = ? AND status IN ('proposed', 'rejected', 'undone') AND "
            . ($s['other_fact_id'] === null ? 'fact_id = ? AND ' : '') . $pair, array_merge([$pid, $s['kind']], $s['other_fact_id'] === null ? [$s['fact_id']] : [], $params));
        foreach ($rows as $r) {
            if ($s['kind'] === 'topics') {
                $old = array_map('mb_strtolower', (array)(json_decode((string)$r['data_json'], true)['topics'] ?? []));
                $new = array_map('mb_strtolower', (array)(json_decode((string)$s['data_json'], true)['topics'] ?? []));
                if (array_diff($new, $old)) continue;
            } elseif ($s['kind'] === 'kind' && $r['data_json'] !== $s['data_json']) continue;
            elseif ($s['kind'] === 'cite' && (json_decode((string)$r['data_json'], true)['ref'] ?? null) !== (json_decode((string)$s['data_json'], true)['ref'] ?? null)) continue;
            elseif ($s['kind'] === 'notation') continue; // compared by symbol below, whatever fact it was attached to
            if ($r['status'] === 'undone') return 'People undid this change.';
            return $r['status'] === 'rejected' ? 'People already rejected this proposal.' : 'The same proposal is already waiting.';
        }
        if ($s['kind'] === 'notation') {
            $mine = json_decode((string)$s['data_json'], true);
            foreach (Db::all("SELECT status, data_json FROM fact_suggestions WHERE project_id = ? AND kind = 'notation' AND status IN ('proposed', 'rejected', 'undone')", [$pid]) as $r) {
                $d = json_decode((string)$r['data_json'], true) ?: [];
                $same = fn($a, $b) => mb_strtolower(preg_replace('/[\s.]+/u', '', (string)$a) ?? '') === mb_strtolower(preg_replace('/[\s.]+/u', '', (string)$b) ?? '');
                if (($d['action'] ?? null) !== $mine['action'] || NotationController::notionKey((string)($d['symbol'] ?? '')) !== NotationController::notionKey((string)$mine['symbol'])) continue;
                if (!$same($d['meaning'] ?? '', $mine['meaning'] ?? '')) continue; // another meaning for the symbol is another proposal
                if ($r['status'] === 'undone') return 'People undid this change.';
                return $r['status'] === 'rejected' ? 'People already rejected this proposal.' : 'The same proposal is already waiting.';
            }
        }
        if ($s['kind'] === 'depends' && Db::value('SELECT 1 FROM fact_deps WHERE fact_id = ? AND depends_on_id = ?', [$s['fact_id'], $s['other_fact_id']])) return 'This dependency is already recorded.';
        if ($s['kind'] === 'progress' && Db::value('SELECT highlight_at FROM facts WHERE id = ?', [$s['fact_id']])) return 'This fact is already marked as worth reading.';
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
        foreach (['id', 'project_id', 'task_id', 'fact_id', 'other_fact_id', 'decided_by', 'ai_user_id', 'ai_generation_ms', 'undone_by'] as $k) $s[$k] = ($s[$k] ?? null) === null ? null : (int)$s[$k];
        $s['data'] = json_decode((string)$s['data_json'], true);
        $s['auto_applied'] = (bool)($s['auto_applied'] ?? false);
        $s['can_undo'] = $s['status'] === 'accepted' && ($s['undo_json'] ?? null) !== null;
        unset($s['data_json'], $s['undo_json']);
        return $s;
    }

    private static function humanOnly(): void
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can do this.');
    }
}
