<?php
// Creates a verified backup of the database and uploaded files. See docs/BACKUP.md.
//
//   php bin/backup.php                 create a backup, then remove the oldest ones
//   php bin/backup.php --keep=30       same, keeping 30 backups
//   php bin/backup.php --list          list the available backups
//   php bin/backup.php --verify FILE   check an archive
//
// Exit codes: 0 success, 1 failure, 2 backup created but some uploaded files are missing or damaged.
if (isset($_SERVER['REQUEST_METHOD'])) { http_response_code(404); exit; }
require __DIR__ . '/../src/bootstrap.php';

use App\Backup;

$args = array_slice($_SERVER['argv'] ?? [], 1);
$mb = fn(int $n) => number_format($n / 1048576, 1) . ' MB';
try {
    if (in_array('--list', $args, true)) {
        $all = Backup::list();
        if (!$all) echo "No backup yet in " . Backup::dir() . "\n";
        foreach ($all as $b) printf("%-42s %10s  %s\n", $b['name'], $mb($b['size']), $b['date']);
        exit(0);
    }
    $i = array_search('--verify', $args, true);
    if ($i !== false) {
        $file = $args[$i + 1] ?? '';
        if ($file === '') throw new RuntimeException('Usage: php bin/backup.php --verify FILE');
        if (!is_file($file)) $file = Backup::dir() . '/' . basename($file);
        $m = Backup::verify($file);
        printf("OK: %d tables, %d rows, %d files, created %s\n", count($m['tables']), array_sum(array_column($m['tables'], 'rows')), count($m['blobs']), $m['created_at']);
        if ($m['problems']) { printf("Warning: %d file(s) were already missing or damaged when this backup was made.\n", count($m['problems'])); exit(2); }
        exit(0);
    }
    $keep = null;
    foreach ($args as $a) {
        if (preg_match('/^--keep=(\d+)$/', $a, $k) && (int)$k[1] > 0) $keep = (int)$k[1];
        elseif ($a !== '') throw new RuntimeException("Unknown option: $a");
    }
    $r = Backup::create();
    $m = $r['manifest'];
    printf("Backup created and verified: %s (%s, %d rows, %d files)\n", $r['file'], $mb($r['size']), array_sum(array_column($m['tables'], 'rows')), count($m['blobs']));
    foreach (Backup::prune($keep) as $old) echo "Removed old backup: $old\n";
    if ($m['problems']) {
        fprintf(STDERR, "WARNING: %d uploaded file(s) could not be backed up:\n", count($m['problems']));
        foreach ($m['problems'] as $p) fprintf(STDERR, "  %s %s\n", $p['problem'], $p['sha256']);
        exit(2);
    }
    exit(0);
} catch (Throwable $e) {
    fwrite(STDERR, 'BACKUP FAILED: ' . $e->getMessage() . "\n");
    exit(1);
}
