<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, HttpError, Notify, Provenance, Request, Response, Sanitizer};

/**
 * Fact database: a DAG of statements with proof and intuition.
 * Content is stored in immutable revisions. A new revision needs fresh reviews
 * and Lean proofs. Retracting a fact flags everything that depends on it.
 * Facts are written by AI clients and agents only, so that they follow the format.
 * Humans review, comment, retract and report Lean checks.
 */
final class FactController
{
    private const KINDS = ['definition', 'lemma', 'proposition', 'theorem', 'corollary', 'conjecture',
        'observation', 'counterexample', 'computation', 'remark'];
    private const PREFIX = ['definition' => 'def', 'lemma' => 'lem', 'proposition' => 'prop', 'theorem' => 'thm',
        'corollary' => 'cor', 'conjecture' => 'conj', 'observation' => 'obs', 'counterexample' => 'cex',
        'computation' => 'comp', 'remark' => 'rem'];
    private const VERDICTS = ['correct', 'gap', 'incorrect'];
    private const MAX_LEAN_BYTES = 1000000;
    private const METHODS = ['extracted', 'deduced'];
    private const NO_PROOF_KINDS = ['definition', 'conjecture', 'remark'];
    private const MAX_BATCH = 500;
    private const MAX_TRACE = 300;
    /** The vocabulary of Danus memory entries. */
    private const LABELS = ['conclusion', 'example', 'counterexample', 'proof_attempt', 'plan', 'dead_end',
        'direction', 'obstacle', 'master_guidance', 'verification', 'elaboration'];
    /** Entries that record a judgment or a research step rather than a claim to prove. */
    private const NO_PROOF_LABELS = ['plan', 'dead_end', 'direction', 'obstacle', 'master_guidance'];
    private const COVERS = ['statement', 'proof', 'both'];

    public static function list(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        Response::json(self::graph($pid));
    }

    /** @return array{facts:list<array>, edges:list<array{0:int,1:int}>} edges are [fact, depends_on] */
    public static function graph(int $pid): array
    {
        $facts = Db::all(
            "SELECT f.id, f.label, f.kind, f.title, f.origin, f.proof_origin, f.labels_json, f.method, f.tool, f.external_id, f.ai_model, f.current_revision, f.retracted_at, f.created_by,
                    f.created_at, f.updated_at, u.name AS author, u.kind AS author_kind, r.statement_html, r.author_id AS revision_author,
                    r.ai_user_id, r.ai_generation_ms, au.name AS ai_user_name,
                    (SELECT COUNT(*) FROM comments c WHERE c.target_type = 'fact' AND c.target_id = f.id) AS comment_count
             FROM facts f JOIN users u ON u.id = f.created_by
             JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
             LEFT JOIN users au ON au.id = r.ai_user_id
             WHERE f.project_id = ? AND f.deleted_at IS NULL ORDER BY f.id", [$pid]);
        $edges = array_map(fn($e) => [(int)$e['fact_id'], (int)$e['depends_on_id']], Db::all(
            'SELECT d.fact_id, d.depends_on_id FROM fact_deps d
             JOIN facts a ON a.id = d.fact_id JOIN facts b ON b.id = d.depends_on_id
             WHERE a.project_id = ? AND a.deleted_at IS NULL AND b.deleted_at IS NULL', [$pid]));
        $reviews = [];
        foreach (Db::all('SELECT v.fact_id, v.verdict, v.reviewer_id, v.reviewer_kind, v.ai_model, u.name AS reviewer_name FROM fact_reviews v
                          JOIN users u ON u.id = v.reviewer_id
                          JOIN facts f ON f.id = v.fact_id AND v.revision_no = f.current_revision WHERE f.project_id = ?', [$pid]) as $v) {
            $reviews[(int)$v['fact_id']][] = $v;
        }
        $lean = [];
        foreach (Db::all('SELECT l.fact_id, l.incomplete, l.check_status FROM fact_lean l
                          JOIN facts f ON f.id = l.fact_id AND l.revision_no = f.current_revision WHERE f.project_id = ?', [$pid]) as $l) {
            $lean[(int)$l['fact_id']][] = $l;
        }

        $byId = [];
        foreach ($facts as $f) {
            $id = (int)$f['id'];
            $f['id'] = $id;
            $f['created_by'] = (int)$f['created_by'];
            $f['revision_author'] = (int)$f['revision_author'];
            $f['current_revision'] = (int)$f['current_revision'];
            $f['comment_count'] = (int)$f['comment_count'];
            $f['status'] = self::status($f, $reviews[$id] ?? []);
            $f['review_counts'] = array_count_values(array_column($reviews[$id] ?? [], 'verdict'));
            $f['lean'] = self::leanState($lean[$id] ?? []);
            $f['labels'] = json_decode((string)$f['labels_json'], true) ?: [];
            unset($f['labels_json']);
            $f['endorsed_by'] = array_values(array_map(fn($v) => ['id' => (int)$v['reviewer_id'], 'name' => $v['reviewer_name']],
                array_filter($reviews[$id] ?? [], fn($v) => $v['reviewer_kind'] === 'human' && $v['verdict'] === 'correct')));
            $f['statement_text'] = Sanitizer::toText($f['statement_html']);
            unset($f['statement_html']);
            $f['deps'] = [];
            $f['dependents'] = [];
            $f['chain'] = 'ok';
            $byId[$id] = $f;
        }
        foreach ($edges as [$a, $b]) { $byId[$a]['deps'][] = $b; $byId[$b]['dependents'][] = $a; }

        // Propagate along dependents: 'unchecked' first, so 'broken' takes precedence.
        self::mark($byId, fn($f) => $f['status'] === 'unchecked', 'unchecked');
        self::mark($byId, fn($f) => in_array($f['status'], ['disputed', 'retracted'], true), 'broken');
        return ['facts' => array_values($byId), 'edges' => $edges];
    }

    private static function mark(array &$byId, callable $bad, string $state): void
    {
        $stack = [];
        foreach ($byId as $f) if ($bad($f)) array_push($stack, ...$f['dependents']);
        $seen = [];
        while ($stack) {
            $id = array_pop($stack);
            if (isset($seen[$id])) continue;
            $seen[$id] = true;
            $byId[$id]['chain'] = $state;
            array_push($stack, ...$byId[$id]['dependents']);
        }
    }

    /** A review by the model that wrote the fact is recorded but is not an independent check. */
    private static function status(array $f, array $reviews): string
    {
        if ($f['retracted_at']) return 'retracted';
        $human = $ai = false;
        foreach ($reviews as $v) {
            if ($v['verdict'] !== 'correct') return 'disputed';
            if ($v['reviewer_kind'] === 'human') $human = true;
            elseif (!self::sameModel($f, $v['ai_model'])) $ai = true;
        }
        return $human && $ai ? 'double_checked' : ($human ? 'human_checked' : ($ai ? 'ai_checked' : 'unchecked'));
    }

    private static function sameModel(array $f, ?string $model): bool
    {
        return (string)$f['ai_model'] !== '' && mb_strtolower(trim((string)$f['ai_model'])) === mb_strtolower(trim((string)$model));
    }

    private static function leanState(array $rows): string
    {
        if (!$rows) return 'none';
        foreach ($rows as $l) if ($l['check_status'] === 'compiles' && !$l['incomplete']) return 'compiled';
        foreach ($rows as $l) if ($l['check_status'] === 'unchecked' && !$l['incomplete']) return 'unchecked';
        foreach ($rows as $l) if ($l['incomplete']) return 'partial';
        return 'failed';
    }

    public static function show(Request $r): never
    {
        $f = Access::fact($r->int('id'));
        Response::json(self::present($f));
    }

    /** Where a fact comes from: its own sources, then everything it is built on. */
    public static function trace(Request $r): never
    {
        $f = Access::fact($r->int('id'));
        $id = (int)$f['id'];
        $byId = array_column(self::graph((int)$f['project_id'])['facts'], null, 'id');
        $depth = [];
        $queue = array_map(fn($d) => [$d, 1], $byId[$id]['deps']);
        for ($i = 0; $i < count($queue); $i++) {
            [$x, $d] = $queue[$i];
            if (isset($depth[$x])) continue;
            $depth[$x] = $d;
            foreach ($byId[$x]['deps'] as $next) $queue[] = [$next, $d + 1];
        }
        $own = self::presentSources($id, (int)$f['current_revision']);
        $people = [];
        $addPeople = function (array $sources, int $factId) use (&$people) {
            foreach ($sources as $s) {
                if (!$s['is_human'] || !$s['author'] || !in_array($s['covers'], ['proof', 'both'], true)) continue;
                $key = $s['author']['name'] . '|' . $s['author']['basis'];
                $people[$key] ??= $s['author'] + ['facts' => []];
                $people[$key]['facts'][] = $factId;
            }
        };
        $addPeople($own, $id);

        $ancestors = [];
        $counts = ['human' => 0, 'ai' => 0, 'mixed' => 0, 'none' => 0];
        asort($depth);
        foreach ($depth as $x => $d) {
            $a = $byId[$x];
            $counts[$a['proof_origin']]++;
            if (count($ancestors) >= self::MAX_TRACE) continue;
            $sources = self::presentSources($x, $a['current_revision']);
            $addPeople($sources, $x);
            $ancestors[] = ['id' => $x, 'label' => $a['label'], 'title' => $a['title'], 'depth' => $d, 'proof_origin' => $a['proof_origin'], 'origin' => $a['origin'],
                'method' => $a['method'], 'tool' => $a['tool'], 'ai_model' => $a['ai_model'], 'status' => $a['status'], 'labels' => $a['labels'],
                // A source merely cited by a deduced fact gives its authors no credit for that fact.
                'credits' => array_values(array_filter(array_map(fn($s) => $s['covers'] === 'context' ? null : $s['author'], $sources)))];
        }
        Response::json([
            'fact' => ['id' => $id, 'proof_origin' => $f['proof_origin'], 'origin' => $f['origin'], 'method' => $f['method'], 'tool' => $f['tool'], 'ai_model' => $f['ai_model']],
            'sources' => $own, 'human_proof_credits' => array_values($people), 'ancestors' => $ancestors,
            'ancestor_count' => count($depth), 'ancestor_proof_origins' => $counts,
        ]);
    }

    public static function create(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        self::requireAi();
        $item = (array)$r->input();
        $id = Db::tx(fn() => self::ingest($pid, $item, []));
        Response::json(self::present(Access::fact($id)), 201);
    }

    /**
     * Imports many facts at once, all or nothing, in dependency order. `depends_on` may use
     * the `ref` of another item. With "format": "danus" items use the Danus fields.
     * Re-importing is safe: an external_id already present is skipped.
     */
    public static function batch(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        self::requireAi();
        $items = $r->input('facts');
        if (!is_array($items) || !$items || !array_is_list($items)) throw new HttpError(422, 'facts must be a non-empty list.');
        if (count($items) > self::MAX_BATCH) throw new HttpError(413, 'At most ' . self::MAX_BATCH . ' facts per batch.');
        $format = $r->str('format') ?: 'native';
        if (!in_array($format, ['native', 'danus'], true)) throw new HttpError(422, 'format must be native or danus.');

        $norm = [];
        foreach ($items as $i => $raw) {
            if (!is_array($raw)) throw new HttpError(422, "Item $i is not an object.");
            $it = $format === 'danus' ? self::fromDanus($raw) : $raw;
            $it['ai_model'] = self::s($it, 'ai_model') ?: $r->str('ai_model');
            $it['tool'] = self::s($it, 'tool') ?: $r->str('tool');
            if (!array_key_exists('publish_private', $it)) $it['publish_private'] = (bool)$r->input('publish_private');
            $it['ref'] = self::s($it, 'ref') ?: self::s($it, 'external_id') ?: self::s($it, 'label') ?: "#$i";
            $norm[$i] = $it;
        }
        $order = self::order($norm);

        $dry = (bool)$r->input('dry_run');
        $refs = []; $created = []; $skipped = []; $errors = [];
        $pdo = Db::pdo();
        $pdo->beginTransaction();
        try {
            foreach ($order as $i) {
                $it = $norm[$i];
                $ext = self::s($it, 'external_id');
                $old = $ext !== '' ? Db::value('SELECT id FROM facts WHERE project_id = ? AND external_id = ? AND deleted_at IS NULL', [$pid, $ext]) : null;
                if ($old) { $refs[$it['ref']] = (int)$old; $skipped[] = ['ref' => $it['ref'], 'id' => (int)$old]; continue; }
                try {
                    $id = self::ingest($pid, $it, $refs);
                    $refs[$it['ref']] = $id;
                    $created[] = ['ref' => $it['ref'], 'id' => $id, 'label' => Db::value('SELECT label FROM facts WHERE id = ?', [$id])];
                } catch (HttpError $e) {
                    $errors[] = ['index' => $i, 'ref' => $it['ref'], 'error' => $e->getMessage()];
                }
            }
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        if ($errors || $dry) $pdo->rollBack(); else $pdo->commit();
        if ($errors) Response::json(['error' => count($errors) . ' fact(s) rejected, nothing was saved.', 'errors' => $errors], 422);
        Response::json(['dry_run' => $dry, 'created' => $created, 'skipped' => $skipped], $dry ? 200 : 201);
    }

    /** Machine-readable description of the format, for AI clients. */
    public static function format(Request $r): never
    {
        Response::json(self::formatSpec());
    }

    public static function formatSpec(): array
    {
        return [
            'fields' => [
                'title' => 'required, short name',
                'kind' => self::KINDS,
                'labels' => ['required, one or more' => self::LABELS],
                'method' => 'required: "extracted" (the result is in a source) or "deduced" (new)',
                'ai_model' => 'required: exact model that wrote this entry',
                'generation_seconds' => 'optional: time actually measured to generate this item. Leave it out rather than estimate it',
                'tool' => 'optional, e.g. "danus"',
                'label' => 'optional, letters, digits, _ : . - (automatic if empty)',
                'statement_text' => 'required, self-contained, LaTeX with $...$',
                'proof_text' => 'required for deduced facts, except kinds ' . implode(', ', self::NO_PROOF_KINDS) . ' and labels ' . implode(', ', self::NO_PROOF_LABELS) . '. For extracted facts, give it only if the source does',
                'intuition_text' => 'optional, one line',
                'depends_on' => 'facts used, by id, label, external_id, or ref within a batch',
                'sources' => 'required if extracted: [{type: document|bib, id, page, quote, covers, version_id?, authors?}] or [{type: message|comment, id, quote, covers}]. covers = statement, proof or both: say honestly what the passage contains. authors = names of the authors of an uploaded file, if you can read them',
                'publish_private' => 'must be true to cite a private conversation. Ask the user first: every project member will see the fact',
                'glossary' => 'optional {symbol: definition}',
                'external_refs' => 'optional list of references',
                'external_id' => 'optional stable id (Danus fact_id): makes imports idempotent',
            ],
            'origin' => 'Set by the server: "human" if the statement is extracted only from human sources, otherwise "ai".',
            'proof_origin' => 'Set by the server: "human" if a human source contains the proof, "ai" if the proof was written by AI, "mixed", or "none".',
            'batch' => 'POST /api/projects/{pid}/facts/batch {facts: [...], ai_model, dry_run?, format?: "native"|"danus"}',
            'danus_fields' => ['labels', 'fact_id', 'predecessors', 'statement', 'proof', 'intuition', 'glossary_introduces', 'external_refs'],
        ];
    }

    /** Only the AI client that wrote a fact can revise it. A new content creates a revision. */
    public static function update(Request $r): never
    {
        $f = self::writable($r->int('id'));
        $id = (int)$f['id'];
        $pid = (int)$f['project_id'];
        $it = (array)$r->input();
        $data = [];
        if (array_key_exists('title', $it)) {
            $data['title'] = mb_substr(self::s($it, 'title'), 0, 255);
            if ($data['title'] === '') throw new HttpError(422, 'A title is required.');
        }
        if (array_key_exists('kind', $it)) $data['kind'] = self::kind(self::s($it, 'kind'));
        if (array_key_exists('label', $it) && self::s($it, 'label') !== $f['label']) {
            $data['label'] = self::label($pid, self::s($it, 'label'), $data['kind'] ?? $f['kind'], $data['title'] ?? $f['title'], $id);
        }
        $cur = Db::one('SELECT * FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$id, $f['current_revision']]);
        $content = self::content($it, $pid, $cur);
        $labels = array_key_exists('labels', $it)
            ? self::labels($it['labels'], $data['kind'] ?? $f['kind'])
            : (json_decode((string)$f['labels_json'], true) ?: []);
        if (array_key_exists('labels', $it)) $data['labels_json'] = json_encode($labels);
        self::checkFormat($data['kind'] ?? $f['kind'], $labels, $f['method'], $content);
        $oldDeps = array_map('intval', array_column(Db::all('SELECT depends_on_id FROM fact_deps WHERE fact_id = ?', [$id]), 'depends_on_id'));
        sort($oldDeps);
        $deps = self::deps($it, $pid, $content, $id, $oldDeps, []);
        $changed = $deps !== $oldDeps;
        foreach (['statement', 'proof', 'intuition'] as $k) {
            if ($content[$k]['html'] !== (string)$cur[$k . '_html']) $changed = true;
        }
        foreach (['sources', 'glossary', 'external_refs'] as $k) if (array_key_exists($k, $it)) $changed = true;

        if (array_key_exists('sources', $it)) {
            $sources = self::sources($pid, $it, $f['method']);
        } else {
            $sources = Db::all('SELECT source_type, source_id, version_id, conversation_id, page, quote, is_human, covers, author_user_id, author_name, author_basis
                                FROM fact_sources WHERE fact_id = ? AND revision_no = ?', [$id, $f['current_revision']]);
        }
        $extra = [
            'glossary_json' => array_key_exists('glossary', $it) ? self::jsonField($it['glossary'], 'glossary') : $cur['glossary_json'],
            'external_refs_json' => array_key_exists('external_refs', $it) ? self::jsonField($it['external_refs'], 'external_refs') : $cur['external_refs_json'],
        ];
        $model = $changed ? Provenance::model(self::s($it, 'ai_model')) : null;

        Db::tx(function () use ($it, $f, $id, $pid, $data, $changed, $content, $deps, $sources, $extra, $model) {
            if ($changed) {
                $prov = self::provenance($f['method'], $content, $sources, $model) + Provenance::stamp($model, $it['generation_seconds'] ?? null);
                $no = (int)$f['current_revision'] + 1;
                self::insertRevision($id, $no, $content, $deps, $prov, self::s($it, 'notes') ?: null, $extra, $sources);
                self::setDeps($id, $deps);
                $data += ['current_revision' => $no, 'origin' => $prov['origin'], 'proof_origin' => $prov['proof_origin'], 'ai_model' => $model];
                self::notifyMentions($pid, $id, $content, false);
            }
            if ($data) {
                Db::update('facts', $data + ['updated_at' => Db::now()], 'id = :id', ['id' => $id]);
                Activity::touch($pid, 'fact', $id, $changed ? 'revision' : 'updated');
            }
        });
        Response::json(self::present(Access::fact($id)));
    }

    public static function delete(Request $r): never
    {
        $f = Access::fact($r->int('id'));
        if ((int)$f['created_by'] !== Auth::id()) Access::owner((int)$f['project_id']);
        if (Db::value('SELECT 1 FROM fact_deps d JOIN facts a ON a.id = d.fact_id WHERE d.depends_on_id = ? AND a.deleted_at IS NULL', [$f['id']])) {
            throw new HttpError(409, 'Other facts depend on this one. Retract it instead, so that they are flagged.');
        }
        Db::tx(function () use ($f) {
            Db::run('DELETE FROM fact_deps WHERE fact_id = ?', [$f['id']]);
            Db::update('facts', ['deleted_at' => Db::now()], 'id = :id', ['id' => $f['id']]);
        });
        Response::json(['ok' => true]);
    }

    public static function retract(Request $r): never
    {
        self::requireHuman();
        $f = Access::fact($r->int('id'));
        $reason = mb_substr($r->str('reason'), 0, 4000);
        if ($reason === '') throw new HttpError(422, 'Please give a reason for retracting this fact.');
        Db::update('facts', ['retracted_at' => Db::now(), 'retracted_by' => Auth::id(), 'retract_reason' => $reason, 'updated_at' => Db::now()], 'id = :id', ['id' => $f['id']]);
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'retracted');

        $g = self::graph((int)$f['project_id']);
        $byId = array_column($g['facts'], null, 'id');
        $affected = [];
        $stack = $byId[(int)$f['id']]['dependents'];
        while ($stack) {
            $x = array_pop($stack);
            if (isset($affected[$x])) continue;
            $affected[$x] = true;
            array_push($stack, ...$byId[$x]['dependents']);
        }
        $authors = array_unique(array_map(fn($x) => $byId[$x]['revision_author'], array_keys($affected)));
        $authors[] = (int)$f['created_by'];
        foreach (array_unique($authors) as $uid) {
            if ($uid === Auth::id() || !Access::isMember((int)$f['project_id'], $uid)) continue;
            Notify::send($uid, (int)$f['project_id'], 'fact_retracted', ['link' => ['view' => 'facts', 'id' => (int)$f['id']], 'excerpt' => $f['label'] . ': ' . $reason]);
        }
        Response::json(['affected' => count($affected)] + self::present(Access::fact((int)$f['id'])));
    }

    public static function reinstate(Request $r): never
    {
        self::requireHuman();
        $f = Access::fact($r->int('id'));
        Db::update('facts', ['retracted_at' => null, 'retracted_by' => null, 'retract_reason' => null, 'updated_at' => Db::now()], 'id = :id', ['id' => $f['id']]);
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'reinstated');
        Response::json(self::present(Access::fact((int)$f['id'])));
    }

    /** One review per reviewer and revision: reviewing again replaces the previous verdict. */
    public static function review(Request $r): never
    {
        $f = Access::fact($r->int('id'));
        if ($f['retracted_at']) throw new HttpError(422, 'This fact is retracted.');
        $verdict = $r->str('verdict');
        if (!in_array($verdict, self::VERDICTS, true)) throw new HttpError(422, 'The verdict must be correct, gap or incorrect.');
        $rev = Db::one('SELECT * FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$f['id'], $f['current_revision']]);
        $kind = Auth::isAi() ? 'agent' : 'human';
        // Every revision is AI-written, so a human can always check it, including their own client's work.
        if ($kind === 'agent' && (int)$rev['author_id'] === Auth::id() && self::sameModel($f, Provenance::agentModel($r))) {
            throw new HttpError(403, 'This model wrote this revision: another model or a human has to check it.');
        }
        $body = Sanitizer::fromRequest($r, (int)$f['project_id']);
        if ($verdict !== 'correct' && (!$body || ($body['text'] === '' && !$body['mentions']))) {
            throw new HttpError(422, 'Please explain the gap or the error.');
        }
        $model = Provenance::agentModel($r);
        $now = Db::now();
        $old = Db::value('SELECT id FROM fact_reviews WHERE fact_id = ? AND revision_no = ? AND reviewer_id = ? AND reviewer_kind = ?', [$f['id'], $f['current_revision'], Auth::id(), $kind]);
        $row = Provenance::stamp($model, $r->input('generation_seconds')) + ['verdict' => $verdict, 'ai_model' => $model, 'body_html' => $body['html'] ?? null, 'updated_at' => $now];
        if ($old) {
            Db::update('fact_reviews', $row, 'id = :id', ['id' => $old]);
            $rid = (int)$old;
        } else {
            $rid = Db::insert('fact_reviews', $row + [
                'fact_id' => $f['id'], 'revision_no' => $f['current_revision'], 'reviewer_id' => Auth::id(),
                'reviewer_kind' => $kind, 'created_at' => $now,
            ]);
        }
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'review', $rid);
        $link = ['view' => 'facts', 'id' => (int)$f['id']];
        if ($body) Notify::mentions((int)$f['project_id'], 'fact_review', $rid, $body['mentions'], $link, $body['text'], null, !$old);
        if ((int)$rev['author_id'] !== Auth::id() && Access::isMember((int)$f['project_id'], (int)$rev['author_id'])) {
            Notify::send((int)$rev['author_id'], (int)$f['project_id'], 'fact_review', ['link' => $link, 'excerpt' => $f['label'] . ': ' . $verdict]);
        }
        Response::json(self::present(Access::fact((int)$f['id'])), $old ? 200 : 201);
    }

    public static function deleteReview(Request $r): never
    {
        $f = Access::fact($r->int('id'));
        $v = Db::one('SELECT * FROM fact_reviews WHERE id = ? AND fact_id = ?', [$r->int('rid'), $f['id']]);
        if (!$v) throw new HttpError(404, 'Review not found');
        if ((int)$v['reviewer_id'] !== Auth::id()) throw new HttpError(403, 'You can only withdraw your own review.');
        Db::run('DELETE FROM fact_reviews WHERE id = ?', [$v['id']]);
        Db::run("DELETE FROM mentions WHERE source_type = 'fact_review' AND source_id = ?", [$v['id']]);
        Response::json(self::present($f));
    }

    public static function addLean(Request $r): never
    {
        self::requireAi();
        $f = Access::fact($r->int('id'));
        $code = (string)$r->input('code', '');
        if (trim($code) === '') throw new HttpError(422, 'The Lean code is empty.');
        if (strlen($code) > self::MAX_LEAN_BYTES) throw new HttpError(413, 'The Lean code is too large (1 MB maximum).');
        $prov = Provenance::resolve($r);
        $url = $r->str('url');
        if ($url !== '' && !preg_match('#^https?://#i', $url)) throw new HttpError(422, 'The URL must start with http(s)://');
        $lid = Db::insert('fact_lean', Provenance::stamp($prov['ai_model'], $r->input('generation_seconds')) + [
            'fact_id' => $f['id'], 'revision_no' => $f['current_revision'], 'code' => $code,
            'decl_name' => mb_substr($r->str('decl_name'), 0, 255) ?: null,
            'lean_version' => mb_substr($r->str('lean_version'), 0, 60) ?: null,
            'mathlib_rev' => mb_substr($r->str('mathlib_rev'), 0, 80) ?: null,
            'url' => mb_substr($url, 0, 500) ?: null, 'origin' => $prov['origin'], 'ai_model' => $prov['ai_model'],
            'incomplete' => self::leanIncomplete($code) ? 1 : 0,
            'created_by' => Auth::id(), 'created_at' => Db::now(),
        ]);
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'lean', $lid);
        Db::update('facts', ['updated_at' => Db::now()], 'id = :id', ['id' => $f['id']]);
        Response::json(self::present(Access::fact((int)$f['id'])), 201);
    }

    /** The platform does not run Lean: this records who reports what, with which toolchain. */
    public static function checkLean(Request $r): never
    {
        $l = Db::one('SELECT * FROM fact_lean WHERE id = ?', [$r->int('lid')]);
        if (!$l) throw new HttpError(404, 'Lean proof not found');
        $f = Access::fact((int)$l['fact_id']);
        $status = $r->str('status');
        if (!in_array($status, ['compiles', 'fails'], true)) throw new HttpError(422, 'The status must be compiles or fails.');
        if ($status === 'compiles' && $l['incomplete']) throw new HttpError(422, 'This code contains sorry, admit or axiom, so it cannot count as a complete proof.');
        $version = mb_substr($r->str('lean_version'), 0, 60) ?: $l['lean_version'];
        if ($status === 'compiles' && !$version) throw new HttpError(422, 'State the Lean version used for this check.');
        $checkModel = Provenance::agentModel($r);
        $checkStamp = Provenance::stamp($checkModel, $r->input('generation_seconds'));
        Db::update('fact_lean', [
            'check_user_id' => $checkStamp['ai_user_id'], 'check_generation_ms' => $checkStamp['ai_generation_ms'],
            'check_status' => $status, 'check_log' => mb_substr((string)$r->input('log', ''), 0, 20000) ?: null,
            'lean_version' => $version, 'mathlib_rev' => mb_substr($r->str('mathlib_rev'), 0, 80) ?: $l['mathlib_rev'],
            'checked_by' => Auth::id(), 'check_model' => $checkModel, 'checked_at' => Db::now(),
        ], 'id = :id', ['id' => $l['id']]);
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'lean_check', (int)$l['id']);
        Response::json(self::present($f));
    }

    public static function deleteLean(Request $r): never
    {
        $l = Db::one('SELECT * FROM fact_lean WHERE id = ?', [$r->int('lid')]);
        if (!$l) throw new HttpError(404, 'Lean proof not found');
        $f = Access::fact((int)$l['fact_id']);
        if ((int)$l['created_by'] !== Auth::id()) Access::owner((int)$f['project_id']);
        Db::run('DELETE FROM fact_lean WHERE id = ?', [$l['id']]);
        Response::json(self::present($f));
    }

    // ---------------------------------------------------------------------

    private static function requireAi(): void
    {
        if (!Auth::isAi()) throw new HttpError(403, 'Facts are added by AI clients, with a personal API key from your profile page.');
    }

    private static function requireHuman(): void
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a human member can do this.');
    }

    private static function writable(int $id): array
    {
        self::requireAi();
        $f = Access::fact($id);
        if ((int)$f['created_by'] !== Auth::id()) {
            throw new HttpError(403, 'Only the client that added this fact can revise it. Review or comment instead.');
        }
        return $f;
    }

    private static function s(array $a, string $k): string
    {
        $v = $a[$k] ?? '';
        return is_scalar($v) ? trim((string)$v) : '';
    }

    private static function fromDanus(array $f): array
    {
        $statement = trim((string)($f['statement'] ?? ''));
        $id = self::s($f, 'fact_id');
        if (!preg_match('/^[0-9a-f]{8,64}$/', $id)) throw new HttpError(422, 'A Danus fact needs a hexadecimal fact_id.');
        $title = self::s($f, 'title') ?: preg_replace('/\s+/u', ' ', mb_substr($statement, 0, 90));
        return [
            'ref' => $id, 'external_id' => $id, 'title' => $title, 'kind' => self::s($f, 'kind') ?: 'lemma',
            'labels' => $f['labels'] ?? ['conclusion'],
            'label' => self::s($f, 'label') ?: 'danus:' . substr($id, 0, 16), 'method' => 'deduced', 'tool' => 'danus',
            'statement_text' => $statement, 'proof_text' => (string)($f['proof'] ?? ''), 'intuition_text' => (string)($f['intuition'] ?? ''),
            'depends_on' => $f['predecessors'] ?? [], 'glossary' => $f['glossary_introduces'] ?? null, 'external_refs' => $f['external_refs'] ?? null,
            'ai_model' => self::s($f, 'ai_model'), 'generation_seconds' => $f['generation_seconds'] ?? null,
        ];
    }

    /** Topological order of a batch, so that a fact is created after what it depends on. */
    private static function order(array $items): array
    {
        $byRef = [];
        foreach ($items as $i => $it) {
            if (isset($byRef[$it['ref']])) throw new HttpError(422, 'Duplicate ref in batch: ' . mb_substr($it['ref'], 0, 80));
            $byRef[$it['ref']] = $i;
        }
        $left = []; $users = [];
        foreach ($items as $i => $it) {
            $left[$i] = 0;
            foreach (array_unique(array_map('strval', (array)($it['depends_on'] ?? []))) as $d) {
                if (isset($byRef[$d])) { $left[$i]++; $users[$byRef[$d]][] = $i; }
            }
        }
        $queue = array_keys(array_filter($left, fn($n) => $n === 0));
        for ($q = 0; $q < count($queue); $q++) {
            foreach ($users[$queue[$q]] ?? [] as $u) if (--$left[$u] === 0) $queue[] = $u;
        }
        if (count($queue) !== count($items)) throw new HttpError(422, 'The dependencies of this batch contain a cycle.');
        return $queue;
    }

    private static function ingest(int $pid, array $it, array $refs): int
    {
        $title = mb_substr(self::s($it, 'title'), 0, 255);
        if ($title === '') throw new HttpError(422, 'A title is required.');
        $kind = self::kind(self::s($it, 'kind') ?: 'lemma');
        $method = self::s($it, 'method');
        if (!in_array($method, self::METHODS, true)) throw new HttpError(422, 'method must be extracted or deduced.');
        $model = Provenance::model(self::s($it, 'ai_model'));
        $ext = mb_substr(self::s($it, 'external_id'), 0, 64) ?: null;
        if ($ext && Db::value('SELECT 1 FROM facts WHERE project_id = ? AND external_id = ?', [$pid, $ext])) {
            throw new HttpError(409, "external_id $ext already exists.");
        }
        $content = self::content($it, $pid, null);
        $labels = self::labels($it['labels'] ?? null, $kind);
        self::checkFormat($kind, $labels, $method, $content);
        $sources = self::sources($pid, $it, $method);
        $label = self::label($pid, self::s($it, 'label'), $kind, $title, null);
        $deps = self::deps($it, $pid, $content, null, [], $refs);
        $prov = self::provenance($method, $content, $sources, $model) + Provenance::stamp($model, $it['generation_seconds'] ?? null);
        $extra = [
            'glossary_json' => self::jsonField($it['glossary'] ?? null, 'glossary'),
            'external_refs_json' => self::jsonField($it['external_refs'] ?? null, 'external_refs'),
        ];
        $now = Db::now();
        $id = Db::insert('facts', [
            'project_id' => $pid, 'label' => $label, 'kind' => $kind, 'title' => $title,
            'origin' => $prov['origin'], 'proof_origin' => $prov['proof_origin'], 'labels_json' => json_encode($labels), 'method' => $method, 'tool' => mb_substr(self::s($it, 'tool'), 0, 60) ?: null,
            'external_id' => $ext, 'ai_model' => $model,
            'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now,
        ]);
        self::insertRevision($id, 1, $content, $deps, $prov, self::s($it, 'notes') ?: 'Initial revision', $extra, $sources);
        self::setDeps($id, $deps);
        self::notifyMentions($pid, $id, $content);
        Activity::touch($pid, 'fact', $id, 'created');
        return $id;
    }

    /** At least one Danus label. A fact of kind counterexample always carries that label. */
    private static function labels(mixed $v, string $kind): array
    {
        if (!is_array($v) || !$v) throw new HttpError(422, 'labels is required: one or more of ' . implode(', ', self::LABELS) . '.');
        $out = [];
        foreach ($v as $l) {
            if (!is_string($l) || !in_array($l, self::LABELS, true)) {
                throw new HttpError(422, 'Unknown label. Use: ' . implode(', ', self::LABELS) . '.');
            }
            $out[] = $l;
        }
        if ($kind === 'counterexample') $out[] = 'counterexample';
        return array_values(array_unique($out));
    }

    /**
     * Where the statement and the proof come from, as far as the sources show.
     * A proof written without a source that contains it is an AI proof, even for a human statement.
     */
    private static function provenance(string $method, array $content, array $sources, ?string $model): array
    {
        $of = fn(array $covers) => array_values(array_filter($sources, fn($s) => in_array($s['covers'], $covers, true)));
        $statement = $of(['statement', 'both']);
        $proofs = $of(['proof', 'both']);
        $hasProof = $content['proof']['text'] !== '' || (bool)$content['proof']['mentions'];
        $origin = $method === 'extracted' && $statement && !array_filter($statement, fn($s) => !(int)$s['is_human']) ? 'human' : 'ai';
        if ($method === 'deduced' || !$proofs) {
            $proof = $hasProof ? 'ai' : 'none';
        } else {
            $human = count(array_filter($proofs, fn($s) => (int)$s['is_human']));
            $proof = $human === count($proofs) ? 'human' : ($human ? 'mixed' : 'ai');
        }
        return ['origin' => $origin, 'proof_origin' => $proof, 'ai_model' => $model];
    }

    private static function checkFormat(string $kind, array $labels, string $method, array $content): void
    {
        if (array_intersect($labels, self::NO_PROOF_LABELS)) return;
        if ($method === 'deduced' && !in_array($kind, self::NO_PROOF_KINDS, true)
            && $content['proof']['text'] === '' && !$content['proof']['mentions']) {
            throw new HttpError(422, "A deduced $kind needs a proof.");
        }
    }

    private static function jsonField(mixed $v, string $name): ?string
    {
        if ($v === null || $v === [] || $v === '') return null;
        if (!is_array($v)) throw new HttpError(422, "$name must be an object or a list.");
        $json = json_encode($v, JSON_UNESCAPED_UNICODE);
        if ($json === false || strlen($json) > 65000) throw new HttpError(422, "$name is invalid or too large.");
        return $json;
    }

    /** @return list<array> source rows, each with its coverage and credit */
    private static function sources(int $pid, array $it, string $method): array
    {
        $list = $it['sources'] ?? [];
        if (!is_array($list) || !array_is_list($list)) throw new HttpError(422, 'sources must be a list.');
        if ($method === 'extracted' && !$list) throw new HttpError(422, 'An extracted fact must cite at least one source.');
        $rows = [];
        foreach ($list as $s) {
            if (!is_array($s)) throw new HttpError(422, 'Each source must be an object.');
            $row = self::source($pid, $s, !empty($it['publish_private']));
            $covers = self::s($s, 'covers');
            if ($method === 'extracted') {
                if (!in_array($covers, self::COVERS, true)) throw new HttpError(422, 'Each source of an extracted fact needs covers: statement, proof or both.');
                $row['covers'] = $covers;
            } else {
                $row['covers'] = 'context'; // a deduced fact can cite sources, but its proof is new
            }
            $row['is_human'] = $row['is_human'] ? 1 : 0;
            $rows[] = $row;
        }
        return $rows;
    }

    private static function source(int $pid, array $s, bool $publishPrivate): array
    {
        $type = self::s($s, 'type');
        $id = (int)($s['id'] ?? 0);
        $quote = mb_substr(trim((string)($s['quote'] ?? '')), 0, 2000);
        if ($quote === '') throw new HttpError(422, 'Each source needs a quote of the passage used.');
        $page = (int)($s['page'] ?? 0);
        $row = ['source_type' => $type, 'source_id' => $id, 'version_id' => null, 'conversation_id' => null, 'page' => $page ?: null, 'quote' => $quote, 'is_human' => true,
            'covers' => 'context', 'author_user_id' => null, 'author_name' => null, 'author_basis' => null];
        $stated = self::statedAuthors($s);
        switch ($type) {
            case 'document':
                $d = Access::document($id);
                if ((int)$d['project_id'] !== $pid) throw new HttpError(422, 'This file belongs to another project.');
                if ($page < 1) throw new HttpError(422, 'A source in a file needs a page number.');
                $vid = (int)($s['version_id'] ?? $d['current_version_id']);
                if (!Db::value('SELECT 1 FROM document_versions WHERE id = ? AND document_id = ?', [$vid, $id])) throw new HttpError(422, 'Unknown version of this file.');
                $row['version_id'] = $vid;
                $row['is_human'] = $d['origin'] === 'human';
                if (!$row['is_human']) {
                    $vm = Db::value('SELECT ai_model FROM document_versions WHERE id = ?', [$vid]);
                    self::credit($row, null, (string)($vm ?: $d['ai_model'] ?: 'unspecified'), 'ai_model');
                } elseif ($stated !== null) {
                    self::credit($row, null, $stated, 'client_stated');
                } else {
                    $up = Db::one('SELECT u.id, u.name FROM document_versions v JOIN users u ON u.id = v.uploaded_by WHERE v.id = ?', [$vid]);
                    self::credit($row, (int)$up['id'], $up['name'], 'file_uploader');
                }
                break;
            case 'bib':
                $b = Access::bib($id);
                if ((int)$b['project_id'] !== $pid) throw new HttpError(422, 'This reference belongs to another project.');
                if ($b['pdf_blob_id'] && $page < 1) throw new HttpError(422, 'A source in a PDF needs a page number.');
                if (trim((string)$b['authors']) !== '') self::credit($row, null, (string)$b['authors'], 'bibliography');
                elseif ($stated !== null) self::credit($row, null, $stated, 'client_stated');
                break;
            case 'message':
                $m = Db::one('SELECT m.conversation_id, m.body_html, m.ai_model, m.author_id, u.name AS author_name FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?', [$id]);
                if (!$m) throw new HttpError(404, 'Message not found');
                $c = Access::conversation((int)$m['conversation_id']);
                if ((int)$c['project_id'] !== $pid) throw new HttpError(422, 'This message belongs to another project.');
                self::assertQuote($quote, $m['body_html']);
                self::assertShareable((int)$c['id'], $pid, $publishPrivate);
                $row['conversation_id'] = (int)$c['id'];
                $row['is_human'] = $m['ai_model'] === null;
                if ($row['is_human']) self::credit($row, (int)$m['author_id'], $m['author_name'], 'message_author');
                else self::credit($row, null, $m['ai_model'], 'ai_model');
                break;
            case 'comment':
                $k = Db::one('SELECT c.project_id, c.target_type, c.target_id, c.body_html, c.ai_model, c.author_id, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?', [$id]);
                if (!$k) throw new HttpError(404, 'Comment not found');
                if (Access::commentTarget($k['target_type'], (int)$k['target_id']) !== $pid) throw new HttpError(422, 'This comment belongs to another project.');
                self::assertQuote($quote, $k['body_html']);
                if ($k['target_type'] === 'conversation') {
                    self::assertShareable((int)$k['target_id'], $pid, $publishPrivate);
                    $row['conversation_id'] = (int)$k['target_id'];
                }
                $row['is_human'] = $k['ai_model'] === null;
                if ($row['is_human']) self::credit($row, (int)$k['author_id'], $k['author_name'], 'comment_author');
                else self::credit($row, null, $k['ai_model'], 'ai_model');
                break;
            default:
                throw new HttpError(422, 'A source type must be document, bib, message or comment.');
        }
        return $row;
    }

    private static function credit(array &$row, ?int $userId, string $name, string $basis): void
    {
        $row['author_user_id'] = $userId;
        $row['author_name'] = mb_substr($name, 0, 500);
        $row['author_basis'] = $basis;
    }

    /** Authors named by the client for a file: a claim, shown as such. */
    private static function statedAuthors(array $s): ?string
    {
        if (!array_key_exists('authors', $s)) return null;
        $list = is_array($s['authors']) ? $s['authors'] : [$s['authors']];
        $names = array_values(array_filter(array_map(fn($a) => is_scalar($a) ? trim((string)$a) : '', $list), fn($a) => $a !== ''));
        return $names ? implode(', ', $names) : null;
    }

    private static function assertQuote(string $quote, string $html): void
    {
        $norm = fn($t) => trim(preg_replace('/\s+/u', ' ', mb_strtolower($t)));
        if (!str_contains($norm(Sanitizer::toText($html)), $norm($quote))) {
            throw new HttpError(422, 'The quote does not appear in the cited text.');
        }
    }

    /** Facts are visible to the whole project: citing a private conversation must be deliberate. */
    private static function assertShareable(int $conversationId, int $pid, bool $publishPrivate): void
    {
        if ($publishPrivate) return;
        $outside = Db::value('SELECT 1 FROM project_members pm WHERE pm.project_id = ?
            AND pm.user_id NOT IN (SELECT user_id FROM conversation_participants WHERE conversation_id = ?)', [$pid, $conversationId]);
        if ($outside) {
            throw new HttpError(422, 'This conversation is private and every project member can see facts. Ask the user, then send publish_private: true.');
        }
    }

    private static function kind(string $k): string
    {
        if (!in_array($k, self::KINDS, true)) throw new HttpError(422, 'Unknown kind of fact.');
        return $k;
    }

    private static function label(int $pid, string $wanted, string $kind, string $title, ?int $self): string
    {
        if ($wanted !== '') {
            if (!preg_match('/^[A-Za-z0-9_:.\-]{1,120}$/', $wanted) || ctype_digit($wanted)) {
                throw new HttpError(422, 'A label uses letters, digits and _ : . - and cannot be only digits.');
            }
            if (Db::value('SELECT 1 FROM facts WHERE project_id = ? AND label = ? AND id <> ?', [$pid, $wanted, $self ?? 0])) {
                throw new HttpError(409, "The label $wanted is already used.");
            }
            return $wanted;
        }
        $ascii = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $title) ?: '';
        $slug = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($ascii)), '-');
        $base = self::PREFIX[$kind] . ':' . (substr($slug, 0, 60) ?: 'fact');
        $label = $base;
        for ($i = 2; Db::value('SELECT 1 FROM facts WHERE project_id = ? AND label = ?', [$pid, $label]); $i++) $label = "$base-$i";
        return $label;
    }

    /** Each field comes as {field}_text; fields left out keep their value. */
    private static function content(array $it, int $pid, ?array $cur): array
    {
        $out = [];
        foreach (['statement', 'proof', 'intuition'] as $k) {
            if (array_key_exists($k . '_text', $it)) {
                $text = is_scalar($it[$k . '_text']) ? (string)$it[$k . '_text'] : '';
                $out[$k] = trim($text) === '' ? ['html' => '', 'mentions' => [], 'text' => ''] : Sanitizer::clean(Sanitizer::textToHtml($text, $pid));
            } elseif ($cur) {
                $out[$k] = Sanitizer::clean((string)$cur[$k . '_html']);
                $out[$k]['html'] = (string)$cur[$k . '_html'];
            } else {
                $out[$k] = ['html' => '', 'mentions' => [], 'text' => ''];
            }
        }
        if ($out['statement']['text'] === '' && !$out['statement']['mentions']) throw new HttpError(422, 'A statement is required.');
        return $out;
    }

    /** Explicit dependencies (ref, external id, id or label) plus every fact @mentioned in the statement or proof. */
    private static function deps(array $it, int $pid, array $content, ?int $self, array $current, array $refs): array
    {
        $ids = $current;
        if (array_key_exists('depends_on', $it)) {
            $ids = [];
            foreach ((array)$it['depends_on'] as $ref) {
                if (!is_scalar($ref)) throw new HttpError(422, 'Invalid dependency.');
                $key = (string)$ref;
                $row = $refs[$key]
                    ?? Db::value('SELECT id FROM facts WHERE project_id = ? AND external_id = ? AND deleted_at IS NULL', [$pid, $key])
                    ?: (ctype_digit($key)
                        ? Db::value('SELECT id FROM facts WHERE project_id = ? AND id = ? AND deleted_at IS NULL', [$pid, (int)$key])
                        : Db::value('SELECT id FROM facts WHERE project_id = ? AND label = ? AND deleted_at IS NULL', [$pid, $key]));
                if (!$row) throw new HttpError(422, 'Unknown dependency: ' . mb_substr($key, 0, 80));
                $ids[] = (int)$row;
            }
        }
        foreach (['statement', 'proof'] as $k) {
            foreach ($content[$k]['mentions'] as $m) {
                if ($m['type'] === 'fact' && Db::value('SELECT 1 FROM facts WHERE project_id = ? AND id = ? AND deleted_at IS NULL', [$pid, $m['id']])) {
                    $ids[] = (int)$m['id'];
                }
            }
        }
        $ids = array_values(array_unique($ids));
        sort($ids);
        if ($self !== null) {
            if (in_array($self, $ids, true)) throw new HttpError(422, 'A fact cannot depend on itself.');
            self::assertAcyclic($pid, $self, $ids);
        }
        return $ids;
    }

    private static function assertAcyclic(int $pid, int $self, array $deps): void
    {
        $next = [];
        foreach (Db::all('SELECT d.fact_id, d.depends_on_id FROM fact_deps d JOIN facts f ON f.id = d.fact_id WHERE f.project_id = ?', [$pid]) as $e) {
            $next[(int)$e['fact_id']][] = (int)$e['depends_on_id'];
        }
        $stack = $deps;
        $seen = [];
        while ($stack) {
            $x = array_pop($stack);
            if ($x === $self) throw new HttpError(422, 'These dependencies would create a cycle.');
            if (isset($seen[$x])) continue;
            $seen[$x] = true;
            array_push($stack, ...($next[$x] ?? []));
        }
    }

    private static function insertRevision(int $id, int $no, array $content, array $deps, array $prov, ?string $notes, array $extra, array $sources): void
    {
        Db::insert('fact_revisions', [
            'fact_id' => $id, 'revision_no' => $no, 'statement_html' => $content['statement']['html'],
            'proof_html' => $content['proof']['html'] ?: null, 'intuition_html' => $content['intuition']['html'] ?: null,
            'deps_json' => json_encode($deps), 'origin' => $prov['origin'], 'proof_origin' => $prov['proof_origin'], 'ai_model' => $prov['ai_model'],
            'ai_user_id' => $prov['ai_user_id'], 'ai_generation_ms' => $prov['ai_generation_ms'],
            'notes' => $notes, 'author_id' => Auth::id(), 'created_at' => Db::now(),
            'glossary_json' => $extra['glossary_json'], 'external_refs_json' => $extra['external_refs_json'],
        ]);
        foreach ($sources as $s) Db::insert('fact_sources', $s + ['fact_id' => $id, 'revision_no' => $no]);
    }

    private static function setDeps(int $id, array $deps): void
    {
        Db::run('DELETE FROM fact_deps WHERE fact_id = ?', [$id]);
        foreach ($deps as $d) Db::insert('fact_deps', ['fact_id' => $id, 'depends_on_id' => $d]);
    }

    private static function notifyMentions(int $pid, int $id, array $content, bool $isNew = true): void
    {
        $mentions = array_values(array_unique(array_merge($content['statement']['mentions'], $content['proof']['mentions'], $content['intuition']['mentions']), SORT_REGULAR));
        Notify::mentions($pid, 'fact', $id, $mentions, ['view' => 'facts', 'id' => $id], $content['statement']['text'], null, $isNew);
    }

    /** Detects sorry, admit and axiom outside strings and comments. */
    private static function leanIncomplete(string $code): bool
    {
        $s = preg_replace('/"(?:\\\\.|[^"\\\\])*"/s', '""', $code) ?? $code;
        do {
            $before = $s;
            $s = preg_replace('/\/-(?:(?!\/-|-\/).)*-\//s', ' ', $s) ?? $s;
        } while ($s !== $before);
        $s = preg_replace('/--[^\n]*/', '', $s) ?? $s;
        return (bool)preg_match('/(?<![\w.\'])(sorry|admit|axiom)(?![\w\'])/', $s);
    }

    /** Sources with a link. A quote from a conversation is only shown to its participants. */
    private static function presentSources(int $id, int $revision): array
    {
        $out = [];
        foreach (Db::all('SELECT s.*, u.orcid AS author_orcid, u.kind AS author_kind FROM fact_sources s LEFT JOIN users u ON u.id = s.author_user_id
                          WHERE s.fact_id = ? AND s.revision_no = ? ORDER BY s.id', [$id, $revision]) as $s) {
            $item = ['type' => $s['source_type'], 'page' => $s['page'] ? (int)$s['page'] : null, 'quote' => $s['quote'], 'is_human' => (bool)$s['is_human'], 'hidden' => false,
                'covers' => $s['covers'],
                'author' => $s['author_name'] === null ? null : [
                    'name' => $s['author_name'], 'basis' => $s['author_basis'], 'user_id' => $s['author_user_id'] ? (int)$s['author_user_id'] : null,
                    'orcid' => $s['author_kind'] === 'human' ? $s['author_orcid'] : null,
                ]];
            if ($s['conversation_id'] && !Db::value('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$s['conversation_id'], Auth::id()])) {
                $out[] = ['type' => 'private', 'page' => null, 'quote' => null, 'is_human' => (bool)$s['is_human'], 'hidden' => true, 'label' => 'A private conversation', 'link' => null, 'covers' => $s['covers'], 'author' => null];
                continue;
            }
            $sid = (int)$s['source_id'];
            switch ($s['source_type']) {
                case 'document':
                    $d = Db::one('SELECT d.title, v.version_no FROM documents d LEFT JOIN document_versions v ON v.id = ? WHERE d.id = ?', [$s['version_id'], $sid]);
                    $item['label'] = ($d['title'] ?? 'Deleted file') . ' (v' . ($d['version_no'] ?? '?') . ')';
                    $item['link'] = ['view' => 'files', 'id' => $sid, 'query' => ['v' => (int)$s['version_id']]];
                    break;
                case 'bib':
                    $item['label'] = (string)(Db::value('SELECT cite_key FROM bib_entries WHERE id = ?', [$sid]) ?: 'Deleted reference');
                    $item['link'] = ['view' => 'bib', 'id' => $sid];
                    break;
                case 'message':
                    $item['label'] = 'Conversation: ' . (Db::value('SELECT subject FROM conversations WHERE id = ?', [$s['conversation_id']]) ?: 'deleted');
                    $item['link'] = ['view' => 'conversations', 'id' => (int)$s['conversation_id']];
                    break;
                default:
                    $k = Db::one('SELECT target_type, target_id FROM comments WHERE id = ?', [$sid]);
                    $view = ['conversation' => 'conversations', 'document' => 'files', 'bib' => 'bib', 'fact' => 'facts'][$k['target_type'] ?? ''] ?? null;
                    $item['label'] = $k ? 'Comment on ' . $k['target_type'] : 'Deleted comment';
                    $item['link'] = $k ? ['view' => $view, 'id' => (int)$k['target_id'], 'query' => ['comment' => $sid]] : null;
            }
            $out[] = $item;
        }
        return $out;
    }

    private static function present(array $f): array
    {
        $id = (int)$f['id'];
        $pid = (int)$f['project_id'];
        $g = self::graph($pid);
        $byId = array_column($g['facts'], null, 'id');
        $out = $byId[$id];
        $brief = fn($x) => ['id' => $x, 'label' => $byId[$x]['label'], 'title' => $byId[$x]['title'], 'kind' => $byId[$x]['kind'],
            'status' => $byId[$x]['status'], 'origin' => $byId[$x]['origin'], 'ai_model' => $byId[$x]['ai_model']];
        $out['project_id'] = $pid;
        $out['last_activity_id'] = Activity::latest($pid, 'fact', $id);
        $out['retract_reason'] = $f['retract_reason'];
        $out['retracted_by_name'] = $f['retracted_by'] ? Db::value('SELECT name FROM users WHERE id = ?', [$f['retracted_by']]) : null;
        $out['deps'] = array_map($brief, $out['deps']);
        $out['dependents'] = array_map($brief, $out['dependents']);
        $out['revisions'] = Db::all(
            'SELECT r.*, u.name AS author_name, u.kind AS author_kind, au.name AS ai_user_name FROM fact_revisions r JOIN users u ON u.id = r.author_id
             LEFT JOIN users au ON au.id = r.ai_user_id WHERE r.fact_id = ? ORDER BY r.revision_no DESC', [$id]);
        $cur = $out['revisions'][0];
        foreach (['statement', 'proof', 'intuition'] as $k) {
            $out[$k . '_html'] = $cur[$k . '_html'];
            $out[$k . '_text'] = Sanitizer::toText((string)$cur[$k . '_html']);
        }
        $out['glossary'] = $cur['glossary_json'] ? json_decode($cur['glossary_json'], true) : null;
        $out['external_refs'] = $cur['external_refs_json'] ? json_decode($cur['external_refs_json'], true) : null;
        $out['sources'] = self::presentSources($id, (int)$f['current_revision']);
        $out['reviews'] = array_map(function ($v) use ($f) {
            $v['independent'] = $v['reviewer_kind'] === 'human' || !self::sameModel($f, $v['ai_model']);
            $v['body_text'] = Sanitizer::toText((string)$v['body_html']);
            return $v;
        }, Db::all('SELECT v.*, u.name AS reviewer_name, au.name AS ai_user_name FROM fact_reviews v JOIN users u ON u.id = v.reviewer_id
                    LEFT JOIN users au ON au.id = v.ai_user_id WHERE v.fact_id = ? ORDER BY v.revision_no DESC, v.updated_at DESC', [$id]));
        $out['lean_proofs'] = Db::all(
            'SELECT l.*, u.name AS created_by_name, c.name AS checked_by_name, au.name AS ai_user_name, cu.name AS check_user_name FROM fact_lean l
             JOIN users u ON u.id = l.created_by LEFT JOIN users c ON c.id = l.checked_by
             LEFT JOIN users au ON au.id = l.ai_user_id LEFT JOIN users cu ON cu.id = l.check_user_id
             WHERE l.fact_id = ? ORDER BY l.revision_no DESC, l.id DESC', [$id]);
        return $out;
    }
}
