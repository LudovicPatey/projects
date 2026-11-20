<?php
declare(strict_types=1);

namespace App\Controllers;

use App\{Auth, Config, Db, HttpError, Orcid, Request, Response};

final class AuthController
{
    public static function login(Request $r): never
    {
        $state = bin2hex(random_bytes(16));
        $_SESSION['oauth_state'] = $state;
        $_SESSION['after_login'] = preg_match('#^/[^/]#', (string)($r->query['next'] ?? '')) ? $r->query['next'] : '/';
        Response::redirect(Orcid::authorizeUrl($state));
    }

    public static function callback(Request $r): never
    {
        if (!empty($r->query['error'])) Response::redirect(Config::appUrl() . '/?login_error=' . urlencode((string)$r->query['error']));
        $state = (string)($r->query['state'] ?? '');
        if (!$state || !hash_equals($_SESSION['oauth_state'] ?? '', $state)) throw new HttpError(400, 'Invalid OAuth state. Please try to log in again.');
        unset($_SESSION['oauth_state']);
        $info = Orcid::exchangeCode((string)($r->query['code'] ?? ''));
        Auth::loginOrcid($info['orcid'], $info['name']);
        Response::redirect(Config::appUrl() . ($_SESSION['after_login'] ?? '/'));
    }

    /** Development only: log in as any ORCID iD without going through orcid.org. */
    public static function devLogin(Request $r): never
    {
        if (!Config::isDev()) throw new HttpError(404, 'Not found');
        $orcid = Orcid::normalize((string)($r->query['orcid'] ?? '0000-0002-1825-0097'));
        Auth::loginOrcid($orcid, (string)($r->query['name'] ?? ''));
        Response::redirect(Config::appUrl() . '/');
    }

    public static function logout(Request $r): never
    {
        Auth::logout();
        Response::json(['ok' => true]);
    }

    public static function me(Request $r): never
    {
        $u = Auth::user();
        Response::json([
            'user' => $u,
            'csrf' => Auth::csrf(),
            'dev' => Config::isDev(),
            'orcid_sandbox' => (bool)Config::get('orcid.sandbox'),
        ]);
    }

    public static function updateProfile(Request $r): never
    {
        if (Auth::isAgent()) throw new HttpError(403, 'Agent profiles are managed by project owners.');
        $data = [];
        if ($r->input('name') !== null && $r->str('name') !== '') $data['name'] = mb_substr($r->str('name'), 0, 255);
        if ($r->input('affiliation') !== null) $data['affiliation'] = mb_substr($r->str('affiliation'), 0, 255) ?: null;
        if ($r->input('email') !== null) {
            $e = $r->str('email');
            if ($e !== '' && !filter_var($e, FILTER_VALIDATE_EMAIL)) throw new HttpError(422, 'Invalid email address.');
            $data['email'] = $e ?: null;
        }
        if ($data) Db::update('users', $data, 'id = :id', ['id' => Auth::id()]);
        Response::json(['ok' => true]);
    }
}
