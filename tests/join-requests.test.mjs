// Public projects and requests to join them: a non-member sees only the card of a public project, asks with a motivation, and an
// owner accepts or declines. Only people take part: AI agents and personal API keys cannot ask, accept or change the visibility.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { JOIN_LIMITS, VISIBILITY, joinState, memberCount, motivationCheck, ownerNames, visibilityOf } from '../public/assets/js/join-model.js';
import { ACTIONS } from '../public/assets/js/action-help.js';

const OWNER = '0000-0002-1825-0097';
const ASKER = '0000-0001-5109-3700';
const OTHER = '0000-0003-1415-9269';
const MOTIVE = 'I work on extremal set theory and proved a related bound last year.';
let app;
let owner, asker, other, pid;

before(async () => {
  app = await startApp();
  owner = await app.signIn(OWNER); asker = await app.signIn(ASKER); other = await app.signIn(OTHER);
  pid = (await app.call(owner, 'POST', '/api/projects', { title: 'Union-closed sets', question_html: '<p>Is there an element in half of the sets?</p>' })).data.id;
});
after(() => app?.stop());

const sql = (q) => execFileSync('php', ['-r', '$p = new PDO("sqlite:" . $argv[1]); $p->exec($argv[2]);', path.join(app.dir, 'storage/t.sqlite'), q]);
const listed = async (who) => (await app.call(who, 'GET', '/api/projects/public')).data.projects;
const notifs = async (who) => (await app.call(who, 'GET', '/api/notifications')).data.notifications;

test('a project is private by default: nobody else sees it or can ask', async () => {
  assert.equal((await app.call(owner, 'GET', `/api/projects/${pid}`)).data.visibility, 'private');
  assert.deepEqual(await listed(asker), []);
  const r = await app.call(asker, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE });
  assert.equal(r.status, 404, 'a private project is not revealed');
});

test('only an owner makes it public, with a valid value', async () => {
  const m = (await app.call(owner, 'POST', `/api/projects/${pid}/members`, { orcid: OTHER })).data;
  assert.ok(m.members.some((x) => x.orcid === OTHER));
  assert.equal((await app.call(other, 'PATCH', `/api/projects/${pid}`, { visibility: 'public' })).status, 403, 'a member is not an owner');
  assert.equal((await app.call(owner, 'PATCH', `/api/projects/${pid}`, { visibility: 'everyone' })).status, 422);
  const r = await app.call(owner, 'PATCH', `/api/projects/${pid}`, { visibility: 'public' });
  assert.equal(r.status, 200); assert.equal(r.data.visibility, 'public');
});

test('a non-member sees only the card of a public project, and nothing inside it', async () => {
  const [card] = await listed(asker);
  assert.equal(card.id, pid);
  assert.deepEqual(Object.keys(card).sort(), ['agents', 'id', 'members', 'owners', 'question_text', 'request', 'status', 'title', 'updated_at']);
  assert.equal(card.members, 2); assert.equal(card.question_text, 'Is there an element in half of the sets?');
  assert.deepEqual(card.owners.map((o) => o.name), ['U0097']);
  assert.equal(card.request, null);
  for (const url of [`/api/projects/${pid}`, `/api/projects/${pid}/facts`, `/api/projects/${pid}/questions`, `/api/projects/${pid}/documents`, `/api/projects/${pid}/context`, `/api/projects/${pid}/join-requests`]) {
    assert.equal((await app.call(asker, 'GET', url)).status, 403, url);
  }
  assert.deepEqual(await listed(other), [], 'members do not see their own project among those to join');
});

test('the motivation is required and length-limited', async () => {
  for (const motivation of ['', '   ', 'Please let me in', 'x'.repeat(JOIN_LIMITS.motivation_max + 1)]) {
    assert.equal((await app.call(asker, 'POST', `/api/projects/${pid}/join-requests`, { motivation })).status, 422, JSON.stringify(motivation.slice(0, 20)));
  }
  assert.equal((await app.call(other, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE })).status, 409, 'already a member');
});

test('a request notifies the owners, is unique while pending, and can be withdrawn', async () => {
  const r = await app.call(asker, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE });
  assert.equal(r.status, 201); assert.equal(r.data.request.status, 'pending');
  assert.equal((await app.call(asker, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE })).status, 409, 'one pending request per user and project');
  const n = (await notifs(owner)).find((x) => x.kind === 'join_request');
  assert.equal(n.payload.excerpt, MOTIVE); assert.equal(n.payload.link.view, 'members');
  assert.ok(!(await notifs(other)).some((x) => x.kind === 'join_request'), 'members who are not owners are not notified');
  assert.equal((await app.call(owner, 'GET', `/api/counters?project=${pid}`)).data.join_requests, 1);
  assert.equal((await app.call(other, 'GET', `/api/counters?project=${pid}`)).data.join_requests, 0);
  assert.equal((await listed(asker))[0].request.status, 'pending');
  const dash = (await app.call(owner, 'GET', `/api/projects/${pid}/dashboard`)).data.actions;
  assert.ok(dash.some((a) => a.kind === 'join' && a.title === 'U3700'), 'in Needs your attention, for owners');

  assert.equal((await app.call(owner, 'DELETE', `/api/join-requests/${r.data.request.id}`)).status, 404, 'only the requester withdraws');
  assert.equal((await app.call(asker, 'DELETE', `/api/join-requests/${r.data.request.id}`)).status, 200);
  assert.equal((await app.call(asker, 'DELETE', `/api/join-requests/${r.data.request.id}`)).status, 409);
  assert.deepEqual((await app.call(owner, 'GET', `/api/projects/${pid}/join-requests`)).data.requests, []);
  assert.equal((await app.call(owner, 'POST', `/api/join-requests/${r.data.request.id}/accept`)).status, 409, 'a withdrawn request cannot be accepted');
});

test('an owner declines with a note; the requester is notified and may ask again a week later', async () => {
  const id = (await app.call(asker, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE })).data.request.id;
  const pending = (await app.call(owner, 'GET', `/api/projects/${pid}/join-requests`)).data.requests;
  assert.equal(pending.length, 1); assert.equal(pending[0].motivation, MOTIVE); assert.equal(pending[0].orcid, ASKER);
  assert.equal((await app.call(other, 'GET', `/api/projects/${pid}/join-requests`)).status, 403, 'members do not see requests');
  assert.equal((await app.call(other, 'POST', `/api/join-requests/${id}/decline`, {})).status, 403, 'a member cannot decline');
  assert.equal((await app.call(asker, 'POST', `/api/join-requests/${id}/accept`)).status, 403, 'nobody accepts their own request');
  assert.equal((await app.call(owner, 'POST', `/api/join-requests/${id}/decline`, { note: 'n'.repeat(JOIN_LIMITS.note_max + 1) })).status, 422);
  assert.equal((await app.call(owner, 'POST', `/api/join-requests/${id}/decline`, { note: 'Full for now.' })).status, 200);
  assert.equal((await app.call(owner, 'POST', `/api/join-requests/${id}/decline`, {})).status, 409, 'already answered');
  const n = (await notifs(asker)).find((x) => x.kind === 'join_declined');
  assert.equal(n.payload.excerpt, 'Full for now.'); assert.equal(n.payload.link.to, 'projects');
  const card = (await listed(asker))[0];
  assert.equal(card.request.status, 'declined'); assert.equal(card.request.decision_note, 'Full for now.');
  assert.equal(joinState(card.request).state, 'declined'); assert.ok(joinState(card.request).disabled, 'asking again waits');
  assert.equal((await app.call(asker, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE })).status, 429, 'too soon after a decline');
  sql(`UPDATE join_requests SET decided_at = datetime('now', '-8 days') WHERE id = ${id}`);
  assert.equal((await app.call(asker, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE })).status, 201, 'a declined user may ask again later');
});

test('accepting makes the requester a member with the default role, notified, and the card leaves their list', async () => {
  const [q] = (await app.call(owner, 'GET', `/api/projects/${pid}/join-requests`)).data.requests;
  assert.equal(q.declined_before, 1);
  const r = await app.call(owner, 'POST', `/api/join-requests/${q.id}/accept`);
  assert.equal(r.status, 200);
  assert.equal(r.data.members.find((m) => m.orcid === ASKER).role, 'member');
  assert.equal((await app.call(asker, 'GET', `/api/projects/${pid}`)).status, 200, 'the new member reads the project');
  assert.ok((await notifs(asker)).some((x) => x.kind === 'join_accepted'));
  assert.deepEqual(await listed(asker), []);
  assert.equal((await app.call(owner, 'POST', `/api/join-requests/${q.id}/accept`)).status, 409);
});

test('adding a researcher by ORCID iD answers their pending request; a project made private keeps it for its requester', async () => {
  const late = await app.signIn('0000-0002-9079-593X');
  const id = (await app.call(late, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE })).data.request.id;
  await app.call(owner, 'PATCH', `/api/projects/${pid}`, { visibility: 'private' });
  const [card] = await listed(late);
  assert.equal(card.private_now, true, 'the requester still sees, and can withdraw, the request they sent');
  assert.equal(card.request.id, id);
  const stranger = await app.signIn('0000-0001-7777-0001');
  assert.deepEqual(await listed(stranger), [], 'nobody else sees a private project');
  assert.equal((await app.call(stranger, 'POST', `/api/projects/${pid}/join-requests`, { motivation: MOTIVE })).status, 404);
  await app.call(owner, 'POST', `/api/projects/${pid}/members`, { orcid: '0000-0002-9079-593X' });
  assert.deepEqual((await app.call(owner, 'GET', `/api/projects/${pid}/join-requests`)).data.requests, []);
  assert.deepEqual(await listed(late), []);
});

test('AI agents and personal API keys cannot ask, answer or change the visibility', async () => {
  await app.call(owner, 'PATCH', `/api/projects/${pid}`, { visibility: 'public' });
  const other2 = (await app.call(owner, 'POST', '/api/projects', { title: 'Second', question_html: '<p>Q</p>' })).data.id;
  await app.call(owner, 'PATCH', `/api/projects/${other2}`, { visibility: 'public' });
  const agent = (await app.call(owner, 'POST', `/api/projects/${pid}/agents`, { name: 'Prover', ai_model: 'claude-opus-5-5' })).data;
  const bot = { token: agent.token };
  assert.equal((await app.call(bot, 'GET', '/api/projects/public')).status, 403);
  assert.equal((await app.call(bot, 'POST', `/api/projects/${other2}/join-requests`, { motivation: MOTIVE })).status, 403);
  assert.equal((await app.call(bot, 'PATCH', `/api/projects/${pid}`, { visibility: 'private' })).status, 403);
  const key = (await app.call(asker, 'POST', '/api/me/keys', { name: 'laptop' })).data;
  const client = { token: key.token };
  assert.equal((await app.call(client, 'POST', `/api/projects/${other2}/join-requests`, { motivation: MOTIVE })).status, 403);
  assert.equal((await app.call(client, 'GET', '/api/projects/public')).status, 403);
  const id = (await app.call(asker, 'POST', `/api/projects/${other2}/join-requests`, { motivation: MOTIVE })).data.request.id;
  assert.equal((await app.call(client, 'DELETE', `/api/join-requests/${id}`)).status, 403);
  const ownerKey = { token: (await app.call(owner, 'POST', '/api/me/keys', { name: 'desk' })).data.token };
  assert.equal((await app.call(ownerKey, 'POST', `/api/join-requests/${id}/accept`)).status, 403);
  assert.equal((await app.call(ownerKey, 'GET', `/api/projects/${other2}/join-requests`)).status, 403);
});

test('the interface states: each card footer says the state and allows one action', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  assert.deepEqual(joinState(null, now), { state: 'none', text: 'Not a member', action: 'ask' });
  assert.equal(joinState({ status: 'withdrawn' }, now).action, 'ask');
  assert.equal(joinState({ status: 'pending' }, now).action, 'withdraw');
  const soon = joinState({ status: 'declined', decision_note: 'Later', ask_again_at: '2026-12-01 10:00:00' }, now);
  assert.equal(soon.note, 'Later'); assert.match(soon.disabled, /ask again from 1 Dec/); assert.equal(soon.text, 'Declined, ask again from 1 Dec', 'said beside the button too, for phones without hover');
  assert.equal(joinState({ status: 'declined', ask_again_at: '2026-11-20 10:00:00' }, now).disabled, undefined);
  assert.equal(motivationCheck('short').ok, false); assert.match(motivationCheck('short').hint, /15 more characters needed/);
  assert.equal(motivationCheck(MOTIVE).ok, true);
  assert.match(motivationCheck('x'.repeat(1002)).hint, /2 characters too many/);
  assert.equal(ownerNames([{ name: 'Ann' }, { name: 'Bob' }]), 'Ann and Bob');
  assert.equal(ownerNames([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }]), 'A, B and 2 others');
  assert.deepEqual(memberCount({ members: 1, agents: 2 }), { text: '1 member', title: '1 researcher and 2 AI agents' });
  assert.equal(visibilityOf({}), 'private'); assert.equal(visibilityOf({ visibility: 'public' }), 'public');
  assert.match(VISIBILITY.public.text, /Nothing inside the project/);
  for (const a of ['project.public', 'project.private', 'join.ask', 'join.withdraw', 'join.accept', 'join.decline']) assert.ok(ACTIONS[a], a);
  assert.match(ACTIONS['join.decline'].keeps, /ask again after a week/, 'says whether it can be undone');
});
