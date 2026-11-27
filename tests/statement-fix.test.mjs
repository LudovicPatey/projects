// A member says a statement is wrong. An AI proposes corrected statements with proofs, an AI of another company checks each one, and
// a member chooses which replace the fact: each becomes a new fact, the old one is retracted as superseded, and each fact that relied
// on it is read again by AIs. A member can undo it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { correctionView, relinkView } from '../public/assets/js/repair-model.js';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key;
const project = async (title) => (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
const F = (ref, deps = []) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `($\\mathsf{RCA}_0$) ${ref} holds.`, proof_text: `By $\\Sigma^0_1$ induction, for ${ref}.`, depends_on: deps });
const facts = async (pid, list) => Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: list })).data.created.map((x) => [x.ref, x.id]));
const claim = (pid, kind, model) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: model, ai_model: model, project_id: pid, kinds: [kind], models: { [kind]: [model] }, features: ['procedures', 'review'], capabilities: ['document', 'web_search'] });
const answer = (t, model, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: model, generation_seconds: 20, answer: ans });
const fact = async (fid) => (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;
const ask = (fid, who = ann) => app.call(who, 'POST', `/api/facts/${fid}/correction`, { request_text: 'In the paper the lemma is over RCA, not RCA_0: full induction is allowed.' });
const proposals = [
  { title: 'lemma (RCA)', statement: '($\\mathsf{RCA}$) lemma holds.', proof: 'By induction on all formulas, as RCA allows.', from_source: true, why: 'The source states it over RCA, p. 3.' },
  { title: 'lemma (RCA_0 + ISigma^0_2)', statement: '($\\mathsf{RCA}_0 + \\mathsf{I}\\Sigma^0_2$) lemma holds.', proof: 'The induction used is Sigma^0_2.', from_source: false, why: 'Only Sigma^0_2 induction is used.' },
];

before(async () => {
  app = await startApp();
  ann = await app.signIn(ANN);
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('accepted proposals replace the fact as new facts; the old one is superseded; its dependents are read again; it can be undone', async () => {
  const pid = await project('Superseded');
  const id = await facts(pid, [F('lemma'), F('uses', ['lemma']), F('needs', ['lemma'])]);
  assert.equal((await ask(id.lemma, key)).status, 403, 'people only');
  assert.equal((await ask(id.lemma)).status, 201);
  assert.equal((await ask(id.lemma)).status, 409, 'one at a time');
  assert.equal((await claim(pid, 'statement_fix', 'claude-opus-5-5')).data.task, null, 'not the model that wrote the fact');
  let t = (await claim(pid, 'statement_fix', 'gpt-5.5')).data.task;
  const c = t.context.corrections[0];
  assert.deepEqual(c.used_by.map((x) => x.title).sort(), ['needs', 'uses'], 'the reviser sees what relies on the fact');
  assert.equal((await answer(t, 'gpt-5.5', { summary: '', corrections: [{ correction_id: c.correction_id, outcome: 'corrected', proposals, explanation: 'RCA_0 is wrong.' }] })).status, 200);
  t = (await claim(pid, 'fix_check', 'claude-sonnet-5-5')).data.task;
  assert.equal(t.context.corrections[0].proposals.length, 2);
  await answer(t, 'claude-sonnet-5-5', { summary: '', checks: [
    { correction_id: c.correction_id, proposal: 0, verdict: 'correct', explanation: 'As in the source.' },
    { correction_id: c.correction_id, proposal: 1, verdict: 'correct', explanation: 'The proof only uses Sigma^0_2 induction.' }] });
  let f = await fact(id.lemma);
  assert.equal(f.corrections[0].state, 'decide'); assert.equal(f.retracted_at, null, 'nothing changes before a member decides');
  const view = correctionView(f.corrections[0]);
  assert.ok(view.waitsForMember); assert.deepEqual(view.proposals.map((x) => [x.fromSource, x.accepted]), [[true, true], [false, true]]);
  const d = (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data;
  assert.ok(d.actions.some((a) => a.kind === 'decide' && a.link.id === id.lemma), 'the overview asks for the decision');
  assert.equal((await app.call(key, 'POST', `/api/corrections/${c.correction_id}/apply`, { chosen: [0] })).status, 403, 'a person decides');
  const r = await app.call(ann, 'POST', `/api/corrections/${c.correction_id}/apply`, { chosen: [0, 1] });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.new_facts.length, 2);
  f = await fact(id.lemma);
  assert.ok(f.retracted_at); assert.match(f.retract_reason, /^Superseded by/);
  assert.equal(f.superseded_by.length, 2); assert.equal(f.superseded_by[0].from_source, true);
  const [src, variant] = r.data.new_facts;
  const nf = await fact(src);
  assert.match(nf.statement_text, /\\mathsf\{RCA\}\$\) lemma/); assert.equal(nf.supersedes[0].id, id.lemma);
  assert.equal(nf.title, 'lemma (RCA)', 'the corrected title'); assert.equal((await fact(variant)).title, 'lemma (RCA_0 + ISigma^0_2)');
  // The two dependents are read again: one works with the corrected statement, one needed the old one.
  t = (await claim(pid, 'relink', 'gpt-5.5')).data.task;
  assert.equal(t.context.relinks.length, 2);
  const rel = Object.fromEntries(t.context.relinks.map((x) => [x.fact.title, x.relink_id]));
  assert.equal(t.context.relinks[0].replacements.length, 2);
  await answer(t, 'gpt-5.5', { summary: '', relinks: [
    { relink_id: rel.uses, outcome: 'use', new_fact_id: src, explanation: 'Step 2 only needs the statement over RCA.' },
    { relink_id: rel.needs, outcome: 'needs_old', new_fact_id: null, explanation: 'Step 3 uses that it is provable in RCA_0.' }] });
  t = (await claim(pid, 'relink_check', 'claude-sonnet-5-5')).data.task;
  await answer(t, 'claude-sonnet-5-5', { summary: '', checks: [
    { relink_id: rel.uses, verdict: 'correct', explanation: 'Agreed.' }, { relink_id: rel.needs, verdict: 'correct', explanation: 'Agreed: it needs RCA_0.' }] });
  const uses = await fact(id.uses);
  assert.deepEqual(uses.deps.map((x) => x.id), [src], 'relies on the corrected fact'); assert.equal(uses.current_revision, 2);
  assert.equal(relinkView(uses.relinks[0]).head, 'Relies on the corrected statement');
  const needs = await fact(id.needs);
  assert.equal(needs.relinks[0].state, 'needs_old');
  assert.equal(needs.repairs[0]?.state, 'repair', 'a repair of its proof starts');
  // Undo: the new facts go, the old one is back.
  const u = await app.call(ann, 'POST', `/api/corrections/${c.correction_id}/undo`, {});
  assert.equal(u.status, 200); assert.equal(u.data.retracted_at, null); assert.equal(u.data.superseded_by.length, 0);
  assert.ok((await fact(src)).retracted_at);
});

test('the AIs may keep the statement, or disagree until the rounds run out; nothing changes the fact', async () => {
  const pid = await project('Kept');
  const id = await facts(pid, [F('kept'), F('argued')]);
  await ask(id.kept);
  let t = (await claim(pid, 'statement_fix', 'gpt-5.5')).data.task;
  await answer(t, 'gpt-5.5', { summary: '', corrections: [{ correction_id: t.context.corrections[0].correction_id, outcome: 'keep', proposals: [], explanation: 'The source says RCA_0 on p. 3.' }] });
  t = (await claim(pid, 'fix_check', 'claude-sonnet-5-5')).data.task;
  await answer(t, 'claude-sonnet-5-5', { summary: '', checks: [{ correction_id: t.context.corrections[0].correction_id, proposal: null, verdict: 'correct', explanation: 'Agreed: RCA_0.' }] });
  assert.equal((await fact(id.kept)).corrections[0].state, 'kept');
  await ask(id.argued);
  for (let round = 1; round <= 3; round++) {
    t = (await claim(pid, 'statement_fix', 'gpt-5.5')).data.task;
    assert.equal(t.context.corrections[0].round, round);
    await answer(t, 'gpt-5.5', { summary: '', corrections: [{ correction_id: t.context.corrections[0].correction_id, outcome: 'corrected', proposals: [proposals[0]], explanation: 'As asked.' }] });
    t = (await claim(pid, 'fix_check', 'claude-sonnet-5-5')).data.task;
    await answer(t, 'claude-sonnet-5-5', { summary: '', checks: [{ correction_id: t.context.corrections[0].correction_id, proposal: 0, verdict: 'incorrect', explanation: 'The statement dropped a hypothesis.' }] });
  }
  const f = await fact(id.argued);
  assert.equal(f.corrections[0].state, 'disagree'); assert.equal(f.retracted_at, null);
  assert.equal(correctionView(f.corrections[0]).proposals[0].verdict.label, 'Rejected', 'the last proposal and its verdict stay readable');
});

test('a fact whose repaired proof was accepted keeps that proof when a correction relinks it', async () => {
  const pid = await project('Relinked repair');
  const id = await facts(pid, [F('base'), F('repaired', ['base'])]);
  // Its own proof was found flawed; a repair by another model was accepted (as live fact 1036).
  await app.call(key, 'POST', `/api/facts/${id.repaired}/reviews`, { verdict: 'gap', body_text: 'Claim 3.6 is asserted without proof.', ai_model: 'gpt-5.5' });
  const p = await app.call(key, 'POST', `/api/facts/${id.repaired}/proofs`, { body_text: 'Complete proof, with Claim 3.6 proved: by induction on |D|.', ai_model: 'claude-opus-5-5' });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const proofId = p.data.proofs.at(-1).id; // the answer is the fact, with its proofs
  const pr = await app.call(key, 'POST', `/api/fact-proofs/${proofId}/reviews`, { verdict: 'correct', body_text: 'The induction closes the gap.', ai_model: 'gpt-5.5' });
  const before = await fact(id.repaired);
  assert.equal(before.status, 'ai_checked', JSON.stringify({ p: p.data, pr: pr.data, status: before.status, proofs: before.proofs }).slice(0, 1500));
  await ask(id.base);
  let t = (await claim(pid, 'statement_fix', 'gpt-5.5')).data.task;
  const c = t.context.corrections[0];
  await answer(t, 'gpt-5.5', { summary: '', corrections: [{ correction_id: c.correction_id, outcome: 'corrected', proposals: [proposals[0]], explanation: 'RCA.' }] });
  t = (await claim(pid, 'fix_check', 'claude-sonnet-5-5')).data.task;
  await answer(t, 'claude-sonnet-5-5', { summary: '', checks: [{ correction_id: c.correction_id, proposal: 0, verdict: 'correct', explanation: 'Yes.' }] });
  const r = await app.call(ann, 'POST', `/api/corrections/${c.correction_id}/apply`, { chosen: [0] });
  const nf = r.data.new_facts[0];
  t = (await claim(pid, 'relink', 'gpt-5.5')).data.task;
  assert.match(t.context.relinks[0].fact.proof, /Claim 3.6 proved/, 'the reader reads the proof that holds');
  const rid = t.context.relinks[0].relink_id;
  await answer(t, 'gpt-5.5', { summary: '', relinks: [{ relink_id: rid, outcome: 'use', new_fact_id: nf, explanation: 'Works.' }] });
  t = (await claim(pid, 'relink_check', 'claude-sonnet-5-5')).data.task;
  await answer(t, 'claude-sonnet-5-5', { summary: '', checks: [{ relink_id: rid, verdict: 'correct', explanation: 'Agreed.' }] });
  const f = await fact(id.repaired);
  assert.equal(f.current_revision, 2);
  assert.match(f.proof_text, /Claim 3.6 proved/, 'the accepted repair is the new revision\'s proof');
  const now = f.proofs.filter((x) => x.revision_no === 2);
  assert.ok(now.some((x) => /for repaired/.test(x.body_html)), 'the flawed proof stays beside it, for the record');
  assert.ok(!now.some((x) => /Claim 3.6 proved/.test(x.body_html)), 'and the accepted one is not listed twice');
});
