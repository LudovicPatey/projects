<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, BibTex, ClientProtocol, Db, HttpError, LatexExport, ModelOrder, Notify, Procedures, Provenance, Request, Response, Sanitizer};

/**
 * The AI work queue. The platform stores requests and results and never runs a model:
 * each user's own AI client claims a task, works on their computer, and sends the result back.
 */
final class AiTaskController
{
    public const KINDS = ['extract', 'ask', 'bib', 'derive', 'review', 'lean', 'notation', 'consolidate', 'latex'];
    /** Procedures that clients from before generic procedures handle with their own code, and the feature they announce. */
    private const BUILT_IN = ['ask' => null, 'notation' => 'notation', 'consolidate' => 'consolidate'];
    private const LEASE_SECONDS = 900;
    private const MAX_ATTEMPTS = 3;
    /** AI requests a person may make in any 24 hours. Work the platform queues on its own does not count. */
    public const MAX_REQUESTS_PER_DAY = 40;

    /**
     * A person's AI requests over the last 24 hours, against the limit, and when the oldest one leaves that window and frees a request.
     * @return array{used: int, limit: int, window_hours: int, next_free_at: ?string}
     */
    public static function usage(int $uid): array
    {
        // Only what the person asked for: sweeps and extractions the platform queues while they work count for nobody.
        $rows = Db::all('SELECT created_at FROM ai_tasks WHERE requested_by = ? AND counted = 1 AND created_at > ? ORDER BY created_at', [$uid, gmdate('Y-m-d H:i:s', time() - 86400)]);
        return ['used' => count($rows), 'limit' => self::MAX_REQUESTS_PER_DAY, 'window_hours' => 24,
            'next_free_at' => $rows ? gmdate('Y-m-d\TH:i:s\Z', strtotime($rows[0]['created_at'] . ' UTC') + 86400) : null];
    }

    /** What the interface shows a person: their AI requests of the last 24 hours. */
    public static function myUsage(Request $r): never
    {
        Response::json(self::usage((int)Auth::id()));
    }
    private const ONLINE_SECONDS = 180;
    private const ASSISTANT = 'ai-assistant';
    private const SOURCES = ['document', 'bib', 'conversation', 'question', 'strategy', 'fact'];
    private const MAX_CONVERSATION_MESSAGES = 1000;
    private const MAX_CONVERSATION_CHARS = 600000;
    /** Raise it when a client release needs new server features: older platforms are then not offered that release. */
    public const API_LEVEL = 3;

    /** Every kind of work: the client's own, and the platform's procedures. */
    public static function kinds(): array
    {
        return array_values(array_unique(array_merge(self::KINDS, Procedures::ids())));
    }

    // ----- created by the platform -----

    /** A new file or file version written or uploaded by a person is queued for fact extraction. */
    public static function queueDocument(int $pid, int $documentId, int $versionId): void
    {
        if (Auth::isAi()) return;
        self::insertTask($pid, 'extract', 'document', $documentId, $versionId, null, null, "extract:$versionId");
    }

    /** An extraction queued by an owner or an administrator, for a file version or a reference PDF. */
    public static function queueExtraction(int $pid, string $type, int $id, ?int $versionId, ?int $blobId): bool
    {
        return self::insertTask($pid, 'extract', $type, $id, $versionId, null, null, null, $blobId) > 0;
    }

    /** A fact to write again in the agreed notation. One task per revision and notation. */
    /**
     * Once the last waiting extraction of a project is done, an AI reads the whole database again:
     * duplicates across sources, missing dependencies, remarks that are open questions, subject tags.
     * One task per state of the database, so that nothing is queued twice for the same facts.
     */
    public static function queueConsolidation(int $pid): ?int
    {
        if (Db::value("SELECT 1 FROM ai_tasks WHERE project_id = ? AND (kind = 'extract' OR (kind = 'consolidate' AND (source_type IS NULL OR source_type <> 'sweep'))) AND status IN ('pending', 'running')", [$pid])) return null;
        $n = (int)Db::value('SELECT COUNT(*) FROM facts WHERE project_id = ? AND deleted_at IS NULL', [$pid]);
        if ($n < 2) return null;
        $last = (int)Db::value('SELECT COALESCE(MAX(id), 0) FROM facts WHERE project_id = ?', [$pid]);
        return self::insertTask($pid, 'consolidate', null, null, null, null, null, "cons:$last:$n");
    }

    /** A maintenance sweep (Sweeps): one task that takes what is stale when a client takes it. $asked: a member asked for it now. */
    public static function queueSweep(int $pid, string $sweep, bool $asked = false): int
    {
        if ($open = \App\Sweeps::open($pid, $sweep)) return $open;
        return self::insertTask($pid, \App\Sweeps::KINDS[$sweep], 'sweep', null, null, null, null, null, null, null, $asked);
    }

    /** The rewrites or proposals a sweep of items covers (rewrite_check, second_reading), as it took them. @return list<int> */
    public static function batchItems(array $t): array
    {
        return array_map('intval', json_decode((string)($t['snapshot_json'] ?? ''), true)['items'] ?? []);
    }

    /**
     * The rewrite of one fact, when a client takes it: the revision and the notation it is written for, as a sweep records them. An
     * answer to a fact edited since is refused, and a rewrite is labelled with the notation it followed, so that it is redone when
     * the notation changed meanwhile.
     */
    private static function pinRewrite(array $t): array
    {
        $fid = (int)$t['source_id'];
        $snap = ['facts' => [[$fid, (int)Db::value('SELECT current_revision FROM facts WHERE id = ?', [$fid])]], 'hash' => NotationController::hashFor((int)$t['project_id'], $fid)];
        Db::update('ai_tasks', ['snapshot_json' => json_encode($snap)], 'id = :id', ['id' => $t['id']]);
        return ['snapshot_json' => json_encode($snap)] + $t;
    }

    /** The cited results a batch of source checks covers, still in the project, at the revision it was queued for. @return list<int> */
    public static function batchFacts(array $t): array
    {
        $out = [];
        foreach ((json_decode((string)($t['snapshot_json'] ?? ''), true)['facts'] ?? []) as [$f, $rev]) {
            if (Db::value('SELECT 1 FROM facts WHERE id = ? AND project_id = ? AND current_revision = ? AND deleted_at IS NULL', [$f, $t['project_id'], $rev])) $out[] = (int)$f;
        }
        return $out;
    }

    /** "@AI" in a message or a comment asks for the opinion of whichever AI client runs next. */
    public static function queueMention(int $pid, string $type, int $id, string $html, ?int $conversationId): void
    {
        if (Auth::isAi() || !self::mentionsAi($html)) return;
        // In a comment, @AI may also ask for work on what it is about (Instructions): a client that follows instructions takes it as one
        // (claim), and a client from before them answers it as a question, as it always did.
        self::insertTask($pid, 'ask', $type, $id, null, $conversationId, mb_substr(Sanitizer::toText($html), 0, 4000), "ask:$type:$id");
    }

    public static function mentionsAi(string $html): bool
    {
        // A chip citing a person or an object named "AI ..." is not a request.
        $text = preg_replace('#<(span|a)\b[^>]*\bdata-(?:mention|ref|type|id)\b[^>]*>.*?</\1>#is', ' ', $html) ?? '';
        $text = html_entity_decode(strip_tags(str_replace('<', ' <', $text)), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return preg_match('/(?<![\w@.])@AI\b/iu', $text) === 1;
    }

    private static function insertTask(int $pid, string $kind, ?string $sourceType, ?int $sourceId, ?int $versionId, ?int $conversationId, ?string $prompt, ?string $dedupe, ?int $blobId = null, ?array $snapshot = null, bool $asked = false): int
    {
        if ($dedupe !== null) {
            $old = Db::value('SELECT id FROM ai_tasks WHERE project_id = ? AND dedupe_key = ?', [$pid, $dedupe]);
            if ($old) return (int)$old;
        }
        $now = Db::now();
        $after = self::dependencies($pid, $kind, $sourceType);
        return Db::insert('ai_tasks', [
            'priority' => self::priority($kind, $sourceType) - ($asked ? self::ASKED_BOOST : 0), 'after_json' => $after ? json_encode($after) : null,
            'project_id' => $pid, 'kind' => $kind, 'status' => 'pending', 'source_type' => $sourceType, 'source_id' => $sourceId,
            'version_id' => $versionId, 'source_blob_id' => $blobId, 'conversation_id' => $conversationId, 'prompt_text' => $prompt, 'snapshot_json' => $snapshot ? json_encode($snapshot) : null,
            'requested_by' => Auth::id(), 'dedupe_key' => $dedupe, 'created_at' => $now, 'updated_at' => $now,
        ]);
    }

    // ----- for people -----

    public static function overview(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        self::expire();
        \App\Sweeps::due($pid);
        $me = Auth::id();
        // What runs next first, in the scheduler's order, then the rest, newest first.
        $tasks = array_merge(
            Db::all(self::listSql() . " WHERE t.project_id = ? AND t.status IN ('running', 'pending') AND " . self::visibleSql('t') . " ORDER BY t.status = 'running' DESC, t.priority, t.id LIMIT 300", [$pid, $me]),
            Db::all(self::listSql() . " WHERE t.project_id = ? AND t.status NOT IN ('running', 'pending') AND " . self::visibleSql('t') . ' ORDER BY t.id DESC LIMIT 200', [$pid, $me]));
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
        Response::json(['tasks' => array_map([self::class, 'present'], $tasks), 'groups' => self::groups($pid, $me), 'counts' => $counts, 'clients' => $clients, 'computers' => self::computers($pid),
            'suggestions' => array_map([self::class, 'presentSuggestion'], $suggestions), 'usage' => self::usage((int)$me)]);
    }

    public static function request(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        $kind = $r->str('kind');
        // A person's own client may record the Danus run they just launched, and nothing else.
        if (Auth::isAi() && !(Auth::isClient() && $kind === 'derive')) throw new HttpError(403, 'Only a person can do this.');
        if (!in_array($kind, self::kinds(), true)) throw new HttpError(422, 'Choose what the AI should do.');
        if (in_array($kind, ['rewrite_check', 'second_reading', 'proof_review', 'proof_repair', 'repair_check', 'statement_fix', 'fix_check', 'relink', 'relink_check', 'instruct'], true)) throw new HttpError(422, 'The platform queues this on its own, whenever there is work for it.');
        $usage = self::usage((int)Auth::id());
        if ($usage['used'] >= $usage['limit']) {
            $wait = max(1, (int)ceil((strtotime((string)$usage['next_free_at']) - time()) / 60));
            $in = $wait >= 60 ? intdiv($wait, 60) . ' h' . ($wait % 60 ? ' ' . ($wait % 60) . ' min' : '') : "$wait min";
            throw new HttpError(429, "You have used your {$usage['limit']} AI requests of the last 24 hours. The next one is available in $in.");
        }
        $prompt = trim((string)$r->input('prompt_text', ''));
        if (mb_strlen($prompt) > 4000) throw new HttpError(422, 'The instructions are too long (4000 characters at most).');
        $sourceType = $r->str('source_type') ?: null;
        $sourceId = (int)$r->input('source_id') ?: null;
        if (($sourceType === null) !== ($sourceId === null) || ($sourceType !== null && !in_array($sourceType, self::SOURCES, true))) {
            throw new HttpError(422, 'Invalid subject.');
        }
        if ($sourceType !== null && self::sourceProject($sourceType, $sourceId) !== $pid) throw new HttpError(404, 'This subject is not in the project.');
        if ($kind === 'extract' && !in_array($sourceType, ['document', 'bib', 'conversation'], true)) throw new HttpError(422, 'Choose the file, reference or conversation to extract facts from.');
        if ($kind === 'extract' && $sourceType === 'document' && Db::value('SELECT exported_fact_id FROM documents WHERE id = ?', [$sourceId])) throw new HttpError(422, 'This file was assembled from facts of the project: extracting it would only copy them.');
        if (in_array($sourceType, ['bib', 'conversation'], true) && $kind !== 'extract') throw new HttpError(422, 'Invalid subject.');
        if ($kind === 'consolidate' && $sourceType !== null) throw new HttpError(422, 'Consolidation reads the whole facts database.');
        if ($kind === 'notation' && $sourceType !== null && $sourceType !== 'fact') throw new HttpError(422, 'Ask for a notation for the whole project, or for one fact.');
        if ($kind === 'notation' && $sourceType === 'fact' && NotationController::hash($pid) === sha1('')) throw new HttpError(422, 'Agree on at least one notation entry first.');
        if (in_array($kind, ['review', 'lean', 'source_check', 'latex'], true)) {
            if ($sourceType !== 'fact') throw new HttpError(422, $kind === 'latex' ? 'Choose the fact to assemble.' : 'Choose the fact to check.');
            self::checkFactRequest($pid, $kind, (int)$sourceId);
        }
        if ($sourceType === 'bib' && !Db::value('SELECT pdf_blob_id FROM bib_entries WHERE id = ?', [$sourceId])) throw new HttpError(422, 'This reference has no PDF.');
        if ($kind === 'ask' && $prompt === '') throw new HttpError(422, 'Write your question for the AI.');
        $versionId = $sourceType === 'document' ? (int)Db::value('SELECT current_version_id FROM documents WHERE id = ?', [$sourceId]) : null;
        $open = Db::value("SELECT id FROM ai_tasks WHERE project_id = ? AND kind = ? AND status IN ('pending', 'running')
                           AND " . ($sourceType === null ? 'source_type IS NULL AND source_id IS NULL' : 'source_type = ? AND source_id = ?') . " AND COALESCE(prompt_text, '') = ?",
            array_merge([$pid, $kind], $sourceType === null ? [] : [$sourceType, $sourceId], [$prompt]));
        if ($open) throw new HttpError(409, 'The same request is already waiting.');
        $blobId = $kind === 'extract' && $sourceType === 'bib' ? (int)Db::value('SELECT pdf_blob_id FROM bib_entries WHERE id = ?', [$sourceId]) : null;
        $snapshot = null;
        if ($sourceType === 'conversation') {
            $private = self::outsideMembers($pid, $sourceId) > 0;
            if ($private && $r->input('publish_private') !== true) {
                throw new HttpError(422, 'This conversation is private and every project member can see facts. Confirm that its results may be shared with the project.');
            }
            $snapshot = self::conversationSnapshot($pid, $sourceId, $private);
        }
        $id = self::insertTask($pid, $kind, $sourceType, $sourceId, $versionId, $sourceType === 'conversation' ? $sourceId : null, $prompt !== '' ? $prompt : null, null, $blobId, $snapshot, !Auth::isAi());
        Db::update('ai_tasks', ['counted' => 1], 'id = :id', ['id' => $id]); // one of the person's AI requests
        if ($snapshot['shared'] ?? false) {
            $subject = (string)Db::value('SELECT subject FROM conversations WHERE id = ?', [$sourceId]);
            foreach (Db::all("SELECT u.id FROM conversation_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.conversation_id = ? AND u.kind = 'human' AND u.id <> ?", [$sourceId, Auth::id()]) as $u) {
                Notify::send((int)$u['id'], $pid, 'conversation_extract', ['link' => ['view' => 'conversations', 'id' => $sourceId], 'excerpt' => $subject]);
            }
        }
        Response::json(self::present(self::row($id)) + ['usage' => self::usage((int)Auth::id())], 201);
    }

    /** Whether a review, Lean proof or source check of this fact makes sense. */
    private static function checkFactRequest(int $pid, string $kind, int $fid): void
    {
        if (Db::value('SELECT retracted_at FROM facts WHERE id = ?', [$fid])) throw new HttpError(422, 'This fact is retracted.');
        // A cited result has no proof here: an AI can only say whether its source states it, and a person accepts it.
        $basis = FactController::graphFact($pid, $fid)['basis'] ?? null;
        if ($kind === 'review' && $basis === 'cited') throw new HttpError(422, 'A cited result has no proof to review. Ask the AI to check its source instead.');
        if ($kind === 'source_check' && $basis !== 'cited') throw new HttpError(422, 'Only a result cited without proof has a source to check.');
        if ($kind === 'latex' && ($why = LatexExport::problem(array_column(FactController::graph($pid)['facts'], null, 'id'), $fid))) throw new HttpError(422, $why);
    }

    /**
     * Work on one object asked through an @AI instruction (src/Instructions.php), as the comment's author: the same checks as a request
     * from the object's page, counted as one of that member's requests. $type is the subject (fact, question, strategy, document, bib,
     * conversation). @return string what was queued, for the reply
     */
    public static function queueFor(int $pid, string $kind, string $type, int $id, int $by, string $note): string
    {
        $names = ['review' => 'Independent review', 'lean' => 'Lean proof', 'source_check' => 'Source check', 'notation' => 'Rewrite in the project notation',
            'extract' => 'Extraction of facts', 'derive' => 'Search for new facts', 'bib' => 'Search for references'];
        if (!isset($names[$kind])) throw new HttpError(422, 'Unknown action.');
        $versionId = null; $blobId = null; $snapshot = null;
        if ($type === 'fact') {
            if ($kind === 'notation') {
                if (NotationController::hash($pid) === sha1('')) throw new HttpError(422, 'the project has no agreed notation yet.');
                if (Db::value('SELECT retracted_at FROM facts WHERE id = ?', [$id])) throw new HttpError(422, 'This fact is retracted.');
            } elseif (in_array($kind, ['review', 'lean', 'source_check'], true)) self::checkFactRequest($pid, $kind, $id);
            else throw new HttpError(422, 'Not an action on a fact.');
        } elseif ($kind === 'extract') {
            if ($type === 'document') $versionId = (int)Db::value('SELECT current_version_id FROM documents WHERE id = ?', [$id]) ?: null;
            elseif ($type === 'bib') { $blobId = (int)Db::value('SELECT pdf_blob_id FROM bib_entries WHERE id = ?', [$id]) ?: null; if (!$blobId) throw new HttpError(422, 'This reference has no PDF.'); }
            elseif ($type === 'conversation') {
                // Every member sees facts: a private conversation's participants confirm the sharing on its page, not in a comment.
                if (self::outsideMembers($pid, $id) > 0) throw new HttpError(422, 'this conversation is private: ask for the extraction on its page, where you confirm that its results may be shared with the project.');
                $snapshot = self::conversationSnapshot($pid, $id, false);
            } else throw new HttpError(422, 'Only a file, a reference or a conversation has facts to extract.');
        } elseif ($kind === 'derive' && !in_array($type, ['question', 'strategy'], true)) throw new HttpError(422, 'A search for new facts works toward a question or a strategy.');
        elseif ($kind === 'bib' && !in_array($type, ['question', 'strategy', 'bib'], true)) throw new HttpError(422, 'Not an action here.');
        $usage = self::usage($by);
        if ($usage['used'] >= $usage['limit']) throw new HttpError(429, "the member has used their {$usage['limit']} AI requests of the last 24 hours.");
        // A reference search about a reference reads it as its subject's context; the queue knows it as a search for the project.
        [$st, $sid] = $kind === 'bib' && $type === 'bib' ? [null, null] : [$type, $id];
        $note = mb_substr(trim($note), 0, 4000);
        if ($kind === 'bib' && $type === 'bib') $note = trim('Works related to the reference ' . Db::value('SELECT title FROM bib_entries WHERE id = ?', [$id]) . ". $note");
        if (Db::value("SELECT 1 FROM ai_tasks WHERE project_id = ? AND kind = ? AND status IN ('pending', 'running') AND " . ($st === null ? 'source_type IS NULL' : 'source_type = ? AND source_id = ?') . " AND COALESCE(prompt_text, '') = ?",
            array_merge([$pid, $kind], $st === null ? [] : [$st, $sid], [$note]))) return "{$names[$kind]}: the same request is already waiting";
        $taskId = self::insertTask($pid, $kind, $st, $sid, $versionId, $type === 'conversation' ? $id : null, $note !== '' ? $note : null, null, $blobId, $snapshot, true);
        Db::update('ai_tasks', ['counted' => 1, 'requested_by' => $by], 'id = :id', ['id' => $taskId]);
        return "{$names[$kind]} queued" . ($note !== '' ? ', with your instruction' : '');
    }

    /** Queues every reference whose current PDF has no finished or waiting extraction. */
    public static function extractAll(Request $r): never
    {
        self::humanOnly();
        $pid = $r->int('id');
        Access::member($pid);
        $state = self::bibExtraction($pid);
        $queued = 0;
        foreach (Db::all('SELECT id, pdf_blob_id FROM bib_entries WHERE project_id = ? AND pdf_blob_id IS NOT NULL ORDER BY id', [$pid]) as $b) {
            $e = $state['entries'][(int)$b['id']];
            if (!in_array($e['state'], ['none', 'failed', 'comments'], true)) continue;
            // The key differs after each failed attempt, and stops two simultaneous clicks from queuing twice.
            self::insertTask($pid, 'extract', 'bib', (int)$b['id'], null, null, null, "bibx:{$b['id']}:{$b['pdf_blob_id']}:{$e['last_task']}", (int)$b['pdf_blob_id']);
            $queued++;
        }
        Response::json(['queued' => $queued, 'progress' => self::bibExtraction($pid)['progress']], 201);
    }

    /**
     * Where each reference stands, for its current PDF only: replacing a PDF starts over.
     * @return array{entries: array<int, array>, progress: array<string, int>}
     */
    public static function bibExtraction(int $pid): array
    {
        $entries = [];
        $progress = ['total' => 0, 'with_pdf' => 0, 'extracted' => 0, 'new_comments' => 0, 'queued' => 0, 'failed' => 0, 'remaining' => 0];
        $tasks = [];
        $notes = [];
        foreach (self::commentRows($pid, 'bib') as $c) $notes[(int)$c['target_id']][] = $c;
        foreach (Db::all("SELECT id, source_id, source_blob_id, status, ai_model, comments_hash FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND source_type = 'bib' ORDER BY id", [$pid]) as $t) {
            $tasks[(int)$t['source_id']][] = $t;
        }
        foreach (Db::all('SELECT id, pdf_blob_id FROM bib_entries WHERE project_id = ?', [$pid]) as $b) {
            $progress['total']++;
            $id = (int)$b['id'];
            if (!$b['pdf_blob_id']) { $entries[$id] = ['state' => 'no_pdf', 'models' => [], 'last_task' => 0]; continue; }
            $progress['with_pdf']++;
            $own = array_values(array_filter($tasks[$id] ?? [], fn($t) => (int)$t['source_blob_id'] === (int)$b['pdf_blob_id']));
            $statuses = array_column($own, 'status');
            $models = array_values(array_unique(array_filter(array_map(fn($t) => $t['status'] === 'done' ? $t['ai_model'] : null, $own))));
            $last = $own ? end($own) : null;
            $hash = self::commentsHash(self::commentScope($notes[$id] ?? [], 'blob_id', (int)$b['pdf_blob_id']));
            $done = array_filter($own, fn($t) => $t['status'] === 'done');
            $current = (bool)array_filter($done, fn($t) => (string)$t['comments_hash'] === $hash);
            $open = (bool)array_intersect(['pending', 'running'], $statuses);
            $state = $open ? 'queued' : ($current ? 'done' : ($done ? 'comments' : ($last && $last['status'] === 'failed' ? 'failed' : 'none')));
            $entries[$id] = ['state' => $state, 'models' => $models, 'last_task' => $last ? (int)$last['id'] : 0];
            if ($done) $progress['extracted']++;
            if ($state === 'comments') $progress['new_comments']++;
            elseif ($state === 'queued') $progress['queued']++;
            elseif ($state === 'failed') $progress['failed']++;
            elseif ($state === 'none') $progress['remaining']++;
        }
        return ['entries' => $entries, 'progress' => $progress];
    }

    /** Where a conversation stands. Only for its participants: the caller checked access. */
    public static function conversationExtraction(int $pid, int $cid): array
    {
        $tasks = Db::all("SELECT status, ai_model, comments_hash FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND source_type = 'conversation' AND source_id = ? ORDER BY id", [$pid, $cid]);
        $latest = self::conversationSnapshot($pid, $cid, false)['hash'];
        $done = array_filter($tasks, fn($t) => $t['status'] === 'done');
        $last = $tasks ? end($tasks) : null;
        $state = array_intersect(['pending', 'running'], array_column($tasks, 'status')) ? 'queued'
            : (array_filter($done, fn($t) => (string)$t['comments_hash'] === $latest) ? 'done'
            : ($done ? 'new_messages' : ($last && $last['status'] === 'failed' ? 'failed' : 'none')));
        $outside = self::outsideMembers($pid, $cid);
        return ['state' => $state, 'models' => array_values(array_unique(array_filter(array_column($done, 'ai_model')))), 'private' => $outside > 0, 'outside' => $outside];
    }

    /**
     * The AI clients of this project: who is online, what each one is doing, and the computing time it spent here.
     * Time is what clients measured on finished tasks. Stats count only this project, and private subjects stay unnamed.
     */
    public static function computers(int $pid): array
    {
        $now = time();
        $online = gmdate('Y-m-d H:i:s', $now - self::ONLINE_SECONDS);
        $latest = self::latestVersion();
        $periods = ['d7' => gmdate('Y-m-d H:i:s', $now - 7 * 86400), 'd30' => gmdate('Y-m-d H:i:s', $now - 30 * 86400), 'all' => ''];
        $blank = fn() => ['done' => 0, 'failed' => 0, 'ms' => 0, 'proving_ms' => 0];
        $group = fn() => ['standard' => ['done' => 0, 'failed' => 0, 'ms' => 0, 'facts' => 0], 'proving' => ['done' => 0, 'failed' => 0, 'ms' => 0, 'facts' => 0]];
        $list = [];
        $key = fn($uid, $name) => $uid . "\n" . $name;
        foreach (Db::all('SELECT c.user_id, c.name, c.ai_model, c.version, c.last_seen_at, u.name AS user_name FROM ai_clients c JOIN users u ON u.id = c.user_id
                          JOIN project_members m ON m.user_id = c.user_id AND m.project_id = ?', [$pid]) as $c) {
            $list[$key($c['user_id'], $c['name'])] = ['user_id' => (int)$c['user_id'], 'user_name' => $c['user_name'], 'name' => $c['name'], 'ai_model' => $c['ai_model'],
                'version' => $c['version'], 'last_seen_at' => $c['last_seen_at'], 'online' => $c['last_seen_at'] >= $online, 'member' => true];
        }
        $totals = array_map(fn() => $blank() + ['by_kind' => [], 'groups' => $group()], $periods);
        $rows = Db::all("SELECT t.claimed_by, t.client_name, t.status, t.kind, t.ai_generation_ms, t.finished_at, t.result_json, u.name AS user_name FROM ai_tasks t JOIN users u ON u.id = t.claimed_by
                         WHERE t.project_id = ? AND t.status IN ('done', 'failed') AND t.finished_at IS NOT NULL", [$pid]);
        foreach ($rows as $t) {
            $k = $key($t['claimed_by'], (string)$t['client_name']);
            $list[$k] ??= ['user_id' => (int)$t['claimed_by'], 'user_name' => $t['user_name'], 'name' => (string)$t['client_name'], 'ai_model' => null, 'version' => null,
                'last_seen_at' => null, 'online' => false, 'member' => false];
            $list[$k]['last_done_at'] = max((string)($list[$k]['last_done_at'] ?? ''), (string)$t['finished_at']);
            foreach ($periods as $p => $since) {
                $list[$k]['stats'][$p] ??= $blank();
                if ($since !== '' && $t['finished_at'] < $since) continue;
                $ms = (int)$t['ai_generation_ms'];
                $g = $t['kind'] === 'derive' ? 'proving' : 'standard';
                $list[$k]['stats'][$p][$t['status']]++;
                $list[$k]['stats'][$p]['ms'] += $ms;
                if ($g === 'proving') $list[$k]['stats'][$p]['proving_ms'] += $ms;
                $totals[$p][$t['status']]++;
                $totals[$p]['ms'] += $ms;
                $totals[$p]['groups'][$g][$t['status']]++;
                $totals[$p]['groups'][$g]['ms'] += $ms;
                if ($t['status'] === 'done') $totals[$p]['groups'][$g]['facts'] += count((array)(json_decode((string)$t['result_json'], true)['fact_ids'] ?? []));
                $totals[$p]['by_kind'][$t['kind']] = ['n' => ($totals[$p]['by_kind'][$t['kind']]['n'] ?? 0) + ($t['status'] === 'done' ? 1 : 0), 'ms' => ($totals[$p]['by_kind'][$t['kind']]['ms'] ?? 0) + $ms];
            }
        }
        $working = Db::all("SELECT t.id, t.kind, t.claimed_by, t.client_name, t.started_at, t.conversation_id, " . self::subjectSql() . " AS subject
                            FROM ai_tasks t " . self::subjectJoins() . " WHERE t.project_id = ? AND t.status = 'running' AND t.lease_until >= ?", [$pid, gmdate('Y-m-d H:i:s', $now)]);
        foreach ($working as $w) {
            $k = $key($w['claimed_by'], (string)$w['client_name']);
            if (!isset($list[$k])) continue;
            $hidden = $w['conversation_id'] && !Db::value('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$w['conversation_id'], Auth::id()]);
            $list[$k]['working'] = ['id' => $hidden ? null : (int)$w['id'], 'kind' => $w['kind'], 'subject' => $hidden ? null : $w['subject'], 'private' => (bool)$hidden, 'started_at' => $w['started_at']];
        }
        $out = [];
        foreach ($list as $c) {
            $c += ['stats' => [], 'working' => null, 'last_done_at' => null];
            foreach (array_keys($periods) as $p) $c['stats'][$p] ??= $blank();
            if (!$c['online'] && !$c['stats']['all']['done'] && !$c['stats']['all']['failed'] && !$c['working']) continue; // never worked here
            $c['outdated'] = $c['version'] && $latest ? version_compare($c['version'], $latest, '<') : false;
            $out[] = $c;
        }
        usort($out, fn($a, $b) => [$b['online'], (bool)$b['working'], $b['stats']['all']['ms']] <=> [$a['online'], (bool)$a['working'], $a['stats']['all']['ms']]);
        return ['clients' => $out, 'totals' => $totals, 'latest_version' => $latest];
    }

    /** All the computing time of a project, for standard work and for proving new facts, with the facts each produced. */
    public static function computeSummary(int $pid): array
    {
        $out = ['standard' => ['ms' => 0, 'tasks' => 0, 'facts' => 0], 'proving' => ['ms' => 0, 'tasks' => 0, 'facts' => 0]];
        foreach (Db::all("SELECT kind, status, ai_generation_ms, result_json FROM ai_tasks WHERE project_id = ? AND status IN ('done', 'failed')", [$pid]) as $t) {
            $g = $t['kind'] === 'derive' ? 'proving' : 'standard';
            $out[$g]['ms'] += (int)$t['ai_generation_ms'];
            $out[$g]['tasks']++;
            if ($t['status'] === 'done') $out[$g]['facts'] += count((array)(json_decode((string)$t['result_json'], true)['fact_ids'] ?? []));
        }
        return $out;
    }

    /** The members of this project whose AI client is running now. */
    public static function onlineMembers(int $pid): array
    {
        return array_map('intval', array_column(Db::all('SELECT DISTINCT c.user_id FROM ai_clients c JOIN project_members m ON m.user_id = c.user_id AND m.project_id = ? WHERE c.last_seen_at >= ?',
            [$pid, gmdate('Y-m-d H:i:s', time() - self::ONLINE_SECONDS)]), 'user_id'));
    }

    private static function latestVersion(): ?string
    {
        preg_match('/^VERSION = "([^"]+)"/m', (string)@file_get_contents(__DIR__ . '/../../client/oq.py', false, null, 0, 8192), $m);
        return $m[1] ?? null;
    }

    private static function subjectSql(): string
    {
        return 'COALESCE(d.title, b.title, cv.subject, q.title, s.title, f.title)';
    }

    private static function subjectJoins(): string
    {
        return "LEFT JOIN documents d ON t.source_type = 'document' AND d.id = t.source_id
                LEFT JOIN bib_entries b ON t.source_type = 'bib' AND b.id = t.source_id
                LEFT JOIN conversations cv ON t.source_type = 'conversation' AND cv.id = t.source_id
                LEFT JOIN open_questions q ON t.source_type = 'question' AND q.id = t.source_id
                LEFT JOIN proof_strategies s ON t.source_type = 'strategy' AND s.id = t.source_id
                LEFT JOIN facts f ON t.source_type = 'fact' AND f.id = t.source_id";
    }

    /** Where the questions asked to the AI in this conversation stand. Only for its participants: the caller checked access. */
    public static function conversationOpinion(int $cid): array
    {
        $asks = Db::all("SELECT id, status FROM ai_tasks WHERE kind = 'ask' AND source_type = 'message' AND conversation_id = ? ORDER BY id", [$cid]);
        $statuses = array_column($asks, 'status');
        $last = $asks ? end($asks) : null;
        $clients = (int)Db::value('SELECT COUNT(DISTINCT c.user_id) FROM ai_clients c JOIN conversation_participants p ON p.user_id = c.user_id AND p.conversation_id = ? WHERE c.last_seen_at >= ?',
            [$cid, gmdate('Y-m-d H:i:s', time() - self::ONLINE_SECONDS)]);
        return ['waiting' => count(array_keys($statuses, 'pending', true)), 'running' => count(array_keys($statuses, 'running', true)),
            'failed_task' => $last && $last['status'] === 'failed' ? (int)$last['id'] : null, 'clients' => $clients];
    }

    /** Project members who cannot read this conversation: none for a whole-project one, which every present and future member reads. */
    public static function outsideMembers(int $pid, int $cid): int
    {
        if (Db::value('SELECT visibility FROM conversations WHERE id = ?', [$cid]) === 'project') return 0;
        return (int)Db::value('SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = ? AND pm.user_id NOT IN (SELECT user_id FROM conversation_participants WHERE conversation_id = ?)', [$pid, $cid]);
    }

    /** The exact part of a conversation that an extraction may read: what exists when a person asks for it. */
    private static function conversationSnapshot(int $pid, int $cid, bool $shared): array
    {
        $message = (int)Db::value('SELECT COALESCE(MAX(id), 0) FROM messages WHERE conversation_id = ?', [$cid]);
        $comment = (int)Db::value("SELECT COALESCE(MAX(id), 0) FROM comments WHERE project_id = ? AND target_type = 'conversation' AND target_id = ?", [$pid, $cid]);
        return ['message' => $message, 'comment' => $comment, 'shared' => $shared, 'hash' => self::conversationHash($pid, $cid, $message, $comment)];
    }

    private static function conversationMessages(int $cid, int $upTo): array
    {
        return Db::all('SELECT m.id, m.body_html, m.created_at, m.edited_at, m.ai_model, u.name AS author, u.kind FROM messages m JOIN users u ON u.id = m.author_id WHERE m.conversation_id = ? AND m.id <= ? ORDER BY m.id', [$cid, $upTo]);
    }

    private static function conversationComments(int $pid, int $cid, int $upTo): array
    {
        return array_values(array_filter(self::commentRows($pid, 'conversation', $cid), fn($c) => (int)$c['id'] <= $upTo));
    }

    private static function conversationHash(int $pid, int $cid, int $message, int $comment): string
    {
        $messages = array_map(fn($m) => [(int)$m['id'], (string)$m['body_html']], self::conversationMessages($cid, $message));
        return sha1(json_encode([$messages, self::commentsHash(self::conversationComments($pid, $cid, $comment))]));
    }

    private static function snapshot(array $t): array
    {
        $s = json_decode((string)($t['snapshot_json'] ?? ''), true);
        return is_array($s) ? $s + ['message' => 0, 'comment' => 0, 'shared' => false, 'hash' => ''] : ['message' => 0, 'comment' => 0, 'shared' => false, 'hash' => ''];
    }

    private static function snapshotHash(array $t): string
    {
        $s = self::snapshot($t);
        return self::conversationHash((int)$t['project_id'], (int)$t['source_id'], (int)$s['message'], (int)$s['comment']);
    }

    /** Why this extraction may no longer run. Sharing a private conversation holds only for what the person saw. */
    private static function conversationBlocked(array $t): ?string
    {
        $pid = (int)$t['project_id']; $cid = (int)$t['source_id']; $s = self::snapshot($t);
        if (!Db::value('SELECT 1 FROM conversations WHERE id = ? AND project_id = ?', [$cid, $pid])) return 'The conversation no longer exists.';
        if (!Db::value('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$cid, $t['requested_by']])) return 'The person who asked no longer takes part in this conversation. Ask again.';
        if (self::outsideMembers($pid, $cid) > 0 && !$s['shared']) return 'This conversation became private after the request. Ask again to confirm that its results may be shared.';
        if ($s['shared'] && self::snapshotHash($t) !== (string)$s['hash']) return 'The conversation was edited after its results were approved for sharing. Ask again.';
        return null;
    }

    /** A reviewer must be independent: not the author's model, not one known to be weaker, and new on this revision. */
    private static function mayReview(array $t, ?string $model): bool
    {
        $m = strtolower(trim((string)$model));
        if ($m === '' || in_array($m, ['claude', 'codex'], true) || str_contains($m, 'default model')) return false;
        $f = Db::one('SELECT ai_model, current_revision, retracted_at FROM facts WHERE id = ?', [$t['source_id']]);
        if (!$f || $f['retracted_at']) return false;
        $author = strtolower(trim((string)$f['ai_model']));
        if ($author === $m || ModelOrder::atLeast($author, $m)) return false;
        // An alias names a line whose exact version is not known yet: it cannot review its own line.
        if (in_array($m, ['opus', 'sonnet', 'haiku'], true) && preg_match('/^claude-(?:\d+(?:-\d+)?-)?(?:opus|sonnet|haiku)/', $author)) return false;
        if ($m === 'fable' && str_starts_with($author, 'claude-fable')) return false;
        return !Db::value("SELECT 1 FROM fact_reviews WHERE fact_id = ? AND revision_no = ? AND reviewer_kind = 'agent' AND LOWER(ai_model) = ?", [$t['source_id'], $f['current_revision'], $m]);
    }

    /** The models that already finished this extraction, on this exact file or PDF. */
    private static function extractedBy(array $t): array
    {
        if ($t['kind'] !== 'extract' || !$t['source_type']) return [];
        if ($t['source_type'] === 'conversation') {
            return array_column(Db::all("SELECT DISTINCT ai_model FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND status = 'done' AND source_type = 'conversation' AND source_id = ? AND comments_hash = ?",
                [$t['project_id'], $t['source_id'], self::snapshotHash($t)]), 'ai_model');
        }
        [$col, $value] = $t['source_type'] === 'bib' ? ['source_blob_id', $t['source_blob_id']] : ['version_id', $t['version_id']];
        if (!$value) return [];
        // New comments are new information: an earlier extraction no longer covers this one.
        return array_column(Db::all("SELECT DISTINCT ai_model FROM ai_tasks WHERE project_id = ? AND kind = 'extract' AND status = 'done' AND source_type = ? AND source_id = ? AND $col = ? AND COALESCE(comments_hash, '') = ?",
            [$t['project_id'], $t['source_type'], $t['source_id'], $value, self::commentsHash(self::extractComments($t))]), 'ai_model');
    }

    private static function commentRows(int $pid, string $type, ?int $id = null): array
    {
        return Db::all('SELECT c.id, c.parent_id, c.target_id, c.body_html, c.anchor_json, c.resolved, c.ai_model, u.name AS author, u.kind AS author_kind
                        FROM comments c JOIN users u ON u.id = c.author_id WHERE c.project_id = ? AND c.target_type = ?' . ($id ? ' AND c.target_id = ?' : '') . ' ORDER BY c.id',
            $id ? [$pid, $type, $id] : [$pid, $type]);
    }

    /** The comments about this version of the text: a remark on a replaced PDF no longer applies. Replies follow their thread. */
    private static function commentScope(array $rows, string $key, int $value): array
    {
        $anchors = [];
        foreach ($rows as $c) $anchors[(int)$c['id']] = json_decode((string)$c['anchor_json'], true);
        return array_values(array_filter($rows, function ($c) use ($anchors, $key, $value) {
            $a = $anchors[(int)($c['parent_id'] ?: $c['id'])] ?? null;
            return !is_array($a) || !isset($a[$key]) || (int)$a[$key] === $value;
        }));
    }

    /** Changes when a person adds, edits, resolves or removes a comment. AI replies do not count. */
    private static function commentsHash(array $rows): string
    {
        $human = array_values(array_filter($rows, fn($c) => $c['ai_model'] === null && ($c['author_kind'] ?? 'human') === 'human'));
        return $human ? sha1(json_encode(array_map(fn($c) => [(int)$c['id'], (string)$c['body_html'], (int)$c['resolved']], $human))) : '';
    }

    private static function extractComments(array $t): array
    {
        if ($t['kind'] === 'extract' && $t['source_type'] === 'conversation') return self::conversationComments((int)$t['project_id'], (int)$t['source_id'], (int)self::snapshot($t)['comment']);
        if ($t['kind'] !== 'extract' || !in_array($t['source_type'], ['document', 'bib'], true)) return [];
        $rows = self::commentRows((int)$t['project_id'], $t['source_type'], (int)$t['source_id']);
        return $t['source_type'] === 'bib' ? self::commentScope($rows, 'blob_id', (int)$t['source_blob_id']) : self::commentScope($rows, 'version_id', (int)$t['version_id']);
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
        $bid = Db::tx(fn() => self::addSuggested($s, Auth::id(), null));
        Response::json(['ok' => true, 'bib_id' => $bid]);
    }

    /**
     * Adds a suggested reference to the bibliography, or finds it there. $check: the record that confirmed it, when no person
     * decided. @return int the bibliography entry
     */
    private static function addSuggested(array $s, int $me, ?array $check): int
    {
        $pid = (int)$s['project_id'];
        $existing = $s['doi'] ? Db::value('SELECT id FROM bib_entries WHERE project_id = ? AND LOWER(doi) = LOWER(?)', [$pid, $s['doi']]) : null;
        if ($existing) $bid = (int)$existing;
        else {
            $fields = array_filter(['title' => $s['title'], 'author' => BibTex::authorList($s['authors']), 'year' => $s['year'], 'journal' => $s['venue'],
                'doi' => $s['doi'], 'url' => $s['url'], 'eprint' => $s['arxiv'], 'archiveprefix' => $s['arxiv'] ? 'arXiv' : null], fn($v) => $v !== null && $v !== '');
            $now = Db::now();
            $bid = Db::insert('bib_entries', BibTex::columns($fields) + [
                'project_id' => $pid, 'cite_key' => BibController::uniqueKey($pid, BibController::makeKey($fields)), 'entry_type' => $s['venue'] ? 'article' : 'misc',
                'fields_json' => json_encode($fields, JSON_UNESCAPED_UNICODE), 'ai_model' => $s['ai_model'], 'ai_user_id' => $s['ai_user_id'], 'ai_generation_ms' => $s['ai_generation_ms'],
                'created_by' => $me, 'created_at' => $now, 'updated_at' => $now,
            ]);
            Activity::touch($pid, 'bib', $bid, 'created');
        }
        Db::update('bib_suggestions', ['status' => 'accepted', 'bib_id' => $bid, 'decided_by' => $check ? null : $me, 'decided_at' => Db::now(),
            'auto_added' => $check ? 1 : 0, 'verified_by' => $check['by'] ?? null], 'id = :id', ['id' => $s['id']]);
        return $bid;
    }

    /**
     * A member takes back a reference added without a person: the entry leaves the bibliography, unless people used it since
     * (a PDF, a discussion, facts found in it). The suggestion is then rejected.
     */
    public static function undoSuggestion(Request $r): never
    {
        self::humanOnly();
        $s = self::suggestion($r->int('id'), false);
        Access::member((int)$s['project_id']);
        if ($s['status'] !== 'accepted' || !$s['auto_added']) throw new HttpError(409, 'Only a reference added automatically can be taken back here.');
        $bid = (int)$s['bib_id'];
        $used = $bid && (Db::value('SELECT 1 FROM bib_entries WHERE id = ? AND pdf_blob_id IS NOT NULL', [$bid])
            || Db::value("SELECT 1 FROM comments WHERE target_type = 'bib' AND target_id = ?", [$bid])
            || Db::value("SELECT 1 FROM fact_sources WHERE source_type = 'bib' AND source_id = ?", [$bid]));
        if ($used) throw new HttpError(409, 'People used this reference since (a PDF, a discussion or facts): remove it from the bibliography instead.');
        Db::tx(function () use ($s, $bid) {
            if ($bid) Db::run('DELETE FROM bib_entries WHERE id = ?', [$bid]);
            Db::update('bib_suggestions', ['status' => 'rejected', 'bib_id' => null, 'decided_by' => Auth::id(), 'decided_at' => Db::now(), 'decision_note' => 'Taken back after it was added automatically.'], 'id = :id', ['id' => $s['id']]);
        });
        Response::json(['ok' => true]);
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
        $kinds = array_values(array_intersect((array)$r->input('kinds', self::kinds()), self::kinds()));
        if (!$kinds) throw new HttpError(422, 'No valid task kind.');
        $features = (array)$r->input('features', []);
        $caps = array_values(array_filter((array)$r->input('capabilities', []), 'is_string'));
        // A client that follows @AI instructions takes an @AI comment as one: it is stored as a question, so that older clients answer it.
        $instructs = in_array('instruct', $kinds, true) && in_array('procedures', $features, true) && !array_diff(Procedures::capabilities('instruct'), $caps);
        $asks = in_array('ask', $kinds, true);
        [$in, $params] = Db::in($instructs && !$asks ? [...$kinds, 'ask'] : $kinds);
        $project = (int)$r->input('project_id');
        // Upkeep that is due is queued now, when someone can do it.
        foreach ($project ? [$project] : array_map('intval', array_column(Db::all('SELECT project_id FROM project_members WHERE user_id = ?', [$me]), 'project_id')) as $p) {
            if (Access::isMember($p, $me)) \App\Sweeps::due($p);
        }
        $only = (int)$r->input('task_id');
        $where = ($project ? ' AND t.project_id = ?' : '') . ($only ? ' AND t.id = ?' : '');
        // A client from before this feature would fail these tasks and use up their attempts.
        if (!in_array('extract_bib', (array)$r->input('features', []), true)) $where .= " AND (t.kind <> 'extract' OR t.source_type IS NULL OR t.source_type <> 'bib')";
        if (!in_array('extract_conversation', (array)$r->input('features', []), true)) $where .= " AND (t.kind <> 'extract' OR t.source_type IS NULL OR t.source_type <> 'conversation')";
        foreach (['review', 'lean', 'latex'] as $newKind) if (!in_array($newKind, $features, true)) $where .= " AND t.kind <> '$newKind'";
        // A procedure goes to a client that runs recipes and has what it needs, or to one with its own code for it.
        $generic = in_array('procedures', $features, true);
        if (!$generic) $where .= " AND (t.source_type IS NULL OR t.source_type <> 'sweep')"; // a sweep is a recipe
        foreach (Procedures::ids() as $p) {
            $byRecipe = $generic && !array_diff(Procedures::capabilities($p), $caps);
            $own = array_key_exists($p, self::BUILT_IN) && (self::BUILT_IN[$p] === null || in_array(self::BUILT_IN[$p], $features, true));
            if (!$byRecipe && !$own) $where .= " AND t.kind <> '$p'";
        }
        $perKind = is_array($r->input('models')) ? $r->input('models') : [];
        // Tasks this model must leave to a stronger one are skipped, so they cannot hide the work behind them.
        for ($offset = 0; ; $offset += 100) {
            $candidates = Db::all(
                "SELECT t.* FROM ai_tasks t JOIN project_members m ON m.project_id = t.project_id AND m.user_id = ?
                 WHERE t.kind IN $in AND (t.status = 'pending' OR (t.status = 'running' AND t.lease_until < ?))
                   AND (t.not_before IS NULL OR t.not_before <= ?) AND " . self::visibleSql('t') . "$where
                 ORDER BY t.priority, t.id LIMIT 100 OFFSET $offset",
                array_merge([$me], $params, [$now, $now, $me], $project ? [$project] : [], $only ? [$only] : []));
            foreach ($candidates as $c) {
                if (self::waitingFor($c)) continue; // after the tasks it depends on
                $instruction = $c['kind'] === 'ask' && $c['source_type'] === 'comment' && $instructs && \App\Instructions::handles((string)Db::value('SELECT target_type FROM comments WHERE id = ?', [$c['source_id']]));
                if ($c['kind'] === 'ask' && !$asks && !$instruction) continue; // a question this client did not ask for
                if ($c['kind'] === 'extract' && $c['source_type'] === 'conversation' && ($why = self::conversationBlocked($c))) {
                    Db::run("UPDATE ai_tasks SET status = 'failed', lease_hash = NULL, lease_until = NULL, error_text = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')", [$why, $now, $now, $c['id']]);
                    continue;
                }
                $choices = array_values(array_filter(array_map(fn($x) => is_string($x) ? mb_substr($x, 0, 120) : '', (array)($perKind[$instruction ? 'instruct' : $c['kind']] ?? [])))) ?: [$model];
                $used = $choices[0];
                if ($c['kind'] === 'review') {
                    $used = null;
                    foreach ($choices as $choice) if (self::mayReview($c, $choice)) { $used = $choice; break; }
                    if ($used === null) continue; // left for a model independent of its author
                }
                // A client that can review with several models, another company's first, takes the proofs the first one may review.
                if (in_array($c['kind'], ['proof_review', 'proof_repair', 'repair_check', 'statement_fix', 'fix_check', 'relink', 'relink_check'], true) && count($choices) > 1) $used = \App\Sweeps::modelFor($c['kind'], (int)$c['project_id'], $choices) ?? $used;
                if (ModelOrder::covered(self::extractedBy($c), $used)) continue;
                $lease = bin2hex(random_bytes(24));
                $won = Db::run(
                    "UPDATE ai_tasks SET status = 'running', lease_hash = ?, lease_until = ?, attempts = attempts + 1, claimed_by = ?, client_name = ?, ai_model = ?, started_at = ?, updated_at = ?
                     WHERE id = ? AND (status = 'pending' OR (status = 'running' AND lease_until < ?))",
                    [hash('sha256', $lease), gmdate('Y-m-d H:i:s', time() + self::LEASE_SECONDS), $me, $name, $used, $now, $now, $c['id'], $now])->rowCount();
                if ($won === 1) {
                    if ($instruction) Db::update('ai_tasks', ['kind' => 'instruct'], 'id = :id', ['id' => $c['id']]);
                    // An older client ignores comments: its extraction must not count as having read them.
                    $reads = in_array('extract_comments', (array)$r->input('features', []), true);
                    if ($c['kind'] === 'extract') Db::update('ai_tasks', ['comments_hash' => $c['source_type'] === 'conversation' ? self::snapshotHash($c) : ($reads ? self::commentsHash(self::extractComments($c)) : null)], 'id = :id', ['id' => $c['id']]);
                    $t = self::row((int)$c['id']);
                    if ($t['source_type'] === 'sweep' && !($t = \App\Sweeps::take($t))) continue; // nothing left: it finished
                    if ($t['kind'] === 'notation' && $t['source_type'] === 'fact') $t = self::pinRewrite($t);
                    $ctx = self::context($t);
                    $recipe = $generic && Procedures::has((string)$t['kind']) ? ['recipe' => Procedures::recipe($t, $ctx)] : [];
                    Response::json(['task' => self::present($t) + ['lease' => $lease, 'lease_seconds' => self::LEASE_SECONDS, 'publish_private' => (bool)self::snapshot($t)['shared'], 'context' => $ctx] + $recipe]);
                }
            }
            if (count($candidates) < 100) break;
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

    /**
     * The PDF of a LaTeX document task, compiled by the client from the source it was given. The platform keeps its own source:
     * if the facts changed since, the PDF no longer matches and is refused, and the task can run again.
     */
    public static function document(Request $r): never
    {
        self::aiOnly();
        $t = self::leased($r);
        if ($t['kind'] !== 'latex' || $t['source_type'] !== 'fact') throw new HttpError(422, 'Only a LaTeX document task sends a PDF.');
        $pid = (int)$t['project_id']; $fid = (int)$t['source_id'];
        $x = LatexExport::build($pid, $fid);
        if (!hash_equals($x['sha256'], $r->str('sha256'))) throw new HttpError(409, 'The facts changed while the document was compiled: run the task again to compile the new version.');
        $pdf = base64_decode($r->str('pdf_base64'), true);
        if ($pdf === false || !str_starts_with($pdf, '%PDF-')) throw new HttpError(422, 'pdf_base64 must be a PDF file.');
        if (strlen($pdf) > 20 * 1024 * 1024) throw new HttpError(413, 'The PDF is too large (20 MB maximum).');
        $tmp = tempnam(sys_get_temp_dir(), 'oqpdf');
        file_put_contents($tmp, $pdf);
        $model = Provenance::agentModel($r);
        $facts = count($x['facts']);
        $description = 'The proof of “' . $x['title'] . '” with the ' . ($facts - 1) . ' ' . ($facts === 2 ? 'fact' : 'facts') . ' it relies on, assembled from the facts of the project'
            . ($x['models'] ? ', written by ' . implode(', ', $x['models']) : '') . '. Results of other works are cited, not proved. A new version replaces it when the facts change and the document is asked again.';
        $docModel = mb_substr(implode(', ', $x['models']) ?: (string)$model, 0, 120) ?: null;
        try {
            $id = DocumentController::saveExport($pid, $fid, $x['title'], $description, $tmp, ['main.tex' => $x['tex']] + ($x['bib'] !== '' ? ['refs.bib' => $x['bib']] : []),
                $docModel, Provenance::stamp($docModel, $r->input('generation_seconds')));
        } finally { @unlink($tmp); }
        Response::json(['document_id' => $id] + DocumentController::present($id), 201);
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
        self::finish($t, $model, $stamp, $summary, $factIds, $suggestionIds, $reply);
        Response::json(self::present(self::row((int)$t['id'])));
    }

    /**
     * A client that runs recipes sends the model's answer to a procedure. The platform checks it against the
     * procedure's schema and applies it itself, so that a new procedure needs no new client.
     */
    public static function answer(Request $r): never
    {
        self::aiOnly();
        $t = self::leased($r);
        if (!Procedures::has((string)$t['kind'])) throw new HttpError(422, 'This task is not a procedure: complete it with /complete.');
        $answer = $r->input('answer');
        if (!is_array($answer) || array_is_list($answer)) throw new HttpError(422, 'answer must be the JSON object the model returned.');
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $done = Db::tx(fn() => Procedures::apply($t, $answer, $model, $r->input('generation_seconds')));
        $reply = isset($done['reply_text']) ? self::postReply($t, mb_substr((string)$done['reply_text'], 0, 20000), $model, $stamp) : null;
        self::finish($t, $model, $stamp, mb_substr((string)($done['summary'] ?? ''), 0, 1000) ?: null, $done['fact_ids'] ?? [], $done['suggestion_ids'] ?? [], $reply);
        Response::json(self::present(self::row((int)$t['id'])));
    }

    /** The procedures of this platform, for clients to offer them to their user. */
    public static function procedures(Request $r): never
    {
        Response::json(['procedures' => Procedures::list(), 'capabilities' => Procedures::CAPABILITIES]);
    }

    private static function finish(array $t, ?string $model, array $stamp, ?string $summary, array $factIds, array $suggestionIds, ?array $reply): void
    {
        $pid = (int)$t['project_id'];
        $now = Db::now();
        Db::update('ai_tasks', ['status' => 'done', 'lease_hash' => null, 'lease_until' => null, 'ai_model' => $model, 'ai_user_id' => $stamp['ai_user_id'], 'ai_generation_ms' => $stamp['ai_generation_ms'],
            'summary_text' => $summary, 'error_text' => null,
            'result_json' => json_encode(['fact_ids' => $factIds, 'suggestion_ids' => $suggestionIds, 'reply' => $reply]), 'finished_at' => $now, 'updated_at' => $now], 'id = :id', ['id' => $t['id']]);
        // New facts, extracted or proved, are read with the whole database: merges, links, and the questions they may settle.
        if ($t['kind'] === 'extract' || ($t['kind'] === 'derive' && $factIds)) self::queueConsolidation($pid);
        if ($t['requested_by'] && (int)$t['requested_by'] !== Auth::aiUserId()) {
            Notify::send((int)$t['requested_by'], $pid, 'ai_done', ['link' => self::resultLink($t, $reply), 'excerpt' => $summary ?? 'Your AI request is done.']);
        }
    }

    public static function fail(Request $r): never
    {
        self::aiOnly();
        $t = self::leased($r);
        $error = mb_substr(trim($r->str('error')), 0, 1000) ?: 'The AI client reported an error.';
        $final = (bool)$r->input('final') || (int)$t['attempts'] >= self::MAX_ATTEMPTS;
        $now = Db::now();
        // Time spent before failing still counts as computing time, once the task stops for good.
        $spent = $final ? Provenance::milliseconds($r->input('generation_seconds')) : null;
        Db::update('ai_tasks', ($spent ? ['ai_generation_ms' => $spent, 'ai_user_id' => Auth::aiUserId()] : []) + ['status' => $final ? 'failed' : 'pending', 'lease_hash' => null, 'lease_until' => null, 'error_text' => $error,
            'not_before' => $final ? null : gmdate('Y-m-d H:i:s', time() + 120 * (int)$t['attempts']), 'finished_at' => $final ? $now : null, 'updated_at' => $now], 'id = :id', ['id' => $t['id']]);
        if ($final && $t['kind'] === 'extract') self::queueConsolidation((int)$t['project_id']);
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
        $created = []; $skipped = []; $added = [];
        // A reference whose DOI or arXiv record has its title and first author is added at once, when the project lets the AI decide.
        $auto = (bool)Db::value('SELECT consolidation_auto FROM projects WHERE id = ?', [$pid]);
        $deadline = microtime(true) + (float)\App\Config::get('bib_check.seconds', 20);
        foreach ($clean as $s) {
            if (self::isKnown($pid, $s)) { $skipped[] = $s['title']; continue; }
            $created[] = $sid = Db::insert('bib_suggestions', $s + $stamp + ['project_id' => $pid, 'task_id' => $taskId, 'status' => 'proposed', 'ai_model' => $model, 'created_at' => Db::now()]);
            if ($auto && ($s['doi'] || $s['arxiv']) && ($check = \App\BibCheck::verify($s, $deadline))) {
                $row = Db::one('SELECT * FROM bib_suggestions WHERE id = ?', [$sid]);
                foreach (['year', 'venue'] as $k) if (!$row[$k] && $check[$k]) $row[$k] = $check[$k];
                Db::tx(fn() => self::addSuggested($row, Auth::id(), $check));
                $added[] = $sid;
            }
        }
        Response::json(['created' => $created, 'skipped' => $skipped, 'added' => $added], 201);
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

    /** @return array<string, string> */
    private static function installers(): array
    {
        return ['mac-arm64' => 'open-questions-ai-mac-arm64.dmg', 'mac-x64' => 'open-questions-ai-mac-x64.dmg',
            'windows' => 'open-questions-ai-windows.exe', 'linux' => 'open-questions-ai-linux.AppImage'];
    }

    /** Public: what can be downloaded. An installer is offered only once its file is in client/releases. */
    public static function clientInfo(Request $r): never
    {
        $dir = __DIR__ . '/../../client/releases/';
        preg_match('/^VERSION = "([^"]+)"/m', (string)file_get_contents(__DIR__ . '/../../client/oq.py', false, null, 0, 8192), $m);
        $list = [];
        foreach (self::installers() as $system => $file) {
            if (!is_file($dir . $file)) continue;
            $hash = is_file($dir . $file . '.sha256') ? strtok(trim((string)file_get_contents($dir . $file . '.sha256')), " \n") : null;
            // An installer states its own version: it can be older than the command-line client.
            $own = is_file($dir . $file . '.version') ? trim((string)file_get_contents($dir . $file . '.version')) : '';
            $list[] = ['system' => $system, 'file' => $file, 'size' => filesize($dir . $file), 'version' => preg_match('/^\d+\.\d+\.\d+$/', $own) ? $own : null,
                'sha256' => is_string($hash) && preg_match('/^[0-9a-f]{64}$/', $hash) ? $hash : null];
        }
        Response::json(['api_level' => self::API_LEVEL, 'min_version' => ClientProtocol::MIN_VERSION, 'version' => $m[1] ?? null, 'script' => 'api/client/oq.py', 'script_sha256' => hash_file('sha256', __DIR__ . '/../../client/oq.py'), 'installers' => $list]);
    }

    public static function clientDownload(Request $r): never
    {
        $system = (string)($r->query['system'] ?? '');
        $file = self::installers()[$system] ?? null;
        $path = $file ? __DIR__ . '/../../client/releases/' . $file : null;
        if (!$path || !is_file($path)) throw new HttpError(404, 'This installer is not available.');
        while (ob_get_level()) ob_end_clean();
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . $file . '"');
        header('Content-Length: ' . filesize($path));
        header('X-Content-Type-Options: nosniff');
        readfile($path);
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

    private static function suggestion(int $id, bool $waiting = true): array
    {
        $s = Db::one('SELECT * FROM bib_suggestions WHERE id = ?', [$id]);
        if (!$s || !Access::role((int)$s['project_id'])) throw new HttpError(404, 'Suggestion not found.');
        if ($waiting && $s['status'] !== 'proposed') throw new HttpError(409, 'This suggestion was already handled.');
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
            if ($reply['target_type'] === 'notation') return ['view' => 'facts', 'query' => ['mode' => 'notation', 'notation' => $reply['target_id'], 'comment' => $reply['root']]];
            $view = ['oquestion' => 'questions', 'conversation' => 'conversations', 'document' => 'files', 'bib' => 'bib', 'fact' => 'facts'][$reply['target_type']] ?? null;
            if ($view) return ['view' => $view, 'id' => $reply['target_id'], 'comment' => $reply['root']];
        }
        if ($t['kind'] === 'consolidate') return ['view' => 'facts', 'query' => ['mode' => 'consolidate']];
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
        // Every AI writing mathematics for the project follows the agreed notation. Proposals are only shown when proposing.
        if (in_array($t['kind'], ['extract', 'notation', 'derive', 'ask'], true)) $ctx['notation'] = NotationController::forTask($pid, !($t['kind'] === 'notation' && $type === null), $t['kind'] === 'notation');
        if ($t['kind'] === 'notation' && $type === null) {
            // Reviewing the notation: the symbols that facts define for themselves, and every fact with its source.
            $ctx['local_notation'] = NotationController::shared($pid, 1, 300);
            $ctx['fact_texts'] = array_map(fn($f) => ['id' => (int)$f['id'], 'label' => $f['label'], 'kind' => $f['kind'], 'title' => $f['title'],
                'statement' => mb_substr(Sanitizer::toText((string)$f['statement_html']), 0, 1500), 'glossary' => json_decode((string)$f['glossary_json'], true) ?: null,
                'source' => Db::value("SELECT COALESCE(b.cite_key, d.title) FROM fact_sources s LEFT JOIN bib_entries b ON s.source_type = 'bib' AND b.id = s.source_id LEFT JOIN documents d ON s.source_type = 'document' AND d.id = s.source_id WHERE s.fact_id = ? AND s.revision_no = ? AND s.covers <> 'context' LIMIT 1", [$f['id'], $f['current_revision']])],
                Db::all('SELECT f.id, f.label, f.kind, f.title, f.current_revision, r.statement_html, r.glossary_json FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL ORDER BY f.id LIMIT 400', [$pid]));
        }
        if ($t['kind'] === 'consolidate' && $type !== 'sweep') $ctx += ConsolidationController::context($pid);
        if ($t['kind'] === 'consolidate' && $type === 'sweep') {
            // Symbols several facts define, with no entry yet: each with its spellings, its meanings and the facts that give them.
            $want = array_flip(json_decode((string)$t['snapshot_json'], true)['symbols'] ?? []);
            $labels = array_column(Db::all('SELECT id, label FROM facts WHERE project_id = ? AND deleted_at IS NULL', [$pid]), 'label', 'id');
            $ctx['symbols'] = [];
            // An entry still proposed comes with the symbol: settling it means adopting it or keeping it local by its id.
            $proposed = [];
            foreach (Db::all("SELECT id, symbol, meaning_html, note_html, variants_json, facts_json FROM notations WHERE project_id = ? AND status = 'proposed'", [$pid]) as $n) {
                $proposed[NotationController::notionKey($n['symbol'])] ??= $n;
            }
            $entryOf = fn(array $n) => ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'meaning' => Sanitizer::toText((string)$n['meaning_html']),
                'note' => $n['note_html'] ? Sanitizer::toText((string)$n['note_html']) : null, 'variants' => json_decode((string)$n['variants_json'], true) ?: []];
            $fact = fn($f) => ['id' => (int)$f, 'label' => $labels[$f] ?? null];
            foreach (NotationController::shared($pid, 2, 1000) as $x) {
                $k = NotationController::notionKey($x['symbol']);
                if (!isset($want[$k])) continue;
                unset($want[$k]);
                $ctx['symbols'][] = ['symbol' => $x['symbol'], 'spellings' => $x['spellings'], 'facts' => $x['facts'],
                    // Numbered as the groups of equivalent wordings name them.
                    'meanings' => array_map(fn($m, $i) => ['no' => $i + 1, 'meaning' => $m['meaning'], 'facts' => array_map($fact, array_slice($m['facts'], 0, 8))], $x['meanings'], array_keys($x['meanings'])),
                    'entry' => isset($proposed[$k]) ? $entryOf($proposed[$k]) : null, 'same_term' => NotationController::sameTerm($pid, (string)$x['symbol'])];
            }
            foreach (array_keys($want) as $k) {
                if (!isset($proposed[$k])) continue;
                $n = $proposed[$k]; $facts = array_slice(array_map('intval', json_decode((string)$n['facts_json'], true) ?: []), 0, 8);
                $ctx['symbols'][] = ['symbol' => $n['symbol'], 'spellings' => [$n['symbol']], 'facts' => count($facts), 'meanings' => [], 'entry' => $entryOf($n) + ['facts' => array_map($fact, $facts)]];
            }
            $ctx['notation'] = NotationController::forTask($pid, false);
            // Entries written with parameters nobody typed: what each one stands for.
            $ctx['entries_to_type'] = [];
            foreach (json_decode((string)$t['snapshot_json'], true)['types'] ?? [] as $id) {
                $n = Db::one('SELECT id, symbol, meaning_html, status, params_json FROM notations WHERE id = ? AND project_id = ?', [(int)$id, $pid]);
                if ($n) $ctx['entries_to_type'][] = ['id' => (int)$n['id'], 'symbol' => $n['symbol'], 'status' => $n['status'], 'meaning' => Sanitizer::toText((string)$n['meaning_html']),
                    'params' => array_column(NotationController::paramsOf($n), 'name')];
            }
        }
        if ($t['kind'] === 'notation' && $type === 'sweep') {
            // A batch of facts to write again in the agreed notation, each with what its source meant by its symbols.
            $ctx['facts_to_rewrite'] = [];
            foreach (self::batchFacts($t) as $fid) {
                $f = Db::one('SELECT f.id, f.label, f.title, f.kind, f.current_revision, r.statement_html, r.proof_html, r.glossary_json FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE f.id = ?', [$fid]);
                $ctx['facts_to_rewrite'][] = ['fact_id' => $fid, 'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['kind'],
                    'statement' => Sanitizer::toText((string)$f['statement_html']), 'proof' => $f['proof_html'] ? Sanitizer::toText((string)$f['proof_html']) : null,
                    'glossary' => json_decode((string)$f['glossary_json'], true) ?: null,
                    // A rewrite of this notation found unfaithful: what changed in the meaning, not to do again.
                    'earlier_rewrite_problem' => Db::value("SELECT check_note FROM fact_rephrasings WHERE fact_id = ? AND revision_no = ? AND notation_hash = ? AND check_verdict = 'unfaithful' ORDER BY id DESC LIMIT 1", [$fid, $f['current_revision'], NotationController::hashFor($pid, (int)$fid)]) ?: null,
                    'sources' => array_values(array_map(fn($s) => ['label' => $s['label'] ?? $s['type'], 'quote' => $s['quote']], array_filter(FactController::presentSources($fid, (int)$f['current_revision']), fn($s) => !$s['hidden'] && $s['covers'] !== 'context')))];
            }
        }
        if ($t['kind'] === 'source_check' && in_array($type, [null, 'sweep'], true)) {
            // A batch: the cited results found in one source, with that document or the PDF of that reference when the project has it.
            $ctx['cited_results'] = [];
            foreach (self::batchFacts($t) as $fid) {
                $f = Db::one('SELECT f.id, f.label, f.title, f.current_revision, r.statement_html, r.external_refs_json FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE f.id = ?', [$fid]);
                $srcs = array_values(array_filter(FactController::presentSources($fid, (int)$f['current_revision']), fn($s) => !$s['hidden'] && $s['covers'] !== 'context'));
                $ctx['cited_results'][] = ['id' => $fid, 'label' => $f['label'], 'title' => $f['title'], 'statement' => Sanitizer::toText((string)$f['statement_html']),
                    'references' => json_decode((string)$f['external_refs_json'], true), 'sources' => array_map(fn($s) => ['type' => $s['type'], 'label' => $s['label'] ?? $s['type'], 'page' => $s['page'] ?? null, 'quote' => $s['quote']], $srcs)];
            }
            $doc = self::sourceCheckDocument($t);
            if ($doc) $ctx['document'] = $doc;
        }
        if ($t['kind'] === 'rewrite_check') {
            // Each rewrite beside the original it must say exactly, with the notation it follows.
            $ctx['notation'] = NotationController::forTask($pid, true, true);
            $ctx['rewrites'] = [];
            foreach (self::batchItems($t) as $xid) {
                $x = Db::one('SELECT x.*, f.label, f.title, r.statement_html AS o_statement, r.proof_html AS o_proof, r.glossary_json FROM fact_rephrasings x JOIN facts f ON f.id = x.fact_id
                              JOIN fact_revisions r ON r.fact_id = x.fact_id AND r.revision_no = x.revision_no WHERE x.id = ? AND f.project_id = ?', [$xid, $pid]);
                if (!$x) continue;
                $ctx['rewrites'][] = ['rewrite_id' => $xid, 'fact_id' => (int)$x['fact_id'], 'label' => $x['label'], 'title' => $x['title'],
                    'original' => ['statement' => Sanitizer::toText((string)$x['o_statement']), 'proof' => $x['o_proof'] ? Sanitizer::toText((string)$x['o_proof']) : null, 'glossary' => json_decode((string)$x['glossary_json'], true) ?: null],
                    'rewrite' => ['statement' => Sanitizer::toText((string)$x['statement_html']), 'proof' => $x['proof_html'] ? Sanitizer::toText((string)$x['proof_html']) : null,
                        'uses' => json_decode((string)$x['uses_json'], true) ?: [], 'local_notation' => json_decode((string)$x['local_json'], true) ?: (object)[]]];
            }
        }
        if ($t['kind'] === 'second_reading') $ctx += ConsolidationController::secondContext($pid, self::batchItems($t));
        if (in_array($t['kind'], ['proof_repair', 'repair_check'], true)) $ctx += \App\ProofRepair::context($pid, self::batchItems($t));
        if (in_array($t['kind'], ['statement_fix', 'fix_check'], true)) $ctx += \App\StatementFix::context($pid, self::batchItems($t));
        if (in_array($t['kind'], ['relink', 'relink_check'], true)) $ctx += \App\Relink::context($pid, self::batchItems($t));
        if ($t['kind'] === 'proof_review') {
            // Each proof with what it may rely on: its dependencies, assumed as stated, and the outside results it still uses.
            $graph = array_column(FactController::graph($pid)['facts'], null, 'id');
            $ctx['facts'] = [];
            foreach (self::batchFacts($t) as $fid) {
                $f = Db::one('SELECT f.id, f.label, f.title, f.kind, r.statement_html, r.proof_html, r.external_refs_json FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE f.id = ? AND f.project_id = ?', [$fid, $pid]);
                if (!$f) continue;
                $ctx['facts'][] = ['fact_id' => (int)$f['id'], 'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['kind'],
                    'statement' => Sanitizer::toText((string)$f['statement_html']), 'proof' => Sanitizer::toText((string)$f['proof_html']),
                    'definitions' => FactController::definitions($pid, (int)$f['id'], (int)$graph[$fid]['current_revision']),
                    'external_refs' => json_decode((string)$f['external_refs_json'], true),
                    // Where the fact was taken from, so that a base system or a hypothesis changed by extraction is seen.
                    'sources' => array_values(array_map(fn($s) => ['label' => $s['label'] ?? $s['type'], 'page' => $s['page'] ?? null, 'quote' => $s['quote']], array_filter(FactController::presentSources($fid, (int)$graph[$fid]['current_revision']), fn($s) => !$s['hidden'] && $s['covers'] !== 'context'))),
                    'outside_refs' => array_values(array_map(fn($x) => ['label' => $x['label'], 'settled' => $x['resolved']], $graph[$fid]['outside_refs'] ?? [])),
                    'dependencies' => array_map(fn($d) => ['label' => $d['label'], 'title' => $d['title'], 'statement' => Sanitizer::toText((string)$d['statement_html']),
                        'basis' => $graph[(int)$d['id']]['basis'] ?? null, 'status' => $graph[(int)$d['id']]['status'] ?? null], Db::all(
                        'SELECT f.id, f.label, f.title, r.statement_html FROM fact_deps d JOIN facts f ON f.id = d.depends_on_id JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE d.fact_id = ? LIMIT 50', [$fid]))];
            }
        }
        if ($t['kind'] === 'extract') {
            $ctx['comments'] = array_slice(array_map(function ($c) {
                $a = json_decode((string)$c['anchor_json'], true);
                return ['id' => (int)$c['id'], 'reply_to' => $c['parent_id'] ? (int)$c['parent_id'] : null, 'author' => $c['author'], 'is_ai' => $c['ai_model'] !== null || $c['author_kind'] !== 'human',
                    'resolved' => (bool)$c['resolved'], 'page' => is_array($a) && isset($a['page']) ? (int)$a['page'] : null, 'on_passage' => is_array($a) && isset($a['quote']) ? mb_substr((string)$a['quote'], 0, 1000) : null,
                    'text' => mb_substr(Sanitizer::toText((string)$c['body_html']), 0, 4000)];
            }, self::extractComments($t)), 0, 200);
        }
        if ($type === 'document') $ctx['document'] = self::documentContext($id, $t['version_id'] ? (int)$t['version_id'] : null);
        if ($type === 'bib') $ctx['reference'] = Db::one('SELECT id, cite_key, title, authors, year, venue, doi, CASE WHEN pdf_blob_id IS NULL THEN 0 ELSE 1 END AS has_pdf FROM bib_entries WHERE id = ? AND project_id = ?', [$id, $pid]) ?: null;
        if ($type === 'conversation' && $t['kind'] === 'extract') {
            $rows = self::conversationMessages($id, (int)self::snapshot($t)['message']);
            $read = []; $chars = 0;
            foreach (array_reverse(array_slice($rows, -self::MAX_CONVERSATION_MESSAGES)) as $m) {
                $text = Sanitizer::toText((string)$m['body_html']);
                if ($read && $chars + mb_strlen($text) > self::MAX_CONVERSATION_CHARS) break;
                $chars += mb_strlen($text);
                $read[] = ['id' => (int)$m['id'], 'author' => $m['author'], 'is_ai' => $m['ai_model'] !== null || $m['kind'] !== 'human', 'at' => $m['created_at'], 'edited' => $m['edited_at'] !== null, 'text' => $text];
            }
            $ctx['conversation'] = ['id' => $id, 'subject' => Db::value('SELECT subject FROM conversations WHERE id = ?', [$id]), 'messages' => array_reverse($read), 'omitted_older_messages' => count($rows) - count($read)];
        }
        if ($type === 'message') {
            $cid = (int)$t['conversation_id'];
            // The question is the last message here, even if people replied before a client took it.
            $ctx['thread'] = self::thread(Db::all('SELECT * FROM (SELECT m.id, m.body_html, m.created_at, u.name AS author, u.kind FROM messages m JOIN users u ON u.id = m.author_id WHERE m.conversation_id = ? AND m.id <= ? ORDER BY m.id DESC LIMIT 100) x ORDER BY id', [$cid, $id]));
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
        if ($t['kind'] === 'ask') self::askFacts($t, $ctx);
        if ($t['kind'] === 'instruct' && $type === 'comment') $ctx += \App\Instructions::context($pid, $id);
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
            // The fact as the project writes it, when an AI rewrote it in the agreed notation and nobody found it unfaithful.
            if (in_array($t['kind'], ['derive', 'ask'], true)) {
                $x = array_values(array_filter(NotationController::forFact($id, $pid, (int)$ctx['fact']['current_revision']), fn($r) => $r['current'] && !$r['unchanged'] && $r['check_verdict'] !== 'unfaithful'))[0] ?? null;
                if ($x) {
                    $ctx['fact']['statement_in_project_notation'] = Sanitizer::toText((string)$x['statement_html']);
                    if ($x['proof_html']) $ctx['fact']['proof_in_project_notation'] = Sanitizer::toText((string)$x['proof_html']);
                }
            }
            if ($t['kind'] === 'notation') {
                $g = Db::value('SELECT glossary_json FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$id, $ctx['fact']['current_revision']]);
                $ctx['fact']['glossary'] = json_decode((string)$g, true) ?: null;
                $ctx['fact']['sources'] = array_map(fn($s) => ['label' => $s['label'] ?? $s['type'], 'quote' => $s['quote']], array_filter(FactController::presentSources($id, (int)$ctx['fact']['current_revision']), fn($s) => !$s['hidden'] && $s['covers'] !== 'context'));
            }
            if ($t['kind'] === 'source_check') {
                $ctx['fact']['references'] = json_decode((string)Db::value('SELECT external_refs_json FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$id, $ctx['fact']['current_revision']]), true);
                $ctx['fact']['sources'] = array_values(array_map(fn($s) => ['type' => $s['type'], 'label' => $s['label'] ?? $s['type'], 'page' => $s['page'] ?? null, 'quote' => $s['quote']],
                    array_filter(FactController::presentSources($id, (int)$ctx['fact']['current_revision']), fn($s) => !$s['hidden'] && $s['covers'] !== 'context')));
                unset($ctx['fact']['proof']);
                $doc = self::sourceCheckDocument($t);
                if ($doc) $ctx['document'] = $doc;
            }
            if (in_array($t['kind'], ['review', 'lean'], true)) {
                $ctx['fact']['external_refs'] = json_decode((string)Db::value('SELECT external_refs_json FROM fact_revisions WHERE fact_id = ? AND revision_no = ?', [$id, $ctx['fact']['current_revision']]), true);
                // What the proof may rely on: each dependency is assumed. A cited result is a result of another work, accepted or not by people.
                $graph = array_column(FactController::graph($pid)['facts'], null, 'id');
                $ctx['fact']['outside_refs'] = array_values(array_map(fn($x) => ['label' => $x['label'], 'settled' => $x['resolved']], $graph[$id]['outside_refs'] ?? []));
                $ctx['dependencies'] = array_map(fn($d) => ['id' => (int)$d['id'], 'label' => $d['label'], 'title' => $d['title'], 'statement' => Sanitizer::toText((string)$d['statement_html']),
                    'basis' => $graph[(int)$d['id']]['basis'] ?? null, 'status' => $graph[(int)$d['id']]['status'] ?? null], Db::all(
                    'SELECT f.id, f.label, f.title, r.statement_html FROM fact_deps d JOIN facts f ON f.id = d.depends_on_id JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision WHERE d.fact_id = ? LIMIT 50', [$id]));
                // The meaning of its terms, and what an empty list of dependencies means: a referee without them reports false gaps.
                $ctx['fact']['definitions'] = FactController::definitions($pid, $id, (int)$ctx['fact']['current_revision']);
                // A Lean proof may take each dependency as a hypothesis; one that compiles already shows how it was stated in Lean.
                if ($t['kind'] === 'lean') foreach ($ctx['dependencies'] as &$d) {
                    $l = Db::one("SELECT l.code, l.decl_name FROM fact_lean l JOIN facts f ON f.id = l.fact_id AND l.revision_no = f.current_revision
                                  WHERE l.fact_id = ? AND l.check_status = 'compiles' AND l.incomplete = 0 ORDER BY l.assumes_json IS NULL DESC, l.id DESC LIMIT 1", [$d['id']]);
                    if ($l) $d['lean'] = ['decl_name' => $l['decl_name'], 'code' => mb_substr((string)$l['code'], 0, 60000)];
                }
                unset($d);
                if (!$ctx['dependencies']) $ctx['dependencies_note'] = 'This proof relies on no other fact of the database: judge it on its own, with its definitions and standard facts.';
            }
        }
        // The document as the platform assembles it now: the client compiles it, and the platform accepts the PDF only of this source.
        if ($t['kind'] === 'latex' && $t['source_type'] === 'fact') {
            $x = LatexExport::build((int)$t['project_id'], (int)$t['source_id']);
            $ctx['latex'] = ['files' => ['main.tex' => $x['tex']] + ($x['bib'] !== '' ? ['refs.bib' => $x['bib']] : []), 'sha256' => $x['sha256'], 'title' => $x['title'], 'facts' => $x['facts']];
        }
        if (isset($ctx['question']['body_html'])) { $ctx['question']['body'] = Sanitizer::toText((string)$ctx['question']['body_html']); unset($ctx['question']['body_html']); }
        return $ctx;
    }

    /** A question to the AI is often about facts: it reads their statements, and the whole of the facts its question cites. */
    private static function askFacts(array $t, array &$ctx): void
    {
        $pid = (int)$t['project_id'];
        $rows = Db::all('SELECT f.id, f.label, f.title, f.kind, r.statement_html, r.proof_html FROM facts f JOIN fact_revisions r ON r.fact_id = f.id AND r.revision_no = f.current_revision
            WHERE f.project_id = ? AND f.deleted_at IS NULL AND f.retracted_at IS NULL ORDER BY f.id DESC LIMIT 300', [$pid]);
        $said = (string)$t['prompt_text'] . ' ' . implode(' ', array_column($ctx['thread'] ?? [], 'text'));
        preg_match_all('/@\{fact:([^}]+)\}/', $said, $m);  // a mention keeps the fact's label, a model may write its id
        $cited = array_slice(array_unique($m[1]), 0, 10);
        $ctx['facts'] = array_map(fn($f) => ['id' => (int)$f['id'], 'label' => $f['label'], 'title' => $f['title'], 'kind' => $f['kind'],
            'statement' => mb_substr(Sanitizer::toText((string)$f['statement_html']), 0, 800)], $rows);
        $ctx['cited_facts'] = [];
        foreach ($rows as $f) if (in_array((string)$f['id'], $cited, true) || in_array((string)$f['label'], $cited, true)) $ctx['cited_facts'][] = ['id' => (int)$f['id'], 'label' => $f['label'], 'title' => $f['title'],
            'statement' => mb_substr(Sanitizer::toText((string)$f['statement_html']), 0, 6000), 'proof' => mb_substr(Sanitizer::toText((string)$f['proof_html']), 0, 12000)];
    }

    private static function thread(array $rows): array
    {
        return array_map(fn($m) => ['id' => (int)$m['id'], 'author' => $m['author'], 'is_ai' => $m['kind'] === 'agent', 'at' => $m['created_at'], 'text' => Sanitizer::toText((string)$m['body_html'])], $rows);
    }

    /**
     * The text a source check reads: the document its cited results were found in, or the PDF of their reference. A batch shares
     * one source; when its results come from several, none is given. Null: the AI has only web search, and says when it could not read.
     */
    public static function sourceCheckDocument(array $t): ?array
    {
        $facts = $t['source_type'] === 'fact' ? [(int)$t['source_id']] : self::batchFacts($t);
        $found = [];
        foreach ($facts as $fid) {
            $s = self::readableSource($fid);
            $found[$s ? $s[0] . ':' . $s[1] : ''] = $s;
        }
        if (count($found) !== 1 || !($s = reset($found))) return null;
        return $s[0] === 'document' ? self::documentContext($s[1], null) : self::referenceDocument($s[1]);
    }

    /** The text of a fact's source, as a task reads it: its project file, or the PDF of its reference. */
    public static function factSourceDocument(int $fid): ?array
    {
        $s = self::readableSource($fid);
        if (!$s) return null;
        return $s[0] === 'document' ? self::documentContext($s[1], null) : self::referenceDocument($s[1]);
    }

    /** Where a cited result can be read: the project file it was found in, else its reference when that has a PDF. @return ?array{0: string, 1: int} */
    public static function readableSource(int $fid): ?array
    {
        $rev = (int)Db::value('SELECT current_revision FROM facts WHERE id = ?', [$fid]);
        $doc = Db::value("SELECT s.source_id FROM fact_sources s JOIN documents d ON d.id = s.source_id AND d.deleted_at IS NULL WHERE s.fact_id = ? AND s.revision_no = ? AND s.source_type = 'document' AND s.covers <> 'context' LIMIT 1", [$fid, $rev]);
        if ($doc) return ['document', (int)$doc];
        $bib = Db::value("SELECT s.source_id FROM fact_sources s JOIN bib_entries b ON b.id = s.source_id AND b.pdf_blob_id IS NOT NULL WHERE s.fact_id = ? AND s.revision_no = ? AND s.source_type = 'bib' AND s.covers <> 'context' LIMIT 1", [$fid, $rev]);
        return $bib ? ['bib', (int)$bib] : null;
    }

    /** The PDF of a reference, shaped as a document with one file, which clients download from /api/files/bib/{id}. */
    private static function referenceDocument(int $bid): ?array
    {
        $b = Db::one('SELECT id, cite_key, title FROM bib_entries WHERE id = ? AND pdf_blob_id IS NOT NULL', [$bid]);
        if (!$b) return null;
        return ['id' => null, 'reference_id' => (int)$b['id'], 'title' => $b['title'], 'description' => null, 'origin' => 'reference', 'current_version_id' => null, 'version_id' => null,
            'files' => [['id' => 'bib/' . (int)$b['id'], 'role' => 'pdf', 'filename' => $b['cite_key'] . '.pdf']]];
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
        if ($type === 'bib') {
            $pid = Db::value('SELECT project_id FROM bib_entries WHERE id = ?', [$id]);
            return $pid ? (int)$pid : null;
        }
        if ($type === 'conversation') {
            // Someone outside it cannot learn that it exists.
            $pid = Db::value('SELECT c.project_id FROM conversations c JOIN conversation_participants p ON p.conversation_id = c.id AND p.user_id = ? WHERE c.id = ?', [Auth::id(), $id]);
            return $pid ? (int)$pid : null;
        }
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
                       d.title AS document_title, b.title AS bib_title, q.title AS question_title, s.title AS strategy_title, f.title AS fact_title, cv.subject AS conversation_title
                FROM ai_tasks t LEFT JOIN users r ON r.id = t.requested_by LEFT JOIN users c ON c.id = t.claimed_by
                LEFT JOIN documents d ON t.source_type = \'document\' AND d.id = t.source_id
                LEFT JOIN bib_entries b ON t.source_type = \'bib\' AND b.id = t.source_id
                LEFT JOIN open_questions q ON t.source_type = \'question\' AND q.id = t.source_id
                LEFT JOIN proof_strategies s ON t.source_type = \'strategy\' AND s.id = t.source_id
                LEFT JOIN facts f ON t.source_type = \'fact\' AND f.id = t.source_id
                LEFT JOIN conversations cv ON t.source_type = \'conversation\' AND cv.id = t.source_id';
    }

    private static function row(int $id): ?array
    {
        return Db::one(self::listSql() . ' WHERE t.id = ?', [$id]);
    }

    private static function present(array $t): array
    {
        $result = json_decode((string)($t['result_json'] ?? ''), true) ?: ['fact_ids' => [], 'suggestion_ids' => [], 'reply' => null];
        $subject = $t['document_title'] ?? $t['bib_title'] ?? $t['conversation_title'] ?? $t['question_title'] ?? $t['strategy_title'] ?? $t['fact_title'] ?? null;
        $snap = json_decode((string)$t['snapshot_json'], true) ?: [];
        if ($t['source_type'] === 'sweep' && !($snap['facts'] ?? $snap['items'] ?? [])) {
            // A sweep takes its batch when a client takes it.
            $subject = ['notation' => 'facts not yet in the project notation', 'source_check' => 'cited results not yet checked',
                'rewrite_check' => 'rewrites not yet compared with their original', 'second_reading' => 'proposals waiting for people', 'proof_review' => 'proofs nobody reviewed yet',
                'proof_repair' => 'proofs a review found flawed', 'repair_check' => 'repaired proofs to check',
                'statement_fix' => 'statements a member asked to correct', 'fix_check' => 'corrected statements to check',
                'relink' => 'facts that relied on a superseded fact', 'relink_check' => 'answers about those facts to check',
                'consolidate' => 'symbols several facts define, not yet in the project notation'][$t['kind']] ?? null;
        } elseif ($t['source_type'] === 'sweep' && isset($snap['symbols'])) {
            $n = count($snap['symbols']); $m = count($snap['types'] ?? []);
            $subject = implode(' and ', array_filter([$n ? "$n symbol" . ($n === 1 ? '' : 's') : '', $m ? "$m entr" . ($m === 1 ? 'y' : 'ies') . ' to type' : ''])) ?: '0 symbols';
        } elseif ($t['source_type'] === 'sweep' && isset($snap['items'])) {
            $n = count($snap['items']);
            $subject = match ($t['kind']) {
                'rewrite_check' => "$n rewrite" . ($n === 1 ? '' : 's'),
                'proof_repair' => "$n proof" . ($n === 1 ? '' : 's') . ' to repair',
                'repair_check' => "$n repair" . ($n === 1 ? '' : 's') . ' to check',
                'statement_fix' => "$n statement" . ($n === 1 ? '' : 's') . ' to correct',
                'fix_check' => "$n correction" . ($n === 1 ? '' : 's') . ' to check',
                'relink' => "$n fact" . ($n === 1 ? '' : 's') . ' to read again',
                'relink_check' => "$n answer" . ($n === 1 ? '' : 's') . ' to check',
                default => "$n proposal" . ($n === 1 ? '' : 's'),
            };
        } elseif ($t['kind'] === 'proof_review' && $t['source_type'] === 'sweep') {
            $n = count(json_decode((string)$t['snapshot_json'], true)['facts'] ?? []);
            $subject = "$n proof" . ($n === 1 ? '' : 's');
        } elseif ($t['kind'] === 'notation' && $t['source_type'] === 'sweep') {
            $n = count(json_decode((string)$t['snapshot_json'], true)['facts']);
            $subject = "$n fact" . ($n === 1 ? '' : 's');
        } elseif ($t['kind'] === 'source_check' && in_array($t['source_type'], [null, 'sweep'], true)) {
            // A batch: how many cited results, and the source they were found in.
            $facts = json_decode((string)$t['snapshot_json'], true)['facts'] ?? [];
            $where = $facts ? Db::value("SELECT COALESCE(d.title, b.cite_key, b.title) FROM fact_sources s LEFT JOIN documents d ON s.source_type = 'document' AND d.id = s.source_id
                                         LEFT JOIN bib_entries b ON s.source_type = 'bib' AND b.id = s.source_id WHERE s.fact_id = ? AND s.covers <> 'context' ORDER BY s.source_type = 'document' DESC, s.id LIMIT 1", [$facts[0][0]]) : null;
            $subject = count($facts) . ' cited result' . (count($facts) === 1 ? '' : 's') . ($where ? " found in $where" : '');
        }
        foreach (['id', 'project_id', 'source_id', 'version_id', 'conversation_id', 'requested_by', 'claimed_by', 'attempts'] as $k) $t[$k] = $t[$k] === null ? null : (int)$t[$k];
        $out = array_intersect_key($t, array_flip(['id', 'project_id', 'kind', 'status', 'source_type', 'source_id', 'version_id', 'conversation_id', 'prompt_text', 'requested_by', 'requested_by_name',
            'claimed_by', 'claimed_by_name', 'client_name', 'started_at', 'ai_model', 'ai_generation_ms', 'attempts', 'summary_text', 'error_text', 'created_at', 'updated_at', 'finished_at']));
        $waiting = $t['status'] === 'pending' ? self::extractedBy($t) : [];
        return $out + ['subject' => $subject, 'result' => $result, 'already_done_by' => $waiting, 'priority' => (int)($t['priority'] ?? 50),
            'group' => self::group($t), 'waits_for' => in_array($t['status'], ['pending', 'running'], true) ? self::waitingFor($t) : []];
    }

    private static function presentSuggestion(array $s): array
    {
        foreach (['id', 'project_id', 'task_id', 'bib_id', 'decided_by', 'ai_user_id', 'ai_generation_ms'] as $k) $s[$k] = $s[$k] === null ? null : (int)$s[$k];
        $s['auto_added'] = (bool)($s['auto_added'] ?? false);
        return $s;
    }

    // ----- the scheduler -----
    // AI clients take the waiting task of lowest priority first, then the oldest, among those whose dependencies are finished.
    // Light work someone waits for goes before heavy background work: an @AI question before the extraction of a long paper.

    /** Lower runs sooner. */
    private const PRIORITY = ['ask' => 10, 'instruct' => 10, 'review' => 20, 'source_check' => 30, 'bib' => 30, 'consolidate' => 40, 'notation' => 40, 'lean' => 40, 'latex' => 40,
        'second_reading' => 45, 'notation_settle' => 45, 'derive' => 50, 'source_sweep' => 55, 'notation_rephrase' => 60, 'rewrite_check' => 65, 'proof_review' => 68, 'extract' => 70];
    /** A member's own request goes before the same work queued by the platform. */
    private const ASKED_BOOST = 10;

    public static function priority(string $kind, ?string $sourceType = null): int
    {
        if ($sourceType === 'sweep' && $kind === 'source_check') return self::PRIORITY['source_sweep'];
        if ($sourceType === 'sweep' && $kind === 'consolidate') return self::PRIORITY['notation_settle'];
        return self::PRIORITY[$kind === 'notation' && in_array($sourceType, ['fact', 'sweep'], true) ? 'notation_rephrase' : $kind] ?? 50;
    }

    /**
     * The tasks this one must wait for, among those open now. A consolidation reads the whole database: after the extractions
     * that are adding facts to it. A fact rewritten in the project notation: after the consolidation or the review of the notation
     * that may change that notation. @return list<int>
     */
    private static function dependencies(int $pid, string $kind, ?string $sourceType): array
    {
        $on = match (true) {
            $kind === 'consolidate' && $sourceType !== 'sweep' => ['extract'],
            $kind === 'notation' && in_array($sourceType, ['fact', 'sweep'], true) => ['consolidate', 'notation', 'notation_settle'],
            $kind === 'consolidate' && $sourceType === 'sweep' => ['extract'],
            // A second reading after the consolidation that proposes; rewrites checked once the rewriting of that round is done.
            $kind === 'second_reading' => ['consolidate'],
            $kind === 'rewrite_check' => ['notation_rephrase'],
            default => [],
        };
        if (!$on) return [];
        $out = [];
        foreach (Db::all("SELECT id, kind, source_type FROM ai_tasks WHERE project_id = ? AND status IN ('pending', 'running') ORDER BY id", [$pid]) as $t) {
            if (in_array(self::group($t), $on, true)) $out[] = (int)$t['id'];
        }
        return $out;
    }

    /** The group a task is shown in: its kind, a rewrite in the project notation apart from a review of the notation. */
    public static function group(array $t): string
    {
        if ($t['kind'] === 'consolidate' && $t['source_type'] === 'sweep') return 'notation_settle';
        return $t['kind'] === 'notation' && in_array($t['source_type'], ['fact', 'sweep'], true) ? 'notation_rephrase' : (string)$t['kind'];
    }

    /** The tasks a waiting task still waits for. @return list<int> */
    public static function waitingFor(array $t): array
    {
        $after = array_map('intval', json_decode((string)($t['after_json'] ?? ''), true) ?: []);
        if (!$after) return [];
        [$in, $p] = Db::in($after);
        return array_map('intval', array_column(Db::all("SELECT id FROM ai_tasks WHERE id IN $in AND status IN ('pending', 'running')", $p), 'id'));
    }

    /**
     * The queue by kind, since the order is the scheduler's: for each kind, its tasks since the oldest one still open (or of the
     * last 7 days when none is), by status, so that a bar shows how many are done. Running work first, then what runs next.
     */
    private static function groups(int $pid, int $me): array
    {
        $week = gmdate('Y-m-d H:i:s', time() - 7 * 86400);
        $rows = Db::all("SELECT t.id, t.kind, t.source_type, t.status, t.created_at, t.priority, t.after_json FROM ai_tasks t WHERE t.project_id = ? AND " . self::visibleSql('t') . "
                         AND (t.status IN ('pending', 'running') OR t.created_at >= ?) ORDER BY t.id", [$pid, $me, $week]);
        $by = [];
        foreach ($rows as $t) $by[self::group($t)][] = $t;
        $out = [];
        foreach ($by as $g => $list) {
            $open = array_values(array_filter($list, fn($t) => in_array($t['status'], ['pending', 'running'], true)));
            $since = $open ? min(array_column($open, 'created_at')) : $week;
            $counts = ['pending' => 0, 'running' => 0, 'done' => 0, 'failed' => 0, 'cancelled' => 0];
            foreach ($list as $t) if ($t['created_at'] >= $since) $counts[$t['status']]++;
            $pending = array_values(array_filter($open, fn($t) => $t['status'] === 'pending'));
            $out[] = ['group' => $g, 'counts' => $counts, 'total' => array_sum($counts), 'since' => $since, 'latest' => max(array_column($list, 'created_at')),
                'priority' => $pending ? min(array_map(fn($t) => (int)$t['priority'], $pending)) : null,
                // Every waiting task waits for others: say so rather than look stuck.
                'blocked' => $pending && !$counts['running'] && !array_filter($pending, fn($t) => !self::waitingFor($t))];
        }
        usort($out, fn($a, $b) => [$b['counts']['running'] > 0, $a['priority'] === null, $a['priority'] ?? 0, $b['latest']] <=> [$a['counts']['running'] > 0, $b['priority'] === null, $b['priority'] ?? 0, $a['latest']]);
        return $out;
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
        $version = ClientProtocol::clientVersion();
        if (Db::value('SELECT 1 FROM ai_clients WHERE user_id = ? AND name = ?', [$uid, $name])) {
            Db::update('ai_clients', ['ai_model' => $model, 'last_seen_at' => $now] + ($version ? ['version' => $version] : []), 'user_id = :u AND name = :n', ['u' => $uid, 'n' => $name]);
            return;
        }
        try { Db::insert('ai_clients', ['user_id' => $uid, 'name' => $name, 'ai_model' => $model, 'version' => $version, 'last_seen_at' => $now]); } catch (\PDOException) { /* created meanwhile */ }
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
