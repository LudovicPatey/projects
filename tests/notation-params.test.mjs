// A notation entry says which objects it is written with and their type: "Y \leq X" for infinite block sequences applies to those
// only, not to \leq between numbers. The page colors them, gives their type, and says what each choice changes and what it leaves.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { colorParams, inferParams, isFixed, paramsOf, relationPattern, trustParams } from '../public/assets/js/notation-params.js';
import { notationMarker } from '../public/assets/js/notation-marks.js';
import { actionEffects, asMath, colorMath, entryBody, entryScope, parseParams, paramsText, sharedState } from '../public/assets/js/notation-model.js';

test('a symbol in words keeps its words as text, and only its parameters are colored math', () => {
  const X = [{ name: 'X', type: 'sets' }];
  assert.equal(colorMath(asMath('effectively immune relative to X'), X), 'effectively immune relative to ${\\htmlClass{oq-pm oq-pm-0}{X}}$');
  assert.equal(colorMath(asMath('Y \\leq X'), BLOCKS), '$' + colorParams('Y \\leq X', BLOCKS) + '$', 'a formula is colored as before');
  assert.equal(colorMath(asMath('\\mathrm{FIN}'), []), '$\\mathrm{FIN}$');
});

const ANN = '0000-0002-1825-0097';
const BLOCKS = [{ name: 'Y', type: 'infinite block sequences' }, { name: 'X', type: 'infinite block sequences' }];
let app; let ann; let key; let pid;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Params', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('the letters a symbol is written with are its parameters; names and terms in words have none', () => {
  assert.deepEqual(inferParams('Y \\leq X'), ['Y', 'X']);
  assert.deepEqual(inferParams('\\mathrm{FS}(X)'), ['X']);
  assert.deepEqual(inferParams("\\mathcal{D}' \\leq \\mathcal{D}"), ['\\mathcal{D}']);
  for (const s of ['\\mathrm{FIN}', '\\mathcal{U}', '\\mathbb{N}', 'P-condition', 'full-match (HT)', 'apart']) assert.deepEqual(inferParams(s), [], s);
  assert.deepEqual(paramsOf({ symbol: 'Y \\leq X', params: [{ name: 'X', type: 'infinite block sequences' }] }), [{ name: 'Y', type: '' }, { name: 'X', type: 'infinite block sequences' }]);
  assert.equal(colorParams('Y \\leq X', BLOCKS), '{\\htmlClass{oq-pm oq-pm-0}{Y}} \\leq {\\htmlClass{oq-pm oq-pm-1}{X}}');
  assert.ok(trustParams({ command: '\\htmlClass', class: 'oq-pm oq-pm-1' }));
  // A colored index stays one argument of ^ and _, and a letter after a font command without braces is the name.
  assert.equal(colorParams('\\mathsf{RT}^n_k', paramsOf({ symbol: '\\mathsf{RT}^n_k' })), '\\mathsf{RT}^{\\htmlClass{oq-pm oq-pm-0}{n}}_{\\htmlClass{oq-pm oq-pm-1}{k}}');
  assert.deepEqual(inferParams('\\mathsf D^2_2'), []);
  assert.equal(colorParams('\\mathsf D^2_2', [{ name: 'D', type: 'x' }]), '\\mathsf D^2_2');
  assert.ok(!trustParams({ command: '\\htmlClass', class: 'evil' }));
});

test('a relation is marked between objects written with its letters, not between other objects', () => {
  const m = notationMarker([{ symbol: 'Y \\leq X', params: BLOCKS }]);
  for (const t of ['Y \\leq X', 'Y_1 \\le X_0', "X' \\leq X", 'Y\\leq X']) assert.match(m.preProcess(t), /^\\htmlClass\{oq-nt oq-nt-0\}/, t);
  for (const t of ['n \\leq m', 'Yes \\leq X', '(J,Y) \\leq (I,X)']) assert.ok(!m.preProcess(t).includes('oq-nt'), t);
  assert.equal(relationPattern('\\mathrm{FIN}', []), null);
});

test('the page says what an entry applies to, and what each choice changes and leaves', () => {
  const e = { symbol: 'Y \\leq X', status: 'proposed', params: BLOCKS, variants: [{ symbol: '(J,Y) \\leq (I,X)', meaning: 'extension', relation: 'clash' }] };
  assert.equal(entryScope(e).text, 'Only where $Y$ and $X$ are infinite block sequences.');
  const rows = actionEffects(e);
  assert.deepEqual(rows.map((r) => r.action), ['Agree', 'Local', 'Reject', 'Edit']);
  assert.match(rows[0].changes, /between these objects only/);
  assert.match(rows[0].keeps, /same symbol between other objects.*keeps its own meaning/);
  assert.match(rows[0].keeps, /other meaning in sources keeps its symbol/);
  assert.match(rows[2].keeps, /Nothing changes in the facts/);
  const untyped = entryScope({ symbol: 'Y \\leq X' });
  assert.equal(untyped.typed, false); assert.match(untyped.text, /not stated/);
  assert.deepEqual(actionEffects({ ...e, status: 'agreed', decided_by_kind: 'consolidation' }).map((r) => r.action), ['Confirm', 'Edit', 'Reopen']);
  assert.deepEqual(parseParams(paramsText(BLOCKS)), BLOCKS);
  assert.deepEqual(entryBody({ symbol: 'Y \\leq X', meaning: 'm', params: 'Y, X: infinite block sequences' }).params, BLOCKS);
});

test('an entry keeps its parameters; changing their types reopens an agreed entry; an AI fills the types nobody gave', async () => {
  const meaning = '$Y \\subseteq FU(X)$.';
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'Y \\leq X', meaning_text: meaning })).data;
  assert.deepEqual(e.params, [{ name: 'Y', type: '' }, { name: 'X', type: '' }], 'inferred, without a type');
  const ai = await app.call(key, 'POST', `/api/projects/${pid}/notation`, { symbol: 'Y \\leq X', meaning_text: meaning, params: BLOCKS, ai_model: 'claude-opus-5-5' });
  assert.equal(ai.status, 200, JSON.stringify(ai.data)); assert.equal(ai.data.params_added, true);
  assert.deepEqual(ai.data.params, BLOCKS);
  assert.equal((await app.call(key, 'POST', `/api/projects/${pid}/notation`, { symbol: 'Y \\leq X', meaning_text: meaning, params: [{ name: 'X', type: 'sets' }], ai_model: 'm' })).status, 409, 'never replaces given types');
  await app.call(ann, 'POST', `/api/notation/${e.id}/status`, { status: 'agreed' });
  const fact = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'm', facts: [{ ref: 'f', title: 'f', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: '$Y \\leq X$.', proof_text: 'P.' }] })).data.created[0].id;
  assert.deepEqual((await app.call(ann, 'GET', `/api/facts/${fact}`)).data.notation.find((n) => n.id === e.id).params, BLOCKS, 'a fact page gets the types');
  const same = await app.call(ann, 'PATCH', `/api/notation/${e.id}`, { params: BLOCKS });
  assert.equal(same.data.status, 'agreed', 'the same types: still agreed');
  const other = await app.call(ann, 'PATCH', `/api/notation/${e.id}`, { params: [{ name: 'X', type: 'sets' }, { name: 'Y', type: 'sets' }] });
  assert.equal(other.data.status, 'proposed', 'other types: what it applies to changed');
});

test('a letter under a relation, or typed "not a parameter", names the symbol and stands for nothing', async () => {
  for (const s of ['\\le_c', '\\le_W', '\\le_{sW}', '\\equiv_T', '\\leq^{\\mathrm{u}}_c']) assert.deepEqual(inferParams(s), [], s);
  assert.deepEqual(inferParams('\\mathsf P \\le_c \\mathsf Q'), [], 'P and Q in \\mathsf without braces are names');
  assert.deepEqual(inferParams('P \\le_W Q'), ['P', 'Q']);
  assert.equal(colorParams('P \\le_W Q', paramsOf({ symbol: 'P \\le_W Q' })), '{\\htmlClass{oq-pm oq-pm-0}{P}} \\le_W {\\htmlClass{oq-pm oq-pm-1}{Q}}');
  assert.deepEqual(inferParams('\\mathsf{RT}^n_k'), ['n', 'k'], 'the exponents of a name stay parameters');
  assert.ok(isFixed('fixed subscript, not a variable: $\\le_c$ relates two problems')); assert.ok(isFixed('not a parameter')); assert.ok(!isFixed('natural numbers'));
  const typed = [{ name: 'c', type: 'fixed subscript, not a variable' }, { name: 'X', type: 'sets' }];
  assert.deepEqual(paramsOf({ symbol: 'c(X)', params: typed }), [{ name: 'X', type: 'sets' }]);
  assert.equal(paramsText([{ name: 'X', type: 'sets' }], ['c']), 'X: sets\nc: not a parameter', 'the form keeps the mark');
  // On the server: stored entries typed this way lose the letter at once, and the form gets it back as "not a parameter".
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'c(X)', meaning_text: 'The c-hull of X.', params: typed })).data;
  assert.deepEqual(e.params, [{ name: 'X', type: 'sets' }]); assert.deepEqual(e.fixed, ['c']);
  assert.deepEqual((await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'P \\le_W Q', meaning_text: 'Weihrauch reducibility.' })).data.params.map((p) => p.name), ['P', 'Q']);
  assert.match(fs.readFileSync('src/Procedures.php', 'utf8'), /gets the type "not a parameter"/);
});

test('a symbol defined in several facts says when the AI compares and settles it', async () => {
  assert.equal(sharedState({ sweep: 'next', meanings: [1, 2] }), 'The AI compares its wordings and settles it in the next symbols sweep, once nobody has added facts for a while.');
  assert.match(sharedState({ sweep: 'later', meanings: [1] }), /^The AI settles it in a later symbols sweep/);
  assert.match(sharedState({ sweep: 'reading', meanings: [1] }), /now/);
  assert.match(sharedState({ sweep: 'left', meanings: [1] }), /waits for a member/);
  assert.equal(sharedState({ sweep: null, entry: { status: 'agreed' } }), '');
  const p2 = (await app.call(ann, 'POST', '/api/projects', { title: 'Shared', question_html: '<p>Q</p>' })).data.id;
  const fact = (ref, m) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'Every $\\mathrm{SG}$ works.', proof_text: 'P.', glossary: { '\\mathrm{SG}': m } });
  await app.call(key, 'POST', `/api/projects/${p2}/facts/batch`, { format: 'native', ai_model: 'm', facts: [fact('a', 'a semigroup'), fact('b', 'a closed semigroup')] });
  const s = (await app.call(ann, 'GET', `/api/projects/${p2}/notation`)).data.shared.find((x) => x.symbol === '\\mathrm{SG}');
  assert.equal(s?.sweep, 'next', JSON.stringify(s));
  assert.doesNotMatch(fs.readFileSync('public/assets/js/views/notation.js', 'utf8'), /not compared yet/);
});

test('the AI recipes ask for the types, and a rewrite keeps a symbol between objects of another type', async () => {
  const src = fs.readFileSync('src/Procedures.php', 'utf8');
  assert.match(src, /'notation_propose' => \[.*'params'/);
  assert.match(src, /'consolidate_notation' => \[.*'params'/);
  assert.match(src, /same symbol between objects of another type/);
});

test('a glossary key with LaTeX thin spaces is one symbol, and the pieces cut before are repaired', async () => {
  const ids = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'm', facts: ['a', 'b'].map((ref) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.', glossary: { 'X\\,\\tilde\\in\\,U': 'there is a finite F with U_F \\subseteq X' } })) })).data.created;
  assert.equal(ids.length, 2);
  const shared = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.shared;
  assert.ok(shared.some((s) => s.symbol === 'X\\,\\tilde\\in\\,U'), 'one symbol');
  assert.ok(!shared.some((s) => /\\$/.test(s.symbol)), 'no piece ending with a backslash');
  // Pieces stored before the fix: an entry, and a spelling of another entry.
  const broken = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '(I,X)\\', meaning_text: 'a piece' })).data.id;
  const good = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'X\\,\\tilde\\in\\,U', meaning_text: 'whole', variants: [{ symbol: 'X\\', meaning: 'piece', where: 'w', relation: 'instance' }, { symbol: 'X\\,\\tilde\\in\\,V', meaning: 'kept', where: 'w', relation: 'instance' }] })).data.id;
  execFileSync('php', ['bin/install.php'], { cwd: app.dir });
  const entries = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.entries;
  assert.ok(!entries.some((x) => x.id === broken), 'the broken entry is gone');
  assert.deepEqual(entries.find((x) => x.id === good).variants.map((v) => v.symbol), ['X\\,\\tilde\\in\\,V']);
});

test('the wordings of a symbol show in groups of equivalent ones, with the entry each one is', async () => {
  const { wordingGroups } = await import('../public/assets/js/notation-model.js');
  const m = (t) => ({ meaning: t, facts: [1] });
  const meanings = [m('a code'), m('the code, unfolded'), m('an algebraic semigroup'), m('a new wording')];
  assert.equal(wordingGroups({ meanings }).summary, '4 wordings, not compared yet');
  assert.equal(wordingGroups({ meanings: [m('x')] }).summary, '');
  const s = { meanings, entry: null, unclassified: [3], classes: [
    { label: 'Hirst\'s code', decided: true, meanings: [0, 1], entry: { id: 7, symbol: 'semigroup (\\beta\\mathbb N)', status: 'agreed' } },
    { label: 'algebraic', decided: false, meanings: [2], entry: null }] };
  const v = wordingGroups(s);
  assert.equal(v.summary, '4 wordings, 2 different meanings, 1 not compared yet');
  assert.deepEqual(v.blocks.map((b) => [b.title, b.items.length, b.entry?.word || null]), [['Meaning 1', 2, 'agreed'], ['Meaning 2', 1, null], ['Not compared yet', 1, null]]);
  assert.equal(wordingGroups({ meanings: meanings.slice(0, 2), unclassified: [], classes: [{ label: 'one', meanings: [0, 1], entry: null, decided: true }], entry: { id: 3, symbol: 'x', status: 'agreed' } }).summary, '2 wordings, all equivalent');
});
