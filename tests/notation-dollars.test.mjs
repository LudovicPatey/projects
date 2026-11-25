// Facts write the symbols they define as formulas, $FS(H)$; project entries without dollars, FS(X). They are the same symbol.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Dollars', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const F = (ref, glossary) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.', glossary });
  await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    F('a', { '$FS(H)$': 'the finite sums of H', '$x_n$': 'the n-th term' }), F('b', { '$\\mathrm{FS}(X)$': 'the finite sums of X', '$x_n$': 'a term' }), F('c', { 'FS(S)': 'the finite sums of S' }),
  ] });
  await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'FS(X)', meaning_text: 'The non-empty finite sums of $X$.' });
});
after(() => app?.stop());

test('a symbol written with dollars in a fact is the project entry of the same symbol, and a variable stays out', async () => {
  const shared = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.shared;
  assert.equal(shared.length, 1, JSON.stringify(shared));
  assert.equal(shared[0].facts, 3); assert.ok(shared[0].entry, 'it has its project entry');
  assert.ok(shared[0].spellings.every((s) => !s.includes('$')), 'spellings without dollars');
  assert.ok(!shared.some((s) => s.symbol === 'x_n'), 'a proof variable is not notation');
});
