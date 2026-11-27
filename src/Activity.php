<?php
declare(strict_types=1);

namespace App;

/**
 * Per-user read state. Every change to an item appends to an ordered event log, and each
 * user has a mark per item. Ids are used instead of timestamps so that two events in the
 * same second cannot be confused. A mark with item_id = 0 covers a whole item type.
 */
final class Activity
{
    public const TYPES = ['conversation', 'fact', 'document', 'bib', 'question', 'oquestion', 'strategy', 'member'];

    /** Work done by a user's AI client stays "new" for that user: they have not read it yet. */
    public static function touch(int $pid, string $type, int $id, string $kind, ?int $ref = null): void
    {
        Db::insert('activity', [
            'project_id' => $pid, 'item_type' => $type, 'item_id' => $id,
            'actor_id' => Auth::isClient() ? null : Auth::id(), 'kind' => $kind, 'ref_id' => $ref, 'created_at' => Db::now(),
        ]);
    }

    public static function latest(int $pid, string $type, int $id): int
    {
        return (int)Db::value('SELECT COALESCE(MAX(id), 0) FROM activity WHERE project_id = ? AND item_type = ? AND item_id = ?', [$pid, $type, $id]);
    }

    /** A new member starts with everything that already exists marked as read. */
    public static function joined(int $pid, int $uid): void
    {
        $max = (int)Db::value('SELECT COALESCE(MAX(id), 0) FROM activity WHERE project_id = ?', [$pid]);
        foreach (self::TYPES as $type) self::setMark($uid, $pid, $type, 0, $max);
        // Whole-project conversations include whoever joins, as they include the members already there.
        Access::syncProjectConversations($pid, $uid);
    }

    /** @return array{items: array<string, array<int,int>>, totals: array<string,int>} */
    public static function unread(int $pid, int $uid): array
    {
        $visible = self::visible($pid, $uid);
        $items = array_fill_keys(self::TYPES, []);
        $rows = Db::all(
            'SELECT a.item_type, a.item_id, COUNT(*) AS n
             FROM activity a
             LEFT JOIN read_marks m ON m.user_id = ? AND m.project_id = a.project_id AND m.item_type = a.item_type AND m.item_id = a.item_id
             LEFT JOIN read_marks f ON f.user_id = ? AND f.project_id = a.project_id AND f.item_type = a.item_type AND f.item_id = 0
             WHERE a.project_id = ? AND (a.actor_id IS NULL OR a.actor_id <> ?)
               AND a.id > COALESCE(m.activity_id, 0) AND a.id > COALESCE(f.activity_id, 0)
             GROUP BY a.item_type, a.item_id', [$uid, $uid, $pid, $uid]);
        foreach ($rows as $r) {
            if (isset($visible[$r['item_type']][(int)$r['item_id']])) $items[$r['item_type']][(int)$r['item_id']] = (int)$r['n'];
        }
        foreach (Db::all('SELECT item_type, item_id FROM read_marks WHERE user_id = ? AND project_id = ? AND forced_unread = 1', [$uid, $pid]) as $r) {
            if (isset($visible[$r['item_type']][(int)$r['item_id']])) {
                $items[$r['item_type']][(int)$r['item_id']] = max(1, $items[$r['item_type']][(int)$r['item_id']] ?? 0);
            }
        }
        $totals = [];
        foreach ($items as $type => $list) {
            // Mail counts new messages and comments, like a mail app. The other views count items.
            $totals[$type] = $type === 'conversation' ? array_sum($list) : count($list);
        }
        return ['items' => $items, 'totals' => $totals];
    }

    public static function total(int $pid, int $uid): int
    {
        return array_sum(self::unread($pid, $uid)['totals']);
    }

    /** Comments of an item that are new for this user. */
    public static function freshComments(int $pid, int $uid, string $type, int $id): array
    {
        $floor = (int)Db::value('SELECT COALESCE(MAX(activity_id), 0) FROM read_marks WHERE user_id = ? AND project_id = ? AND item_type = ? AND item_id IN (0, ?)', [$uid, $pid, $type, $id]);
        return array_map('intval', array_column(Db::all(
            "SELECT DISTINCT ref_id FROM activity WHERE project_id = ? AND item_type = ? AND item_id = ? AND id > ?
             AND kind IN ('comment', 'comment_edit') AND ref_id IS NOT NULL AND (actor_id IS NULL OR actor_id <> ?)",
            [$pid, $type, $id, $floor, $uid]), 'ref_id'));
    }

    /** @param list<array{type:string,id:int,up_to?:int}> $items */
    public static function markRead(int $pid, int $uid, array $items): void
    {
        $visible = self::visible($pid, $uid);
        foreach ($items as $it) {
            if (!is_array($it)) continue;
            $type = (string)($it['type'] ?? '');
            $id = (int)($it['id'] ?? 0);
            if (!isset($visible[$type][$id])) continue;
            $latest = self::latest($pid, $type, $id);
            // Never mark as read something that arrived after the user's page was loaded.
            $upTo = isset($it['up_to']) ? min(max(0, (int)$it['up_to']), $latest) : $latest;
            self::setMark($uid, $pid, $type, $id, $upTo);
        }
    }

    public static function markAll(int $pid, int $uid, string $type): void
    {
        $max = (int)Db::value('SELECT COALESCE(MAX(id), 0) FROM activity WHERE project_id = ? AND item_type = ?', [$pid, $type]);
        self::setMark($uid, $pid, $type, 0, $max);
        Db::run('UPDATE read_marks SET forced_unread = 0 WHERE user_id = ? AND project_id = ? AND item_type = ?', [$uid, $pid, $type]);
    }

    public static function markUnread(int $pid, int $uid, string $type, int $id): void
    {
        if (!isset(self::visible($pid, $uid)[$type][$id])) throw new HttpError(404, 'Item not found');
        $where = [$uid, $pid, $type, $id];
        if (Db::value('SELECT 1 FROM read_marks WHERE user_id = ? AND project_id = ? AND item_type = ? AND item_id = ?', $where)) {
            Db::run('UPDATE read_marks SET forced_unread = 1 WHERE user_id = ? AND project_id = ? AND item_type = ? AND item_id = ?', $where);
        } else {
            Db::insert('read_marks', ['user_id' => $uid, 'project_id' => $pid, 'item_type' => $type, 'item_id' => $id, 'activity_id' => 0, 'forced_unread' => 1]);
        }
    }

    private static function setMark(int $uid, int $pid, string $type, int $id, int $activityId): void
    {
        $where = [$uid, $pid, $type, $id];
        $old = Db::value('SELECT activity_id FROM read_marks WHERE user_id = ? AND project_id = ? AND item_type = ? AND item_id = ?', $where);
        if ($old === null) {
            Db::insert('read_marks', ['user_id' => $uid, 'project_id' => $pid, 'item_type' => $type, 'item_id' => $id, 'activity_id' => $activityId, 'forced_unread' => 0]);
        } else {
            Db::run('UPDATE read_marks SET activity_id = ?, forced_unread = 0 WHERE user_id = ? AND project_id = ? AND item_type = ? AND item_id = ?',
                array_merge([max((int)$old, $activityId)], $where));
        }
    }

    /** What this user may see: a private conversation never counts for a non-participant. */
    private static function visible(int $pid, int $uid): array
    {
        $ids = fn(string $sql, array $params) => array_fill_keys(array_map('intval', array_column(Db::all($sql, $params), 'id')), true);
        return [
            'conversation' => $ids('SELECT c.id FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ? WHERE c.project_id = ?', [$uid, $pid]),
            'fact' => $ids('SELECT id FROM facts WHERE project_id = ? AND deleted_at IS NULL', [$pid]),
            'document' => $ids('SELECT id FROM documents WHERE project_id = ? AND deleted_at IS NULL', [$pid]),
            'bib' => $ids('SELECT id FROM bib_entries WHERE project_id = ?', [$pid]),
            'question' => [$pid => true],
            'oquestion' => $ids('SELECT id FROM open_questions WHERE project_id = ? AND deleted_at IS NULL', [$pid]),
            'strategy' => $ids('SELECT s.id FROM proof_strategies s JOIN open_questions q ON q.id = s.question_id
                                WHERE s.project_id = ? AND s.deleted_at IS NULL AND q.deleted_at IS NULL', [$pid]),
            'member' => $ids('SELECT user_id AS id FROM project_members WHERE project_id = ?', [$pid]),
        ];
    }
}
