// What scripts/deploy.mjs uploads to the live site, and how. Pure functions,
// tested in tests/deploy.test.mjs.
//
// The list is explicit (never "everything in the repository"): config/config.php, the
// local database, uploads, backups, cache/ and development tools can never be uploaded.
// Nothing is ever deleted on the server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SINGLE_FILES = [
  ['deploy/htaccess.txt', '.htaccess'], // HTTPS, routing to public/, blocks everything else
  ['.ovhconfig', '.ovhconfig'],         // PHP 8.2 for this site
  ['sql/.htaccess', 'sql/.htaccess'],
  ['sql/schema.mysql.sql', 'sql/schema.mysql.sql'],
  ['bin/.htaccess', 'bin/.htaccess'],
  ['bin/install.php', 'bin/install.php'],
  ['bin/backup.php', 'bin/backup.php'],
  ['bin/restore.php', 'bin/restore.php'],
  ['bin/migrate-facts.php', 'bin/migrate-facts.php'],
  ['bin/migrate-facts-preview.php', 'bin/migrate-facts-preview.php'],
  ['bin/migrate-facts-apply.php', 'bin/migrate-facts-apply.php'],
  ['bin/migrate-facts-undo.php', 'bin/migrate-facts-undo.php'],
  ['bin/admin.php', 'bin/admin.php'],
  ['client/.htaccess', 'client/.htaccess'],
  ['client/releases/.htaccess', 'client/releases/.htaccess'],
  ['client/oq.py', 'client/oq.py'],             // served by /api/client/oq.py
  ['config/.htaccess', 'config/.htaccess'],
  ['config/config.example.php', 'config/config.example.php'],
];
const TREES = [
  { dir: 'src', files: /\.php$/, dotfiles: ['.htaccess'] },
  { dir: 'public', files: /\.(php|html|css|js|webp)$/, dotfiles: ['.htaccess', '.user.ini'] },
];

function walk(root, dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Protection rules go first, and the entry point last, so that a partial upload exposes nothing. */
export function uploadRank(remote) {
  if (path.posix.basename(remote) === '.htaccess') return remote === '.htaccess' ? 0 : 1;
  if (remote === '.ovhconfig') return 2;
  if (remote.startsWith('sql/')) return 3;
  if (remote.startsWith('src/')) return 4;
  if (remote.startsWith('bin/') || remote.startsWith('config/')) return 5;
  if (remote === 'public/index.php') return 7;
  return 6;
}

export function deployFiles(root = '.') {
  const pairs = [...SINGLE_FILES];
  for (const t of TREES) {
    for (const rel of walk(root, t.dir)) {
      const name = path.posix.basename(rel);
      if (name.startsWith('.') ? t.dotfiles.includes(name) : t.files.test(name)) pairs.push([rel, rel]);
    }
  }
  const files = pairs.map(([local, remote]) => {
    if (/(^|\/)config\.php$/.test(remote)) throw new Error(`refusing to upload ${remote}`);
    const full = path.join(root, local);
    if (!fs.existsSync(full)) throw new Error(`missing ${local}`);
    const data = fs.readFileSync(full);
    return { local: full, remote, size: data.length, hash: crypto.createHash('sha256').update(data).digest('hex') };
  });
  return files.sort((a, b) => uploadRank(a.remote) - uploadRank(b.remote) || a.remote.localeCompare(b.remote));
}

const INSTALLERS = ['open-questions-ai-mac-arm64.dmg', 'open-questions-ai-mac-x64.dmg', 'open-questions-ai-windows.exe', 'open-questions-ai-linux.AppImage'];

/**
 * The installers built in client/desktop/dist, each followed by its checksum and version files.
 * Refuses a build older than the client it should contain, or versions that disagree.
 */
export function installerFiles(root = '.') {
  const client = path.join(root, 'client/oq.py');
  const pkg = path.join(root, 'client/desktop/package.json');
  const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  const own = fs.readFileSync(client, 'utf8').match(/^VERSION = "([^"]+)"/m)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(String(version)) || version !== own) throw new Error(`client versions differ: oq.py ${own}, desktop ${version}`);
  const newest = Math.max(fs.statSync(client).mtimeMs, fs.statSync(pkg).mtimeMs);
  const releases = path.join(root, 'client/releases');
  const out = [];
  for (const name of INSTALLERS) {
    const local = path.join(root, 'client/desktop/dist', name);
    if (!fs.existsSync(local)) continue;
    if (fs.statSync(local).mtimeMs < newest) throw new Error(`${name} is older than the client: run npm run dist in client/desktop`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
    out.push({ local, remote: `client/releases/${name}`, size: fs.statSync(local).size, hash });
    for (const [ext, text] of [['sha256', `${hash}  ${name}\n`], ['version', `${version}\n`]]) {
      const file = path.join(releases, `${name}.${ext}`);
      fs.writeFileSync(file, text);
      out.push({ local: file, remote: `client/releases/${name}.${ext}`, size: Buffer.byteLength(text), hash: crypto.createHash('sha256').update(text).digest('hex') });
    }
  }
  if (!out.length) throw new Error('no installer found in client/desktop/dist: run npm run dist in client/desktop');
  return out;
}

export const changedFiles = (files, manifest = {}) => files.filter((f) => manifest[f.remote] !== f.hash);

export function updatedManifest(manifest, uploaded) {
  const next = { ...manifest };
  for (const f of uploaded) if (f.hash) next[f.remote] = f.hash;
  return next;
}

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const remotePath = (dir, remote) => [dir.replace(/^\/+|\/+$/g, ''), remote].filter(Boolean).join('/');

function allDirs(paths) {
  const dirs = new Set();
  for (const p of paths) {
    for (let d = path.posix.dirname(p); d !== '.' && d !== '/'; d = path.posix.dirname(d)) dirs.add(d);
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** sftp batch: creates the folders (a leading "-" ignores "already exists"), then puts each file. No rm, no rename. */
export function sftpBatch(files, { dir = 'projects' }) {
  const targets = files.map((f) => remotePath(dir, f.remote));
  const lines = allDirs(targets).map((d) => `-mkdir ${q(d)}`);
  for (const f of files) {
    lines.push(`put ${q(path.resolve(f.local))} ${q(remotePath(dir, f.remote))}`);
    if (f.private) lines.push(`chmod 600 ${q(remotePath(dir, f.remote))}`);
  }
  return lines.join('\n') + '\n';
}

/** curl configuration, read from stdin so that the password is not on the command line. */
export function curlConfig(files, { host, user, password, dir = 'projects', tls = true }) {
  const lines = [`user = ${q(`${user}:${password}`)}`, 'ftp-create-dirs', 'fail', 'silent', 'show-error'];
  if (tls) lines.push('ssl-reqd');
  for (const f of files) {
    lines.push(`upload-file = ${q(path.resolve(f.local))}`);
    lines.push(`url = ${q(`ftp://${host}/${encodeURI(remotePath(dir, f.remote))}`)}`);
  }
  return lines.join('\n') + '\n';
}
