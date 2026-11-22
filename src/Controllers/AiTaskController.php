<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, BibTex, Db, HttpError, Notify, Provenance, Request, Response, Sanitizer};

/**
 * The AI work queue. The platform stores requests and results and never runs a model:
 * each user's own AI client claims a task, works on their computer, and sends the result back.
 */
final class AiTaskController
{
    public const KINDS = ['extract', 'ask', 'bib', 'derive'];
    private const LEASE_SECONDS = 900;
    private const MAX_ATTEMPTS = 3;
    private const MAX_REQUESTS_PER_DAY = 40;
    private const ONLINE_SECONDS = 180;
    private const ASSISTANT = 'ai-assistant';
    private const SOURCES = ['document', 'question', 'strategy', 'fact'];

    // ----- created by the platform -----

    /** A new file or file version written or uploaded by a person is queued for fact extraction. */
    public static function queueDocument(int $pid, int $documentId, int $versionId): void
    {
        if (Auth::isAi()) return;
        self::insertTask($pid, 'extract', 'document', $documentId, $versionId, null, null, "extract:$versionId");
    }

    /** "@AI" in a message or a comment asks for the opinion of whichever AI client runs next. */
    public static function queueMention(int $pid, string $type, int $id, string $html, ?int $conversationId): void
    {
        if (Auth::isAi() || !self::mentionsAi($html)) return;
        self::insertTask($pid, 'ask', $type, $id, null, $conversationId, mb_substr(Sanitizer::toText($html), 0, 4000), "ask:$type:$id");
    }

    public static function mentionsAi(string $html): bool
    {
        // A chip citing a person or an object named "AI ..." is not a request.
        $text = preg_replace('#<(span|a)\b[^>]*\bdata-(?:mention|ref|type|id)\b[^>]*>.*?</\1>#is', ' ', $html) ?? '';
        $text = html_entity_decode(strip_tags(str_replace('<', ' <', $text)), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return preg_match('/(?<![\w@.])@AI\b/iu', $text) === 1;
    }

    private static function insertTask(int $pid, string $kind, ?string $sourceType, ?int $sourceId, ?int $versionId, ?int $conversationId, ?string $prompt, ?string $dedupe): int
    {
        if ($dedupe !== null) {
            $old = Db::value('SELECT id FROM ai_tasks WHERE project_id = ? AND dedupe_key = ?', [$pid, $dedupe]);
            if ($old) return (int)$old;
        }
        $now = Db::now();
        return Db::insert('ai_tasks', [
            'project_id' => $pid, 'kind' => $kind, 'status' => 'pending', 'source_type' => $sourceType, 'source_id' => $sourceId,
            'version_id' => $versionId, 'conversation_id' => $conversationId, 'prompt_text' => $prompt,
            'requested_by' => Auth::id(), 'dedupe_key' => $dedupe, 'created_at' => $now, 'updated_at' => $now,
        ]);
    }

    // ----- for people -----

    public static function overview(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        self::expire();
        $me = Auth::id();
        $tasks = Db::all(self::listSql() . ' WHERE t.project_id = ? AND ' . self::visibleSql('t') . ' ORDER BY t.id DESC LIMIT 200', [$pid, $me]);
        $counts = ['pending' => 0, 'running' => 0, 'done' => 0, 'failed' => 0, 'cancelled' => 0];
        foreach (Db::all('SELECT t.status, COUNT(*) AS n FROM ai_tasks t WHERE t.project_id = ? AND ' . self::visibleSql('t') . ' GROUP BY t.status', [$pid, $me]) as $c) {
            $counts[$c['status']] = (int)$c['n'];
        }
        $since = gmdate('Y-m-d H:i:s', time() - self::ONLINE_SECONDS);
        $clients = Db::all(
            'SELECT c.name, c.ai_model, c.last_seen_at, u.name AS user_name FROM ai_clients c JOIN users u ON u.id = c.user_id
             JOIN project_members m ON m.user_id = c.user_id AND m.project_id = ? WHERE c.last_seen_at >= ? ORDER BY c.last_seen_at DESC', [$pid, $since]);
        $suggestions = Db::all(
            "SELECT s.*, u.name AS ai_user_name, d.name AS decided_by_name FROM bib_suggestions s LEFT JOIN users u ON u.id = s.ai_user_id LEFT JOIN users d ON d.id = s.decided_by
             WHERE s.project_id = ? ORDER BY CASE s.status WHEN 'proposed' THEN 0 ELSE 1 END, s.id DESC LIMIT 100", [$pid]);
        Response::json(['tasks' => array_map([self::class, 'present'], $tasks), 'counts' => $counts, 'clients' => $clients,
            'suggestions' => array_map([self::class, 'presentSuggestion'], $suggestions)]);
    }

    public static function request(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        self::humanOnly();
        $kind = $r->str('kind');
        if (!in_array($kind, self::KINDS, true)) throw new HttpError(422, 'Choose what the AI should do.');
        $since = gmdate('Y-m-d H:i:s', time() - 86400);
        if ((int)Db::value('SELECT COUNT(*) FROM ai_tasks WHERE requested_by = ? AND created_at > ? AND dedupe_key IS NULL', [Auth::id(), $since]) >= self::MAX_REQUESTS_PER_DAY) {
            throw new HttpError(429, 'You have reached the limit of AI requests for today.');
        }
        $prompt = trim((string)$r->input('prompt_text', ''));
        if (mb_strlen($prompt) > 4000) throw new HttpError(422, 'The instructions are too long (4000 characters at most).');
        $sourceType = $r->str('source_type') ?: null;
        $sourceId = (int)$r->input('source_id') ?: null;
        if (($sourceType === null) !== ($sourceId === null) || ($sourceType !== null && !in_array($sourceType, self::SOURCES, true))) {
            throw new HttpError(422, 'Invalid subject.');
        }
        if ($sourceType !== null && self::sourceProject($sourceType, $sourceId) !== $pid) throw new HttpError(404, 'This subject is not in the project.');
        if ($kind === 'extract' && $sourceType !== 'document') throw new HttpError(422, 'Choose the file to extract facts from.');
        if ($kind === 'ask' && $prompt === '') throw new HttpError(422, 'Write your question for the AI.');
        $versionId = $sourceType === 'document' ? (int)Db::value('SELECT current_version_id FROM documents WHERE id = ?', [$sourceId]) : null;
        $open = Db::value("SELECT id FROM ai_tasks WHERE project_id = ? AND kind = ? AND status IN ('pending', 'running')
                           AND " . ($sourceType === null ? 'source_type IS NULL AND source_id IS NULL' : 'source_type = ? AND source_id = ?') . " AND COALESCE(prompt_text, '') = ?",
            array_merge([$pid, $kind], $sourceType === null ? [] : [$sourceType, $sourceId], [$prompt]));
        if ($open) throw new HttpError(409, 'The same request is already waiting.');
        $id = self::insertTask($pid, $kind, $sourceType, $sourceId, $versionId, null, $prompt !== '' ? $prompt : null, null);
        Response::json(self::present(self::row($id)), 201);
    }

    public static function cancel(Request $r): never
    {
        self::humanOnly();
        $t = self::visible($r->int('id'));
        self::mayManage($t);
        if (!in_array($t['status'], ['pending', 'running'], true)) throw new HttpError(409, 'This task is already finished.');
        Db::update('ai_tasks', ['status' => 'cancelled', 'lease_hash' => null, 'lease_until' => null, 'finished_at' => Db::now(), 'updated_at' => Db::now()], 'id = :id', ['id' => $t['id']]);
        Response::json(self::present(self::row((int)$t['id'])));
    }

    public static function retry(Request $r): never
    {
        self::humanOnly();
        $t = self::visible($r->int('id'));
        self::mayManage($t);
        if (!in_array($t['status'], ['failed', 'cancelled'], true)) throw new HttpError(409, 'Only a failed or cancelled task can be retried.');
        Db::update('ai_tasks', ['status' => 'pending', 'attempts' => 0, 'not_before' => null, 'error_text' => null, 'finished_at' => null, 'updated_at' => Db::now()], 'id = :id', ['id' => $t['id']]);
        Response::json(self::present(self::row((int)$t['id'])));
    }

    public static function acceptSuggestion(Request $r): never
    {
        self::humanOnly();
        $s = self::suggestion($r->int('id'));
        $me = Auth::id();
        $bid = Db::tx(function () use ($s, $me) {
            $pid = (int)$s['project_id'];
            $existing = $s['doi'] ? Db::value('SELECT id FROM bib_entries WHERE project_id = ? AND LOWER(doi) = LOWER(?)', [$pid, $s['doi']]) : null;
            if ($existing) $bid = (int)$existing;
            else {
                $fields = array_filter(['title' => $s['title'], 'author' => $s['authors'], 'year' => $s['year'], 'journal' => $s['venue'],
                    'doi' => $s['doi'], 'url' => $s['url'], 'eprint' => $s['arxiv'], 'archiveprefix' => $s['arxiv'] ? 'arXiv' : null], fn($v) => $v !== null && $v !== '');
                $now = Db::now();
                $bid = Db::insert('bib_entries', BibTex::columns($fields) + [
                    'project_id' => $pid, 'cite_key' => BibController::uniqueKey($pid, BibController::makeKey($fields)), 'entry_type' => $s['venue'] ? 'article' : 'misc',
                    'fields_json' => json_encode($fields, JSON_UNESCAPED_UNICODE), 'ai_model' => $s['ai_model'], 'ai_user_id' => $s['ai_user_id'], 'ai_generation_ms' => $s['ai_generation_ms'],
                    'created_by' => $me, 'created_at' => $now, 'updated_at' => $now,
                ]);
                Activity::touch($pid, 'bib', $bid, 'created');
            }
            Db::update('bib_suggestions', ['status' => 'accepted', 'bib_id' => $bid, 'decided_by' => $me, 'decided_at' => Db::now()], 'id = :id', ['id' => $s['id']]);
            return $bid;
        });
        Response::json(['ok' => true, 'bib_id' => $bid]);
    }

    public static function rejectSuggestion(Request $r): never
    {
        self::humanOnly();
        $s = self::suggestion($r->int('id'));
        Db::update('bib_suggestions', ['status' => 'rejected', 'decided_by' => Auth::id(), 'decided_at' => Db::now(), 'decision_note' => mb_substr($r->str('note'), 0, 500) ?: null], 'id = :id', ['id' => $s['id']]);
        Response::json(['ok' => true]);
    }

    // ----- for AI clients -----

    public static function claim(Request $r): never
    {
        self::aiOnly();
        self::expire();
        $me = Auth::id();
        $now = Db::now();
        $name = mb_substr($r->str('client_name'), 0, 80) ?: 'AI client';
        $model = mb_substr($r->str('ai_model'), 0, 120) ?: null;
        self::seen($me, $name, $model);
        $kinds = array_values(array_intersect((array)$r->input('kinds', self::KINDS), self::KINDS));
        if (!$kinds) throw new HttpError(422, 'No valid task kind.');
        [$in, $params] = Db::in($kinds);
        $project = (int)$r->input('project_id');
        $where = $project ? ' AND t.project_id = ?' : '';
        $candidates = Db::all(
            "SELECT t.id, t.status FROM ai_tasks t JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ?
             WHERE t.kind IN $in AND (t.status = 'pending' OR (t.status = 'running' AND t.lease_until < ?))
               AND (t.not_before IS NULL OR t.not_before <= ?) AND " . self::visibleSql('t') . "$where
             ORDER BY CASE t.kind WHEN 'ask' THEN 0 ELSE 1 END, t.id LIMIT 10",
            array_merge([$me], $params, [$now, $now, $me], $project ? [$project] : []));
        foreach ($candidates as $c) {
            $lease = bin2hex(random_bytes(24));
            $won = Db::run(
                "UPDATE ai_tasks SET status = 'running', lease_hash = ?, lease_until = ?, attempts = attempts + 1, claimed_by = ?, client_name = ?, ai_model = ?, updated_at = ?
                 WHERE id = ? AND (status = 'pending' OR (status = 'running' AND lease_until < ?))",
                [hash('sha256', $lease), gmdate('Y-m-d H:i:s', time() + self::LEASE_SECONDS), $me, $name, $model, $now, $c['id'], $now])->rowCount();
            if ($won === 1) {
                $t = self::row((int)$c['id']);
                Response::json(['task' => self::present($t) + ['lease' => $lease, 'lease_seconds' => self::LEASE_SECONDS, 'context' => self::context($t)]]);
            }
        }
        Response::json(['task' => null]);
    }

    public static function heartbeat(Request $r): never
    {
        self::aiOnly();
        $t = self::leased($r);
        Db::update('ai_tasks', ['lease_until' => gmdate('Y-m-d H:i:s', time() + self::LEASE_SECONDS), 'updated_at' => Db::now()], 'id = :id', ['id' => $t['id']]);
        self::seen(Auth::id(), (string)$t['client_name'], $t['ai_model']);
        Response::json(['ok' => true, 'lease_seconds' => self::LEASE_SECONDS]);
    }

    public static function complete(Request $r): never
    {
        self::aiOnly();
        $t = self::leased($r);
        $pid = (int)$t['project_id'];
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $factIds = self::owned('facts', $pid, (array)$r->input('fact_ids', []));
        $suggestionIds = self::owned('bib_suggestions', $pid, (array)$r->input('suggestion_ids', []));
        $summary = mb_substr(trim($r->str('summary')), 0, 1000) ?: null;
        $reply = null;
        if ($t['kind'] === 'ask') {
            $text = trim((string)$r->input('reply_text', ''));
            if ($text === '') throw new HttpError(422, 'An answer is required: send reply_text.');
            if (mb_strlen($text) > 20000) throw new HttpError(422, 'The answer is too long.');
            $reply = self::postReply($t, $text, $model, $stamp);
        }
        $now = Db::now();
        Db::update('ai_tasks', ['status' => 'done', 'lease_hash' => null, 'lease_until' => null, 'ai_model' => $model, 'ai_user_id' => $stamp['ai_user_id'], 'ai_generation_ms' => $stamp['ai_generation_ms'],
            'summary_text' => $summary, 'error_text' => null,
            'result_json' => json_encode(['fact_ids' => $factIds, 'suggestion_ids' => $suggestionIds, 'reply' => $reply]), 'finished_at' => $now, 'updated_at' => $now], 'id = :id', ['id' => $t['id']]);
        if ($t['requested_by'] && (int)$t['requested_by'] !== Auth::aiUserId()) {
            Notify::send((int)$t['requested_by'], $pid, 'ai_done', ['link' => self::resultLink($t, $reply), 'excerpt' => $summary ?? 'Your AI request is done.']);
        }
        Response::json(self::present(self::row((int)$t['id'])));
    }

    public static function fail(Request $r): never
    {
        self::aiOnly();
        $t = self::leased($r);
        $error = mb_substr(trim($r->str('error')), 0, 1000) ?: 'The AI client reported an error.';
        $final = (bool)$r->input('final') || (int)$t['attempts'] >= self::MAX_ATTEMPTS;
        $now = Db::now();
        Db::update('ai_tasks', ['status' => $final ? 'failed' : 'pending', 'lease_hash' => null, 'lease_until' => null, 'error_text' => $error,
            'not_before' => $final ? null : gmdate('Y-m-d H:i:s', time() + 120 * (int)$t['attempts']), 'finished_at' => $final ? $now : null, 'updated_at' => $now], 'id = :id', ['id' => $t['id']]);
        Response::json(self::present(self::row((int)$t['id'])));
    }

    /** The client stops for a usage limit or at its user's request: the task waits for the next one. */
    public static function release(Request $r): never
    {
        self::aiOnly();
        $t = self::leased($r);
        Db::update('ai_tasks', ['status' => 'pending', 'lease_hash' => null, 'lease_until' => null, 'attempts' => max(0, (int)$t['attempts'] - 1), 'updated_at' => Db::now()], 'id = :id', ['id' => $t['id']]);
        Response::json(self::present(self::row((int)$t['id'])));
    }

    public static function suggest(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        self::aiOnly();
        $items = $r->input('suggestions');
        if (!is_array($items) || !$items || !array_is_list($items) || count($items) > 25) throw new HttpError(422, 'suggestions must be a list of 1 to 25 references.');
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $taskId = (int)$r->input('task_id') ?: null;
        if ($taskId && (int)Db::value('SELECT project_id FROM ai_tasks WHERE id = ?', [$taskId]) !== $pid) $taskId = null;
        $clean = array_map([self::class, 'cleanSuggestion'], $items);
        $created = []; $skipped = [];
        foreach ($clean as $s) {
            if (self::isKnown($pid, $s)) { $skipped[] = $s['title']; continue; }
            $created[] = Db::insert('bib_suggestions', $s + $stamp + ['project_id' => $pid, 'task_id' => $taskId, 'status' => 'proposed', 'ai_model' => $model, 'created_at' => Db::now()]);
        }
        Response::json(['created' => $created, 'skipped' => $skipped], 201);
    }

    /** The client itself, a single file with no dependency. */
    public static function download(Request $r): never
    {
        $file = __DIR__ . '/../../client/oq.py';
        if (!is_file($file)) throw new HttpError(404, 'Client not available.');
        header('Content-Type: text/x-python; charset=utf-8');
        header('Content-Disposition: attachment; filename="oq.py"');
        header('X-Content-Type-Options: nosniff');
        readfile($file);
        exit;
    }

    // ----- helpers -----

    private static function cleanSuggestion(mixed $x): array
    {
        if (!is_array($x)) throw new HttpError(422, 'Each suggestion must be an object.');
        $s = fn(string $k, int $max) => mb_substr(trim(is_scalar($x[$k] ?? null) ? (string)$x[$k] : ''), 0, $max);
        $title = $s('title', 500); $reason = $s('reason_text', 2000);
        if ($title === '') throw new HttpError(422, 'A suggestion needs a title.');
        if ($reason === '') throw new HttpError(422, "A suggestion must explain why it is relevant: \"$title\".");
        $doi = preg_replace('#^https?://(dx\.)?doi\.org/#i', '', $s('doi', 200)) ?? '';
        if ($doi !== '' && !preg_match('#^10\.\d{4,9}/\S+$#', $doi)) throw new HttpError(422, "Invalid DOI for \"$title\".");
        $arxiv = preg_replace('#^(arxiv:|https?://arxiv\.org/abs/)#i', '', $s('arxiv', 40)) ?? '';
        if ($arxiv !== '' && !preg_match('#^(\d{4}\.\d{4,5}|[a-z.-]+/\d{7})(v\d+)?$#i', $arxiv)) throw new HttpError(422, "Invalid arXiv id for \"$title\".");
        $url = $s('url', 500);
        if ($url !== '' && !preg_match('#^https?://[^\s<>"]+$#i', $url)) throw new HttpError(422, "Invalid address for \"$title\".");
        if ($doi === '' && $arxiv === '' && $url === '') throw new HttpError(422, "A suggestion needs a DOI, an arXiv id or an address that a person can check: \"$title\".");
        $year = $s('year', 4);
        return ['title' => $title, 'authors' => $s('authors', 1000) ?: null, 'year' => preg_match('/^\d{4}$/', $year) ? $year : null,
            'venue' => $s('venue', 255) ?: null, 'doi' => $doi ?: null, 'arxiv' => $arxiv ?: null, 'url' => $url ?: null, 'reason_text' => $reason];
    }

    private static function isKnown(int $pid, array $s): bool
    {
        if ($s['doi'] && (Db::value('SELECT 1 FROM bib_entries WHERE project_id = ? AND LOWER(doi) = LOWER(?)', [$pid, $s['doi']])
            || Db::value('SELECT 1 FROM bib_suggestions WHERE project_id = ? AND LOWER(doi) = LOWER(?)', [$pid, $s['doi']]))) return true;
        if ($s['arxiv'] && Db::value('SELECT 1 FROM bib_suggestions WHERE project_id = ? AND arxiv = ?', [$pid, $s['arxiv']])) return true;
        return (bool)Db::value('SELECT 1 FROM bib_suggestions WHERE project_id = ? AND LOWER(title) = LOWER(?)', [$pid, $s['title']])
            || (bool)Db::value('SELECT 1 FROM bib_entries WHERE project_id = ? AND LOWER(title) = LOWER(?)', [$pid, $s['title']]);
    }

    private static function suggestion(int $id): array
    {
        $s = Db::one('SELECT * FROM bib_suggestions WHERE id = ?', [$id]);
        if (!$s || !Access::role((int)$s['project_id'])) throw new HttpError(404, 'Suggestion not found.');
        if ($s['status'] !== 'proposed') throw new HttpError(409, 'This suggestion was already handled.');
        return $s;
    }

    private static function postReply(array $t, string $text, ?string $model, array $stamp): array
    {
        $pid = (int)$t['project_id'];
        $body = Sanitizer::clean(Sanitizer::textToHtml($text, $pid));
        $author = self::assistantId();
        $now = Db::now();
        if ($t['source_type'] === 'message') {
            $cid = (int)Db::value('SELECT conversation_id FROM messages WHERE id = ?', [$t['source_id']]);
            if (!$cid) throw new HttpError(409, 'The message was deleted.');
            $id = Db::insert('messages', $stamp + ['conversation_id' => $cid, 'author_id' => $author, 'ai_model' => $model, 'body_html' => $body['html'], 'created_at' => $now]);
            Activity::touch($pid, 'conversation', $cid, 'message', $id);
            Db::update('conversations', ['last_message_at' => $now], 'id = :id', ['id' => $cid]);
            Db::run('UPDATE conversation_participants SET archived = 0 WHERE conversation_id = ?', [$cid]);
            return ['type' => 'message', 'id' => $id, 'conversation_id' => $cid];
        }
        if ($t['source_type'] === 'comment') {
            $c = Db::one('SELECT * FROM comments WHERE id = ?', [$t['source_id']]);
            if (!$c) throw new HttpError(409, 'The comment was deleted.');
            $root = (int)($c['parent_id'] ?: $c['id']);
            $id = Db::insert('comments', $stamp + ['project_id' => $pid, 'target_type' => $c['target_type'], 'target_id' => $c['target_id'], 'parent_id' => $root,
                'author_id' => $author, 'ai_model' => $model, 'body_html' => $body['html'], 'created_at' => $now]);
            Activity::touch($pid, $c['target_type'], (int)$c['target_id'], 'comment', $id);
            return ['type' => 'comment', 'id' => $id, 'target_type' => $c['target_type'], 'target_id' => (int)$c['target_id'], 'root' => $root];
        }
        return ['type' => 'task', 'id' => (int)$t['id'], 'text' => $text];
    }

    /** The author of answers to "@AI". It is not a member of any project and has no credential. */
    private static function assistantId(): int
    {
        $id = Db::value('SELECT id FROM users WHERE orcid = ?', [self::ASSISTANT]);
        if ($id) return (int)$id;
        try {
            return Db::insert('users', ['orcid' => self::ASSISTANT, 'name' => 'AI assistant', 'kind' => 'agent', 'created_at' => Db::now()]);
        } catch (\PDOException) {
            return (int)Db::value('SELECT id FROM users WHERE orcid = ?', [self::ASSISTANT]);
        }
    }

    private static function resultLink(array $t, ?array $reply): array
    {
        if ($reply && $reply['type'] === 'message') return ['view' => 'conversations', 'id' => $reply['conversation_id']];
        if ($reply && $reply['type'] === 'comment') {
            $view = ['oquestion' => 'questions', 'conversation' => 'conversations', 'document' => 'files', 'bib' => 'bib', 'fact' => 'facts'][$reply['target_type']] ?? null;
            if ($view) return ['view' => $view, 'id' => $reply['target_id'], 'comment' => $reply['root']];
        }
        return ['view' => 'ai', 'id' => (int)$t['id']];
    }

    /** What a client needs to work. The claim is limited to tasks its user may see. */
    private static function context(array $t): array
    {
        $pid = (int)$t['project_id'];
        $p = Db::one('SELECT id, title, question_html FROM projects WHERE id = ?', [$pid]);
        $ctx = [
            'project' => ['id' => $pid, 'title' => $p['title'], 'question' => Sanitizer::toText((string)$p['question_html'])],
            'questions' => Db::all('SELECT id, parent_id, title, status FROM open_questions WHERE project_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 200', [$pid]),
            'facts' => Db::all('SELECT id, label, title, kind FROM facts WHERE project_id = ? AND deleted_at IS NULL AND retracted_at IS NULL ORDER BY id DESC LIMIT 300', [$pid]),
            'bibliography' => Db::all('SELECT id, cite_key, title, authors, year, doi FROM bib_entries WHERE project_id = ? ORDER BY id LIMIT 500', [$pid]),
        ];
        $type = $t['source_type']; $id = (int)$t['source_id'];
        if ($type === 'document') $ctx['document'] = self::documentContext($id, $t['version_id'] ? (int)$t['version_id'] : null);
        if ($type === 'message') {
            $cid = (int)$t['conversation_id'];
            $ctx['thread'] = self::thread(Db::all('SELECT * FROM (SELECT m.id, m.body_html, m.created_at, u.name AS author, u.kind FROM messages m JOIN users u ON u.id = m.author_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 30) x ORDER BY id', [$cid]));
            $ctx['subject'] = Db::value('SELECT subject FROM conversations WHERE id = ?', [$cid]);
        }
        if ($type === 'comment') {
            $c = Db::one('SELECT * FROM comments WHERE id = ?', [$id]);
            if ($c) {
                $root = (int)($c['parent_id'] ?: $c['id']);
                $ctx['thread'] = self::thread(Db::all('SELECT c.id, c.body_html, c.created_at, u.name AS author, u.kind FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ? OR c.parent_id = ? ORDER BY c.id', [$root, $root]));
                $anchor = json_decode((string)$c['anchor_json'], true);
                if (is_array($anchor) && !empty($anchor['quote'])) $ctx['quote'] = (string)$anchor['quote'];
                $ctx['commented_on'] = ['type' => $c['target_type'], 'id' => (int)$c['target_id']];
                if ($c['target_type'] === 'document') $ctx['document'] = self::documentContext((int)$c['target_id'], null);
            }
        }
        if ($type === 'question') $ctx['question'] = Db::one('SELECT id, title, statement_html AS body_html, status FROM open_questions WHERE id = ?', [$id]);
        if ($type === 'strategy') {
            $ctx['strategy'] = Db::one('SELECT id, question_id, title, status FROM proof_strategies WHERE id = ?', [$id]);
            $ctx['strategy']['body'] = Sanitizer::toText((string)Db::value('SELECT body_html FROM strategy_revisions WHERE strategy_id = ? ORDER BY revision_no DESC LIMIT 1', [$id]));
        }
        if ($type === 'fact') {
            $ctx['fact'] = Db::one('SELECT id, label, title, kind, current_revision FROM facts WHERE id = ?', [$id]);
            $rev = Db::one('SELECT statement_html, proof_html FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$id, $ctx['fact']['current_revision']]);
            $ctx['fact']['statement'] = Sanitizer::toText((string)($rev['statement_html'] ?? ''));
            $ctx['fact']['proof'] = Sanitizer::toText((string)($rev['proof_html'] ?? ''));
        }
        if (isset($ctx['question']['body_html'])) { $ctx['question']['body'] = Sanitizer::toText((string)$ctx['question']['body_html']); unset($ctx['question']['body_html']); }
        return $ctx;
    }

    private static function thread(array $rows): array
    {
        return array_map(fn($m) => ['id' => (int)$m['id'], 'author' => $m['author'], 'is_ai' => $m['kind'] === 'agent', 'at' => $m['created_at'], 'text' => Sanitizer::toText((string)$m['body_html'])], $rows);
    }

    private static function documentContext(int $id, ?int $versionId): ?array
    {
        $d = Db::one('SELECT id, title, description, origin, current_version_id FROM documents WHERE id = ? AND deleted_at IS NULL', [$id]);
        if (!$d) return null;
        $vid = $versionId ?: (int)$d['current_version_id'];
        $d['version_id'] = $vid;
        $d['files'] = Db::all('SELECT id, role, filename FROM version_files WHERE version_id = ? ORDER BY id', [$vid]);
        return $d;
    }

    private static function sourceProject(string $type, int $id): ?int
    {
        $table = ['document' => 'documents', 'question' => 'open_questions', 'strategy' => 'proof_strategies', 'fact' => 'facts'][$type];
        $pid = Db::value("SELECT project_id FROM $table WHERE id = ? AND deleted_at IS NULL", [$id]);
        return $pid ? (int)$pid : null;
    }

    private static function owned(string $table, int $pid, array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', array_filter($ids, 'is_numeric')))));
        if (!$ids) return [];
        [$in, $p] = Db::in($ids);
        return array_map('intval', array_column(Db::all("SELECT id FROM $table WHERE project_id = ? AND id IN $in", array_merge([$pid], $p)), 'id'));
    }

    private static function leased(Request $r): array
    {
        $t = Db::one('SELECT * FROM ai_tasks WHERE id = ?', [$r->int('id')]);
        if (!$t || !Access::role((int)$t['project_id'])) throw new HttpError(404, 'Task not found.');
        $lease = $r->str('lease');
        if ($t['status'] !== 'running' || (int)$t['claimed_by'] !== Auth::id() || $lease === '' || !hash_equals((string)$t['lease_hash'], hash('sha256', $lease))) {
            throw new HttpError(409, 'This task is no longer assigned to this client.');
        }
        return $t;
    }

    private static function visible(int $id): array
    {
        $t = self::row($id);
        if (!$t || !Access::role((int)$t['project_id'])) throw new HttpError(404, 'Task not found.');
        if ($t['conversation_id'] && !in_array(Auth::id(), Access::audience('conversation', (int)$t['conversation_id']) ?? [], true)) throw new HttpError(404, 'Task not found.');
        return $t;
    }

    private static function mayManage(array $t): void
    {
        if ((int)$t['requested_by'] !== Auth::id()) Access::owner((int)$t['project_id']);
    }

    private static function visibleSql(string $a): string
    {
        return "($a.conversation_id IS NULL OR EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = $a.conversation_id AND cp.user_id = ?))";
    }

    private static function listSql(): string
    {
        return 'SELECT t.*, r.name AS requested_by_name, c.name AS claimed_by_name,
                       d.title AS document_title, q.title AS question_title, s.title AS strategy_title, f.title AS fact_title
                FROM ai_tasks t LEFT JOIN users r ON r.id = t.requested_by LEFT JOIN users c ON c.id = t.claimed_by
                LEFT JOIN documents d ON t.source_type = \'document\' AND d.id = t.source_id
                LEFT JOIN open_questions q ON t.source_type = \'question\' AND q.id = t.source_id
                LEFT JOIN proof_strategies s ON t.source_type = \'strategy\' AND s.id = t.source_id
                LEFT JOIN facts f ON t.source_type = \'fact\' AND f.id = t.source_id';
    }

    private static function row(int $id): ?array
    {
        return Db::one(self::listSql() . ' WHERE t.id = ?', [$id]);
    }

    private static function present(array $t): array
    {
        $result = json_decode((string)($t['result_json'] ?? ''), true) ?: ['fact_ids' => [], 'suggestion_ids' => [], 'reply' => null];
        $subject = $t['document_title'] ?? $t['question_title'] ?? $t['strategy_title'] ?? $t['fact_title'] ?? null;
        foreach (['id', 'project_id', 'source_id', 'version_id', 'conversation_id', 'requested_by', 'claimed_by', 'attempts'] as $k) $t[$k] = $t[$k] === null ? null : (int)$t[$k];
        $out = array_intersect_key($t, array_flip(['id', 'project_id', 'kind', 'status', 'source_type', 'source_id', 'version_id', 'conversation_id', 'prompt_text', 'requested_by', 'requested_by_name',
            'claimed_by', 'claimed_by_name', 'client_name', 'ai_model', 'ai_generation_ms', 'attempts', 'summary_text', 'error_text', 'created_at', 'updated_at', 'finished_at']));
        return $out + ['subject' => $subject, 'result' => $result];
    }

    private static function presentSuggestion(array $s): array
    {
        foreach (['id', 'project_id', 'task_id', 'bib_id', 'decided_by', 'ai_user_id', 'ai_generation_ms'] as $k) $s[$k] = $s[$k] === null ? null : (int)$s[$k];
        return $s;
    }

    /** Running tasks whose client vanished after its last attempt stop being offered. */
    private static function expire(): void
    {
        $now = Db::now();
        Db::run("UPDATE ai_tasks SET status = 'failed', lease_hash = NULL, lease_until = NULL, finished_at = ?, updated_at = ?,
                 error_text = 'The AI client stopped responding.' WHERE status = 'running' AND lease_until < ? AND attempts >= ?", [$now, $now, $now, self::MAX_ATTEMPTS]);
    }

    private static function seen(int $uid, string $name, ?string $model): void
    {
        $now = Db::now();
        if (Db::value('SELECT 1 FROM ai_clients WHERE user_id = ? AND name = ?', [$uid, $name])) {
            Db::update('ai_clients', ['ai_model' => $model, 'last_seen_at' => $now], 'user_id = :u AND name = :n', ['u' => $uid, 'n' => $name]);
            return;
        }
        try { Db::insert('ai_clients', ['user_id' => $uid, 'name' => $name, 'ai_model' => $model, 'last_seen_at' => $now]); } catch (\PDOException) { /* created meanwhile */ }
    }

    private static function aiOnly(): void
    {
        if (!Auth::isAi()) throw new HttpError(403, 'This is for AI clients.');
    }

    private static function humanOnly(): void
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can do this.');
    }
}
