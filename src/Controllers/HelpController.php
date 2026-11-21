<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, Request, Response};

/**
 * Live pointers for the help center: real items of the current project that illustrate each
 * article. It returns only what the current user can already see.
 */
final class HelpController
{
    private const SAMPLE = 3;

    public static function context(Request $r): never
    {
        $pid = $r->int('id');
        $role = Access::member($pid);
        $me = Auth::id();
        $project = Db::one('SELECT id, title, status FROM projects WHERE id = ?', [$pid]);
        $state = Activity::unread($pid, $me);
        $conversations = self::conversations($pid, $me, $state['items']['conversation']);
        Response::json([
            'project' => ['id' => (int)$project['id'], 'title' => $project['title'], 'status' => $project['status'], 'role' => $role],
            'me' => ['id' => $me, 'name' => Auth::user()['name'], 'keys' => (int)Db::value('SELECT COUNT(*) FROM user_api_keys WHERE user_id = ? AND revoked_at IS NULL', [$me])],
            'unread' => (object)$state['totals'],
            'questions' => self::questions($pid, $state['items']),
            'facts' => self::facts($pid, $me, $state['items']['fact']),
            'files' => self::files($pid, $state['items']['document']),
            'bib' => self::bibliography($pid),
            'conversations' => $conversations,
            'thread' => self::openThread($pid, $me),
            'people' => self::people($pid),
        ]);
    }

    private static function questions(int $pid, array $unread): array
    {
        $all = QuestionController::summary($pid);
        $brief = fn($q) => ['id' => $q['id'], 'title' => $q['title']];
        $closed = ['solved', 'refuted', 'abandoned'];
        $open = array_values(array_filter($all, fn($q) => !in_array($q['status'], $closed, true)));
        $without = array_values(array_filter($open, fn($q) => !$q['strategies']));
        $blocked = [];
        $strategies = 0;
        foreach ($all as $q) {
            $strategies += count($q['strategies']);
            foreach ($q['strategies'] as $s) if ($s['status'] === 'blocked') $blocked[] = ['id' => $q['id'], 'strategy' => $s['id'], 'title' => $s['title']];
        }
        $new = array_values(array_filter($all, fn($q) => isset($unread['oquestion'][$q['id']])));
        $pending = array_values(array_filter($all, fn($q) => $q['pending_answers'] > 0));
        $risk = array_values(array_filter($all, fn($q) => $q['answer_at_risk']));
        return [
            'total' => count($all), 'big' => count(array_filter($all, fn($q) => $q['parent_id'] === null)), 'open' => count($open), 'strategies' => $strategies,
            'top' => array_map($brief, array_slice(array_values(array_filter($open, fn($q) => $q['parent_id'] === null)), 0, self::SAMPLE)),
            'without_strategy' => array_map($brief, array_slice($without, 0, self::SAMPLE)), 'without_strategy_count' => count($without),
            'pending' => array_map($brief, array_slice($pending, 0, self::SAMPLE)), 'pending_count' => count($pending),
            'at_risk' => array_map($brief, array_slice($risk, 0, self::SAMPLE)),
            'blocked' => array_slice($blocked, 0, self::SAMPLE), 'unread' => array_map($brief, array_slice($new, 0, self::SAMPLE)),
        ];
    }

    private static function facts(int $pid, int $me, array $unread): array
    {
        $all = FactController::graph($pid)['facts'];
        $brief = fn($f) => ['id' => $f['id'], 'label' => $f['label'], 'title' => $f['title']];
        $some = fn(callable $test) => array_map($brief, array_slice(array_values(array_filter($all, $test)), 0, self::SAMPLE));
        $count = fn(callable $test) => count(array_filter($all, $test));
        $reviewed = array_flip(array_map('intval', array_column(Db::all(
            "SELECT v.fact_id FROM fact_reviews v JOIN facts f ON f.id = v.fact_id AND v.revision_no = f.current_revision
             WHERE f.project_id = ? AND v.reviewer_id = ? AND v.reviewer_kind = 'human'", [$pid, $me]), 'fact_id')));
        $open = array_values(array_filter($all, fn($f) => !isset($reviewed[$f['id']]) && !in_array($f['status'], ['retracted'], true)));
        usort($open, fn($a, $b) => (int)($b['status'] === 'unchecked') <=> (int)($a['status'] === 'unchecked') ?: count($b['dependents']) <=> count($a['dependents']) ?: $a['id'] <=> $b['id']);
        $labels = [];
        foreach ($all as $f) foreach ($f['labels'] as $l) $labels[$l] = ($labels[$l] ?? 0) + 1;
        arsort($labels);
        $used = $all;
        usort($used, fn($a, $b) => count($b['dependents']) <=> count($a['dependents']) ?: $a['id'] <=> $b['id']);
        return [
            'total' => count($all),
            'by_status' => (object)array_count_values(array_column($all, 'status')),
            'labels' => (object)$labels,
            'to_review' => array_map($brief, array_slice($open, 0, self::SAMPLE)),
            'to_review_count' => count($open),
            'disputed' => $some(fn($f) => $f['status'] === 'disputed'),
            'retracted' => $some(fn($f) => $f['status'] === 'retracted'),
            'broken' => $some(fn($f) => $f['chain'] === 'broken'),
            'broken_count' => $count(fn($f) => $f['chain'] === 'broken'),
            'human_proofs' => $some(fn($f) => $f['proof_origin'] === 'human'),
            'ai_proofs' => $some(fn($f) => $f['proof_origin'] === 'ai'),
            'endorsed' => $some(fn($f) => (bool)$f['endorsed_by']),
            'lean' => $some(fn($f) => $f['lean'] !== 'none'),
            'danus' => $some(fn($f) => $f['tool'] === 'danus'),
            'counterexamples' => $some(fn($f) => in_array('counterexample', $f['labels'], true)),
            'most_used' => ($used && $used[0]['dependents']) ? $brief($used[0]) + ['used_by' => count($used[0]['dependents'])] : null,
            'unread' => $some(fn($f) => isset($unread[$f['id']])),
        ];
    }

    private static function files(int $pid, array $unread): array
    {
        $rows = Db::all("SELECT d.id, d.title, d.origin, (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS versions
                         FROM documents d WHERE d.project_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id DESC", [$pid]);
        $brief = fn($d) => ['id' => (int)$d['id'], 'title' => $d['title']];
        $first = function (callable $test) use ($rows, $brief) {
            foreach ($rows as $d) if ($test($d)) return $brief($d);
            return null;
        };
        return [
            'total' => count($rows),
            'human' => $first(fn($d) => $d['origin'] === 'human'),
            'ai' => $first(fn($d) => $d['origin'] === 'ai'),
            'versioned' => $first(fn($d) => (int)$d['versions'] > 1),
            'latest' => $rows ? $brief($rows[0]) : null,
            'unread' => $first(fn($d) => isset($unread[(int)$d['id']])),
        ];
    }

    private static function bibliography(int $pid): array
    {
        $rows = Db::all('SELECT id, cite_key, title, pdf_blob_id FROM bib_entries WHERE project_id = ? ORDER BY cite_key', [$pid]);
        $brief = fn($b) => ['id' => (int)$b['id'], 'label' => $b['cite_key'], 'title' => $b['title']];
        $missing = array_values(array_filter($rows, fn($b) => $b['pdf_blob_id'] === null));
        return ['total' => count($rows), 'without_pdf_count' => count($missing), 'without_pdf' => array_map($brief, array_slice($missing, 0, self::SAMPLE)),
            'sample' => $rows ? $brief($rows[0]) : null];
    }

    /** Only the conversations this user takes part in. */
    private static function conversations(int $pid, int $me, array $unread): array
    {
        $rows = Db::all('SELECT c.id, c.subject FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ?
                         WHERE c.project_id = ? ORDER BY c.last_message_at DESC, c.id DESC', [$me, $pid]);
        $brief = fn($c) => ['id' => (int)$c['id'], 'title' => $c['subject']];
        $new = array_values(array_filter($rows, fn($c) => isset($unread[(int)$c['id']])));
        return ['total' => count($rows), 'latest' => $rows ? $brief($rows[0]) : null, 'unread' => array_map($brief, array_slice($new, 0, self::SAMPLE))];
    }

    /** An unresolved comment thread the user can open. */
    private static function openThread(int $pid, int $me): ?array
    {
        $rows = Db::all("SELECT c.id, c.target_type, c.target_id FROM comments c
                         LEFT JOIN conversation_participants p ON c.target_type = 'conversation' AND p.conversation_id = c.target_id AND p.user_id = ?
                         LEFT JOIN documents d ON c.target_type = 'document' AND d.id = c.target_id
                         LEFT JOIN facts f ON c.target_type = 'fact' AND f.id = c.target_id
                         LEFT JOIN open_questions q ON c.target_type = 'oquestion' AND q.id = c.target_id
                         WHERE c.project_id = ? AND c.parent_id IS NULL AND c.resolved = 0
                           AND (c.target_type = 'bib' OR p.user_id IS NOT NULL OR (d.id IS NOT NULL AND d.deleted_at IS NULL) OR (f.id IS NOT NULL AND f.deleted_at IS NULL) OR (q.id IS NOT NULL AND q.deleted_at IS NULL))
                         ORDER BY c.id DESC LIMIT 1", [$me, $pid]);
        if (!$rows) return null;
        $c = $rows[0];
        $views = ['fact' => 'facts', 'document' => 'files', 'bib' => 'bib', 'conversation' => 'conversations', 'oquestion' => 'questions'];
        return ['view' => $views[$c['target_type']], 'id' => (int)$c['target_id'], 'comment' => (int)$c['id']];
    }

    private static function people(int $pid): array
    {
        $rows = Db::all('SELECT u.id, u.name, u.kind, u.ai_model, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name', [$pid]);
        $brief = fn($u) => ['id' => (int)$u['id'], 'title' => $u['name']];
        return [
            'researchers' => count(array_filter($rows, fn($u) => $u['kind'] !== 'agent')),
            'owners' => array_map($brief, array_values(array_filter($rows, fn($u) => $u['role'] === 'owner'))),
            'agents' => array_map(fn($u) => $brief($u) + ['model' => $u['ai_model']], array_values(array_filter($rows, fn($u) => $u['kind'] === 'agent'))),
        ];
    }
}
