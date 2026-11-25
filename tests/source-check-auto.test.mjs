// Every cited result is checked against its source by an AI as soon as it arrives, so that the native prover may build on it
// once confirmed; people still accept it. Once per revision: a failed check is not retried.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid; let bib;

const checks = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.filter((t) => t.kind === 'source_check');
const batch = async (facts) => (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts })).data;
const F = (ref, extra) => ({ ref, title: ref, kind: 'theorem', labels: ['conclusion'], method: 'extracted', statement_text: `S ${ref}.`, proof_text: '', sources: [{ type: 'bib', id: bib, quote: 'Theorem 1', covers: 'statement' }], ...extra });
const claim = () => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds: ['source_check'], features: ['procedures'], capabilities: ['web_search', 'document'] });

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Sources', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'A survey', author: 'Doe, J.', year: '2020' }, cite_key: 'doe20' })).data.created[0];
});
after(() => app?.stop());

test('an extraction queues one source check per cited result, and none for proved facts or remarks', async () => {
  const r = await batch([F('cited', { external_refs: [{ key: 'h74', title: 'Finite sums from sequences', year: 1974 }] }), F('proved', { proof_text: 'P.' }), F('remark', { kind: 'remark' })]);
  assert.equal(r.source_checks_queued, 1, JSON.stringify(r));
  const t = await checks();
  assert.equal(t.length, 1); assert.equal(t[0].source_id, r.created[0].id); assert.equal(t[0].status, 'pending');
  assert.equal((await batch([F('more', { proof_text: 'P.' })])).source_checks_queued, 0, 'not twice');
});

test('a failed check is not retried; a person can still ask for another one', async () => {
  const t = (await claim()).data.task;
  assert.equal(t.recipe.procedure, 'source_check');
  const r = await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', answer: { summary: 'Not found.', verdict: 'not_found', where: '', explanation: 'No such statement.' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await batch([F('another', { proof_text: 'P.' })])).source_checks_queued, 0);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'source_check', source_type: 'fact', source_id: t.source_id })).status, 201);
});

test('a cited result the consolidation writes is checked too, and undoing it cancels its check', async () => {
  const made = await batch([F('user', { proof_text: 'By Milliken\'s theorem.', external_refs: [{ key: 'm75', title: 'Ramsey\'s theorem with sums or unions', year: 1975, cited_for: 'Milliken\'s theorem' }] })]);
  const fid = made.created[0].id;
  const ref = (await app.call(ann, 'GET', `/api/facts/${fid}`)).data.outside_refs[0].key;
  const s = (await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ kind: 'cite', fact: fid, ref, title: 'Milliken', statement: 'Milliken\'s theorem.', new_kind: 'theorem', reason: 'Used.', confidence: 'high' }] })).data;
  assert.equal(s.applied.length, 1, JSON.stringify(s));
  const cited = (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data.suggestions.find((x) => x.id === s.created[0]);
  const c = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.find((f) => f.title === 'Milliken').id;
  const pending = (await checks()).filter((t) => t.status === 'pending' && t.source_id === c);
  assert.equal(pending.length, 1, 'the new cited result');
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${cited.id}/undo`, {})).status, 200);
  assert.equal((await checks()).find((t) => t.id === pending[0].id).status, 'cancelled');
});
