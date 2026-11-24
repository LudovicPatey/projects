<?php
declare(strict_types=1);

namespace App;

use App\Controllers\{FactController, SearchController};

/**
 * The reference system of rich text: any object of a project can be cited as @{type:id}.
 * A stored chip holds only a safe label. Titles are resolved when it is displayed, for the
 * person reading it, so a citation never reveals a private conversation to a non-participant.
 * TO ADD A TYPE: add it to TYPES, write its loader in load() and its ids in allIds().
 */
final class References
{
    public const TYPES = ['user', 'project', 'question', 'strategy', 'revision', 'answer', 'fact', 'review', 'proof', 'notation', 'lean',
        'document', 'version', 'bib', 'suggestion', 'conversation', 'message', 'comment', 'aitask'];
    /** Their stored label is generic, and a reader without access cannot tell whether they exist. */
    public const PRIVATE = ['conversation', 'message', 'comment', 'aitask'];
    private const COMMENT_TARGETS = ['oquestion' => 'question', 'strategy' => 'strategy', 'fact' => 'fact', 'document' => 'document', 'bib' => 'bib', 'conversation' => 'conversation'];
    private const MAX_RESOLVE = 200;
    private const PER_TYPE = 5;

    public static function safeLabel(string $type, int $id, string $label): string
    {
        return in_array($type, self::PRIVATE, true) ? "$type #$id" : mb_substr($label, 0, 200);
    }

    /** @param list<string> $keys like "fact:3". @return array<string, array> what this user may see of each. */
    public static function resolve(int $pid, int $uid, array $keys): array
    {
        $wanted = [];
        foreach (array_slice(array_values(array_unique($keys)), 0, self::MAX_RESOLVE) as $key) {
            if (!is_string($key) || !preg_match('/^([a-z]+):(\d{1,10})$/', $key, $m) || !in_array($m[1], self::TYPES, true)) continue;
            $wanted[$m[1]][] = (int)$m[2];
        }
        $out = [];
        foreach ($wanted as $type => $ids) {
            $items = self::load($pid, $uid, $type, $ids);
            foreach ($ids as $id) {
                $out["$type:$id"] = isset($items[$id]) ? self::publicItem($items[$id]) : self::unavailable($type, $id);
            }
        }
        return $out;
    }

    /** Objects matching the query, by type, among what this user can see. */
    public static function search(int $pid, int $uid, string $query, ?string $only = null): array
    {
        $terms = preg_split('/\s+/u', SearchController::fold(trim($query)), -1, PREG_SPLIT_NO_EMPTY) ?: [];
        $limit = $only ? 25 : self::PER_TYPE;
        $out = [];
        foreach ($only ? [$only] : self::TYPES as $type) {
            $n = 0;
            foreach (self::load($pid, $uid, $type, self::allIds($pid, $type)) as $item) {
                $hay = SearchController::fold(implode(' ', [$item['label'], $item['title'], $item['subtitle'], $item['text'] ?? '']));
                foreach ($terms as $t) if (!str_contains($hay, $t)) continue 2;
                $out[] = self::publicItem($item);
                if (++$n >= $limit) break;
            }
        }
        return $out;
    }

    private static function publicItem(array $item): array
    {
        unset($item['text']);
        return $item;
    }

    private static function unavailable(string $type, int $id): array
    {
        $private = in_array($type, self::PRIVATE, true);
        return ['type' => $type, 'id' => $id, 'key' => "$type:$id", 'state' => $private ? 'private' : 'missing',
            'label' => $private ? 'Private ' . $type : 'Deleted ' . $type, 'title' => '', 'subtitle' => '', 'status' => null, 'excerpt' => '', 'by' => null, 'ai_model' => null, 'at' => null, 'link' => null];
    }

    private static function item(string $type, int $id, string $label, string $title, string $subtitle, ?string $status, string $text, ?string $by, ?string $model, ?string $at, array $link): array
    {
        return ['type' => $type, 'id' => $id, 'key' => "$type:$id", 'state' => 'ok', 'label' => $label, 'title' => $title, 'subtitle' => $subtitle,
            'status' => $status, 'excerpt' => self::shorten($text), 'text' => $text, 'by' => $by, 'ai_model' => $model, 'at' => $at, 'link' => $link];
    }

    private static function shorten(string $text): string
    {
        $text = trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
        if (mb_strlen($text) <= 220) return $text;
        $cut = mb_substr($text, 0, 220);
        if (substr_count($cut, '$') % 2 === 1) $cut = mb_substr($cut, 0, (int)mb_strrpos($cut, '$'));
        return rtrim($cut) . '…';
    }

    private static function plain(?string $html): string
    {
        return $html ? Sanitizer::toText($html) : '';
    }

    private static function allIds(int $pid, string $type): array
    {
        $sql = match ($type) {
            'user' => 'SELECT user_id AS id FROM project_members WHERE project_id = ?',
            'project' => 'SELECT id FROM projects WHERE id = ?',
            'question' => 'SELECT id FROM open_questions WHERE project_id = ? AND deleted_at IS NULL',
            'strategy' => 'SELECT id FROM proof_strategies WHERE project_id = ? AND deleted_at IS NULL',
            'revision' => 'SELECT r.id FROM strategy_revisions r JOIN proof_strategies s ON s.id = r.strategy_id WHERE s.project_id = ? AND s.deleted_at IS NULL',
            'answer' => 'SELECT id FROM question_answers WHERE project_id = ?',
            'fact' => 'SELECT id FROM facts WHERE project_id = ? AND deleted_at IS NULL',
            'review' => 'SELECT v.id FROM fact_reviews v JOIN facts f ON f.id = v.fact_id WHERE f.project_id = ? AND f.deleted_at IS NULL',
            'proof' => 'SELECT p.id FROM fact_proofs p JOIN facts f ON f.id = p.fact_id WHERE f.project_id = ? AND f.deleted_at IS NULL',
            'notation' => 'SELECT id FROM notations WHERE project_id = ?',
            'lean' => 'SELECT l.id FROM fact_lean l JOIN facts f ON f.id = l.fact_id WHERE f.project_id = ? AND f.deleted_at IS NULL',
            'document' => 'SELECT id FROM documents WHERE project_id = ? AND deleted_at IS NULL',
            'version' => 'SELECT v.id FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.project_id = ? AND d.deleted_at IS NULL',
            'bib' => 'SELECT id FROM bib_entries WHERE project_id = ?',
            'suggestion' => 'SELECT id FROM bib_suggestions WHERE project_id = ?',
            'aitask' => 'SELECT id FROM ai_tasks WHERE project_id = ?',
            'conversation' => 'SELECT id FROM conversations WHERE project_id = ?',
            'message' => 'SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.project_id = ?',
            'comment' => 'SELECT id FROM comments WHERE project_id = ?',
        };
        return array_map('intval', array_column(Db::all($sql . ' ORDER BY 1 DESC LIMIT 400', [$pid]), 'id'));
    }

    /** @return array<int, array> the items of this type that exist in the project and are visible to the user. */
    private static function load(int $pid, int $uid, string $type, array $ids): array
    {
        if (!$ids) return [];
        [$in, $p] = Db::in($ids);
        $q = fn(string $link, array $extra = []) => Db::all($link, array_merge($extra, [$pid], $p));
        $out = [];
        switch ($type) {
            case 'user':
                foreach ($q("SELECT u.id, u.name, u.kind, u.affiliation, u.ai_model, m.role, m.joined_at FROM users u JOIN project_members m ON m.user_id = u.id WHERE m.project_id = ? AND u.id IN $in") as $r) {
                    $agent = $r['kind'] === 'agent';
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $r['name'], $r['name'], $agent ? 'AI agent' : ucfirst($r['role']), $agent ? 'agent' : $r['role'],
                        (string)($agent ? $r['ai_model'] : $r['affiliation']), null, $agent ? $r['ai_model'] : null, $r['joined_at'], ['view' => 'members', 'query' => ['user' => (int)$r['id']]]);
                }
                break;
            case 'project':
                if (in_array($pid, $ids, true)) {
                    $r = Db::one('SELECT title, status, question_html, updated_at FROM projects WHERE id = ?', [$pid]);
                    if ($r) $out[$pid] = self::item($type, $pid, $r['title'], $r['title'], 'This project', $r['status'], self::plain($r['question_html']), null, null, $r['updated_at'], ['view' => 'overview']);
                }
                break;
            case 'question':
                foreach ($q("SELECT q.id, q.title, q.status, q.statement_html, q.ai_model, q.updated_at, u.name AS by_name FROM open_questions q JOIN users u ON u.id = q.created_by WHERE q.project_id = ? AND q.deleted_at IS NULL AND q.id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $r['title'], $r['title'], 'Question', $r['status'], self::plain($r['statement_html']), $r['by_name'], $r['ai_model'], $r['updated_at'], ['view' => 'questions', 'id' => (int)$r['id']]);
                }
                break;
            case 'strategy':
                foreach ($q("SELECT s.id, s.title, s.status, s.question_id, s.current_revision, s.updated_at, q.title AS question, r.body_html, r.ai_model, u.name AS by_name
                             FROM proof_strategies s JOIN open_questions q ON q.id = s.question_id JOIN strategy_revisions r ON r.strategy_id = s.id AND r.revision_no = s.current_revision JOIN users u ON u.id = r.author_id
                             WHERE s.project_id = ? AND s.deleted_at IS NULL AND q.deleted_at IS NULL AND s.id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $r['title'], $r['title'], 'Strategy for ' . $r['question'], $r['status'], self::plain($r['body_html']), $r['by_name'], $r['ai_model'], $r['updated_at'],
                        ['view' => 'questions', 'id' => (int)$r['question_id'], 'query' => ['strategy' => (int)$r['id']]]);
                }
                break;
            case 'revision':
                foreach ($q("SELECT r.id, r.revision_no, r.title, r.status, r.body_html, r.change_note, r.ai_model, r.created_at, r.strategy_id, s.question_id, u.name AS by_name
                             FROM strategy_revisions r JOIN proof_strategies s ON s.id = r.strategy_id JOIN open_questions q ON q.id = s.question_id JOIN users u ON u.id = r.author_id
                             WHERE s.project_id = ? AND s.deleted_at IS NULL AND q.deleted_at IS NULL AND r.id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], "{$r['title']} v{$r['revision_no']}", $r['title'], "Version {$r['revision_no']}: {$r['change_note']}", $r['status'], self::plain($r['body_html']), $r['by_name'], $r['ai_model'], $r['created_at'],
                        ['view' => 'questions', 'id' => (int)$r['question_id'], 'query' => ['strategy' => (int)$r['strategy_id'], 'rev' => (int)$r['revision_no']]]);
                }
                break;
            case 'answer':
                foreach ($q("SELECT a.id, a.answer, a.state, a.rationale_html, a.ai_model, a.created_at, a.question_id, q.title AS question, f.label AS fact, u.name AS by_name
                             FROM question_answers a JOIN open_questions q ON q.id = a.question_id JOIN facts f ON f.id = a.fact_id JOIN users u ON u.id = a.proposed_by
                             WHERE a.project_id = ? AND q.deleted_at IS NULL AND a.id IN $in") as $r) {
                    $kind = ucfirst($r['answer']) . ' answer';
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], "$kind: {$r['fact']}", $kind . ' to ' . $r['question'], "Backed by {$r['fact']}", $r['state'], self::plain($r['rationale_html']), $r['by_name'], $r['ai_model'], $r['created_at'],
                        ['view' => 'questions', 'id' => (int)$r['question_id'], 'query' => ['answer' => (int)$r['id']]]);
                }
                break;
            case 'fact':
                $graph = array_column(FactController::graph($pid)['facts'], null, 'id');
                foreach ($ids as $id) {
                    if (!isset($graph[$id])) continue;
                    $f = $graph[$id];
                    $out[$id] = self::item($type, $id, $f['label'], $f['title'], ucfirst($f['display_kind']), $f['status'], (string)$f['statement_text'], null, $f['ai_model'], $f['updated_at'] ?? null, ['view' => 'facts', 'id' => $id]);
                }
                break;
            case 'review':
                foreach ($q("SELECT v.id, v.verdict, v.body_html, v.ai_model, v.updated_at, v.revision_no, f.id AS fact_id, f.label, u.name AS by_name
                             FROM fact_reviews v JOIN facts f ON f.id = v.fact_id JOIN users u ON u.id = v.reviewer_id WHERE f.project_id = ? AND f.deleted_at IS NULL AND v.id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], "Review of {$r['label']}", "Review of {$r['label']}", "By {$r['by_name']}, revision {$r['revision_no']}", $r['verdict'], self::plain($r['body_html']), $r['by_name'], $r['ai_model'], $r['updated_at'],
                        ['view' => 'facts', 'id' => (int)$r['fact_id'], 'query' => ['tab' => 'reviews']]);
                }
                break;
            case 'proof':
                foreach ($q("SELECT p.id, p.body_html, p.ai_model, p.updated_at, p.revision_no, f.id AS fact_id, f.label, u.name AS by_name
                             FROM fact_proofs p JOIN facts f ON f.id = p.fact_id JOIN users u ON u.id = p.author_id WHERE f.project_id = ? AND f.deleted_at IS NULL AND p.id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], "Proof of {$r['label']}", "Another proof of {$r['label']}", "By {$r['by_name']}, revision {$r['revision_no']}", null, self::plain($r['body_html']), $r['by_name'], $r['ai_model'], $r['updated_at'],
                        ['view' => 'facts', 'id' => (int)$r['fact_id'], 'query' => ['proof' => (int)$r['id']]]);
                }
                break;
            case 'notation':
                foreach ($q("SELECT n.id, n.symbol, n.meaning_html, n.status, n.ai_model, n.updated_at, u.name AS by_name FROM notations n JOIN users u ON u.id = n.author_id WHERE n.project_id = ? AND n.id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $r['symbol'], 'Notation ' . $r['symbol'], ucfirst($r['status']) . ' notation', $r['status'], self::plain($r['meaning_html']), $r['by_name'], $r['ai_model'], $r['updated_at'],
                        ['view' => 'facts', 'query' => ['mode' => 'notation', 'notation' => (int)$r['id']]]);
                }
                break;
            case 'lean':
                foreach ($q("SELECT l.id, l.decl_name, l.check_status, l.incomplete, l.ai_model, l.created_at, l.code, f.id AS fact_id, f.label
                             FROM fact_lean l JOIN facts f ON f.id = l.fact_id WHERE f.project_id = ? AND f.deleted_at IS NULL AND l.id IN $in") as $r) {
                    $name = $r['decl_name'] ?: "Lean proof of {$r['label']}";
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $name, $name, "Lean proof of {$r['label']}", $r['incomplete'] ? 'incomplete' : $r['check_status'], mb_substr((string)$r['code'], 0, 400), null, $r['ai_model'], $r['created_at'],
                        ['view' => 'facts', 'id' => (int)$r['fact_id'], 'query' => ['tab' => 'lean']]);
                }
                break;
            case 'document':
                foreach ($q("SELECT d.id, d.title, d.description, d.origin, d.ai_model, d.updated_at, u.name AS by_name FROM documents d JOIN users u ON u.id = d.created_by WHERE d.project_id = ? AND d.deleted_at IS NULL AND d.id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $r['title'], $r['title'], $r['origin'] === 'ai' ? 'AI-written file' : 'Human-written file', $r['origin'], (string)$r['description'], $r['by_name'], $r['ai_model'], $r['updated_at'], ['view' => 'files', 'id' => (int)$r['id']]);
                }
                break;
            case 'version':
                foreach ($q("SELECT v.id, v.version_no, v.notes, v.ai_model, v.created_at, d.id AS doc, d.title, d.origin, u.name AS by_name FROM document_versions v JOIN documents d ON d.id = v.document_id JOIN users u ON u.id = v.uploaded_by
                             WHERE d.project_id = ? AND d.deleted_at IS NULL AND v.id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], "{$r['title']} v{$r['version_no']}", $r['title'], "Version {$r['version_no']}", $r['origin'], (string)$r['notes'], $r['by_name'], $r['ai_model'], $r['created_at'], ['view' => 'files', 'id' => (int)$r['doc'], 'query' => ['v' => (int)$r['id']]]);
                }
                break;
            case 'bib':
                foreach ($q("SELECT id, cite_key, title, authors, year, venue, ai_model, updated_at FROM bib_entries WHERE project_id = ? AND id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $r['title'] ?: $r['cite_key'], $r['title'], implode(' · ', array_filter([$r['cite_key'], trim($r['authors'] . ($r['year'] ? " ({$r['year']})" : ''))])), null, (string)$r['venue'], null, $r['ai_model'], $r['updated_at'], ['view' => 'bib', 'id' => (int)$r['id']]);
                }
                break;
            case 'suggestion':
                foreach ($q("SELECT id, title, authors, year, status, reason_text, ai_model, created_at FROM bib_suggestions WHERE project_id = ? AND id IN $in") as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $r['title'], $r['title'], trim((string)$r['authors'] . ($r['year'] ? " ({$r['year']})" : '')), $r['status'] === 'proposed' ? 'suggested' : $r['status'], (string)$r['reason_text'], null, $r['ai_model'], $r['created_at'], ['view' => 'ai', 'query' => ['suggestion' => (int)$r['id']]]);
                }
                break;
            case 'aitask':
                foreach (Db::all("SELECT t.id, t.kind, t.status, t.summary_text, t.ai_model, t.updated_at, u.name AS who FROM ai_tasks t LEFT JOIN users u ON u.id = t.requested_by
                                  WHERE t.project_id = ? AND t.id IN $in AND (t.conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = t.conversation_id AND cp.user_id = ?))", array_merge([$pid], $p, [$uid])) as $r) {
                    $name = ['extract' => 'Fact extraction', 'ask' => 'Question to AI', 'bib' => 'Reference search', 'derive' => 'Proof search'][$r['kind']] ?? 'AI task';
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], "$name #{$r['id']}", $name, 'AI task', 'task_' . $r['status'], (string)$r['summary_text'], $r['who'], $r['ai_model'], $r['updated_at'], ['view' => 'ai', 'id' => (int)$r['id']]);
                }
                break;
            case 'conversation':
                foreach ($q("SELECT c.id, c.subject, c.last_message_at FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ? WHERE c.project_id = ? AND c.id IN $in", [$uid]) as $r) {
                    $names = array_column(Db::all('SELECT u.name FROM conversation_participants p JOIN users u ON u.id = p.user_id WHERE p.conversation_id = ? ORDER BY u.name', [$r['id']]), 'name');
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], $r['subject'], $r['subject'], 'Conversation', null, implode(', ', $names), null, null, $r['last_message_at'], ['view' => 'conversations', 'id' => (int)$r['id']]);
                }
                break;
            case 'message':
                foreach ($q("SELECT m.id, m.body_html, m.ai_model, m.created_at, c.id AS conv, c.subject, u.name AS by_name FROM messages m JOIN conversations c ON c.id = m.conversation_id
                             JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ? JOIN users u ON u.id = m.author_id WHERE c.project_id = ? AND m.id IN $in", [$uid]) as $r) {
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], "{$r['by_name']} in {$r['subject']}", "Message in {$r['subject']}", "By {$r['by_name']}", null, self::plain($r['body_html']), $r['by_name'], $r['ai_model'], $r['created_at'],
                        ['view' => 'conversations', 'id' => (int)$r['conv'], 'query' => ['message' => (int)$r['id']]]);
                }
                break;
            case 'comment':
                $rows = $q("SELECT c.id, c.parent_id, c.target_type, c.target_id, c.body_html, c.ai_model, c.created_at, u.name AS by_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.project_id = ? AND c.id IN $in");
                $targets = [];
                foreach ($rows as $r) if (isset(self::COMMENT_TARGETS[$r['target_type']])) $targets[self::COMMENT_TARGETS[$r['target_type']]][] = (int)$r['target_id'];
                $seen = [];
                foreach ($targets as $t => $list) $seen[$t] = self::load($pid, $uid, $t, array_values(array_unique($list)));
                foreach ($rows as $r) {
                    $t = self::COMMENT_TARGETS[$r['target_type']] ?? null;
                    $target = $t ? ($seen[$t][(int)$r['target_id']] ?? null) : null;
                    if (!$target) continue; // the thread's target is hidden from this user, or deleted
                    $link = $target['link'];
                    $link['query'] = ($link['query'] ?? []) + ['comment' => (int)($r['parent_id'] ?: $r['id'])];
                    $out[(int)$r['id']] = self::item($type, (int)$r['id'], "{$r['by_name']} on {$target['label']}", 'Comment on ' . $target['label'], "By {$r['by_name']}", null, self::plain($r['body_html']), $r['by_name'], $r['ai_model'], $r['created_at'], $link);
                }
                break;
        }
        return $out;
    }
}
