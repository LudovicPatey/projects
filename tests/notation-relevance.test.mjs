// What the real-data bench found: rewrites redone at every change of the notation, groups of wordings coming apart after rewrites,
// doubts of the model lost in task summaries, and spellings of an entry ("F$ full-matches $X") left unlinked to it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { wordingGroups } from '../public/assets/js/notation-model.js';

const ANN = '0000-0002-1825-0097';
const NOW = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, review_hours: 0, consolidate_hours: 0 } };
let app; let ann; let key;

const project = async (title) => (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
const facts = async (pid, list) => Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: list })).data.created.map((x) => [x.ref, x.id]));
const F = (ref, statement, glossary) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: statement, proof_text: 'Clear.', glossary });
const entry = async (pid, symbol, meaning, status = 'agreed', extra = {}) => {
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol, meaning_text: meaning, ...extra })).data;
  await app.call(ann, 'POST', `/api/notation/${e.id}/status`, { status });
  return e.id;
};
const claim = (pid, kinds) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds, features: ['procedures', 'notation', 'consolidate'], capabilities: ['web_search', 'document'] });
const answer = (t, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 1, answer: ans });
const rewrite = (fid, extra = {}) => app.call(key, 'POST', `/api/facts/${fid}/rephrasings`, { ai_model: 'claude-opus-5-5', unchanged: true, ...extra });
const state = async (fid) => (await app.call(ann, 'GET', `/api/facts/${fid}`)).data.rephrasings.find((x) => x.current) ? 'current' : 'out of date';

before(async () => {
  app = await startApp({ config: NOW }); ann = await app.signIn(ANN);
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('a rewrite goes out of date only when an entry its fact uses changes; a fact that uses none needs no rewrite', async () => {
  const pid = await project('Relevance');
  const id = await facts(pid, [F('fs', 'Every $FS(X)$ is infinite.'), F('kreuzer', 'Under $(\\mu)$, every ultrafilter is idempotent.'), F('plain', 'Every set is a set.')]);
  await entry(pid, '\\mathrm{FS}(X)', 'The finite sums of $X$.');
  await rewrite(id.fs); await rewrite(id.kreuzer);
  assert.equal(await state(id.fs), 'current');
  await entry(pid, '(\\mu)', 'Feferman\'s functional: $\\exists x\\,f(x)=0\\to f(\\mu(f))=0$.', 'local'); // one paper's notion
  assert.equal(await state(id.fs), 'current', 'an entry the FS fact does not write leaves its rewrite current');
  assert.equal(await state(id.kreuzer), 'out of date', 'the fact that writes (\\mu) is rewritten');
  const progress = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.progress;
  assert.equal(progress.facts - progress.unchanged - progress.current, 1, 'only the Kreuzer fact waits; the plain one uses no entry');
  // An entry defined through a symbol a fact writes concerns that fact: NS(X) is defined with FS.
  await entry(pid, '\\mathrm{NS}(X)', '$\\mathrm{FS}(X)\\setminus\\{0\\}$.');
  assert.equal(await state(id.fs), 'out of date', 'NS is defined with FS, which the fact writes');
});

test('rewrites wait while the notation still has symbols to settle', async () => {
  const pid = await project('Settle first');
  await facts(pid, [F('a', 'Every $FS(X)$ has $\\mathrm{SG}$.', { '\\mathrm{SG}': 'a semigroup' }), F('b', 'Each $FS(Y)$ is in $\\mathrm{SG}$.', { '\\mathrm{SG}': 'a closed semigroup' })]);
  await entry(pid, '\\mathrm{FS}(X)', 'The finite sums of $X$.');
  const first = (await claim(pid, ['notation', 'consolidate'])).data.task;
  assert.equal(first.kind, 'consolidate', 'the symbols sweep first');
  assert.equal((await claim(pid, ['notation'])).data.task, null, 'no rewrite while SG is unsettled');
  await answer(first, { summary: '', types: [], decisions: [{ symbol: '\\mathrm{SG}', action: 'local', entry: null, project_symbol: null, meaning: 'A semigroup.', note: '', variants: [], params: [], fact: null, reason: 'One paper.', classes: [], class: null }] });
  const next = (await claim(pid, ['notation'])).data.task;
  assert.ok(next, 'once settled, the rewrites start'); assert.equal(next.kind, 'notation');
});

test('a rewrite changes neither the wordings of a symbol nor what several facts define', async () => {
  const pid = await project('Wordings');
  const id = await facts(pid, [F('a', 'Every $\\mathrm{SG}$ works.', { '\\mathrm{SG}': 'a semigroup' }), F('b', 'Some $\\mathrm{SG}$ works.', { '\\mathrm{SG}': 'a closed semigroup' })]);
  await entry(pid, '\\mathrm{FIN}', 'The non-empty finite sets: $\\mathrm{SG}$ aside.');
  const shared = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.shared;
  const before = (await shared()).find((s) => s.symbol === '\\mathrm{SG}').meanings.map((m) => m.meaning).sort();
  for (const fid of [id.a, id.b]) await rewrite(fid, { unchanged: false, statement_text: 'Every $\\mathrm{SG}$ works.', proof_text: 'Clear.', local_notation: [{ symbol: '\\mathrm{SG}', meaning: 'reworded by the rewrite' }, { symbol: '(\\mathcal U)', meaning: 'only the rewrite defines it' }] });
  const after = await shared();
  assert.deepEqual(after.find((s) => s.symbol === '\\mathrm{SG}').meanings.map((m) => m.meaning).sort(), before, 'the facts\' own wordings stay');
  assert.ok(!after.some((s) => s.symbol === '(\\mathcal U)'), 'a notion only rewrites define is not a symbol several facts define');
  // A settled symbol does not say "not compared yet".
  assert.equal(wordingGroups({ meanings: [{ meaning: 'a', facts: [1] }, { meaning: 'b', facts: [2] }], entry: { id: 1, status: 'local' } }).summary, '2 wordings');
});

test('a doubt of the model waits on the fact for a person, and closes when a person answers it', async () => {
  const pid = await project('Doubts');
  const id = await facts(pid, [F('a', 'Every $FS(S)$ is in $A$.')]);
  await entry(pid, '\\mathrm{FS}(X)', 'The non-empty finite sums of $X$.');
  const r = await rewrite(id.a, { unchanged: false, statement_text: 'Every $FS(S)\\cup\\{0\\}$ is in $A$.', proof_text: 'Clear.', doubt_text: 'The source glossary includes 0 in FS(S): is that what the fact means?' });
  assert.equal(r.status, 201);
  let f = (await app.call(ann, 'GET', `/api/facts/${id.a}`)).data;
  assert.equal(f.ai_questions.length, 1); assert.equal(f.ai_questions[0].kind, 'rewrite'); assert.match(f.ai_questions[0].text, /includes 0/);
  const actions = (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data.actions;
  assert.ok(actions.some((a) => a.kind === 'ai_question' && a.ref === `fact:${id.a}`), 'it is in Needs your attention');
  await app.call(ann, 'POST', `/api/fact-rephrasings/${f.rephrasings[0].id}/check`, { verdict: 'faithful' });
  f = (await app.call(ann, 'GET', `/api/facts/${id.a}`)).data;
  assert.equal(f.ai_questions.length, 0, 'a person checked the rewrite: answered');
  const t = (await app.call(key, 'GET', `/api/ai/procedures`)).data.procedures;
  assert.ok(t.length);
});

test('a source check with a doubt waits for a person until someone reviews the cited result; old answers without doubts still apply', async () => {
  const pid = await project('Source doubts');
  const bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'A book', author: 'X, Y.', year: '2000' }, cite_key: 'xy00' })).data.created[0];
  const id = await facts(pid, [{ ref: 'c', title: 'c', kind: 'theorem', labels: ['conclusion'], method: 'extracted', statement_text: 'S c.', proof_text: '', sources: [{ type: 'bib', id: bib, quote: 'Theorem', covers: 'statement' }] }]);
  const t = (await claim(pid, ['source_check'])).data.task;
  assert.match(t.recipe.instructions, /say in "doubt" what a person should check/);
  assert.equal((await answer(t, { summary: '', checks: [{ fact_id: id.c, verdict: 'confirmed', where: 'Theorem 1', explanation: 'From an abstract.', doubt: 'Only the abstract was read: check Theorem 1 in the paper.' }] })).status, 200);
  let f = (await app.call(ann, 'GET', `/api/facts/${id.c}`)).data;
  assert.equal(f.ai_questions[0]?.kind, 'source');
  await app.call(ann, 'POST', `/api/facts/${id.c}/reviews`, { verdict: 'correct' });
  f = (await app.call(ann, 'GET', `/api/facts/${id.c}`)).data;
  assert.equal(f.ai_questions.length, 0, 'a person reviewed it: answered');
});

test('a spelling with arguments or stray dollars finds its entry: the sweep sees the same term, a tidied answer still counts, a member can record it', async () => {
  const pid = await project('Same term');
  await facts(pid, [F('a', 'If $F$ full-matches $X$ then...', { 'F$ full-matches $X': '$F<X$ and for every $b\\in FU(X)$ some $a\\in F$ has $f(a)=f(a\\cup b)=f(b)$' }),
    F('b', 'When $F$ full-matches $X$...', { 'F$ full-matches $X': '$F<X$ and each $b\\in FU(X)$ has $a\\in F$ with $f(a)=f(a\\cup b)=f(b)$' })]);
  const fut = await entry(pid, 'full-match (FUT)', 'In $(\\mathrm{FIN},\\cup)$: $F$ full-matches $X$ if $F<X$ and for every $b\\in FU(X)$ some $a\\in F$ has $f(a)=f(a\\cup b)=f(b)$.');
  await entry(pid, 'full-match (HT)', 'In $(\\mathbb N,+)$: $F$ full-matches $X$ if ...');
  const row = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.shared.find((s) => s.symbol.includes('full-matches'));
  assert.deepEqual((await row()).related.map((x) => x.symbol).sort(), ['full-match (FUT)', 'full-match (HT)']);
  const t = (await claim(pid, ['consolidate'])).data.task;
  const listed = t.context.symbols.find((s) => s.symbol.includes('full-matches'));
  assert.deepEqual(listed.same_term.map((x) => x.symbol).sort(), ['full-match (FUT)', 'full-match (HT)']);
  assert.match(t.recipe.instructions, /"same_term" lists the entries/);
  // The model writes the symbol without the stray dollars: its decision still counts.
  const done = await answer(t, { summary: '', types: [], decisions: [{ symbol: 'F full-matches X', action: 'same', entry: fut, project_symbol: null, meaning: 'the FUT full-match', note: '', variants: [], params: [], fact: null, reason: 'The FUT setting.', classes: [], class: null }] });
  assert.match(done.data.summary_text, /1 recorded as spellings/);
  assert.equal((await row()).entry?.id, fut, 'the row is now that entry');
  // A member records a spelling by hand.
  const other = await project('By hand');
  await facts(other, [F('a', 'A $P$-branch $(F,X)$.', { 'P-branch $(F,X)$': 'a pair with $F<X$' }), F('b', 'Another $P$-branch.', { 'P-branch $(F,X)$': 'a pair $(F,X)$ with $F<X$' })]);
  const pb = await entry(other, 'P-branch', 'A pair $(F,X)$ with $F<X$.', 'local');
  const r = await app.call(ann, 'POST', `/api/notation/${pb}/spellings`, { symbol: 'P-branch $(F,X)$', meaning: 'as the facts write it' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await app.call(key, 'POST', `/api/notation/${pb}/spellings`, { symbol: 'x' })).status, 403, 'a person only');
  const after = (await app.call(ann, 'GET', `/api/projects/${other}/notation`)).data.shared.find((s) => s.symbol.includes('P-branch'));
  assert.equal(after.entry?.id, pb);
});
