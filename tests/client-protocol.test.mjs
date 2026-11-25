// Every change to what the AI client relies on is a recorded decision, and a client too old for the platform is stopped.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { braceBlock, clientPaths, compareProtocol, currentProtocol, newer, normalizeCode, phpMembers, readRecord, reachable, references, serverMinimum, clientVersion, unreviewedMessage } from '../scripts/lib/protocol.mjs';

const ANN = '0000-0002-1825-0097';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let key; let tmp;

const asClient = (url, ua) => fetch(app.base + url, { headers: { Authorization: `Bearer ${key}`, ...(ua ? { 'User-Agent': ua } : {}) } });
// The running server may serve its cached copy of the file for a moment: wait until it reports the new minimum.
const setMinimum = async (v) => {
  const f = path.join(app.dir, 'src/ClientProtocol.php');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/const MIN_VERSION = '[^']+'/, `const MIN_VERSION = '${v}'`));
  for (let i = 0; i < 50; i++) {
    if ((await (await fetch(`${app.base}/api/client/info`)).json()).min_version === v) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the server did not take the minimum ${v}`);
};

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  await app.call(ann, 'POST', '/api/projects', { title: 'Protocol', question_html: '<p>Q</p>' });
  key = (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-protocol-'));
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('the client protocol matches its last recorded decision', () => {
  const diff = compareProtocol(readRecord(), currentProtocol());
  assert.ok(diff.same, unreviewedMessage(diff));
});

test('the minimum client version is consistent', () => {
  const record = readRecord(); const v = clientVersion();
  assert.equal(serverMinimum(), record.min_version, 'src/ClientProtocol.php must hold the recorded minimum');
  assert.ok(!newer(record.min_version, v), 'the current client must be accepted');
  assert.ok(!newer(record.client_version, v), 'the client version cannot go back');
  assert.ok(record.history.length && record.history.every((h) => h.note && ['baseline', 'compatible', 'breaking'].includes(h.decision)));
  assert.equal(record.history.at(-1).min_version, record.min_version);
});

test('the protocol covers what the client uses', () => {
  const { routes, items } = currentProtocol();
  for (const r of ['POST /api/ai/tasks/claim', 'POST /api/ai/tasks/{id}/complete', 'POST /api/ai/tasks/{id}/fail', 'POST /api/projects/{pid}/facts/batch', 'GET /api/files/{fid}', 'GET /api/client/info']) {
    assert.ok(routes.some((x) => x.startsWith(r + ' ')), r);
  }
  for (const k of ['AiTaskController::context', 'FactController::source', 'Auth::CLIENT_WRITES', 'ClientProtocol::check']) assert.ok(k in items, k);
});

test('paths built by concatenation are found', () => {
  const paths = clientPaths('url = f"/api/ai/tasks/{task[\'id\']}"\napi.post(url + "/complete", r)\napi.raw("GET", f"/api/files/{f[\'id\']}")');
  assert.ok(paths.has('/api/ai/tasks/{}/complete')); assert.ok(paths.has('/api/files/{}'));
});

test('code is read through strings and comments, and cosmetic edits do not count', () => {
  const php = "class A {\n  const X = ['a', '}'];\n  public static function f(int $a): int { $s = '{'; /* } */ return self::g() + B::h() + self::X; }\n  private static function g(): int { # }\n return 1; }\n}";
  const m = phpMembers(php);
  assert.deepEqual(Object.keys(m.methods), ['f', 'g']); assert.ok(m.methods.f.endsWith('self::X; }'));
  assert.equal(braceBlock('{ "}" }', 0), '{ "}" }');
  assert.deepEqual([...references(m.methods.f, 'A')].sort(), ['A::X', 'A::g', 'B::h']);
  assert.equal(normalizeCode('a  =  1; // note\n'), normalizeCode('a = 1;'));
  const before_ = reachable({ A: m }, ['A::f']);
  const edited = phpMembers(php.replace('return 1;', 'return 2;'));
  const after_ = reachable({ A: edited }, ['A::f']);
  assert.notEqual(before_['A::g'], after_['A::g']); assert.equal(before_['A::f'], after_['A::f']);
  const diff = compareProtocol({ fingerprint: 'x', items: before_ }, { fingerprint: 'y', items: after_ });
  assert.deepEqual(diff.changed, ['A::g']);
  assert.match(unreviewedMessage(diff), /--compatible[\s\S]*--breaking/);
});

test('the platform refuses an official client older than the minimum, and only that', async () => {
  await setMinimum('1.9.0');
  try {
    const old = await asClient('/api/projects', 'open-questions-client/1.8.0');
    assert.equal(old.status, 426);
    const body = await old.json();
    assert.equal(body.update_required, true); assert.equal(body.min_version, '1.9.0'); assert.match(body.error, /too old/);
    assert.equal((await asClient('/api/projects', `open-questions-client/${clientVersion()}`)).status, 200);
    assert.equal((await asClient('/api/projects', 'curl/8.0')).status, 200);
    assert.equal((await asClient('/api/projects')).status, 200);
    assert.equal((await (await fetch(`${app.base}/api/client/info`)).json()).min_version, '1.9.0');
  } finally { await setMinimum(serverMinimum()); }
});

test('a client below the minimum stops and says to update', async () => {
  await setMinimum('99.0.0');
  try {
    const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n[ "$1" = "--version" ] && echo "1.0 (Claude Code)"\necho "{}"\n', { mode: 0o755 });
    const home = path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
    const r = spawnSync('python3', [CLIENT, 'run', '--once', '--provider', 'claude', '--only', 'ask'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, OQ_CONFIG_DIR: path.join(home, 'c'), OQ_URL: app.base, OQ_KEY: key }, encoding: 'utf8', timeout: 60000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /Update required/);
    assert.match(r.stdout + r.stderr, /99\.0\.0/);
  } finally { await setMinimum(serverMinimum()); }
});
