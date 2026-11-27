// A proof an AI review found flawed is repaired by an AI of another company and checked again by one of the reviewer's side, in
// rounds, until both agree on a proof, both agree on a gap, or the rounds run out and people decide.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { repairView } from '../public/assets/js/repair-model.js';

const ANN = '0000-0002-1825-0097';
const NOW = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, review_hours: 0, consolidate_hours: 0, repair_hours: 0, recheck_hours: 0 } };
let app; let ann; let key;

const project = async (title) => (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
const F = (ref, extra = {}) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `Proof of ${ref}.`, ...extra });
const facts = async (pid, list) => Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: list })).data.created.map((x) => [x.ref, x.id]));
const review = (fid, model, verdict, body = 'Step 2 uses a bound that is not proved.') => app.call(key, 'POST', `/api/facts/${fid}/reviews`, { verdict, body_text: body, ai_model: model });
const claim = (pid, kind, model) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: model, project_id: pid, kinds: [kind], models: { [kind]: [model] }, features: ['procedures', 'review'], capabilities: [] });
const answer = (t, model, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: model, generation_seconds: 9, answer: ans });
const fact = async (fid) => (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;

before(async () => {
  app = await startApp({ config: NOW }); ann = await app.signIn(ANN);
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('a gap an AI found is repaired by another company, checked by the reviewer’s side, and settles the fact', async () => {
  const pid = await project('Repaired');
  const id = await facts(pid, [F('lemma', { glossary: { 'half-match': 'D half-matches B if c(B)=c(D∪B) for some D in D' } })]);
  assert.ok((await review(id.lemma, 'gpt-5.5', 'gap')).status < 300);
  let f = await fact(id.lemma);
  assert.equal(f.repairs[0].state, 'repair'); assert.equal(f.repairs[0].round, 1);
  assert.ok(f.ai_pending.some((p) => p.sweep === 'repair'), 'the fact says a repair is due');
  // Not to the reviewer's company: another one is around.
  assert.equal((await claim(pid, 'proof_repair', 'gpt-5.5')).data.task, null);
  let t = (await claim(pid, 'proof_repair', 'claude-opus-5-5')).data.task;
  assert.ok(t); assert.equal(t.recipe.independent, true);
  const item = t.context.repairs[0];
  assert.equal(item.steps[0].step, 'review'); assert.match(item.steps[0].text, /bound that is not proved/);
  assert.equal(item.fact.definitions[0].symbol, 'half-match', 'the repairer reads the fact’s definitions');
  assert.equal((await answer(t, 'claude-opus-5-5', { summary: '', repairs: [{ repair_id: item.repair_id, outcome: 'repaired', proof: 'First prove the bound: $n\\le k$. Then step 2 follows.', explanation: 'Added the bound step 2 needed.' }] })).status, 200);
  f = await fact(id.lemma);
  assert.equal(f.repairs[0].state, 'check'); assert.equal(f.proofs.length, 1, 'the repaired proof is another proof');
  assert.match(f.proof_text || f.proof_html, /Proof of lemma/, 'the reviewed text never changes');
  // The check goes to the reviewer's side, not to the repairer's company.
  assert.equal((await claim(pid, 'repair_check', 'claude-sonnet-5-5')).data.task, null);
  t = (await claim(pid, 'repair_check', 'gpt-5.5')).data.task;
  assert.ok(t); assert.match(t.context.repairs[0].proof_under_discussion, /First prove the bound/);
  assert.equal((await answer(t, 'gpt-5.5', { summary: '', checks: [{ repair_id: item.repair_id, verdict: 'correct', explanation: 'The bound closes the gap.' }] })).status, 200);
  f = await fact(id.lemma);
  assert.equal(f.repairs[0].state, 'proof');
  assert.equal(f.status, 'ai_checked', 'the review it answered no longer weighs; the repaired proof is AI-checked');
  assert.equal(f.reviews.length, 1, 'the review still shows');
});

test('a gap the other side cannot fix is agreed on; a disagreement ends after three rounds', async () => {
  const pid = await project('Gaps');
  const id = await facts(pid, [F('hard'), F('disputed')]);
  await review(id.hard, 'gpt-5.5', 'gap');
  await review(id.disputed, 'gpt-5.5', 'gap');
  let t = (await claim(pid, 'proof_repair', 'claude-opus-5-5')).data.task;
  const by = Object.fromEntries(t.context.repairs.map((x) => [x.fact.fact_id, x.repair_id]));
  await answer(t, 'claude-opus-5-5', { summary: '', repairs: [
    { repair_id: by[id.hard], outcome: 'real_gap', proof: null, explanation: 'It needs a result on stable colorings that is not among the dependencies.' },
    { repair_id: by[id.disputed], outcome: 'review_wrong', proof: null, explanation: 'The bound is the induction hypothesis of step 1.' }] });
  assert.equal((await fact(id.hard)).repairs[0].state, 'gap');
  for (let round = 1; round <= 3; round++) {
    t = (await claim(pid, 'repair_check', 'gpt-5.5')).data.task;
    assert.ok(t, `check of round ${round}`);
    await answer(t, 'gpt-5.5', { summary: '', checks: [{ repair_id: by[id.disputed], verdict: 'gap', explanation: 'Step 1 proves a weaker bound.' }] });
    if (round < 3) {
      t = (await claim(pid, 'proof_repair', 'claude-opus-5-5')).data.task;
      assert.equal(t.context.repairs[0].round, round + 1);
      await answer(t, 'claude-opus-5-5', { summary: '', repairs: [{ repair_id: by[id.disputed], outcome: 'review_wrong', proof: null, explanation: 'It is the same bound.' }] });
    }
  }
  const f = await fact(id.disputed);
  assert.equal(f.repairs[0].state, 'disagree'); assert.equal(f.repairs[0].steps.length, 7, 'the review, then three answers and three checks');
  assert.equal(repairView(f.repairs[0]).head, 'No agreement: left to people');
});

test('a referee gets the fact’s definitions, and is told what no dependencies means', async () => {
  const pid = await project('Definitions');
  const id = await facts(pid, [F('defs', { glossary: { 'IP set': 'closed under finite unions, with infinitely many disjoint members' } })]);
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'review', source_type: 'fact', source_id: id.defs });
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'gpt-5.5', project_id: pid, kinds: ['review'], models: { review: ['gpt-5.5'] }, features: ['procedures', 'review'], capabilities: [] })).data.task;
  assert.ok(t);
  assert.deepEqual(t.context.fact.definitions, [{ symbol: 'IP set', meaning: 'closed under finite unions, with infinitely many disjoint members', from: 'this fact' }]);
  assert.match(t.context.dependencies_note, /relies on no other fact/);
});

test('a member asks for a repair after a person found a gap; AIs never ask', async () => {
  const pid = await project('Asked');
  const id = await facts(pid, [F('person')]);
  await app.call(ann, 'POST', `/api/facts/${id.person}/reviews`, { verdict: 'gap', statement: 'true', body_text: 'The last step needs compactness.' });
  assert.equal((await fact(id.person)).repairs.length, 0, 'a person’s review starts nothing by itself');
  assert.equal((await app.call(key, 'POST', `/api/facts/${id.person}/repair`, {})).status, 403);
  const r = await app.call(ann, 'POST', `/api/facts/${id.person}/repair`, {});
  assert.equal(r.status, 201); assert.equal(r.data.repairs[0].state, 'repair'); assert.ok(r.data.repairs[0].asked_by);
  assert.equal(r.data.repairs[0].steps[0].text, 'The last step needs compactness.');
  // Any model may answer a person's objection.
  assert.ok((await claim(pid, 'proof_repair', 'gpt-5.5')).data.task);
});
