// People check the citations an interesting result relies on, not all of them: the prover may build on a cited result nobody
// accepted yet, unless people dispute it or its source states something else; a result worth reading lists those it relies on.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid; let id;

const ctx = async () => Object.fromEntries((await app.call(key, 'GET', `/api/projects/${pid}/proving-context`)).data.facts.map((f) => [f.id, f]));
const reading = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data.reading;
const check = async (fid, verdict) => {
  const tasks = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks;
  const tid = tasks.find((t) => t.kind === 'source_check' && t.status === 'pending' && t.source_id === fid)?.id
    ?? (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'source_check', source_type: 'fact', source_id: fid })).data.id;
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, task_id: tid, kinds: ['source_check'], features: ['procedures'], capabilities: ['web_search', 'document'] })).data.task;
  assert.equal(t.source_id, fid);
  assert.equal((await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', answer: { summary: verdict, verdict, where: '', explanation: 'Read it.' } })).status, 200);
};

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Citations', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'Finite sums', author: 'Hindman, N.', year: '1974' }, cite_key: 'h74' })).data.created[0];
  const C = (ref) => ({ ref, title: ref, kind: 'theorem', labels: ['conclusion'], method: 'extracted', statement_text: `S ${ref}.`, sources: [{ type: 'bib', id: bib, quote: 'Theorem 1', covers: 'statement' }] });
  const P = (ref, dep) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `By ${dep}.`, depends_on: [dep] });
  id = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: [C('cited'), C('wrong'), P('uses', 'cited'), P('uses_wrong', 'wrong')] })).data.created.map((x) => [x.ref, x.id]));
  // An independent AI checked both proofs: they are usable as soon as what they rely on is.
  for (const f of [id.uses, id.uses_wrong]) await app.call(key, 'POST', `/api/facts/${f}/reviews`, { verdict: 'correct', statement: 'true', body_text: 'Right.', ai_model: 'claude-opus-5-5' });
});
after(() => app?.stop());

test('a cited result nobody accepted or checked is usable, and so is a proof that relies on it; people still see it unchecked', async () => {
  const c = await ctx();
  assert.equal(c[id.cited].status, 'unchecked'); assert.equal(c[id.cited].usable, true); assert.equal(c[id.cited].trusted, false);
  assert.equal(c[id.uses].usable, true);
});

test('a source that states something else, or a person disputing it, makes it unusable, with what relies on it', async () => {
  await check(id.wrong, 'differs');
  let c = await ctx();
  assert.equal(c[id.wrong].usable, false); assert.equal(c[id.uses_wrong].usable, false);
  await check(id.cited, 'not_found');
  assert.equal((await ctx())[id.cited].usable, true, 'not finding it is no evidence against it');
  await app.call(ann, 'POST', `/api/facts/${id.cited}/reviews`, { verdict: 'incorrect', statement: 'false', body_text: 'The paper assumes more.' });
  c = await ctx();
  assert.equal(c[id.cited].usable, false); assert.equal(c[id.uses].usable, false);
});

test('a result worth reading lists the cited results it relies on that nobody accepted', async () => {
  const r = (await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ kind: 'progress', fact: id.uses_wrong, reason: 'Key step.', confidence: 'high' }] })).data;
  assert.equal(r.applied.length, 1);
  const item = (await reading()).find((x) => x.id === id.uses_wrong);
  assert.deepEqual(item.citations.facts.map((x) => x.id), [id.wrong]); assert.equal(item.citations.count, 1);
  // A person reads the source and accepts it: nothing left to check.
  await app.call(ann, 'POST', `/api/facts/${id.wrong}/reviews`, { verdict: 'correct', body_text: 'Theorem 1 of the paper.' });
  assert.equal((await reading()).find((x) => x.id === id.uses_wrong).citations.count, 0);
  assert.equal((await ctx())[id.wrong].usable, true, 'accepted by a person, whatever the AI check said');
});
