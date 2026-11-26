// Symbols that several facts define and that the project notation lacks are settled by an AI, thirty at a time: adopted, kept
// local to their paper, or recorded as another spelling of an entry. A glossary key defining two symbols is two symbols.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const NOW = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, consolidate_hours: 0 } };
let app; let ann; let key; let pid; let ids; let mu;

const claim = (kinds) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds, features: ['procedures', 'notation', 'consolidate'], capabilities: [] });
const answer = (t, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 9, answer: ans });
const shared = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.shared;

before(async () => {
  app = await startApp({ config: NOW }); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Symbols', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const F = (ref, glossary) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.', glossary });
  ids = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'm', facts: [
    F('a', { '\\lambda(n),\\mu(n)': 'least and largest binary exponents of n', '\\mathsf{RT}^1': 'the infinite pigeonhole principle', '\\mathrm{Subt}': 'subtraction-like' }),
    F('b', { '$\\mu(x)$, $\\lambda(x)$': 'highest and lowest binary digits', '\\mathsf{RT}^1': 'every finite coloring of N has an infinite homogeneous set', '\\mathrm{Subt}': 'a set closed under differences' }),
    F('c', { '\\mathsf{RT}^1_{<\\infty}': 'RT^1 for all numbers of colors' }), F('d', { '\\mathsf{RT}^1_{<\\infty}': 'the pigeonhole principle for finitely many colors' }),
  ] })).data.created.map((x) => [x.ref, x.id]));
  mu = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mu(n)', meaning_text: 'The largest binary exponent of $n$.' })).data.id;
  await app.call(ann, 'POST', `/api/notation/${mu}/status`, { status: 'agreed' });
});
after(() => app?.stop());

test('a glossary key defining two symbols counts as two, and an agreed symbol is not listed as missing', async () => {
  const s = await shared();
  const of = (sym) => s.find((x) => x.spellings.includes(sym));
  assert.ok(of('\\mu(n)')?.entry, 'mu has its entry');
  assert.ok(of('\\lambda(n)') && !of('\\lambda(n)').entry, 'lambda is its own symbol, without an entry yet');
  assert.ok(!s.some((x) => x.symbol.includes(',')), 'no combined key is left');
});

test('a symbols sweep settles every symbol without an entry: adopt, local, or another spelling', async () => {
  const t = (await claim(['consolidate'])).data.task;
  assert.ok(t); assert.equal(t.source_type, 'sweep'); assert.equal(t.recipe.variant, 'consolidate_notation');
  assert.match(t.recipe.instructions, /Decide every symbol yourself/);
  const syms = t.context.symbols.map((x) => x.symbol).sort();
  assert.deepEqual(syms, ['\\lambda(n)', '\\mathrm{Subt}', '\\mathsf{RT}^1', '\\mathsf{RT}^1_{<\\infty}'].sort());
  assert.ok(t.context.notation.some((n) => n.id === mu), 'with the entries, to attach a spelling to');
  assert.ok(!t.context.fact_texts, 'not the whole database');
  const r = await answer(t, { summary: '', decisions: [
    { symbol: '\\mathsf{RT}^1', action: 'adopt', entry: null, project_symbol: '\\mathsf{RT}^1', meaning: 'Every finite coloring of $\\mathbb{N}$ has an infinite homogeneous set.', note: '', variants: [], fact: ids.a, reason: 'Equivalent wordings of one principle.' },
    { symbol: '\\mathrm{Subt}', action: 'local', entry: null, project_symbol: null, meaning: 'Closed under differences, in this paper.', note: null, variants: [], fact: ids.a, reason: 'One paper\'s name.' },
    { symbol: '\\lambda(n)', action: 'adopt', entry: null, project_symbol: '\\lambda(n)', meaning: 'The least binary exponent of $n$.', note: '', variants: [], fact: ids.a, reason: 'Used beside mu.' },
    { symbol: '\\mathsf{RT}^1_{<\\infty}', action: 'same', entry: mu, project_symbol: null, meaning: 'should not matter', note: null, variants: [], fact: null, reason: 'A wrong attachment the server records as asked.' },
    { symbol: 'not in the batch', action: 'adopt', entry: null, project_symbol: 'X', meaning: 'x', note: '', variants: [], fact: ids.a, reason: 'Ignored.' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.summary_text, /^4 symbols read \(3 settled, 1 recorded as spellings of an entry\)/);
  const entries = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.entries;
  const by = (sym) => entries.find((e) => e.symbol === sym);
  assert.equal(by('\\mathsf{RT}^1').status, 'agreed'); assert.equal(by('\\lambda(n)').status, 'agreed');
  assert.equal(by('\\mathrm{Subt}').status, 'local'); assert.equal(by('\\mathrm{Subt}').definition_fact_id, ids.a, 'a local entry knows its paper');
  assert.ok(by('\\mu(n)').variants.some((v) => v.relation === 'instance'), 'a spelling recorded on the entry');
  assert.equal((await shared()).filter((x) => !x.entry).length, 0, 'nothing left without an entry');
  assert.equal((await claim(['consolidate'])).data.task, null, 'nothing left to settle');
  const cons = (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data;
  assert.equal(cons.suggestions.filter((x) => x.kind === 'notation' && x.auto_applied).length, 3, 'each choice listed under Consolidate, undoable');
  assert.equal(cons.waiting, null, 'the sweep is not shown as a waiting consolidation');
});

test('keeping a paper\'s symbol local never demotes the agreed entry it shares a letter with', async () => {
  const r = await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [
    { kind: 'notation', fact: String(ids.b), reason: 'Feferman\'s functional in this paper.', confidence: 'high', notation: { action: 'local', entry: null, symbol: '\\mu(f)', meaning: 'Feferman\'s search functional applied to $f$.', note: '', variants: [] } },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.applied.length, 1, JSON.stringify(r.data));
  const entries = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.entries;
  assert.equal(entries.find((e) => e.id === mu).status, 'agreed', 'the project\'s mu(n) stays agreed');
  assert.ok(entries.some((e) => e.symbol === '\\mu(f)' && e.status === 'local' && e.definition_fact_id === ids.b), 'a new local entry for its paper');
});
