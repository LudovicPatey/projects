// Bug reports and feature requests: form logic, and the API on a throwaway copy of the application.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { draftError, filterReports, pageContext, reportCounts } from '../public/assets/js/feedback-model.js';
import { startApp } from './harness.mjs';

test('the page address drops its query and refuses anything else', () => {
  assert.equal(pageContext('#/p/3/facts/12?comment=4'), '#/p/3/facts/12');
  assert.equal(pageContext('#/projects'), '#/projects');
  assert.equal(pageContext('#/feedback/7'), '#/feedback/7');
  assert.equal(pageContext('#/p/3/<script>'), null);
  assert.equal(pageContext('https://example.org'), null);
  assert.equal(pageContext(''), null);
});

test('a draft needs a type, a title and a description', () => {
  const d = { kind: 'bug', title: 'T', body: 'B' };
  assert.equal(draftError(d), null);
  assert.ok(draftError({ ...d, kind: 'x' }));
  assert.ok(draftError({ ...d, title: '  ' }));
  assert.ok(draftError({ ...d, body: '' }));
  assert.ok(draftError({ ...d, title: 'x'.repeat(161) }));
  assert.ok(draftError({ ...d, body: 'x'.repeat(8001) }));
});

test('filters and counts', () => {
  const list = [{ id: 1, kind: 'bug', status: 'new', title: 'Crash on PDF', body_text: 'x' }, { id: 2, kind: 'feature', status: 'done', title: 'Dark mode', body_text: 'theme' }, { id: 3, kind: 'bug', status: 'declined', title: 'Other', body_text: 'y', author: 'Mei' }];
  assert.deepEqual(filterReports(list, { kind: 'bug' }).map((r) => r.id), [1, 3]);
  assert.deepEqual(filterReports(list, { status: 'open' }).map((r) => r.id), [1]);
  assert.deepEqual(filterReports(list, { search: 'THEME' }).map((r) => r.id), [2]);
  assert.deepEqual(filterReports(list, { search: 'mei' }).map((r) => r.id), [3]);
  assert.deepEqual(reportCounts(list), { total: 3, bug: 2, feature: 1, open: 1, done: 1 });
});

const ADMIN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X';
let app; let admin; let bob; let eve; let key; let agent; let pid;
const send = (who, extra = {}) => app.call(who, 'POST', '/api/feedback', { kind: 'bug', title: 'It breaks', body_text: 'Steps', ...extra });
const badge = async (who) => (await app.call(who, 'GET', '/api/counters')).data.feedback;

before(async () => {
  app = await startApp({ feedbackAdmins: [ADMIN] });
  admin = await app.signIn(ADMIN); bob = await app.signIn(BOB); eve = await app.signIn(EVE);
  pid = (await app.call(bob, 'POST', '/api/projects', { title: 'Secret project', question_html: '<p>x</p>' })).data.id;
  key = { token: (await app.call(bob, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  agent = { token: (await app.call(bob, 'POST', `/api/projects/${pid}/agents`, { name: 'Bot', ai_model: 'm' })).data.token };
});
after(() => app?.stop());

test('API: a report is private to its author and the administrators', async () => {
  const r = (await send(bob, { title: 'Private bug', page: `#/p/${pid}/facts/3`, client_info: 'Browser' })).data;
  assert.equal(r.status, 'new');
  assert.equal(r.project_title, 'Secret project');
  const eveList = (await app.call(eve, 'GET', '/api/feedback?scope=all')).data;
  assert.equal(eveList.is_admin, false);
  assert.ok(!eveList.reports.some((x) => x.id === r.id), 'scope=all is ignored for a non-administrator');
  for (const [m, u, b] of [['PATCH', `/api/feedback/${r.id}`, { title: 'x' }], ['DELETE', `/api/feedback/${r.id}`], ['POST', `/api/feedback/${r.id}/seen`, {}]]) {
    assert.equal((await app.call(eve, m, u, b)).status, 404, `${m}: looks like it does not exist`);
  }
  const all = (await app.call(admin, 'GET', '/api/feedback?scope=all')).data;
  assert.equal(all.is_admin, true);
  const seen = all.reports.find((x) => x.id === r.id);
  assert.equal(seen.author_orcid, BOB);
  assert.equal(seen.project_title, null, 'an administrator does not learn the title of a project they are not in');
  assert.ok(!JSON.stringify(all).includes('email'));
});

test('API: input is validated and the context is limited', async () => {
  assert.equal((await send(bob, { kind: 'x' })).status, 422);
  assert.equal((await send(bob, { title: ' ' })).status, 422);
  assert.equal((await send(bob, { body_text: '' })).status, 422);
  assert.equal((await send(bob, { impact: 'huge' })).status, 422);
  assert.equal((await send(bob, { body_text: 'x'.repeat(8001) })).status, 422);
  assert.equal((await send(bob, { page: 'javascript:alert(1)' })).data.page, null);
  const foreign = (await send(eve, { page: `#/p/${pid}/facts` })).data;
  assert.equal(foreign.project_title, null, 'a project the author is not in is not linked');
  const html = (await send(bob, { title: '<img src=x onerror=alert(1)>' })).data;
  assert.equal(html.title, '<img src=x onerror=alert(1)>', 'kept as plain text, displayed escaped');
});

test('API: AI clients and agents cannot use it', async () => {
  for (const who of [key, agent]) {
    assert.equal((await app.call(who, 'GET', '/api/feedback')).status, 403);
    assert.equal((await send(who)).status, 403);
  }
});

test('API: only an administrator handles a report, and the author is told', async () => {
  const r = (await send(bob, { title: 'Handle me' })).data;
  assert.equal((await app.call(bob, 'PATCH', `/api/feedback/${r.id}`, { status: 'done' })).status, 403);
  assert.equal((await app.call(bob, 'PATCH', `/api/feedback/${r.id}`, { response_text: 'x' })).status, 403);
  assert.equal((await app.call(admin, 'PATCH', `/api/feedback/${r.id}`, { title: 'Rewritten' })).status, 403);
  assert.equal((await app.call(admin, 'PATCH', `/api/feedback/${r.id}`, { status: 'nope' })).status, 422);
  assert.equal((await app.call(bob, 'PATCH', `/api/feedback/${r.id}`, { title: 'Clearer title' })).data.title, 'Clearer title');
  const before = await badge(bob);
  const done = await app.call(admin, 'PATCH', `/api/feedback/${r.id}`, { status: 'planned', response_text: 'Thanks' });
  assert.equal(done.data.responder !== null, true);
  assert.equal(await badge(bob), before + 1);
  assert.equal((await app.call(bob, 'POST', `/api/feedback/${r.id}/seen`, {})).status, 200);
  assert.equal(await badge(bob), before);
  assert.equal((await app.call(bob, 'PATCH', `/api/feedback/${r.id}`, { title: 'Too late' })).status, 409);
  assert.equal((await app.call(bob, 'DELETE', `/api/feedback/${r.id}`)).status, 409);
  assert.equal((await app.call(admin, 'DELETE', `/api/feedback/${r.id}`)).status, 200);
});

test('API: an administrator sees a badge for new reports, and sending is limited', async () => {
  const n = await badge(admin);
  const r = (await send(eve, { title: 'For the badge' })).data;
  assert.equal(await badge(admin), n + 1);
  await app.call(admin, 'POST', `/api/feedback/${r.id}/seen`, {});
  assert.equal(await badge(admin), n);
  let last;
  for (let i = 0; i < 21; i++) last = await send(eve, { title: `Report ${i}` });
  assert.equal(last.status, 429);
});
