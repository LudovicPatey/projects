// Which facts to verify first, for the AI reviews and for people alike, and when a check is independent: from a person, or from an
// AI of another company than the one whose model wrote the proof.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { factBadges, plainTex, verifyBadge } from '../public/assets/js/fact-badges.js';

const ANN = '0000-0002-1825-0097';
const NOW = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, review_hours: 0, consolidate_hours: 0 } };
let app; let ann; let key;

const project = async (title) => (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
const F = (ref, deps = []) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `Proof of ${ref}.`, depends_on: deps });
const facts = async (pid, list, model = 'claude-opus-5-5') => Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: model, facts: list })).data.created.map((x) => [x.ref, x.id]));
const list = async (pid) => Object.fromEntries((await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.map((f) => [f.title, f]));
const review = (fid, model, verdict = 'correct') => app.call(key, 'POST', `/api/facts/${fid}/reviews`, { verdict, body_text: `Read by ${model}.`, ai_model: model });
const claim = (pid, models, model = models[0]) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: model, project_id: pid, kinds: ['proof_review'], models: { proof_review: models }, features: ['procedures', 'review'], capabilities: [] });

before(async () => {
  app = await startApp({ config: NOW }); ann = await app.signIn(ANN);
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('what an answer rests on comes first, then what many facts rely on, directly or not', async () => {
  const pid = await project('Priority');
  const id = await facts(pid, [F('root'), F('mid', ['root']), F('top', ['mid']), F('lone'), F('answer')]);
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Is it so?' })).data;
  assert.ok((await app.call(ann, 'POST', `/api/questions/${q.id}/answers`, { answer: 'positive', fact_id: id.answer, body_text: 'It says so.' })).status < 300);
  const f = await list(pid);
  assert.equal(f.answer.verify.answers[0].title, 'Is it so?');
  assert.equal(f.root.verify.rests, 2, 'two facts rely on it, one of them indirectly');
  const order = Object.values(f).filter((x) => x.verify).sort((a, b) => b.verify.score - a.verify.score).map((x) => x.title);
  assert.deepEqual(order.slice(0, 3), ['answer', 'root', 'mid']);
  assert.equal(f.answer.verify.waits, 'ai', 'an AI review is due on it');
  // The overview suggests the same facts, with the reason.
  const d = (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data;
  const todo = d.actions.filter((a) => a.kind === 'review');
  assert.equal(todo[0].title, 'answer'); assert.equal(todo[0].why, 'An answer rests on it'); assert.match(todo[0].why_title, /“Is it so\?”/);
  // A person's endorsement takes it off the list.
  await app.call(ann, 'POST', `/api/facts/${id.answer}/reviews`, { verdict: 'correct', body_text: 'Checked.' });
  assert.equal((await list(pid)).answer.verify, null);
});

test('a check by an AI of the author\'s company is not independent; another company\'s is', async () => {
  const pid = await project('Companies');
  const id = await facts(pid, [F('same'), F('other')]);
  await review(id.same, 'claude-sonnet-5-5');
  await review(id.other, 'gpt-5.5');
  const f = await list(pid);
  assert.equal(f.same.check_level, 'same_ai'); assert.equal(f.other.check_level, 'other_ai');
  assert.equal(f.same.status, 'ai_checked');
  assert.match(factBadges(f.same).find((b) => b.key === 'status').title, /only by an AI of the same company/);
  assert.match(factBadges(f.other).find((b) => b.key === 'status').title, /another company/);
  // Another company's AI reviewed here lately: the proof only Claude checked waits for it.
  assert.equal(f.same.verify.waits, 'ai'); assert.equal(f.other.verify.waits, 'person');
});

test('a client with both AIs reviews with the other company\'s, on what its own company only checked', async () => {
  const pid = await project('Two AIs');
  const id = await facts(pid, [F('base'), F('top', ['base'])]);
  // Only Claude is around: a Claude model other than the author's reviews first.
  let t = (await claim(pid, ['claude-sonnet-5-5'])).data.task;
  assert.ok(t); assert.equal(t.ai_model, 'claude-sonnet-5-5'); assert.equal(t.recipe.independent, true);
  assert.equal(t.context.facts[0].fact_id, id.base, 'what the other fact rests on first');
  assert.equal((await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-sonnet-5-5', answer: { summary: '', reviews: [{ fact_id: id.base, verdict: 'correct', explanation: 'Fine.' }] } })).status, 200);
  assert.equal((await list(pid)).base.check_level, 'same_ai');
  // A client that has ChatGPT too offers it first: the platform gives it the proof Claude only checked, and leases with GPT.
  t = (await claim(pid, ['gpt-5.5', 'claude-opus-5-5'], 'claude-opus-5-5')).data.task;
  assert.ok(t, 'another company is around now'); assert.equal(t.ai_model, 'gpt-5.5');
  assert.ok(t.context.facts.some((f) => f.fact_id === id.base), 'the proof Claude checked goes to GPT');
  assert.equal((await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'gpt-5.5', answer: { summary: '', reviews: t.context.facts.map((f) => ({ fact_id: f.fact_id, verdict: 'correct', explanation: 'Fine.' })) } })).status, 200);
  const f = await list(pid);
  assert.equal(f.base.check_level, 'other_ai'); assert.equal(f.base.verify.waits, 'person', 'now it waits for a person');
  // Nothing left for Claude: the sweep is not offered to it, and nothing is lost for others.
  assert.equal((await claim(pid, ['claude-opus-5-5'])).data.task, null);
});

test('the list says why a fact matters only when something rests on it', () => {
  assert.equal(verifyBadge(null), null);
  assert.equal(verifyBadge({ answers: [], answer_count: 0, worth: 0, rests: 1, waits: 'person' }), null, 'most cards say nothing');
  const a = verifyBadge({ answers: [{ title: 'Q1', state: 'ratified' }], answer_count: 2, worth: 0, rests: 4, waits: 'ai' });
  assert.equal(a.icon, 'target'); assert.match(a.title, /the answer to “Q1” \(ratified\) and 1 more rests on it\. 4 facts rely on it\. An AI review is due/);
  assert.match(verifyBadge({ answers: [{ title: 'Is $\\mathsf{HT}_2$ true?', state: 'proposed' }], answer_count: 1, worth: 0, rests: 0, waits: 'person' }).title, /“Is HT_2 true\?”/, 'a hover cannot typeset formulas');
  assert.equal(plainTex('$\\emptyset\'$'), '∅\'');
  const many = verifyBadge({ answers: [], answer_count: 0, worth: 0, rests: 7, waits: 'person' });
  assert.equal(many.count, 7); assert.match(many.title, /It waits for a person/);
});

test('a client that names its model by an alias is still recognised as the author, and a refusal is not a read', async () => {
  const pid = await project('Aliases');
  const id = await facts(pid, [F('mine')]); // written by claude-opus-5-5
  assert.equal((await claim(pid, ['opus'])).data.task, null, '"opus" wrote what claude-opus-5-5 wrote: no batch for it');
  const t = (await claim(pid, ['gpt-5.5'])).data.task;
  assert.deepEqual(t.context.facts.map((f) => f.fact_id), [id.mine], 'another company gets it');
});
