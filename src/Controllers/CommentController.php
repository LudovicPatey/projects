<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, HttpError, Notify, Provenance, Request, Response, Sanitizer};

/**
 * Comment threads (root + replies) attached to a conversation, a document, a
 * bibliography entry or a fact. Root comments may carry an anchor: a text selection in a
 * PDF, or a message (optionally with a quoted passage).
 */
final class CommentController
{
    private const VIEWS = ['conversation' => 'conversations', 'document' => 'files', 'bib' => 'bib', 'fact' => 'facts'];

    public static function list(Request $r): never
    {
        $type = (string)($r->query['type'] ?? '');
        $id = (int)($r->query['id'] ?? 0);
        $pid = Access::commentTarget($type, $id);
        $asText = Auth::isAi() || isset($r->query['text']);
        $rows = Db::all(
            'SELECT c.id, c.parent_id, c.author_id, u.name AS author_name, u.kind AS author_kind, c.ai_model AS author_model, c.ai_user_id, au.name AS ai_user_name, c.ai_generation_ms, c.body_html, c.anchor_json, c.resolved, c.created_at, c.edited_at
             FROM comments c JOIN users u ON u.id = c.author_id LEFT JOIN users au ON au.id = c.ai_user_id
             WHERE c.target_type = ? AND c.target_id = ? ORDER BY c.created_at, c.id', [$type, $id]);
        $threads = []; $replies = [];
        foreach ($rows as $c) {
            $c['anchor'] = $c['anchor_json'] ? json_decode($c['anchor_json'], true) : null;
            $c['resolved'] = (bool)$c['resolved'];
            if ($asText) $c['body_text'] = Sanitizer::toText($c['body_html']);
            unset($c['anchor_json']);
            if ($c['parent_id']) $replies[$c['parent_id']][] = $c; else $threads[] = $c;
        }
        foreach ($threads as &$t) $t['replies'] = $replies[$t['id']] ?? [];
        Response::json(['threads' => $threads, 'last_activity_id' => Activity::latest($pid, $type, $id),
            'fresh_ids' => Activity::freshComments($pid, Auth::id(), $type, $id)]);
    }

    public static function create(Request $r): never
    {
        $type = $r->str('target_type');
        $tid = (int)$r->input('target_id');
        $pid = Access::commentTarget($type, $tid);
        $body = Sanitizer::fromRequest($r, $pid) ?? throw new HttpError(422, 'body_html or body_text is required.');
        if ($body['text'] === '' && !$body['mentions']) throw new HttpError(422, 'The comment is empty.');

        $parentId = (int)$r->input('parent_id') ?: null;
        $anchor = null;
        if ($parentId) {
            $parent = Db::one('SELECT * FROM comments WHERE id = ?', [$parentId]);
            if (!$parent || $parent['target_type'] !== $type || (int)$parent['target_id'] !== $tid) throw new HttpError(422, 'Invalid parent comment');
            if ($parent['parent_id']) $parentId = (int)$parent['parent_id']; // flatten: threads are one level deep
        } elseif (is_array($r->input('anchor'))) {
            $anchor = self::anchor($r->input('anchor'));
        }

        $model = Provenance::agentModel($r);
        $id = Db::insert('comments', Provenance::stamp($model, $r->input('generation_seconds')) + [
            'project_id' => $pid, 'target_type' => $type, 'target_id' => $tid, 'parent_id' => $parentId,
            'author_id' => Auth::id(), 'ai_model' => $model, 'body_html' => $body['html'],
            'anchor_json' => $anchor ? json_encode($anchor, JSON_UNESCAPED_UNICODE) : null, 'created_at' => Db::now(),
        ]);
        Activity::touch($pid, $type, $tid, 'comment', $id);
        $link = ['view' => self::VIEWS[$type], 'id' => $tid, 'comment' => $parentId ?: $id];
        $audience = Access::audience($type, $tid);
        Notify::mentions($pid, 'comment', $id, $body['mentions'], $link, $body['text'], $audience);

        // Notify the other people taking part in the thread.
        if ($parentId) {
            $mentioned = array_column(array_filter($body['mentions'], fn($m) => $m['type'] === 'user'), 'id');
            $people = Db::all('SELECT DISTINCT author_id FROM comments WHERE id = ? OR parent_id = ?', [$parentId, $parentId]);
            foreach (array_map('intval', array_column($people, 'author_id')) as $uid) {
                if ($uid === Auth::id() || in_array($uid, $mentioned, true)) continue;
                if ($audience !== null && !in_array($uid, $audience, true)) continue;
                Notify::send($uid, $pid, 'reply', ['link' => $link, 'excerpt' => $body['text']]);
            }
        }
        Response::json(['id' => $id], 201);
    }

    public static function update(Request $r): never
    {
        $c = Db::one('SELECT * FROM comments WHERE id = ?', [$r->int('id')]);
        if (!$c) throw new HttpError(404, 'Comment not found');
        Access::commentTarget($c['target_type'], (int)$c['target_id']);
        $data = [];
        if ($r->input('resolved') !== null) $data['resolved'] = $r->input('resolved') ? 1 : 0;
        if ($r->input('body_html') !== null || $r->input('body_text') !== null) {
            if ((int)$c['author_id'] !== Auth::id()) throw new HttpError(403, 'You can only edit your own comments.');
            $body = Sanitizer::fromRequest($r, (int)$c['project_id']);
            if ($body['text'] === '' && !$body['mentions']) throw new HttpError(422, 'The comment is empty.');
            $data['body_html'] = $body['html'];
            $data['ai_model'] = Provenance::agentModel($r);
            $data += Provenance::stamp($data['ai_model'], $r->input('generation_seconds'));
            Activity::touch((int)$c['project_id'], $c['target_type'], (int)$c['target_id'], 'comment_edit', (int)$c['id']);
            $data['edited_at'] = Db::now();
            Notify::mentions((int)$c['project_id'], 'comment', (int)$c['id'], $body['mentions'],
                ['view' => self::VIEWS[$c['target_type']], 'id' => (int)$c['target_id'], 'comment' => (int)($c['parent_id'] ?: $c['id'])],
                $body['text'], Access::audience($c['target_type'], (int)$c['target_id']), false);
        }
        if ($data) Db::update('comments', $data, 'id = :id', ['id' => $c['id']]);
        Response::json(['ok' => true]);
    }

    public static function delete(Request $r): never
    {
        $c = Db::one('SELECT * FROM comments WHERE id = ?', [$r->int('id')]);
        if (!$c) throw new HttpError(404, 'Comment not found');
        Access::commentTarget($c['target_type'], (int)$c['target_id']);
        if ((int)$c['author_id'] !== Auth::id()) Access::owner((int)$c['project_id']);
        Db::run('DELETE FROM comments WHERE parent_id = ?', [$c['id']]);
        Db::run('DELETE FROM comments WHERE id = ?', [$c['id']]);
        Db::run("DELETE FROM mentions WHERE source_type = 'comment' AND source_id = ?", [$c['id']]);
        Response::json(['ok' => true]);
    }

    private static function anchor(array $a): ?array
    {
        $out = [];
        foreach (['version_id', 'blob_id', 'message_id', 'page'] as $k) {
            if (isset($a[$k])) $out[$k] = max(0, (int)$a[$k]);
        }
        if (isset($a['quote'])) $out['quote'] = mb_substr(trim((string)$a['quote']), 0, 2000);
        if (isset($a['rects']) && is_array($a['rects'])) {
            $out['rects'] = [];
            foreach (array_slice($a['rects'], 0, 80) as $rect) {
                if (!is_array($rect) || count($rect) !== 4) continue;
                $out['rects'][] = array_map(fn($v) => round(min(1, max(0, (float)$v)), 5), array_values($rect));
            }
        }
        return $out ?: null;
    }
}
