// Stars on the facts that matter, and graph views that stay readable when the database is huge.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { LARGE_GRAPH, bestCenter, defaultView, keyGraph, neighborhood } from '../public/assets/js/graph-views.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const OUT = '0000-0003-1415-9269';
let app; let ann; let bob; let out; let key; let pid;

// a <- b <- c <- d, and e <- c: d depends on c, which depends on b and e, and b on a.
const N = (id, extra = {}) => ({ id, stars: 0, dependents: [], ...extra });
const EDGES = [[2, 1], [3, 2], [4, 3], [3, 5]];

test('key facts are linked through the facts between them, without implied links', () => {
  const nodes = [N(1, { stars: 1 }), N(2), N(3, { stars: 2 }), N(4, { stars: 1 }), N(5)];
  const g = keyGraph(nodes, EDGES, (n) => n.stars > 0);
  assert.deepEqual(g.nodes.map((n) => n.id), [1, 3, 4]);
  assert.deepEqual(g.edges.sort(), [[3, 1, 1], [4, 3, 0]]); // d -> c directly, c -> a through b; no d -> a
  assert.deepEqual(keyGraph(nodes, EDGES, () => false), { nodes: [], edges: [] });
});

test('around a fact, up to a depth', () => {
  const nodes = [1, 2, 3, 4, 5].map((i) => N(i));
  assert.deepEqual(neighborhood(nodes, EDGES, 3, 1).nodes.map((n) => n.id).sort(), [2, 3, 4, 5]);
  assert.deepEqual(neighborhood(nodes, EDGES, 3, 0).nodes.map((n) => n.id).sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(neighborhood(nodes, EDGES, 4, 1).edges, [[4, 3]]);
  assert.deepEqual(neighborhood(nodes, EDGES, 99, 2), { nodes: [], edges: [] });
  assert.equal(bestCenter([N(1, { dependents: [2, 3] }), N(2, { stars: 1 })]), 2);
  assert.equal(bestCenter([N(1, { dependents: [2, 3] }), N(2)]), 1);
  assert.equal(defaultView(LARGE_GRAPH, true), 'all'); assert.equal(defaultView(LARGE_GRAPH + 1, true), 'key'); assert.equal(defaultView(5000, false), 'around');
});

test('the views stay fast on 20,000 facts', () => {
  const n = 20000; const nodes = []; const edges = [];
  for (let i = 1; i <= n; i++) {
    nodes.push(N(i, { stars: i % 400 === 0 ? 1 : 0 }));
    for (const d of [i - 1, i - 7, Math.floor(i / 3)]) if (d >= 1 && d < i) edges.push([i, d]);
  }
  let t = performance.now();
  const g = keyGraph(nodes, edges, (x) => x.stars > 0);
  const keyMs = performance.now() - t;
  assert.equal(g.nodes.length, 50); assert.ok(g.edges.length > 0 && g.edges.length < 200, `${g.edges.length} links`);
  t = performance.now();
  const around = neighborhood(nodes, edges, 10000, 2);
  const aroundMs = performance.now() - t;
  assert.ok(around.nodes.length > 3 && around.nodes.length < 60);
  assert.ok(keyMs < 3000, `key facts took ${Math.round(keyMs)} ms`); assert.ok(aroundMs < 500, `around took ${Math.round(aroundMs)} ms`);
});

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB); out = await app.signIn(OUT);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Stars', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('members star the facts that matter; stars are shared, and only people give them', async () => {
  const id = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [{ ref: 'a', title: 'Main', kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'P.' }] })).data.created[0].id;
  assert.equal((await app.call(key, 'POST', `/api/facts/${id}/star`, {})).status, 403);
  assert.equal((await app.call(out, 'POST', `/api/facts/${id}/star`, {})).status, 403);
  let r = await app.call(ann, 'POST', `/api/facts/${id}/star`, {});
  assert.deepEqual(r.data, { id, stars: 1, starred: true });
  assert.equal((await app.call(ann, 'POST', `/api/facts/${id}/star`, {})).data.stars, 1); // once per person
  await app.call(bob, 'POST', `/api/facts/${id}/star`, {});
  const mine = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.find((f) => f.id === id);
  assert.equal(mine.stars, 2); assert.equal(mine.starred, true);
  const f = (await app.call(bob, 'GET', `/api/facts/${id}`)).data;
  assert.deepEqual(f.starred_by.map((u) => u.id), [ann.id, bob.id]); assert.equal(f.starred, true);
  r = await app.call(ann, 'DELETE', `/api/facts/${id}/star`);
  assert.deepEqual(r.data, { id, stars: 1, starred: false });
  assert.equal((await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.find((x) => x.id === id).starred, false);
});
