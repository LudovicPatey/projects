// The client lists the projects: each is active or paused on this computer, under one set of limits.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let annKey; let bobKey; let main; let side; let tmp; let bin; let n = 0; let asked = 0;

const envFor = (name) => {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OQ_CONFIG_DIR: path.join(dir, 'c'), OQ_URL: app.base, OQ_KEY: annKey };
};
const oq = (e, ...args) => spawnSync('python3', [CLIENT, ...args], { env: e, encoding: 'utf8', timeout: 60000 });
const once = (e, ...extra) => oq(e, 'run', '--once', '--provider', 'claude', ...extra);
const ask = async (project) => { asked += 1; return (await app.call(ann, 'POST', `/api/projects/${project}/ai/tasks`, { kind: 'ask', prompt_text: `Question ${asked}` })).data.id; };
const status = async (project, id) => (await app.call(ann, 'GET', `/api/projects/${project}/ai`)).data.tasks.find((t) => t.id === id).status;
const fresh = () => { n += 1; return envFor(`case-${n}`); };

before(async () => {
  app = await startApp();
  ann = await app.signIn(ANN); const bob = await app.signIn(BOB);
  main = (await app.call(ann, 'POST', '/api/projects', { title: 'Main project', question_html: '<p>A</p>' })).data.id;
  side = (await app.call(ann, 'POST', '/api/projects', { title: 'Side project', question_html: '<p>B</p>' })).data.id;
  assert.ok((await app.call(ann, 'POST', `/api/projects/${main}/members`, { orcid: BOB })).status < 300);
  annKey = (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token;
  bobKey = (await app.call(bob, 'POST', '/api/me/keys', { name: 'k' })).data.token;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-projects-'));
  bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a == ["--version"]: print("1.0 (Claude Code)"); sys.exit()
if a[:2] == ["auth", "status"]: print("ok"); sys.exit()
sys.stdin.read()
print(json.dumps({"is_error": False, "result": "", "structured_output": {"summary": "Answered.", "reply": "An answer."}, "modelUsage": {"test-model": {"inputTokens": 10, "outputTokens": 5}}}))
`, { mode: 0o755 });
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(async () => {
  for (const project of [main, side]) {
    const { tasks } = (await app.call(ann, 'GET', `/api/projects/${project}/ai`)).data;
    for (const t of tasks) if (t.status === 'pending') await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {});
  }
});

test('projects are active by default, and the list shows their state', () => {
  const e = fresh();
  assert.match(oq(e, 'projects').stdout, /Main project: active[\s\S]*Side project: active/);
  assert.match(oq(e, 'projects', 'pause', String(main)).stdout, /Main project: paused[\s\S]*Side project: active/);
  assert.match(oq(e, 'projects', 'resume', String(main)).stdout, /Main project: active/);
});

test('a paused project gets no work here, and stays available to other members', async () => {
  const e = fresh();
  oq(e, 'projects', 'pause', String(main));
  const paused = await ask(main); const open = await ask(side);
  assert.equal(once(e).status, 0);
  assert.equal(await status(main, paused), 'pending');
  assert.equal(await status(side, open), 'done');
  assert.match(once(e, '--project', String(main)).stdout, /This project is paused/);
  assert.equal(await status(main, paused), 'pending');
  assert.equal(once({ ...envFor('bob'), OQ_KEY: bobKey }).status, 0);
  assert.equal(await status(main, paused), 'done', 'another member can still process it');
});

test('work continues after a project is made active again', async () => {
  const e = fresh();
  oq(e, 'projects', 'pause', String(main), String(side));
  const t = await ask(main);
  assert.match(once(e).stdout, /All your projects are paused/);
  assert.equal(await status(main, t), 'pending');
  oq(e, 'projects', 'resume', String(main));
  assert.equal(once(e).status, 0);
  assert.equal(await status(main, t), 'done');
});

test('the limits are shared by all active projects', async () => {
  const e = fresh();
  oq(e, 'limits', '--tasks-per-day', '1');
  const a = await ask(main); const b = await ask(side);
  assert.equal(once(e).status, 0);
  const states = [await status(main, a), await status(side, b)].sort();
  assert.deepEqual(states, ['done', 'pending']);
});

test('only your own projects can be switched', () => {
  const bob = { ...envFor('bob-check'), OQ_KEY: bobKey };
  assert.match(oq(bob, 'projects', 'pause', String(side)).stderr, /not a member/);
  assert.equal(oq(bob, 'projects', 'pause').status, 2);
  assert.doesNotMatch(oq(bob, 'projects').stdout, /Side project/);
});

test('a proof search respects the pause of its project', () => {
  const e = fresh();
  oq(e, 'projects', 'pause', String(main));
  const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
oq.UsageReader.read = classmethod(lambda cls, provider, max_age=60: [{"name": "weekly", "used": 1}])
run = {"stop_weekly": 90, "stop_session": 90}
assert "paused" in oq.danus_block({**run, "project_id": int(sys.argv[2])})[0]
assert oq.danus_block({**run, "project_id": int(sys.argv[3])}) is None
`;
  execFileSync('python3', ['-c', script, CLIENT, String(main), String(side)], { env: e, encoding: 'utf8' });
});

test('the graphic interface switches a project, with its token', async () => {
  const e = fresh();
  const child = spawn('python3', [CLIENT, 'app', '--no-open'], { env: { ...e, OQ_BACKUP_POLL: '3600' } });
  try {
    const url = await new Promise((resolve, reject) => {
      let text = ''; child.stdout.on('data', (d) => { text += d; const m = text.match(/OQ_APP_URL=(\S+)/); if (m) resolve(m[1]); });
      child.on('exit', () => reject(new Error('stopped')));
    });
    const u = new URL(url); const token = u.searchParams.get('t');
    const post = (body, t = token) => fetch(`${u.origin}/api/project/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { 'X-OQ-Token': t } : {}) }, body: JSON.stringify(body) });
    const state = async () => (await fetch(`${u.origin}/api/state`, { headers: { 'X-OQ-Token': token } })).json();
    assert.equal((await post({ project_id: main, paused: true }, '')).status, 403);
    assert.equal((await post({ project_id: 0, paused: true })).status, 422);
    assert.equal((await post({ project_id: main, paused: true })).status, 200);
    let s = await state();
    assert.equal(s.projects.find((p) => p.id === main).paused, true);
    assert.equal(s.projects.find((p) => p.id === side).paused, false);
    assert.equal((await post({ project_id: side, paused: true })).status, 200);
    s = await state();
    assert.equal(s.allowed, false); assert.match(s.reason, /All your projects are paused/);
  } finally { child.kill(); }
});

test('the Claude Code of Claude for Mac is found only with a valid signature', () => {
  const home = path.join(tmp, 'claude-app'); fs.mkdirSync(home, { recursive: true });
  const script = `
import importlib.util, os, pathlib, shutil, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
oq.sys.platform = "darwin"
root = oq.claude_app_root()
def add(version):
    f = root / version / "abc" / "claude.app" / "Contents" / "MacOS" / "claude"
    f.parent.mkdir(parents=True); f.write_text("#!/bin/sh\\n"); f.chmod(0o755)
    return f
def refresh(path="/usr/bin:/bin"):
    os.environ["PATH"] = path; oq.CLAUDE_APP_CHECKED.clear(); oq.extend_path()
old, new, ten = add("2.1.9"), add("2.1.300"), add("2.1.1000")
oq.claude_app_signed = lambda p: False
refresh(); assert shutil.which("claude") is None, "an unsigned program is never used"
oq.claude_app_signed = lambda p: p != ten
refresh(); assert shutil.which("claude") == str(new), "newest signed version, compared as numbers"
oq.claude_app_signed = lambda p: True
refresh(os.environ["PATH"]); assert shutil.which("claude") == str(ten), "an update replaces the older folder"
assert os.environ["PATH"].count(str(root)) == 1
own = pathlib.Path(sys.argv[2]) / "own"; own.mkdir(); (own / "claude").write_text("#!/bin/sh\\n"); (own / "claude").chmod(0o755)
refresh(str(own) + ":/usr/bin:/bin"); assert shutil.which("claude") == str(own / "claude"), "a separate installation comes first"
oq.sys.platform = "linux"
assert oq.claude_app_tool() is None
`;
  execFileSync('python3', ['-c', script, CLIENT, home], { env: { ...process.env, HOME: home, OQ_CONFIG_DIR: path.join(home, 'c') }, encoding: 'utf8' });
});

test('a program that is not signed by Anthropic is refused by the real check', { skip: process.platform !== 'darwin' }, () => {
  const file = path.join(tmp, 'not-signed'); fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  const script = 'import importlib.util, sys\nspec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)\nassert oq.claude_app_signed(sys.argv[2]) is False\nassert oq.claude_app_signed("/bin/ls") is False';
  execFileSync('python3', ['-c', script, CLIENT, file], { env: { ...process.env, OQ_CONFIG_DIR: path.join(tmp, 'sig') }, encoding: 'utf8' });
});

test('the app accepts the key alone or the commands copied from the key window', () => {
  const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
assert oq.extract_key("  ouk_abc-D_1\\n") == "ouk_abc-D_1"
assert oq.extract_key("export OQ_URL=https://x.org\\nexport OQ_KEY=ouk_abc-D_1") == "ouk_abc-D_1"
assert oq.extract_key("oq_agent") == "oq_agent"
assert oq.extract_key("ouk_one ouk_two") == "ouk_one ouk_two", "two keys are not guessed"
assert oq.extract_key("hello") == "hello"
`;
  execFileSync('python3', ['-c', script, CLIENT], { env: { ...process.env, OQ_CONFIG_DIR: path.join(tmp, 'extract') }, encoding: 'utf8' });
});

test('connecting reports each failure, and one unreadable project does not disconnect the client', async () => {
  const fake = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url.startsWith('/html')) return res.end('<html>not a platform</html>');
      if (req.headers.authorization !== 'Bearer ouk_good') { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"Invalid or revoked API key"}'); }
      if (req.url === '/api/projects') { res.setHeader('Content-Type', 'application/json'); return res.end('{"projects":[{"id":5,"title":"Readable title"}]}'); }
      res.statusCode = 500; return res.end('{"error":"Broken"}');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const site = `http://127.0.0.1:${fake.address().port}`;
  const { OQ_URL: _u, OQ_KEY: _k, ...e } = fresh();
  const child = spawn('python3', [CLIENT, 'app', '--no-open'], { env: { ...e, OQ_BACKUP_POLL: '3600' } });
  try {
    const url = await new Promise((resolve, reject) => {
      let text = ''; child.stdout.on('data', (d) => { text += d; const m = text.match(/OQ_APP_URL=(\S+)/); if (m) resolve(m[1]); });
      child.on('exit', () => reject(new Error('stopped')));
    });
    const u = new URL(url); const h = { 'Content-Type': 'application/json', 'X-OQ-Token': u.searchParams.get('t') };
    const connect = async (body) => { const r = await fetch(`${u.origin}/api/connect`, { method: 'POST', headers: h, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
    const saved = path.join(e.OQ_CONFIG_DIR, 'config.json');
    let r = await connect({ url: site, key: 'not a key' });
    assert.equal(r.status, 422); assert.match(r.data.error, /personal key/); assert.ok(!fs.existsSync(saved));
    r = await connect({ url: site, key: 'ouk_wrong' });
    assert.equal(r.status, 422); assert.match(r.data.error, /Invalid or revoked/); assert.ok(!fs.existsSync(saved));
    r = await connect({ url: `${site}/html`, key: 'ouk_good' });
    assert.equal(r.status, 422); assert.match(r.data.error, /Open Questions platform/); assert.ok(!fs.existsSync(saved));
    r = await connect({ url: site, key: `export OQ_URL=${site}export OQ_KEY=ouk_good` });
    assert.equal(r.status, 200, 'the commands pasted on one line still work');
    const s = await (await fetch(`${u.origin}/api/state`, { headers: h })).json();
    assert.equal(s.connected, true);
    assert.deepEqual(s.projects.map((p) => [p.title, p.unavailable]), [['Readable title', true]]);
  } finally { child.kill(); fake.close(); }
});
