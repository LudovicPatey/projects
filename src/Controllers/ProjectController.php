<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Activity, Access, Auth, Config, Db, HttpError, Notify, Orcid, Request, Response, Sanitizer};

final class ProjectController
{
    public static function list(Request $r): never
    {
        $rows = Db::all(
            'SELECT p.id, p.title, p.status, p.updated_at, pm.role,
                    (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS members
             FROM projects p JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
             ORDER BY p.updated_at DESC', [Auth::id()]);
        foreach ($rows as &$p) {
            $id = (int)$p['id'];
            $p['unread'] = Activity::total($id, Auth::id());
            $p['question_text'] = mb_substr(Sanitizer::toText((string)Db::value('SELECT question_html FROM projects WHERE id = ?', [$id])), 0, 260);
            $p['counts'] = [
                'questions' => (int)Db::value('SELECT COUNT(*) FROM open_questions WHERE project_id = ? AND deleted_at IS NULL', [$id]),
                'settled' => (int)Db::value("SELECT COUNT(*) FROM open_questions WHERE project_id = ? AND deleted_at IS NULL AND status IN ('solved', 'refuted', 'abandoned')", [$id]),
                'facts' => (int)Db::value('SELECT COUNT(*) FROM facts WHERE project_id = ? AND deleted_at IS NULL', [$id]),
                'files' => (int)Db::value('SELECT COUNT(*) FROM documents WHERE project_id = ? AND deleted_at IS NULL', [$id]),
                'references' => (int)Db::value('SELECT COUNT(*) FROM bib_entries WHERE project_id = ?', [$id]),
            ];
            $p['ai_time'] = AiTaskController::computeSummary($id);
            $p['people'] = Db::all('SELECT u.id, u.name, u.kind FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.joined_at, u.id LIMIT 5', [$id]);
        }
        unset($p);
        Response::json(['projects' => $rows, 'can_create' => self::canCreate()]);
    }

    private static function canCreate(): bool
    {
        if (Auth::isAgent()) return false;
        $allowed = (array)Config::get('project_creators', []);
        return !$allowed || in_array(Auth::require()['orcid'], $allowed, true);
    }

    public static function create(Request $r): never
    {
        if (!self::canCreate()) throw new HttpError(403, 'You are not allowed to create projects.');
        $title = $r->str('title');
        if ($title === '') throw new HttpError(422, 'A title is required.');
        $q = Sanitizer::clean($r->str('question_html'));
        $now = Db::now();
        $id = Db::tx(function () use ($title, $q, $now) {
            $id = Db::insert('projects', [
                'title' => mb_substr($title, 0, 255), 'question_html' => $q['html'], 'status' => 'open',
                'created_by' => Auth::id(), 'created_at' => $now, 'updated_at' => $now,
            ]);
            Db::insert('project_members', ['project_id' => $id, 'user_id' => Auth::id(), 'role' => 'owner', 'joined_at' => $now]);
            return $id;
        });
        Response::json(['id' => $id], 201);
    }

    public static function show(Request $r): never
    {
        $id = $r->int('id');
        $role = Access::member($id);
        $p = Db::one('SELECT * FROM projects WHERE id = ?', [$id]);
        $p['my_role'] = $role;
        $p['last_activity_id'] = Activity::latest($id, 'question', $id);
        $p['members'] = self::members($id);
        $p['stats'] = [
            'documents_human' => (int)Db::value("SELECT COUNT(*) FROM documents WHERE project_id = ? AND origin = 'human' AND deleted_at IS NULL", [$id]),
            'documents_ai' => (int)Db::value("SELECT COUNT(*) FROM documents WHERE project_id = ? AND origin = 'ai' AND deleted_at IS NULL", [$id]),
            'bib' => (int)Db::value('SELECT COUNT(*) FROM bib_entries WHERE project_id = ?', [$id]),
            'conversations' => (int)Db::value('SELECT COUNT(*) FROM conversations WHERE project_id = ?', [$id]),
            'facts' => (int)Db::value('SELECT COUNT(*) FROM facts WHERE project_id = ? AND deleted_at IS NULL', [$id]),
        ];
        $p['recent_documents'] = Db::all(
            'SELECT d.id, d.title, d.origin, d.updated_at, u.name AS author FROM documents d JOIN users u ON u.id = d.created_by
             WHERE d.project_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 6', [$id]);
        Response::json($p);
    }

    public static function members(int $projectId): array
    {
        return Db::all(
            'SELECT u.id, u.name, u.orcid, u.affiliation, u.kind, u.ai_model, pm.role, pm.joined_at,
                    CASE WHEN u.last_login_at IS NULL THEN 0 ELSE 1 END AS has_logged_in
             FROM project_members pm JOIN users u ON u.id = pm.user_id
             WHERE pm.project_id = ? ORDER BY u.name', [$projectId]);
    }

    public static function update(Request $r): never
    {
        $id = $r->int('id');
        Access::owner($id);
        $data = ['updated_at' => Db::now()];
        if ($r->input('title') !== null) {
            if ($r->str('title') === '') throw new HttpError(422, 'A title is required.');
            $data['title'] = mb_substr($r->str('title'), 0, 255);
        }
        if ($r->input('question_html') !== null) {
            $q = Sanitizer::clean($r->str('question_html'));
            $data['question_html'] = $q['html'];
            Notify::mentions($id, 'project', $id, $q['mentions'], ['view' => 'overview'], $q['text'], null, false);
        }
        if (in_array($r->str('status'), ['open', 'solved', 'archived'], true)) $data['status'] = $r->str('status');
        Db::update('projects', $data, 'id = :id', ['id' => $id]);
        if (isset($data['title']) || isset($data['question_html']) || isset($data['status'])) Activity::touch($id, 'question', $id, 'updated');
        Response::json(['ok' => true]);
    }

    public static function addMember(Request $r): never
    {
        $id = $r->int('id');
        Access::owner($id);
        $orcid = Orcid::normalize($r->str('orcid'));
        if (!Orcid::isValid($orcid)) throw new HttpError(422, 'This is not a valid ORCID iD (format 0000-0000-0000-0000).');
        $role = $r->str('role') === 'owner' ? 'owner' : 'member';
        $user = Db::one('SELECT id FROM users WHERE orcid = ?', [$orcid]);
        if (!$user) {
            $name = Orcid::publicName($orcid) ?? $orcid;
            $uid = Db::insert('users', ['orcid' => $orcid, 'name' => $name, 'created_at' => Db::now()]);
        } else {
            $uid = (int)$user['id'];
        }
        if (Db::value('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', [$id, $uid])) {
            throw new HttpError(409, 'This researcher is already a member.');
        }
        Db::insert('project_members', ['project_id' => $id, 'user_id' => $uid, 'role' => $role, 'joined_at' => Db::now()]);
        Activity::touch($id, 'member', $uid, 'joined');
        Activity::joined($id, $uid);
        Notify::send($uid, $id, 'added', ['link' => ['view' => 'overview'], 'excerpt' => 'You were added to the project.']);
        Response::json(['members' => self::members($id)]);
    }

    public static function updateMember(Request $r): never
    {
        $id = $r->int('id');
        Access::owner($id);
        $uid = $r->int('uid');
        if (Db::value("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?", [$id, $uid]) === 'agent') {
            throw new HttpError(422, 'The role of an AI agent cannot be changed.');
        }
        $role = $r->str('role') === 'owner' ? 'owner' : 'member';
        if ($role === 'member') self::assertAnotherOwner($id, $uid);
        Db::update('project_members', ['role' => $role], 'project_id = :p AND user_id = :u', ['p' => $id, 'u' => $uid]);
        Response::json(['members' => self::members($id)]);
    }

    public static function removeMember(Request $r): never
    {
        $id = $r->int('id');
        $uid = $r->int('uid');
        if ($uid !== Auth::id() || Auth::isAgent()) Access::owner($id); else Access::member($id);
        self::assertAnotherOwner($id, $uid);
        Db::run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [$id, $uid]);
        Db::run('DELETE FROM conversation_participants WHERE user_id = ? AND conversation_id IN (SELECT id FROM conversations WHERE project_id = ?)', [$uid, $id]);
        Response::json(['members' => self::members($id)]);
    }

    private static function assertAnotherOwner(int $projectId, int $uid): void
    {
        $owners = Db::all("SELECT user_id FROM project_members WHERE project_id = ? AND role = 'owner'", [$projectId]);
        $ids = array_map('intval', array_column($owners, 'user_id'));
        if ($ids === [$uid]) throw new HttpError(422, 'A project needs at least one owner.');
    }

    /** Everything that can be @mentioned in the project. */
    public static function mentionables(Request $r): never
    {
        $id = $r->int('id');
        Access::member($id);
        Response::json([
            'users' => Db::all('SELECT u.id, u.name, u.orcid, u.kind FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name', [$id]),
            'documents' => Db::all('SELECT id, title, origin FROM documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY title', [$id]),
            'bib' => Db::all('SELECT id, cite_key, title, authors, year FROM bib_entries WHERE project_id = ? ORDER BY cite_key', [$id]),
            'facts' => Db::all('SELECT id, label, title, kind, origin FROM facts WHERE project_id = ? AND deleted_at IS NULL ORDER BY label', [$id]),
            'questions' => Db::all('SELECT id, title, status FROM open_questions WHERE project_id = ? AND deleted_at IS NULL ORDER BY id', [$id]),
            'strategies' => Db::all('SELECT s.id, s.title, s.status, s.question_id, q.title AS question FROM proof_strategies s JOIN open_questions q ON q.id = s.question_id
                                     WHERE s.project_id = ? AND s.deleted_at IS NULL AND q.deleted_at IS NULL ORDER BY s.id', [$id]),
        ]);
    }

    /** Where is something mentioned? (used on file / bib detail pages) */
    public static function backlinks(Request $r): never
    {
        $type = (string)($r->query['type'] ?? '');
        $id = $r->int('id');
        Access::member($id);
        $rows = Db::all('SELECT source_type, source_id FROM mentions WHERE project_id = ? AND mentioned_type = ? AND mentioned_id = ? ORDER BY id DESC LIMIT 50',
            [$id, $type, (int)($r->query['target'] ?? 0)]);
        $out = [];
        foreach ($rows as $m) {
            if ($m['source_type'] === 'message') {
                $row = Db::one('SELECT m.conversation_id, c.subject, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id
                                JOIN conversation_participants cp ON cp.conversation_id = c.id AND cp.user_id = ? WHERE m.id = ?', [Auth::id(), $m['source_id']]);
                if ($row) $out[] = ['kind' => 'message', 'label' => $row['subject'], 'link' => ['view' => 'conversations', 'id' => (int)$row['conversation_id']], 'at' => $row['created_at']];
            } elseif ($m['source_type'] === 'comment') {
                $c = Db::one('SELECT target_type, target_id, created_at FROM comments WHERE id = ?', [$m['source_id']]);
                if (!$c) continue;
                if ($c['target_type'] === 'conversation' && !Db::value('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [$c['target_id'], Auth::id()])) continue;
                if ($c['target_type'] === 'strategy') {
                    $s = Db::one('SELECT s.question_id FROM proof_strategies s JOIN open_questions q ON q.id = s.question_id WHERE s.id = ? AND s.deleted_at IS NULL AND q.deleted_at IS NULL', [$c['target_id']]);
                    if ($s) $out[] = ['kind' => 'comment', 'label' => 'Comment on a strategy', 'link' => ['view' => 'questions', 'id' => (int)$s['question_id'], 'query' => ['strategy' => (int)$c['target_id']]], 'at' => $c['created_at']];
                    continue;
                }
                if ($c['target_type'] === 'oquestion' && !Db::value('SELECT 1 FROM open_questions WHERE id = ? AND deleted_at IS NULL', [$c['target_id']])) continue;
                if ($c['target_type'] === 'notation') {
                    $out[] = ['kind' => 'comment', 'label' => 'Comment on a notation entry', 'link' => ['view' => 'facts', 'query' => ['mode' => 'notation', 'notation' => (int)$c['target_id']]], 'at' => $c['created_at']];
                    continue;
                }
                $view = ['conversation' => 'conversations', 'document' => 'files', 'bib' => 'bib', 'fact' => 'facts', 'oquestion' => 'questions'][$c['target_type']];
                $names = ['oquestion' => 'question'];
                $out[] = ['kind' => 'comment', 'label' => 'Comment on ' . ($names[$c['target_type']] ?? $c['target_type']), 'link' => ['view' => $view, 'id' => (int)$c['target_id']], 'at' => $c['created_at']];
            } elseif ($m['source_type'] === 'oquestion') {
                $q = Db::one('SELECT id, title, updated_at FROM open_questions WHERE id = ? AND deleted_at IS NULL', [$m['source_id']]);
                if ($q) $out[] = ['kind' => 'question', 'label' => 'Question: ' . $q['title'], 'link' => ['view' => 'questions', 'id' => (int)$q['id']], 'at' => $q['updated_at']];
            } elseif ($m['source_type'] === 'strategy') {
                $s = Db::one('SELECT s.id, s.question_id, s.title, s.updated_at FROM proof_strategies s JOIN open_questions q ON q.id = s.question_id WHERE s.id = ? AND s.deleted_at IS NULL AND q.deleted_at IS NULL', [$m['source_id']]);
                if ($s) $out[] = ['kind' => 'question', 'label' => 'Strategy: ' . $s['title'], 'link' => ['view' => 'questions', 'id' => (int)$s['question_id'], 'query' => ['strategy' => (int)$s['id']]], 'at' => $s['updated_at']];
            } elseif ($m['source_type'] === 'answer') {
                $q = Db::one('SELECT q.id, q.title, a.created_at FROM question_answers a JOIN open_questions q ON q.id = a.question_id WHERE a.id = ? AND q.deleted_at IS NULL', [$m['source_id']]);
                if ($q) $out[] = ['kind' => 'question', 'label' => 'Proposed answer to: ' . $q['title'], 'link' => ['view' => 'questions', 'id' => (int)$q['id']], 'at' => $q['created_at']];
            } elseif ($m['source_type'] === 'fact') {
                $f = Db::one('SELECT id, label, updated_at FROM facts WHERE id = ? AND deleted_at IS NULL', [$m['source_id']]);
                if ($f) $out[] = ['kind' => 'fact', 'label' => 'Fact ' . $f['label'], 'link' => ['view' => 'facts', 'id' => (int)$f['id']], 'at' => $f['updated_at']];
            } elseif ($m['source_type'] === 'fact_proof') {
                $f = Db::one('SELECT f.id, f.label, p.id AS proof_id, p.updated_at FROM fact_proofs p JOIN facts f ON f.id = p.fact_id WHERE p.id = ? AND f.deleted_at IS NULL', [$m['source_id']]);
                if ($f) $out[] = ['kind' => 'fact', 'label' => 'Proof of ' . $f['label'], 'link' => ['view' => 'facts', 'id' => (int)$f['id'], 'query' => ['proof' => (int)$f['proof_id']]], 'at' => $f['updated_at']];
            } elseif ($m['source_type'] === 'fact_review') {
                $f = Db::one('SELECT f.id, f.label, v.updated_at FROM fact_reviews v JOIN facts f ON f.id = v.fact_id WHERE v.id = ? AND f.deleted_at IS NULL', [$m['source_id']]);
                if ($f) $out[] = ['kind' => 'fact', 'label' => 'Review of ' . $f['label'], 'link' => ['view' => 'facts', 'id' => (int)$f['id']], 'at' => $f['updated_at']];
            }
        }
        if ($type === 'fact') {
            foreach (Db::all("SELECT a.answer, a.state, a.created_at, q.id, q.title FROM question_answers a JOIN open_questions q ON q.id = a.question_id
                              WHERE a.project_id = ? AND a.fact_id = ? AND a.state IN ('proposed', 'ratified') AND q.deleted_at IS NULL", [$id, (int)($r->query['target'] ?? 0)]) as $a) {
                $out[] = ['kind' => 'question', 'label' => ucfirst($a['state']) . " {$a['answer']} answer to: {$a['title']}", 'link' => ['view' => 'questions', 'id' => (int)$a['id']], 'at' => $a['created_at']];
            }
        }
        // Questions and strategies that are explicitly linked to this item.
        foreach (Db::all('SELECT DISTINCT q.id, q.title, q.updated_at FROM question_links l JOIN open_questions q ON q.id = l.question_id
                          WHERE l.project_id = ? AND l.target_type = ? AND l.target_id = ? AND q.deleted_at IS NULL', [$id, $type, (int)($r->query['target'] ?? 0)]) as $q) {
            $out[] = ['kind' => 'question', 'label' => 'Question: ' . $q['title'], 'link' => ['view' => 'questions', 'id' => (int)$q['id']], 'at' => $q['updated_at']];
        }
        Response::json(['backlinks' => $out]);
    }
}
