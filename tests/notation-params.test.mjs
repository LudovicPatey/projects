// A notation entry says which objects it is written with and their type: "Y \leq X" for infinite block sequences applies to those
// only, not to \leq between numbers. The page colors them, gives their type, and says what each choice changes and what it leaves.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { colorParams, inferParams, paramsOf, relationPattern, trustParams } from '../public/assets/js/notation-params.js';
import { notationMarker } from '../public/assets/js/notation-marks.js';
import { actionEffects, entryBody, entryScope, parseParams, paramsText } from '../public/assets/js/notation-model.js';

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
