<?php
declare(strict_types=1);

namespace App;

/** Permission checks. Every API call that touches project data goes through here. */
final class Access
{
    public static function role(int $projectId): ?string
    {
        $r = Db::value('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [$projectId, Auth::id()]);
        return $r ?: null;
    }

    public static function member(int $projectId): string
    {
        $role = self::role($projectId);
        if (!$role) throw new HttpError(403, 'You are not a member of this project.');
        return $role;
    }

    public static function owner(int $projectId): void
    {
        if (self::member($projectId) !== 'owner') throw new HttpError(403, 'Only project owners can do this.');
    }

    public static function conversation(int $id): array
    {
        $c = Db::one('SELECT * FROM conversations WHERE id = ?', [$id]);
        if (!$c) throw new HttpError(404, 'Conversation not found');
        self::member((int)$c['project_id']);
        $isParticipant = Db::value('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$id, Auth::id()]);
        if (!$isParticipant) throw new HttpError(403, 'You are not a participant of this conversation.');
        return $c;
    }

    public static function document(int $id): array
    {
        $d = Db::one('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [$id]);
        if (!$d) throw new HttpError(404, 'File not found');
        self::member((int)$d['project_id']);
        return $d;
    }

    public static function bib(int $id): array
    {
        $b = Db::one('SELECT * FROM bib_entries WHERE id = ?', [$id]);
        if (!$b) throw new HttpError(404, 'Bibliography entry not found');
        self::member((int)$b['project_id']);
        return $b;
    }

    public static function fact(int $id): array
    {
        $f = Db::one('SELECT * FROM facts WHERE id = ? AND deleted_at IS NULL', [$id]);
        if (!$f) throw new HttpError(404, 'Fact not found');
        self::member((int)$f['project_id']);
        return $f;
    }

    public static function isMember(int $projectId, int $userId): bool
    {
        return (bool)Db::value('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', [$projectId, $userId]);
    }

    /** Checks access to a comment target and returns its project id. */
    public static function commentTarget(string $type, int $id): int
    {
        return (int)match ($type) {
            'conversation' => self::conversation($id)['project_id'],
            'document' => self::document($id)['project_id'],
            'bib' => self::bib($id)['project_id'],
            'fact' => self::fact($id)['project_id'],
            default => throw new HttpError(400, 'Invalid comment target'),
        };
    }

    /** User ids who can see a comment target (null = every project member). */
    public static function audience(string $type, int $id): ?array
    {
        if ($type !== 'conversation') return null;
        return array_map('intval', array_column(
            Db::all('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [$id]), 'user_id'));
    }
}
