// The facts list stays light on large databases: a compact form, a change tag, and a search on full statements.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { expandFacts } from '../public/assets/js/api.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const OUT = '0000-0003-1415-9269';
let app; let ann; let bob; let out; let key; let pid; let ids;
const LONG = 'For every finite coloring of the natural numbers there is an infinite set whose finite sums are monochromatic. '.repeat(4);

const get = async (who, url, etag) => {
  const headers = { Cookie: who.cookie, Accept: 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  const r = await fetch(app.base + url, { headers });
  return { status: r.status, etag: r.headers.get('ETag'), data: r.status === 200 ? await r.json() : null, bytes: r.status === 200 ? 0 : 0 };
};

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB); out = await app.signIn(OUT);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'List', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const facts = [];
  for (let i = 1; i <= 300; i++) facts.push({ ref: `f${i}`, title: `Lemma ${i}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: LONG + (i === 150 ? ' Hidden word: zorn.' : ''), proof_text: 'Proof.', depends_on: i > 1 ? [`f${i - 1}`] : [] });
  ids = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts })).data.created.map((x) => x.id);
});
after(() => app?.stop());

test('the compact list keeps what the list and the graph show, with excerpts', async () => {
  const full = await get(ann, `/api/projects/${pid}/facts`);
  const compact = await get(ann, `/api/projects/${pid}/facts?compact=1`);
  const rows = expandFacts(compact.data);
  const f = rows.find((x) => x.id === ids[1]);
  assert.equal(compact.data.compact, true);
  assert.equal(f.statement_truncated, true); assert.ok(f.statement_text.length <= 161); assert.equal(f.used_by, 1);
  for (const k of ['label', 'title', 'status', 'chain', 'proof_origin', 'labels', 'stars', 'starred', 'lean']) assert.ok(k in f, k);
  for (const k of ['dependents', 'deps', 'result_endorsed_by', 'created_at']) assert.equal(k in f, false, k);
  assert.deepEqual(compact.data.edges, full.data.edges);
  const sizeFull = JSON.stringify(full.data).length, sizeCompact = JSON.stringify(compact.data).length;
  assert.ok(sizeCompact < sizeFull * 0.4, `${sizeCompact} bytes compact for ${sizeFull} full`);
  assert.deepEqual(expandFacts({ facts: [{ id: 1 }] }), [{ id: 1 }]);
  // The full form is unchanged, for AI clients and agents.
  const g = full.data.facts.find((x) => x.id === ids[1]);
  assert.equal(g.statement_text.trim(), LONG.trim()); assert.deepEqual(g.dependents, [ids[2]]);
});

test('a poll costs nothing when nothing changed, and sees every change', async () => {
  const first = await get(ann, `/api/projects/${pid}/facts?compact=1`);
  assert.ok(first.etag);
  assert.equal((await get(ann, `/api/projects/${pid}/facts?compact=1`, first.etag)).status, 304);
  assert.notEqual((await get(bob, `/api/projects/${pid}/facts?compact=1`)).etag, first.etag, 'each person has their own stars');
  await app.call(bob, 'POST', `/api/facts/${ids[0]}/star`, {});
  const starred = await get(ann, `/api/projects/${pid}/facts?compact=1`, first.etag);
  assert.equal(starred.status, 200); assert.equal(expandFacts(starred.data).find((x) => x.id === ids[0]).stars, 1);
  await app.call(ann, 'POST', `/api/facts/${ids[0]}/reviews`, { verdict: 'correct' });
  const reviewed = await get(ann, `/api/projects/${pid}/facts?compact=1`, starred.etag);
  assert.equal(reviewed.status, 200); assert.equal(expandFacts(reviewed.data).find((x) => x.id === ids[0]).status, 'human_checked');
  await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [{ ref: 'n', title: 'New', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'New.', proof_text: 'P.' }] });
  const added = await get(ann, `/api/projects/${pid}/facts?compact=1`, reviewed.etag);
  assert.equal(added.status, 200); assert.equal(expandFacts(added.data).length, 301);
  assert.equal((await get(out, `/api/projects/${pid}/facts?compact=1`, added.etag)).status, 403, 'the tag never bypasses access');
});

test('the search reaches the full statements, for members only', async () => {
  const r = await app.call(ann, 'GET', `/api/projects/${pid}/facts/match?q=${encodeURIComponent('hidden zorn')}`);
  assert.deepEqual(r.data.ids, [ids[149]]);
  assert.deepEqual((await app.call(ann, 'GET', `/api/projects/${pid}/facts/match?q=a`)).data.ids, []);
  assert.equal((await app.call(out, 'GET', `/api/projects/${pid}/facts/match?q=zorn`)).status, 403);
});
