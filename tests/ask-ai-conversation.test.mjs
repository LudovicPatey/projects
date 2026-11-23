// Asking the AI inside a conversation.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { askAiPrefix, opinionStatus } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X';
let app; let ann; let bob; let eve; let annKey; let eveKey; let pid;
const claim = async (key = annKey) => (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', kinds: ['ask'], project_id: pid })).data.task;
const make = async (text, ids = [bob.id, eve.id]) => (await app.call(ann, 'POST', `/api/projects/${pid}/conversations`, { subject: 'S', body_text: text, participant_ids: ids })).data.id;
const say = async (c, text, who = bob) => (await app.call(who, 'POST', `/api/conversations/${c}/messages`, { body_text: text })).data.id;
const opinion = async (c, who = ann) => (await app.call(who, 'GET', `/api/conversations/${c}`)).data.ai_opinion;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Ask', question_html: '<p>Q</p>' })).data.id;
  for (const o of [BOB, EVE]) await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: o });
  annKey = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'a' })).data.token };
  eveKey = { token: (await app.call(eve, 'POST', '/api/me/keys', { name: 'e' })).data.token };
});
after(() => app?.stop());

test('the button keeps the request visible in the message', () => {
  assert.equal(askAiPrefix(''), '@AI What is your opinion on this discussion?');
  assert.equal(askAiPrefix('Is this true?'), '@AI ');
  assert.equal(askAiPrefix('Is this true, @ai?'), '');
  assert.equal(askAiPrefix('write to me@AI.org'), '@AI ');
});

test('the status says what the discussion is waiting for', () => {
  assert.equal(opinionStatus({ waiting: 0, running: 0, failed_task: null, clients: 1 }), null);
  assert.match(opinionStatus({ waiting: 1, running: 0, clients: 0 }).text, /starts their AI client/);
  assert.match(opinionStatus({ waiting: 1, running: 0, clients: 1 }).text, /will answer here/);
  assert.match(opinionStatus({ waiting: 1, running: 1, clients: 1 }).text, /preparing/);
  assert.equal(opinionStatus({ waiting: 0, running: 0, failed_task: 9, clients: 1 }).task, 9);
});

test('@AI works in the first message of a conversation', async () => {
  const c = await make('@AI is the first message heard?');
  assert.equal((await opinion(c)).waiting, 1);
  const t = await claim();
  assert.equal(t.conversation_id, c);
  assert.equal((await opinion(c)).running, 1);
  assert.equal((await app.call(annKey, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'claude-opus-5-5', reply_text: 'Yes.', summary: 'ok' })).status, 200);
  const after_ = (await app.call(ann, 'GET', `/api/conversations/${c}`)).data;
  assert.equal(after_.messages.at(-1).body_html.includes('Yes.'), true);
  assert.equal(after_.ai_opinion.waiting + after_.ai_opinion.running, 0);
});

test('the AI answers the question, even if someone replied before it ran', async () => {
  const c = await make('Some context.');
  const q = await say(c, '@AI is this lemma true?');
  await say(c, 'A later reply that is not the question.', ann);
  const t = await claim();
  assert.equal(t.context.thread.at(-1).id, q);
  assert.equal(t.context.thread.some((m) => m.text.includes('later reply')), false);
  await app.call(annKey, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'claude-opus-5-5', reply_text: 'Done.', summary: 'ok' });
});

test('a private question reaches only participants, and its status stays private', async () => {
  const c = await make('@AI a private question', [bob.id]);
  assert.equal(await claim(eveKey), null);
  assert.equal((await app.call(eve, 'GET', `/api/conversations/${c}`)).status, 403);
  const t = await claim();
  await app.call(annKey, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'claude-opus-5-5', reply_text: 'Private answer.', summary: 'ok' });
});
