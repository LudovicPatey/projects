<?php
// Restores a backup. This REPLACES the current data. See docs/BACKUP.md.
//
//   php bin/restore.php FILE                      asks for confirmation
//   php bin/restore.php FILE --yes                no question, for scripts
//   php bin/restore.php FILE --no-safety-backup   skip the copy of the current data
//
// The archive is checked first. The current data is saved to storage/backups/oq-pre-restore-*.zip
// and the site shows a maintenance page during the operation.
if (isset($_SERVER['REQUEST_METHOD'])) { http_response_code(404); exit; }
require __DIR__ . '/../src/bootstrap.php';

use App\Backup;

$args = array_slice($_SERVER['argv'] ?? [], 1);
$yes = in_array('--yes', $args, true);
$safety = !in_array('--no-safety-backup', $args, true);
$files = array_values(array_filter($args, fn($a) => !str_starts_with($a, '--')));
try {
    foreach ($args as $a) {
        if (str_starts_with($a, '--') && !in_array($a, ['--yes', '--no-safety-backup'], true)) throw new RuntimeException("Unknown option: $a");
    }
    if (count($files) !== 1) throw new RuntimeException('Usage: php bin/restore.php FILE [--yes] [--no-safety-backup]');
    $file = is_file($files[0]) ? $files[0] : Backup::dir() . '/' . basename($files[0]);

    echo "Checking the archive...\n";
    $m = Backup::verify($file);
    printf("Backup of %s: %d tables, %d rows, %d files.\n", $m['created_at'], count($m['tables']), array_sum(array_column($m['tables'], 'rows')), count($m['blobs']));
    if ($m['problems']) printf("Warning: %d file(s) were already missing or damaged when this backup was made.\n", count($m['problems']));

    if (!$yes) {
        echo "\nThis REPLACES all current data of the platform with this backup.\nType RESTORE to continue: ";
        $answer = trim((string)fgets(STDIN));
        if ($answer !== 'RESTORE') { echo "Cancelled. Nothing was changed.\n"; exit(1); }
    }
    $r = Backup::restore($file, $safety);
    echo "Restore complete.\n";
    if ($r['safety']) echo "The previous data was saved to: {$r['safety']}\n";
    if ($r['broken_references']) printf("Warning: this backup contains %d broken reference(s) between tables, restored as they were.\n", $r['broken_references']);
    exit($m['problems'] || $r['broken_references'] ? 2 : 0);
} catch (Throwable $e) {
    fwrite(STDERR, 'RESTORE FAILED: ' . $e->getMessage() . "\n");
    exit(1);
}
