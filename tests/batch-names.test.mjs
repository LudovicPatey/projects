// New facts sent together name each other by the refs their author gave them ("By lem:full-match-gives-left-match ..."), not
// by the labels the platform gives. In the text, such a name becomes a link to the fact, and a fact the proof names is a
// dependency, even when the author forgot to list it (live fact 1496).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

let app; let ann; let key;
before(async () => {
  app = await startApp(); ann = await app.signIn('0000-0002-1825-0097');
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('a batch\'s refs in a proof become links and dependencies; ordinary words are left alone', async () => {
  const pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Batch names', question_html: '<p>Q</p>' })).data.id;
  const F = (ref, proof, deps = []) => ({ ref, external_id: `oq-t1-${ref}`, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `${ref} holds.`, proof_text: proof, depends_on: deps, tool: 'oq-client' });
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-fable-5-2', facts: [
    F('lem:full-match-gives-left-match', 'Direct.'),
    F('cor:full-matches-compute-zero-jump', 'By lem:full-match-gives-left-match there is a left match, and a lemma about it holds.'),
    F('a', 'Direct.'),
    F('lem:uses-a', 'Take a and b.')] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = Object.fromEntries(r.data.created.map((x) => [x.ref, x.id]));
  const cor = (await app.call(ann, 'GET', `/api/facts/${id['cor:full-matches-compute-zero-jump']}`)).data;
  assert.deepEqual(cor.deps.map((d) => d.id), [id['lem:full-match-gives-left-match']], 'the fact the proof names is a dependency');
  assert.match(cor.proof_html, new RegExp(`data-type="fact" data-id="${id['lem:full-match-gives-left-match']}"`), 'and a link to it');
  assert.doesNotMatch(cor.proof_text, /lem:full-match-gives-left-match/);
  const other = (await app.call(ann, 'GET', `/api/facts/${id['lem:uses-a']}`)).data;
  assert.deepEqual(other.deps, [], 'a short ref such as "a" is a word, not a name');
  assert.equal(other.proof_text, 'Take a and b.');
});

test('a name stored raw (older imports, or a fact named before it was created) links on the page, cut refs included', async () => {
  const pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Raw names', question_html: '<p>Q</p>' })).data.id;
  const F = (ref, proof, ext = `oq-t7-${ref}`) => ({ ref, external_id: ext, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `${ref} holds.`, proof_text: proof, depends_on: [], tool: 'oq-client' });
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-fable-5-2', facts: [
    F('cor:uses-later', 'By lem:full-match-gives-left-match and lem:apart-refinement-with-divisibility it holds.'),
    F('lem:full-match-gives-left-match', 'Direct.'),
    // As a client before 1.22.6 sent it: the ref cut to 32 characters.
    F('lem:apart-refinement-with-divisi', 'Direct.', 'oq-t7-lem:apart-refinement-with-divisi'),
    F('lem:elsewhere', 'Direct.', 'oq-t8-lem:elsewhere')] });
  const id = Object.fromEntries(r.data.created.map((x) => [x.ref, x.id]));
  const f = (await app.call(ann, 'GET', `/api/facts/${id['cor:uses-later']}`)).data;
  const refs = Object.fromEntries(f.text_refs.map((x) => [x.text, x.fact_id]));
  assert.equal(refs['lem:full-match-gives-left-match'], id['lem:full-match-gives-left-match']);
  assert.equal(refs['lem:apart-refinement-with-divisibility'], id['lem:apart-refinement-with-divisi'], 'the full name finds the cut ref');
  const { splitRefs } = await import('../public/assets/js/fact-refs.js');
  const parts = splitRefs('By lem:full-match-gives-left-match and lem:full-match-gives-left-match-two.', f.text_refs);
  assert.deepEqual(parts.filter((p) => typeof p !== 'string').map((p) => p.text), ['lem:full-match-gives-left-match'], 'whole names only');
});
