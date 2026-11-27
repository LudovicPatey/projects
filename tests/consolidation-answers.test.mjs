// When facts settle one of the project's questions, the consolidation proposes the answer, with its reason and its caveats: a
// proposed answer under the question, which a member ratifies or rejects. Undoing the proposal withdraws it. New proved facts
// start a consolidation, not only extractions.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

let app; let ann; let key; let pid; let q; let id;
const S = (x) => ({ kind: 'answer', fact: String(x.fact), other_fact: null, question: x.question, answer: x.answer, new_kind: null, title: null, topics: [], ref: null, statement: null, notation: null, reason: x.reason, confidence: x.confidence });
const consolidate = async (suggestions) => {
  const asked = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate' })).data;
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds: ['consolidate'], features: ['procedures'], capabilities: [] })).data.task;
  const r = await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 30, answer: { summary: '', suggestions } });
  return { t, r, asked };
};

before(async () => {
  app = await startApp(); ann = await app.signIn('0000-0002-1825-0097');
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Answers', question_html: '<p>Q</p>' })).data.id;
  q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Does the existence of full-matches imply $\\mathsf{ACA}_0$?' })).data;
  const F = (ref) => ({ ref, title: ref, kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: `${ref} holds.`, proof_text: 'Clear.' });
  id = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-fable-5-2', facts: [F('coding'), F('other')] })).data.created.map((x) => [x.ref, x.id]));
});
after(() => app?.stop());

test('the consolidation reads the questions, and proposes an answer a member ratifies; undo withdraws it', async () => {
  const { t, r } = await consolidate([S({ fact: id.coding, question: q.id, answer: 'positive', confidence: 'medium',
    reason: 'A computable instance all of whose full-matches compute 0\' gives ACA_0 over omega-models. Caveat: the proof in RCA_0 is not checked.' })]);
  assert.ok(t.context.open_questions.some((x) => x.id === q.id && x.title.includes('full-matches')), 'the AI reads the questions');
  assert.match(t.recipe.instructions, /"answer": facts of the database settle one of the project's questions/);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const shown = (await app.call(ann, 'GET', `/api/questions/${q.id}`)).data;
  const a = shown.answers.find((x) => x.fact_id === id.coding);
  assert.equal(a.state, 'proposed', 'a proposed answer, for a member to ratify'); assert.equal(a.answer, 'positive'); assert.equal(a.ai_model, 'claude-opus-5-5');
  assert.match(a.rationale_html, /Caveat/);
  const s = (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data;
  const sug = (s.suggestions || s).find((x) => x.kind === 'answer');
  assert.equal(sug.status, 'accepted'); assert.ok(sug.auto_applied);
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${sug.id}/undo`, {})).status, 200);
  assert.equal((await app.call(ann, 'GET', `/api/questions/${q.id}`)).data.answers.find((x) => x.fact_id === id.coding).state, 'withdrawn');
  // The same answer is not proposed again, and an unsure one waits for people.
  const again = await consolidate([S({ fact: id.coding, question: q.id, answer: 'positive', confidence: 'high', reason: 'Again.' }), S({ fact: id.other, question: q.id, answer: 'negative', confidence: 'low', reason: 'Perhaps.' })]);
  assert.equal(again.r.status, 200);
  const list = (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data;
  const waiting = (list.suggestions || list).filter((x) => x.kind === 'answer' && x.status === 'proposed');
  assert.deepEqual(waiting.map((x) => x.fact_id), [id.other], 'only the unsure one waits; the undone one is not proposed again');
});

test('facts from Prove new facts start a consolidation', async () => {
  const p2 = (await app.call(ann, 'POST', '/api/projects', { title: 'Derived', question_html: '<p>Q</p>' })).data.id;
  const F = (ref) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `${ref}.`, proof_text: 'Clear.' });
  await app.call(key, 'POST', `/api/projects/${p2}/facts/batch`, { format: 'native', ai_model: 'gpt-5.5', facts: [F('x'), F('y')] });
  const asked = (await app.call(ann, 'POST', `/api/projects/${p2}/ai/tasks`, { kind: 'derive' })).data;
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'gpt-5.5', project_id: p2, kinds: ['derive'] })).data.task;
  assert.equal(t.id, asked.id);
  const made = (await app.call(key, 'POST', `/api/projects/${p2}/facts/batch`, { format: 'native', ai_model: 'gpt-5.5', facts: [F('z')] })).data.created;
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'gpt-5.5', summary: 'One fact.', fact_ids: [made[0].id] });
  const queue = (await app.call(ann, 'GET', `/api/projects/${p2}/ai`)).data.tasks;
  assert.ok(queue.some((x) => x.kind === 'consolidate' && x.status === 'pending'), 'a consolidation waits');
});
