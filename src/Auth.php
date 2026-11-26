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
    /** Set when the request carries a valid audit key: it signs nobody in, and only the audit routes accept it. */
    private static ?array $audit = null;
    /** The only writes a personal key can make: everything else would look human-written. */
    private const CLIENT_WRITES = [
        'POST /api/projects/{pid}/facts', 'POST /api/projects/{pid}/facts/batch', 'PATCH /api/facts/{id}',
        'POST /api/facts/{id}/reviews', 'POST /api/facts/{id}/proofs', 'POST /api/projects/{id}/notation', 'POST /api/facts/{id}/rephrasings', 'PATCH /api/fact-proofs/{proof}', 'POST /api/fact-proofs/{proof}/reviews', 'POST /api/facts/{id}/comment-links', 'POST /api/facts/{id}/lean', 'POST /api/fact-lean/{lid}/check',
        'POST /api/projects/{pid}/questions', 'PATCH /api/questions/{id}', 'POST /api/questions/{id}/strategies',
        'POST /api/questions/{id}/links', 'PATCH /api/strategies/{id}',
        'POST /api/questions/{id}/answers', 'POST /api/answers/{id}/withdraw',
        'POST /api/ai/tasks/claim', 'POST /api/ai/tasks/{id}/heartbeat', 'POST /api/ai/tasks/{id}/complete', 'POST /api/ai/tasks/{id}/answer', 'POST /api/ai/tasks/{id}/fail', 'POST /api/ai/tasks/{id}/release', 'POST /api/projects/{id}/ai/suggestions', 'POST /api/projects/{id}/consolidation', 'POST /api/projects/{id}/ai/tasks',
        'POST /api/projects/{pid}/prover/campaigns', 'POST /api/prover/campaigns/{id}/rounds', 'POST /api/prover/rounds/{id}/finish', 'POST /api/prover/rounds/{id}/lead',
        'POST /api/prover/rounds/{id}/notes', 'POST /api/prover/rounds/{id}/facts', 'POST /api/prover/rounds/{id}/rejected', 'POST /api/prover/rounds/{id}/cited',
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
        if (empty($_SESSION['uid']) && isset($_COOKIE[self::LOGIN_COOKIE])) self::resume((string)$_COOKIE[self::LOGIN_COOKIE]);
    }

    // ----- staying signed in -----
    // A PHP session ends when the browser drops its cookie (a phone closing the tab) or when the host clears idle sessions,
    // often after 24 minutes. A sign-in therefore also leaves a long-lived cookie on the device: a random selector and a secret,
    // whose hash only is stored. It signs the device in again when its session is gone. Signing out removes it.

    public const LOGIN_COOKIE = 'crp_login';
    public const LOGIN_DAYS = 60;

    private static function remember(int $uid): void
    {
        $selector = bin2hex(random_bytes(12));
        $secret = bin2hex(random_bytes(32));
        $now = Db::now();
        Db::insert('login_tokens', ['user_id' => $uid, 'selector' => $selector, 'token_hash' => hash('sha256', $secret), 'user_agent' => mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
            'created_at' => $now, 'last_used_at' => $now, 'expires_at' => gmdate('Y-m-d H:i:s', time() + self::LOGIN_DAYS * 86400)]);
        self::loginCookie("$selector.$secret", time() + self::LOGIN_DAYS * 86400);
    }

    /** Signs the device in again from its login cookie. A wrong secret for a known selector looks like a stolen cookie: the token goes. */
    private static function resume(string $cookie): void
    {
        if (!preg_match('/^([0-9a-f]{24})\.([0-9a-f]{64})$/', $cookie, $m)) { self::loginCookie('', 1); return; }
        $t = Db::one('SELECT l.id, l.user_id, l.token_hash, l.expires_at, l.last_used_at FROM login_tokens l JOIN users u ON u.id = l.user_id AND u.kind = \'human\' WHERE l.selector = ?', [$m[1]]);
        if (!$t || !hash_equals((string)$t['token_hash'], hash('sha256', $m[2])) || $t['expires_at'] < Db::now()) {
            if ($t) Db::run('DELETE FROM login_tokens WHERE id = ?', [$t['id']]);
            self::loginCookie('', 1);
            return;
        }
        session_regenerate_id(true);
        $_SESSION['uid'] = (int)$t['user_id'];
        self::$user = null;
        // Used again: it lasts another 60 days, on the server and in the browser.
        $until = time() + self::LOGIN_DAYS * 86400;
        Db::update('login_tokens', ['last_used_at' => Db::now(), 'expires_at' => gmdate('Y-m-d H:i:s', $until)], 'id = :id', ['id' => $t['id']]);
        self::loginCookie($cookie, $until);
    }

    private static function forget(): void
    {
        $c = (string)($_COOKIE[self::LOGIN_COOKIE] ?? '');
        if (preg_match('/^([0-9a-f]{24})\./', $c, $m)) Db::run('DELETE FROM login_tokens WHERE selector = ?', [$m[1]]);
        if ($c !== '') self::loginCookie('', 1);
    }

    private static function loginCookie(string $value, int $expires): void
    {
        if (headers_sent()) return;
        setcookie(self::LOGIN_COOKIE, $value, ['expires' => $expires, 'path' => '/', 'secure' => str_starts_with(Config::appUrl(), 'https://'), 'httponly' => true, 'samesite' => 'Lax']);
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
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if (preg_match('/^Bearer\s+(\S+)$/i', trim($h), $m)) return $m[1];
        $k = trim($_SERVER['HTTP_X_API_KEY'] ?? '');
        return $k !== '' ? $k : null;
    }

    public static function user(): ?array
    {
        if (self::$user !== null) return self::$user;
        $tok = self::bearer();
        if ($tok !== null && str_starts_with($tok, 'oqa_')) {
            self::$audit ??= Db::one('SELECT id, project_id, label FROM audit_keys WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?', [hash('sha256', $tok), Db::now()]) ?: null;
            return null; // never a user: every route that needs one answers 401
        }
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
        if (!$ok) throw new HttpError(403, 'A personal API key can read the project and submit facts, reviews, Lean proofs, questions, strategies, proposed answers and AI task results. It cannot do this.');
    }

    /** Project the current agent token is bound to (null for humans). */
    public static function tokenProject(): ?int { return self::$token ? (int)self::$token['token_project_id'] : null; }

    public static function require(): array
    {
        $u = self::user();
        if (!$u) throw new HttpError(401, 'Not authenticated');
        return $u;
    }

    public static function id(): int
    {
        self::user();
        if (self::$audit) return 0; // an auditor is nobody: private conversations stay hidden, nothing is starred
        return (int)self::require()['id'];
    }

    /** The audit key of this request, or null. @return ?array{id: int, project_id: int, label: string} */
    public static function audit(): ?array
    {
        self::user();
        return self::$audit;
    }

    /** Finds or creates a user by ORCID iD and logs them in. */
    public static function loginOrcid(string $orcid, string $name): void
    {
        $now = Db::now();
        $u = Db::one("SELECT id, name FROM users WHERE orcid = ? AND kind = 'human'", [$orcid]);
        if ($u) {
            Db::update('users', ['last_login_at' => $now] + ($name ? ['name' => $name] : []), 'id = :id', ['id' => $u['id']]);
            // The first sign-in, kept: an account an owner created by adding the researcher is used only from then on.
            Db::run('UPDATE users SET first_login_at = ? WHERE id = ? AND first_login_at IS NULL', [$now, $u['id']]);
            $id = (int)$u['id'];
        } else {
            $id = Db::insert('users', ['orcid' => $orcid, 'name' => $name ?: $orcid, 'created_at' => $now, 'last_login_at' => $now, 'first_login_at' => $now]);
        }
        session_regenerate_id(true);
        $_SESSION['uid'] = $id;
        self::$user = null;
        self::forget(); // another account may have been signed in on this device
        self::remember($id);
        // Expired tokens of everyone, now and then.
        if (random_int(1, 50) === 1) Db::run('DELETE FROM login_tokens WHERE expires_at < ?', [Db::now()]);
    }

    public static function logout(): void
    {
        self::forget();
        $_SESSION = [];
        if (session_status() === PHP_SESSION_ACTIVE) session_destroy();
    }
}
