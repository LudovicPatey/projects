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
        // A whole-project conversation is read by every member: their row holds what they read, starred or archived.
        if (($c['visibility'] ?? 'chosen') === 'project') self::syncProjectConversations((int)$c['project_id'], (int)Auth::id());
        $isParticipant = Db::value('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$id, Auth::id()]);
        if (!$isParticipant) throw new HttpError(403, 'You are not a participant of this conversation.');
        return $c;
    }

    /**
     * Makes every member a participant of the whole-project conversations (visibility 'project'), so that one who joins later reads,
     * answers and is notified like the others. Limited to a project and/or a member when given. Called when someone joins a project,
     * when a member opens their conversations, and at install for members added another way.
     */
    public static function syncProjectConversations(?int $projectId = null, ?int $userId = null): void
    {
        $where = '';
        $params = [];
        if ($projectId !== null) { $where .= ' AND c.project_id = ?'; $params[] = $projectId; }
        if ($userId !== null) { $where .= ' AND pm.user_id = ?'; $params[] = $userId; }
        Db::run("INSERT INTO conversation_participants (conversation_id, user_id)
                 SELECT c.id, pm.user_id FROM conversations c JOIN project_members pm ON pm.project_id = c.project_id
                 WHERE c.visibility = 'project'$where
                   AND NOT EXISTS (SELECT 1 FROM conversation_participants x WHERE x.conversation_id = c.id AND x.user_id = pm.user_id)", $params);
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

    public static function question(int $id): array
    {
        $q = Db::one('SELECT * FROM open_questions WHERE id = ? AND deleted_at IS NULL', [$id]);
        if (!$q) throw new HttpError(404, 'Question not found');
        self::member((int)$q['project_id']);
        return $q;
    }

    public static function strategy(int $id): array
    {
        $s = Db::one('SELECT s.* FROM proof_strategies s JOIN open_questions q ON q.id = s.question_id
                      WHERE s.id = ? AND s.deleted_at IS NULL AND q.deleted_at IS NULL', [$id]);
        if (!$s) throw new HttpError(404, 'Strategy not found');
        self::member((int)$s['project_id']);
        return $s;
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
            'oquestion' => self::question($id)['project_id'],
            'strategy' => self::strategy($id)['project_id'],
            'notation' => self::notation($id),
            default => throw new HttpError(400, 'Invalid comment target'),
        };
    }

    /** A notation entry of a project the caller belongs to. @return int its project */
    public static function notation(int $id): int
    {
        $pid = Db::value('SELECT project_id FROM notations WHERE id = ?', [$id]);
        if (!$pid) throw new HttpError(404, 'Notation entry not found');
        self::member((int)$pid);
        return (int)$pid;
    }

    /** User ids who can see a comment target (null = every project member). */
    public static function audience(string $type, int $id): ?array
    {
        if ($type !== 'conversation') return null;
        return array_map('intval', array_column(
            Db::all('SELECT user_id FROM conversation_participants WHERE conversation_id = ?', [$id]), 'user_id'));
    }
}
