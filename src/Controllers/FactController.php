<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{FactBasis, FactKind, Access, Activity, Auth, Db, HttpError, Notify, Provenance, Request, Response, Sanitizer};

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
    /** What a reviewer thinks of the result itself, apart from its proof. */
    private const STATEMENT_VERDICTS = ['true', 'false', 'unsure'];
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
    private const COMMENT_ROLES = ['supports', 'disputes', 'clarifies'];

    /** What the interface shows in the list and the graph. The full statement is loaded with each fact. */
    private const COMPACT = ['id', 'label', 'title', 'kind', 'display_kind', 'status', 'chain', 'origin', 'proof_origin', 'method', 'tool', 'lean', 'labels', 'ai_model',
        'author', 'ai_user_name', 'ai_generation_ms', 'updated_at', 'stars', 'starred', 'comment_count', 'retracted_at', 'created_by', 'current_revision', 'endorsed_by', 'topics', 'basis', 'incomplete'];
    private const EXCERPT = 160;

    /**
     * The facts and their dependencies. With ?compact=1, only what the list and the graph show, with an excerpt of each statement.
     * The ETag changes with anything that can change the answer: a poll that sends it back gets 304 without the graph being rebuilt.
     */
    public static function list(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $compact = !empty($r->query['compact']);
        $etag = '"' . self::listVersion($pid, $compact) . '"';
        header('ETag: ' . $etag);
        if (in_array($etag, array_map('trim', explode(',', (string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''))), true)) {
            http_response_code(304);
            header('Cache-Control: no-cache');
            exit;
        }
        $g = self::graph($pid);
        $mine = array_flip(array_map('intval', array_column(Db::all('SELECT s.fact_id FROM fact_stars s JOIN facts f ON f.id = s.fact_id WHERE f.project_id = ? AND s.user_id = ?', [$pid, Auth::id()]), 'fact_id')));
        foreach ($g['facts'] as &$f) {
            $f['starred'] = isset($mine[$f['id']]);
            if (!$compact) continue;
            $text = (string)$f['statement_text'];
            $short = mb_strlen($text) > self::EXCERPT;
            $f = array_intersect_key($f, array_flip(self::COMPACT)) + ['used_by' => count($f['dependents']),
                'statement_text' => $short ? mb_substr($text, 0, self::EXCERPT) . '…' : $text, 'statement_truncated' => $short];
        }
        unset($f);
        if (!$compact) Response::json($g + ['compact' => false]);
        // Columns, so that each field name is sent once rather than once per fact.
        $columns = array_merge(self::COMPACT, ['used_by', 'statement_text', 'statement_truncated']);
        Response::json(['compact' => true, 'columns' => $columns, 'rows' => array_map(fn($f) => array_map(fn($c) => $f[$c] ?? null, $columns), $g['facts']), 'edges' => $g['edges']]);
    }

    /** Changes whenever the list could: a fact, review, proof, comment, star or rewrite, for this person. */
    private static function listVersion(int $pid, bool $compact): string
    {
        $parts = [
            Db::value("SELECT COALESCE(MAX(id), 0) FROM activity WHERE project_id = ? AND item_type = 'fact'", [$pid]),
            Db::value('SELECT COUNT(*) FROM facts WHERE project_id = ? AND deleted_at IS NULL', [$pid]),
            Db::value('SELECT COALESCE(MAX(updated_at), \'\') FROM facts WHERE project_id = ?', [$pid]),
            Db::value('SELECT COUNT(*) FROM fact_stars s JOIN facts f ON f.id = s.fact_id WHERE f.project_id = ?', [$pid]),
            Db::value('SELECT COALESCE(MAX(s.created_at), \'\') FROM fact_stars s JOIN facts f ON f.id = s.fact_id WHERE f.project_id = ?', [$pid]),
            Db::value('SELECT COUNT(*) FROM notations WHERE project_id = ?', [$pid]),
        ];
        return sha1(json_encode([$parts, Auth::id(), $compact]));
    }

    /** The facts whose label, title or full statement contain the words: the list searches beyond its excerpts. */
    public static function match(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $words = array_slice(array_values(array_filter(preg_split('/\s+/u', mb_strtolower(trim((string)($r->query['q'] ?? '')))) ?: [], fn($w) => mb_strlen($w) >= 2)), 0, 8);
        if (!$words) Response::json(['ids' => []]);
        $where = []; $params = [$pid];
        foreach ($words as $w) {
            $where[] = '(LOWER(f.label) LIKE ? OR LOWER(f.title) LIKE ? OR LOWER(r.statement_html) LIKE ?)';
            $like = '%' . htmlspecialchars($w, ENT_QUOTES | ENT_HTML5, 'UTF-8') . '%'; // the stored text is HTML; a % or _ typed only widens the search
            array_push($params, $like, $like, $like);
        }
        $ids = Db::all('SELECT f.id FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
                        WHERE f.project_id = ? AND f.deleted_at IS NULL AND ' . implode(' AND ', $where) . ' LIMIT 5000', $params);
        Response::json(['ids' => array_map('intval', array_column($ids, 'id'))]);
    }

    /** A member marks a fact as interesting, or takes the star back. People only. */
    public static function star(Request $r): never
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can star a fact.');
        $f = Access::fact($r->int('id'));
        if ($r->method === 'DELETE') Db::run('DELETE FROM fact_stars WHERE fact_id = ? AND user_id = ?', [$f['id'], Auth::id()]);
        elseif (!Db::value('SELECT 1 FROM fact_stars WHERE fact_id = ? AND user_id = ?', [$f['id'], Auth::id()])) {
            try { Db::insert('fact_stars', ['fact_id' => $f['id'], 'user_id' => Auth::id(), 'created_at' => Db::now()]); } catch (\PDOException) { /* starred meanwhile */ }
        }
        $n = (int)Db::value('SELECT COUNT(*) FROM fact_stars WHERE fact_id = ?', [$f['id']]);
        Response::json(['id' => (int)$f['id'], 'stars' => $n, 'starred' => $r->method !== 'DELETE']);
    }

    /** @return array{facts:list<array>, edges:list<array{0:int,1:int}>} edges are [fact, depends_on] */
    public static function graph(int $pid): array
    {
        $facts = Db::all(
            "SELECT f.id, f.label, f.kind, f.title, f.origin, f.proof_origin, f.labels_json, f.method, f.tool, f.external_id, f.ai_model, f.current_revision, f.retracted_at, f.created_by, f.topics_json,
                    f.created_at, f.updated_at, u.name AS author, u.kind AS author_kind, r.statement_html, r.proof_html, r.external_refs_json, r.author_id AS revision_author,
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
        foreach (Db::all('SELECT v.fact_id, v.verdict, v.statement_verdict, v.reviewer_id, v.reviewer_kind, v.ai_model, u.name AS reviewer_name FROM fact_reviews v
                          JOIN users u ON u.id = v.reviewer_id
                          JOIN facts f ON f.id = v.fact_id AND v.revision_no = f.current_revision WHERE f.project_id = ?', [$pid]) as $v) {
            $reviews[(int)$v['fact_id']][] = $v;
        }
        $proofs = [];
        foreach (Db::all('SELECT p.id, p.fact_id, p.ai_model FROM fact_proofs p JOIN facts f ON f.id = p.fact_id AND p.revision_no = f.current_revision WHERE f.project_id = ?', [$pid]) as $p) {
            $proofs[(int)$p['fact_id']][(int)$p['id']] = $p + ['reviews' => []];
        }
        foreach (Db::all('SELECT v.proof_id, p.fact_id, v.verdict, v.reviewer_id, v.reviewer_kind, v.ai_model, u.name AS reviewer_name FROM fact_proof_reviews v
                          JOIN users u ON u.id = v.reviewer_id JOIN fact_proofs p ON p.id = v.proof_id
                          JOIN facts f ON f.id = p.fact_id AND p.revision_no = f.current_revision WHERE f.project_id = ?', [$pid]) as $v) {
            $proofs[(int)$v['fact_id']][(int)$v['proof_id']]['reviews'][] = $v;
        }
        $stars = array_map('intval', array_column(Db::all('SELECT s.fact_id, COUNT(*) AS n FROM fact_stars s JOIN facts f ON f.id = s.fact_id WHERE f.project_id = ? GROUP BY s.fact_id', [$pid]), 'n', 'fact_id'));
        // What tells a cited result from a proved fact, and whether a proof still uses an outside reference directly.
        $checks = [];
        foreach (Db::all('SELECT c.fact_id, c.verdict, c.ai_model FROM fact_source_checks c JOIN facts f ON f.id = c.fact_id AND c.revision_no = f.current_revision
                          WHERE f.project_id = ? ORDER BY c.id DESC', [$pid]) as $c) $checks[(int)$c['fact_id']][] = $c;
        $links = [];
        foreach (Db::all('SELECT l.fact_id, l.ref_key, l.cited_fact_id FROM fact_ref_links l JOIN facts f ON f.id = l.fact_id WHERE f.project_id = ?', [$pid]) as $l) {
            $links[(int)$l['fact_id']][$l['ref_key']] = $l['cited_fact_id'] === null ? null : (int)$l['cited_fact_id'];
        }
        $bibOf = [];
        foreach (Db::all("SELECT s.fact_id, s.source_id FROM fact_sources s JOIN facts f ON f.id = s.fact_id AND s.revision_no = f.current_revision
                          WHERE f.project_id = ? AND s.source_type = 'bib' AND s.covers <> 'context'", [$pid]) as $s) $bibOf[(int)$s['fact_id']][] = (int)$s['source_id'];
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
            $f['status'] = self::status($f, $reviews[$id] ?? [], array_values($proofs[$id] ?? []));
            $f['proof_count'] = 1 + count($proofs[$id] ?? []);
            $f['stars'] = $stars[$id] ?? 0;
            $f['review_counts'] = array_count_values(array_column($reviews[$id] ?? [], 'verdict'));
            $f['lean'] = self::leanState($lean[$id] ?? []);
            $f['labels'] = json_decode((string)$f['labels_json'], true) ?: [];
            $f['topics'] = json_decode((string)$f['topics_json'], true) ?: [];
            unset($f['labels_json'], $f['topics_json']);
            $people = fn(array $rows) => array_values(array_map(fn($v) => ['id' => (int)$v['reviewer_id'], 'name' => $v['reviewer_name']],
                array_values(array_column(array_filter($rows, fn($v) => $v['reviewer_kind'] === 'human'), null, 'reviewer_id'))));
            $altReviews = array_merge([], ...array_map(fn($p) => $p['reviews'], array_values($proofs[$id] ?? [])));
            // Endorsed: a person accepted a proof of this revision, the main one or another.
            $f['endorsed_by'] = $people(array_merge(array_filter($reviews[$id] ?? [], fn($v) => $v['verdict'] === 'correct'), array_filter($altReviews, fn($v) => $v['verdict'] === 'correct')));
            $endorsers = array_column($f['endorsed_by'], 'id');
            // The result is accepted, but no proof is: "I believe it, the proof is wrong".
            $f['result_endorsed_by'] = array_values(array_filter($people(array_filter($reviews[$id] ?? [], fn($v) => $v['statement_verdict'] === 'true' && $v['verdict'] !== 'correct')), fn($p) => !in_array($p['id'], $endorsers, true)));
            $f['denied_by'] = $people(array_filter($reviews[$id] ?? [], [self::class, 'doubtsStatement']));
            $f['statement_text'] = Sanitizer::toText($f['statement_html']);
            $f['display_kind'] = FactKind::of((string)$f['kind'], $f['tool'], $f['statement_text']);
            // A definition is a convention, not a claim: it belongs to the project notation, and nothing in it needs a check.
            $f['basis'] = FactBasis::of($f['display_kind'], $f['labels'], trim((string)$f['proof_html']) !== '' || !empty($proofs[$id]));
            if ($f['basis'] === 'cited') $f['status'] = FactBasis::citedStatus($f['retracted_at'], $reviews[$id] ?? [], $checks[$id] ?? [], $f['ai_model']);
            $f['source_verdict'] = $f['basis'] === 'cited' ? FactBasis::sourceVerdict($checks[$id] ?? [], $f['ai_model']) : null;
            if ($f['display_kind'] === 'definition' && !in_array($f['status'], ['retracted', 'disputed'], true)) $f['status'] = 'definition';
            $f['outside_refs'] = $f['basis'] === 'proved' ? FactBasis::outsideRefs($f['proof_html'], $f['external_refs_json']) : [];
            unset($f['statement_html'], $f['proof_html'], $f['external_refs_json']);
            $f['deps'] = [];
            $f['dependents'] = [];
            $f['chain'] = 'ok';
            $byId[$id] = $f;
        }
        foreach ($edges as [$a, $b]) { $byId[$a]['deps'][] = $b; $byId[$b]['dependents'][] = $a; }
        foreach ($byId as $id => &$f) {
            $f['outside_refs'] = FactBasis::resolve($f['outside_refs'], $links[$id] ?? [], $f['deps'], $bibOf);
            $f['incomplete'] = (bool)array_filter($f['outside_refs'], fn($x) => !$x['resolved']);
        }
        unset($f);

        // Propagate along dependents, weakest first, so that 'broken' takes precedence. A cited result nobody accepted is unchecked.
        // A proof that uses an outside result directly makes what relies on it incomplete: no review of the chain can settle it.
        self::mark($byId, fn($f) => in_array($f['status'], ['unchecked', 'source_confirmed'], true), 'unchecked');
        self::mark($byId, fn($f) => $f['incomplete'], 'incomplete');
        self::mark($byId, fn($f) => $f['status'] === 'proof_disputed', 'unproved');
        self::mark($byId, fn($f) => in_array($f['status'], ['disputed', 'retracted'], true), 'broken');
        return ['facts' => array_values($byId), 'edges' => $edges];
    }

    /** What a proof search on this computer may build on: established, its whole chain too. */
    public const ESTABLISHED = ['human_checked', 'ai_checked', 'double_checked', 'accepted', 'definition'];

    /**
     * What a proof search may build on, by fact id: more than what people established. A proved fact a verifier accepted (even
     * the model that wrote it), and a cited result nobody accepted yet, unless people dispute it or its source says otherwise:
     * people check the citations an interesting result relies on, not all of them. Everything it relies on must be usable too.
     * @param array<int, array> $byId the facts of graph(), by id @return array<int, bool>
     */
    public static function usable(array $byId): array
    {
        $usable = [];
        $use = function (int $id, array $seen = []) use (&$use, &$usable, $byId): bool {
            if (isset($usable[$id])) return $usable[$id];
            if (isset($seen[$id]) || !isset($byId[$id])) return false;
            $f = $byId[$id];
            if ($f['basis'] === 'cited') $good = FactBasis::citedUsable($f['status'], $f['source_verdict'] ?? null);
            else {
                $checked = ($f['review_counts']['correct'] ?? 0) > 0 && !in_array($f['status'], ['disputed', 'proof_disputed', 'retracted'], true);
                $good = (in_array($f['status'], self::ESTABLISHED, true) || $checked) && !$f['incomplete'];
            }
            foreach ($f['deps'] as $d) $good = $good && $use((int)$d, $seen + [$id => true]);
            return $usable[$id] = $good;
        };
        foreach (array_keys($byId) as $id) $use((int)$id);
        return $usable;
    }

    /**
     * Everything a proof search merges before it starts, so that it builds on the project instead of starting from scratch:
     * each fact with its text (in the project's notation when a faithful version exists), dependencies, status and whether
     * it may be built on; the strategies of the question; the agreed notation. Proofs and statements are plain text.
     */
    public static function provingContext(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $byId = array_column(self::graph($pid)['facts'], null, 'id');
        $rev = [];
        foreach (Db::all('SELECT r.fact_id, r.revision_no, r.statement_html, r.proof_html, r.glossary_json, r.external_refs_json FROM fact_revisions r
                          JOIN facts f ON f.id = r.fact_id AND r.revision_no = f.current_revision WHERE f.project_id = ? AND f.deleted_at IS NULL', [$pid]) as $x) $rev[(int)$x['fact_id']] = $x;
        $notation = [];
        foreach (Db::all("SELECT p.fact_id, p.statement_html, p.proof_html, p.local_json FROM fact_rephrasings p JOIN facts f ON f.id = p.fact_id AND p.revision_no = f.current_revision
                          WHERE f.project_id = ? AND p.unchanged = 0 AND COALESCE(p.check_verdict, '') <> 'unfaithful' AND p.notation_hash = ? ORDER BY p.id", [$pid, NotationController::hash($pid)]) as $x) $notation[(int)$x['fact_id']] = $x;
        // A fact may be built on when it is established, and everything it relies on too.
        $trusted = [];
        $ok = function (int $id, array $seen = []) use (&$ok, &$trusted, $byId): bool {
            if (isset($trusted[$id])) return $trusted[$id];
            if (isset($seen[$id]) || !isset($byId[$id])) return false;
            $f = $byId[$id];
            $good = in_array($f['status'], self::ESTABLISHED, true) && !$f['incomplete'];
            foreach ($f['deps'] as $d) $good = $good && $ok((int)$d, $seen + [$id => true]);
            return $trusted[$id] = $good;
        };
        $usable = self::usable($byId);
        $use = fn(int $id): bool => $usable[$id] ?? false;
        $facts = [];
        foreach ($byId as $id => $f) {
            $x = $rev[$id] ?? null;
            if (!$x) continue;
            $n = $notation[$id] ?? null;
            $glossary = json_decode((string)($n['local_json'] ?? $x['glossary_json']), true);
            $facts[] = ['id' => $id, 'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['display_kind'], 'revision' => (int)$x['revision_no'],
                'basis' => $f['basis'], 'status' => $f['status'], 'chain' => $f['chain'], 'incomplete' => $f['incomplete'], 'trusted' => $ok($id), 'usable' => $use($id),
                'ai_model' => $f['ai_model'], 'tool' => $f['tool'], 'external_id' => $f['external_id'], 'deps' => array_map('intval', $f['deps']),
                'statement' => Sanitizer::toText((string)($n['statement_html'] ?? $x['statement_html'])),
                'proof' => Sanitizer::toText((string)($n ? ($n['proof_html'] ?: $x['proof_html']) : $x['proof_html'])),
                'glossary' => is_array($glossary) ? array_map(fn($v) => is_string($v) ? $v : json_encode($v, JSON_UNESCAPED_UNICODE), $glossary) : null,
                'external_refs' => json_decode((string)$x['external_refs_json'], true) ?: null, 'in_project_notation' => $n !== null];
        }
        $qid = (int)($r->query['question'] ?? 0);
        $strategies = [];
        if ($qid && Db::value('SELECT 1 FROM open_questions WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [$qid, $pid])) {
            foreach (Db::all('SELECT s.id, s.title, s.status, s.current_revision, v.body_html, v.ai_model FROM proof_strategies s JOIN strategy_revisions v ON v.strategy_id = s.id AND v.revision_no = s.current_revision
                              WHERE s.question_id = ? AND s.deleted_at IS NULL ORDER BY s.id', [$qid]) as $x) {
                $strategies[] = ['id' => (int)$x['id'], 'title' => $x['title'], 'status' => $x['status'], 'revision' => (int)$x['current_revision'], 'body' => Sanitizer::toText((string)$x['body_html']), 'ai_model' => $x['ai_model']];
            }
        }
        $agreed = array_map(fn($e) => ['symbol' => $e['symbol'], 'meaning' => Sanitizer::toText((string)$e['meaning_html']), 'note' => Sanitizer::toText((string)$e['note_html']) ?: null],
            Db::all("SELECT symbol, meaning_html, note_html FROM notations WHERE project_id = ? AND status = 'agreed' ORDER BY id", [$pid]));
        Response::json(['project_id' => $pid, 'question_id' => $qid ?: null, 'facts' => $facts, 'strategies' => $strategies, 'notation' => $agreed]);
    }

    /** One fact as the graph sees it: its basis, status and outside references. */
    public static function graphFact(int $pid, int $id): ?array
    {
        foreach (self::graph($pid)['facts'] as $f) if ($f['id'] === $id) return $f;
        return null;
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

    /**
     * The status of a fact from all the proofs of its current revision: the main one and any other proposed.
     * Doubting the result disputes the fact. Otherwise one accepted proof is enough, and a flaw in a proof
     * only disputes that proof. When every proof is flawed but someone accepts the result, the proof is disputed.
     * A review by the model that wrote a proof is recorded but is not an independent check of it.
     */
    private static function status(array $f, array $reviews, array $proofs = []): string
    {
        if ($f['retracted_at']) return 'retracted';
        if (array_filter($reviews, [self::class, 'doubtsStatement'])) return 'disputed';
        $candidates = [[$reviews, (string)$f['ai_model']]];
        foreach ($proofs as $p) $candidates[] = [$p['reviews'], (string)$p['ai_model']];
        $human = $ai = $flawed = false;
        foreach ($candidates as [$rows, $model]) {
            if (array_filter($rows, fn($v) => $v['verdict'] !== 'correct')) { $flawed = true; continue; }
            foreach ($rows as $v) {
                if ($v['reviewer_kind'] === 'human') $human = true;
                elseif ($model === '' || mb_strtolower(trim($model)) !== mb_strtolower(trim((string)$v['ai_model']))) $ai = true;
            }
        }
        if ($human || $ai) return $human && $ai ? 'double_checked' : ($human ? 'human_checked' : 'ai_checked');
        if (!$flawed) return 'unchecked';
        $believed = array_filter($reviews, fn($v) => $v['statement_verdict'] === 'true');
        foreach ($proofs as $p) foreach ($p['reviews'] as $v) if ($v['verdict'] === 'correct') $believed[] = $v;
        return $believed ? 'proof_disputed' : 'disputed';
    }

    /** A review that says the result is false. An error reported without saying so (older reviews, AI reviews) counts as doubt. */
    private static function doubtsStatement(array $v): bool
    {
        return $v['statement_verdict'] === 'false' || ($v['statement_verdict'] === null && $v['verdict'] === 'incorrect');
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
        // A fact merged into another as the same result opens the one it was merged into.
        $id = $r->int('id');
        $from = null;
        for ($i = 0; $i < 10; $i++) {
            $next = Db::value('SELECT merged_into FROM facts WHERE id = ? AND deleted_at IS NOT NULL', [$id]);
            if (!$next) break;
            $from ??= Db::value('SELECT label FROM facts WHERE id = ?', [$id]);
            $id = (int)$next;
        }
        $f = Access::fact($id);
        Response::json(self::present($f) + ($from !== null ? ['merged_from' => $from] : []));
    }

    /** @return list<string> */
    public static function kinds(): array
    {
        return self::KINDS;
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
            $ancestors[] = ['id' => $x, 'label' => $a['label'], 'title' => $a['title'], 'depth' => $d, 'proof_origin' => $a['proof_origin'], 'origin' => $a['origin'], 'basis' => $a['basis'], 'incomplete' => $a['incomplete'],
                'method' => $a['method'], 'tool' => $a['tool'], 'ai_model' => $a['ai_model'], 'status' => $a['status'], 'labels' => $a['labels'],
                // A source merely cited by a deduced fact gives its authors no credit for that fact.
                'credits' => array_values(array_filter(array_map(fn($s) => $s['covers'] === 'context' ? null : $s['author'], $sources)))];
        }
        // The cited results it rests on, at any depth: what a reader must accept for the fact to hold.
        $cited = array_values(array_map(fn($x) => ['id' => $x, 'label' => $byId[$x]['label'], 'title' => $byId[$x]['title'], 'status' => $byId[$x]['status']],
            array_filter(array_keys($depth), fn($x) => $byId[$x]['basis'] === 'cited')));
        Response::json([
            'rests_on' => $cited, 'rests_on_accepted' => count(array_filter($cited, fn($c) => $c['status'] === 'accepted')),
            'incomplete' => array_values(array_map(fn($x) => ['id' => $x, 'label' => $byId[$x]['label'], 'title' => $byId[$x]['title']],
                array_filter(array_merge([$id], array_keys($depth)), fn($x) => $byId[$x]['incomplete']))),
            'fact' => ['id' => $id, 'basis' => $byId[$id]['basis'], 'proof_origin' => $f['proof_origin'], 'origin' => $f['origin'], 'method' => $f['method'], 'tool' => $f['tool'], 'ai_model' => $f['ai_model']],
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
        // The cited results among them are checked against their source by an AI, without waiting for people.
        $checks = !$dry && $created ? AiTaskController::queueSourceChecks($pid) : 0;
        Response::json(['dry_run' => $dry, 'created' => $created, 'skipped' => $skipped, 'source_checks_queued' => $checks], $dry ? 200 : 201);
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
            $sources = Db::all('SELECT source_type, source_id, version_id, conversation_id, page, quote, is_human, covers, comment_role, author_user_id, author_name, author_basis
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
        if ($changed) QuestionController::factChanged($pid, $id, "{$f['label']} was revised and needs a new endorsement");
        Response::json(self::present(Access::fact($id)));
    }

    public static function delete(Request $r): never
    {
        $f = Access::fact($r->int('id'));
        if ((int)$f['created_by'] !== Auth::id()) Access::owner((int)$f['project_id']);
        if (Db::value('SELECT 1 FROM fact_deps d JOIN facts a ON a.id = d.fact_id WHERE d.depends_on_id = ? AND a.deleted_at IS NULL', [$f['id']])) {
            throw new HttpError(409, 'Other facts depend on this one. Retract it instead, so that they are flagged.');
        }
        if (QuestionController::hasRatifiedAnswer((int)$f['id'])) {
            throw new HttpError(409, 'This fact supports a ratified answer. Retract it instead, so that the question is flagged.');
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
        QuestionController::factChanged((int)$f['project_id'], (int)$f['id'], "{$f['label']} was retracted");

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
        $statement = $r->str('statement') ?: null;
        if ($statement !== null && !in_array($statement, self::STATEMENT_VERDICTS, true)) throw new HttpError(422, 'The statement verdict must be true, false or unsure.');
        if ($verdict === 'correct') {
            if ($statement !== null && $statement !== 'true') throw new HttpError(422, 'A correct proof proves the statement: it cannot be false or unsure.');
            $statement = 'true';
        }
        if ($statement === 'false' && $verdict !== 'incorrect') throw new HttpError(422, 'If the result is false, its proof is incorrect.');
        $rev = Db::one('SELECT * FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$f['id'], $f['current_revision']]);
        $kind = Auth::isAi() ? 'agent' : 'human';
        // Every revision is AI-written, so a human can always check it, including their own client's work.
        if ($kind === 'agent' && self::sameModel($f, Provenance::agentModel($r))) {
            throw new HttpError(403, 'This model wrote this revision: another model or a human has to check it.');
        }
        $body = Sanitizer::fromRequest($r, (int)$f['project_id']);
        if ($verdict !== 'correct' && (!$body || ($body['text'] === '' && !$body['mentions']))) {
            throw new HttpError(422, 'Please explain the gap or the error.');
        }
        $model = Provenance::agentModel($r);
        $now = Db::now();
        $old = Db::value('SELECT id FROM fact_reviews WHERE fact_id = ? AND revision_no = ? AND reviewer_id = ? AND reviewer_kind = ?', [$f['id'], $f['current_revision'], Auth::id(), $kind]);
        $row = Provenance::stamp($model, $r->input('generation_seconds')) + ['verdict' => $verdict, 'statement_verdict' => $statement, 'ai_model' => $model, 'body_html' => $body['html'] ?? null, 'updated_at' => $now];
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
        if ($verdict !== 'correct') QuestionController::factChanged((int)$f['project_id'], (int)$f['id'], "{$f['label']} was " . ($statement === 'true' ? 'accepted with a disputed proof' : ($verdict === 'incorrect' ? 'denied' : 'reported with a gap')));
        $link = ['view' => 'facts', 'id' => (int)$f['id']];
        if ($body) Notify::mentions((int)$f['project_id'], 'fact_review', $rid, $body['mentions'], $link, $body['text'], null, !$old);
        if ((int)$rev['author_id'] !== Auth::id() && Access::isMember((int)$f['project_id'], (int)$rev['author_id'])) {
            Notify::send((int)$rev['author_id'], (int)$f['project_id'], 'fact_review', ['link' => $link, 'excerpt' => $f['label'] . ': ' . $verdict]);
        }
        Response::json(self::present(Access::fact((int)$f['id'])), $old ? 200 : 201);
    }

    /**
     * A person settles an outside reference of a proof: the fact of the database that states the result it uses, which becomes
     * a dependency, or "not used as a result" (a reference for context only). {"clear": true} unsettles it again.
     */
    public static function linkRef(Request $r): never
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can do this.');
        $f = Access::fact($r->int('id'));
        $pid = (int)$f['project_id'];
        Access::member($pid);
        $key = $r->str('ref');
        if ($r->input('clear') === true) {
            // Back to unsettled. A dependency added with the link stays: it is part of the proof now.
            Db::run('DELETE FROM fact_ref_links WHERE fact_id = ? AND ref_key = ?', [$f['id'], $key]);
            Activity::touch($pid, 'fact', (int)$f['id'], 'updated');
            Response::json(self::present(Access::fact((int)$f['id'])));
        }
        $byId = array_column(self::graph($pid)['facts'], null, 'id');
        if (!in_array($key, array_column($byId[(int)$f['id']]['outside_refs'] ?? [], 'key'), true)) throw new HttpError(422, 'This proof does not use this reference.');
        $target = null;
        if ($r->input('not_used') !== true) {
            $target = (int)$r->input('fact_id');
            if (!isset($byId[$target]) || $target === (int)$f['id']) throw new HttpError(422, 'Choose another fact of this project.');
        }
        Db::tx(function () use ($f, $pid, $key, $target) {
            if ($target !== null) ConsolidationController::addDependency($pid, $f, $target);
            Db::run('DELETE FROM fact_ref_links WHERE fact_id = ? AND ref_key = ?', [$f['id'], $key]);
            Db::insert('fact_ref_links', ['fact_id' => $f['id'], 'ref_key' => $key, 'cited_fact_id' => $target, 'created_by' => Auth::id(), 'created_at' => Db::now()]);
        });
        Activity::touch($pid, 'fact', (int)$f['id'], 'updated');
        Response::json(self::present(Access::fact((int)$f['id'])));
    }

    /**
     * A new cited result for an outside reference of $proved: its statement, written from how the proof uses it, and the reference.
     * It has no proof and waits for a person who reads the source. @return int its id
     */
    public static function createCited(int $pid, array $proved, string $refKey, string $title, string $statement, string $kind, ?string $model, mixed $seconds): int
    {
        $byId = array_column(self::graph($pid)['facts'], null, 'id');
        $ref = array_values(array_filter($byId[(int)$proved['id']]['outside_refs'] ?? [], fn($x) => $x['key'] === $refKey))[0] ?? null;
        if (!$ref) throw new HttpError(422, 'This proof does not use this reference.');
        if ($ref['bib_id'] !== null) {
            $b = Db::one('SELECT id, cite_key, title, authors, year, doi FROM bib_entries WHERE id = ? AND project_id = ?', [$ref['bib_id'], $pid]);
            $entry = $b ? ['key' => $b['cite_key'], 'title' => $b['title'], 'authors' => $b['authors'], 'year' => $b['year'], 'doi' => $b['doi'], 'bib_id' => (int)$b['id']] : ['title' => $ref['label']];
        } else {
            $cur = Db::value('SELECT external_refs_json FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$proved['id'], $proved['current_revision']]);
            $list = json_decode((string)$cur, true) ?: [];
            $list = \App\FactMigration::repairRefs($list) ?? $list;
            $entry = array_values(array_filter($list, fn($x) => 'ext:' . substr(sha1(json_encode($x, JSON_UNESCAPED_UNICODE) ?: ''), 0, 16) === $refKey))[0] ?? ['title' => $ref['label']];
            if (!is_array($entry)) $entry = ['title' => (string)$entry];
        }
        return self::ingest($pid, ['title' => $title, 'kind' => in_array($kind, self::KINDS, true) ? $kind : 'theorem', 'labels' => ['conclusion'], 'method' => 'extracted',
            'statement_text' => $statement, 'external_refs' => [$entry], 'ai_model' => $model, 'generation_seconds' => $seconds,
            'notes' => 'Cited result used by the proof of ' . $proved['label']], [], true);
    }

    /** Links a reader's comment to a fact from the same text. The fact and its reviews do not change. */
    public static function linkComment(Request $r): never
    {
        self::requireAi();
        $f = Access::fact($r->int('id'));
        $role = $r->str('role');
        if (!in_array($role, self::COMMENT_ROLES, true)) throw new HttpError(422, 'The role must be supports, disputes or clarifies.');
        $cid = (int)$r->input('comment_id');
        $k = Db::one("SELECT c.id, c.target_type, c.target_id FROM comments c WHERE c.id = ? AND c.project_id = ? AND c.target_type IN ('document', 'bib', 'conversation')", [$cid, $f['project_id']]);
        if (!$k) throw new HttpError(404, 'Comment not found');
        $fromConversation = $k['target_type'] === 'conversation';
        $sameText = $fromConversation
            ? Db::value("SELECT 1 FROM fact_sources WHERE fact_id = ? AND revision_no = ? AND source_type = 'message' AND conversation_id = ? AND covers <> 'context'", [$f['id'], $f['current_revision'], $k['target_id']])
            : Db::value("SELECT 1 FROM fact_sources WHERE fact_id = ? AND revision_no = ? AND source_type = ? AND source_id = ? AND covers <> 'context'", [$f['id'], $f['current_revision'], $k['target_type'], $k['target_id']]);
        if (!$sameText) throw new HttpError(422, 'This comment is not about the text this fact comes from.');
        if ($fromConversation) Access::conversation((int)$k['target_id']);
        // The fact already cites this conversation, and its comment stays hidden from non-participants like its message.
        $row = self::source((int)$f['project_id'], ['type' => 'comment', 'id' => $cid, 'quote' => $r->input('quote')], $fromConversation);
        if (!Db::value("SELECT 1 FROM fact_sources WHERE fact_id = ? AND revision_no = ? AND source_type = 'comment' AND source_id = ?", [$f['id'], $f['current_revision'], $cid])) {
            $row['is_human'] = $row['is_human'] ? 1 : 0;
            Db::insert('fact_sources', ['covers' => 'context', 'comment_role' => $role] + $row + ['fact_id' => $f['id'], 'revision_no' => $f['current_revision']]);
            Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'source');
        }
        Response::json(self::present(Access::fact((int)$f['id'])));
    }

    // ----- other proofs of the same statement -----

    /** A person or an AI client proposes another proof of the current revision's statement. */
    public static function proposeProof(Request $r): never
    {
        $f = Access::fact($r->int('id'));
        if ($f['retracted_at']) throw new HttpError(422, 'This fact is retracted.');
        $pid = (int)$f['project_id'];
        $body = Sanitizer::fromRequest($r, $pid);
        if (!$body || ($body['text'] === '' && !$body['mentions'])) throw new HttpError(422, 'Write the proof.');
        $model = Provenance::agentModel($r);
        $now = Db::now();
        $id = Db::insert('fact_proofs', Provenance::stamp($model, $r->input('generation_seconds')) + [
            'fact_id' => $f['id'], 'revision_no' => $f['current_revision'], 'author_id' => Auth::id(), 'author_kind' => Auth::isAi() ? 'agent' : 'human',
            'ai_model' => $model, 'body_html' => $body['html'], 'created_at' => $now, 'updated_at' => $now,
        ]);
        Activity::touch($pid, 'fact', (int)$f['id'], 'proof', $id);
        $link = ['view' => 'facts', 'id' => (int)$f['id'], 'query' => ['proof' => $id]];
        Notify::mentions($pid, 'fact_proof', $id, $body['mentions'], $link, $body['text']);
        $author = (int)Db::value('SELECT author_id FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$f['id'], $f['current_revision']]);
        if ($author !== Auth::id() && Access::isMember($pid, $author)) Notify::send($author, $pid, 'fact_proof', ['link' => $link, 'excerpt' => $f['label'] . ': ' . mb_substr($body['text'], 0, 150)]);
        Response::json(self::present(Access::fact((int)$f['id'])), 201);
    }

    /** Its author rewrites a proof. Reviews of the old text no longer apply. */
    public static function updateProof(Request $r): never
    {
        [$p, $f] = self::proof($r->int('proof'));
        if ((int)$p['author_id'] !== Auth::id()) throw new HttpError(403, 'Only its author can change this proof.');
        $body = Sanitizer::fromRequest($r, (int)$f['project_id']);
        if (!$body || ($body['text'] === '' && !$body['mentions'])) throw new HttpError(422, 'Write the proof.');
        $model = Provenance::agentModel($r);
        Db::tx(function () use ($p, $body, $model, $r) {
            Db::update('fact_proofs', Provenance::stamp($model, $r->input('generation_seconds')) + ['body_html' => $body['html'], 'ai_model' => $model, 'updated_at' => Db::now()], 'id = :id', ['id' => $p['id']]);
            Db::run('DELETE FROM fact_proof_reviews WHERE proof_id = ?', [$p['id']]);
        });
        Notify::mentions((int)$f['project_id'], 'fact_proof', (int)$p['id'], $body['mentions'], ['view' => 'facts', 'id' => (int)$f['id'], 'query' => ['proof' => (int)$p['id']]], $body['text'], null, false);
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'proof', (int)$p['id']);
        QuestionController::factChanged((int)$f['project_id'], (int)$f['id'], "A proof of {$f['label']} was rewritten");
        Response::json(self::present(Access::fact((int)$f['id'])));
    }

    /** Its author, or a project owner, withdraws a proof. */
    public static function deleteProof(Request $r): never
    {
        [$p, $f] = self::proof($r->int('proof'));
        if ((int)$p['author_id'] !== Auth::id()) Access::owner((int)$f['project_id']);
        Db::run('DELETE FROM fact_proof_reviews WHERE proof_id = ?', [$p['id']]);
        Db::run('DELETE FROM fact_proofs WHERE id = ?', [$p['id']]);
        Db::run("DELETE FROM mentions WHERE source_type = 'fact_proof' AND source_id = ?", [$p['id']]);
        QuestionController::factChanged((int)$f['project_id'], (int)$f['id'], "A proof of {$f['label']} was withdrawn");
        Response::json(self::present(Access::fact((int)$f['id'])));
    }

    /** One review per reviewer and proof. Nobody reviews their own proof, and a model does not review its own. */
    public static function reviewProof(Request $r): never
    {
        [$p, $f] = self::proof($r->int('proof'));
        if ($f['retracted_at']) throw new HttpError(422, 'This fact is retracted.');
        if ((int)$p['revision_no'] !== (int)$f['current_revision']) throw new HttpError(422, 'This proof is about an older revision of the statement.');
        $verdict = $r->str('verdict');
        if (!in_array($verdict, self::VERDICTS, true)) throw new HttpError(422, 'The verdict must be correct, gap or incorrect.');
        $kind = Auth::isAi() ? 'agent' : 'human';
        $model = Provenance::agentModel($r);
        if ((int)$p['author_id'] === Auth::id() && $kind === $p['author_kind'] && ($kind === 'human' || mb_strtolower((string)$p['ai_model']) === mb_strtolower((string)$model))) {
            throw new HttpError(403, 'You wrote this proof: someone else has to check it.');
        }
        if ($kind === 'agent' && $p['ai_model'] && mb_strtolower(trim((string)$p['ai_model'])) === mb_strtolower(trim((string)$model))) throw new HttpError(403, 'This model wrote this proof: another model or a human has to check it.');
        $body = Sanitizer::fromRequest($r, (int)$f['project_id']);
        if ($verdict !== 'correct' && (!$body || ($body['text'] === '' && !$body['mentions']))) throw new HttpError(422, 'Please explain the gap or the error.');
        $now = Db::now();
        $old = Db::value('SELECT id FROM fact_proof_reviews WHERE proof_id = ? AND reviewer_id = ? AND reviewer_kind = ?', [$p['id'], Auth::id(), $kind]);
        $row = Provenance::stamp($model, $r->input('generation_seconds')) + ['verdict' => $verdict, 'ai_model' => $model, 'body_html' => $body['html'] ?? null, 'updated_at' => $now];
        if ($old) Db::update('fact_proof_reviews', $row, 'id = :id', ['id' => $old]);
        else Db::insert('fact_proof_reviews', $row + ['proof_id' => $p['id'], 'reviewer_id' => Auth::id(), 'reviewer_kind' => $kind, 'created_at' => $now]);
        Activity::touch((int)$f['project_id'], 'fact', (int)$f['id'], 'review', (int)$p['id']);
        $link = ['view' => 'facts', 'id' => (int)$f['id'], 'query' => ['proof' => (int)$p['id']]];
        if ((int)$p['author_id'] !== Auth::id() && Access::isMember((int)$f['project_id'], (int)$p['author_id'])) {
            Notify::send((int)$p['author_id'], (int)$f['project_id'], 'fact_proof_review', ['link' => $link, 'excerpt' => $f['label'] . ': ' . $verdict]);
        }
        if ($verdict !== 'correct') QuestionController::factChanged((int)$f['project_id'], (int)$f['id'], "A proof of {$f['label']} was reported with " . ($verdict === 'gap' ? 'a gap' : 'an error'));
        Response::json(self::present(Access::fact((int)$f['id'])), $old ? 200 : 201);
    }

    public static function deleteProofReview(Request $r): never
    {
        [$p, $f] = self::proof($r->int('proof'));
        $v = Db::one('SELECT * FROM fact_proof_reviews WHERE id = ? AND proof_id = ?', [$r->int('rid'), $p['id']]);
        if (!$v) throw new HttpError(404, 'Review not found');
        if ((int)$v['reviewer_id'] !== Auth::id()) throw new HttpError(403, 'You can only withdraw your own review.');
        Db::run('DELETE FROM fact_proof_reviews WHERE id = ?', [$v['id']]);
        if ($v['verdict'] === 'correct') QuestionController::factChanged((int)$f['project_id'], (int)$f['id'], "An endorsement of a proof of {$f['label']} was withdrawn");
        Response::json(self::present(Access::fact((int)$f['id'])));
    }

    /** @return array{0: array, 1: array} the proof and its fact, if the caller may see them */
    private static function proof(int $id): array
    {
        $p = Db::one('SELECT * FROM fact_proofs WHERE id = ?', [$id]);
        if (!$p) throw new HttpError(404, 'Proof not found');
        return [$p, Access::fact((int)$p['fact_id'])];
    }

    public static function deleteReview(Request $r): never
    {
        $f = Access::fact($r->int('id'));
        $v = Db::one('SELECT * FROM fact_reviews WHERE id = ? AND fact_id = ?', [$r->int('rid'), $f['id']]);
        if (!$v) throw new HttpError(404, 'Review not found');
        if ((int)$v['reviewer_id'] !== Auth::id()) throw new HttpError(403, 'You can only withdraw your own review.');
        Db::run('DELETE FROM fact_reviews WHERE id = ?', [$v['id']]);
        Db::run("DELETE FROM mentions WHERE source_type = 'fact_review' AND source_id = ?", [$v['id']]);
        if ($v['verdict'] === 'correct') QuestionController::factChanged((int)$f['project_id'], (int)$f['id'], "An endorsement of {$f['label']} was withdrawn");
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

    /** A fact written by the native prover, in a transaction of its own. @return int its id */
    public static function addFact(int $pid, array $it, bool $cited = false): int
    {
        return Db::tx(fn() => self::ingest($pid, $it, [], $cited));
    }

    /** $cited: a cited result written from an outside reference of a proof, which names that reference instead of quoting a source. */
    private static function ingest(int $pid, array $it, array $refs, bool $cited = false): int
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
        $sources = $cited ? [] : self::sources($pid, $it, $method);
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
                if ($row['source_type'] === 'comment' && $covers === 'context') {
                    $row['covers'] = 'context'; // a reader's remark about the result, never the result itself
                    $role = self::s($s, 'role');
                    if (!in_array($role, self::COMMENT_ROLES, true)) throw new HttpError(422, 'A comment cited as context needs a role: supports, disputes or clarifies.');
                    $row['comment_role'] = $role;
                } else {
                    if (!in_array($covers, self::COVERS, true)) throw new HttpError(422, 'Each source of an extracted fact needs covers: statement, proof or both.');
                    $row['covers'] = $covers;
                }
            } else {
                $row['covers'] = 'context'; // a deduced fact can cite sources, but its proof is new
            }
            $row['is_human'] = $row['is_human'] ? 1 : 0;
            $rows[] = $row;
        }
        if ($method === 'extracted' && !array_filter($rows, fn($x) => $x['covers'] !== 'context')) throw new HttpError(422, 'An extracted fact must cite the text it comes from, not only a comment.');
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
            'covers' => 'context', 'comment_role' => null, 'author_user_id' => null, 'author_name' => null, 'author_basis' => null];
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
    public static function presentSources(int $id, int $revision): array
    {
        $out = [];
        foreach (Db::all('SELECT s.*, u.orcid AS author_orcid, u.kind AS author_kind FROM fact_sources s LEFT JOIN users u ON u.id = s.author_user_id
                          WHERE s.fact_id = ? AND s.revision_no = ? ORDER BY s.id', [$id, $revision]) as $s) {
            $item = ['type' => $s['source_type'], 'page' => $s['page'] ? (int)$s['page'] : null, 'quote' => $s['quote'], 'is_human' => (bool)$s['is_human'], 'hidden' => false,
                'covers' => $s['covers'], 'comment_role' => $s['comment_role'] ?? null,
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
                    $item['label'] = (string)(Db::value("SELECT COALESCE(NULLIF(title, ''), cite_key) FROM bib_entries WHERE id = ?", [$sid]) ?: 'Deleted reference');
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

    /** @param ?array $byId the project's graph by id, when the caller already has it */
    public static function present(array $f, ?array $byId = null): array
    {
        $id = (int)$f['id'];
        $pid = (int)$f['project_id'];
        $byId ??= array_column(self::graph($pid)['facts'], null, 'id');
        $out = $byId[$id];
        $brief = fn($x) => ['id' => $x, 'label' => $byId[$x]['label'], 'title' => $byId[$x]['title'], 'kind' => $byId[$x]['kind'], 'display_kind' => $byId[$x]['display_kind'],
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
        $out['outside_refs'] = array_map(fn($x) => $x + ['fact' => $x['fact_id'] !== null && isset($byId[$x['fact_id']]) ? $brief($x['fact_id']) : null], $out['outside_refs']);
        $out['source_checks'] = array_map(function ($c) use ($f) {
            $c['independent'] = !self::sameModel($f, $c['ai_model']);
            $c['current'] = (int)$c['revision_no'] === (int)$f['current_revision'];
            $c['body_text'] = Sanitizer::toText((string)$c['body_html']);
            return $c;
        }, Db::all('SELECT c.*, au.name AS ai_user_name FROM fact_source_checks c LEFT JOIN users au ON au.id = c.ai_user_id WHERE c.fact_id = ? ORDER BY c.id DESC LIMIT 20', [$id]));
        $out['reviews'] = array_map(function ($v) use ($f) {
            $v['independent'] = $v['reviewer_kind'] === 'human' || !self::sameModel($f, $v['ai_model']);
            $v['body_text'] = Sanitizer::toText((string)$v['body_html']);
            return $v;
        }, Db::all('SELECT v.*, u.name AS reviewer_name, au.name AS ai_user_name FROM fact_reviews v JOIN users u ON u.id = v.reviewer_id
                    LEFT JOIN users au ON au.id = v.ai_user_id WHERE v.fact_id = ? ORDER BY v.revision_no DESC, v.updated_at DESC', [$id]));
        $proofReviews = [];
        foreach (Db::all('SELECT v.*, u.name AS reviewer_name, au.name AS ai_user_name FROM fact_proof_reviews v JOIN users u ON u.id = v.reviewer_id LEFT JOIN users au ON au.id = v.ai_user_id
                          JOIN fact_proofs p ON p.id = v.proof_id WHERE p.fact_id = ? ORDER BY v.updated_at DESC', [$id]) as $v) {
            $v['body_text'] = Sanitizer::toText((string)$v['body_html']);
            $proofReviews[(int)$v['proof_id']][] = $v;
        }
        $out['proofs'] = array_map(function ($p) use ($proofReviews) {
            $p['reviews'] = $proofReviews[(int)$p['id']] ?? [];
            $p['body_text'] = Sanitizer::toText((string)$p['body_html']);
            $bad = array_filter($p['reviews'], fn($v) => $v['verdict'] !== 'correct');
            $p['state'] = $bad ? 'flawed' : (array_filter($p['reviews'], fn($v) => $v['reviewer_kind'] === 'human' || mb_strtolower((string)$v['ai_model']) !== mb_strtolower((string)$p['ai_model'])) ? 'accepted' : 'unchecked');
            return $p;
        }, Db::all('SELECT p.*, u.name AS author_name, au.name AS ai_user_name FROM fact_proofs p JOIN users u ON u.id = p.author_id LEFT JOIN users au ON au.id = p.ai_user_id
                    WHERE p.fact_id = ? ORDER BY p.revision_no DESC, p.id', [$id]));
        $out['rephrasings'] = NotationController::forFact($id, $pid, (int)$f['current_revision']);
        // Its history beside its revisions: the consolidation changes applied to it, by people or by the AI on its own, each one undoable.
        $out['history'] = array_map(function ($s) {
            foreach (['id', 'fact_id', 'other_fact_id'] as $k) $s[$k] = $s[$k] === null ? null : (int)$s[$k];
            $s['auto_applied'] = (bool)$s['auto_applied'];
            $s['data'] = json_decode((string)$s['data_json'], true);
            $s['can_undo'] = $s['status'] === 'accepted' && $s['undo_json'] !== null;
            unset($s['data_json'], $s['undo_json']);
            return $s;
        }, Db::all("SELECT s.id, s.kind, s.status, s.fact_id, s.other_fact_id, s.data_json, s.undo_json, s.reason_text, s.confidence, s.auto_applied, s.ai_model,
                           s.decided_at, s.undone_at, d.name AS decided_by_name, ub.name AS undone_by_name, a.label AS fact_label, b.label AS other_label
                    FROM fact_suggestions s LEFT JOIN users d ON d.id = s.decided_by LEFT JOIN users ub ON ub.id = s.undone_by
                    LEFT JOIN facts a ON a.id = s.fact_id LEFT JOIN facts b ON b.id = s.other_fact_id
                    WHERE (s.fact_id = ? OR s.other_fact_id = ?) AND s.status IN ('accepted', 'undone') ORDER BY s.decided_at DESC, s.id DESC LIMIT 100", [$id, $id]));
        $out['worth_reading'] = $f['highlight_at'] ? ['reason' => $f['highlight_reason'], 'at' => $f['highlight_at'], 'model' => $f['highlight_model']] : null;
        // The agreed notation, so that a reader sees the meaning of each symbol the fact uses.
        $out['notation'] = array_map(fn($n) => ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'meaning_html' => $n['meaning_html']],
            Db::all("SELECT id, symbol, meaning_html FROM notations WHERE project_id = ? AND status = 'agreed' ORDER BY id", [$pid]));
        $out['starred_by'] = Db::all('SELECT u.id, u.name FROM fact_stars s JOIN users u ON u.id = s.user_id WHERE s.fact_id = ? ORDER BY s.created_at', [$id]);
        foreach ($out['starred_by'] as &$u) $u['id'] = (int)$u['id'];
        unset($u);
        $out['starred'] = in_array(Auth::id(), array_column($out['starred_by'], 'id'), true);
        $out['lean_proofs'] = Db::all(
            'SELECT l.*, u.name AS created_by_name, c.name AS checked_by_name, au.name AS ai_user_name, cu.name AS check_user_name FROM fact_lean l
             JOIN users u ON u.id = l.created_by LEFT JOIN users c ON c.id = l.checked_by
             LEFT JOIN users au ON au.id = l.ai_user_id LEFT JOIN users cu ON cu.id = l.check_user_id
             WHERE l.fact_id = ? ORDER BY l.revision_no DESC, l.id DESC', [$id]);
        return $out;
    }
}
