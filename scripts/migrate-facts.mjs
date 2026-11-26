// Updates existing facts on the live site over SSH (docs/DEPLOY.md).
//
//   npm run migrate:facts                preview, then apply after you type APPLY
//   npm run migrate:facts -- --details   same, showing each change
//   npm run migrate:facts -- --preview   preview only
//   npm run migrate:facts -- --undo      undo the latest migration after you type UNDO
//
// The host, login and folder come from cache/deploy.json. ssh asks for the password itself, once.
import { sshPassword } from './lib/netrc.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { hasChanges, remoteCommand } from './lib/migrate-remote.mjs';

process.chdir(path.resolve(import.meta.dirname, '..'));
const fail = (message) => { console.error(message); process.exit(1); };
const argv = process.argv.slice(2); const flags = new Set(); const values = new Map();
for (let i = 0; i < argv.length; i++) {
  if (['--details', '--preview', '--undo'].includes(argv[i])) flags.add(argv[i]);
  else if (['--host', '--user', '--dir', '--site'].includes(argv[i]) && i + 1 < argv.length) values.set(argv[i], argv[++i]);
  else fail('Usage: npm run migrate:facts -- [--details] [--preview] [--undo]');
}
if (flags.has('--undo') && (flags.has('--preview') || flags.has('--details'))) fail('--undo cannot be combined with a preview.');
const saved = fs.existsSync('cache/deploy.json') ? JSON.parse(fs.readFileSync('cache/deploy.json', 'utf8')) : {};
const host = values.get('--host') ?? saved.host; const user = values.get('--user') ?? saved.user; const dir = values.get('--dir') ?? saved.dir ?? 'projects';
const site = values.get('--site') ?? 'https://projects.ludovicpatey.com';
if (!host || !user) fail('No host or login: fill in cache/deploy.json (see docs/DEPLOY.md).');
if (!/^[\w.-]+$/.test(host) || !/^[\w.-]+$/.test(user)) fail('Invalid host or login in cache/deploy.json.');

// One connection for the whole procedure, so that the password is asked once.
const sockets = fs.mkdtempSync(path.join(os.tmpdir(), 'oqm-'));
const ssh = (() => { try { return sshPassword(host, user); } catch (e) { fail(e.message); } })();
if (ssh.machine) console.log(`Password from ~/.netrc (machine ${ssh.machine}).`);
const shared = [...ssh.args, '-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(sockets, 's')}`, '-o', 'ControlPersist=120', '-o', 'ConnectTimeout=20'];
const close = () => {
  spawnSync('ssh', [...shared, '-O', 'exit', `${user}@${host}`], { stdio: 'ignore', env: ssh.env });
  fs.rmSync(sockets, { recursive: true, force: true });
};
const run = (action) => {
  const r = spawnSync('ssh', ['-n', ...shared, `${user}@${host}`, remoteCommand(dir, action)], { env: ssh.env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout);
  return { code: r.status ?? 1, out: r.stdout || '' };
};
const confirm = async (word, question) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(`${question} Type ${word} to continue: `)).trim() === word; } catch { return false; } finally { rl.close(); }
};

let exit = 0;
try {
  if (flags.has('--undo')) {
    if (await confirm('UNDO', `Undo the latest fact migration on ${host}?`)) exit = run('undo').code;
    else console.log('Cancelled: nothing was changed.');
  } else {
    // The first request after a deployment updates the database schema.
    if (site !== 'none') { try { await fetch(`${site}/api/me`, { signal: AbortSignal.timeout(20000) }); } catch { console.warn(`! Could not reach ${site}.`); } }
    const preview = run(flags.has('--details') ? 'details' : 'preview');
    if (preview.code !== 0) exit = preview.code;
    else if (flags.has('--preview') || !hasChanges(preview.out)) { if (!hasChanges(preview.out)) console.log('Nothing to apply.'); }
    else if (await confirm('APPLY', `\nApply these changes on ${host}? A verified backup is made first.`)) exit = run('apply').code;
    else console.log('Cancelled: nothing was changed.');
  }
} finally { close(); }
process.exit(exit);
