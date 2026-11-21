<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, HttpError, Request, Response, Sanitizer};

/**
 * AI agents: project members of kind 'agent' that call the API with a bearer token.
 * Owners create agents and manage their tokens; agents then use the regular API
 * (conversations, comments, files, bibliography) plus the /api/agent/* helpers.
 */
final class AgentController
{
    // ---------------- management (project owners, web UI) ----------------

    public static function list(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        Response::json(['agents' => self::agents($pid, Access::role($pid) === 'owner')]);
    }

    public static function create(Request $r): never
    {
        $pid = $r->int('id');
        if (Auth::isAgent()) throw new HttpError(403, 'Agents cannot create agents.');
        Access::owner($pid);
        $name = mb_substr($r->str('name'), 0, 120);
        if ($name === '') throw new HttpError(422, 'Give the agent a name.');
        $model = mb_substr($r->str('ai_model'), 0, 120);
        if ($model === '') throw new HttpError(422, 'State the AI model behind this agent.');
        $token = Db::tx(function () use ($pid, $name, $model) {
            $now = Db::now();
            $uid = Db::insert('users', [
                'orcid' => 'AI-' . bin2hex(random_bytes(7)), 'name' => $name, 'kind' => 'agent', 'ai_model' => $model,
                'affiliation' => 'AI agent', 'created_at' => $now,
            ]);
            Db::insert('project_members', ['project_id' => $pid, 'user_id' => $uid, 'role' => 'agent', 'joined_at' => $now]);
            Activity::touch($pid, 'member', $uid, 'joined');
            Activity::joined($pid, $uid);
            return self::issue($pid, $uid);
        });
        Response::json(['token' => $token, 'agents' => self::agents($pid, true)], 201);
    }

    /** Revokes the agent's current token(s) and issues a new one. */
    public static function rotate(Request $r): never
    {
        $pid = $r->int('id');
        if (Auth::isAgent()) throw new HttpError(403, 'Forbidden');
        Access::owner($pid);
        $uid = self::agentId($pid, $r->int('uid'));
        $token = Db::tx(function () use ($pid, $uid) {
            Db::run('UPDATE api_tokens SET revoked_at = ? WHERE agent_user_id = ? AND revoked_at IS NULL', [Db::now(), $uid]);
            return self::issue($pid, $uid);
        });
        Response::json(['token' => $token, 'agents' => self::agents($pid, true)]);
    }

    /** Revokes all tokens and removes the agent from the project (its past messages and files stay). */
    public static function remove(Request $r): never
    {
        $pid = $r->int('id');
        if (Auth::isAgent()) throw new HttpError(403, 'Forbidden');
        Access::owner($pid);
        $uid = self::agentId($pid, $r->int('uid'));
        Db::tx(function () use ($pid, $uid) {
            Db::run('UPDATE api_tokens SET revoked_at = ? WHERE agent_user_id = ? AND revoked_at IS NULL', [Db::now(), $uid]);
            Db::run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [$pid, $uid]);
            Db::run('DELETE FROM conversation_participants WHERE user_id = ?', [$uid]);
        });
        Response::json(['agents' => self::agents($pid, true)]);
    }

    public static function update(Request $r): never
    {
        $pid = $r->int('id');
        if (Auth::isAgent()) throw new HttpError(403, 'Forbidden');
        Access::owner($pid);
        $uid = self::agentId($pid, $r->int('uid'));
        $data = [];
        if ($r->str('name') !== '') $data['name'] = mb_substr($r->str('name'), 0, 120);
        if ($r->input('ai_model') !== null) {
            $data['ai_model'] = mb_substr($r->str('ai_model'), 0, 120);
            if ($data['ai_model'] === '') throw new HttpError(422, 'An agent must have an AI model.');
        }
        if ($data) Db::update('users', $data, 'id = :id', ['id' => $uid]);
        Response::json(['agents' => self::agents($pid, true)]);
    }

    // ---------------- agent-side helpers (bearer token) ----------------

    /** Everything an agent needs to orient itself, in one call. */
    public static function context(Request $r): never
    {
        if (!Auth::isAgent()) throw new HttpError(403, 'This endpoint is for AI agents (use an API token).');
        self::snapshot((int)Auth::tokenProject());
    }

    /** Same overview for any member, in particular a user's AI client. */
    public static function projectContext(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        self::snapshot($pid);
    }

    private static function snapshot(int $pid): never
    {
        $me = Auth::id();
        $p = Db::one('SELECT id, title, status, question_html, updated_at FROM projects WHERE id = ?', [$pid]);
        $p['question_text'] = Sanitizer::toText($p['question_html']);
        $convs = Db::all(
            "SELECT c.id, c.subject, c.last_message_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.author_id <> ?
                        AND (cp.last_read_at IS NULL OR m.created_at > cp.last_read_at)) AS unread
             FROM conversations c JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ?
             WHERE c.project_id = ? ORDER BY c.last_message_at DESC", [$me, $me, $pid]);
        $notifs = Db::all('SELECT id, kind, payload_json, created_at FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id', [$me]);
        foreach ($notifs as &$n) { $n['payload'] = json_decode($n['payload_json'], true); unset($n['payload_json']); }
        unset($n);

        Response::json([
            'agent' => ['id' => $me, 'name' => Auth::user()['name'], 'ai_model' => Auth::user()['ai_model']],
            'project' => $p,
            'members' => Db::all('SELECT u.id, u.name, u.orcid, u.kind, pm.role FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name', [$pid]),
            'documents' => Db::all(
                'SELECT d.id, d.title, d.description, d.origin, d.ai_model, d.updated_at, v.version_no AS current_version_no,
                        (SELECT f.id FROM version_files f WHERE f.version_id = d.current_version_id AND f.role = \'pdf\' LIMIT 1) AS pdf_file_id
                 FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id
                 WHERE d.project_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC', [$pid]),
            'bibliography' => Db::all(
                'SELECT id, cite_key, title, authors, year, venue, doi, url, CASE WHEN pdf_blob_id IS NULL THEN 0 ELSE 1 END AS has_pdf
                 FROM bib_entries WHERE project_id = ? ORDER BY cite_key', [$pid]),
            'facts' => array_map(fn($f) => array_intersect_key($f, array_flip(['id', 'label', 'kind', 'title', 'origin', 'ai_model', 'status', 'chain', 'lean', 'current_revision', 'statement_text', 'deps', 'method', 'tool', 'external_id', 'labels', 'proof_origin', 'endorsed_by'])),
                FactController::graph($pid)['facts']),
            'open_questions' => QuestionController::summary($pid),
            'conversations' => $convs,
            'unread_notifications' => $notifs,
            'fact_format' => FactController::formatSpec(),
            'help' => 'See docs/AGENT_API.md. Agents write messages with body_text; mention with @{user:ID}, @{document:ID}, @{bib:KEY}, @{fact:LABEL}; LaTeX with $...$. Send ai_model with each write to record the exact model used.',
        ]);
    }

    // ---------------------------------------------------------------------

    private static function issue(int $pid, int $uid): string
    {
        $token = 'oq_' . bin2hex(random_bytes(24));
        Db::insert('api_tokens', [
            'project_id' => $pid, 'agent_user_id' => $uid, 'token_hash' => hash('sha256', $token),
            'token_prefix' => substr($token, 0, 10), 'created_by' => Auth::id(), 'created_at' => Db::now(),
        ]);
        return $token;
    }

    private static function agentId(int $pid, int $uid): int
    {
        $ok = Db::value("SELECT 1 FROM project_members pm JOIN users u ON u.id = pm.user_id
                         WHERE pm.project_id = ? AND pm.user_id = ? AND u.kind = 'agent'", [$pid, $uid]);
        if (!$ok) throw new HttpError(404, 'Agent not found in this project.');
        return $uid;
    }

    private static function agents(int $pid, bool $withTokens): array
    {
        $rows = Db::all(
            "SELECT u.id, u.name, u.ai_model, u.created_at,
                    (SELECT COUNT(*) FROM messages m WHERE m.author_id = u.id) AS messages,
                    (SELECT COUNT(*) FROM documents d WHERE d.created_by = u.id AND d.deleted_at IS NULL) AS documents
             FROM project_members pm JOIN users u ON u.id = pm.user_id
             WHERE pm.project_id = ? AND u.kind = 'agent' ORDER BY u.name", [$pid]);
        foreach ($rows as &$a) {
            $t = Db::one('SELECT token_prefix, created_at, last_used_at FROM api_tokens WHERE agent_user_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', [$a['id']]);
            $a['token'] = $withTokens ? $t : null;
            $a['last_used_at'] = $t['last_used_at'] ?? null;
        }
        return $rows;
    }
}
