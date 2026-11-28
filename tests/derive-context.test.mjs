// A proof search toward a question reads the facts themselves, not their titles, and the answers already proposed: on the live project it
// could not adapt the proof of an almost answer (proved over a stronger system) because it only saw titles.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

let app; let ann; let key; let pid;
before(async () => {
  app = await startApp(); ann = await app.signIn('0000-0002-1825-0097');
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Matches', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('a proof search sees statements, proofs, what it may build on, and the proposed answers', async () => {
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Does the existence of full-matches imply $\\mathsf{ACA}_0$?' })).data;
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    { ref: 'a', title: 'Full-matches compute the jump', kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: 'Every full-match for $c$ computes $\\emptyset\'$.', proof_text: 'Over $\\mathsf{ACA}_0$, by the coding lemma.' },
    { ref: 'b', title: 'Unchecked step', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'P.' },
  ] })).data.created;
  await app.call(key, 'POST', `/api/facts/${made[0].id}/reviews`, { verdict: 'correct', body_text: 'Checked.', ai_model: 'gpt-5.6-sol' });
  assert.equal((await app.call(ann, 'POST', `/api/questions/${q.id}/answers`, { answer: 'positive', fact_id: made[0].id, body_text: 'Almost: proved over ACA_0 only.' })).status, 201);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', source_type: 'question', source_id: q.id })).status, 201);
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'x', kinds: ['derive'], project_id: pid })).data.task;
  const a = t.context.facts.find((f) => f.id === made[0].id); const b = t.context.facts.find((f) => f.id === made[1].id);
  assert.match(a.statement, /computes/); assert.match(a.proof, /coding lemma/);
  assert.equal(a.usable, true); assert.equal(b.usable, false);
  assert.match(t.context.facts_note, /usable/);
  assert.deepEqual(t.context.question.answers.map((x) => [x.fact_id, x.answer, x.state]), [[made[0].id, 'positive', 'proposed']]);
  assert.match(t.context.question.answers[0].rationale, /ACA_0 only/);
  assert.match(t.context.question.answers_note, /base system of the question/);
  assert.equal(Object.keys(t.context)[0], 'goal', 'the goal comes first');
  assert.match(t.context.goal, new RegExp(`Answer open question ${q.id} as it is asked`));
  assert.match(t.context.goal, /exactly, yes or no, in the setting the question asks for/); assert.match(t.context.goal, /judging whether a complete answer is within reach/); assert.match(t.context.goal, /intermediate results/);
});

test('every AI task sees each fact with its statement and its own notation, not only its title', async () => {
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    { ref: 'g', title: 'Left matches code the jump', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'Every left match $(F,S)$ for $f$ has $S\\ge_T\\emptyset\'$.', proof_text: 'P.', glossary: { 'left match': 'a pair $(F,S)$ with $F<S$ such that every $b$ has a match in $F$' } },
  ] })).data.created;
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'ask', prompt_text: 'What is known about left matches?' })).status, 201);
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'x', kinds: ['ask'], project_id: pid })).data.task;
  const g = t.context.facts.find((f) => f.id === made[0].id);
  assert.match(g.statement, /left match/); assert.match(g.glossary['left match'], /F<S/);
  assert.equal(g.proof, undefined, 'proofs only for a proof search');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'x', reply_text: 'ok', summary: 'ok' });
});
