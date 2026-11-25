// The consolidation applies on its own what it is highly confident about, keeps the rest for people, and every change can be undone.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
let app; let ann; let bob; let key; let pid; let id;

const fact = async (fid) => (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;
const live = async () => Object.fromEntries((await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.map((f) => [f.id, f]));
const propose = async (x) => (await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ reason: 'Because.', ...x }] })).data;
const suggestion = async (sid) => (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data.suggestions.find((s) => s.id === sid);

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Undo', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB, role: 'member' });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const F = (ref, extra) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `Proof of ${ref}.`, ...extra });
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    F('base'), F('keep', { depends_on: ['base'] }), F('dup', { depends_on: ['base'] }), F('user', { depends_on: ['dup'] }), F('other'), F('third'),
  ] })).data.created;
  id = Object.fromEntries(made.map((x) => [x.ref, x.id]));
  await app.call(bob, 'POST', `/api/facts/${id.dup}/star`, {});
  await app.call(ann, 'POST', `/api/facts/${id.dup}/topics`, { topics: ['Dup tag'] });
});
after(() => app?.stop());

test('a change of high confidence is applied at once; the others, and open questions, wait for people', async () => {
  const r = await propose({ kind: 'same', fact: id.keep, other_fact: id.dup, confidence: 'high' });
  assert.equal(r.applied.length, 1);
  const s = await suggestion(r.created[0]);
  assert.equal(s.status, 'accepted'); assert.equal(s.auto_applied, true); assert.equal(s.confidence, 'high'); assert.equal(s.can_undo, true);
  const f = await live();
  assert.equal(f[id.dup], undefined, 'merged'); assert.deepEqual(f[id.user].deps, [id.keep]);
  assert.equal((await propose({ kind: 'depends', fact: id.other, other_fact: id.base, confidence: 'medium' })).applied.length, 0);
  assert.equal((await propose({ kind: 'question', fact: id.third, title: 'Open?', confidence: 'high' })).applied.length, 0, 'an open question is for people');
  assert.equal((await propose({ kind: 'depends', fact: id.other, other_fact: id.third, reason: 'x' })).applied.length, 0, 'no confidence given: an older client');
});

test('the merge is in the history of the kept fact, and unmerging gives everything back', async () => {
  const k = await fact(id.keep);
  const h = k.history.find((x) => x.kind === 'same');
  assert.equal(h.other_label, (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data.facts[id.dup].label); assert.equal(h.auto_applied, true); assert.equal(h.can_undo, true);
  assert.equal(k.proofs.length, 1, 'the duplicate\'s proof became another proof'); assert.deepEqual(k.topics, ['Dup tag']); assert.equal(k.stars, 1);
  assert.equal((await app.call(key, 'POST', `/api/fact-suggestions/${h.id}/undo`, {})).status, 403, 'people undo');
  const r = await app.call(bob, 'POST', `/api/fact-suggestions/${h.id}/undo`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.unmerged, id.dup);
  const f = await live();
  assert.ok(f[id.dup], 'the duplicate is back'); assert.deepEqual(f[id.dup].deps, [id.base]); assert.deepEqual(f[id.user].deps, [id.dup]);
  assert.equal(f[id.dup].stars, 1); assert.deepEqual(f[id.dup].topics, ['Dup tag']);
  const k2 = await fact(id.keep);
  assert.equal(k2.proofs.length, 0); assert.deepEqual(k2.topics, []); assert.equal(k2.stars, 0);
  assert.equal(k2.history.find((x) => x.id === h.id).status, 'undone');
  assert.equal((await app.call(bob, 'POST', `/api/fact-suggestions/${h.id}/undo`, {})).status, 409, 'once');
  assert.equal((await propose({ kind: 'same', fact: id.keep, other_fact: id.dup, confidence: 'high' })).skipped[0].reason, 'People undid this change.');
});

test('a merge a person accepted is undone by an owner', async () => {
  const sid = (await propose({ kind: 'same', fact: id.other, other_fact: id.third, confidence: 'low' })).created[0];
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${sid}/accept`, {})).status, 200);
  assert.equal((await app.call(bob, 'POST', `/api/fact-suggestions/${sid}/undo`, {})).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${sid}/undo`, {})).status, 200);
  assert.ok((await live())[id.third]);
});

test('a dependency, a kind and subject tags are undone too', async () => {
  const d = (await propose({ kind: 'depends', fact: id.third, other_fact: id.keep, confidence: 'high' })).created[0];
  const k = (await propose({ kind: 'kind', fact: id.third, new_kind: 'theorem', confidence: 'high' })).created[0];
  const t = (await propose({ kind: 'topics', fact: id.third, topics: ['Auto tag'], confidence: 'high' })).created[0];
  let f = (await live())[id.third];
  assert.deepEqual(f.deps, [id.keep]); assert.equal(f.kind, 'theorem'); assert.deepEqual(f.topics, ['Auto tag']);
  await app.call(ann, 'POST', `/api/facts/${id.third}/topics`, { topics: ['Auto tag', 'Mine'] });
  for (const sid of [d, k, t]) assert.equal((await app.call(bob, 'POST', `/api/fact-suggestions/${sid}/undo`, {})).status, 200);
  f = (await live())[id.third];
  assert.deepEqual(f.deps, []); assert.equal(f.kind, 'lemma'); assert.deepEqual(f.topics, ['Mine'], 'a tag a person added stays');
});

test('a high-confidence change that cannot be applied waits for people, and the others still apply', async () => {
  const r = await propose({ kind: 'depends', fact: id.base, other_fact: id.keep, confidence: 'high' });
  assert.equal(r.applied.length, 0, 'it would make a cycle'); assert.equal((await suggestion(r.created[0])).status, 'proposed');
});

test('an owner turns automatic changes off, and they wait for people', async () => {
  assert.equal((await app.call(bob, 'POST', `/api/projects/${pid}/consolidation/settings`, { auto: false })).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/consolidation/settings`, { auto: false })).status, 200);
  assert.equal((await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data.auto, false);
  assert.equal((await propose({ kind: 'topics', fact: id.other, topics: ['Off'], confidence: 'high' })).applied.length, 0);
  await app.call(ann, 'POST', `/api/projects/${pid}/consolidation/settings`, { auto: true });
});

test('a cited result written by an automatic change goes when it is undone', async () => {
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    { ref: 'ext', title: 'ext', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'By Milliken.', external_refs: [{ key: 'm75', title: 'Milliken' }] }] })).data.created[0].id;
  const ref = (await fact(made)).outside_refs[0].key;
  const r = await propose({ kind: 'cite', fact: made, ref, title: 'Milliken\'s theorem', statement: 'Every coloring...', new_kind: 'theorem', confidence: 'high' });
  assert.equal(r.applied.length, 1);
  const cited = (await fact(made)).deps[0].id;
  assert.equal((await fact(made)).incomplete, false);
  assert.equal((await app.call(bob, 'POST', `/api/fact-suggestions/${r.created[0]}/undo`, {})).status, 200);
  const f = await live();
  assert.equal(f[cited], undefined, 'the cited result it wrote is gone'); assert.equal(f[made].incomplete, true); assert.deepEqual(f[made].deps, []);
});

test('the history of a fact says each change from its point of view, and the panel lists what the AI applied', async () => {
  const { autoApplied, historyText, undoLabel } = await import('../public/assets/js/consolidation-model.js');
  const h = { kind: 'same', fact_id: 1, other_fact_id: 2, fact_label: 'thm:a', other_label: 'thm:b' };
  assert.equal(historyText(h, 1), 'thm:b was merged into this fact'); assert.equal(historyText(h, 2), 'Merged into thm:a');
  assert.equal(historyText({ kind: 'depends', fact_id: 1, other_label: 'b', fact_label: 'a' }, 1), 'Now relies on b');
  assert.equal(historyText({ kind: 'cite', fact_id: 1, other_label: null, data: { ref_label: 'Milliken 1975', title: 'Milliken\'s theorem' } }, 1), 'Milliken 1975 linked to the new cited result “Milliken\'s theorem”');
  assert.equal(undoLabel(h), 'Unmerge'); assert.equal(undoLabel({ kind: 'topics' }), 'Undo');
  assert.deepEqual(autoApplied([{ id: 1, auto_applied: true, status: 'accepted' }, { id: 2, auto_applied: true, status: 'undone' }, { id: 3, auto_applied: false, status: 'accepted' }]).map((s) => s.id), [1]);
});
