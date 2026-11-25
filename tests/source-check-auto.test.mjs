// Every cited result is checked against its source by an AI as soon as it arrives, so that the native prover may build on it
// once confirmed; people still accept it. Results found in the same source are checked together, by batches, so that one session
// reads the source once and the AI list holds one task per batch. Once per revision: a failed check is not retried.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid; let bib; let bib2;

const checks = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.filter((t) => t.kind === 'source_check');
const batch = async (facts) => (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts })).data;
const F = (ref, extra) => ({ ref, title: ref, kind: 'theorem', labels: ['conclusion'], method: 'extracted', statement_text: `S ${ref}.`, proof_text: '', sources: [{ type: 'bib', id: bib, quote: 'Theorem 1', covers: 'statement' }], ...extra });
const claim = (task_id) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, task_id, kinds: ['source_check'], features: ['procedures'], capabilities: ['web_search', 'document'] });
const fact = async (id) => (await app.call(ann, 'GET', `/api/facts/${id}`)).data;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Sources', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'A survey', author: 'Doe, J.', year: '2020' }, cite_key: 'doe20' })).data.created[0];
  bib2 = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'Another', author: 'Roe, R.', year: '2021' }, cite_key: 'roe21' })).data.created[0];
});
after(() => app?.stop());

test('an extraction queues the cited results of one source in batches of ten, and none for proved facts or remarks', async () => {
  const many = Array.from({ length: 12 }, (_, i) => F(`c${i}`));
  const r = await batch([...many, F('elsewhere', { sources: [{ type: 'bib', id: bib2, quote: 'Lemma 2', covers: 'statement' }] }), F('proved', { proof_text: 'P.' }), F('remark', { kind: 'remark' })]);
  assert.equal(r.source_checks_queued, 13, JSON.stringify(r));
  const t = await checks();
  assert.deepEqual(t.map((x) => x.subject).sort(), ['1 cited result found in roe21', '10 cited results found in doe20', '2 cited results found in doe20']);
  assert.ok(t.every((x) => x.source_type === null && x.status === 'pending'));
  assert.equal((await batch([F('more', { proof_text: 'P.' })])).source_checks_queued, 0, 'not twice');
});

test('one session checks a batch; only its results are recorded, once each, and a failed check is not retried', async () => {
  const two = (await checks()).find((x) => x.subject.startsWith('2 '));
  const t = (await claim(two.id)).data.task;
  assert.equal(t.recipe.variant, 'source_check_batch'); assert.deepEqual(t.recipe.capabilities, ['web_search']);
  assert.equal(t.context.cited_results.length, 2); assert.equal(t.context.cited_results[0].sources[0].quote, 'Theorem 1');
  const [a, b] = t.context.cited_results.map((x) => x.id);
  const send = (answer) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', answer });
  assert.equal((await send({ summary: 'x', checks: [{ fact_id: a, verdict: 'maybe', where: '', explanation: '' }] })).status, 422);
  const r = await send({ summary: 'Read it.', checks: [
    { fact_id: a, verdict: 'confirmed', where: 'Theorem 1, page 3', explanation: 'As written.' },
    { fact_id: a, verdict: 'differs', where: '', explanation: 'Again.' },
    { fact_id: b, verdict: 'not_found', where: '', explanation: 'Not there.' },
    { fact_id: 999999, verdict: 'confirmed', where: '', explanation: 'Not in this batch.' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.summary_text, /^2 cited results checked \(1 confirmed, 1 not found\)/);
  assert.equal((await fact(a)).status, 'source_confirmed'); assert.equal((await fact(a)).source_checks.length, 1);
  assert.equal((await fact(b)).source_checks[0].verdict, 'not_found');
  assert.equal((await batch([F('again', { proof_text: 'P.' })])).source_checks_queued, 0, 'neither checked nor waiting results are queued again');
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'source_check', source_type: 'fact', source_id: b })).status, 201, 'a person can still ask again');
});

test('a cited result the consolidation writes is checked too; one that leaves the database leaves its batch', async () => {
  const made = await batch([F('user', { method: 'deduced', sources: [], proof_text: 'By Milliken\'s theorem.', external_refs: [{ key: 'm75', title: 'Ramsey\'s theorem with sums or unions', year: 1975, cited_for: 'Milliken\'s theorem' }] })]);
  const fid = made.created[0].id;
  const ref = (await fact(fid)).outside_refs[0].key;
  const s = (await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ kind: 'cite', fact: fid, ref, title: 'Milliken', statement: 'Milliken\'s theorem.', new_kind: 'theorem', reason: 'Used.', confidence: 'high' }] })).data;
  assert.equal(s.applied.length, 1, JSON.stringify(s));
  const task = (await checks()).find((x) => x.subject === '1 cited result');
  assert.ok(task, 'a batch of its own: it was found in no source');
  const sid = (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data.suggestions.find((x) => x.id === s.created[0]).id;
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${sid}/undo`, {})).status, 200);
  const t = (await claim(task.id)).data.task;
  assert.deepEqual(t.context.cited_results, [], 'the removed result is not checked');
});
