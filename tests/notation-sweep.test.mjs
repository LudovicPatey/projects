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
  assert.match(t.recipe.instructions, /Decide every symbol\s+yourself/);
  const syms = t.context.symbols.map((x) => x.symbol).sort();
  assert.deepEqual(syms, ['\\lambda(n)', '\\mathrm{Subt}', '\\mathsf{RT}^1', '\\mathsf{RT}^1_{<\\infty}'].sort());
  assert.ok(t.context.notation.some((n) => n.id === mu), 'with the entries, to attach a spelling to');
  assert.ok(!t.context.fact_texts, 'not the whole database');
  const r = await answer(t, { summary: '', types: [], decisions: [
    { symbol: '\\mathsf{RT}^1', action: 'adopt', entry: null, project_symbol: '\\mathsf{RT}^1', meaning: 'Every finite coloring of $\\mathbb{N}$ has an infinite homogeneous set.', note: '', variants: [], params: [], fact: ids.a, reason: 'Equivalent wordings of one principle.' },
    { symbol: '\\mathrm{Subt}', action: 'local', entry: null, project_symbol: null, meaning: 'Closed under differences, in this paper.', note: null, variants: [], params: [], fact: ids.a, reason: 'One paper\'s name.' },
    { symbol: '\\lambda(n)', action: 'adopt', entry: null, project_symbol: '\\lambda(n)', meaning: 'The least binary exponent of $n$.', note: '', variants: [], params: [], fact: ids.a, reason: 'Used beside mu.' },
    { symbol: '\\mathsf{RT}^1_{<\\infty}', action: 'same', entry: mu, project_symbol: null, meaning: 'should not matter', note: null, variants: [], params: [], fact: null, reason: 'A wrong attachment the server records as asked.' },
    { symbol: 'not in the batch', action: 'adopt', entry: null, project_symbol: 'X', meaning: 'x', note: '', variants: [], params: [], fact: ids.a, reason: 'Ignored.' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.summary_text, /^4 symbols read \(3 settled, 1 recorded as spellings of an entry\)/);
  const entries = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.entries;
  const by = (sym) => entries.find((e) => e.symbol === sym);
  assert.equal(by('\\mathsf{RT}^1').status, 'agreed'); assert.equal(by('\\lambda(n)').status, 'agreed');
  assert.equal(by('\\mathrm{Subt}').status, 'local'); assert.equal(by('\\mathrm{Subt}').definition_fact_id, ids.a, 'a local entry knows its paper');
  assert.ok(by('\\mu(n)').variants.some((v) => v.relation === 'instance'), 'a spelling recorded on the entry');
  assert.equal((await shared()).filter((x) => !x.entry).length, 0, 'nothing left without an entry');
  // The entries it adopted are written with a parameter nobody typed: the next sweep says what it stands for.
  const typing = (await claim(['consolidate'])).data.task;
  assert.ok(typing, 'a sweep for the types'); assert.equal(typing.context.symbols.length, 0);
  const lam = typing.context.entries_to_type.find((x) => x.symbol === '\\lambda(n)');
  assert.deepEqual(lam.params, ['n']);
  const tr = await answer(typing, { summary: '', decisions: [], types: [{ entry: lam.id, params: [{ name: 'n', type: 'positive integers' }, { name: 'zz', type: 'ignored: not a parameter' }] }, { entry: 999999, params: [{ name: 'n', type: 'x' }] }] });
  assert.equal(tr.status, 200, JSON.stringify(tr.data)); assert.match(tr.data.summary_text, /1 entry typed/);
  const lamEntry = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.entries.find((x) => x.id === lam.id);
  assert.deepEqual(lamEntry.params, [{ name: 'n', type: 'positive integers' }]);
  assert.equal(lamEntry.status, 'agreed', 'typing changes nothing else');
  assert.equal((await claim(['consolidate'])).data.task, null, 'nothing left to settle: an entry read once is not read again');
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

test('the sweep also settles proposed entries by their id, keeps the facts\' spelling, and reads a symbol it left once more', async () => {
  const p = (await app.call(ann, 'POST', '/api/projects', { title: 'Symbols 2', question_html: '<p>Q</p>' })).data.id;
  const F = (ref, glossary) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.', glossary });
  const f = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'm', facts: [
    F('a', { semigroup: 'Hirst\'s code for a closed subsemigroup', 'P-branch, P-condition, $\\le$': 'forcing notions', fip: 'finite intersection property' }),
    F('b', { semigroup: 'a closed subsemigroup of beta N, coded', 'P-branch, P-condition, $\\le$': 'as in Section 2', fip: 'the finite intersection property' }),
  ] })).data.created.map((x) => [x.ref, x.id]));
  const prop = (await app.call(ann, 'POST', `/api/projects/${p}/notation`, { symbol: 'fip', meaning_text: 'The finite intersection property.' })).data.id;
  const claimP = () => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: p, kinds: ['consolidate'], features: ['procedures', 'consolidate'], capabilities: [] });
  let t = (await claimP()).data.task;
  const syms = t.context.symbols.map((x) => x.symbol);
  assert.ok(['P-branch', 'P-condition'].every((x) => syms.includes(x)) && !syms.some((x) => x.includes(',') || x.includes('$')), `one-word names are split: ${syms}`);
  assert.equal(t.context.symbols.find((x) => x.symbol === 'fip').entry.id, prop, 'a proposed entry comes with its symbol');
  const r = await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', answer: { summary: '', types: [], decisions: [
    { symbol: 'fip', action: 'adopt', entry: prop, project_symbol: null, meaning: null, note: null, variants: [], params: [], fact: null, reason: 'Standard.' },
    { symbol: 'semigroup', action: 'adopt', entry: null, project_symbol: 'semigroup (\\beta\\mathbb N)', meaning: 'Hirst\'s code for a closed subsemigroup of $\\beta\\mathbb N$.', note: '', variants: [], params: [], fact: f.a, reason: 'One notion.' },
  ] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const n = (await app.call(ann, 'GET', `/api/projects/${p}/notation`)).data;
  assert.equal(n.entries.find((e) => e.id === prop).status, 'agreed', 'the proposed entry is settled');
  assert.ok(n.shared.find((x) => x.symbol === 'semigroup').entry, 'the facts\' spelling counts as the adopted entry');
  t = (await claimP()).data.task;
  assert.ok(t.context.symbols.some((x) => x.symbol === 'P-branch'), 'a symbol left once is read once more');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', answer: { summary: '', types: [], decisions: [] } });
  assert.equal((await claimP()).data.task, null, 'but not a third time');
});

test('an expression in agreed symbols needs no entry, an indexed one does, and the sweep rejects a proposed composition', async () => {
  const p = (await app.call(ann, 'POST', '/api/projects', { title: 'Symbols 3', question_html: '<p>Q</p>' })).data.id;
  const F = (ref, glossary) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.', glossary });
  const f = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'm', facts: [
    F('a', { '\\mathrm{FIN}\\cup\\{\\emptyset\\}': 'all finite sets', '\\mathrm{FIN}_k': 'Gowers\' FIN_k', '\\mathcal P_{fin}(\\mathbb N)': 'all finite sets' }),
    F('b', { '\\mathrm{FIN}\\cup\\{\\emptyset\\}': 'finite sets, empty included', '\\mathrm{FIN}_k': 'functions to k', '\\mathcal P_{fin}(\\mathbb N)': 'finite subsets' }),
  ] })).data.created.map((x) => [x.ref, x.id]));
  const fin = (await app.call(ann, 'POST', `/api/projects/${p}/notation`, { symbol: '\\mathrm{FIN}', meaning_text: 'The non-empty finite subsets of $\\mathbb N$.' })).data.id;
  await app.call(ann, 'POST', `/api/notation/${fin}/status`, { status: 'agreed' });
  const prop = (await app.call(ann, 'POST', `/api/projects/${p}/notation`, { symbol: '\\mathcal P_{fin}(\\mathbb N)', meaning_text: 'All finite subsets.' })).data.id;
  const s = (await app.call(ann, 'GET', `/api/projects/${p}/notation`)).data.shared;
  assert.equal(s.find((x) => x.symbol === '\\mathrm{FIN}\\cup\\{\\emptyset\\}').entry.status, 'derived', 'needs no entry');
  assert.equal(s.find((x) => x.symbol === '\\mathrm{FIN}_k').entry, null, 'an indexed symbol is a notion of its own');
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: p, kinds: ['consolidate'], features: ['procedures', 'consolidate'], capabilities: [] })).data.task;
  const syms = t.context.symbols.map((x) => x.symbol);
  assert.ok(!syms.includes('\\mathrm{FIN}\\cup\\{\\emptyset\\}') && syms.includes('\\mathrm{FIN}_k'), `${syms}`);
  assert.match(t.recipe.instructions, /never adopt or keep local a mere combination/);
  const r = await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', answer: { summary: '', types: [], decisions: [
    { symbol: '\\mathcal P_{fin}(\\mathbb N)', action: 'reject', entry: prop, project_symbol: null, meaning: null, note: null, variants: [], params: [], fact: f.a, reason: 'FIN together with the empty set.' },
    { symbol: '\\mathrm{FIN}_k', action: 'reject', entry: null, project_symbol: null, meaning: null, note: null, variants: [], params: [], fact: f.a, reason: 'Ignored: no entry to reject.' },
  ] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await app.call(ann, 'GET', `/api/projects/${p}/notation`)).data.entries.find((e) => e.id === prop).status, 'rejected');
});

test('the sweep groups the wordings of a symbol into equivalent ones, each pointing at its entry, and a renamed entry takes the facts\' word', async () => {
  const p = (await app.call(ann, 'POST', '/api/projects', { title: 'Wordings', question_html: '<p>Q</p>' })).data.id;
  const F = (ref, glossary) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.', glossary });
  await app.call(key, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'm', facts: [
    F('a', { semigroup: 'a sequence $U$ with fip such that every $X\\in U$ satisfies $X\\,\\tilde\\in\\,U+U$' }),
    F('b', { semigroup: '$U$ satisfies fip and every $X\\in U$ has $Y\\,\\tilde\\in\\,U$ with $X-n\\,\\tilde\\in\\,U$ for all $n\\in Y$' }),
    F('c', { semigroup: 'a set with an associative operation' }),
  ] });
  // Agreed before, under another spelling, with the algebraic word as a clash: what the consolidation did on the live project.
  const sg = (await app.call(ann, 'POST', `/api/projects/${p}/notation`, { symbol: 'semigroup (\\beta\\mathbb N)', meaning_text: 'Hirst\'s code for a closed subsemigroup.',
    variants: [{ symbol: 'semigroup', meaning: 'an algebraic semigroup', where: 'Kreuzer', relation: 'clash' }] })).data.id;
  await app.call(ann, 'POST', `/api/notation/${sg}/status`, { status: 'agreed' });
  const row = async () => (await app.call(ann, 'GET', `/api/projects/${p}/notation`)).data.shared.find((x) => x.symbol === 'semigroup');
  const before = await row();
  assert.equal(before.entry, null); assert.deepEqual(before.classes, []); assert.deepEqual(before.unclassified, [0, 1, 2], 'not compared yet');
  const claimP = () => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: p, kinds: ['consolidate'], features: ['procedures', 'consolidate'], capabilities: [] });
  const t = (await claimP()).data.task;
  assert.match(t.recipe.instructions, /"classes" of mathematically equivalent wordings/);
  const shown = t.context.symbols.find((x) => x.symbol === 'semigroup').meanings;
  assert.deepEqual(shown.map((m) => m.no), [1, 2, 3], 'each wording comes with its number');
  const no = (re) => shown.find((m) => re.test(m.meaning)).no;
  // Two facts added before the answer, with one new wording: it now comes first in the list, and must not shift the numbers.
  await app.call(key, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'm', facts: [F('d', { semigroup: 'a monoid without unit' }), F('e', { semigroup: 'a monoid without unit' })] });
  const r = await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', answer: { summary: '', types: [], decisions: [
    { symbol: 'semigroup', action: 'same', entry: sg, project_symbol: null, meaning: 'Hirst\'s code', note: null, variants: [], params: [], fact: null, reason: 'The project writes it semigroup (βN).',
      classes: [{ meanings: [no(/U\+U/), no(/X-n/)], label: 'Hirst\'s code for a closed subsemigroup of $\\beta\\mathbb N$', entry: null, decided: true },
        { meanings: [no(/associative/)], label: 'an algebraic semigroup', entry: null, decided: false }] },
  ] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = await row();
  assert.equal(after.classes.length, 2);
  assert.deepEqual(after.unclassified.map((i) => after.meanings[i].meaning), ['a monoid without unit'], 'the wording added since is not compared yet');
  assert.deepEqual(after.classes[0].meanings.map((i) => after.meanings[i].meaning).sort(), shown.filter((m) => /U\+U|X-n/.test(m.meaning)).map((m) => m.meaning).sort(), 'the numbers named the wordings the AI saw');
  assert.equal(after.classes[0].entry.id, sg, 'the decided group is the entry the decision named');
  assert.equal(after.classes[0].meanings.length, 2); assert.equal(after.classes[1].entry, null);
  assert.equal(after.entry?.id, sg, 'the facts\' word is linked to the renamed entry, beside its clash');
  const variants = (await app.call(ann, 'GET', `/api/projects/${p}/notation`)).data.entries.find((e) => e.id === sg).variants;
  assert.deepEqual(variants.map((v) => v.relation).sort(), ['clash', 'instance']);
});
