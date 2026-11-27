<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, HttpError, Notify, Provenance, Request, Response, Sanitizer};

/**
 * Webmail-like linear conversations. Each is open to chosen people (visibility 'chosen': its participants only, who can add others) or
 * to the whole project (visibility 'project': every member takes part, including those who join later; Access::syncProjectConversations).
 * The choice is made when it starts and is final.
 */
final class ConversationController
{
    public static function list(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $me = Auth::id();
        Access::syncProjectConversations($pid, $me);
        $convs = Db::all(
            "SELECT c.id, c.subject, c.visibility, c.created_at, c.last_message_at, cp.starred, cp.archived, cp.last_read_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.author_id <> ?
                        AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)) AS unread,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                    (SELECT COUNT(*) FROM comments k WHERE k.target_type = 'conversation' AND k.target_id = c.id) AS comment_count
             FROM conversations c JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
             WHERE c.project_id = ? ORDER BY c.last_message_at DESC", [$me, $me, $pid]);
        $ids = array_column($convs, 'id');
        [$in, $params] = Db::in($ids);
        $parts = Db::all("SELECT cp.conversation_id, u.id, u.name, u.kind FROM conversation_participants cp JOIN users u ON u.id = cp.user_id
                          WHERE cp.conversation_id IN $in ORDER BY u.name", $params);
        $last = Db::all("SELECT m.conversation_id, m.body_html, u.name AS author FROM messages m JOIN users u ON u.id = m.author_id
                         WHERE m.id IN (SELECT MAX(id) FROM messages WHERE conversation_id IN $in GROUP BY conversation_id)", $params);
        $lastBy = array_column($last, null, 'conversation_id');
        foreach ($convs as &$c) {
            $c['participants'] = array_values(array_map(fn($p) => ['id' => (int)$p['id'], 'name' => $p['name'], 'kind' => $p['kind']],
                array_filter($parts, fn($p) => $p['conversation_id'] == $c['id'])));
            $l = $lastBy[$c['id']] ?? null;
            $c['last_author'] = $l['author'] ?? null;
            $c['snippet'] = $l ? mb_substr(trim(preg_replace('/\s+/u', ' ', html_entity_decode(strip_tags(str_replace('</p>', ' </p>', $l['body_html'])), ENT_QUOTES | ENT_HTML5))), 0, 160) : '';
            $c['unread'] = (int)$c['unread'];
            $c['starred'] = (bool)$c['starred'];
            $c['archived'] = (bool)$c['archived'];
        }
        $unread = Activity::unread($pid, $me)['items']['conversation'];
        foreach ($convs as &$c) { $c['unread'] = $unread[(int)$c['id']] ?? 0; $c['private'] = $c['visibility'] !== 'project' && AiTaskController::outsideMembers($pid, (int)$c['id']) > 0; }
        unset($c);
        Response::json(['conversations' => $convs]);
    }

    public static function create(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $subject = $r->str('subject');
        if ($subject === '') throw new HttpError(422, 'A subject is required.');
        $body = Sanitizer::fromRequest($r, $pid) ?? throw new HttpError(422, 'body_html or body_text is required.');
        if ($body['text'] === '' && !$body['mentions']) throw new HttpError(422, 'The message is empty.');
        $visibility = $r->input('visibility') ?? 'chosen';
        if (!in_array($visibility, ['chosen', 'project'], true)) throw new HttpError(422, "visibility is 'chosen' (the participants you list) or 'project' (every present and future member).");
        // A whole-project conversation includes every member now; those who join later are added when they join.
        $ids = $visibility === 'project'
            ? array_map('intval', array_column(Db::all('SELECT user_id FROM project_members WHERE project_id = ?', [$pid]), 'user_id'))
            : self::validMembers($pid, (array)$r->input('participant_ids', []));
        $ids[] = Auth::id();
        $ids = array_values(array_unique($ids));

        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        [$cid, $firstMessage] = Db::tx(function () use ($pid, $subject, $visibility, $ids, $body, $model, $stamp) {
            $now = Db::now();
            $cid = Db::insert('conversations', [
                'project_id' => $pid, 'subject' => mb_substr($subject, 0, 255), 'visibility' => $visibility, 'created_by' => Auth::id(),
                'created_at' => $now, 'last_message_at' => $now,
            ]);
            foreach ($ids as $uid) {
                Db::insert('conversation_participants', ['conversation_id' => $cid, 'user_id' => $uid, 'last_read_at' => $uid === Auth::id() ? $now : null]);
            }
            $mid = Db::insert('messages', $stamp + ['conversation_id' => $cid, 'author_id' => Auth::id(), 'ai_model' => $model, 'body_html' => $body['html'], 'created_at' => $now]);
            Activity::touch($pid, 'conversation', $cid, 'message', $mid);
            Notify::mentions($pid, 'message', $mid, $body['mentions'], ['view' => 'conversations', 'id' => $cid], $body['text'], $ids);
            return [$cid, $mid];
        });
        AiTaskController::queueMention($pid, 'message', $firstMessage, $body['html'], $cid);
        Response::json(['id' => $cid], 201);
    }

    public static function show(Request $r): never
    {
        $c = Access::conversation($r->int('id'));
        $me = Auth::id();
        $c['participants'] = Db::all('SELECT u.id, u.name, u.orcid, u.kind, u.ai_model FROM conversation_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.conversation_id = ? ORDER BY u.name', [$c['id']]);
        $c['messages'] = Db::all(
            "SELECT m.id, m.author_id, u.name AS author_name, u.orcid AS author_orcid, u.kind AS author_kind, m.ai_model AS author_model, m.ai_user_id, au.name AS ai_user_name, m.ai_generation_ms, m.body_html, m.created_at, m.edited_at
             FROM messages m JOIN users u ON u.id = m.author_id LEFT JOIN users au ON au.id = m.ai_user_id WHERE m.conversation_id = ? ORDER BY m.created_at, m.id", [$c['id']]);
        if (Auth::isAi() || isset($r->query['text'])) {
            foreach ($c['messages'] as &$msg) $msg['body_text'] = Sanitizer::toText($msg['body_html']);
            unset($msg);
        }
        $flags = Db::one('SELECT last_read_at, starred, archived FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$c['id'], $me]);
        $c['last_read_at'] = $flags['last_read_at'];
        $c['starred'] = (bool)$flags['starred'];
        $c['archived'] = (bool)$flags['archived'];
        $c['last_activity_id'] = Activity::latest((int)$c['project_id'], 'conversation', (int)$c['id']);
        $c['extraction'] = AiTaskController::conversationExtraction((int)$c['project_id'], (int)$c['id']);
        $c['ai_opinion'] = AiTaskController::conversationOpinion((int)$c['id']);
        // An AI client reading on the user's behalf must not mark messages as read.
        if (!Auth::isClient()) {
            Db::update('conversation_participants', ['last_read_at' => Db::now()], 'conversation_id = :c AND user_id = :u', ['c' => $c['id'], 'u' => $me]);
        }
        Response::json($c);
    }

    public static function postMessage(Request $r): never
    {
        $c = Access::conversation($r->int('id'));
        $body = Sanitizer::fromRequest($r, (int)$c['project_id']) ?? throw new HttpError(422, 'body_html or body_text is required.');
        if ($body['text'] === '' && !$body['mentions']) throw new HttpError(422, 'The message is empty.');
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $now = Db::now();
        $mid = Db::insert('messages', $stamp + ['conversation_id' => $c['id'], 'author_id' => Auth::id(), 'ai_model' => $model, 'body_html' => $body['html'], 'created_at' => $now]);
        Activity::touch((int)$c['project_id'], 'conversation', (int)$c['id'], 'message', $mid);
        Db::update('conversations', ['last_message_at' => $now], 'id = :id', ['id' => $c['id']]);
        // A new message brings archived conversations back to the inbox.
        Db::run('UPDATE conversation_participants SET archived = 0 WHERE conversation_id = ?', [$c['id']]);
        Db::update('conversation_participants', ['last_read_at' => $now], 'conversation_id = :c AND user_id = :u', ['c' => $c['id'], 'u' => Auth::id()]);
        Notify::mentions((int)$c['project_id'], 'message', $mid, $body['mentions'], ['view' => 'conversations', 'id' => (int)$c['id']],
            $body['text'], Access::audience('conversation', (int)$c['id']));
        AiTaskController::queueMention((int)$c['project_id'], 'message', $mid, $body['html'], (int)$c['id']);
        Response::json(['id' => $mid], 201);
    }

    public static function editMessage(Request $r): never
    {
        $m = Db::one('SELECT * FROM messages WHERE id = ?', [$r->int('mid')]);
        if (!$m) throw new HttpError(404, 'Message not found');
        $c = Access::conversation((int)$m['conversation_id']);
        if ((int)$m['author_id'] !== Auth::id()) throw new HttpError(403, 'You can only edit your own messages.');
        $body = Sanitizer::fromRequest($r, (int)$c['project_id']) ?? throw new HttpError(422, 'body_html or body_text is required.');
        if ($body['text'] === '' && !$body['mentions']) throw new HttpError(422, 'The message is empty.');
        $model = Provenance::agentModel($r);
        Db::update('messages', Provenance::stamp($model, $r->input('generation_seconds')) + ['body_html' => $body['html'], 'ai_model' => $model, 'edited_at' => Db::now()], 'id = :id', ['id' => $m['id']]);
        Activity::touch((int)$c['project_id'], 'conversation', (int)$c['id'], 'message_edit', (int)$m['id']);
        Notify::mentions((int)$c['project_id'], 'message', (int)$m['id'], $body['mentions'], ['view' => 'conversations', 'id' => (int)$c['id']],
            $body['text'], Access::audience('conversation', (int)$c['id']), false);
        Response::json(['ok' => true]);
    }

    public static function addParticipants(Request $r): never
    {
        $c = Access::conversation($r->int('id'));
        if ($c['visibility'] === 'project') throw new HttpError(422, 'Every member of the project already takes part in this conversation, including those who join later.');
        foreach (self::validMembers((int)$c['project_id'], (array)$r->input('user_ids', [])) as $uid) {
            if (!Db::value('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$c['id'], $uid])) {
                Db::insert('conversation_participants', ['conversation_id' => $c['id'], 'user_id' => $uid]);
                \App\Notify::send($uid, (int)$c['project_id'], 'added_to_conversation',
                    ['link' => ['view' => 'conversations', 'id' => (int)$c['id']], 'excerpt' => $c['subject']]);
            }
        }
        Response::json(['ok' => true]);
    }

    public static function leave(Request $r): never
    {
        $c = Access::conversation($r->int('id'));
        if ($c['visibility'] === 'project') throw new HttpError(422, 'Every member of the project takes part in this conversation and cannot leave it. Archive it to take it out of your inbox.');
        Db::run('DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$c['id'], Auth::id()]);
        Response::json(['ok' => true]);
    }

    public static function flags(Request $r): never
    {
        $c = Access::conversation($r->int('id'));
        $data = [];
        if ($r->input('starred') !== null) $data['starred'] = $r->input('starred') ? 1 : 0;
        if ($r->input('archived') !== null) $data['archived'] = $r->input('archived') ? 1 : 0;
        if ($r->input('unread')) $data['last_read_at'] = null;
        if ($data) Db::update('conversation_participants', $data, 'conversation_id = :c AND user_id = :u', ['c' => $c['id'], 'u' => Auth::id()]);
        if ($r->input('unread')) Activity::markUnread((int)$c['project_id'], Auth::id(), 'conversation', (int)$c['id']);
        Response::json(['ok' => true]);
    }

    private static function validMembers(int $pid, array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
        if (!$ids) return [];
        [$in, $params] = Db::in($ids);
        $ok = Db::all("SELECT user_id FROM project_members WHERE project_id = ? AND user_id IN $in", array_merge([$pid], $params));
        return array_map('intval', array_column($ok, 'user_id'));
    }
}
