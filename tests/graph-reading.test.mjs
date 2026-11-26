// The graph can show only the facts worth reading, linked through the rest of the database like the key facts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { GRAPH_VIEWS, keyGraph } from '../public/assets/js/graph-views.js';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid; let ids;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Reading', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const F = (ref, deps = []) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.', depends_on: deps });
  ids = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'm', facts: [F('base'), F('step', ['base']), F('top', ['step'])] })).data.created.map((x) => [x.ref, x.id]));
  const r = await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [
    { kind: 'progress', fact: String(ids.top), reason: 'Settles the question.', confidence: 'high' },
    { kind: 'progress', fact: String(ids.base), reason: 'The key lemma.', confidence: 'high' },
  ] });
  assert.equal(r.data.applied.length, 2, JSON.stringify(r.data));
});
after(() => app?.stop());

test('the fact list says which facts are worth reading, in full and compact form', async () => {
  const full = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts;
  assert.deepEqual(full.filter((f) => f.worth_reading).map((f) => f.id).sort(), [ids.base, ids.top].sort());
  const c = (await app.call(ann, 'GET', `/api/projects/${pid}/facts?compact=1`)).data;
  if (c.compact) {
    const i = c.columns.indexOf('worth_reading');
    assert.ok(i >= 0, 'a compact column');
    assert.equal(c.rows.filter((r) => r[i]).length, 2);
  }
  assert.ok((await app.call(ann, 'GET', `/api/facts/${ids.top}`)).data.worth_reading?.reason, 'a fact page still gives the reason');
});

test('the worth-reading view keeps those facts, linked through the others', () => {
  assert.ok(GRAPH_VIEWS.reading);
  const nodes = [{ id: 1, worth_reading: true }, { id: 2 }, { id: 3, worth_reading: true }];
  const g = keyGraph(nodes, [[3, 2], [2, 1]], (n) => n.worth_reading);
  assert.deepEqual(g.nodes.map((n) => n.id), [1, 3]);
  assert.deepEqual(g.edges, [[3, 1, 1]], 'top relies on base through one other fact');
  const view = fs.readFileSync('public/assets/js/views/facts.js', 'utf8');
  assert.match(view, /graphView === 'reading'\) return keyGraph\(this\.filtered, this\.filteredEdges, \(n\) => n\.worth_reading\)/);
});
