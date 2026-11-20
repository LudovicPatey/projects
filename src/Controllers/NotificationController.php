<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Auth, Db, Request, Response};

final class NotificationController
{
    public static function list(Request $r): never
    {
        $rows = Db::all(
            'SELECT n.id, n.project_id, p.title AS project_title, n.kind, n.payload_json, n.created_at, n.read_at
             FROM notifications n JOIN projects p ON p.id = n.project_id
             WHERE n.user_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 100', [Auth::id()]);
        foreach ($rows as &$n) {
            $n['payload'] = json_decode($n['payload_json'], true);
            unset($n['payload_json']);
        }
        $unread = (int)Db::value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', [Auth::id()]);
        Response::json(['notifications' => $rows, 'unread' => $unread]);
    }

    public static function markRead(Request $r): never
    {
        $ids = array_map('intval', (array)$r->input('ids', []));
        if ($ids) {
            [$in, $params] = Db::in($ids);
            Db::run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN $in", array_merge([Db::now(), Auth::id()], $params));
        } else {
            Db::run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [Db::now(), Auth::id()]);
        }
        Response::json(['ok' => true]);
    }

    /** Lightweight polling endpoint: unread counters for the left menu. */
    public static function counters(Request $r): never
    {
        $me = Auth::id();
        $pid = (int)($r->query['project'] ?? 0);
        $conv = 0;
        if ($pid) {
            $conv = (int)Db::value(
                'SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                 JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
                 WHERE c.project_id = ? AND m.author_id <> ? AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)', [$me, $pid, $me]);
        }
        Response::json([
            'notifications' => (int)Db::value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', [$me]),
            'conversations' => $conv,
        ]);
    }
}
