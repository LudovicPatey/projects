// Accepting a result while disputing its proof, and other proofs of the same statement.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { proofTally, resultOnlyBody, stance } from '../public/assets/js/fact-proofs.js';
import { FACT_SUPPORT } from '../public/assets/js/questions-model.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X'; const OUT = '0000-0003-1415-9269';
let app; let ann; let bob; let eve; let out; let key; let bobKey; let pid; let n = 0;

const addFacts = async (deps = false) => {
  n += 1;
  const facts = [{ ref: `a${n}`, title: `Base ${n}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `Statement ${n}.`, proof_text: 'A flawed proof.' }];
  if (deps) facts.push({ ref: `b${n}`, title: `Uses ${n}`, kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: `Consequence ${n}.`, proof_text: 'By the base.', depends_on: [`a${n}`] });
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  return r.data.created.map((x) => x.id);
};
const fact = async (id, who = ann) => (await app.call(who, 'GET', `/api/facts/${id}`)).data;
const listed = async (id) => (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.find((f) => f.id === id);
const review = (id, body, who = ann) => app.call(who, 'POST', `/api/facts/${id}/reviews`, body);
const propose = (id, text, who = bob) => app.call(who, 'POST', `/api/facts/${id}/proofs`, { body_text: text });
const check = (proof, verdict, who = ann, text) => app.call(who, 'POST', `/api/fact-proofs/${proof}/reviews`, { verdict, ...(text ? { body_text: text } : {}) });

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB); eve = await app.signIn(EVE); out = await app.signIn(OUT);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Proofs', question_html: '<p>Q</p>' })).data.id;
  for (const o of [BOB, EVE]) await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: o });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  bobKey = { token: (await app.call(bob, 'POST', '/api/me/keys', { name: 'b' })).data.token };
});
after(() => app?.stop());

test('the interface names each stance', () => {
  assert.equal(stance({ verdict: 'correct', statement_verdict: 'true' }).key, 'endorsed');
  assert.equal(stance({ verdict: 'gap', statement_verdict: 'true' }).label, 'Result true, proof has a gap');
  assert.equal(stance({ verdict: 'incorrect', statement_verdict: 'false' }).key, 'denied');
  assert.equal(stance({ verdict: 'incorrect', statement_verdict: null }).key, 'denied');
  assert.equal(stance({ verdict: 'gap', statement_verdict: 'unsure' }).key, 'gap');
  assert.deepEqual(resultOnlyBody('incorrect', ' step 3 '), { verdict: 'incorrect', statement: 'true', body_text: 'step 3' });
  assert.deepEqual(proofTally({ reviews: [{ verdict: 'correct' }, { verdict: 'gap' }, { verdict: 'gap' }] }), { correct: 1, gap: 2, incorrect: 0 });
  assert.equal(FACT_SUPPORT.proof_disputed.ok, false); assert.equal(FACT_SUPPORT.chain_unproved.ok, false);
});

test('a reviewer can accept the result and dispute the proof', async () => {
  const [a, b] = await addFacts(true);
  assert.equal((await review(a, { verdict: 'gap', statement: 'true', body_text: 'Step 2 is unjustified.' })).status, 201);
  const f = await fact(a);
  assert.equal(f.status, 'proof_disputed');
  assert.deepEqual(f.result_endorsed_by.map((x) => x.id), [ann.id]); assert.deepEqual(f.endorsed_by, []); assert.deepEqual(f.denied_by, []);
  assert.equal((await listed(b)).chain, 'unproved'); // its consequence is usable, but not proved
  assert.equal(f.reviews[0].statement_verdict, 'true');
});

test('the two judgments must be consistent, and a gap needs an explanation', async () => {
  const [a] = await addFacts();
  assert.equal((await review(a, { verdict: 'correct', statement: 'false' })).status, 422);
  assert.equal((await review(a, { verdict: 'gap', statement: 'false', body_text: 'x' })).status, 422);
  assert.equal((await review(a, { verdict: 'gap', statement: 'maybe', body_text: 'x' })).status, 422);
  assert.equal((await review(a, { verdict: 'gap', statement: 'true' })).status, 422);
  assert.equal((await review(a, { verdict: 'correct' })).status, 201);
  assert.equal((await fact(a)).reviews[0].statement_verdict, 'true');
});

test('denying the result disputes the fact, as an error reported without saying so', async () => {
  const [a, b] = await addFacts(true);
  await review(a, { verdict: 'incorrect', statement: 'false', body_text: 'Counterexample: n = 3.' }, bob);
  assert.equal((await fact(a)).status, 'disputed'); assert.equal((await listed(b)).chain, 'broken');
  const [c] = await addFacts();
  await review(c, { verdict: 'incorrect', body_text: 'Wrong.' }, bob); // older clients and AI reviews
  assert.equal((await fact(c)).status, 'disputed');
  await review(c, { verdict: 'incorrect', statement: 'unsure', body_text: 'The proof is wrong, I do not know about the result.' }, bob);
  assert.equal((await fact(c)).status, 'disputed'); // nobody accepts the result and no proof is accepted
});

test('another proof can be proposed and, once accepted, checks the fact', async () => {
  const [a, b] = await addFacts(true);
  await review(a, { verdict: 'incorrect', statement: 'true', body_text: 'Step 2 is false.' });
  const r = await propose(a, 'A different argument by induction on n.');
  assert.equal(r.status, 201);
  const p = r.data.proofs[0];
  assert.equal(p.author_id, bob.id); assert.equal(p.author_kind, 'human'); assert.equal(p.state, 'unchecked'); assert.equal(r.data.status, 'proof_disputed');
  assert.equal((await check(p.id, 'correct', bob)).status, 403); // not its own
  assert.equal((await check(p.id, 'gap', eve)).status, 422); // needs an explanation
  assert.equal((await check(p.id, 'correct', ann)).status, 201);
  let f = await fact(a);
  assert.equal(f.status, 'human_checked'); assert.deepEqual(f.endorsed_by.map((x) => x.id), [ann.id]); assert.deepEqual(f.result_endorsed_by, []);
  assert.equal(f.proofs[0].state, 'accepted'); assert.equal((await listed(b)).chain, 'ok');
  await check(p.id, 'gap', eve, 'The base case is missing.');
  f = await fact(a);
  assert.equal(f.proofs[0].state, 'flawed'); assert.equal(f.status, 'proof_disputed');
  // Rewriting the proof clears the reviews of the old text.
  assert.equal((await app.call(eve, 'PATCH', `/api/fact-proofs/${p.id}`, { body_text: 'x' })).status, 403);
  const edited = (await app.call(bob, 'PATCH', `/api/fact-proofs/${p.id}`, { body_text: 'Induction, with the base case n = 0.' })).data;
  assert.deepEqual(edited.proofs[0].reviews, []); assert.equal(edited.status, 'proof_disputed');
});

test('a proof never outweighs a reviewer who says the result is false', async () => {
  const [a] = await addFacts();
  const p = (await propose(a, 'Another proof entirely.')).data.proofs[0];
  await check(p.id, 'correct', ann);
  assert.equal((await fact(a)).status, 'human_checked');
  await review(a, { verdict: 'incorrect', statement: 'false', body_text: 'Counterexample.' }, eve);
  assert.equal((await fact(a)).status, 'disputed');
});

test('AI clients can propose and review proofs, but never their own', async () => {
  const [a] = await addFacts();
  const made = await app.call(bobKey, 'POST', `/api/facts/${a}/proofs`, { body_text: 'An AI proof.', ai_model: 'gpt-5.6-sol' });
  assert.equal(made.status, 201);
  const p = made.data.proofs.find((x) => x.author_kind === 'agent');
  assert.equal(p.ai_model, 'gpt-5.6-sol');
  assert.equal((await app.call(bobKey, 'POST', `/api/fact-proofs/${p.id}/reviews`, { verdict: 'correct', ai_model: 'gpt-5.6-sol' })).status, 403);
  assert.equal((await app.call(key, 'POST', `/api/fact-proofs/${p.id}/reviews`, { verdict: 'correct', ai_model: 'claude-opus-5-5' })).status, 201);
  assert.equal((await fact(a)).status, 'ai_checked');
  assert.equal((await check(p.id, 'correct', bob)).status, 201); // its owner checks the AI's work as a person
  assert.equal((await fact(a)).status, 'double_checked');
});

test('only members see proofs, and only the author or an owner withdraws one', async () => {
  const [a] = await addFacts();
  const p = (await propose(a, 'Members only.')).data.proofs[0];
  assert.equal((await app.call(out, 'POST', `/api/facts/${a}/proofs`, { body_text: 'x' })).status, 403);
  assert.equal((await app.call(out, 'POST', `/api/fact-proofs/${p.id}/reviews`, { verdict: 'correct' })).status, 403);
  assert.equal((await app.call(eve, 'DELETE', `/api/fact-proofs/${p.id}`)).status, 403);
  const refs = (await app.call(ann, 'GET', `/api/projects/${pid}/refs/resolve?keys=${encodeURIComponent(`proof:${p.id}`)}`)).data.refs;
  assert.equal(refs[`proof:${p.id}`].link.query.proof, p.id);
  assert.equal((await app.call(ann, 'DELETE', `/api/fact-proofs/${p.id}`)).status, 200);
  assert.deepEqual((await fact(a)).proofs, []);
});
