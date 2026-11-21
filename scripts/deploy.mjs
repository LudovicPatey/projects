// Uploads the platform to https://projects.ludovicpatey.com (docs/DEPLOY.md).
// Sends only the files listed in scripts/lib/deploy.mjs that changed since the last
// deployment. Nothing is ever deleted on the server, and its config/config.php and
// data (projects-data/, outside the web root) are not touched.
//
//   npm run deploy -- [--dry-run] [--all] [--config] [--protocol sftp|ftp] [--host H] [--user U] [--dir projects] [--no-tls]
//
//   --dry-run  list what would be uploaded, upload nothing
//   --all      upload every file, not only those changed since the last deployment
//   --config   also upload cache/config.prod.php as config/config.php
//
// Settings are read from cache/deploy.json (git-ignored), e.g.
//   { "protocol": "sftp", "host": "ftp.clusterXXX.hosting.ovh.net", "user": "LOGIN", "dir": "projects" }
// sftp: OpenSSH sftp (OVH web hosting accepts it with the FTP password, which ssh
//       asks in the terminal; an SSH key works too). The default.
// ftp:  FTP with TLS through curl, for hosts that support it (OVH does not); the
//       password is asked (or PROJECTS_FTP_PASSWORD), never stored.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { changedFiles, curlConfig, deployFiles, sftpBatch, updatedManifest } from './lib/deploy.mjs';

const SITE = 'https://projects.ludovicpatey.com';
process.chdir(path.resolve(import.meta.dirname, '..'));
const usage = 'npm run deploy -- [--dry-run] [--all] [--config] [--protocol sftp|ftp] [--host H] [--user U] [--dir projects] [--no-tls]';

// ---- options -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set();
const values = new Map();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (['--dry-run', '--all', '--config', '--no-tls'].includes(a)) flags.add(a);
  else if (['--protocol', '--host', '--user', '--dir'].includes(a) && i + 1 < argv.length) values.set(a, argv[++i]);
  else fail(`Unknown option ${a}\nUsage: ${usage}`);
}
const saved = fs.existsSync('cache/deploy.json') ? JSON.parse(fs.readFileSync('cache/deploy.json', 'utf8')) : {};
const opt = {
  protocol: values.get('--protocol') ?? saved.protocol ?? 'sftp',
  host: values.get('--host') ?? saved.host,
  user: values.get('--user') ?? saved.user,
  dir: values.get('--dir') ?? saved.dir ?? 'projects',
  tls: !flags.has('--no-tls') && saved.tls !== false,
};
const dry = flags.has('--dry-run');
if (!['ftp', 'sftp'].includes(opt.protocol)) fail('--protocol: ftp or sftp');
if (!dry && (!opt.host || !opt.user)) {
  fail('No host/user: create cache/deploy.json, e.g.\n  { "protocol": "sftp", "host": "ftp.clusterXXX.hosting.ovh.net", "user": "LOGIN", "dir": "projects" }\n(the FTP host and login are in the OVH control panel: Web hosting → FTP-SSH)');
}

// ---- checks --------------------------------------------------------------------
try {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'public', 'sql', 'bin', 'deploy', 'config/config.example.php'], { encoding: 'utf8' }).trim();
  if (dirty) console.warn(`! uncommitted changes (the live site will differ from GitHub):\n${dirty.split('\n').map((l) => '    ' + l).join('\n')}`);
} catch { /* not a git checkout */ }

const files = deployFiles('.');
for (const f of files) {
  const check = f.remote.endsWith('.php') ? ['php', ['-l', f.local]] : f.remote.endsWith('.js') ? null : null;
  if (check && spawnSync(check[0], check[1], { stdio: 'ignore' }).status !== 0) fail(`PHP syntax error in ${f.local}: nothing uploaded.`);
}

const extra = [];
if (flags.has('--config')) extra.push(checkedConfig('cache/config.prod.php'));

const target = `${opt.protocol}://${opt.user ?? '?'}@${opt.host ?? '?'}/${opt.dir}`;
const manifestFile = 'cache/deploy-manifest.json';
const manifests = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
const manifest = flags.has('--all') ? {} : (manifests[target] ?? {});
const todo = [...changedFiles(files, manifest), ...extra];
const mb = (list) => (list.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(1);

console.log(`\n${files.length} files (${mb(files)} MB); ${todo.length} to upload (${mb(todo)} MB) → ${target}`);
for (const f of todo.slice(0, 40)) console.log(`  ${f.remote}`);
if (todo.length > 40) console.log(`  … and ${todo.length - 40} more`);
console.log(`Nothing is deleted on the server.${flags.has('--config') ? '' : ' config/config.php is not touched.'} projects-data/ is not touched.`);
if (dry || todo.length === 0) {
  console.log(dry ? '(dry run: nothing uploaded)' : 'Nothing to upload.');
  process.exit(0);
}

// ---- upload --------------------------------------------------------------------
if (opt.protocol === 'ftp') {
  const password = process.env.PROJECTS_FTP_PASSWORD || (await askHidden(`FTP password for ${opt.user}@${opt.host}: `));
  const r = spawnSync('curl', ['-K', '-'], { input: curlConfig(todo, { ...opt, password }) + 'fail-early\n', stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) fail(`curl failed (exit ${r.status}).${opt.tls ? ' If the server does not support TLS (OVH does not), use --protocol sftp rather than --no-tls, which sends the password in clear.' : ''}`);
} else {
  // batch commands on stdin (`-b -`): sftp stops at the first failed upload, so that the
  // manifest only records what is online; BatchMode=no lets ssh ask the password
  const r = spawnSync('sftp', ['-o', 'BatchMode=no', '-o', 'ConnectTimeout=20', '-b', '-', `${opt.user}@${opt.host}`], {
    input: sftpBatch(todo, opt),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.status !== 0) fail(`sftp failed (exit ${r.status}); the manifest is unchanged, so the next deployment uploads these files again.`);
}
manifests[target] = updatedManifest(manifest, todo);
fs.mkdirSync('cache', { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify(manifests, null, 1) + '\n');
console.log(`✓ ${todo.length} files uploaded.`);

// ---- check the live site ---------------------------------------------------------
try {
  const res = await fetch(`${SITE}/api/me`, { signal: AbortSignal.timeout(20000) });
  const type = res.headers.get('content-type') || '';
  if (res.ok && type.includes('json')) console.log(`✓ ${SITE} answers.`);
  else console.warn(`! ${SITE}/api/me answered ${res.status}. See docs/DEPLOY.md, "If something goes wrong".`);
} catch (e) {
  console.warn(`! Could not reach ${SITE} (${e.message}). Is the domain attached to the folder ${opt.dir}/?`);
}

// ---------------------------------------------------------------------------------
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The production configuration must be complete, and can never enable the dev login. */
function checkedConfig(file) {
  if (!fs.existsSync(file)) fail(`Missing ${file}: copy deploy/config.prod.example.php there and fill it in.`);
  const code = `$c = require $argv[1];
    $bad = [];
    if (($c['env'] ?? '') !== 'prod') $bad[] = "env must be 'prod'";
    if (($c['app_url'] ?? '') !== '${SITE}') $bad[] = 'app_url must be ${SITE}';
    foreach (['db.dsn' => $c['db']['dsn'] ?? '', 'db.user' => $c['db']['user'] ?? '', 'db.password' => $c['db']['password'] ?? '',
              'orcid.client_id' => $c['orcid']['client_id'] ?? '', 'orcid.client_secret' => $c['orcid']['client_secret'] ?? ''] as $k => $v) {
      if ($v === '' || stripos($v, 'xxxxx') !== false) $bad[] = "$k is not filled in";
    }
    if (!str_contains((string)($c['storage_path'] ?? ''), 'projects-data')) $bad[] = 'storage_path must be the projects-data folder';
    if (!empty($c['orcid']['sandbox'])) $bad[] = 'orcid.sandbox must be false';
    echo implode("\\n", $bad);`;
  const r = spawnSync('php', ['-r', code, '--', file], { encoding: 'utf8' });
  if (r.status !== 0) fail(`${file} is not valid PHP.`);
  if (r.stdout.trim()) fail(`${file} cannot be uploaded:\n  ${r.stdout.trim().split('\n').join('\n  ')}`);
  return { local: file, remote: 'config/config.php', size: fs.statSync(file).size, private: true };
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) fail('No terminal to ask the password: set PROJECTS_FTP_PASSWORD.');
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const on = (ch) => {
      if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); stdout.write('\n'); resolve(s); }
      else if (ch === '\u0003') { stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f') s = s.slice(0, -1);
      else s += ch;
    };
    stdin.on('data', on);
  });
}
