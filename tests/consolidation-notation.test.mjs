// The consolidation normalizes the project's notation on its own: it adopts, keeps local or sets aside entries, the facts are
// rewritten in it, and every choice can be undone. What a person decided, it leaves.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
let app; let ann; let bob; let key; let pid; let id;

const propose = async (notation, extra = {}) => (await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ kind: 'notation', fact: id.a, reason: 'Sources differ.', confidence: 'high', notation, ...extra }] })).data;
const entries = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data;
const entry = async (symbol) => (await entries()).entries.find((e) => e.symbol === symbol);
const queued = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.filter((t) => t.kind === 'notation' && ['pending', 'running'].includes(t.status)).length;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Notation', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB, role: 'member' });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const F = (ref, glossary) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `$\\mathrm{FS}(X)$ is large, ${ref}.`, proof_text: 'Clear.', glossary });
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    F('a', { '\\mathrm{FS}(X)': 'the finite sums of X, with 0' }), F('b', { '\\mathrm{FS}(H)': 'the non-empty finite sums of H' }), F('c'),
  ] })).data.created;
  id = Object.fromEntries(made.map((x) => [x.ref, x.id]));
});
after(() => app?.stop());

test('the consolidation reads the notation and the symbols facts define, and may answer with notation', async () => {
  await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathbb{N}', meaning_text: 'The positive integers.' });
  const asked = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate' })).data;
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds: ['consolidate'], features: ['procedures'], capabilities: [] })).data.task;
  assert.equal(t.context.notation.find((n) => n.symbol === '\\mathbb{N}').decided_by, null, 'proposed: nobody decided it');
  assert.equal(t.context.local_notation[0].meanings.length, 2, 'FS defined two ways');
  assert.match(t.recipe.instructions, /normalize the project's notation yourself/);
  assert.match(t.recipe.instructions, /Equivalent formulations[\s\S]*never for another wording/, 'wordings are not meanings');
  const item = t.recipe.schema.properties.suggestions.items;
  assert.ok(item.properties.kind.enum.includes('notation')); assert.ok(item.required.includes('notation'));
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease }); await app.call(ann, 'POST', `/api/ai/tasks/${asked.id}/cancel`, {});
});

test('a probable choice of notation is adopted at once, and the facts wait for a sweep to rewrite them in it', async () => {
  const r = await propose({ action: 'adopt', entry: null, symbol: '\\mathrm{FS}(X)', meaning: 'The non-empty finite sums of $X$.', note: 'Some sources include 0.', variants: [{ symbol: '\\mathrm{FS}(X)', meaning: 'with 0', where: 'a', relation: 'clash' }] }, { confidence: 'medium' });
  assert.equal(r.applied.length, 1, JSON.stringify(r));
  const e = await entry('\\mathrm{FS}(X)');
  assert.equal(e.status, 'agreed'); assert.equal(e.auto_suggestion_id, r.created[0]); assert.equal(e.author_kind, 'agent'); assert.equal(e.variants[0].relation, 'clash');
  assert.equal(await queued(), 0, 'no task per fact: a sweep rewrites them once the project is quiet');
  assert.equal((await entries()).progress.none, 3, 'all three still to rewrite');
  const s = (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data.suggestions.find((x) => x.id === r.created[0]);
  assert.equal(s.auto_applied, true); assert.equal(s.data.symbol, '\\mathrm{FS}(X)');
  assert.equal((await app.call(ann, 'GET', `/api/facts/${id.a}`)).data.history[0].kind, 'notation');
  assert.equal((await propose({ action: 'adopt', entry: null, symbol: '\\mathrm{FS}(H)', meaning: 'The non-empty finite sums of $X$.', note: '', variants: [] })).skipped[0].reason, '\\mathrm{FS}(X) is already agreed.', 'the same notion, spelled otherwise');
});

test('an unsure one waits; an entry already proposed is adopted or kept local by its id', async () => {
  const n = (await entries()).entries.find((e) => e.symbol === '\\mathbb{N}');
  const low = await propose({ action: 'local', entry: n.id, symbol: null, meaning: null, note: null, variants: [] }, { confidence: 'low' });
  assert.equal(low.applied.length, 0);
  assert.equal((await app.call(bob, 'POST', `/api/fact-suggestions/${low.created[0]}/accept`, {})).status, 200, 'any member decides notation');
  assert.equal((await entry('\\mathbb{N}')).status, 'local');
  assert.equal((await propose({ action: 'reject', entry: null, symbol: null, meaning: null, note: null, variants: [] })).skipped[0].reason, 'Name in "entry" the notation entry to reject.');
  assert.equal((await propose({ action: 'local', entry: null, symbol: null, meaning: null, note: null, variants: [] })).skipped[0].reason, 'A new notation entry needs a "symbol" and a "meaning".', 'a new local entry needs its symbol and meaning');
  assert.equal((await propose({ action: 'adopt', entry: 99999, symbol: null, meaning: null, note: null, variants: [] })).skipped[0].reason, 'Unknown notation entry: 99999');
});

test('what a person decided, the consolidation leaves; a person confirms an automatic choice', async () => {
  const mine = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{IP}', meaning_text: 'IP sets.' })).data;
  await app.call(ann, 'POST', `/api/notation/${mine.id}/status`, { status: 'agreed' });
  assert.match((await propose({ action: 'reject', entry: mine.id, symbol: null, meaning: null, note: null, variants: [] })).skipped[0].reason, /A person decided/);
  const fs = await entry('\\mathrm{FS}(X)');
  assert.equal((await app.call(bob, 'POST', `/api/notation/${fs.id}/status`, { status: 'agreed' })).status, 200, 'confirmed');
  assert.equal((await entry('\\mathrm{FS}(X)')).auto_suggestion_id, null);
  assert.equal((await app.call(bob, 'POST', `/api/fact-suggestions/${fs.auto_suggestion_id}/undo`, {})).status, 409, 'a person decided it since');
  const ctx = await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate' });
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds: ['consolidate'], features: ['procedures'], capabilities: [] })).data.task;
  assert.deepEqual(Object.fromEntries(t.context.notation.map((n) => [n.symbol, n.decided_by])), { '\\mathbb{N}': 'person', '\\mathrm{FS}(X)': 'person', '\\mathrm{IP}': 'person' }, 'accepted by a person counts as theirs');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease }); await app.call(ann, 'POST', `/api/ai/tasks/${ctx.data.id}/cancel`, {});
});

test('undoing gives the notation back as it was, and the rewrites in that notation are current again', async () => {
  const progress = async () => (await entries()).progress;
  assert.equal((await app.call(key, 'POST', `/api/facts/${id.c}/rephrasings`, { ai_model: 'claude-opus-5-5', unchanged: true })).status, 201);
  assert.equal((await progress()).unchanged, 1);
  // The facts write FS(X): the entry records that spelling, as the symbols sweep does, which ties it to them.
  const r = await propose({ action: 'adopt', entry: null, symbol: '\\mathrm{NS}(X)', meaning: 'The finite sums of $X$, with 0.', note: '', variants: [{ symbol: '\\mathrm{FS}(X)', meaning: 'as the facts write it', where: 'facts of the project', relation: 'instance' }] });
  assert.equal(r.applied.length, 1);
  assert.equal((await progress()).unchanged, 0, 'the notation changed: the rewrite is out of date');
  assert.equal((await app.call(key, 'POST', `/api/facts/${id.c}/rephrasings`, { ai_model: 'claude-opus-5-5', unchanged: true })).status, 201, 'rewritten in the new notation');
  const n = (await entries()).entries.find((e) => e.symbol === '\\mathbb{N}');
  assert.equal(n.status, 'local');
  const undoLocal = (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data.suggestions.find((s) => s.kind === 'notation' && s.data.entry === n.id);
  const before = (await entries()).hash;
  assert.equal((await app.call(bob, 'POST', `/api/fact-suggestions/${r.created[0]}/undo`, {})).status, 200, 'any member undoes what the AI did on its own');
  assert.equal(await entry('\\mathrm{NS}(X)'), undefined, 'the entry it wrote goes');
  assert.notEqual((await entries()).hash, before);
  assert.equal((await progress()).unchanged, 1, 'the rewrite in the notation as it was is current again, although a later one exists');
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${undoLocal.id}/undo`, {})).status, 200, 'a person accepted it: undone by a member too');
  assert.equal((await entry('\\mathbb{N}')).status, 'proposed', 'back to proposed');
  assert.equal((await propose({ action: 'adopt', entry: null, symbol: '\\mathrm{NS}(X)', meaning: 'The finite sums of $X$, with 0.', note: '', variants: [] })).skipped[0].reason, 'People undid this change.');
  assert.equal((await propose({ action: 'adopt', entry: null, symbol: '\\mathrm{NS}(X)', meaning: 'The finite sums of $X$, 0 included, in any semigroup.', note: '', variants: [] })).applied.length, 1, 'another meaning is another proposal');
});

test('with automatic changes off, notation waits for people like the rest', async () => {
  await app.call(ann, 'POST', `/api/projects/${pid}/consolidation/settings`, { auto: false });
  const n = (await entries()).entries.find((e) => e.symbol === '\\mathbb{N}');
  const r = await propose({ action: 'adopt', entry: n.id, symbol: null, meaning: null, note: null, variants: [] });
  assert.equal(r.applied.length, 0); assert.equal((await entry('\\mathbb{N}')).status, 'proposed');
});
