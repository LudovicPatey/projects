// Answers at the edge: what changed between the claim and the answer, the same proposal twice in one answer, numbers the model
// invented. Each must leave the data right, and never lose the rest of the answer.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const NOW = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, review_hours: 0, consolidate_hours: 0 } };
let app; let ann; let key;

const project = async (title) => (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
const facts = async (pid, list) => Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: list })).data.created.map((x) => [x.ref, x.id]));
const F = (ref, extra) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `Every $X$ has ${ref}.`, proof_text: `Proof of ${ref}.`, ...extra });
const claim = (pid, kinds) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds, features: ['procedures', 'notation', 'consolidate', 'review'], capabilities: ['web_search', 'document'] });
const answer = (t, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 3, answer: ans });
const agree = async (pid, symbol, meaning) => {
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol, meaning_text: meaning })).data;
  await app.call(ann, 'POST', `/api/notation/${e.id}/status`, { status: 'agreed' });
  return e.id;
};

before(async () => {
  app = await startApp({ config: NOW }); ann = await app.signIn(ANN);
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('the same new cited result proposed twice in one answer is written once', async () => {
  const pid = await project('Twice');
  const id = await facts(pid, [F('ext', { proof_text: 'By Milliken.', external_refs: [{ key: 'm75', title: 'Milliken' }] })]);
  const ref = (await app.call(ann, 'GET', `/api/facts/${id.ext}`)).data.outside_refs[0].key;
  const cite = { kind: 'cite', fact: id.ext, ref, title: 'Milliken\'s theorem', statement: 'Every coloring of finite unions has a homogeneous block sequence.', new_kind: 'theorem', reason: 'The proof uses it.', confidence: 'high' };
  const r = (await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [cite, { ...cite, title: 'Milliken 1975' }] })).data;
  assert.equal(r.applied.length, 1, 'the first is applied');
  assert.equal(r.skipped.length, 1, 'the second sees the reference settled');
  const cited = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.filter((f) => /Milliken/.test(f.title));
  assert.equal(cited.length, 1, 'one cited result, not two');
});

test('a rewrite asked for one fact is not kept when the fact was edited before the answer', async () => {
  const pid = await project('Edited');
  const id = await facts(pid, [F('a')]);
  await agree(pid, '\\mathrm{FIN}', 'The non-empty finite subsets of $\\mathbb N$.');
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'notation', source_type: 'fact', source_id: id.a })).status, 201);
  const t = (await claim(pid, ['notation'])).data.task;
  assert.equal(t.source_type, 'fact');
  assert.ok((await app.call(key, 'PATCH', `/api/facts/${id.a}`, { statement_text: 'Every $X$ has a stronger property.', ai_model: 'm' })).status < 300);
  const done = await answer(t, { summary: '', unchanged: false, statement: 'Every $X$ has a (old text).', proof: 'Proof of a.', local_notation: [], uses: [] });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.match(done.data.summary_text, /edited or removed since/);
  const f = (await app.call(ann, 'GET', `/api/facts/${id.a}`)).data;
  assert.ok(!(f.rephrasings || []).some((x) => x.revision_no === f.current_revision), 'the new revision has no rewrite of the old text');
});

test('a rewrite made in a notation changed before the answer counts as out of date, and is made again', async () => {
  const pid = await project('Notation moved');
  await facts(pid, [F('b', { statement_text: 'Every $X\\in\\mathrm{FIN}$ has $FS(X)$ finite.' })]); // it uses both entries below
  await agree(pid, '\\mathrm{FIN}', 'The non-empty finite subsets of $\\mathbb N$.');
  const t = (await claim(pid, ['notation'])).data.task;
  assert.equal(t.source_type, 'sweep');
  const fid = t.context.facts_to_rewrite[0].fact_id;
  await agree(pid, '\\mathrm{FS}(X)', 'The finite sums of $X$.'); // the notation changes while the AI writes
  const done = await answer(t, { summary: '', facts: [{ fact_id: fid, unchanged: true, statement: '', proof: null, local_notation: [], uses: [] }] });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const again = (await claim(pid, ['notation'])).data.task;
  assert.ok(again, 'the fact is rewritten again in the new notation');
  assert.deepEqual(again.context.facts_to_rewrite.map((x) => x.fact_id), [fid]);
});

test('groups of wordings with numbers the model invented, or repeated, keep only what is real', async () => {
  const pid = await project('Invented');
  await facts(pid, [F('a', { glossary: { '\\mathrm{SG}': 'a semigroup' } }), F('b', { glossary: { '\\mathrm{SG}': 'a closed semigroup' } })]);
  const t = (await claim(pid, ['consolidate'])).data.task;
  assert.equal(t.recipe.variant, 'consolidate_notation');
  const other = await project('Elsewhere');
  const foreign = (await app.call(ann, 'POST', `/api/projects/${other}/notation`, { symbol: '\\mathrm{SG}', meaning_text: 'Elsewhere.' })).data.id;
  const done = await answer(t, { summary: '', types: [], decisions: [{ symbol: '\\mathrm{SG}', action: 'local', entry: null, project_symbol: null, meaning: 'A semigroup.', note: '', variants: [], params: [], fact: null, reason: 'r',
    classes: [{ meanings: [1, 1, 0, 99, -3], label: 'one', entry: foreign, decided: true }, { meanings: [1, 2], label: 'two', entry: null, decided: false }] }] });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const row = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.shared.find((x) => x.symbol === '\\mathrm{SG}');
  assert.deepEqual(row.classes.map((c) => c.meanings.length).sort(), [1, 1], 'each real wording in one group, the invented numbers dropped');
  assert.ok(row.classes.every((c) => c.entry?.id !== foreign), 'an entry of another project is never linked');
});
