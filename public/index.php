<?php
declare(strict_types=1);

require __DIR__ . '/../src/bootstrap.php';

use App\{Auth, Config, HttpError, Request, Response};
use App\Controllers\{AgentController, AiTaskController, AuthController, BibController, CommentController, ConversationController, DashboardController,
    DocumentController, ExportController, FactController, FeedbackController, HelpController, KeyController, NotificationController, ProjectController, QuestionController, ReferenceController, SearchController};

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
    ['GET',    '/api/projects/{id}/help-context',         [HelpController::class, 'context']],
    ['GET',    '/api/projects/{id}/export',               [ExportController::class, 'project']],
    ['GET',    '/api/projects/{id}/context',              [AgentController::class, 'projectContext']],
    ['GET',    '/api/projects/{id}/dashboard',            [DashboardController::class, 'project']],
    ['GET',    '/api/projects/{id}/activity',             [DashboardController::class, 'activityFeed']],
    ['GET',    '/api/projects/{id}/refs',                 [ReferenceController::class, 'search']],
    ['GET',    '/api/projects/{id}/refs/resolve',         [ReferenceController::class, 'resolve']],
    ['GET',    '/api/projects/{id}/backlinks',            [ProjectController::class, 'backlinks']],
    // AI agents
    ['GET',    '/api/projects/{id}/agents',               [AgentController::class, 'list']],
    ['POST',   '/api/projects/{id}/agents',               [AgentController::class, 'create']],
    ['PATCH',  '/api/projects/{id}/agents/{uid}',         [AgentController::class, 'update']],
    ['POST',   '/api/projects/{id}/agents/{uid}/token',   [AgentController::class, 'rotate']],
    ['DELETE', '/api/projects/{id}/agents/{uid}',         [AgentController::class, 'remove']],
    ['GET',    '/api/agent/context',                      [AgentController::class, 'context']],
    // AI work queue, processed by the users' own AI clients
    ['GET',    '/api/client/oq.py',                       [AiTaskController::class, 'download'], false],
    ['GET',    '/api/client/info',                        [AiTaskController::class, 'clientInfo'], false],
    ['GET',    '/api/client/download',                    [AiTaskController::class, 'clientDownload'], false],
    ['GET',    '/api/projects/{id}/ai',                   [AiTaskController::class, 'overview']],
    ['POST',   '/api/projects/{id}/ai/tasks',             [AiTaskController::class, 'request']],
    ['POST',   '/api/projects/{id}/ai/suggestions',       [AiTaskController::class, 'suggest']],
    ['POST',   '/api/ai/tasks/claim',                     [AiTaskController::class, 'claim']],
    ['POST',   '/api/ai/tasks/{id}/heartbeat',            [AiTaskController::class, 'heartbeat']],
    ['POST',   '/api/ai/tasks/{id}/complete',             [AiTaskController::class, 'complete']],
    ['POST',   '/api/ai/tasks/{id}/fail',                 [AiTaskController::class, 'fail']],
    ['POST',   '/api/ai/tasks/{id}/release',              [AiTaskController::class, 'release']],
    ['POST',   '/api/ai/tasks/{id}/cancel',               [AiTaskController::class, 'cancel']],
    ['POST',   '/api/ai/tasks/{id}/retry',                [AiTaskController::class, 'retry']],
    ['POST',   '/api/bib-suggestions/{id}/accept',        [AiTaskController::class, 'acceptSuggestion']],
    ['POST',   '/api/bib-suggestions/{id}/reject',        [AiTaskController::class, 'rejectSuggestion']],
    // bibliography
    ['GET',    '/api/projects/{pid}/bib',                 [BibController::class, 'list']],
    ['POST',   '/api/projects/{pid}/bib',                 [BibController::class, 'create']],
    ['POST',   '/api/projects/{id}/bib/extract-all',      [AiTaskController::class, 'extractAll']],
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
    // bug reports and feature requests
    ['GET',    '/api/feedback',                           [FeedbackController::class, 'list']],
    ['POST',   '/api/feedback',                           [FeedbackController::class, 'create']],
    ['PATCH',  '/api/feedback/{id}',                      [FeedbackController::class, 'update']],
    ['DELETE', '/api/feedback/{id}',                      [FeedbackController::class, 'delete']],
    ['POST',   '/api/feedback/{id}/seen',                 [FeedbackController::class, 'seen']],
    // open questions and proof strategies
    ['GET',    '/api/projects/{pid}/questions',           [QuestionController::class, 'list']],
    ['POST',   '/api/projects/{pid}/questions',           [QuestionController::class, 'create']],
    ['GET',    '/api/questions/{id}',                     [QuestionController::class, 'show']],
    ['PATCH',  '/api/questions/{id}',                     [QuestionController::class, 'update']],
    ['DELETE', '/api/questions/{id}',                     [QuestionController::class, 'delete']],
    ['POST',   '/api/questions/{id}/strategies',          [QuestionController::class, 'createStrategy']],
    ['POST',   '/api/questions/{id}/links',               [QuestionController::class, 'addLink']],
    ['DELETE', '/api/question-links/{id}',                [QuestionController::class, 'deleteLink']],
    ['POST',   '/api/questions/{id}/answers',             [QuestionController::class, 'proposeAnswer']],
    ['POST',   '/api/answers/{id}/ratify',                [QuestionController::class, 'ratifyAnswer']],
    ['POST',   '/api/answers/{id}/reject',                [QuestionController::class, 'rejectAnswer']],
    ['POST',   '/api/answers/{id}/revoke',                [QuestionController::class, 'revokeAnswer']],
    ['POST',   '/api/answers/{id}/withdraw',              [QuestionController::class, 'withdrawAnswer']],
    ['GET',    '/api/strategies/{id}',                    [QuestionController::class, 'showStrategy']],
    ['PATCH',  '/api/strategies/{id}',                    [QuestionController::class, 'updateStrategy']],
    ['DELETE', '/api/strategies/{id}',                    [QuestionController::class, 'deleteStrategy']],
    ['POST',   '/api/strategies/{id}/restore',            [QuestionController::class, 'restoreStrategy']],
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
    ['POST',   '/api/facts/{id}/comment-links',           [FactController::class, 'linkComment']],
    ['DELETE', '/api/facts/{id}/reviews/{rid}',           [FactController::class, 'deleteReview']],
    ['POST',   '/api/facts/{id}/proofs',                  [FactController::class, 'proposeProof']],
    ['PATCH',  '/api/fact-proofs/{proof}',                [FactController::class, 'updateProof']],
    ['DELETE', '/api/fact-proofs/{proof}',                [FactController::class, 'deleteProof']],
    ['POST',   '/api/fact-proofs/{proof}/reviews',        [FactController::class, 'reviewProof']],
    ['DELETE', '/api/fact-proofs/{proof}/reviews/{rid}',  [FactController::class, 'deleteProofReview']],
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
    ['GET',    '/api/search',                             [SearchController::class, 'search']],
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

// A restore is running: refuse requests so that nothing is written meanwhile.
if (is_file(App\Backup::maintenanceFile())) {
    header('Retry-After: 120');
    if ($isApi) Response::json(['error' => 'The platform is being restored. Please try again in a few minutes.'], 503);
    http_response_code(503);
    header('Content-Type: text/html; charset=utf-8');
    exit('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maintenance</title><p style="font-family:sans-serif;text-align:center;margin-top:20vh">Open Questions is being restored.<br>Please try again in a few minutes.</p>');
}

try {
    App\Db::ensureSchema();
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
        if ($needsAuth) { Auth::require(); App\ClientProtocol::check(); Auth::checkCsrf($req); Auth::checkClientRoute($method, $pattern); }
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
