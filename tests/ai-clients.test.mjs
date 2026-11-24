// The AI work page shows which clients are online, what they do, and the time they spent on the project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { aiTimeSummary, clientStatus, computeTime, timeByKind } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X';
const LATEST = fs.readFileSync('client/oq.py', 'utf8').match(/^VERSION = "([^"]+)"/m)[1];
let app; let ann; let bob; let eve; let annKey; let bobKey; let pid; let other;

const asClient = async (key, path, body, version = LATEST) => {
  const r = await fetch(app.base + path, { method: 'POST', headers: { Authorization: `Bearer ${key.token}`, 'Content-Type': 'application/json', 'User-Agent': `open-questions-client/${version}` }, body: JSON.stringify(body) });
  return r.json();
};
const claim = (key, name, project = pid, version) => asClient(key, '/api/ai/tasks/claim', { client_name: name, ai_model: 'claude-opus-5-5', kinds: ['ask', 'bib'], project_id: project }, version).then((r) => r.task);
const complete = (key, t, seconds) => asClient(key, `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: seconds, reply_text: 'ok', summary: 'ok' });
const fail = (key, t, seconds) => asClient(key, `/api/ai/tasks/${t.id}/fail`, { lease: t.lease, error: 'x', final: true, ...(seconds ? { generation_seconds: seconds } : {}) });
const queue = (project = pid) => app.call(ann, 'POST', `/api/projects/${project}/ai/tasks`, { kind: 'bib', prompt_text: `p${Math.random()}` });
const computers = async (who = ann) => (await app.call(who, 'GET', `/api/projects/${pid}/ai`)).data.computers;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Clients', question_html: '<p>Q</p>' })).data.id;
  other = (await app.call(ann, 'POST', '/api/projects', { title: 'Other', question_html: '<p>Q</p>' })).data.id;
  for (const o of [BOB, EVE]) await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: o });
  await app.call(ann, 'POST', `/api/projects/${other}/members`, { orcid: BOB });
  annKey = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'a' })).data.token };
  bobKey = { token: (await app.call(bob, 'POST', '/api/me/keys', { name: 'b' })).data.token };
});
after(() => app?.stop());

test('the interface helpers describe time and state', () => {
  assert.equal(computeTime(0), '—'); assert.equal(computeTime(400), '1 s'); assert.equal(computeTime(125000), '2 min'); assert.equal(computeTime(3 * 3600000 + 5 * 60000), '3 h 05 min');
  const now = Date.parse('2026-01-01T10:05:00Z');
  const s = clientStatus({ online: true, working: { kind: 'extract', subject: 'Paper', started_at: '2026-01-01 10:00:00' } }, now);
  assert.equal(s.text, 'Working on Extraction: Paper'); assert.equal(s.since, '5 min');
  assert.equal(clientStatus({ online: true, working: { kind: 'ask', private: true } }).text, 'Working on a task in a private conversation');
  assert.equal(clientStatus({ online: true }).label, 'Online'); assert.equal(clientStatus({ online: false, last_seen_at: 'x' }).label, 'Offline');
  assert.deepEqual(timeByKind({ ask: { n: 1, ms: 1000 }, extract: { n: 2, ms: 3000 } }).map((k) => [k.kind, k.share]), [['extract', 75], ['ask', 25]]);
});

test('clients show their state, version and time spent in this project only', async () => {
  await queue(); await queue(); await queue(); await queue(other);
  const t1 = await claim(annKey, 'Ann laptop', pid, '1.8.0');
  await complete(annKey, t1, 90);
  const t2 = await claim(bobKey, 'Bob server');
  await complete(bobKey, t2, 30);
  const t3 = await claim(bobKey, 'Bob server');
  await fail(bobKey, t3);
  const elsewhere = await claim(bobKey, 'Bob server', other);
  await complete(bobKey, elsewhere, 999);
  const running = await claim(bobKey, 'Bob server');
  assert.equal(running, null); // nothing else waits
  await queue();
  const busy = await claim(bobKey, 'Bob server');
  const c = await computers();
  const ann1 = c.clients.find((x) => x.name === 'Ann laptop'); const bob1 = c.clients.find((x) => x.name === 'Bob server');
  assert.equal(ann1.version, '1.8.0'); assert.equal(ann1.outdated, true); assert.equal(ann1.online, true); assert.equal(ann1.working, null);
  assert.equal(ann1.stats.d7.ms, 90000); assert.equal(ann1.stats.all.done, 1);
  assert.equal(bob1.outdated, false); assert.deepEqual(bob1.stats.all, { done: 1, failed: 1, ms: 30000, proving_ms: 0 });
  assert.equal(bob1.working.id, busy.id); assert.equal(bob1.working.kind, 'bib'); assert.ok(bob1.working.started_at);
  assert.equal(c.totals.d30.ms, 120000); assert.equal(c.totals.all.by_kind.bib.n, 2);
  assert.equal(c.clients[0].name, 'Bob server'); // working first
  const team = (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data.people;
  assert.equal(team[bob.id].ai_online, true); assert.equal(team[eve.id].ai_online, false);
  await complete(bobKey, busy, 1);
});

test('a task in a private conversation stays unnamed for others', async () => {
  const cid = (await app.call(ann, 'POST', `/api/projects/${pid}/conversations`, { subject: 'Secret subject', body_text: '@AI hello', participant_ids: [bob.id] })).data.id;
  const t = await claim(bobKey, 'Bob server');
  assert.equal(t.conversation_id, cid);
  const seenByEve = (await computers(eve)).clients.find((x) => x.name === 'Bob server').working;
  assert.deepEqual([seenByEve.private, seenByEve.id, seenByEve.subject], [true, null, null]);
  assert.equal((await computers(bob)).clients.find((x) => x.name === 'Bob server').working.private, false);
  await complete(bobKey, t, 2);
});

test('time is split between standard tasks and proving new facts, per project', async () => {
  assert.equal(aiTimeSummary({ standard: { ms: 0 }, proving: { ms: 0, facts: 0 } }), 'No AI computing yet');
  assert.equal(aiTimeSummary({ standard: { ms: 120000 }, proving: { ms: 3600000, facts: 1 } }), '2 min standard · 1 h 00 min proving, 1 new fact');
  const before_ = (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data.ai_time;
  const derive = async () => (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', prompt_text: `d${Math.random()}` })).data;
  await derive();
  const run = (await asClient(bobKey, '/api/ai/tasks/claim', { client_name: 'Bob server', ai_model: 'claude-opus-5-5', kinds: ['derive'], project_id: pid, features: [] })).task;
  const fact = (await asClient(bobKey, `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [{ ref: 'n', title: 'New', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'A new statement.', proof_text: 'A proof.' }] })).created[0].id;
  await asClient(bobKey, `/api/ai/tasks/${run.id}/complete`, { lease: run.lease, ai_model: 'claude-opus-5-5', generation_seconds: 600, fact_ids: [fact], summary: 'ok' });
  await derive();
  const stuck = (await asClient(bobKey, '/api/ai/tasks/claim', { client_name: 'Bob server', ai_model: 'claude-opus-5-5', kinds: ['derive'], project_id: pid, features: [] })).task;
  await fail(bobKey, stuck, 300);
  const after_ = (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data.ai_time;
  assert.equal(after_.proving.ms - before_.proving.ms, 900000);
  assert.equal(after_.proving.facts - before_.proving.facts, 1);
  assert.equal(after_.standard.ms, before_.standard.ms);
  const card = (await app.call(ann, 'GET', '/api/projects')).data.projects.find((p) => p.id === pid);
  assert.deepEqual(card.ai_time, after_);
  const g = (await computers()).totals.d7.groups;
  assert.equal(g.proving.ms, after_.proving.ms); assert.equal(g.proving.failed, 1);
  assert.equal((await computers()).clients.find((x) => x.name === 'Bob server').stats.all.proving_ms, 900000);
});

test('a failure that will be retried does not count its time yet', async () => {
  const before_ = (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data.ai_time.standard.ms;
  await queue();
  const t = await claim(bobKey, 'Bob server');
  await asClient(bobKey, `/api/ai/tasks/${t.id}/fail`, { lease: t.lease, error: 'x', final: false, generation_seconds: 50 });
  assert.equal((await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data.ai_time.standard.ms, before_);
});
