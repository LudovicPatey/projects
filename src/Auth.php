<?php
declare(strict_types=1);

namespace App;

final class Auth
{
    private static ?array $user = null;
    /** Set when the request is authenticated by an agent API token instead of a session. */
    private static ?array $token = null;

    public static function startSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) return;
        $secure = str_starts_with(Config::appUrl(), 'https://');
        session_name('crp_session');
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/',
            'secure' => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
        if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }

    public static function csrf(): string { return $_SESSION['csrf'] ?? ''; }

    public static function checkCsrf(Request $r): void
    {
        if (self::$token) return; // token-authenticated API calls are not exposed to CSRF
        if (in_array($r->method, ['GET', 'HEAD', 'OPTIONS'], true)) return;
        $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!$sent || !hash_equals(self::csrf(), $sent)) throw new HttpError(419, 'Invalid CSRF token, please reload the page.');
    }

    /** API token sent as "Authorization: Bearer ..." (or "X-Api-Key: ..." when the host strips Authorization). */
    public static function bearer(): ?string
    {
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (preg_match('/^Bearer\s+(\S+)$/i', trim($h), $m)) return $m[1];
        $k = trim($_SERVER['HTTP_X_API_KEY'] ?? '');
        return $k !== '' ? $k : null;
    }

    public static function user(): ?array
    {
        if (self::$user !== null) return self::$user;
        $tok = self::bearer();
        if ($tok !== null) {
            $row = Db::one(
                "SELECT t.id AS token_id, t.project_id AS token_project_id, u.id, u.orcid, u.name, u.email, u.affiliation, u.kind, u.ai_model
                 FROM api_tokens t JOIN users u ON u.id = t.agent_user_id
                 WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.kind = 'agent'", [hash('sha256', $tok)]);
            if (!$row) throw new HttpError(401, 'Invalid or revoked API token.');
            Db::update('api_tokens', ['last_used_at' => Db::now()], 'id = :id', ['id' => $row['token_id']]);
            self::$token = $row;
            self::$user = $row;
        } elseif (!empty($_SESSION['uid'])) {
            self::$user = Db::one('SELECT id, orcid, name, email, affiliation, kind, ai_model FROM users WHERE id = ?', [$_SESSION['uid']]);
        }
        return self::$user;
    }

    public static function isAgent(): bool { return (self::user()['kind'] ?? 'human') === 'agent'; }

    /** Project the current agent token is bound to (null for humans). */
    public static function tokenProject(): ?int { return self::$token ? (int)self::$token['token_project_id'] : null; }

    public static function require(): array
    {
        $u = self::user();
        if (!$u) throw new HttpError(401, 'Not authenticated');
        return $u;
    }

    public static function id(): int { return (int)self::require()['id']; }

    /** Finds or creates a user by ORCID iD and logs them in. */
    public static function loginOrcid(string $orcid, string $name): void
    {
        $now = Db::now();
        $u = Db::one("SELECT id, name FROM users WHERE orcid = ? AND kind = 'human'", [$orcid]);
        if ($u) {
            Db::update('users', ['last_login_at' => $now] + ($name ? ['name' => $name] : []), 'id = :id', ['id' => $u['id']]);
            $id = (int)$u['id'];
        } else {
            $id = Db::insert('users', ['orcid' => $orcid, 'name' => $name ?: $orcid, 'created_at' => $now, 'last_login_at' => $now]);
        }
        session_regenerate_id(true);
        $_SESSION['uid'] = $id;
        self::$user = null;
    }

    public static function logout(): void
    {
        $_SESSION = [];
        if (session_status() === PHP_SESSION_ACTIVE) session_destroy();
    }
}
