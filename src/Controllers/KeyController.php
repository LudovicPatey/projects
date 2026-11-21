<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Auth, Db, HttpError, Request, Response};

/** Personal API keys, created by a signed-in user for their own AI client. */
final class KeyController
{
    private const MAX_ACTIVE = 10;

    public static function list(Request $r): never
    {
        self::humanSession();
        Response::json(['keys' => self::keys()]);
    }

    public static function create(Request $r): never
    {
        self::humanSession();
        $name = mb_substr($r->str('name'), 0, 120);
        if ($name === '') throw new HttpError(422, 'Give this key a name, for example the AI client that will use it.');
        $n = (int)Db::value('SELECT COUNT(*) FROM user_api_keys WHERE user_id = ? AND revoked_at IS NULL', [Auth::id()]);
        if ($n >= self::MAX_ACTIVE) throw new HttpError(422, 'You have too many active keys. Revoke one first.');
        $token = 'ouk_' . bin2hex(random_bytes(24));
        Db::insert('user_api_keys', [
            'user_id' => Auth::id(), 'name' => $name, 'token_hash' => hash('sha256', $token),
            'token_prefix' => substr($token, 0, 11), 'created_at' => Db::now(),
        ]);
        Response::json(['token' => $token, 'keys' => self::keys()], 201);
    }

    public static function revoke(Request $r): never
    {
        self::humanSession();
        Db::run('UPDATE user_api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [Db::now(), $r->int('id'), Auth::id()]);
        Response::json(['keys' => self::keys()]);
    }

    private static function humanSession(): void
    {
        if (Auth::isAi()) throw new HttpError(403, 'API keys are managed from the profile page.');
    }

    private static function keys(): array
    {
        return Db::all('SELECT id, name, token_prefix, created_at, last_used_at FROM user_api_keys
                        WHERE user_id = ? AND revoked_at IS NULL ORDER BY id DESC', [Auth::id()]);
    }
}
