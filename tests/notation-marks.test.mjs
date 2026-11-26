// Notation marked in the text of a fact, with its meaning on hover.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, test } from 'node:test';
import { factNotation, notationKey, notationMarker, symbolPattern, trustMarks } from '../public/assets/js/notation-marks.js';
import { startApp } from './harness.mjs';

const mark = (entries, math) => notationMarker(entries.map((symbol) => ({ symbol }))).preProcess(math);
let app;
after(() => app?.stop());

test('a name is found in any font, with any argument, and never inside another word', () => {
  assert.equal(mark(['\\mathrm{FIN}'], 'A \\subseteq \\operatorname{FIN}, FIN_k'), 'A \\subseteq \\htmlClass{oq-nt oq-nt-0}{\\operatorname{FIN}}, \\htmlClass{oq-nt oq-nt-0}{FIN}_k');
  assert.equal(mark(['FS(X)'], '\\mathrm{FS}(H) \\cap FS(Y)'), '\\htmlClass{oq-nt oq-nt-0}{\\mathrm{FS}}(H) \\cap \\htmlClass{oq-nt oq-nt-0}{FS}(Y)', 'its argument is a placeholder');
  assert.equal(mark(['\\mathrm{FIN}'], 'FINITE \\finite'), 'FINITE \\finite');
  assert.equal(mark(['\\mathrm{FU}', '\\mathrm{FUT}'], 'FUT \\ne FU'), '\\htmlClass{oq-nt oq-nt-1}{FUT} \\ne \\htmlClass{oq-nt oq-nt-0}{FU}', 'the longest name first');
});

test('one letter is a variable, unless its font makes it a named object', () => {
  assert.equal(symbolPattern('X'), null); assert.equal(symbolPattern('x_n'), null);
  assert.equal(mark(['\\mathbb{N}', 'X'], 'n \\in \\mathbb{N}, N, X'), 'n \\in \\htmlClass{oq-nt oq-nt-0}{\\mathbb{N}}, N, X');
  assert.equal(mark(['\\beta\\mathbb{N}'], 'p \\in \\beta\\mathbb{N}'), 'p \\in \\htmlClass{oq-nt oq-nt-0}{\\beta\\mathbb{N}}');
});

test('text inside a formula, and formulas marked by hand, are left as they are', () => {
  assert.equal(mark(['\\mathrm{FIN}'], '\\text{all FIN sets}'), '\\text{all FIN sets}');
  assert.equal(mark(['\\mathrm{FIN}'], '\\htmlClass{x}{FIN}'), '\\htmlClass{x}{FIN}');
  assert.equal(notationMarker([]).count, 0); assert.equal(notationMarker([]).preProcess('FIN'), 'FIN');
});

test('KaTeX may only add the classes of these marks', () => {
  assert.equal(trustMarks({ command: '\\htmlClass', class: 'oq-nt oq-nt-3' }), true);
  for (const ctx of [{ command: '\\htmlClass', class: 'btn danger' }, { command: '\\href', url: 'javascript:alert(1)' }, { command: '\\htmlData' }]) assert.equal(trustMarks(ctx), false);
});

test('what the fact defines for itself comes first, and replaces the project symbol of the same name', () => {
  assert.equal(notationKey('\\mathrm{FS}(X)'), notationKey('FS(H)'));
  const list = factNotation([['FS(X)', 'finite sums including 0']], [{ id: 1, symbol: '\\mathrm{FS}(X)', meaning_html: '<p>without 0</p>' }, { id: 2, symbol: '\\mathrm{FIN}', meaning_html: '<p>finite sets</p>' }]);
  assert.deepEqual(list.map((e) => [e.symbol, e.source]), [['FS(X)', 'fact'], ['\\mathrm{FIN}', 'project']]);
});

test('a local entry of the fact\'s paper replaces the project symbol of the same name: Kreuzer\'s (\\mu) is not the binary exponent', () => {
  assert.equal(notationKey('(\\mu)'), notationKey('\\mu(n)'), 'an axiom named after its symbol is that symbol');
  const list = factNotation([], [{ id: 1, symbol: '\\mu(n)', meaning_html: 'largest binary exponent' }, { id: 2, symbol: '\\mathrm{FIN}', meaning_html: 'finite sets' }], [{ id: 3, symbol: '(\\mu)', meaning_html: 'Feferman' }]);
  assert.deepEqual(list.map((e) => [e.symbol, e.source]), [['(\\mu)', 'paper'], ['\\mathrm{FIN}', 'project']]);
  const marked = notationMarker(list).preProcess('\\mathsf{ACA}_0+(\\mu)+f(\\mu(f))');
  assert.equal(marked, '\\mathsf{ACA}_0+(\\htmlClass{oq-nt oq-nt-0}{\\mu})+f(\\htmlClass{oq-nt oq-nt-0}{\\mu}(f))', 'every \\mu with the paper\'s meaning');
  const own = factNotation([['\\mu', 'defined here']], [], [{ id: 3, symbol: '(\\mu)', meaning_html: 'Feferman' }]);
  assert.deepEqual(own.map((e) => e.source), ['fact'], 'what the fact defines itself still comes first');
});

test('every text of a fact is marked, and its page receives the agreed notation only', async () => {
  const view = fs.readFileSync('public/assets/js/views/facts.js', 'utf8');
  for (const part of ['shown(statementHtml)', 'shown(proofHtml)', 'shown(p.body_html)', 'shown(content.intuition_html)']) assert.ok(view.includes(`<rich-content :html="${part}" :notation="notationMarks" :fact-refs="fact.text_refs"/>`), part);
  app = await startApp();
  const ann = await app.signIn('0000-0002-1825-0097');
  const pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Marks', question_html: '<p>Q</p>' })).data.id;
  const key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const fid = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [{ ref: 'a', title: 'a', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: '$\\mathrm{FIN}$', proof_text: 'P.' }] })).data.created[0].id;
  const agreed = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{FIN}', meaning_text: 'The nonempty finite subsets of $\\mathbb{N}$.' })).data;
  await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{FU}', meaning_text: 'Finite unions.' });
  assert.equal((await app.call(ann, 'POST', `/api/notation/${agreed.id}/status`, { status: 'agreed' })).status, 200);
  const f = (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;
  assert.deepEqual(f.notation.map((n) => n.symbol), ['\\mathrm{FIN}'], 'a proposal is not marked');
  assert.match(f.notation[0].meaning_html, /nonempty finite subsets/);
});

test('a local entry applies to its defining fact and the facts of the same paper, not to other papers', async () => {
  const ann = await app.signIn('0000-0002-1825-0097');
  const pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Local', question_html: '<p>Q</p>' })).data.id;
  const key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const bib = async (t) => (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: t, author: 'Doe, J.', year: '2020' }, cite_key: t })).data.created[0];
  const kreuzer = await bib('kreuzer'); const carlucci = await bib('carlucci');
  const F = (ref, b) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'extracted', statement_text: `$(\\mu)$ ${ref}.`, proof_text: 'P.', sources: [{ type: 'bib', id: b, quote: ref, covers: 'statement' }] });
  const ids = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'm', facts: [F('def', kreuzer), F('same', kreuzer), F('other', carlucci)] })).data.created.map((x) => [x.ref, x.id]));
  const local = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '(\\mu)', meaning_text: 'Feferman\'s functional exists.', definition_fact_id: ids.def })).data;
  assert.equal((await app.call(ann, 'POST', `/api/notation/${local.id}/status`, { status: 'local' })).status, 200);
  const get = async (k) => (await app.call(ann, 'GET', `/api/facts/${ids[k]}`)).data.local_entries.map((e) => e.symbol);
  assert.deepEqual(await get('def'), ['(\\mu)']); assert.deepEqual(await get('same'), ['(\\mu)']); assert.deepEqual(await get('other'), []);
});
