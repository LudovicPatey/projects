<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Activity, Auth, Db, HttpError, Notify, Request, Response, Sanitizer};

/**
 * Public projects and requests to join them. A public project shows its card (title, main question, owners, member count) to every
 * signed-in researcher; nothing inside it is readable until an owner accepts their request (Access::member is unchanged).
 * Only a person asks, accepts or declines: AI agents and personal API keys cannot.
 */
final class JoinController
{
    public const MOTIVATION_MIN = 20;
    public const MOTIVATION_MAX = 1000;
    public const NOTE_MAX = 500;
    /** After a decline, the same researcher can ask the same project again after this many days. */
    public const ASK_AGAIN_DAYS = 7;

    private static function person(): void
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can ask to join a project or answer a request. AI agents and API keys cannot.');
    }

    /** The cards of the public projects the caller is not a member of, with their own request to each, and their pending requests elsewhere. */
    public static function publicList(Request $r): never
    {
        self::person();
        $me = Auth::id();
        $rows = Db::all(
            "SELECT p.id, p.title, p.status, p.question_html, p.updated_at FROM projects p
             WHERE p.visibility = 'public' AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?)
             ORDER BY p.updated_at DESC, p.id DESC", [$me]);
        $mine = self::myRequests($me);
        $out = [];
        foreach ($rows as $p) $out[] = self::card($p) + ['request' => $mine[(int)$p['id']] ?? null];
        // A request to a project made private since stays the requester's to see and withdraw, with the card they asked from.
        $listed = array_column($out, 'id');
        $elsewhere = [];
        foreach ($mine as $pid => $req) {
            if ($req['status'] !== 'pending' || in_array($pid, $listed, true)) continue;
            $p = Db::one('SELECT id, title, status, question_html, updated_at FROM projects WHERE id = ?', [$pid]);
            if ($p && !Access::isMember($pid, $me)) $elsewhere[] = self::card($p) + ['request' => $req, 'private_now' => true];
        }
        Response::json(['projects' => array_merge($elsewhere, $out), 'limits' => self::limits()]);
    }

    public static function limits(): array
    {
        return ['motivation_min' => self::MOTIVATION_MIN, 'motivation_max' => self::MOTIVATION_MAX, 'note_max' => self::NOTE_MAX, 'ask_again_days' => self::ASK_AGAIN_DAYS];
    }

    /** What a non-member may know of a project: nothing beyond this. */
    private static function card(array $p): array
    {
        $id = (int)$p['id'];
        $counts = Db::one("SELECT SUM(CASE WHEN u.kind = 'agent' THEN 0 ELSE 1 END) AS people, SUM(CASE WHEN u.kind = 'agent' THEN 1 ELSE 0 END) AS agents
                           FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?", [$id]);
        return [
            'id' => $id, 'title' => $p['title'], 'status' => $p['status'], 'updated_at' => $p['updated_at'],
            'question_text' => mb_substr(Sanitizer::toText((string)$p['question_html']), 0, 400),
            'owners' => Db::all("SELECT u.id, u.name FROM project_members m JOIN users u ON u.id = m.user_id
                                 WHERE m.project_id = ? AND m.role = 'owner' AND u.kind <> 'agent' ORDER BY m.joined_at, u.id", [$id]),
            'members' => (int)($counts['people'] ?? 0), 'agents' => (int)($counts['agents'] ?? 0),
        ];
    }

    /** The caller's latest request to each project: pending, or the latest decision. @return array<int, array> by project */
    private static function myRequests(int $me): array
    {
        $out = [];
        foreach (Db::all('SELECT id, project_id, motivation, status, decision_note, created_at, decided_at FROM join_requests WHERE user_id = ? ORDER BY id', [$me]) as $q) {
            $q['id'] = (int)$q['id'];
            $q['ask_again_at'] = $q['status'] === 'declined' ? self::askAgainAt((string)$q['decided_at']) : null;
            $out[(int)$q['project_id']] = $q;
        }
        return $out;
    }

    private static function askAgainAt(string $decidedAt): string
    {
        return gmdate('Y-m-d H:i:s', strtotime($decidedAt . ' UTC') + self::ASK_AGAIN_DAYS * 86400);
    }

    public static function ask(Request $r): never
    {
        self::person();
        $pid = $r->int('id');
        $me = Auth::id();
        // A private project answers as if it did not exist: its existence is not revealed.
        $project = Db::one("SELECT id, title FROM projects WHERE id = ? AND visibility = 'public'", [$pid]);
        if (!$project) throw new HttpError(404, 'This project is not open to requests.');
        if (Access::isMember($pid, $me)) throw new HttpError(409, 'You are already a member of this project.');
        $motivation = trim(preg_replace('/[^\P{C}\n\t]/u', '', $r->str('motivation')) ?? '');
        $len = mb_strlen($motivation);
        if ($len < self::MOTIVATION_MIN) throw new HttpError(422, 'Explain in a few sentences why you would like to join (at least ' . self::MOTIVATION_MIN . ' characters).');
        if ($len > self::MOTIVATION_MAX) throw new HttpError(422, 'Your motivation is too long: ' . self::MOTIVATION_MAX . ' characters at most.');
        $id = Db::tx(function () use ($pid, $me, $motivation) {
            if (Db::value("SELECT 1 FROM join_requests WHERE project_id = ? AND user_id = ? AND status = 'pending'", [$pid, $me])) {
                throw new HttpError(409, 'You already asked to join this project. The owners have not answered yet.');
            }
            $declined = Db::value("SELECT MAX(decided_at) FROM join_requests WHERE project_id = ? AND user_id = ? AND status = 'declined'", [$pid, $me]);
            if ($declined && self::askAgainAt((string)$declined) > Db::now()) {
                throw new HttpError(429, 'The owners declined your last request. You can ask again from ' . substr(self::askAgainAt((string)$declined), 0, 10) . ' (UTC).');
            }
            return Db::insert('join_requests', ['project_id' => $pid, 'user_id' => $me, 'motivation' => $motivation, 'status' => 'pending', 'created_at' => Db::now()]);
        });
        foreach (self::owners($pid) as $uid) {
            Notify::send($uid, $pid, 'join_request', ['link' => ['view' => 'members', 'request' => $id], 'excerpt' => $motivation]);
        }
        Response::json(['request' => self::myRequests($me)[$pid]], 201);
    }

    /** The requester takes back a pending request. */
    public static function withdraw(Request $r): never
    {
        self::person();
        $q = Db::one('SELECT * FROM join_requests WHERE id = ? AND user_id = ?', [$r->int('id'), Auth::id()]);
        if (!$q) throw new HttpError(404, 'Request not found.');
        if ($q['status'] !== 'pending') throw new HttpError(409, 'This request was already answered or withdrawn.');
        Db::update('join_requests', ['status' => 'withdrawn', 'decided_at' => Db::now()], 'id = :id', ['id' => $q['id']]);
        Response::json(['ok' => true]);
    }

    /** Pending requests of a project, for its owners. */
    public static function list(Request $r): never
    {
        self::person();
        $pid = $r->int('id');
        Access::owner($pid);
        Response::json(['requests' => self::pending($pid), 'visibility' => Db::value('SELECT visibility FROM projects WHERE id = ?', [$pid]), 'limits' => self::limits()]);
    }

    public static function pending(int $pid): array
    {
        $rows = Db::all("SELECT q.id, q.motivation, q.created_at, u.id AS user_id, u.name, u.orcid, u.affiliation,
                                (SELECT COUNT(*) FROM join_requests d WHERE d.project_id = q.project_id AND d.user_id = q.user_id AND d.status = 'declined') AS declined_before
                         FROM join_requests q JOIN users u ON u.id = q.user_id
                         WHERE q.project_id = ? AND q.status = 'pending' ORDER BY q.created_at, q.id", [$pid]);
        foreach ($rows as &$q) { $q['id'] = (int)$q['id']; $q['user_id'] = (int)$q['user_id']; $q['declined_before'] = (int)$q['declined_before']; }
        unset($q);
        return $rows;
    }

    /** How many requests wait for this owner's answer (0 for anyone else). */
    public static function pendingFor(int $pid, int $uid): int
    {
        if (Db::value('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?', [$pid, $uid]) !== 'owner') return 0;
        return (int)Db::value("SELECT COUNT(*) FROM join_requests WHERE project_id = ? AND status = 'pending'", [$pid]);
    }

    public static function accept(Request $r): never
    {
        [$q, $pid] = self::decidable($r);
        $uid = (int)$q['user_id'];
        Db::tx(function () use ($q, $pid, $uid) {
            Db::update('join_requests', ['status' => 'accepted', 'decided_by' => Auth::id(), 'decided_at' => Db::now()], 'id = :id', ['id' => $q['id']]);
            if (!Access::isMember($pid, $uid)) Db::insert('project_members', ['project_id' => $pid, 'user_id' => $uid, 'role' => 'member', 'joined_at' => Db::now()]);
        });
        Activity::touch($pid, 'member', $uid, 'joined');
        Activity::joined($pid, $uid);
        Notify::send($uid, $pid, 'join_accepted', ['link' => ['view' => 'overview'], 'excerpt' => 'Your request to join was accepted: you are now a member.']);
        Response::json(['requests' => self::pending($pid), 'members' => ProjectController::members($pid)]);
    }

    public static function decline(Request $r): never
    {
        [$q, $pid] = self::decidable($r);
        $note = trim(preg_replace('/[^\P{C}\n\t]/u', '', $r->str('note')) ?? '');
        if (mb_strlen($note) > self::NOTE_MAX) throw new HttpError(422, 'The note is too long: ' . self::NOTE_MAX . ' characters at most.');
        Db::update('join_requests', ['status' => 'declined', 'decision_note' => $note !== '' ? $note : null, 'decided_by' => Auth::id(), 'decided_at' => Db::now()],
            'id = :id', ['id' => $q['id']]);
        Notify::send((int)$q['user_id'], $pid, 'join_declined', ['link' => ['to' => 'projects'], 'excerpt' => $note]);
        Response::json(['requests' => self::pending($pid)]);
    }

    /** A pending request of a project the caller owns. @return array{0: array, 1: int} */
    private static function decidable(Request $r): array
    {
        self::person();
        $q = Db::one('SELECT * FROM join_requests WHERE id = ?', [$r->int('id')]);
        if (!$q) throw new HttpError(404, 'Request not found.');
        $pid = (int)$q['project_id'];
        Access::owner($pid);
        if ($q['status'] !== 'pending') throw new HttpError(409, $q['status'] === 'withdrawn' ? 'The researcher withdrew this request.' : 'This request was already answered.');
        return [$q, $pid];
    }

    /** A researcher added by ORCID iD while their request waited: the request is answered by that. */
    public static function settleByAdding(int $pid, int $uid): void
    {
        Db::run("UPDATE join_requests SET status = 'accepted', decided_by = ?, decided_at = ? WHERE project_id = ? AND user_id = ? AND status = 'pending'",
            [Auth::id(), Db::now(), $pid, $uid]);
    }

    /** @return int[] the human owners of a project */
    private static function owners(int $pid): array
    {
        return array_map('intval', array_column(Db::all("SELECT m.user_id FROM project_members m JOIN users u ON u.id = m.user_id
                                                         WHERE m.project_id = ? AND m.role = 'owner' AND u.kind <> 'agent'", [$pid]), 'user_id'));
    }
}
