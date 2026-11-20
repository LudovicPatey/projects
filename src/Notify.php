<?php
declare(strict_types=1);

namespace App;

final class Notify
{
    /**
     * Stores the mentions found in a piece of rich text and notifies mentioned users.
     * @param array $link  where the notification points to, e.g. ['view'=>'conversations','id'=>3]
     * @param ?array $audience user ids allowed to see the source (null = all project members)
     */
    public static function mentions(int $projectId, string $sourceType, int $sourceId, array $mentions,
                                    array $link, string $excerpt, ?array $audience = null, bool $isNew = true): void
    {
        $previous = [];
        foreach (Db::all('SELECT mentioned_type, mentioned_id FROM mentions WHERE source_type = ? AND source_id = ?', [$sourceType, $sourceId]) as $m) {
            $previous[$m['mentioned_type'] . ':' . $m['mentioned_id']] = true;
        }
        Db::run('DELETE FROM mentions WHERE source_type = ? AND source_id = ?', [$sourceType, $sourceId]);

        $members = array_map('intval', array_column(Db::all('SELECT user_id FROM project_members WHERE project_id = ?', [$projectId]), 'user_id'));
        $me = Auth::id();
        foreach ($mentions as $m) {
            Db::insert('mentions', [
                'project_id' => $projectId, 'source_type' => $sourceType, 'source_id' => $sourceId,
                'mentioned_type' => $m['type'], 'mentioned_id' => $m['id'],
            ]);
            if ($m['type'] !== 'user' || $m['id'] === $me || !in_array($m['id'], $members, true)) continue;
            if ($audience !== null && !in_array($m['id'], $audience, true)) continue;
            if (!$isNew && isset($previous['user:' . $m['id']])) continue;
            self::send($m['id'], $projectId, 'mention', ['link' => $link, 'excerpt' => $excerpt]);
        }
    }

    public static function send(int $userId, int $projectId, string $kind, array $payload): void
    {
        $u = Auth::require();
        $payload['by'] = ['id' => (int)$u['id'], 'name' => $u['name']];
        $payload['excerpt'] = mb_substr($payload['excerpt'] ?? '', 0, 200);
        Db::insert('notifications', [
            'user_id' => $userId, 'project_id' => $projectId, 'kind' => $kind,
            'payload_json' => json_encode($payload, JSON_UNESCAPED_UNICODE), 'created_at' => Db::now(),
        ]);
    }
}
