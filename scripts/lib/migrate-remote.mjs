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

export const ADMIN_ACTIONS = ['cancel_waiting', 'retry_failed', 'requeue_extraction', 'reset_extraction', 'clear_notation', 'reset_facts'];
const ADMIN_FLAGS = ['--requeue', '--notation', '--all', '--apply'];

/** The SSH command of bin/admin.php. Only a project number, a known action and known flags pass. */
export function adminCommand(dir, project, action, flags = []) {
  if (!/^[1-9]\d{0,9}$/.test(String(project))) throw new Error('Give the project number: --project ID.');
  if (action !== null && !ADMIN_ACTIONS.includes(action)) throw new Error(`Unknown action ${action}. Actions: ${ADMIN_ACTIONS.join(', ')}.`);
  for (const f of flags) if (!ADMIN_FLAGS.includes(f)) throw new Error(`Unknown option ${f}.`);
  const base = remoteCommand(dir, 'preview').replace(/bin\/migrate-facts\.php$/, 'bin/admin.php').replace('[ -f bin/migrate-facts.php ]', '[ -f bin/admin.php ]').replace('The migration is not on the server yet', 'The admin command is not on the server yet');
  return `${base} --project ${project}${action ? ` ${action}` : ''}${flags.length ? ` ${flags.join(' ')}` : ''}`;
}

/** True when a preview reports at least one change. */
export function hasChanges(report) {
  const m = String(report).match(/To update: (\d+) kind\(s\), (\d+) title\(s\), (\d+) revision\(s\)/);
  return !!m && (+m[1] + +m[2] + +m[3]) > 0;
}
