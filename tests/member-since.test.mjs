// A researcher an owner adds by ORCID iD is a member from then on, but signs in later, or never. The People page says both, so that
// "has not signed in yet" is not followed by "joined 2 d ago", the day they were added, once they sign in.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { memberSince } from '../public/assets/js/util.js';
import { activityVerb } from '../public/assets/js/references.js';

const OWNER = '0000-0002-1825-0097';
const ADDED = '0000-0001-5109-3700';
let app;

before(async () => { app = await startApp(); });
after(() => app?.stop());

test('the first sign-in is recorded once, and the member list gives it with the date they were added', async () => {
  const owner = await app.signIn(OWNER);
  const pid = (await app.call(owner, 'POST', '/api/projects', { title: 'Members', question_html: '<p>Q</p>' })).data.id;
  const added = (await app.call(owner, 'POST', `/api/projects/${pid}/members`, { orcid: ADDED })).data.members.find((m) => m.orcid === ADDED);
  assert.equal(added.has_logged_in, 0); assert.equal(added.first_login_at, null);
  assert.match(memberSince(added), /^added just now, has not signed in yet$/);
  const me = (await app.call(owner, 'GET', `/api/projects/${pid}`)).data.members.find((m) => m.orcid === OWNER);
  assert.equal(memberSince(me), 'joined just now', 'the creator signed in before the project existed');
  const them = await app.signIn(ADDED);
  const member = async () => (await app.call(them, 'GET', `/api/projects/${pid}`)).data.members.find((m) => m.orcid === ADDED);
  const first = (await member()).first_login_at;
  assert.ok(first, 'their first sign-in is recorded');
  await app.signIn(ADDED);
  assert.equal((await member()).first_login_at, first, 'and kept at the next one');
});

test('the words: added, first signed in, joined, and the feed says who added whom', () => {
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(memberSince({ joined_at: ago(2), has_logged_in: 0 }), 'added 2 d ago, has not signed in yet');
  assert.equal(memberSince({ joined_at: ago(2), has_logged_in: 1, first_login_at: ago(0) }), 'added 2 d ago, first signed in just now');
  assert.equal(memberSince({ joined_at: ago(2), has_logged_in: 1, first_login_at: ago(30) }), 'joined 2 d ago', 'an account older than the membership');
  assert.equal(memberSince({ joined_at: ago(2), has_logged_in: 1, first_login_at: null }), 'added 2 d ago', 'signed in before the first sign-in was recorded: no date is invented');
  assert.equal(activityVerb('joined'), 'added', '"Ann added Bob": an owner adds members, and members add AI agents');
});
