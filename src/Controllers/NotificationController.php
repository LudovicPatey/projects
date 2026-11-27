<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, HttpError, Request, Response};

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
        $state = $pid && Access::role($pid) ? Activity::unread($pid, $me) : ['items' => [], 'totals' => []];
        Response::json([
            'notifications' => (int)Db::value('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', [$me]),
            'conversations' => $state['totals']['conversation'] ?? 0,
            'feedback' => FeedbackController::unseen($me),
            'join_requests' => $pid ? JoinController::pendingFor($pid, $me) : 0,
            'ai_suggestions' => $pid && Access::role($pid) ? (int)Db::value("SELECT COUNT(*) FROM bib_suggestions WHERE project_id = ? AND status = 'proposed'", [$pid]) : 0,
            'totals' => (object)$state['totals'],
            'unread' => (object)array_map(fn($list) => (object)$list, $state['items']),
        ]);
    }

    /** {items: [{type, id, up_to}]}: called by the interface once an item has been displayed. */
    public static function read(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        Activity::markRead($pid, Auth::id(), (array)$r->input('items', []));
        Response::json(['ok' => true]);
    }

    public static function readAll(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        $types = $r->str('type') !== '' ? [$r->str('type')] : Activity::TYPES;
        foreach ($types as $type) {
            if (!in_array($type, Activity::TYPES, true)) throw new HttpError(422, 'Unknown item type.');
            Activity::markAll($pid, Auth::id(), $type);
        }
        Response::json(['ok' => true]);
    }

    public static function unread(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        Activity::markUnread($pid, Auth::id(), $r->str('type'), (int)$r->input('item_id'));
        Response::json(['ok' => true]);
    }
}
