<?php
// Repairs the kinds, titles and external references of facts imported from Danus. See docs/DEPLOY.md.
// Statements, proofs, reviews and revision numbers are never changed.
//
//   php bin/migrate-facts.php             preview, changes nothing
//   php bin/migrate-facts.php --details   preview, and print each change
//   php bin/migrate-facts.php --apply     make a verified backup, then apply
//   php bin/migrate-facts.php --undo      undo the latest migration
//
// Exit codes: 0 success, 1 failure, 2 applied, but some facts changed meanwhile and were left alone.
if (isset($_SERVER['REQUEST_METHOD'])) { http_response_code(404); exit; }
require_once __DIR__ . '/../src/bootstrap.php';

use App\{Backup, FactMigration};

$args = array_slice($_SERVER['argv'] ?? [], 1);
foreach ($args as $a) {
    if (!in_array($a, ['--details', '--apply', '--undo'], true)) { fwrite(STDERR, "Unknown option: $a\n"); exit(1); }
}
$summary = function (array $plan): void {
    $c = $plan['counts'];
    printf("%d imported fact(s) read.\nTo update: %d kind(s), %d title(s), %d revision(s) with external references.\n", $plan['facts'], $c['kind'], $c['title'], $c['references']);
    if ($plan['unrepaired']) printf("Left as they are, because they cannot be repaired safely: %d revision(s).\n", count($plan['unrepaired']));
};
try {
    if (in_array('--undo', $args, true)) {
        if (in_array('--apply', $args, true)) throw new RuntimeException('Choose --apply or --undo.');
        $r = FactMigration::undo();
        if ($r['state'] === 'none') echo "No migration to undo.\n";
        elseif ($r['state'] === 'already undone') echo "The latest migration was already undone.\n";
        else printf("Undone: %d value(s) restored, %d edited since then and kept.\n", $r['restored'], $r['kept']);
        exit(0);
    }
    $plan = FactMigration::plan();
    $summary($plan);
    if (!in_array('--apply', $args, true)) {
        if (in_array('--details', $args, true)) {
            foreach ($plan['changes'] as $c) printf("\n%s  %s\n  from: %s\n  to:   %s\n", $c['label'], $c['type'], $c['old'], $c['new']);
        }
        if ($plan['changes']) echo 'Full preview: ' . FactMigration::writePreview($plan) . "\n";
        echo "Preview only: nothing was changed.\n";
        exit(0);
    }
    if (!$plan['changes']) { echo "Nothing to change.\n"; exit(0); }
    $b = Backup::create();
    if ($b['manifest']['problems']) throw new RuntimeException('The backup reports missing or damaged files, so nothing was changed: ' . $b['file']);
    echo "Backup created and verified: {$b['file']}\n";
    $r = FactMigration::apply($plan, $b['file']);
    printf("Applied: %d change(s). Journal: %s\n", $r['applied'], $r['file']);
    if ($r['skipped']) { printf("Left alone because they changed meanwhile: %d.\n", $r['skipped']); exit(2); }
    exit(0);
} catch (Throwable $e) {
    fwrite(STDERR, 'MIGRATION FAILED: ' . $e->getMessage() . "\n");
    exit(1);
}
