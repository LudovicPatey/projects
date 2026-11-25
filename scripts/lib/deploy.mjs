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

/**
 * Downloads into client/desktop/dist the installers of the GitHub release vX.Y.Z of the current client (built by the Client
 * installers workflow) that are missing there or older than the client. A local build that is up to date is kept.
 * A published release needs no token; a draft needs one with read access (GITHUB_TOKEN or GH_TOKEN), which is never printed.
 * @return {Promise<{release: ?string, draft: boolean, fetched: string[], kept: string[], missing: string[]}>}
 */
export async function fetchInstallers(root = '.', { token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '', fetch = globalThis.fetch, log = () => {} } = {}) {
  const client = fs.readFileSync(path.join(root, 'client/oq.py'), 'utf8');
  const version = client.match(/^VERSION = "([^"]+)"/m)?.[1];
  const repo = client.match(/^GITHUB_REPO = "([^"]+)"/m)?.[1];
  if (!version || !repo) throw new Error('client/oq.py gives no VERSION or GITHUB_REPO');
  const tag = `v${version}`;
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const api = (url, accept = 'application/vnd.github+json') => fetch(url, { headers: { Accept: accept, 'User-Agent': 'open-questions-deploy', ...auth } });
  // A draft is only listed, to someone who may see it; a published release is found by its tag.
  let release = null;
  if (token) {
    const r = await api(`https://api.github.com/repos/${repo}/releases?per_page=30`);
    if (r.ok) release = (await r.json()).find((x) => x.tag_name === tag) || null;
  }
  if (!release) {
    const r = await api(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
    if (r.ok) release = await r.json();
  }
  const dist = path.join(root, 'client/desktop/dist');
  const newest = Math.max(fs.statSync(path.join(root, 'client/oq.py')).mtimeMs, fs.statSync(path.join(root, 'client/desktop/package.json')).mtimeMs);
  const fresh = (name) => fs.existsSync(path.join(dist, name)) && fs.statSync(path.join(dist, name)).mtimeMs >= newest;
  const out = { release: release ? tag : null, draft: !!release?.draft, fetched: [], kept: [], missing: [] };
  for (const name of INSTALLERS) {
    if (fresh(name)) { out.kept.push(name); continue; }
    const asset = (release?.assets || []).find((a) => a.name === name);
    if (!asset) { out.missing.push(name); continue; }
    log(`Downloading ${name} from the ${release.draft ? 'draft ' : ''}release ${tag}…`);
    const r = await api(asset.url, 'application/octet-stream');
    if (!r.ok) throw new Error(`${name}: GitHub answered ${r.status}`);
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length !== asset.size) throw new Error(`${name}: ${data.length} bytes received, ${asset.size} expected`);
    const want = String(asset.digest || '').replace(/^sha256:/, '');
    if (want && crypto.createHash('sha256').update(data).digest('hex') !== want) throw new Error(`${name}: the checksum does not match the release`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, name), data);
    out.fetched.push(name);
  }
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
