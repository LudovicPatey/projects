<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, HttpError, Notify, Provenance, Request, Response, Sanitizer};

/**
 * Open questions of a project: a tree of big questions and sub-questions, each with proof
 * strategies. Every change to a strategy is a new revision, so its evolution stays readable.
 * Humans and AI can both write here, but only a human can declare a result.
 */
final class QuestionController
{
    public const STATUSES = ['open', 'active', 'partial', 'solved', 'refuted', 'abandoned'];
    public const STRATEGY_STATUSES = ['idea', 'active', 'blocked', 'succeeded', 'failed', 'abandoned'];
    public const PRIORITIES = ['high', 'normal', 'low'];
    public const LINK_TYPES = ['fact', 'document', 'bib'];
    public const ANSWERS = ['positive', 'negative'];
    private const SUPPORT_ERRORS = [
        'missing' => 'The fact of this answer no longer exists.',
        'retracted' => 'This fact is retracted.',
        'disputed' => 'This fact is denied or disputed. Settle its reviews first.',
        'chain_broken' => 'This fact relies on a denied, disputed or retracted fact.',
        'proof_disputed' => 'The result is accepted but no proof of it is. Fix the proof, or propose and check another one.',
        'chain_unproved' => 'This fact relies on a result whose proof is disputed.',
        'unvalidated' => 'A human must endorse the current revision of this fact first.',
    ];
    private const HUMAN_ONLY = ['solved', 'refuted'];
    private const HUMAN_ONLY_STRATEGY = ['succeeded'];
    private const MAX_DEPTH = 8;

    // ---------------- questions ----------------

    public static function list(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        Response::json(['questions' => self::summary($pid)]);
    }

    public static function show(Request $r): never
    {
        $q = Access::question($r->int('id'));
        Response::json(self::present($q));
    }

    /** Where a strategy lives: used to open an @mention of it. */
    public static function showStrategy(Request $r): never
    {
        $s = Access::strategy($r->int('id'));
        Response::json(['id' => (int)$s['id'], 'question_id' => (int)$s['question_id'], 'project_id' => (int)$s['project_id'], 'title' => $s['title'], 'status' => $s['status'], 'current_revision' => (int)$s['current_revision']]);
    }

    public static function create(Request $r): never
    {
        $pid = $r->int('pid');
        Access::member($pid);
        $title = self::title($r);
        $body = Sanitizer::fromRequest($r, $pid) ?? ['html' => '', 'text' => '', 'mentions' => []];
        $parent = (int)$r->input('parent_id') ?: null;
        self::checkParent($pid, $parent, null);
        $status = self::choice($r, 'status', self::STATUSES, 'open');
        self::guardResult($status, null, self::HUMAN_ONLY, 'mark a question as solved or refuted');
        $priority = self::choice($r, 'priority', self::PRIORITIES, 'normal');
        $model = Provenance::agentModel($r);
        $now = Db::now();
        $id = Db::tx(function () use ($r, $pid, $parent, $title, $body, $status, $priority, $model, $now) {
            $id = Db::insert('open_questions', Provenance::stamp($model, $r->input('generation_seconds')) + [
                'project_id' => $pid, 'parent_id' => $parent, 'title' => $title, 'statement_html' => $body['html'], 'status' => $status,
                'priority' => $priority, 'ai_model' => $model, 'created_by' => Auth::id(), 'updated_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now,
            ]);
            Activity::touch($pid, 'oquestion', $id, 'created');
            Notify::mentions($pid, 'oquestion', $id, $body['mentions'], ['view' => 'questions', 'id' => $id], $title);
            return $id;
        });
        Response::json(self::present(Access::question($id)), 201);
    }

    public static function update(Request $r): never
    {
        $q = Access::question($r->int('id'));
        $pid = (int)$q['project_id'];
        $data = [];
        if ($r->input('title') !== null) $data['title'] = self::title($r);
        $body = Sanitizer::fromRequest($r, $pid);
        if ($body !== null) $data['statement_html'] = $body['html'];
        $wording = (isset($data['title']) && $data['title'] !== $q['title']) || (isset($data['statement_html']) && $data['statement_html'] !== $q['statement_html']);
        if ($wording && Auth::isAi() && $q['ai_model'] === null) {
            throw new HttpError(403, 'An AI client cannot reword a question written by a human. Add a comment or a strategy instead.');
        }
        if ($r->input('status') !== null) {
            $data['status'] = self::choice($r, 'status', self::STATUSES, $q['status']);
            if ($data['status'] !== $q['status'] && self::ratified((int)$q['id'])) {
                throw new HttpError(409, 'This question has a ratified answer. Revoke the ratification to change its status.');
            }
            self::guardResult($data['status'], $q['status'], self::HUMAN_ONLY, 'mark a question as solved or refuted');
        }
        if ($r->input('priority') !== null) $data['priority'] = self::choice($r, 'priority', self::PRIORITIES, $q['priority']);
        if (array_key_exists('parent_id', $r->input())) {
            $parent = (int)$r->input('parent_id') ?: null;
            self::checkParent($pid, $parent, (int)$q['id']);
            $data['parent_id'] = $parent;
        }
        $changed = array_filter($data, fn($v, $k) => (string)$v !== (string)$q[$k], ARRAY_FILTER_USE_BOTH);
        if (!$changed) Response::json(self::present($q));
        if ($wording) {
            $model = Provenance::agentModel($r);
            $changed += ['ai_model' => $model] + Provenance::stamp($model, $r->input('generation_seconds'));
        }
        $changed += ['updated_by' => Auth::id(), 'updated_at' => Db::now()];
        Db::tx(function () use ($q, $pid, $changed, $body) {
            Db::update('open_questions', $changed, 'id = :id', ['id' => $q['id']]);
            Activity::touch($pid, 'oquestion', (int)$q['id'], isset($changed['status']) ? 'status' : 'updated');
            if ($body !== null) Notify::mentions($pid, 'oquestion', (int)$q['id'], $body['mentions'], ['view' => 'questions', 'id' => (int)$q['id']], $changed['title'] ?? $q['title'], null, false);
        });
        Response::json(self::present(Access::question((int)$q['id'])));
    }

    public static function delete(Request $r): never
    {
        $q = Access::question($r->int('id'));
        if ((int)$q['created_by'] !== Auth::id()) Access::owner((int)$q['project_id']);
        if (Db::value('SELECT 1 FROM open_questions WHERE parent_id = ? AND deleted_at IS NULL', [$q['id']])) {
            throw new HttpError(409, 'Move or delete its sub-questions first.');
        }
        Db::update('open_questions', ['deleted_at' => Db::now()], 'id = :id', ['id' => $q['id']]);
        Response::json(['ok' => true]);
    }

    // ---------------- strategies ----------------

    public static function createStrategy(Request $r): never
    {
        $q = Access::question($r->int('id'));
        $pid = (int)$q['project_id'];
        $title = self::title($r);
        $body = Sanitizer::fromRequest($r, $pid) ?? ['html' => '', 'text' => '', 'mentions' => []];
        $status = self::choice($r, 'status', self::STRATEGY_STATUSES, 'idea');
        self::guardResult($status, null, self::HUMAN_ONLY_STRATEGY, 'mark a strategy as successful');
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $sid = Db::tx(function () use ($q, $pid, $title, $body, $status, $model, $stamp, $r) {
            $now = Db::now();
            $sid = Db::insert('proof_strategies', ['project_id' => $pid, 'question_id' => $q['id'], 'title' => $title, 'status' => $status,
                'current_revision' => 1, 'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now]);
            self::revision($sid, 1, $title, $status, $body['html'], mb_substr($r->str('change_note'), 0, 500) ?: 'First version', $model, $stamp);
            Activity::touch($pid, 'strategy', $sid, 'created');
            Notify::mentions($pid, 'strategy', $sid, $body['mentions'], self::strategyLink((int)$q['id'], $sid), $title);
            return $sid;
        });
        Response::json(['id' => $sid, 'question' => self::present($q)], 201);
    }

    /** Any change of title, status or text creates a revision. */
    public static function updateStrategy(Request $r): never
    {
        $s = Access::strategy($r->int('id'));
        $pid = (int)$s['project_id'];
        $base = $r->input('base_revision');
        if ($base !== null && (int)$base !== (int)$s['current_revision']) {
            throw new HttpError(409, 'Someone revised this strategy in the meantime. Reload it before saving.');
        }
        $cur = self::currentRevision($s);
        $title = $r->input('title') !== null ? self::title($r) : $s['title'];
        $status = self::choice($r, 'status', self::STRATEGY_STATUSES, $s['status']);
        self::guardResult($status, $s['status'], self::HUMAN_ONLY_STRATEGY, 'mark a strategy as successful');
        $body = Sanitizer::fromRequest($r, $pid);
        $html = $body['html'] ?? $cur['body_html'];
        if ($title === $s['title'] && $status === $s['status'] && $html === $cur['body_html']) {
            Response::json(['id' => (int)$s['id'], 'question' => self::present(Access::question((int)$s['question_id']))]);
        }
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $note = mb_substr($r->str('change_note'), 0, 500) ?: self::describe($s, $title, $status, $html, $cur['body_html']);
        Db::tx(function () use ($s, $pid, $title, $status, $html, $note, $model, $stamp, $body) {
            $no = (int)$s['current_revision'] + 1;
            self::revision((int)$s['id'], $no, $title, $status, $html, $note, $model, $stamp);
            Db::update('proof_strategies', ['title' => $title, 'status' => $status, 'current_revision' => $no, 'updated_at' => Db::now()], 'id = :id', ['id' => $s['id']]);
            Activity::touch($pid, 'strategy', (int)$s['id'], 'revision');
            if ($body !== null) Notify::mentions($pid, 'strategy', (int)$s['id'], $body['mentions'], self::strategyLink((int)$s['question_id'], (int)$s['id']), $title, null, false);
        });
        Response::json(['id' => (int)$s['id'], 'question' => self::present(Access::question((int)$s['question_id']))]);
    }

    /** Going back to an earlier version adds a revision: history is never rewritten. */
    public static function restoreStrategy(Request $r): never
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a human can restore a revision.');
        $s = Access::strategy($r->int('id'));
        $old = Db::one('SELECT * FROM strategy_revisions WHERE strategy_id = ? AND revision_no = ?', [$s['id'], (int)$r->input('revision_no')]);
        if (!$old) throw new HttpError(404, 'Revision not found');
        if ((int)$old['revision_no'] === (int)$s['current_revision']) throw new HttpError(422, 'This is already the current revision.');
        Db::tx(function () use ($s, $old) {
            $no = (int)$s['current_revision'] + 1;
            self::revision((int)$s['id'], $no, $old['title'], $old['status'], $old['body_html'], "Restored revision {$old['revision_no']}", null, ['ai_user_id' => null, 'ai_generation_ms' => null]);
            Db::update('proof_strategies', ['title' => $old['title'], 'status' => $old['status'], 'current_revision' => $no, 'updated_at' => Db::now()], 'id = :id', ['id' => $s['id']]);
            Activity::touch((int)$s['project_id'], 'strategy', (int)$s['id'], 'revision');
        });
        Response::json(['id' => (int)$s['id'], 'question' => self::present(Access::question((int)$s['question_id']))]);
    }

    public static function deleteStrategy(Request $r): never
    {
        $s = Access::strategy($r->int('id'));
        if ((int)$s['created_by'] !== Auth::id()) Access::owner((int)$s['project_id']);
        Db::update('proof_strategies', ['deleted_at' => Db::now()], 'id = :id', ['id' => $s['id']]);
        Response::json(['ok' => true]);
    }

    // ---------------- links to facts, files and references ----------------

    public static function addLink(Request $r): never
    {
        $q = Access::question($r->int('id'));
        $pid = (int)$q['project_id'];
        $type = $r->str('target_type');
        $target = (int)$r->input('target_id');
        if (!in_array($type, self::LINK_TYPES, true)) throw new HttpError(422, 'A link points to a fact, a file or a reference.');
        if (!self::linkTarget($pid, $type, $target)) throw new HttpError(422, 'This item is not in the project.');
        $sid = (int)$r->input('strategy_id');
        if ($sid && !Db::value('SELECT 1 FROM proof_strategies WHERE id = ? AND question_id = ? AND deleted_at IS NULL', [$sid, $q['id']])) {
            throw new HttpError(422, 'This strategy does not belong to the question.');
        }
        $exists = Db::value('SELECT 1 FROM question_links WHERE question_id = ? AND strategy_id = ? AND target_type = ? AND target_id = ?', [$q['id'], $sid, $type, $target]);
        if (!$exists) {
            Db::insert('question_links', ['project_id' => $pid, 'question_id' => $q['id'], 'strategy_id' => $sid, 'target_type' => $type, 'target_id' => $target, 'created_by' => Auth::id(), 'created_at' => Db::now()]);
            if ($sid) Activity::touch($pid, 'strategy', $sid, 'link'); else Activity::touch($pid, 'oquestion', (int)$q['id'], 'link');
        }
        Response::json(self::present($q), $exists ? 200 : 201);
    }

    public static function deleteLink(Request $r): never
    {
        $l = Db::one('SELECT * FROM question_links WHERE id = ?', [$r->int('id')]);
        if (!$l) throw new HttpError(404, 'Link not found');
        $q = Access::question((int)$l['question_id']);
        Db::run('DELETE FROM question_links WHERE id = ?', [$l['id']]);
        Response::json(self::present($q));
    }

    // ---------------- proposed answers ----------------

    /** Anyone, human or AI, can suggest that a fact answers the question. It changes nothing until ratified. */
    public static function proposeAnswer(Request $r): never
    {
        $q = Access::question($r->int('id'));
        $pid = (int)$q['project_id'];
        $answer = $r->str('answer');
        if (!in_array($answer, self::ANSWERS, true)) throw new HttpError(422, 'The answer must be positive or negative.');
        $f = Db::one('SELECT id, label, current_revision, retracted_at FROM facts WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [(int)$r->input('fact_id'), $pid]);
        if (!$f) throw new HttpError(422, 'An answer must point to a fact of this project.');
        if ($f['retracted_at']) throw new HttpError(422, 'This fact is retracted.');
        $body = Sanitizer::fromRequest($r, $pid) ?? ['html' => '', 'text' => '', 'mentions' => []];
        if (Auth::isAi() && $body['text'] === '') throw new HttpError(422, 'Explain why this fact answers the question: send body_text.');
        if (self::ratified((int)$q['id'])) throw new HttpError(409, 'This question already has a ratified answer.');
        if (Db::value("SELECT 1 FROM question_answers WHERE question_id = ? AND fact_id = ? AND answer = ? AND state = 'proposed'", [$q['id'], $f['id'], $answer])) {
            throw new HttpError(409, 'This answer is already proposed.');
        }
        $model = Provenance::agentModel($r);
        $stamp = Provenance::stamp($model, $r->input('generation_seconds'));
        $id = Db::tx(function () use ($q, $pid, $f, $answer, $body, $model, $stamp) {
            $id = Db::insert('question_answers', $stamp + ['project_id' => $pid, 'question_id' => $q['id'], 'fact_id' => $f['id'], 'fact_revision' => $f['current_revision'],
                'answer' => $answer, 'state' => 'proposed', 'rationale_html' => $body['html'], 'proposed_by' => Auth::id(), 'ai_model' => $model, 'created_at' => Db::now()]);
            Activity::touch($pid, 'oquestion', (int)$q['id'], 'answer', $id);
            $link = ['view' => 'questions', 'id' => (int)$q['id']];
            Notify::mentions($pid, 'answer', $id, $body['mentions'], $link, $q['title']);
            self::tell((int)$q['created_by'], $pid, 'answer_proposed', $link, "{$f['label']}: {$q['title']}");
            return $id;
        });
        Response::json(['id' => $id, 'question' => self::present(Access::question((int)$q['id']))], 201);
    }

    /** A person accepts the answer. Its fact must carry a human endorsement at that moment. */
    public static function ratifyAnswer(Request $r): never
    {
        self::requireHuman('ratify an answer');
        [$a, $q] = self::answerRow($r->int('id'));
        if ($a['state'] !== 'proposed') throw new HttpError(409, 'Only a proposed answer can be ratified.');
        $fact = self::factsOf((int)$a['project_id'])[(int)$a['fact_id']] ?? null;
        $support = self::support($fact);
        if ($support !== 'validated') throw new HttpError(409, self::SUPPORT_ERRORS[$support]);
        $status = $a['answer'] === 'positive' ? 'solved' : 'refuted';
        Db::tx(function () use ($a, $q, $status, $fact) {
            // Updating the question first serializes two simultaneous ratifications on MySQL.
            Db::update('open_questions', ['status' => $status, 'updated_by' => Auth::id(), 'updated_at' => Db::now()], 'id = :id', ['id' => $q['id']]);
            if (self::ratified((int)$q['id'])) throw new HttpError(409, 'This question already has a ratified answer.');
            Db::update('question_answers', ['state' => 'ratified', 'ratified_by' => Auth::id(), 'ratified_at' => Db::now(), 'ratified_revision' => $fact['current_revision']], 'id = :id', ['id' => $a['id']]);
            Activity::touch((int)$a['project_id'], 'oquestion', (int)$q['id'], 'ratified', (int)$a['id']);
            self::tell((int)$a['proposed_by'], (int)$a['project_id'], 'answer_ratified', ['view' => 'questions', 'id' => (int)$q['id']], "{$fact['label']}: {$q['title']}");
        });
        Response::json(self::present(Access::question((int)$q['id'])));
    }

    public static function rejectAnswer(Request $r): never
    {
        self::requireHuman('reject an answer');
        [$a, $q] = self::answerRow($r->int('id'));
        if ($a['state'] !== 'proposed') throw new HttpError(409, 'Only a proposed answer can be rejected.');
        self::close($a, $q, 'rejected', self::note($r), 'answer_rejected');
        Response::json(self::present(Access::question((int)$q['id'])));
    }

    /** Takes back a ratification: the question is open for work again, and the record stays. */
    public static function revokeAnswer(Request $r): never
    {
        self::requireHuman('revoke a ratification');
        [$a, $q] = self::answerRow($r->int('id'));
        if ($a['state'] !== 'ratified') throw new HttpError(409, 'Only a ratified answer can be revoked.');
        $note = self::note($r);
        Db::tx(function () use ($a, $q, $note) {
            Db::update('open_questions', ['status' => 'active', 'updated_by' => Auth::id(), 'updated_at' => Db::now()], 'id = :id', ['id' => $q['id']]);
            self::close($a, $q, 'revoked', $note, 'answer_revoked');
        });
        Response::json(self::present(Access::question((int)$q['id'])));
    }

    public static function withdrawAnswer(Request $r): never
    {
        [$a, $q] = self::answerRow($r->int('id'));
        if ((int)$a['proposed_by'] !== Auth::id()) throw new HttpError(403, 'Only the author of a proposal can withdraw it.');
        if ($a['state'] !== 'proposed') throw new HttpError(409, 'Only a proposed answer can be withdrawn.');
        self::close($a, $q, 'withdrawn', mb_substr($r->str('note'), 0, 1000) ?: null, null);
        Response::json(self::present(Access::question((int)$q['id'])));
    }

    /**
     * A fact behind a ratified answer changed for the worse. The answer is not touched,
     * because only a person can revoke it, but the question is flagged and its ratifier told.
     */
    public static function factChanged(int $pid, int $factId, string $why): void
    {
        $rows = Db::all("SELECT a.id, a.fact_id, a.question_id, a.ratified_by, q.title FROM question_answers a JOIN open_questions q ON q.id = a.question_id
                         WHERE a.project_id = ? AND a.state = 'ratified' AND q.deleted_at IS NULL", [$pid]);
        if (!$rows) return;
        $facts = self::factsOf($pid);
        $affected = [];
        $stack = [$factId];
        while ($stack) {
            $x = array_pop($stack);
            if (isset($affected[$x])) continue;
            $affected[$x] = true;
            array_push($stack, ...($facts[$x]['dependents'] ?? []));
        }
        foreach ($rows as $a) {
            if (!isset($affected[(int)$a['fact_id']])) continue;
            Activity::touch($pid, 'oquestion', (int)$a['question_id'], 'answer_fact', (int)$a['id']);
            self::tell((int)$a['ratified_by'], $pid, 'answer_fact', ['view' => 'questions', 'id' => (int)$a['question_id']], "$why: {$a['title']}");
        }
    }

    public static function hasRatifiedAnswer(int $factId): bool
    {
        return (bool)Db::value("SELECT 1 FROM question_answers WHERE fact_id = ? AND state = 'ratified'", [$factId]);
    }

    private static function close(array $a, array $q, string $state, ?string $note, ?string $notice): void
    {
        Db::update('question_answers', ['state' => $state, 'closed_by' => Auth::id(), 'closed_at' => Db::now(), 'closed_note' => $note], 'id = :id', ['id' => $a['id']]);
        Activity::touch((int)$a['project_id'], 'oquestion', (int)$q['id'], $state, (int)$a['id']);
        if ($notice) self::tell((int)$a['proposed_by'], (int)$a['project_id'], $notice, ['view' => 'questions', 'id' => (int)$q['id']], (string)($note ?? $q['title']));
    }

    private static function tell(int $uid, int $pid, string $kind, array $link, string $excerpt): void
    {
        if ($uid !== Auth::id() && Access::isMember($pid, $uid)) Notify::send($uid, $pid, $kind, ['link' => $link, 'excerpt' => $excerpt]);
    }

    private static function requireHuman(string $what): void
    {
        if (Auth::isAi()) throw new HttpError(403, "Only a human can $what.");
    }

    private static function note(Request $r): string
    {
        $note = mb_substr($r->str('note'), 0, 1000);
        if ($note === '') throw new HttpError(422, 'Please give a reason.');
        return $note;
    }

    private static function ratified(int $questionId): bool
    {
        return (bool)Db::value("SELECT 1 FROM question_answers WHERE question_id = ? AND state = 'ratified'", [$questionId]);
    }

    private static function answerRow(int $id): array
    {
        $a = Db::one('SELECT * FROM question_answers WHERE id = ?', [$id]);
        if (!$a) throw new HttpError(404, 'Answer not found');
        return [$a, Access::question((int)$a['question_id'])];
    }

    private static function factsOf(int $pid): array
    {
        return array_column(FactController::graph($pid)['facts'], null, 'id');
    }

    /** Whether a fact can currently carry an answer. Checked by the server at ratification. */
    private static function support(?array $f): string
    {
        if (!$f) return 'missing';
        if ($f['status'] === 'retracted') return 'retracted';
        if ($f['status'] === 'disputed') return 'disputed';
        if ($f['status'] === 'proof_disputed') return 'proof_disputed';
        if ($f['chain'] === 'broken') return 'chain_broken';
        if ($f['chain'] === 'unproved') return 'chain_unproved';
        if ($f['incomplete'] || $f['chain'] === 'incomplete') return 'incomplete';
        return $f['endorsed_by'] ? 'validated' : 'unvalidated';
    }

    private static function answers(int $pid, int $qid): array
    {
        $rows = Db::all('SELECT a.*, u.name AS proposer, u.kind AS proposer_kind, au.name AS ai_user_name, rb.name AS ratified_by_name, cb.name AS closed_by_name
                         FROM question_answers a JOIN users u ON u.id = a.proposed_by LEFT JOIN users au ON au.id = a.ai_user_id
                         LEFT JOIN users rb ON rb.id = a.ratified_by LEFT JOIN users cb ON cb.id = a.closed_by
                         WHERE a.question_id = ? ORDER BY a.id DESC', [$qid]);
        if (!$rows) return [];
        $facts = self::factsOf($pid);
        $me = Auth::id();
        return array_map(function ($a) use ($facts, $me) {
            $f = $facts[(int)$a['fact_id']] ?? null;
            $mine = $f ? Db::one("SELECT id, verdict FROM fact_reviews WHERE fact_id = ? AND revision_no = ? AND reviewer_id = ? AND reviewer_kind = 'human'", [$f['id'], $f['current_revision'], $me]) : null;
            foreach (['id', 'question_id', 'fact_id', 'fact_revision', 'proposed_by'] as $k) $a[$k] = (int)$a[$k];
            $a['ratified_revision'] = $a['ratified_revision'] === null ? null : (int)$a['ratified_revision'];
            $a['rationale_text'] = Sanitizer::toText((string)$a['rationale_html']);
            $a['support'] = self::support($f);
            $a['fact'] = $f ? ['id' => $f['id'], 'label' => $f['label'], 'title' => $f['title'], 'statement_text' => $f['statement_text'], 'status' => $f['status'], 'chain' => $f['chain'],
                'current_revision' => $f['current_revision'], 'endorsed_by' => $f['endorsed_by'], 'denied_by' => $f['denied_by'],
                'my_review' => $mine ? ['id' => (int)$mine['id'], 'verdict' => $mine['verdict']] : null] : null;
            return $a;
        }, $rows);
    }

    // ---------------- data ----------------

    /** Every question of the project with its strategies in brief. */
    public static function summary(int $pid): array
    {
        $strategies = [];
        foreach (Db::all('SELECT id, question_id, title, status, current_revision, updated_at FROM proof_strategies WHERE project_id = ? AND deleted_at IS NULL ORDER BY id', [$pid]) as $s) {
            foreach (['id', 'question_id', 'current_revision'] as $k) $s[$k] = (int)$s[$k];
            $strategies[$s['question_id']][] = $s;
        }
        $open = [];
        $live = Db::all("SELECT question_id, fact_id, answer, state FROM question_answers WHERE project_id = ? AND state IN ('proposed', 'ratified')", [$pid]);
        $facts = array_filter($live, fn($a) => $a['state'] === 'ratified') ? self::factsOf($pid) : [];
        foreach ($live as $a) {
            $k = (int)$a['question_id'];
            $open[$k] ??= ['pending' => 0, 'answer' => null, 'at_risk' => false];
            if ($a['state'] === 'proposed') $open[$k]['pending']++;
            else { $open[$k]['answer'] = $a['answer']; $open[$k]['at_risk'] = self::support($facts[(int)$a['fact_id']] ?? null) !== 'validated'; }
        }
        $rows = Db::all('SELECT q.id, q.parent_id, q.title, q.statement_html, q.status, q.priority, q.ai_model, q.created_by, q.created_at, q.updated_at, u.name AS author
                         FROM open_questions q JOIN users u ON u.id = q.created_by WHERE q.project_id = ? AND q.deleted_at IS NULL ORDER BY q.id', [$pid]);
        return array_map(function ($q) use ($strategies, $open) {
            $q['id'] = (int)$q['id'];
            $q['parent_id'] = $q['parent_id'] === null ? null : (int)$q['parent_id'];
            $q['created_by'] = (int)$q['created_by'];
            $q['statement_text'] = Sanitizer::toText((string)$q['statement_html']);
            unset($q['statement_html']);
            $q['strategies'] = $strategies[$q['id']] ?? [];
            $q['pending_answers'] = $open[$q['id']]['pending'] ?? 0;
            $q['answer'] = $open[$q['id']]['answer'] ?? null;
            $q['answer_at_risk'] = $open[$q['id']]['at_risk'] ?? false;
            return $q;
        }, $rows);
    }

    /** One question with its strategies, their full history and its links. */
    public static function present(array $q): array
    {
        $id = (int)$q['id'];
        $pid = (int)$q['project_id'];
        $names = fn(?string $uid) => $uid ? Db::value('SELECT name FROM users WHERE id = ?', [(int)$uid]) : null;
        $links = self::links($pid, $id);
        $strategies = Db::all('SELECT s.*, u.name AS author FROM proof_strategies s JOIN users u ON u.id = s.created_by WHERE s.question_id = ? AND s.deleted_at IS NULL ORDER BY s.id', [$id]);
        foreach ($strategies as &$s) {
            $sid = (int)$s['id'];
            foreach (['id', 'question_id', 'current_revision', 'created_by'] as $k) $s[$k] = (int)$s[$k];
            $s['revisions'] = Db::all('SELECT r.id, r.revision_no, r.title, r.status, r.body_html, r.change_note, r.author_id, u.name AS author_name, u.kind AS author_kind,
                                              r.ai_model, r.ai_user_id, au.name AS ai_user_name, r.ai_generation_ms, r.created_at
                                       FROM strategy_revisions r JOIN users u ON u.id = r.author_id LEFT JOIN users au ON au.id = r.ai_user_id
                                       WHERE r.strategy_id = ? ORDER BY r.revision_no DESC', [$sid]);
            foreach ($s['revisions'] as &$rev) { $rev['revision_no'] = (int)$rev['revision_no']; $rev['body_text'] = Sanitizer::toText((string)$rev['body_html']); }
            unset($rev);
            $s['body_html'] = $s['revisions'][0]['body_html'] ?? '';
            $s['body_text'] = $s['revisions'][0]['body_text'] ?? '';
            $s['links'] = array_values(array_filter($links, fn($l) => $l['strategy_id'] === $sid));
            $s['last_activity_id'] = Activity::latest($pid, 'strategy', $sid);
            $s['comment_count'] = (int)Db::value("SELECT COUNT(*) FROM comments WHERE target_type = 'strategy' AND target_id = ?", [$sid]);
            unset($s['deleted_at']);
        }
        unset($s);
        $path = [];
        for ($p = $q['parent_id'], $guard = 0; $p && $guard < self::MAX_DEPTH + 1; $guard++) {
            $row = Db::one('SELECT id, parent_id, title FROM open_questions WHERE id = ?', [$p]);
            if (!$row) break;
            array_unshift($path, ['id' => (int)$row['id'], 'title' => $row['title']]);
            $p = $row['parent_id'];
        }
        return [
            'id' => $id, 'project_id' => $pid, 'parent_id' => $q['parent_id'] === null ? null : (int)$q['parent_id'], 'title' => $q['title'],
            'statement_html' => $q['statement_html'], 'statement_text' => Sanitizer::toText((string)$q['statement_html']),
            'status' => $q['status'], 'priority' => $q['priority'], 'ai_model' => $q['ai_model'], 'ai_user_name' => $names($q['ai_user_id'] === null ? null : (string)$q['ai_user_id']),
            'ai_generation_ms' => $q['ai_generation_ms'], 'created_by' => (int)$q['created_by'], 'author' => $names((string)$q['created_by']), 'updated_by_name' => $names($q['updated_by'] === null ? null : (string)$q['updated_by']),
            'created_at' => $q['created_at'], 'updated_at' => $q['updated_at'], 'path' => $path,
            'strategies' => $strategies, 'links' => array_values(array_filter($links, fn($l) => $l['strategy_id'] === 0)),
            'answers' => self::answers($pid, $id),
            'comment_count' => (int)Db::value("SELECT COUNT(*) FROM comments WHERE target_type = 'oquestion' AND target_id = ?", [$id]),
            'last_activity_id' => Activity::latest($pid, 'oquestion', $id),
        ];
    }

    private static function links(int $pid, int $questionId): array
    {
        $out = [];
        foreach (Db::all('SELECT * FROM question_links WHERE question_id = ? ORDER BY id', [$questionId]) as $l) {
            $t = self::linkTarget($pid, $l['target_type'], (int)$l['target_id']);
            if (!$t) continue; // the item was deleted
            $out[] = ['id' => (int)$l['id'], 'strategy_id' => (int)$l['strategy_id'], 'target_type' => $l['target_type'], 'target_id' => (int)$l['target_id']] + $t;
        }
        return $out;
    }

    private static function linkTarget(int $pid, string $type, int $id): ?array
    {
        $row = match ($type) {
            'fact' => Db::one('SELECT label AS code, title FROM facts WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [$id, $pid]),
            'document' => Db::one('SELECT NULL AS code, title FROM documents WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [$id, $pid]),
            'bib' => Db::one('SELECT cite_key AS code, title FROM bib_entries WHERE id = ? AND project_id = ?', [$id, $pid]),
            default => null,
        };
        if (!$row) return null;
        return $row + ['view' => ['fact' => 'facts', 'document' => 'files', 'bib' => 'bib'][$type]];
    }

    public static function strategyLink(int $questionId, int $strategyId): array
    {
        return ['view' => 'questions', 'id' => $questionId, 'strategy' => $strategyId];
    }

    // ---------------------------------------------------------------------

    private static function revision(int $sid, int $no, string $title, string $status, string $html, string $note, ?string $model, array $stamp): void
    {
        Db::insert('strategy_revisions', $stamp + ['strategy_id' => $sid, 'revision_no' => $no, 'title' => $title, 'status' => $status, 'body_html' => $html,
            'change_note' => $note, 'author_id' => Auth::id(), 'ai_model' => $model, 'created_at' => Db::now()]);
    }

    private static function currentRevision(array $s): array
    {
        return Db::one('SELECT * FROM strategy_revisions WHERE strategy_id = ? AND revision_no = ?', [$s['id'], $s['current_revision']])
            ?? throw new HttpError(500, 'Missing strategy revision.');
    }

    private static function describe(array $s, string $title, string $status, string $html, string $oldHtml): string
    {
        $parts = [];
        if ($status !== $s['status']) $parts[] = "Status: {$s['status']} → $status";
        if ($title !== $s['title']) $parts[] = 'Renamed';
        if ($html !== $oldHtml) $parts[] = 'Text revised';
        return implode(', ', $parts);
    }

    private static function title(Request $r): string
    {
        $t = mb_substr($r->str('title'), 0, 255);
        if ($t === '') throw new HttpError(422, 'A title is required.');
        return $t;
    }

    private static function choice(Request $r, string $key, array $allowed, string $default): string
    {
        $v = $r->str($key, $default);
        if (!in_array($v, $allowed, true)) throw new HttpError(422, "Unknown $key: choose one of " . implode(', ', $allowed) . '.');
        return $v;
    }

    /** A result is declared by a person. An AI client proposes it in a strategy or a comment. */
    private static function guardResult(string $new, ?string $old, array $reserved, string $what): void
    {
        if (Auth::isAi() && $new !== $old && in_array($new, $reserved, true)) throw new HttpError(403, "Only a human can $what.");
    }

    /** The parent must exist in the project, and the move must not create a cycle or a too deep tree. */
    private static function checkParent(int $pid, ?int $parent, ?int $self): void
    {
        if ($parent === null) return;
        $depth = 1;
        for ($cur = $parent; $cur; $depth++) {
            if ($cur === $self) throw new HttpError(422, 'A question cannot be placed under itself or one of its sub-questions.');
            if ($depth > self::MAX_DEPTH) throw new HttpError(422, 'Questions cannot be nested this deep.');
            $row = Db::one('SELECT parent_id FROM open_questions WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [$cur, $pid]);
            if (!$row) throw new HttpError(422, 'The parent question is not in this project.');
            $cur = (int)$row['parent_id'];
        }
        if ($depth + ($self ? self::height($self) : 0) > self::MAX_DEPTH + 1) throw new HttpError(422, 'Questions cannot be nested this deep.');
    }

    private static function height(int $id): int
    {
        $max = 0;
        foreach (Db::all('SELECT id FROM open_questions WHERE parent_id = ? AND deleted_at IS NULL', [$id]) as $c) $max = max($max, 1 + self::height((int)$c['id']));
        return $max;
    }
}
