// Two models under one member's key give two reviews; a proof one model could not check goes to another; and a symbol whose
// wordings are several meanings gets a decision for each, each group then pointing at its entry.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const NOW = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, review_hours: 0, consolidate_hours: 0 } };
let app; let ann; let key;

const project = async (title) => (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
const facts = async (pid, list) => Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: list })).data.created.map((x) => [x.ref, x.id]));
const F = (ref, extra) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `Proof of ${ref}.`, ...extra });
const claimAs = (pid, model, kinds) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: model, project_id: pid, kinds, features: ['procedures', 'consolidate', 'review'], capabilities: [] });
const answerAs = (t, model, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: model, generation_seconds: 2, answer: ans });

before(async () => {
  app = await startApp({ config: NOW }); ann = await app.signIn(ANN);
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('two models under one member\'s key give two reviews; the same model again replaces its own', async () => {
  const pid = await project('Two models');
  const id = await facts(pid, [F('a')]);
  const review = (model, verdict) => app.call(key, 'POST', `/api/facts/${id.a}/reviews`, { verdict, body_text: `Read by ${model}.`, ai_model: model });
  assert.ok((await review('claude-opus-5-5', 'correct')).status < 300);
  assert.ok((await review('gpt-5', 'gap')).status < 300);
  let reviews = (await app.call(ann, 'GET', `/api/facts/${id.a}`)).data.reviews.filter((r) => r.reviewer_kind === 'agent');
  assert.deepEqual(reviews.map((r) => r.ai_model).sort(), ['claude-opus-5-5', 'gpt-5'], 'two independent reviews');
  assert.ok((await review('claude-opus-5-5', 'gap')).status < 300);
  reviews = (await app.call(ann, 'GET', `/api/facts/${id.a}`)).data.reviews.filter((r) => r.reviewer_kind === 'agent');
  assert.equal(reviews.length, 2, 'a model\'s second review replaces its first');
  assert.equal(reviews.find((r) => r.ai_model === 'claude-opus-5-5').verdict, 'gap');
});

test('a proof one model left out goes to another model, and after two to people', async () => {
  const pid = await project('Left out');
  const id = await facts(pid, [F('hard')]);
  const empty = { summary: '', reviews: [] };
  const first = (await claimAs(pid, 'claude-opus-5-5', ['proof_review'])).data.task;
  assert.deepEqual(first.context.facts.map((f) => f.fact_id), [id.hard]);
  assert.equal((await answerAs(first, 'claude-opus-5-5', empty)).status, 200);
  assert.equal((await claimAs(pid, 'claude-opus-5-5', ['proof_review'])).data.task, null, 'not to the model that left it out');
  const second = (await claimAs(pid, 'gpt-5', ['proof_review'])).data.task;
  assert.ok(second, 'another model gets it'); assert.deepEqual(second.context.facts.map((f) => f.fact_id), [id.hard]);
  assert.equal((await answerAs(second, 'gpt-5', empty)).status, 200);
  assert.equal((await claimAs(pid, 'o4-mini', ['proof_review'])).data.task, null, 'two models could not check it: it is left to people');
});

test('a symbol whose wordings are two meanings gets one decision for each, and each group points at its entry', async () => {
  const pid = await project('Two meanings');
  await facts(pid, [
    F('a', { glossary: { semigroup: 'a code for a closed subsemigroup of $\\beta\\mathbb N$' } }),
    F('b', { glossary: { semigroup: 'a sequence $U$ with fip such that every $X\\in U$ satisfies $X\\,\\tilde\\in\\,U+U$' } }),
    F('c', { glossary: { semigroup: 'a set with an associative operation' } }),
  ]);
  const t = (await claimAs(pid, 'claude-opus-5-5', ['consolidate'])).data.task;
  assert.match(t.recipe.instructions, /give one decision per class/);
  const shown = t.context.symbols.find((x) => x.symbol === 'semigroup').meanings;
  const no = (re) => shown.find((m) => re.test(m.meaning)).no;
  const base = { symbol: 'semigroup', entry: null, note: '', variants: [], params: [], fact: null, reason: 'r' };
  const done = await answerAs(t, 'claude-opus-5-5', { summary: '', types: [], decisions: [
    { ...base, action: 'adopt', project_symbol: 'semigroup (\\beta\\mathbb N)', meaning: 'A code for a closed subsemigroup of $\\beta\\mathbb N$.', class: 1,
      classes: [{ meanings: [no(/code/), no(/fip/)], label: 'Hirst\'s code', entry: null, decided: true }, { meanings: [no(/associative/)], label: 'an algebraic semigroup', entry: null, decided: false }] },
    { ...base, action: 'local', project_symbol: null, meaning: 'A set with an associative operation.', class: 2, classes: [] },
  ] });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.match(done.data.summary_text, /^1 symbol read \(2 settled\)/);
  const n = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data;
  const row = n.shared.find((x) => x.symbol === 'semigroup');
  const byLabel = Object.fromEntries(row.classes.map((c) => [c.label, c.entry]));
  assert.equal(byLabel['Hirst\'s code']?.status, 'agreed'); assert.equal(byLabel['Hirst\'s code']?.symbol, 'semigroup (\\beta\\mathbb N)');
  assert.equal(byLabel['an algebraic semigroup']?.status, 'local', 'the other meaning is settled too, local to its paper');
  assert.ok(row.entry, 'every group points at an entry: the symbol is settled');
});
