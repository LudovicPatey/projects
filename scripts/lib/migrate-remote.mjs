// Builds the SSH command of the live fact migration. Pure functions, tested in tests/fact-migration.test.mjs.

export const MIGRATE_ACTIONS = { preview: [], details: ['--details'], apply: ['--apply'], undo: ['--undo'] };

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Runs from the site folder, with a PHP recent enough: the default one on a shared host can be older than the site's. */
export function remoteCommand(dir, action) {
  if (!Object.hasOwn(MIGRATE_ACTIONS, action)) throw new Error(`Unknown action ${action}`);
  if (!/^[\w./-]+$/.test(dir) || dir.split('/').includes('..')) throw new Error('Invalid site folder.');
  const flags = MIGRATE_ACTIONS[action].join(' ');
  const find = 'P=; for x in /usr/local/php8.2/bin/php /usr/local/php8.3/bin/php /usr/local/php8.4/bin/php php; do if command -v "$x" >/dev/null 2>&1 && "$x" -r "exit(PHP_VERSION_ID >= 80100 ? 0 : 1);" 2>/dev/null; then P=$x; break; fi; done; [ -n "$P" ] || { echo "PHP 8.1 or later was not found on the server." >&2; exit 1; }';
  const check = '[ -f bin/migrate-facts.php ] || { echo "The migration is not on the server yet: run npm run deploy first." >&2; exit 1; }';
  return `cd ${quote(dir)} || exit 1; ${check}; ${find}; exec "$P" bin/migrate-facts.php${flags ? ` ${flags}` : ''}`;
}

/** True when a preview reports at least one change. */
export function hasChanges(report) {
  const m = String(report).match(/To update: (\d+) kind\(s\), (\d+) title\(s\), (\d+) revision\(s\)/);
  return !!m && (+m[1] + +m[2] + +m[3]) > 0;
}
