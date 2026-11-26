// A proof names other facts the way its paper does, "Lemma 2.4": the fact page links each name it can resolve, with a preview.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { splitRefs } from '../public/assets/js/fact-refs.js';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid; let bib; let other; let id;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Refs', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'A paper', author: 'Doe, J.', year: '2020' }, cite_key: 'doe20' })).data.created[0];
  other = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'Another paper', author: 'Roe, R.', year: '2021' }, cite_key: 'roe21' })).data.created[0];
  const src = (b, quote) => [{ type: 'bib', id: b, quote, covers: 'statement' }];
  const F = (ref, kind, extra = {}) => ({ ref, external_id: ref, title: ref, kind, labels: ['conclusion'], method: 'extracted', statement_text: `S ${ref}.`, proof_text: 'P.', sources: src(bib, `Statement of ${ref}`), ...extra });
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: [
    F('oq-t1-lem-2.4', 'lemma'),
    F('oq-t1-thm-3', 'theorem'),
    F('dup-a', 'lemma', { title: 'Lemma 5.1 (first reading)' }), F('dup-b', 'lemma', { title: 'Lemma 5.1 (second reading)' }),
    F('elsewhere', 'proposition', { title: 'Proposition 7', sources: src(other, 'Proposition 7') }),
    F('main', 'theorem', { depends_on: ['oq-t1-lem-2.4'], proof_text: 'Apply Lemma 2.4, then Theorem 3 and Lemma 5.1. Proposition 7 is elsewhere, and Lemma 9 does not exist. In $Lemma 2.4$ no link.' }),
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  id = Object.fromEntries(r.data.created.map((x) => [x.ref, x.id]));
});
after(() => app?.stop());

test('a name resolves to the one fact of that kind and number, among dependencies and then the same source', async () => {
  const f = (await app.call(ann, 'GET', `/api/facts/${id.main}`)).data;
  const refs = Object.fromEntries(f.text_refs.map((x) => [x.text, x.fact_id]));
  assert.equal(refs['Lemma 2.4'], id['oq-t1-lem-2.4'], 'a dependency, by its extraction id');
  assert.equal(refs['Theorem 3'], id['oq-t1-thm-3'], 'a fact of the same paper');
  assert.ok(!('Lemma 5.1' in refs), 'two facts carry this number: no link rather than a wrong one');
  assert.ok(!('Proposition 7' in refs), 'a fact of another paper is not this paper\'s Proposition 7');
  assert.ok(!('Lemma 9' in refs));
  const lemma = f.text_refs.find((x) => x.text === 'Lemma 2.4');
  assert.equal(lemma.fact.kind, 'lemma'); assert.ok(lemma.fact.label, 'with what the preview needs');
  const plain = (await app.call(ann, 'GET', `/api/facts/${id['oq-t1-thm-3']}`)).data;
  assert.deepEqual(plain.text_refs, [], 'a text naming nothing');
});

test('the page cuts the text around the resolved names only', () => {
  const refs = [{ text: 'Lemma 2.4', fact_id: 5 }, { text: 'Theorem 3', fact_id: 6 }];
  const parts = splitRefs('By Lemma 2.4 and Theorem~3, not Lemma 9 nor Lemma 2.45.', refs);
  assert.deepEqual(parts.filter((p) => typeof p !== 'string').map((p) => [p.text, p.ref.fact_id]), [['Lemma 2.4', 5], ['Theorem~3', 6]]);
  assert.equal(parts.map((p) => (typeof p === 'string' ? p : p.text)).join(''), 'By Lemma 2.4 and Theorem~3, not Lemma 9 nor Lemma 2.45.');
  assert.deepEqual(splitRefs('Nothing here.', refs), ['Nothing here.']);
});
