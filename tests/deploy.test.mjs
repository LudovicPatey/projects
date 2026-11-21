import assert from 'node:assert/strict';
import test from 'node:test';
import { changedFiles, curlConfig, deployFiles, sftpBatch, updatedManifest, uploadRank } from '../scripts/lib/deploy.mjs';

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

test('ftp requires TLS by default', () => {
  const c = curlConfig([{ local: 'x', remote: 'a b.js' }], { host: 'h', user: 'u', password: 'p"w', dir: 'projects' });
  assert.match(c, /ssl-reqd/);
  assert.match(c, /ftp:\/\/h\/projects\/a%20b\.js/);
  assert.match(c, /user = "u:p\\"w"/);
});
