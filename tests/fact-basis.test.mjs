// Cited results and proved facts: a proof relies only on facts of the database, and a cited result waits for a person who read its source.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
let app; let ann; let bob; let key; let pid; let bib; let id;

const fact = async (fid) => (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;
const listed = async () => Object.fromEntries((await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.map((f) => [f.title, f]));
const claim = (body) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, features: ['procedures', 'review'], capabilities: ['web_search', 'document'], ...body });

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Basis', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB, role: 'member' });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'Finite sums from sequences', author: 'Hindman, N.', year: '1974' }, cite_key: 'hindman74' })).data.created[0];
  const doc = { type: 'bib', id: bib, quote: 'Theorem 3.1', covers: 'statement' };
  const F = (ref, extra) => ({ ref, title: ref, kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.', ...extra });
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    F('hindman', { method: 'extracted', proof_text: '', sources: [doc] }),
    F('uses_bib', { proof_text: `By @{bib:${bib}}, the coloring has a homogeneous set.` }),
    F('uses_ext', { proof_text: 'By Milliken\'s theorem.', external_refs: [{ key: 'milliken75', title: 'Ramsey\'s theorem with sums or unions', year: 1975, cited_for: 'Milliken\'s theorem' }] }),
    F('above', { proof_text: 'By uses_ext.', depends_on: ['uses_ext'] }),
    F('remark', { kind: 'remark', proof_text: '' }),
  ] })).data;
  assert.ok(made.created, JSON.stringify(made));
  id = Object.fromEntries(made.created.map((x) => [x.ref, x.id]));
});
after(() => app?.stop());

test('a fact without its proof is a cited result, one with its proof a proved fact', async () => {
  const f = await listed();
  assert.equal(f.hindman.basis, 'cited'); assert.equal(f.uses_bib.basis, 'proved'); assert.equal(f.remark.basis, 'none', 'a remark claims nothing to establish');
  assert.equal(f.hindman.status, 'unchecked');
});

test('a proof that uses an outside reference directly has incomplete dependencies, and so has what relies on it', async () => {
  const f = await listed();
  assert.equal(f.uses_ext.incomplete, true); assert.equal(f.uses_bib.incomplete, true); assert.equal(f.above.incomplete, false);
  assert.equal(f.above.chain, 'incomplete', 'it relies on a proof that still uses an outside result');
  const refs = (await fact(id.uses_ext)).outside_refs;
  assert.equal(refs.length, 1); assert.match(refs[0].key, /^ext:[0-9a-f]{16}$/); assert.match(refs[0].label, /Ramsey's theorem with sums or unions, 1975: Milliken's theorem/); assert.equal(refs[0].resolved, false);
  assert.deepEqual((await fact(id.uses_bib)).outside_refs.map((r) => [r.key, r.resolved]), [[`bib:${bib}`, false]]);
});

test('a cited result whose source is the same entry settles a cited reference once the proof depends on it', async () => {
  const s = (await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ kind: 'depends', fact: id.uses_bib, other_fact: id.hindman, reason: 'It cites Hindman.' }] })).data.created[0];
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${s}/accept`, {})).status, 200);
  const r = (await fact(id.uses_bib)).outside_refs[0];
  assert.equal(r.resolved, true); assert.equal(r.fact.id, id.hindman);
  assert.equal((await listed()).uses_bib.incomplete, false);
  assert.equal((await listed()).uses_bib.chain, 'unchecked', 'it rests on a cited result nobody accepted yet');
});

test('only a person accepts a cited result, and the result it supports then rests on accepted citations', async () => {
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'review', source_type: 'fact', source_id: id.hindman })).status, 422, 'no proof to review');
  await app.call(key, 'POST', `/api/facts/${id.hindman}/reviews`, { verdict: 'correct', body_text: 'Looks right.', ai_model: 'gpt-5.6-sol' });
  assert.equal((await listed()).hindman.status, 'unchecked', 'an AI review does not accept a citation');
  await app.call(bob, 'POST', `/api/facts/${id.hindman}/reviews`, { verdict: 'correct', body_text: 'Theorem 3.1 of the paper.' });
  const f = await listed();
  assert.equal(f.hindman.status, 'accepted'); assert.equal(f.uses_bib.chain, 'ok');
  const t = (await app.call(ann, 'GET', `/api/facts/${id.uses_bib}/trace`)).data;
  assert.deepEqual(t.rests_on.map((c) => [c.id, c.status]), [[id.hindman, 'accepted']]); assert.equal(t.rests_on_accepted, 1); assert.deepEqual(t.incomplete, []);
});

test('an AI checks that the source states a cited result: evidence, shown apart, never an acceptance', async () => {
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'source_check', source_type: 'fact', source_id: id.uses_ext })).status, 422, 'a proved fact has no source to check');
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: [
    { ref: 'c', title: 'c', kind: 'lemma', labels: ['conclusion'], method: 'extracted', statement_text: 'S c.', sources: [{ type: 'bib', id: bib, quote: 'Lemma 2', covers: 'statement' }] }] })).data.created[0].id;
  // A batch already checks it with the other cited results of its source; a member can still ask for a check of this one.
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'source_check', source_type: 'fact', source_id: made })).status, 201);
  for (const x of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) {
    if (x.kind === 'source_check' && x.status === 'pending' && x.source_id !== made) await app.call(ann, 'POST', `/api/ai/tasks/${x.id}/cancel`, {});
  }
  assert.equal((await claim({ kinds: ['source_check'], capabilities: ['document'] })).data.task, null, 'it needs web search');
  const t = (await claim({ kinds: ['source_check'] })).data.task;
  assert.equal(t.recipe.procedure, 'source_check'); assert.equal(t.context.fact.statement, 'S c.'); assert.equal(t.context.fact.proof, undefined);
  assert.equal(t.context.fact.sources[0].quote, 'Lemma 2');
  const send = (answer, who = key) => app.call(who, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 3, answer });
  assert.equal((await send({ summary: 'x', verdict: 'maybe', where: '', explanation: '' })).status, 422);
  const r = await send({ summary: 'Found it.', verdict: 'confirmed', where: 'Lemma 2, page 4', explanation: 'The paper states it as written.' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.summary_text, /^The source states it\. Found it\./);
  const f = await fact(made);
  assert.equal(f.status, 'source_confirmed'); assert.equal(f.source_checks[0].verdict, 'confirmed'); assert.equal(f.source_checks[0].independent, true);
  assert.match(f.source_checks[0].body_text, /Where: Lemma 2, page 4/);
  assert.equal(f.source_checks[0].ai_model, 'claude-opus-5-5');
});

test('a person settles an outside reference: the fact that states it, or not used as a result', async () => {
  const key2 = (await fact(id.uses_ext)).outside_refs[0].key;
  assert.equal((await app.call(key, 'POST', `/api/facts/${id.uses_ext}/refs`, { ref: key2, not_used: true })).status, 403, 'people decide');
  assert.equal((await app.call(ann, 'POST', `/api/facts/${id.uses_ext}/refs`, { ref: 'ext:nope', not_used: true })).status, 422);
  assert.equal((await app.call(ann, 'POST', `/api/facts/${id.uses_ext}/refs`, { ref: key2, fact_id: id.uses_ext })).status, 422, 'not itself');
  assert.equal((await app.call(ann, 'POST', `/api/facts/${id.uses_ext}/refs`, { ref: key2, fact_id: id.above })).status, 409, 'no cycle');
  let r = await app.call(ann, 'POST', `/api/facts/${id.uses_ext}/refs`, { ref: key2, not_used: true });
  assert.equal(r.status, 200); assert.equal(r.data.outside_refs[0].not_used, true); assert.equal(r.data.incomplete, false);
  r = await app.call(ann, 'POST', `/api/facts/${id.uses_ext}/refs`, { ref: key2, clear: true });
  assert.equal(r.data.incomplete, true);
});

test('the consolidation writes the cited result behind an outside reference, and accepting it links the proof to it', async () => {
  const ref = (await fact(id.uses_ext)).outside_refs[0].key;
  const ctx = (await (async () => {
    await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate' });
    const t = (await claim({ kinds: ['consolidate'] })).data.task;
    await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
    await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {});
    return t;
  })());
  const row = ctx.context.fact_texts.find((f) => f.id === id.uses_ext);
  assert.equal(row.basis, 'proved'); assert.deepEqual(row.outside_refs.map((x) => x.key), [ref]);
  assert.match(ctx.recipe.instructions, /"cite"/); assert.ok(ctx.recipe.schema.properties.suggestions.items.properties.ref);
  const post = (x) => app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ kind: 'cite', fact: id.uses_ext, reason: 'The proof uses Milliken.', ...x }] });
  assert.match((await post({ ref: 'ext:nope', title: 'M', statement: 'S' })).data.skipped[0].reason, /outside reference/);
  assert.match((await post({ ref })).data.skipped[0].reason, /title and a statement/);
  const sid = (await post({ ref, title: 'Milliken\'s theorem', statement: 'Every finite coloring of block sequences has a homogeneous block subsequence.', new_kind: 'theorem' })).data.created[0];
  assert.equal((await post({ ref, title: 'Again', statement: 'Again' })).data.skipped[0].reason, 'The same proposal is already waiting.');
  const r = await app.call(bob, 'POST', `/api/fact-suggestions/${sid}/accept`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.created, true);
  const cited = await fact(r.data.cited_fact_id);
  assert.equal(cited.basis, 'cited'); assert.equal(cited.status, 'unchecked'); assert.equal(cited.method, 'extracted'); assert.equal(cited.origin, 'ai');
  assert.equal(cited.external_refs[0].key, 'milliken75', 'it names the reference it comes from');
  const f = await fact(id.uses_ext);
  assert.equal(f.incomplete, false); assert.deepEqual(f.deps.map((d) => d.id), [r.data.cited_fact_id]); assert.equal(f.outside_refs[0].fact.id, r.data.cited_fact_id);
  assert.equal((await listed()).above.chain, 'unchecked', 'what relies on it now rests on a citation nobody accepted');
});

test('a reviewer reads which dependencies are cited results, and assumes them', async () => {
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'review', source_type: 'fact', source_id: id.uses_ext });
  const t = (await claim({ kinds: ['review'], ai_model: 'gpt-5.6-sol', models: { review: ['gpt-5.6-sol'] } })).data.task;
  assert.ok(t);
  assert.deepEqual(t.context.dependencies.map((d) => [d.basis, d.status]), [['cited', 'unchecked']]);
  assert.deepEqual(t.context.fact.outside_refs.map((x) => x.settled), [true]);
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
});
