// Maintenance sweeps: upkeep no one waits for is one task per kind, queued once the project is quiet and taking what is stale
// when a client takes it, a batch at a time. Source checks and rewrites in the project notation are no longer one task per fact.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const NOW = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, consolidate_hours: 0 } };
let app; let quiet; let ann; let key; let pid; let bib; let bib2;

const tasks = async (a = app, who = ann, p = pid) => (await a.call(who, 'GET', `/api/projects/${p}/ai`)).data.tasks;
const claim = (kinds, extra = {}, a = app, k = key, p = pid) => a.call(k, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: p, kinds, features: ['procedures', 'notation'], capabilities: ['web_search', 'document'], ...extra });
const answer = (t, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 20, answer: ans });
const F = (ref, extra) => ({ ref, title: ref, kind: 'theorem', labels: ['conclusion'], method: 'extracted', statement_text: `S ${ref}.`, proof_text: '', sources: [{ type: 'bib', id: bib, quote: 'Theorem 1', covers: 'statement' }], ...extra });
const batch = (facts, a = app, k = key, p = pid) => a.call(k, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts });

before(async () => {
  app = await startApp({ config: NOW }); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Sweeps', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'A survey', author: 'Doe, J.', year: '2020' }, cite_key: 'doe20' })).data.created[0];
  bib2 = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'Another', author: 'Roe, R.', year: '2021' }, cite_key: 'roe21' })).data.created[0];
});
after(() => { app?.stop(); quiet?.stop(); });

test('new cited results make no task of their own; a source sweep checks them ten at a time, source by source, until none is left', async () => {
  const r = await batch([...Array.from({ length: 12 }, (_, i) => F(`c${i}`)), F('elsewhere', { sources: [{ type: 'bib', id: bib2, quote: 'Lemma 2', covers: 'statement' }] }), F('proved', { proof_text: 'P.' })]);
  assert.equal(r.status, 201);
  assert.equal(r.data.source_checks_queued, undefined);
  const queued = (await tasks()).filter((t) => t.kind === 'source_check');
  assert.deepEqual(queued.map((t) => [t.source_type, t.subject]), [['sweep', 'cited results not yet checked']], 'one sweep, not one task per result');
  const seen = [];
  for (let round = 0; round < 3; round++) {
    const t = (await claim(['source_check'])).data.task;
    assert.ok(t, `round ${round}`); assert.equal(t.source_type, 'sweep'); assert.equal(t.recipe.variant, 'source_check_batch');
    const ids = t.context.cited_results.map((x) => x.id);
    seen.push(ids.length);
    assert.equal((await answer(t, { summary: 'Read.', checks: ids.map((fact_id) => ({ fact_id, verdict: 'not_found', where: '', explanation: 'Not there.' })) })).status, 200);
  }
  assert.deepEqual(seen, [10, 2, 1], 'the largest source first, then the rest');
  assert.equal((await claim(['source_check'])).data.task, null, 'every cited result was checked once: nothing is due');
  assert.equal((await tasks()).filter((t) => t.kind === 'source_check').length, 3, 'three tasks for thirteen results');
});

test('a rewrite sweep writes at most twelve facts per session, records each, and carries on until every fact is in the notation', async () => {
  const P = (ref) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `$FS(X)$ is large ${ref}.`, proof_text: 'P.' });
  await batch([P('p1'), P('p2'), P('p3')]);
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'FS(X)', meaning_text: 'The finite sums of $X$.' })).data;
  await app.call(ann, 'POST', `/api/notation/${e.id}/status`, { status: 'agreed' });
  let t = (await claim(['notation'])).data.task;
  assert.equal(t.source_type, 'sweep'); assert.equal(t.recipe.variant, 'notation_rephrase_batch');
  assert.match(t.recipe.instructions, /facts_to_rewrite[\s\S]*The mathematical content must stay exactly the same/);
  assert.equal(t.context.facts_to_rewrite.length, 12, 'a batch');
  assert.ok(t.context.notation.some((n) => n.symbol === 'FS(X)'));
  const write = (list, skip = 0) => list.slice(skip).map((f) => ({ fact_id: f.fact_id, unchanged: true, statement: f.statement, proof: f.proof, local_notation: [], uses: [] }));
  let r = await answer(t, { summary: 'Done.', facts: [...write(t.context.facts_to_rewrite, 1), { fact_id: 999999, unchanged: true, statement: 'x', proof: null, local_notation: [], uses: [] }] });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.summary_text, /^11 facts written in the project notation \(11 already were\)/);
  const left = t.context.facts_to_rewrite[0].fact_id;
  t = (await claim(['notation'])).data.task;
  assert.ok(!t.context.facts_to_rewrite.some((f) => f.fact_id === left), 'the fact the model left out waits for the notation to change');
  r = await answer(t, { summary: 'Done.', facts: write(t.context.facts_to_rewrite) });
  assert.equal(r.status, 200);
  const progress = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.progress;
  assert.equal(progress.facts - progress.unchanged, 1, 'every fact but the one left out');
  assert.equal((await claim(['notation'])).data.task, null);
  assert.equal((await tasks()).filter((x) => x.kind === 'notation').length, 2, 'two tasks for seventeen facts');
});

test('a client that does not run recipes never gets a sweep', async () => {
  await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'FU(X)', meaning_text: 'The finite unions of $X$.' }).then((x) => app.call(ann, 'POST', `/api/notation/${x.data.id}/status`, { status: 'agreed' }));
  assert.equal((await claim(['notation'], { features: ['notation'] })).data.task, null);
  const t = (await claim(['notation'])).data.task;
  assert.equal(t.source_type, 'sweep');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
});

test('with the usual settings, nothing is queued while facts arrive; a member asking to rewrite starts a sweep at once', async () => {
  quiet = await startApp();
  const a = await quiet.signIn(ANN);
  const p = (await quiet.call(a, 'POST', '/api/projects', { title: 'Quiet', question_html: '<p>Q</p>' })).data.id;
  const k = { token: (await quiet.call(a, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const P = (ref) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.' });
  await quiet.call(k, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [P('a'), P('b')] });
  const e = (await quiet.call(a, 'POST', `/api/projects/${p}/notation`, { symbol: 'FS(X)', meaning_text: 'Sums.' })).data;
  await quiet.call(a, 'POST', `/api/notation/${e.id}/status`, { status: 'agreed' });
  assert.equal((await claim(['notation', 'source_check', 'consolidate'], {}, quiet, k, p)).data.task, null, 'facts just arrived: not yet');
  const r = await quiet.call(a, 'POST', `/api/projects/${p}/notation/rephrase-all`, {});
  assert.equal(r.status, 201); assert.equal(r.data.queued, 2); assert.equal(r.data.progress.queued, 2);
  const list = await tasks(quiet, a, p);
  assert.equal(list.length, 1); assert.equal(list[0].subject, 'facts not yet in the project notation'); assert.equal(list[0].group, 'notation_rephrase');
  assert.equal(list[0].priority, 50, 'background work, asked by a member');
  assert.equal((await quiet.call(a, 'POST', `/api/projects/${p}/notation/rephrase-all`, {})).data.queued, 2, 'asking again joins the same sweep');
  assert.equal((await tasks(quiet, a, p)).length, 1);
});
