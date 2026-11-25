// The native prover on the platform: campaigns, rounds, notes, verified facts, citations, and the comparison with Danus.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
let app; let ann; let bob; let key; let bobKey; let pid; let qid; let id; let cid;

const claim = (who = key, body = {}) => app.call(who, 'POST', `/api/prover/campaigns/${cid}/rounds`, { engine: 'claude', ai_model: 'claude-opus-5-5', client_name: 'mac', ...body });

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Prover', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB, role: 'member' });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  bobKey = { token: (await app.call(bob, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  qid = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Triples?' })).data.id;
  const F = (ref, extra) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `P ${ref}.`, ...extra });
  id = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'gpt-5.6-sol', facts: [F('checked'), F('loose')] })).data.created.map((x) => [x.ref, x.id]));
  await app.call(ann, 'POST', `/api/facts/${id.checked}/reviews`, { verdict: 'correct' });
});
after(() => app?.stop());

test('a campaign on a question is shared: starting it again joins it', async () => {
  const r = await app.call(key, 'POST', `/api/projects/${pid}/prover/campaigns`, { question_id: qid, goal: 'Settle triples.' });
  assert.equal(r.status, 201); cid = r.data.id;
  assert.equal(r.data.status, 'active'); assert.equal(r.data.goal, 'Settle triples.');
  assert.equal((await app.call(bobKey, 'POST', `/api/projects/${pid}/prover/campaigns`, { question_id: qid })).data.id, cid, 'another member joins it');
  assert.equal((await app.call(key, 'POST', `/api/projects/${pid}/prover/campaigns`, { question_id: 999999 })).status, 422);
});

test('the first round is the lead; its guidance gives the workers their lanes, and becomes a strategy of the question', async () => {
  const lead = (await claim()).data.round;
  assert.equal(lead.kind, 'lead');
  assert.equal((await claim(bobKey)).data.round.kind, 'worker', 'one lead at a time');
  assert.equal((await app.call(bobKey, 'POST', `/api/prover/rounds/${lead.id}/lead`, { lanes: [] })).status, 403, 'only its client answers');
  assert.equal((await app.call(key, 'POST', `/api/prover/rounds/${lead.id}/lead`, { lanes: [] })).status, 422);
  const r = await app.call(key, 'POST', `/api/prover/rounds/${lead.id}/lead`, { summary: 'Pairs are done.', elaboration: 'Closed: induction.', guidance: 'Try ultrafilters.',
    lanes: [{ title: 'Ultrafilters', task: 'Build an idempotent.' }, { title: 'Counterexamples', task: 'Look for a coloring.' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await app.call(key, 'POST', `/api/prover/rounds/${lead.id}/finish`, { seconds: 90, summary: 'Lanes set.' });
  const s = (await app.call(ann, 'GET', `/api/strategies/${r.data.strategy_id}`)).data;
  assert.equal(s.strategy?.title ?? s.title, 'Proof search with the native prover');
  const w = (await claim()).data.round;
  assert.equal(w.kind, 'worker'); assert.ok(['Ultrafilters', 'Counterexamples'].includes(w.lane_task.title));
  const w2 = (await claim()).data.round;
  assert.notEqual(w2.lane, w.lane, 'the lane worked least recently');
  for (const x of [w, w2]) await app.call(key, 'POST', `/api/prover/rounds/${x.id}/finish`, { seconds: 10 });
});

test('a verified fact is created with the verifier\'s review, and may rely only on facts the prover can build on', async () => {
  const w = (await claim()).data.round;
  const post = (body) => app.call(key, 'POST', `/api/prover/rounds/${w.id}/facts`, { title: 'Step', kind: 'lemma', statement: 'S new.', proof: 'By the checked lemma.', verifier: { model: 'gpt-5.6-sol', report: 'All steps check.' }, ...body });
  assert.match((await post({ depends_on: [id.loose] })).data.error, /verify it before building on it/);
  assert.equal((await post({ verifier: {} })).status, 422);
  const r = await post({ depends_on: [id.checked] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const f = (await app.call(ann, 'GET', `/api/facts/${r.data.id}`)).data;
  assert.equal(f.tool, 'prover'); assert.equal(f.method, 'deduced'); assert.equal(f.ai_model, 'claude-opus-5-5'); assert.deepEqual(f.deps.map((d) => d.id), [id.checked]);
  assert.equal(f.status, 'ai_checked', 'another model verified it'); assert.equal(f.reviews[0].ai_model, 'gpt-5.6-sol');
  const same = await post({ statement: 'S same.', verifier: { model: 'claude-opus-5-5' } });
  const g = (await app.call(ann, 'GET', `/api/facts/${same.data.id}`)).data;
  assert.equal(g.status, 'unchecked', 'the same model is not an independent check');
  const ctx = Object.fromEntries((await app.call(key, 'GET', `/api/projects/${pid}/proving-context`)).data.facts.map((x) => [x.id, x]));
  assert.equal(ctx[same.data.id].usable, true, 'but the prover may build on what its verifier accepted'); assert.equal(ctx[same.data.id].trusted, false);
  assert.equal(ctx[id.loose].usable, false);
  await app.call(key, 'POST', `/api/prover/rounds/${w.id}/rejected`, { statement: 'S bad.', hints: 'Step 3 fails.' });
  await app.call(key, 'POST', `/api/prover/rounds/${w.id}/notes`, { kind: 'dead_end', claim: 'Induction on k', evidence: 'Fails at k = 3.' });
  assert.equal((await app.call(key, 'POST', `/api/prover/rounds/${w.id}/notes`, { kind: 'gossip', claim: 'x' })).status, 422);
  await app.call(key, 'POST', `/api/prover/rounds/${w.id}/finish`, { seconds: 1800, summary: 'Two facts.' });
  assert.equal((await app.call(key, 'POST', `/api/prover/rounds/${w.id}/notes`, { kind: 'plan', claim: 'late' })).status, 409, 'a finished round writes nothing');
  const notes = (await app.call(key, 'GET', `/api/prover/campaigns/${cid}/notes`)).data.notes;
  assert.deepEqual(notes.map((n) => n.kind), ['conclusion', 'conclusion', 'verification', 'dead_end']);
  assert.match(notes[2].evidence, /Step 3 fails/);
  const c = (await app.call(ann, 'GET', `/api/prover/campaigns/${cid}`)).data;
  assert.equal(c.facts, 2); assert.equal(c.rejected, 1);
});

test('a result of the literature becomes a cited result with its source check', async () => {
  const w = (await claim()).data.round;
  assert.equal((await app.call(key, 'POST', `/api/prover/rounds/${w.id}/cited`, { title: 'Hindman', statement: 'FS.', reference: {}, check: { verdict: 'confirmed' } })).status, 422);
  const r = await app.call(key, 'POST', `/api/prover/rounds/${w.id}/cited`, { title: 'Hindman\'s theorem', statement: 'Every finite coloring of N has an IP set.',
    reference: { title: 'Finite sums from sequences within cells of a partition of N', year: 1974, cited_for: 'Theorem 3.1' }, check: { verdict: 'confirmed', model: 'claude-sonnet-5-5', explanation: 'Theorem 3.1.' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const f = (await app.call(ann, 'GET', `/api/facts/${r.data.id}`)).data;
  assert.equal(f.basis, 'cited'); assert.equal(f.status, 'source_confirmed'); assert.equal(f.external_refs[0].cited_for, 'Theorem 3.1');
  const ctx = (await app.call(key, 'GET', `/api/projects/${pid}/proving-context`)).data.facts.find((x) => x.id === r.data.id);
  assert.equal(ctx.usable, true); assert.equal(ctx.trusted, false, 'a person has not accepted it');
  await app.call(key, 'POST', `/api/prover/rounds/${w.id}/finish`, { seconds: 60 });
});

test('a paused campaign gives no rounds; only people pause it', async () => {
  assert.equal((await app.call(key, 'POST', `/api/prover/campaigns/${cid}/status`, { status: 'paused' })).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/prover/campaigns/${cid}/status`, { status: 'paused' })).status, 200);
  assert.equal((await claim()).status, 409);
  await app.call(ann, 'POST', `/api/prover/campaigns/${cid}/status`, { status: 'active' });
});

test('the comparison puts Danus and the native prover side by side', async () => {
  const s = (await app.call(ann, 'GET', `/api/projects/${pid}/prover/stats`)).data;
  assert.equal(s.native.facts, 3); assert.equal(s.native.rejected_by_verifier, 1); assert.equal(s.native.established, 1);
  assert.ok(s.native.seconds >= 1900); assert.ok(s.native.facts_per_hour > 0);
  assert.equal(s.danus.facts, 0); assert.equal(s.danus.facts_per_hour, null);
});
