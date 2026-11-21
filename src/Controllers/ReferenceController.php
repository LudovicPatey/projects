<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Access, Auth, HttpError, References, Request, Response};

/** Lets rich text find and display references to any object of a project. */
final class ReferenceController
{
    /** GET ?keys=fact:3,message:8 : what the current user may see of each reference. */
    public static function resolve(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        $keys = is_string($r->query['keys'] ?? null) ? explode(',', $r->query['keys']) : [];
        Response::json(['refs' => (object)References::resolve($pid, Auth::id(), $keys)]);
    }

    /** GET ?q=text&type=fact : objects to cite, limited to what the current user can see. */
    public static function search(Request $r): never
    {
        $pid = $r->int('id');
        Access::member($pid);
        $q = is_string($r->query['q'] ?? null) ? mb_substr($r->query['q'], 0, 80) : '';
        $type = is_string($r->query['type'] ?? null) && $r->query['type'] !== '' ? $r->query['type'] : null;
        if ($type !== null && !in_array($type, References::TYPES, true)) throw new HttpError(422, 'Unknown reference type.');
        Response::json(['results' => References::search($pid, Auth::id(), $q, $type)]);
    }
}
