<?php
declare(strict_types=1);

require __DIR__ . '/../src/bootstrap.php';

use App\{Auth, Config, HttpError, Request, Response};
use App\Controllers\{AgentController, AuthController, BibController, CommentController, ConversationController,
    DocumentController, FactController, KeyController, NotificationController, ProjectController};

$routes = [
    // auth
    ['GET',    '/auth/login',                             [AuthController::class, 'login'], false],
    ['GET',    '/auth/callback',                          [AuthController::class, 'callback'], false],
    ['GET',    '/auth/dev-login',                         [AuthController::class, 'devLogin'], false],
    ['GET',    '/api/me',                                 [AuthController::class, 'me'], false],
    ['POST',   '/api/logout',                             [AuthController::class, 'logout']],
    ['PATCH',  '/api/me',                                 [AuthController::class, 'updateProfile']],
    ['GET',    '/api/me/keys',                            [KeyController::class, 'list']],
    ['POST',   '/api/me/keys',                            [KeyController::class, 'create']],
    ['DELETE', '/api/me/keys/{id}',                       [KeyController::class, 'revoke']],
    // projects & members
    ['GET',    '/api/projects',                           [ProjectController::class, 'list']],
    ['POST',   '/api/projects',                           [ProjectController::class, 'create']],
    ['GET',    '/api/projects/{id}',                      [ProjectController::class, 'show']],
    ['PATCH',  '/api/projects/{id}',                      [ProjectController::class, 'update']],
    ['POST',   '/api/projects/{id}/members',              [ProjectController::class, 'addMember']],
    ['PATCH',  '/api/projects/{id}/members/{uid}',        [ProjectController::class, 'updateMember']],
    ['DELETE', '/api/projects/{id}/members/{uid}',        [ProjectController::class, 'removeMember']],
    ['GET',    '/api/projects/{id}/mentionables',         [ProjectController::class, 'mentionables']],
    ['GET',    '/api/projects/{id}/context',              [AgentController::class, 'projectContext']],
    ['GET',    '/api/projects/{id}/backlinks',            [ProjectController::class, 'backlinks']],
    // AI agents
    ['GET',    '/api/projects/{id}/agents',               [AgentController::class, 'list']],
    ['POST',   '/api/projects/{id}/agents',               [AgentController::class, 'create']],
    ['PATCH',  '/api/projects/{id}/agents/{uid}',         [AgentController::class, 'update']],
    ['POST',   '/api/projects/{id}/agents/{uid}/token',   [AgentController::class, 'rotate']],
    ['DELETE', '/api/projects/{id}/agents/{uid}',         [AgentController::class, 'remove']],
    ['GET',    '/api/agent/context',                      [AgentController::class, 'context']],
    // bibliography
    ['GET',    '/api/projects/{pid}/bib',                 [BibController::class, 'list']],
    ['POST',   '/api/projects/{pid}/bib',                 [BibController::class, 'create']],
    ['GET',    '/api/projects/{pid}/bib/export',          [BibController::class, 'export']],
    ['GET',    '/api/bib/{id}',                           [BibController::class, 'show']],
    ['PATCH',  '/api/bib/{id}',                           [BibController::class, 'update']],
    ['DELETE', '/api/bib/{id}',                           [BibController::class, 'delete']],
    ['POST',   '/api/bib/{id}/pdf',                       [BibController::class, 'uploadPdf']],
    ['DELETE', '/api/bib/{id}/pdf',                       [BibController::class, 'removePdf']],
    ['GET',    '/api/bib/{id}/pdf',                       [BibController::class, 'pdf']],
    // documents (files)
    ['GET',    '/api/projects/{pid}/documents',           [DocumentController::class, 'list']],
    ['POST',   '/api/projects/{pid}/documents',           [DocumentController::class, 'create']],
    ['GET',    '/api/documents/{id}',                     [DocumentController::class, 'show']],
    ['PATCH',  '/api/documents/{id}',                     [DocumentController::class, 'update']],
    ['DELETE', '/api/documents/{id}',                     [DocumentController::class, 'delete']],
    ['POST',   '/api/documents/{id}/versions',            [DocumentController::class, 'addVersion']],
    ['POST',   '/api/documents/{id}/versions/{vid}/restore', [DocumentController::class, 'restore']],
    ['GET',    '/api/files/{fid}',                        [DocumentController::class, 'file']],
    ['GET',    '/api/versions/{vid}/zip',                 [DocumentController::class, 'zip']],
    // fact database
    ['GET',    '/api/projects/{pid}/facts',               [FactController::class, 'list']],
    ['POST',   '/api/projects/{pid}/facts',               [FactController::class, 'create']],
    ['POST',   '/api/projects/{pid}/facts/batch',         [FactController::class, 'batch']],
    ['GET',    '/api/fact-format',                        [FactController::class, 'format']],
    ['GET',    '/api/facts/{id}/trace',                   [FactController::class, 'trace']],
    ['GET',    '/api/facts/{id}',                         [FactController::class, 'show']],
    ['PATCH',  '/api/facts/{id}',                         [FactController::class, 'update']],
    ['DELETE', '/api/facts/{id}',                         [FactController::class, 'delete']],
    ['POST',   '/api/facts/{id}/retract',                 [FactController::class, 'retract']],
    ['POST',   '/api/facts/{id}/reinstate',               [FactController::class, 'reinstate']],
    ['POST',   '/api/facts/{id}/reviews',                 [FactController::class, 'review']],
    ['DELETE', '/api/facts/{id}/reviews/{rid}',           [FactController::class, 'deleteReview']],
    ['POST',   '/api/facts/{id}/lean',                    [FactController::class, 'addLean']],
    ['POST',   '/api/fact-lean/{lid}/check',              [FactController::class, 'checkLean']],
    ['DELETE', '/api/fact-lean/{lid}',                    [FactController::class, 'deleteLean']],
    // conversations
    ['GET',    '/api/projects/{pid}/conversations',       [ConversationController::class, 'list']],
    ['POST',   '/api/projects/{pid}/conversations',       [ConversationController::class, 'create']],
    ['GET',    '/api/conversations/{id}',                 [ConversationController::class, 'show']],
    ['POST',   '/api/conversations/{id}/messages',        [ConversationController::class, 'postMessage']],
    ['POST',   '/api/conversations/{id}/participants',    [ConversationController::class, 'addParticipants']],
    ['POST',   '/api/conversations/{id}/leave',           [ConversationController::class, 'leave']],
    ['PATCH',  '/api/conversations/{id}/flags',           [ConversationController::class, 'flags']],
    ['PATCH',  '/api/messages/{mid}',                     [ConversationController::class, 'editMessage']],
    // comments
    ['GET',    '/api/comments',                           [CommentController::class, 'list']],
    ['POST',   '/api/comments',                           [CommentController::class, 'create']],
    ['PATCH',  '/api/comments/{id}',                      [CommentController::class, 'update']],
    ['DELETE', '/api/comments/{id}',                      [CommentController::class, 'delete']],
    // notifications
    ['GET',    '/api/notifications',                      [NotificationController::class, 'list']],
    ['POST',   '/api/notifications/read',                 [NotificationController::class, 'markRead']],
    ['POST',   '/api/projects/{id}/read',                 [NotificationController::class, 'read']],
    ['POST',   '/api/projects/{id}/read-all',             [NotificationController::class, 'readAll']],
    ['POST',   '/api/projects/{id}/unread',               [NotificationController::class, 'unread']],
    ['GET',    '/api/counters',                           [NotificationController::class, 'counters']],
];

$req = new Request();
$isApi = str_starts_with($req->path, '/api/');

try {
    if (Auth::bearer() === null) Auth::startSession();
    // Browsers may only send GET/POST from forms; allow method override for PATCH/DELETE.
    if ($req->method === 'POST' && !empty($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'])) {
        $req->method = strtoupper($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']);
    }
    foreach ($routes as $route) {
        [$method, $pattern, $handler] = $route;
        $needsAuth = $route[3] ?? true;
        $regex = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>\d+)', $pattern) . '$#';
        if (!preg_match($regex, $req->path, $m)) continue;
        if ($method !== $req->method) { $allowedOther = true; continue; }
        $req->params = array_filter($m, 'is_string', ARRAY_FILTER_USE_KEY);
        if ($needsAuth) { Auth::require(); Auth::checkCsrf($req); Auth::checkClientRoute($method, $pattern); }
        $handler($req);
    }
    if ($isApi) throw new HttpError(isset($allowedOther) ? 405 : 404, 'Not found');

    // Everything else: the single-page application shell (served at the root only).
    if ($req->path !== '/') Response::redirect((Config::appUrl() ?: '') . '/');
    header('Content-Type: text/html; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    readfile(__DIR__ . '/app.html');
} catch (HttpError $e) {
    if ($isApi) Response::json(['error' => $e->getMessage()], $e->status);
    http_response_code($e->status);
    echo '<!doctype html><meta charset="utf-8"><title>Error</title><p style="font-family:sans-serif">'
        . htmlspecialchars($e->getMessage()) . ' — <a href="' . htmlspecialchars(Config::appUrl() ?: '/') . '/">back</a></p>';
} catch (Throwable $e) {
    error_log((string)$e);
    $msg = Config::isDev() ? $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine() : 'Internal server error';
    if ($isApi) Response::json(['error' => $msg], 500);
    http_response_code(500);
    echo htmlspecialchars($msg);
}
