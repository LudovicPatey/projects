<?php
declare(strict_types=1);

namespace App;

final class Auth
{
    private static ?array $user = null;
    /** Set when the request is authenticated by an agent API token instead of a session. */
    private static ?array $token = null;
    /** True when the request comes from a user's AI client, through a personal API key. */
    private static bool $client = false;
    /** The only writes a personal key can make: everything else would look human-written. */
    private const CLIENT_WRITES = [
        'POST /api/projects/{pid}/facts', 'POST /api/projects/{pid}/facts/batch', 'PATCH /api/facts/{id}',
        'POST /api/facts/{id}/reviews', 'POST /api/facts/{id}/lean', 'POST /api/fact-lean/{lid}/check',
    ];
    private const CLIENT_NO_READ = ['/api/me/keys', '/api/projects/{id}/agents', '/api/agent/context'];

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
        if ($tok !== null && str_starts_with($tok, 'ouk_')) {
            $row = Db::one(
                "SELECT k.id AS key_id, u.id, u.orcid, u.name, u.email, u.affiliation, u.kind, u.ai_model
                 FROM user_api_keys k JOIN users u ON u.id = k.user_id
                 WHERE k.token_hash = ? AND k.revoked_at IS NULL AND u.kind = 'human'", [hash('sha256', $tok)]);
            if (!$row) throw new HttpError(401, 'Invalid or revoked API key.');
            Db::update('user_api_keys', ['last_used_at' => Db::now()], 'id = :id', ['id' => $row['key_id']]);
            self::$client = true;
            self::$token = ['token_project_id' => null];
            unset($row['key_id']);
            self::$user = $row;
        } elseif ($tok !== null) {
            $row = Db::one(
                "SELECT t.id AS token_id, t.project_id AS token_project_id, t.created_by AS token_created_by, u.id, u.orcid, u.name, u.email, u.affiliation, u.kind, u.ai_model
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

    public static function isClient(): bool { self::user(); return self::$client; }

    /** The request is made by an AI: a project agent or a user's AI client. */
    public static function isAi(): bool { return self::isAgent() || self::isClient(); }

    /** The person an AI output is for: the key's owner, or the owner who issued the agent's token. */
    public static function aiUserId(): int
    {
        $u = self::require();
        return (int)($u['token_created_by'] ?? $u['id']);
    }

    public static function checkClientRoute(string $method, string $pattern): void
    {
        if (!self::isClient()) return;
        $ok = in_array($method, ['GET', 'HEAD'], true)
            ? !in_array($pattern, self::CLIENT_NO_READ, true)
            : in_array("$method $pattern", self::CLIENT_WRITES, true);
        if (!$ok) throw new HttpError(403, 'A personal API key can read the project and submit facts, reviews and Lean proofs. It cannot do this.');
    }

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
