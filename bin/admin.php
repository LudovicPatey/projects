<?php
// Maintenance of one project, for administrators. The owners of a project have the same actions on its Admin page.
// See docs/DEPLOY.md, "Administer a project".
//
//   php bin/admin.php --project ID                    what the project holds, and the actions
//   php bin/admin.php --project ID ACTION [options]   preview of ACTION: changes nothing
//   php bin/admin.php --project ID ACTION --apply     a verified backup first for destructive actions, then ACTION
//
// Actions: cancel_waiting, retry_failed, requeue_extraction, reset_extraction, clear_notation, reset_facts.
// Options: --requeue (reset_extraction, reset_facts: then extract every file and reference PDF again),
//          --notation (reset_facts: also delete the project notation), --all (clear_notation: also agreed entries and rewrites).
// The bibliography, its PDFs, the files, conversations, questions and members are never changed.
if (isset($_SERVER['REQUEST_METHOD'])) { http_response_code(404); exit; }
require_once __DIR__ . '/../src/bootstrap.php';

use App\{Db, HttpError, ProjectAdmin};

$args = array_slice($_SERVER['argv'] ?? [], 1);
$project = 0; $action = null; $apply = false; $opt = [];
for ($i = 0; $i < count($args); $i++) {
    $a = $args[$i];
    if ($a === '--project' && isset($args[$i + 1])) $project = (int)$args[++$i];
    elseif (preg_match('/^--project=(\d+)$/', $a, $m)) $project = (int)$m[1];
    elseif ($a === '--apply') $apply = true;
    elseif ($a === '--requeue') $opt['requeue'] = true;
    elseif ($a === '--notation') $opt['notation'] = true;
    elseif ($a === '--all') $opt['mode'] = 'all';
    elseif (isset(ProjectAdmin::ACTIONS[str_replace('-', '_', $a)]) && $action === null) $action = str_replace('-', '_', $a);
    else { fwrite(STDERR, "Unknown option: $a\n"); exit(1); }
}
try {
    $title = $project ? Db::value('SELECT title FROM projects WHERE id = ?', [$project]) : null;
    if (!$title) throw new RuntimeException('Give an existing project: --project ID.');
    echo "Project $project: $title\n";
    if ($action === null) {
        foreach (ProjectAdmin::summary($project) as $k => $v) echo '  ' . str_replace('_', ' ', $k) . ': ' . (is_array($v) ? json_encode($v) : $v) . "\n";
        echo "Actions:\n";
        foreach (ProjectAdmin::ACTIONS as $k => [$label, $destructive]) echo "  $k  $label" . ($destructive ? ' (backup first)' : '') . "\n";
        exit(0);
    }
    $preview = ProjectAdmin::preview($project, $action, $opt);
    echo $preview['label'] . ($preview['destructive'] ? ' (a verified backup is made first)' : '') . ":\n";
    foreach ($preview['changes'] as $k => $v) echo '  ' . str_replace('_', ' ', $k) . ": $v\n";
    if (!$apply) { echo "Preview only: nothing was changed. Add --apply to run it.\n"; exit(0); }
    $r = ProjectAdmin::run($project, $action, $opt);
    if ($r['backup']) echo "Backup: {$r['backup']}\n";
    echo "Done:\n";
    foreach ($r['changes'] as $k => $v) echo '  ' . str_replace('_', ' ', $k) . ": $v\n";
} catch (HttpError | Throwable $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
