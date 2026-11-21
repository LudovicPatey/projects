<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Auth, Config, Db, HttpError, Request, Response};

/**
 * Bug reports and feature requests about the platform itself. A report is visible only to its
 * author and to the administrators listed in the `feedback_admins` setting. It is plain text,
 * and it records at most the address of the page, never the content of a project.
 */
final class FeedbackController
{
    public const KINDS = ['bug', 'feature'];
    public const IMPACTS = ['minor', 'normal', 'blocking'];
    public const STATUSES = ['new', 'planned', 'in_progress', 'done', 'declined'];
    private const MAX_PER_DAY = 20;
    private const MAX_BODY = 8000;

    public static function list(Request $r): never
    {
        self::human();
        $admin = self::isAdmin();
        $all = $admin && ($r->query['scope'] ?? '') === 'all';
        $rows = Db::all('SELECT f.*, u.name AS author_name, u.orcid AS author_orcid, rb.name AS responder_name, p.title AS project_title
                         FROM feedback_reports f JOIN users u ON u.id = f.user_id LEFT JOIN users rb ON rb.id = f.responded_by LEFT JOIN projects p ON p.id = f.project_id'
            . ($all ? '' : ' WHERE f.user_id = ?') . ' ORDER BY f.updated_at DESC, f.id DESC LIMIT 500', $all ? [] : [Auth::id()]);
        Response::json(['reports' => array_map([self::class, 'present'], $rows), 'is_admin' => $admin, 'unseen' => self::unseen(Auth::id())]);
    }

    public static function create(Request $r): never
    {
        self::human();
        $me = Auth::id();
        $since = gmdate('Y-m-d H:i:s', time() - 86400);
        if ((int)Db::value('SELECT COUNT(*) FROM feedback_reports WHERE user_id = ? AND created_at > ?', [$me, $since]) >= self::MAX_PER_DAY) {
            throw new HttpError(429, 'You have sent many reports today. Please try again tomorrow.');
        }
        $page = self::page($r->str('page'));
        $id = Db::insert('feedback_reports', self::content($r, null) + [
            'user_id' => $me, 'status' => 'new', 'page' => $page,
            'project_id' => self::projectOf($page), 'client_info' => mb_substr($r->str('client_info'), 0, 255) ?: null,
            'author_unseen' => 0, 'admin_unseen' => self::isAdmin() ? 0 : 1, 'created_at' => Db::now(), 'updated_at' => Db::now(),
        ]);
        Response::json(self::present(self::row($id)), 201);
    }

    /** The author edits a report until it is handled. An administrator sets its status and answer. */
    public static function update(Request $r): never
    {
        self::human();
        $f = self::visible($r->int('id'));
        $admin = self::isAdmin();
        $mine = (int)$f['user_id'] === Auth::id();
        $data = [];
        if ($r->input('title') !== null || $r->input('body_text') !== null || $r->input('kind') !== null || $r->input('impact') !== null) {
            if (!$mine) throw new HttpError(403, 'Only its author can change a report.');
            if ($f['status'] !== 'new') throw new HttpError(409, 'This report is already being handled. Send a new one to add information.');
            $data += self::content($r, $f);
            if (!$admin) $data['admin_unseen'] = 1;
        }
        if ($r->input('status') !== null || $r->input('response_text') !== null) {
            if (!$admin) throw new HttpError(403, 'Only an administrator can do this.');
            if ($r->input('status') !== null) {
                if (!in_array($r->str('status'), self::STATUSES, true)) throw new HttpError(422, 'Unknown status.');
                $data['status'] = $r->str('status');
            }
            if ($r->input('response_text') !== null) {
                $text = trim((string)$r->input('response_text'));
                if (mb_strlen($text) > self::MAX_BODY) throw new HttpError(422, 'The answer is too long.');
                $data['response_text'] = $text === '' ? null : $text;
                $data['responded_by'] = $text === '' ? null : Auth::id();
                $data['responded_at'] = $text === '' ? null : Db::now();
            }
            $changed = ($data['status'] ?? $f['status']) !== $f['status'] || ($data['response_text'] ?? $f['response_text']) !== $f['response_text'];
            if ($changed && !$mine) $data['author_unseen'] = 1;
        }
        if ($data) Db::update('feedback_reports', $data + ['updated_at' => Db::now()], 'id = :id', ['id' => $f['id']]);
        Response::json(self::present(self::row((int)$f['id'])));
    }

    /** Clears the badge of the current reader once the report has been displayed. */
    public static function seen(Request $r): never
    {
        self::human();
        $f = self::visible($r->int('id'));
        $data = [];
        if ((int)$f['user_id'] === Auth::id()) $data['author_unseen'] = 0;
        if (self::isAdmin()) $data['admin_unseen'] = 0;
        if ($data) Db::update('feedback_reports', $data, 'id = :id', ['id' => $f['id']]);
        Response::json(['unseen' => self::unseen(Auth::id())]);
    }

    public static function delete(Request $r): never
    {
        self::human();
        $f = self::visible($r->int('id'));
        if (!self::isAdmin() && $f['status'] !== 'new') throw new HttpError(409, 'This report is already being handled.');
        Db::run('DELETE FROM feedback_reports WHERE id = ?', [$f['id']]);
        Response::json(['ok' => true]);
    }

    /** Badge of the menu: answers for an author, plus new reports for an administrator. */
    public static function unseen(int $uid): int
    {
        if (Auth::isAi()) return 0;
        $n = (int)Db::value('SELECT COUNT(*) FROM feedback_reports WHERE user_id = ? AND author_unseen = 1', [$uid]);
        if (self::isAdmin()) $n += (int)Db::value('SELECT COUNT(*) FROM feedback_reports WHERE admin_unseen = 1 AND NOT (user_id = ? AND author_unseen = 1)', [$uid]);
        return $n;
    }

    public static function isAdmin(): bool
    {
        if (Auth::isAi()) return false;
        return in_array(Auth::require()['orcid'], (array)Config::get('feedback_admins', []), true);
    }

    // ---------------------------------------------------------------------

    private static function human(): void
    {
        if (Auth::isAi()) throw new HttpError(403, 'Feedback is sent by people, from the interface.');
    }

    private static function row(int $id): array
    {
        return Db::one('SELECT f.*, u.name AS author_name, u.orcid AS author_orcid, rb.name AS responder_name, p.title AS project_title
                        FROM feedback_reports f JOIN users u ON u.id = f.user_id LEFT JOIN users rb ON rb.id = f.responded_by LEFT JOIN projects p ON p.id = f.project_id
                        WHERE f.id = ?', [$id]) ?? throw new HttpError(404, 'Report not found');
    }

    /** Someone else's report looks exactly like one that does not exist. */
    private static function visible(int $id): array
    {
        $f = Db::one('SELECT * FROM feedback_reports WHERE id = ?', [$id]);
        if (!$f || ((int)$f['user_id'] !== Auth::id() && !self::isAdmin())) throw new HttpError(404, 'Report not found');
        return $f;
    }

    private static function content(Request $r, ?array $old): array
    {
        $kind = $r->str('kind', $old['kind'] ?? '');
        if (!in_array($kind, self::KINDS, true)) throw new HttpError(422, 'Choose a bug report or a feature request.');
        $impact = $r->str('impact', $old['impact'] ?? 'normal');
        if (!in_array($impact, self::IMPACTS, true)) throw new HttpError(422, 'Unknown impact.');
        $title = mb_substr($r->str('title', $old['title'] ?? ''), 0, 160);
        if ($title === '') throw new HttpError(422, 'A short title is required.');
        $body = trim(is_scalar($r->input('body_text')) ? (string)$r->input('body_text') : (string)($old['body_text'] ?? ''));
        if ($body === '') throw new HttpError(422, 'Please describe it.');
        if (mb_strlen($body) > self::MAX_BODY) throw new HttpError(422, 'The description is too long (8000 characters at most).');
        return ['kind' => $kind, 'impact' => $impact, 'title' => $title, 'body_text' => $body];
    }

    /** Only the shape of an address of the application is kept, without its query. */
    private static function page(string $page): ?string
    {
        return preg_match('~^#/(p/\d+(/[a-z]+(/\d+)?)?|projects|profile|help|feedback(/\d+)?)$~', $page) ? $page : null;
    }

    private static function projectOf(?string $page): ?int
    {
        if (!$page || !preg_match('~^#/p/(\d+)~', $page, $m)) return null;
        return Access::role((int)$m[1]) ? (int)$m[1] : null;
    }

    private static function present(array $f): array
    {
        $mine = (int)$f['user_id'] === Auth::id();
        $admin = self::isAdmin();
        return [
            'id' => (int)$f['id'], 'kind' => $f['kind'], 'impact' => $f['impact'], 'title' => $f['title'], 'body_text' => $f['body_text'], 'status' => $f['status'],
            'mine' => $mine, 'author' => $mine || $admin ? $f['author_name'] : null, 'author_orcid' => $admin ? $f['author_orcid'] : null,
            'page' => $f['page'], 'project_title' => $mine ? $f['project_title'] : null, 'client_info' => $f['client_info'],
            'response_text' => $f['response_text'], 'responder' => $f['response_text'] !== null ? $f['responder_name'] : null, 'responded_at' => $f['responded_at'],
            'unseen' => ($mine && (int)$f['author_unseen'] === 1) || ($admin && (int)$f['admin_unseen'] === 1),
            'created_at' => $f['created_at'], 'updated_at' => $f['updated_at'],
        ];
    }
}
