<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Auth, Db, HttpError, ProjectAdmin, Request, Response};

/** The Admin page of a project: maintenance actions for its owners, with a preview and, when destructive, a backup and a typed confirmation. */
final class AdminController
{
    public static function show(Request $r): never
    {
        $pid = self::owner($r);
        $actions = [];
        foreach (ProjectAdmin::ACTIONS as $k => $_) $actions[] = ProjectAdmin::preview($pid, $k, []);
        Response::json(['summary' => ProjectAdmin::summary($pid), 'actions' => $actions]);
    }

    public static function preview(Request $r): never
    {
        $pid = self::owner($r);
        Response::json(ProjectAdmin::preview($pid, (string)($r->query['action'] ?? ''), self::options($r->query)));
    }

    public static function run(Request $r): never
    {
        $pid = self::owner($r);
        $action = $r->str('action');
        if (!isset(ProjectAdmin::ACTIONS[$action])) throw new HttpError(404, 'Unknown action.');
        if (ProjectAdmin::ACTIONS[$action][1]) {
            $title = (string)Db::value('SELECT title FROM projects WHERE id = ?', [$pid]);
            if (mb_strtolower(trim($r->str('confirm'))) !== mb_strtolower(trim($title))) throw new HttpError(422, 'Type the title of the project to confirm.');
        }
        $result = ProjectAdmin::run($pid, $action, self::options((array)$r->input('options', [])));
        Response::json($result + ['summary' => ProjectAdmin::summary($pid)]);
    }

    private static function options(array $in): array
    {
        $on = fn($k) => in_array($in[$k] ?? null, [true, 1, '1', 'true'], true);
        return array_filter(['requeue' => $on('requeue'), 'notation' => $on('notation'), 'mode' => ($in['mode'] ?? '') === 'all' ? 'all' : null]);
    }

    private static function owner(Request $r): int
    {
        if (Auth::isAi()) throw new HttpError(403, 'Only a person can do this.');
        $pid = $r->int('id');
        Access::owner($pid);
        return $pid;
    }
}
