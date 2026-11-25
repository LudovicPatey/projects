// A device stays signed in when its PHP session is gone (a phone closing the tab, the host clearing idle sessions),
// through a long-lived login cookie whose secret only the device knows. Signing out ends it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

let app;
const cookies = (r) => Object.fromEntries(r.headers.getSetCookie().map((c) => { const [kv, ...attrs] = c.split(';'); const i = kv.indexOf('='); return [kv.slice(0, i), { value: kv.slice(i + 1), attrs: attrs.join(';').toLowerCase() }]; }));
const me = async (cookie) => { const r = await fetch(`${app.base}/api/me`, { headers: { Cookie: cookie } }); return { body: await r.json(), set: cookies(r) }; };
const signIn = async (orcid) => cookies(await fetch(`${app.base}/auth/dev-login?orcid=${orcid}`, { redirect: 'manual' }));

before(async () => { app = await startApp(); });
after(() => app?.stop());

test('signing in leaves a login cookie for 60 days, with which a device whose session is gone is signed in again', async () => {
  const c = await signIn('0000-0002-1825-0097');
  const login = c.crp_login;
  assert.match(login.value, /^[0-9a-f]{24}\.[0-9a-f]{64}$/);
  assert.match(login.attrs, /httponly/); assert.match(login.attrs, /samesite=lax/); assert.match(login.attrs, /expires=/);
  const days = (Date.parse(login.attrs.match(/expires=([^;]+)/)[1]) - Date.now()) / 86400000;
  assert.ok(days > 59 && days <= 60, String(days));
  // No session cookie: as on a phone that closed the tab.
  const r = await me(`crp_login=${login.value}`);
  assert.equal(r.body.user.orcid, '0000-0002-1825-0097');
  assert.ok(r.set.crp_session, 'a new session'); assert.equal(r.set.crp_login.value, login.value, 'the same cookie, for another 60 days');
  const again = await me(`crp_session=${r.set.crp_session.value.split(';')[0]}`);
  assert.equal(again.body.user.orcid, '0000-0002-1825-0097', 'then the session carries on');
});

test('a wrong secret signs nobody in and ends that login; a malformed cookie is cleared', async () => {
  const login = (await signIn('0000-0001-5109-3700')).crp_login.value;
  const [selector] = login.split('.');
  const forged = await me(`crp_login=${selector}.${'0'.repeat(64)}`);
  assert.equal(forged.body.user, null); assert.match(forged.set.crp_login.value, /^(deleted)?$/, 'cleared');
  assert.equal((await me(`crp_login=${login}`)).body.user, null, 'the real cookie no longer works either: it may have been stolen');
  assert.match((await me('crp_login=nonsense')).set.crp_login.value, /^(deleted)?$/);
});

test('signing out ends the login of this device only', async () => {
  const a = await signIn('0000-0003-1415-9269'); const b = await signIn('0000-0003-1415-9269');
  const session = (await me(`crp_login=${a.crp_login.value}`)).set.crp_session.value;
  const csrf = (await me(`crp_session=${session}`)).body.csrf;
  const out = await fetch(`${app.base}/api/logout`, { method: 'POST', headers: { Cookie: `crp_session=${session}; crp_login=${a.crp_login.value}`, 'X-CSRF-Token': csrf } });
  assert.equal(out.status, 200, await out.text());
  assert.match(cookies(out).crp_login.value, /^(deleted)?$/);
  assert.equal((await me(`crp_login=${a.crp_login.value}`)).body.user, null);
  assert.equal((await me(`crp_login=${b.crp_login.value}`)).body.user.orcid, '0000-0003-1415-9269', 'the other device stays signed in');
});
