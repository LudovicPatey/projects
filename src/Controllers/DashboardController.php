<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Auth, Db, HttpError, References, Request, Response};

/** The figures and work lists shown on the overview and section pages, limited to what the user can see. */
final class DashboardController
{
    private const FEED = 14;
    private const SAMPLE = 5;
    private const SETTLED = ['solved', 'refuted', 'abandoned'];
    private const FEED_TYPES = ['conversation' => 'conversation', 'fact' => 'fact', 'document' => 'document', 'bib' => 'bib',
        'question' => 'project', 'oquestion' => 'question', 'strategy' => 'strategy', 'member' => 'user'];

    private const SECTIONS = ['questions' => ['oquestion', 'strategy'], 'facts' => ['fact'], 'files' => ['document'], 'bib' => ['bib'], 'conversations' => ['conversation']];

    /** GET ?section=facts : the recent activity of one section. */
    public static function activityFeed(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        $section = self::SECTIONS[(string)($r->query['section'] ?? '')] ?? throw new HttpError(422, 'Unknown section.');
        Response::json(['activity' => self::activity($pid, Auth::id(), $section)]);
    }

    public static function project(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        $me = Auth::id();
        $facts = FactController::graph($pid)['facts'];
        $questions = QuestionController::summary($pid);
        Response::json([
            'questions' => self::questions($questions),
            'facts' => self::facts($facts),
            'files' => self::files($pid),
            'bib' => self::bibliography($pid),
            'conversations' => self::conversations($pid, $me),
            'actions' => self::actions($pid, $me, $questions, $facts),
            'activity' => self::activity($pid, $me),
            'people' => self::people($pid),
        ]);
    }

    private static function questions(array $all): array
    {
        $children = [];
        foreach ($all as $q) if ($q['parent_id']) $children[$q['parent_id']][] = $q;
        $count = function (array $q) use (&$count, $children): array {
            $total = $done = 0;
            foreach ($children[$q['id']] ?? [] as $c) {
                $total++;
                if (in_array($c['status'], self::SETTLED, true)) $done++;
                [$t, $d] = $count($c);
                $total += $t; $done += $d;
            }
            return [$total, $done];
        };
        $byStatus = array_count_values(array_column($all, 'status'));
        $strategies = [];
        foreach ($all as $q) foreach ($q['strategies'] as $s) $strategies[$s['status']] = ($strategies[$s['status']] ?? 0) + 1;
        $rank = ['high' => 0, 'normal' => 1, 'low' => 2];
        $roots = array_values(array_filter($all, fn($q) => $q['parent_id'] === null));
        usort($roots, fn($a, $b) => ($rank[$a['priority']] ?? 1) <=> ($rank[$b['priority']] ?? 1) ?: $a['id'] <=> $b['id']);
        return [
            'total' => count($all), 'big' => count($roots),
            'settled' => count(array_filter($all, fn($q) => in_array($q['status'], self::SETTLED, true))),
            'by_status' => (object)$byStatus, 'strategies' => array_sum($strategies), 'strategy_by_status' => (object)$strategies,
            'roots' => array_map(function ($q) use ($count) {
                [$total, $done] = $count($q);
                return ['id' => $q['id'], 'title' => $q['title'], 'status' => $q['status'], 'priority' => $q['priority'], 'answer' => $q['answer'],
                    'strategies' => count($q['strategies']), 'pending' => $q['pending_answers'], 'total' => $total, 'done' => $done];
            }, array_slice($roots, 0, 8)),
        ];
    }

    private static function facts(array $all): array
    {
        $proofs = array_count_values(array_column($all, 'proof_origin'));
        return ['total' => count($all), 'by_status' => (object)array_count_values(array_column($all, 'status')),
            'by_kind' => (object)array_count_values(array_column($all, 'kind')), 'by_proof' => (object)$proofs,
            'lean' => count(array_filter($all, fn($f) => $f['lean'] !== 'none')),
            'endorsed' => count(array_filter($all, fn($f) => (bool)$f['endorsed_by']))];
    }

    private static function files(int $pid): array
    {
        $rows = Db::all('SELECT d.id, d.title, d.origin, d.ai_model, d.updated_at, u.name AS author,
                                (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS versions
                         FROM documents d JOIN users u ON u.id = d.created_by WHERE d.project_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id DESC', [$pid]);
        foreach ($rows as &$d) { $d['id'] = (int)$d['id']; $d['versions'] = (int)$d['versions']; }
        unset($d);
        return ['total' => count($rows), 'human' => count(array_filter($rows, fn($d) => $d['origin'] === 'human')), 'ai' => count(array_filter($rows, fn($d) => $d['origin'] === 'ai')),
            'versions' => array_sum(array_column($rows, 'versions')), 'recent' => array_slice($rows, 0, self::SAMPLE)];
    }

    private static function bibliography(int $pid): array
    {
        $rows = Db::all('SELECT id, cite_key, title, authors, year, pdf_blob_id, updated_at FROM bib_entries WHERE project_id = ? ORDER BY updated_at DESC, id DESC', [$pid]);
        $years = [];
        foreach ($rows as $b) if ($b['year']) $years[(string)$b['year']] = ($years[(string)$b['year']] ?? 0) + 1;
        ksort($years);
        return ['total' => count($rows), 'with_pdf' => count(array_filter($rows, fn($b) => $b['pdf_blob_id'] !== null)),
            'years' => array_map(fn($y, $n) => ['year' => (string)$y, 'n' => $n], array_keys($years), $years),
            'recent' => array_map(fn($b) => ['id' => (int)$b['id'], 'cite_key' => $b['cite_key'], 'title' => $b['title'], 'authors' => $b['authors'], 'year' => $b['year'], 'has_pdf' => $b['pdf_blob_id'] !== null], array_slice($rows, 0, self::SAMPLE))];
    }

    /** Only the conversations this user takes part in. */
    private static function conversations(int $pid, int $me): array
    {
        $rows = Db::all('SELECT c.id, c.subject, c.last_message_at, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messages,
                                (SELECT COUNT(*) FROM conversation_participants x WHERE x.conversation_id = c.id) AS people
                         FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ?
                         WHERE c.project_id = ? ORDER BY c.last_message_at DESC, c.id DESC', [$me, $pid]);
        foreach ($rows as &$c) { $c['id'] = (int)$c['id']; $c['messages'] = (int)$c['messages']; $c['people'] = (int)$c['people']; }
        unset($c);
        return ['total' => count($rows), 'messages' => array_sum(array_column($rows, 'messages')), 'recent' => array_slice($rows, 0, self::SAMPLE)];
    }

    /** What this person could do now, most urgent first. */
    private static function actions(int $pid, int $me, array $questions, array $facts): array
    {
        $out = [];
        foreach ($questions as $q) {
            if ($q['answer_at_risk']) $out[] = ['kind' => 'at_risk', 'ref' => 'question:' . $q['id'], 'title' => $q['title'], 'link' => ['view' => 'questions', 'id' => $q['id']]];
        }
        foreach ($questions as $q) {
            if ($q['pending_answers']) $out[] = ['kind' => 'ratify', 'ref' => 'question:' . $q['id'], 'title' => $q['title'], 'link' => ['view' => 'questions', 'id' => $q['id']]];
        }
        foreach ($facts as $f) {
            if ($f['status'] === 'disputed') $out[] = ['kind' => 'disputed', 'ref' => 'fact:' . $f['id'], 'title' => $f['title'], 'code' => $f['label'], 'link' => ['view' => 'facts', 'id' => $f['id']]];
        }
        $reviewed = array_flip(array_map('intval', array_column(Db::all(
            "SELECT v.fact_id FROM fact_reviews v JOIN facts f ON f.id = v.fact_id AND v.revision_no = f.current_revision
             WHERE f.project_id = ? AND v.reviewer_id = ? AND v.reviewer_kind = 'human'", [$pid, $me]), 'fact_id')));
        $todo = array_filter($facts, fn($f) => !isset($reviewed[$f['id']]) && in_array($f['status'], ['unchecked', 'ai_checked'], true));
        usort($todo, fn($a, $b) => count($b['dependents']) <=> count($a['dependents']) ?: $a['id'] <=> $b['id']);
        foreach (array_slice($todo, 0, 3) as $f) $out[] = ['kind' => 'review', 'ref' => 'fact:' . $f['id'], 'title' => $f['title'], 'code' => $f['label'], 'link' => ['view' => 'facts', 'id' => $f['id']]];
        foreach ($questions as $q) {
            if (!$q['strategies'] && !$q['answer'] && !in_array($q['status'], self::SETTLED, true)) {
                $out[] = ['kind' => 'strategy', 'ref' => 'question:' . $q['id'], 'title' => $q['title'], 'link' => ['view' => 'questions', 'id' => $q['id']]];
                break;
            }
        }
        return array_slice($out, 0, 7);
    }

    /** Recent events on items this user can see. Private conversations of others never appear. */
    private static function activity(int $pid, int $me, ?array $only = null): array
    {
        [$in, $types] = Db::in($only ?? array_keys(self::FEED_TYPES));
        $rows = Db::all("SELECT a.id, a.item_type, a.item_id, a.kind, a.actor_id, a.created_at, u.name AS actor, u.kind AS actor_kind
                         FROM activity a LEFT JOIN users u ON u.id = a.actor_id WHERE a.project_id = ? AND a.item_type IN $in ORDER BY a.id DESC LIMIT 120", array_merge([$pid], $types));
        $keys = [];
        foreach ($rows as $a) if (isset(self::FEED_TYPES[$a['item_type']])) $keys[] = self::FEED_TYPES[$a['item_type']] . ':' . $a['item_id'];
        $refs = References::resolve($pid, $me, $keys);
        $out = [];
        $seen = [];
        foreach ($rows as $a) {
            $type = self::FEED_TYPES[$a['item_type']] ?? null;
            $ref = $type ? ($refs["$type:{$a['item_id']}"] ?? null) : null;
            if (!$ref || $ref['state'] !== 'ok') continue;
            $once = "{$a['actor_id']}|{$a['kind']}|{$ref['key']}"; // repeated edits make one line
            if (isset($seen[$once])) continue;
            $seen[$once] = true;
            $out[] = ['id' => (int)$a['id'], 'kind' => $a['kind'], 'at' => $a['created_at'], 'actor' => $a['actor_id'] ? ['id' => (int)$a['actor_id'], 'name' => $a['actor'], 'kind' => $a['actor_kind']] : null,
                'ref' => array_intersect_key($ref, array_flip(['type', 'id', 'key', 'label', 'title', 'status', 'link']))];
            if (count($out) >= self::FEED) break;
        }
        return $out;
    }

    /** Contributions everyone can see. Messages in private conversations are not counted. */
    private static function people(int $pid): array
    {
        $count = function (string $sql) use ($pid) {
            return array_column(Db::all($sql, [$pid]), 'n', 'uid');
        };
        $facts = $count('SELECT created_by AS uid, COUNT(*) AS n FROM facts WHERE project_id = ? AND deleted_at IS NULL GROUP BY created_by');
        $reviews = $count('SELECT v.reviewer_id AS uid, COUNT(*) AS n FROM fact_reviews v JOIN facts f ON f.id = v.fact_id WHERE f.project_id = ? AND f.deleted_at IS NULL GROUP BY v.reviewer_id');
        $questions = $count('SELECT created_by AS uid, COUNT(*) AS n FROM open_questions WHERE project_id = ? AND deleted_at IS NULL GROUP BY created_by');
        $strategies = $count('SELECT r.author_id AS uid, COUNT(DISTINCT r.strategy_id) AS n FROM strategy_revisions r JOIN proof_strategies s ON s.id = r.strategy_id WHERE s.project_id = ? AND s.deleted_at IS NULL GROUP BY r.author_id');
        $files = $count('SELECT created_by AS uid, COUNT(*) AS n FROM documents WHERE project_id = ? AND deleted_at IS NULL GROUP BY created_by');
        $out = [];
        foreach (ProjectController::members($pid) as $m) {
            $id = (int)$m['id'];
            $out[$id] = ['facts' => (int)($facts[$id] ?? 0), 'reviews' => (int)($reviews[$id] ?? 0), 'questions' => (int)($questions[$id] ?? 0),
                'strategies' => (int)($strategies[$id] ?? 0), 'files' => (int)($files[$id] ?? 0)];
        }
        return $out ?: [];
    }
}
