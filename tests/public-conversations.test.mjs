// A conversation is open to chosen people, as before, or to the whole project: every present and future member reads, answers and
// is notified of it. Private conversations keep their participants only, whoever joins the project later.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { ACCESS_FINAL, CONVERSATION_ACCESS, accessOf, createBody, whoLine } from '../public/assets/js/conversation-model.js';
import { ACTIONS } from '../public/assets/js/action-help.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X'; const DAN = '0000-0003-1415-9269';
const ZOE = '0000-0001-2345-6789';
let app; let ann; let bob; let eve; let dan; let zoe; let pid;

const start = (who, subject, extra) => app.call(who, 'POST', `/api/projects/${pid}/conversations`, { subject, body_text: `Opening ${subject}.`, ...extra });
const open = (who, id) => app.call(who, 'GET', `/api/conversations/${id}`);
const listed = async (who) => (await app.call(who, 'GET', `/api/projects/${pid}/conversations`)).data.conversations;
const notes = async (who) => (await app.call(who, 'GET', '/api/notifications')).data.notifications || [];
const addMember = (orcid) => app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid });
const sql = (q) => execFileSync('php', ['-r', '$p = new PDO("sqlite:" . $argv[1]); $p->exec($argv[2]);', path.join(app.dir, 'storage/t.sqlite'), q]);
let everyone; let secret;

before(async () => {
  app = await startApp();
  [ann, bob, eve, dan, zoe] = [await app.signIn(ANN), await app.signIn(BOB), await app.signIn(EVE), await app.signIn(DAN), await app.signIn(ZOE)];
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Open talks', question_html: '<p>Q</p>' })).data.id;
  assert.ok((await addMember(BOB)).status < 300);
});
after(() => app?.stop());

test('the interface says who each choice reaches, and that it is final', () => {
  assert.equal(CONVERSATION_ACCESS.project.long, 'Whole project (including future members)');
  assert.match(CONVERSATION_ACCESS.project.text, /joins the project later/);
  assert.match(CONVERSATION_ACCESS.project.text, /need no confirmation/);
  assert.match(CONVERSATION_ACCESS.chosen.text, /join the project later do not see it/);
  assert.match(ACCESS_FINAL, /cannot be changed/);
  for (const k of ['project', 'chosen', 'leave', 'add']) assert.ok(ACTIONS[`conversation.${k}`], k);
  assert.equal(accessOf({ visibility: 'project' }), 'project');
  assert.equal(accessOf({}), 'chosen');
  assert.deepEqual(createBody({ subject: 'S', access: 'project', participants: [3] }), { subject: 'S', visibility: 'project', participant_ids: [] });
  assert.deepEqual(createBody({ subject: 'S', access: 'chosen', participants: [3] }), { subject: 'S', visibility: 'chosen', participant_ids: [3] });
  assert.equal(whoLine({ visibility: 'project', participants: [] }, 1), 'Whole project');
  assert.equal(whoLine({ participants: [{ id: 1, name: 'Ann A' }, { id: 2, name: 'Bob B' }] }, 1), 'Bob');
  const view = fs.readFileSync('public/assets/js/views/conversations.js', 'utf8');
  assert.match(view, /accessFinal/, 'the composer says the choice is final beside it');
  assert.match(view, /v-if="convAccess === 'chosen'" class="icon-btn" @click="leave"/, 'nobody can leave a whole-project conversation');
});

test('a visibility other than the two choices is refused', async () => {
  assert.equal((await start(ann, 'Bad', { visibility: 'public' })).status, 422);
  assert.equal((await start(ann, 'Bad', { visibility: '' })).status, 422);
});

test('a whole-project conversation includes every member now, without a list of people', async () => {
  const r = await start(bob, 'Strategy for the main question', { visibility: 'project' });
  assert.equal(r.status, 201);
  everyone = r.data.id;
  const c = (await open(ann, everyone)).data;
  assert.equal(c.visibility, 'project');
  assert.deepEqual(c.participants.map((p) => p.id).sort(), [ann.id, bob.id].sort());
  assert.equal(c.extraction.private, false);
  assert.equal((await listed(ann)).find((x) => x.id === everyone).visibility, 'project');
  secret = (await start(ann, 'Only Bob and me', { participant_ids: [bob.id] })).data.id;
  assert.equal((await open(ann, secret)).data.visibility, 'chosen', 'chosen people stays the default');
});

test('an outsider can neither read nor answer it', async () => {
  assert.equal((await open(eve, everyone)).status, 403);
  assert.equal((await app.call(eve, 'POST', `/api/conversations/${everyone}/messages`, { body_text: 'Hi' })).status, 403);
  assert.equal((await app.call(eve, 'GET', `/api/projects/${pid}/conversations`)).status, 403);
});

test('a member added later reads it, answers it, comments on it and is notified like the others', async () => {
  assert.ok((await addMember(EVE)).status < 300);
  const mine = await listed(eve);
  assert.deepEqual(mine.map((x) => x.id), [everyone], 'the private conversation stays hidden');
  const c = (await open(eve, everyone)).data;
  assert.ok(c.participants.some((p) => p.id === eve.id));
  assert.equal(c.messages[0].body_html.includes('Opening'), true, 'the whole history');
  assert.equal((await app.call(eve, 'POST', `/api/conversations/${everyone}/messages`, { body_text: `A thought for @{user:${bob.id}}` })).status, 201);
  assert.ok((await notes(bob)).some((n) => n.kind === 'mention'), 'a mention by the newcomer notifies');
  assert.equal((await app.call(eve, 'POST', '/api/comments', { target_type: 'conversation', target_id: everyone, body_text: 'A comment.' })).status, 201);
  assert.equal((await app.call(eve, 'GET', `/api/comments?type=conversation&id=${everyone}`)).status, 200);
  await app.call(ann, 'POST', `/api/conversations/${everyone}/messages`, { body_text: `Welcome @{user:${eve.id}}` });
  assert.ok((await notes(eve)).some((n) => n.kind === 'mention'), 'the newcomer is notified');
  const refs = (await app.call(eve, 'GET', `/api/projects/${pid}/refs/resolve?keys=conversation:${everyone},conversation:${secret}`)).data.refs;
  assert.equal(refs[`conversation:${everyone}`].state, 'ok', 'it can be cited and opened');
  assert.equal(refs[`conversation:${secret}`].state, 'private');
});

test('a private conversation keeps working as before', async () => {
  assert.equal((await open(eve, secret)).status, 403, 'joining the project does not open it');
  assert.equal((await app.call(eve, 'POST', '/api/comments', { target_type: 'conversation', target_id: secret, body_text: 'x' })).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/conversations/${secret}/participants`, { user_ids: [eve.id] })).status, 200);
  assert.equal((await open(eve, secret)).status, 200);
  assert.equal((await app.call(eve, 'POST', `/api/conversations/${secret}/leave`)).status, 200);
  assert.equal((await open(eve, secret)).status, 403);
});

test('nobody leaves a whole-project conversation or is added to it; archiving still works', async () => {
  assert.equal((await app.call(eve, 'POST', `/api/conversations/${everyone}/leave`)).status, 422);
  assert.equal((await app.call(ann, 'POST', `/api/conversations/${everyone}/participants`, { user_ids: [eve.id] })).status, 422);
  assert.equal((await app.call(eve, 'PATCH', `/api/conversations/${everyone}/flags`, { archived: true })).status, 200);
  assert.equal((await listed(eve)).find((x) => x.id === everyone).archived, true);
  assert.equal((await open(eve, everyone)).status, 200);
});

test('a member who leaves the project loses it, and finds it again when added back', async () => {
  assert.equal((await app.call(ann, 'DELETE', `/api/projects/${pid}/members/${eve.id}`)).status, 200);
  assert.equal((await open(eve, everyone)).status, 403);
  await addMember(EVE);
  assert.equal((await open(eve, everyone)).status, 200);
});

test('people joining through a request, an AI agent or another way take part too', async () => {
  assert.equal((await app.call(ann, 'PATCH', `/api/projects/${pid}`, { visibility: 'public' })).status, 200);
  const q = await app.call(dan, 'POST', `/api/projects/${pid}/join-requests`, { motivation: 'I work on this question and would like to help.' });
  assert.equal(q.status, 201);
  assert.equal((await app.call(ann, 'POST', `/api/join-requests/${q.data.id ?? q.data.request?.id}/accept`)).status, 200);
  assert.ok((await open(dan, everyone)).data.participants.some((p) => p.id === dan.id));
  const agent = await app.call(ann, 'POST', `/api/projects/${pid}/agents`, { name: 'Helper', ai_model: 'claude-opus-5-5' });
  assert.equal(agent.status, 201);
  assert.ok((await open(ann, everyone)).data.participants.some((p) => p.name === 'Helper'));
  // A member added straight in the database, as by an older import, takes part as soon as they open their conversations.
  sql(`INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (${pid}, ${zoe.id}, 'member', '2026-11-27 10:00:00')`);
  assert.deepEqual((await listed(zoe)).map((x) => x.id), [everyone]);
  assert.equal((await open(zoe, everyone)).status, 200);
});

test('extracting facts from it needs no privacy confirmation and notifies nobody', async () => {
  const before = (await notes(bob)).filter((n) => n.kind === 'conversation_extract').length;
  const r = await app.call(eve, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'conversation', source_id: everyone });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await notes(bob)).filter((n) => n.kind === 'conversation_extract').length, before);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'conversation', source_id: secret })).status, 422, 'a private one still asks');
});
