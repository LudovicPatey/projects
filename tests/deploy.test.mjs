import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { changedFiles, curlConfig, deployFiles, installerFiles, sftpBatch, updatedManifest, uploadRank } from '../scripts/lib/deploy.mjs';

const files = deployFiles('.');
const remotes = files.map((f) => f.remote);

test('uploads what the site needs', () => {
  for (const r of ['.htaccess', '.ovhconfig', 'public/index.php', 'public/app.html', 'public/.htaccess', 'public/.user.ini', 'public/assets/js/main.js',
    'public/assets/css/app.css', 'public/assets/img/landing/files.webp', 'src/Db.php', 'src/Controllers/FactController.php', 'src/.htaccess',
    'sql/schema.mysql.sql', 'sql/.htaccess', 'bin/backup.php', 'bin/restore.php', 'bin/install.php', 'bin/.htaccess', 'config/.htaccess', 'config/config.example.php']) {
    assert.ok(remotes.includes(r), r);
  }
});

test('never uploads secrets, data or development files', () => {
  for (const r of remotes) {
    assert.ok(!/(^|\/)config\.php$/.test(r), r);
    assert.ok(!/^(storage|cache|docs|examples|tests|scripts|\.git|\.claude)\//.test(r), r);
    assert.ok(!/\.(sqlite|zip|md|mjs|json|DS_Store)$/.test(r), r);
    assert.notEqual(r, 'bin/dev-router.php');
  }
});

test('protection rules go first and the entry point last', () => {
  assert.equal(remotes[0], '.htaccess');
  assert.equal(remotes.at(-1), 'public/index.php');
  const lastRule = Math.max(...remotes.flatMap((r, i) => (r.endsWith('.htaccess') ? [i] : [])));
  const firstCode = remotes.findIndex((r) => r.endsWith('.php') || r.endsWith('.sql'));
  assert.ok(lastRule < firstCode);
  assert.ok(uploadRank('src/Db.php') < uploadRank('public/index.php'));
});

test('only changed files are sent, and the manifest records them', () => {
  const a = { remote: 'a', hash: '1' }, b = { remote: 'b', hash: '2' };
  assert.deepEqual(changedFiles([a, b], { a: '1', b: 'old' }), [b]);
  assert.deepEqual(updatedManifest({ a: '1', b: 'old' }, [b]), { a: '1', b: '2' });
  assert.deepEqual(updatedManifest({}, [{ remote: 'config/config.php', private: true }]), {}, 'the config is not tracked');
});

test('the sftp batch creates parents and never deletes', () => {
  const batch = sftpBatch([{ local: 'x.js', remote: 'public/assets/js/x.js' }, { local: 'c.php', remote: 'config/config.php', private: true }], { dir: 'projects' });
  const lines = batch.trim().split('\n');
  const at = (s) => lines.indexOf(`-mkdir "${s}"`);
  assert.ok(at('projects') >= 0 && at('projects') < at('projects/public') && at('projects/public') < at('projects/public/assets') && at('projects/public/assets') < at('projects/public/assets/js'));
  assert.ok(lines.some((l) => l.startsWith('put ') && l.endsWith('"projects/public/assets/js/x.js"')));
  assert.ok(lines.includes('chmod 600 "projects/config/config.php"'));
  assert.ok(!/^(rm|rmdir|rename)\b/m.test(batch));
});

test('installers are sent only on request, with their checksum and version, and never when stale', () => {
  assert.ok(!remotes.some((r) => /\.(dmg|exe|AppImage|sha256|version)$/.test(r)), 'a normal deployment has no installer');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-installers-'));
  try {
    for (const d of ['client/desktop/dist', 'client/releases']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const put = (f, text) => fs.writeFileSync(path.join(root, f), text);
    put('client/oq.py', 'VERSION = "2.0.0"\n'); put('client/desktop/package.json', '{"version":"2.0.0"}');
    assert.throws(() => installerFiles(root), /no installer/);
    const dmg = path.join(root, 'client/desktop/dist/open-questions-ai-mac-arm64.dmg');
    put('client/desktop/dist/open-questions-ai-mac-arm64.dmg', 'image');
    const future = new Date(Date.now() + 5000); fs.utimesSync(dmg, future, future);
    const list = installerFiles(root);
    assert.deepEqual(list.map((f) => path.posix.basename(f.remote)), ['open-questions-ai-mac-arm64.dmg', 'open-questions-ai-mac-arm64.dmg.sha256', 'open-questions-ai-mac-arm64.dmg.version']);
    assert.ok(list.every((f) => f.remote.startsWith('client/releases/')));
    assert.equal(fs.readFileSync(list[2].local, 'utf8'), '2.0.0\n');
    assert.equal(fs.readFileSync(list[1].local, 'utf8').split(' ')[0], list[0].hash);
    const past = new Date(Date.now() - 60000); fs.utimesSync(dmg, past, past);
    assert.throws(() => installerFiles(root), /older than the client/);
    fs.utimesSync(dmg, future, future);
    put('client/oq.py', 'VERSION = "2.0.1"\n');
    assert.throws(() => installerFiles(root), /versions differ/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ftp requires TLS by default', () => {
  const c = curlConfig([{ local: 'x', remote: 'a b.js' }], { host: 'h', user: 'u', password: 'p"w', dir: 'projects' });
  assert.match(c, /ssl-reqd/);
  assert.match(c, /ftp:\/\/h\/projects\/a%20b\.js/);
  assert.match(c, /user = "u:p\\"w"/);
});
