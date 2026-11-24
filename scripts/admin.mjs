// Administers one project of the live site over SSH (docs/DEPLOY.md, "Administer a project").
//
//   npm run admin -- --project ID                       what the project holds, and the actions
//   npm run admin -- --project ID ACTION [options]      preview, then run it after you type APPLY
//
// Actions: cancel_waiting, retry_failed, requeue_extraction, reset_extraction, clear_notation, reset_facts.
// Options: --requeue, --notation, --all (see bin/admin.php). Destructive actions make a verified backup first.
// The host, login and folder come from cache/deploy.json. ssh asks for the password itself, once.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { ADMIN_ACTIONS, adminCommand } from './lib/migrate-remote.mjs';

process.chdir(path.resolve(import.meta.dirname, '..'));
const fail = (message) => { console.error(message); process.exit(1); };
const argv = process.argv.slice(2);
let project = null; let action = null; const flags = []; const values = new Map();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' && i + 1 < argv.length) project = argv[++i];
  else if (['--host', '--user', '--dir'].includes(a) && i + 1 < argv.length) values.set(a, argv[++i]);
  else if (['--requeue', '--notation', '--all'].includes(a)) flags.push(a);
  else if (ADMIN_ACTIONS.includes(a.replaceAll('-', '_')) && !action) action = a.replaceAll('-', '_');
  else fail(`Usage: npm run admin -- --project ID [${ADMIN_ACTIONS.join('|')}] [--requeue] [--notation] [--all]`);
}
if (!project) fail('Give the project number: npm run admin -- --project ID');
const saved = fs.existsSync('cache/deploy.json') ? JSON.parse(fs.readFileSync('cache/deploy.json', 'utf8')) : {};
const host = values.get('--host') ?? saved.host; const user = values.get('--user') ?? saved.user; const dir = values.get('--dir') ?? saved.dir ?? 'projects';
if (!host || !user) fail('No host or login: fill in cache/deploy.json (see docs/DEPLOY.md).');
if (!/^[\w.-]+$/.test(host) || !/^[\w.-]+$/.test(user)) fail('Invalid host or login in cache/deploy.json.');

const sockets = fs.mkdtempSync(path.join(os.tmpdir(), 'oqa-'));
const shared = ['-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(sockets, 's')}`, '-o', 'ControlPersist=120', '-o', 'ConnectTimeout=20'];
const close = () => { spawnSync('ssh', [...shared, '-O', 'exit', `${user}@${host}`], { stdio: 'ignore' }); fs.rmSync(sockets, { recursive: true, force: true }); };
const run = (extra) => {
  let command;
  try { command = adminCommand(dir, project, action, [...flags, ...extra]); } catch (e) { fail(e.message); }
  const r = spawnSync('ssh', ['-n', ...shared, `${user}@${host}`, command], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  return { code: r.status ?? 1, out: r.stdout || '' };
};

let exit = 0;
try {
  const preview = run([]);
  exit = preview.code;
  if (preview.code === 0 && action) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer = '';
    try { answer = (await rl.question(`\nRun this on ${host}? Type APPLY to continue: `)).trim(); } catch { /* no terminal */ } finally { rl.close(); }
    if (answer === 'APPLY') exit = run(['--apply']).code;
    else console.log('Cancelled: nothing was changed.');
  }
} finally { close(); }
process.exit(exit);
