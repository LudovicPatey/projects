// Scheduled backups of the local client, against a real platform and against a faulty one.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const EVE = '0000-0002-1694-233X';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let eve; let annKey; let eveKey; let pid; let other; let tmp;

const env = (name, url, key) => ({ ...process.env, OQ_CONFIG_DIR: path.join(tmp, name), OQ_URL: url, OQ_KEY: key, HOME: path.join(tmp, name, 'home') });
const oq = (e, ...args) => spawnSync('python3', [CLIENT, ...args], { env: e, encoding: 'utf8', timeout: 60000 });
// Does not block, for the stand-in server running in this process.
const oqAsync = (e, ...args) => new Promise((resolve) => {
  const c = spawn('python3', [CLIENT, ...args], { env: e }); let stdout = ''; let stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
const site = (url) => new URL(url).host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
const zips = (dir, id) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.startsWith(`oq-project-${id}-`) && f.endsWith('.zip')).sort();
const state = (e) => JSON.parse(fs.readFileSync(path.join(e.OQ_CONFIG_DIR, 'backup.json'), 'utf8'));
const setup = (name, url, key) => {
  const e = env(name, url, key);
  fs.mkdirSync(e.HOME, { recursive: true });
  const folder = path.join(tmp, name, 'saved');
  assert.equal(oq(e, 'backup', '--on', '--folder', folder).status, 0);
  return { e, folder, dir: path.join(folder, site(url)) };
};

before(async () => {
  app = await startApp();
  ann = await app.signIn(ANN); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Backup Été', question_html: '<p>Is it true?</p>' })).data.id;
  other = (await app.call(ann, 'POST', '/api/projects', { title: 'Second', question_html: '<p>Other</p>' })).data.id;
  annKey = (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token;
  eveKey = (await app.call(eve, 'POST', '/api/me/keys', { name: 'k' })).data.token;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-backup-'));
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('automatic backups are optional: off by default, then weekly with four copies', () => {
  const e = env('defaults', app.base, annKey);
  fs.mkdirSync(e.HOME, { recursive: true });
  const out = oq(e, 'backup', '--list');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /off, every 7 day\(s\), keeping 4/);
  assert.match(oq(e, 'backup', '--if-due').stdout, /Automatic backups are off/);
  assert.ok(!fs.existsSync(path.join(e.HOME, 'Open Questions backups')), 'nothing is copied until the user opts in');
  assert.ok(out.stdout.includes(path.join(e.HOME, 'Open Questions backups')));
});

test('settings are validated', () => {
  const e = env('invalid', app.base, annKey);
  fs.mkdirSync(e.HOME, { recursive: true });
  for (const args of [['--keep', '0'], ['--every-days', '0'], ['--every-days', '366'], ['--folder', 'relative/path']]) {
    assert.equal(oq(e, 'backup', ...args).status, 2, args.join(' '));
  }
});

test('a backup is private, complete, and only due again after the interval', () => {
  const { e, dir } = setup('first', app.base, annKey);
  const out = oq(e, 'backup');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(zips(dir, pid).length, 1);
  assert.equal(zips(dir, other).length, 1);
  assert.match(zips(dir, pid)[0], /^oq-project-\d+-\d{8}-\d{6}-backup-t\.zip$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, zips(dir, pid)[0])).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.part')).length, 0);

  assert.match(oq(e, 'backup', '--if-due').stdout, /No backup is due/);
  assert.equal(zips(dir, pid).length, 1);

  const s = state(e);
  s.projects[`${site(app.base)}:${pid}`].last_ok -= 8 * 86400;
  fs.writeFileSync(path.join(e.OQ_CONFIG_DIR, 'backup.json'), JSON.stringify(s));
  assert.match(oq(e, 'backup', '--if-due').stdout, /1 project\(s\) backed up/);
  assert.equal(zips(dir, pid).length, 2);
  assert.equal(zips(dir, other).length, 1, 'the project that was not due is left alone');
});

test('retention removes only the oldest backups of that project', () => {
  const { e, dir } = setup('retention', app.base, annKey);
  assert.equal(oq(e, 'backup', '--keep', '2').status, 0);
  fs.mkdirSync(dir, { recursive: true });
  const old = `oq-project-${pid}-20200101-000000-old.zip`;
  const personal = ['notes.zip', `oq-project-${pid}-notes.zip`, `oq-project-${pid}-20200101-000000-old.zip.txt`];
  fs.writeFileSync(path.join(dir, old), 'old');
  for (const f of personal) fs.writeFileSync(path.join(dir, f), 'mine');
  for (let i = 0; i < 3; i += 1) assert.equal(oq(e, 'backup', '--project', String(pid)).status, 0);
  assert.equal(zips(dir, pid).filter((f) => /-\d{8}-\d{6}/.test(f)).length, 2, 'only the two latest backups remain');
  assert.ok(!fs.existsSync(path.join(dir, old)), 'the oldest was removed');
  for (const f of personal) assert.ok(fs.existsSync(path.join(dir, f)), `${f} is not a backup`);
});

test('a failed download keeps every earlier backup and retries later', async () => {
  let mode = 'garbage';
  const server = http.createServer((req, res) => {
    if (req.url === '/api/projects') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ projects: [{ id: 7, title: 'Faulty' }] })); }
    if (mode === 'error') { res.statusCode = 500; return res.end('{"error":"Server problem"}'); }
    if (mode === 'short') { res.setHeader('Content-Length', '5000'); res.write('partial'); return setTimeout(() => res.destroy(), 20); }
    return res.end('this is not a zip file');
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const { e, dir } = setup('faulty', url, 'ouk_test');
    assert.equal(oq(e, 'backup', '--keep', '1').status, 0);
    fs.mkdirSync(dir, { recursive: true });
    const good = 'oq-project-7-20260101-000000-faulty.zip';
    fs.writeFileSync(path.join(dir, good), 'earlier');
    for (mode of ['garbage', 'error', 'short']) {
      const out = await oqAsync(e, 'backup');
      assert.equal(out.status, 1, mode);
      assert.match(out.stdout, /earlier backups were kept/);
      assert.deepEqual(fs.readdirSync(dir), [good], mode);
    }
    const entry = state(e).projects[`${site(url)}:7`];
    assert.ok(entry.error); assert.ok(entry.retry_at > Date.now() / 1000);
    assert.match((await oqAsync(e, 'backup', '--if-due')).stdout, /No backup is due/);
  } finally { server.close(); }
});

test('verification refuses a tampered or foreign archive', () => {
  const script = `
import importlib.util, json, sys, zipfile, hashlib
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
def make(name, pid, body):
    with zipfile.ZipFile(name, "w") as z:
        z.writestr("r/files/a.txt", body)
        z.writestr("r/manifest.json", json.dumps({"app": "open-questions", "project": {"id": pid}, "files": [{"path": "files/a.txt", "sha256": hashlib.sha256(b"good").hexdigest()}]}))
    return name
oq.verify_backup(make(sys.argv[2] + "/ok.zip", 3, b"good"), 3)
for args in ((make(sys.argv[2] + "/bad.zip", 3, b"evil"), 3), (make(sys.argv[2] + "/other.zip", 4, b"good"), 3)):
    try:
        oq.verify_backup(*args)
    except oq.Stop:
        continue
    sys.exit("accepted")
`;
  execFileSync('python3', ['-c', script, CLIENT, tmp], { encoding: 'utf8' });
});

test('a key only backs up projects of its owner', async () => {
  const { e, dir } = setup('eve', app.base, eveKey);
  assert.equal(oq(e, 'backup').status, 0);
  assert.equal(zips(dir, pid).length, 0);
  const r = await fetch(`${app.base}/api/projects/${pid}/export`, { headers: { Authorization: `Bearer ${eveKey}` } });
  assert.equal(r.status, 403);
});

test('the export keeps the questions written before a strategy', async () => {
  const first = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Earlier question' })).data;
  const second = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Later question' })).data;
  assert.ok((await app.call(ann, 'POST', `/api/questions/${second.id}/strategies`, { title: 'A strategy', body_html: '<p>Plan</p>' })).status < 300);
  assert.ok(first.id);
  const r = await fetch(`${app.base}/api/projects/${pid}/export`, { headers: { Authorization: `Bearer ${annKey}` } });
  const file = path.join(tmp, 'strategy.zip');
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  const md = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);n=[x for x in z.namelist() if x.endswith("questions.md") or x.endswith("questions/README.md")][0];print(z.read(n).decode())', file], { encoding: 'utf8' });
  for (const text of ['Earlier question', 'Later question', 'A strategy']) assert.ok(md.includes(text), text);
});

test('the graphic interface needs its token for backup actions', async () => {
  const e = env('ui', app.base, annKey);
  fs.mkdirSync(e.HOME, { recursive: true });
  const child = spawn('python3', [CLIENT, 'app', '--no-open'], { env: { ...e, OQ_BACKUP_POLL: '3600' } });
  try {
    const url = await new Promise((resolve, reject) => {
      let text = ''; child.stdout.on('data', (d) => { text += d; const m = text.match(/OQ_APP_URL=(\S+)/); if (m) resolve(m[1]); });
      child.on('exit', () => reject(new Error('stopped')));
    });
    const u = new URL(url); const token = u.searchParams.get('t');
    const post = (p, body, t) => fetch(u.origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { 'X-OQ-Token': t } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/api/backup/run', {})).status, 403);
    assert.equal((await post('/api/backup/settings', { keep: 9 })).status, 403);
    assert.equal((await post('/api/backup/settings', { keep: 0 }, token)).status, 422);
    assert.equal((await post('/api/backup/settings', { keep: 9, every_days: 14 }, token)).status, 200);
    const s = await (await fetch(`${u.origin}/api/state`, { headers: { 'X-OQ-Token': token } })).json();
    assert.equal(s.backup.settings.keep, 9); assert.equal(s.backup.settings.every_days, 14);
    assert.ok(s.backup.projects.some((p) => p.id === pid));
  } finally { child.kill(); }
});
