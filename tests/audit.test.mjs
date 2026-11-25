// The audit API: read-only access to one project's facts with a key that an owner creates, revokes, and that expires.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X';
let app; let ann; let bob; let eve; let key; let pid; let other; let token;

const audit = async (route, t = token, method = 'GET') => {
  const r = await fetch(app.base + route, { method, headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const sql = (q) => execFileSync('php', ['-r', `$p = new PDO('sqlite:' . $argv[1]); $p->exec($argv[2]);`, path.join(app.dir, 'storage/t.sqlite'), q]);

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Audited', question_html: '<p>Is it true?</p>' })).data.id;
  other = (await app.call(ann, 'POST', '/api/projects', { title: 'Other', question_html: '<p>Q</p>' })).data.id;
  for (const o of [BOB, EVE]) await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: o });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const facts = [];
  for (let i = 1; i <= 205; i++) facts.push({ ref: `f${i}`, title: `Lemma ${i}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `Statement ${i}.`, proof_text: 'Proof.', depends_on: i > 1 ? [`f${i - 1}`] : [] });
  await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts });
  // A fact quoted from a conversation that Eve does not take part in.
  const conv = (await app.call(ann, 'POST', `/api/projects/${pid}/conversations`, { subject: 'Private', body_text: 'The secret lemma holds for all n.', participant_ids: [bob.id] })).data.id;
  const mid = (await app.call(ann, 'GET', `/api/conversations/${conv}`)).data.messages[0].id;
  await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', publish_private: true, facts: [{ ref: 'p', title: 'From a private talk', kind: 'lemma', labels: ['conclusion'], method: 'extracted', statement_text: 'It holds.', sources: [{ type: 'message', id: mid, quote: 'the secret lemma holds', covers: 'statement' }] }] });
});
after(() => app?.stop());

test('only owners create and revoke audit keys, for a limited time', async () => {
  assert.equal((await app.call(bob, 'POST', `/api/projects/${pid}/audit-keys`, { label: 'x' })).status, 403);
  assert.equal((await app.call(key, 'POST', `/api/projects/${pid}/audit-keys`, { label: 'x' })).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/audit-keys`, { label: 'x', days: 365 })).status, 422);
  const r = await app.call(ann, 'POST', `/api/projects/${pid}/audit-keys`, { label: 'Claude audit', days: 7 });
  assert.equal(r.status, 201); token = r.data.token;
  assert.match(token, /^oqa_[0-9a-f]{48}$/);
  const listed = r.data.keys[0];
  assert.equal(listed.label, 'Claude audit'); assert.equal(listed.active, true); assert.equal(listed.prefix, token.slice(0, 12));
  assert.equal(JSON.stringify(r.data.keys).includes(token), false, 'the key is never listed again');
});

test('the key reads the project, its graph, every fact and the notation', async () => {
  const p = await audit('/api/audit/project');
  assert.equal(p.status, 200); assert.equal(p.data.project.id, pid); assert.equal(p.data.summary.facts, 206);
  const g = await audit('/api/audit/graph');
  assert.equal(g.data.facts.length, 206); assert.equal(g.data.edges.length, 204);
  const first = await audit('/api/audit/facts?offset=0');
  assert.equal(first.data.facts.length, 200); assert.equal(first.data.next, 200);
  assert.equal(first.data.facts[1].proof_text, 'Proof.'); assert.ok(first.data.facts[1].deps.length === 1);
  const second = await audit('/api/audit/facts?offset=200');
  assert.equal(second.data.facts.length, 6); assert.equal(second.data.next, null);
  const nota = (await audit('/api/audit/notation')).data;
  assert.ok(nota.progress); assert.ok(nota.entries.every((e) => 'decided_by' in e && 'decided_at' in e), 'who settled each entry');
  const keys = (await app.call(ann, 'GET', `/api/projects/${pid}/audit-keys`)).data.keys;
  assert.ok(keys[0].uses >= 5); assert.ok(keys[0].last_used_at);
});

test('it shows nothing private, and nothing personal', async () => {
  const all = (await audit('/api/audit/facts?offset=200')).data.facts;
  const fromTalk = all.find((f) => f.title === 'From a private talk');
  assert.equal(fromTalk.sources[0].hidden, true); assert.equal(fromTalk.sources[0].quote, null); assert.equal(fromTalk.sources[0].link, null);
  const text = JSON.stringify(all);
  assert.equal(text.includes('secret lemma'), false);
  for (const orcid of [ANN, BOB, EVE]) assert.equal(text.includes(orcid), false, 'no ORCID iD');
  assert.equal(/"email"/.test(text), false);
});

test('the key opens nothing else, and stops when revoked or expired', async () => {
  for (const route of ['/api/projects', `/api/projects/${pid}/facts`, `/api/projects/${pid}`, `/api/projects/${pid}/admin`, '/api/me/keys']) assert.equal((await audit(route)).status, 401, route);
  const me = await audit('/api/me'); // answers everyone, and signs nobody in
  assert.equal(me.data.user ?? null, null);
  assert.equal((await audit(`/api/projects/${pid}/facts/batch`, token, 'POST')).status, 401);
  assert.equal((await audit('/api/audit/project', 'oqa_' + '0'.repeat(48))).status, 401);
  // Another project's key does not read this one.
  const otherToken = (await app.call(ann, 'POST', `/api/projects/${other}/audit-keys`, { label: 'o', days: 1 })).data.token;
  assert.equal((await audit('/api/audit/project', otherToken)).data.project.id, other);
  sql(`UPDATE audit_keys SET expires_at = '2000-01-01 00:00:00' WHERE token_prefix = '${otherToken.slice(0, 12)}'`);
  assert.equal((await audit('/api/audit/project', otherToken)).status, 401, 'expired');
  const k = (await app.call(ann, 'GET', `/api/projects/${pid}/audit-keys`)).data.keys.find((x) => x.prefix === token.slice(0, 12));
  assert.equal((await app.call(bob, 'DELETE', `/api/projects/${pid}/audit-keys/${k.id}`)).status, 403);
  assert.equal((await app.call(ann, 'DELETE', `/api/projects/${pid}/audit-keys/${k.id}`)).status, 200);
  assert.equal((await audit('/api/audit/project')).status, 401, 'revoked');
});

test('npm run audit:fetch saves the project for a local audit, and needs https for a remote site', async () => {
  const t = (await app.call(ann, 'POST', `/api/projects/${pid}/audit-keys`, { label: 'fetch', days: 1 })).data.token;
  const run = (env) => spawnSync('node', ['scripts/audit-fetch.mjs'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
  assert.match(run({ OQ_AUDIT_URL: 'http://example.org', OQ_AUDIT_KEY: t }).stderr, /only sent over https/);
  assert.match(run({ OQ_AUDIT_URL: app.base, OQ_AUDIT_KEY: 'nope' }).stderr, /does not look like an audit key/);
  const r = run({ OQ_AUDIT_URL: app.base, OQ_AUDIT_KEY: t });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes(t), false, 'the key is never printed');
  const dir = r.stdout.match(/Saved to (\S+):/)[1];
  try {
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8')).length, 206);
    assert.equal(fs.readdirSync(path.join(dir, 'facts')).length, 206);
    assert.match(fs.readFileSync(path.join(dir, 'facts', fs.readdirSync(path.join(dir, 'facts'))[1]), 'utf8'), /## Statement/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
