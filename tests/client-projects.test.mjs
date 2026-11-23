// The client lists the projects: each is active or paused on this computer, under one set of limits.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
