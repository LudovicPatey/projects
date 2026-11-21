// Open questions: tree logic, and the API on a throwaway copy of the application.
// The copy has its own SQLite database, so these tests never touch development data.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { answerActions, buildTree, mentionMatches, mentionQuery, progress, sortStrategies, unreadOf, validParents, visibleRows } from '../public/assets/js/questions-model.js';

const q = (id, parent_id = null, extra = {}) => ({ id, parent_id, title: `Q${id}`, status: 'open', priority: 'normal', strategies: [], ...extra });

test('the tree nests sub-questions and sorts them by priority', () => {
  const tree = buildTree([q(1), q(2, 1), q(3, 1, { priority: 'high' }), q(4, 3), q(5, 99)]);
  assert.deepEqual(tree.map((n) => n.id), [1, 5], 'a missing parent makes a root');
  assert.deepEqual(tree[0].children.map((n) => n.id), [3, 2]);
  assert.equal(tree[0].children[0].children[0].id, 4);
});

test('progress counts settled sub-questions at any depth', () => {
  const [root] = buildTree([q(1), q(2, 1, { status: 'solved' }), q(3, 1), q(4, 3, { status: 'refuted' }), q(5, 3, { status: 'partial' })]);
  assert.deepEqual(progress(root), { done: 2, total: 4 });
});

test('filters keep the ancestors of a match, and collapsing hides descendants', () => {
  const tree = buildTree([q(1), q(2, 1), q(3, 2, { title: 'Compactness', status: 'solved' }), q(4)]);
  const found = visibleRows(tree, { search: 'compact' });
  assert.deepEqual(found.map((r) => r.node.id), [1, 2, 3]);
  assert.deepEqual(found.map((r) => r.dimmed), [true, true, false]);
  assert.deepEqual(visibleRows(tree, { status: 'solved' }).map((r) => r.node.id), [1, 2, 3]);
  assert.deepEqual(visibleRows(tree, { status: 'unsettled' }).map((r) => r.node.id), [1, 2, 4]);
  assert.deepEqual(visibleRows(tree, { collapsed: [2] }).map((r) => r.node.id), [1, 2, 4]);
  assert.deepEqual(visibleRows(tree, { search: 'compact', collapsed: [1] }).map((r) => r.node.id), [1, 2, 3], 'a filter opens the branch');
});

test('a question cannot be moved under itself or a descendant', () => {
  const all = [q(1), q(2, 1), q(3, 2), q(4)];
  assert.deepEqual(validParents(all, 1).map((x) => x.id), [4]);
  assert.deepEqual(validParents(all, 2).map((x) => x.id), [1, 4]);
  assert.equal(validParents(all, null).length, 4);
});

test('unread counts include strategies, and live strategies come first', () => {
  assert.equal(unreadOf(q(1, null, { strategies: [{ id: 7 }, { id: 8 }] }), { oquestion: { 1: 2 }, strategy: { 8: 3 } }), 5);
  const order = sortStrategies([{ id: 1, status: 'failed', updated_at: '3' }, { id: 2, status: 'idea', updated_at: '2' }, { id: 3, status: 'active', updated_at: '1' }]);
  assert.deepEqual(order.map((s) => s.id), [3, 2, 1]);
});

test('the @ menu finds titles with spaces without trapping normal typing', () => {
  assert.equal(mentionQuery('See @Does the'), 'Does the');
  assert.equal(mentionQuery('@'), '');
  assert.equal(mentionQuery('mail a@b.org'), null);
  assert.equal(mentionQuery('line @one\ntwo'), null);
  const items = [{ type: 'user' }, { type: 'question' }];
  assert.equal(mentionMatches('alice', items).length, 2);
  assert.deepEqual(mentionMatches('does the', items), [{ type: 'question' }]);
  assert.equal(mentionMatches('alice and', [{ type: 'user' }]), null);
});

test('answer actions follow the ratification rules', () => {
  const a = (extra) => ({ id: 1, state: 'proposed', support: 'validated', proposed_by: 5, fact: { status: 'human_checked' }, ...extra });
  assert.equal(answerActions(a(), { me: 1, answers: [a()] }).ratify, true);
  for (const support of ['unvalidated', 'disputed', 'chain_broken', 'retracted', 'missing']) assert.equal(answerActions(a({ support }), { me: 1 }).ratify, false, support);
  assert.equal(answerActions(a(), { me: 1, answers: [a({ id: 2, state: 'ratified' })] }).ratify, false, 'one ratified answer per question');
  assert.equal(answerActions(a(), { me: 5 }).withdraw, true);
  assert.equal(answerActions(a(), { me: 1 }).withdraw, false);
  const done = answerActions(a({ state: 'ratified', support: 'disputed' }), { me: 1 });
  assert.deepEqual([done.ratify, done.reject, done.revoke, done.atRisk], [false, false, true, true]);
  assert.equal(answerActions(a({ state: 'rejected' }), { me: 5 }).review, false);
});

// ---------------------------------------------------------------------- API

const ALICE = '0000-0002-1825-0097';
const BOB = '0000-0001-5109-3700';
const EVE = '0000-0002-1694-233X';
let dir; let server; let base;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function signIn(orcid) {
  const r = await fetch(`${base}/auth/dev-login?orcid=${orcid}&name=${orcid.slice(-4)}`, { redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrf: me.csrf, id: me.user.id };
}

async function call(who, method, url, body) {
  const headers = { Accept: 'application/json' };
  if (who.token) headers.Authorization = `Bearer ${who.token}`;
  else { headers.Cookie = who.cookie; if (method !== 'GET') headers['X-CSRF-Token'] = who.csrf; }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

let alice; let bob; let eve; let ai; let pid;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-questions-'));
  for (const d of ['src', 'public', 'sql', 'bin']) fs.cpSync(d, path.join(dir, d), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'storage'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(dir, 'config/config.php'), `<?php return ['app_url' => '${base}', 'env' => 'dev', 'db' => ['dsn' => 'sqlite:' . __DIR__ . '/../storage/t.sqlite', 'user' => null, 'password' => null],
    'orcid' => ['client_id' => '', 'client_secret' => '', 'sandbox' => true], 'storage_path' => __DIR__ . '/../storage', 'max_upload_mb' => 8, 'project_creators' => []];`);
  execFileSync('php', ['bin/install.php'], { cwd: dir });
  execFileSync('php', ['bin/install.php'], { cwd: dir }); // the upgrade can run twice
  server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', 'public', 'bin/dev-router.php'], { cwd: dir, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/me`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  alice = await signIn(ALICE); bob = await signIn(BOB); eve = await signIn(EVE);
  pid = (await call(alice, 'POST', '/api/projects', { title: 'P', question_html: '<p>x</p>' })).data.id;
  assert.ok(pid);
  assert.equal((await call(alice, 'POST', `/api/projects/${pid}/members`, { orcid: BOB })).status < 300, true);
  ai = { token: (await call(bob, 'POST', '/api/me/keys', { name: 'client' })).data.token };
});

after(() => {
  server?.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const addQ = async (who, body) => (await call(who, 'POST', `/api/projects/${pid}/questions`, body)).data;

test('API: only members can reach questions', async () => {
  const q1 = await addQ(alice, { title: 'Private', body_text: 'Statement' });
  assert.equal((await call(eve, 'GET', `/api/projects/${pid}/questions`)).status, 403);
  assert.equal((await call(eve, 'GET', `/api/questions/${q1.id}`)).status, 403);
  assert.equal((await call(eve, 'PATCH', `/api/questions/${q1.id}`, { title: 'x' })).status, 403);
  assert.equal((await call(eve, 'POST', `/api/questions/${q1.id}/strategies`, { title: 'x' })).status, 403);
  const hits = await call(eve, 'GET', '/api/search?q=Private');
  assert.equal(hits.data.total, 0, 'search stays within the projects of the user');
});

test('API: validates input and refuses cycles', async () => {
  assert.equal((await call(alice, 'POST', `/api/projects/${pid}/questions`, { title: '  ' })).status, 422);
  assert.equal((await call(alice, 'POST', `/api/projects/${pid}/questions`, { title: 'x', status: 'nope' })).status, 422);
  assert.equal((await call(alice, 'POST', `/api/projects/${pid}/questions`, { title: 'x', parent_id: 99999 })).status, 422);
  const a = await addQ(alice, { title: 'A' });
  const b = await addQ(alice, { title: 'B', parent_id: a.id });
  const c = await addQ(bob, { title: 'C', parent_id: b.id });
  assert.deepEqual(c.path.map((p) => p.id), [a.id, b.id]);
  assert.equal((await call(alice, 'PATCH', `/api/questions/${a.id}`, { parent_id: c.id })).status, 422);
  assert.equal((await call(alice, 'PATCH', `/api/questions/${a.id}`, { parent_id: a.id })).status, 422);
  assert.equal((await call(alice, 'DELETE', `/api/questions/${b.id}`)).status, 409, 'it still has a sub-question');
  assert.equal((await call(bob, 'DELETE', `/api/questions/${a.id}`)).status, 403, 'neither its author nor an owner');
  assert.equal((await call(bob, 'DELETE', `/api/questions/${c.id}`)).status, 200);
  assert.equal((await call(alice, 'GET', `/api/questions/${c.id}`)).status, 404);
});

test('API: a strategy keeps its history, detects conflicts and restores', async () => {
  const x = await addQ(alice, { title: 'Evolving' });
  const made = await call(alice, 'POST', `/api/questions/${x.id}/strategies`, { title: 'Induction', body_text: 'First idea' });
  assert.equal(made.status, 201);
  const sid = made.data.id;
  const r2 = await call(bob, 'PATCH', `/api/strategies/${sid}`, { status: 'active', body_text: 'Second idea', change_note: 'Base case done', base_revision: 1 });
  assert.equal(r2.status, 200);
  assert.equal((await call(alice, 'PATCH', `/api/strategies/${sid}`, { body_text: 'Stale', base_revision: 1 })).status, 409);
  const same = await call(bob, 'PATCH', `/api/strategies/${sid}`, { status: 'active', base_revision: 2 });
  assert.equal(same.data.question.strategies[0].current_revision, 2, 'no change, no revision');
  const back = await call(alice, 'POST', `/api/strategies/${sid}/restore`, { revision_no: 1 });
  const s = back.data.question.strategies[0];
  assert.equal(s.current_revision, 3);
  assert.equal(s.status, 'idea');
  assert.match(s.body_text, /First idea/);
  assert.deepEqual(s.revisions.map((v) => v.revision_no), [3, 2, 1]);
  assert.equal(s.revisions[1].change_note, 'Base case done');
  assert.equal((await call(alice, 'POST', `/api/strategies/${sid}/restore`, { revision_no: 3 })).status, 422);
  assert.equal((await call(alice, 'POST', `/api/strategies/${sid}/restore`, { revision_no: 42 })).status, 404);
});

test('API: AI content names its model, and only humans declare a result', async () => {
  const human = await addQ(alice, { title: 'Human question', body_text: 'Original' });
  assert.equal((await call(ai, 'POST', `/api/projects/${pid}/questions`, { title: 'No model' })).status, 422);
  const made = await call(ai, 'POST', `/api/projects/${pid}/questions`, { title: 'AI question', ai_model: 'model-x', generation_seconds: 2.5, parent_id: human.id });
  assert.equal(made.status, 201);
  assert.equal(made.data.ai_model, 'model-x');
  assert.equal(made.data.ai_generation_ms, 2500);
  assert.equal((await call(ai, 'POST', `/api/projects/${pid}/questions`, { title: 'x', ai_model: 'm', status: 'solved' })).status, 403);
  assert.equal((await call(ai, 'PATCH', `/api/questions/${made.data.id}`, { status: 'solved', ai_model: 'm' })).status, 403);
  assert.equal((await call(ai, 'PATCH', `/api/questions/${human.id}`, { body_text: 'Rewritten', ai_model: 'm' })).status, 403);
  assert.equal((await call(ai, 'PATCH', `/api/questions/${human.id}`, { status: 'active' })).status, 200);
  const st = await call(ai, 'POST', `/api/questions/${human.id}/strategies`, { title: 'AI plan', ai_model: 'model-x' });
  assert.equal(st.status, 201);
  assert.equal((await call(ai, 'PATCH', `/api/strategies/${st.data.id}`, { status: 'succeeded', ai_model: 'm' })).status, 403);
  assert.equal((await call(ai, 'POST', `/api/strategies/${st.data.id}/restore`, { revision_no: 1 })).status, 403);
  assert.equal((await call(ai, 'DELETE', `/api/strategies/${st.data.id}`)).status, 403);
  assert.equal((await call(ai, 'DELETE', `/api/questions/${made.data.id}`)).status, 403);
  assert.equal((await call(bob, 'PATCH', `/api/strategies/${st.data.id}`, { status: 'succeeded' })).status, 200);
  const rev = (await call(bob, 'GET', `/api/questions/${human.id}`)).data.strategies[0].revisions;
  assert.equal(rev[1].ai_model, 'model-x');
  assert.equal(rev[0].ai_model, null, 'the human revision is not attributed to the model');
});

test('API: unread badges, comments, links and search', async () => {
  const x = await addQ(alice, { title: 'Zorn lemma route', body_text: 'About chains' });
  const counters = async (who) => (await call(who, 'GET', `/api/counters?project=${pid}`)).data;
  assert.ok((await counters(bob)).unread.oquestion[x.id], 'new for the other member');
  assert.ok(!(await counters(alice)).unread.oquestion?.[x.id], 'not new for its author');
  const st = await call(alice, 'POST', `/api/questions/${x.id}/strategies`, { title: 'Maximal chain', body_text: 'Use @{user:' + bob.id + '}' });
  assert.ok((await counters(bob)).unread.strategy[st.data.id]);
  const notes = (await call(bob, 'GET', '/api/notifications')).data.notifications;
  assert.ok(notes.some((n) => n.payload.link?.strategy === st.data.id), 'a mention opens the strategy');
  const c = await call(bob, 'POST', '/api/comments', { target_type: 'strategy', target_id: st.data.id, body_text: 'Nice idea' });
  assert.equal(c.status, 201);
  assert.equal((await call(alice, 'GET', `/api/comments?type=strategy&id=${st.data.id}`)).data.threads.length, 1);
  assert.equal((await call(eve, 'GET', `/api/comments?type=strategy&id=${st.data.id}`)).status, 403);
  assert.equal((await call(alice, 'POST', `/api/questions/${x.id}/links`, { target_type: 'fact', target_id: 12345 })).status, 422);
  assert.equal((await call(alice, 'POST', `/api/questions/${x.id}/links`, { target_type: 'project', target_id: pid })).status, 422);
  const types = async (term) => (await call(alice, 'GET', `/api/search?q=${term}&project=${pid}&scope=project`)).data.groups.map((g) => g.type);
  assert.ok((await types('zorn')).includes('question'));
  assert.ok((await types('maximal')).includes('strategy'));
  assert.equal((await call(alice, 'POST', `/api/projects/${pid}/read-all`, { type: 'strategy' })).status, 200);
  assert.equal((await call(alice, 'DELETE', `/api/strategies/${st.data.id}`)).status, 200);
  assert.ok(!(await types('maximal')).includes('strategy'));
  assert.ok(!(await counters(bob)).unread.strategy?.[st.data.id], 'a deleted strategy leaves the badges');
  assert.equal((await call(bob, 'GET', `/api/projects/${pid}/help-context`)).status, 200);
  assert.ok((await call(ai, 'GET', `/api/projects/${pid}/context`)).data.open_questions.some((o) => o.id === x.id));
});

let factNo = 0;
const addFact = async (extra = {}) => {
  factNo += 1;
  const r = await call(ai, 'POST', `/api/projects/${pid}/facts`, { title: `Fact ${factNo}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', ai_model: 'model-x',
    statement_text: `Statement ${factNo}`, proof_text: 'Proof.', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const review = (who, f, verdict, extra = {}) => call(who, 'POST', `/api/facts/${f.id}/reviews`, { verdict, ...(verdict === 'correct' ? {} : { body_text: 'Step 2 is wrong' }), ...extra });
const propose = (who, q0, f, answer = 'positive', extra = {}) => call(who, 'POST', `/api/questions/${q0.id}/answers`, { answer, fact_id: f.id, body_text: 'It implies the claim', ai_model: 'model-x', ...extra });
const getQ = async (id) => (await call(alice, 'GET', `/api/questions/${id}`)).data;

test('API: proposing an answer is validated and changes nothing', async () => {
  const x = await addQ(alice, { title: 'Proposal rules' });
  const f = await addFact();
  assert.equal((await propose(eve, x, f)).status, 403);
  assert.equal((await propose(ai, x, f, 'maybe')).status, 422);
  assert.equal((await propose(ai, x, { id: 99999 })).status, 422);
  assert.equal((await call(ai, 'POST', `/api/questions/${x.id}/answers`, { answer: 'positive', fact_id: f.id, ai_model: 'm' })).status, 422, 'AI must explain');
  assert.equal((await call(ai, 'POST', `/api/questions/${x.id}/answers`, { answer: 'positive', fact_id: f.id, body_text: 'x' })).status, 422, 'AI must name its model');
  const made = await propose(ai, x, f);
  assert.equal(made.status, 201);
  assert.equal((await propose(ai, x, f)).status, 409, 'no duplicate');
  const q1 = await getQ(x.id);
  assert.equal(q1.status, 'open');
  assert.equal(q1.answers[0].ai_model, 'model-x');
  assert.equal(q1.answers[0].support, 'unvalidated');
  assert.equal((await call(alice, 'POST', `/api/answers/${made.data.id}/withdraw`)).status, 403, 'not its author');
  assert.equal((await call(ai, 'POST', `/api/answers/${made.data.id}/withdraw`)).status, 200);
  assert.equal((await getQ(x.id)).answers[0].state, 'withdrawn');
});

test('API: only a human ratifies, and only an endorsed fact', async () => {
  const x = await addQ(alice, { title: 'Ratification' });
  const f = await addFact();
  const id = (await propose(ai, x, f)).data.id;
  const agent = { token: (await call(alice, 'POST', `/api/projects/${pid}/agents`, { name: 'Prover', ai_model: 'model-y' })).data.token };
  for (const who of [ai, agent]) {
    assert.equal((await call(who, 'POST', `/api/answers/${id}/ratify`)).status, 403);
    assert.equal((await call(who, 'POST', `/api/answers/${id}/reject`, { note: 'no' })).status, 403);
  }
  assert.equal((await call(eve, 'POST', `/api/answers/${id}/ratify`)).status, 403);
  assert.equal((await call(alice, 'POST', `/api/answers/${id}/ratify`)).status, 409, 'not endorsed');
  assert.equal((await review(agent, f, 'correct', { ai_model: 'model-y' })).status < 300, true);
  assert.equal((await call(alice, 'POST', `/api/answers/${id}/ratify`)).status, 409, 'an AI check is not a human endorsement');
  assert.equal((await review(bob, f, 'correct')).status < 300, true);
  const done = await call(alice, 'POST', `/api/answers/${id}/ratify`);
  assert.equal(done.status, 200);
  assert.equal(done.data.status, 'solved');
  assert.equal(done.data.answers[0].ratified_by, alice.id);
  assert.equal((await call(alice, 'POST', `/api/answers/${id}/ratify`)).status, 409);
  assert.equal((await call(alice, 'PATCH', `/api/questions/${x.id}`, { status: 'open' })).status, 409, 'the status is locked');
  assert.equal((await propose(ai, x, await addFact(), 'negative')).status, 409, 'already answered');
  assert.equal((await call(alice, 'DELETE', `/api/facts/${f.id}`)).status, 409, 'a ratified fact cannot be deleted');

  // A denial flags the answer and alerts its ratifier, but only a human reopens the question.
  assert.equal((await review(bob, f, 'incorrect')).status < 300, true);
  const flagged = await getQ(x.id);
  assert.equal(flagged.status, 'solved');
  assert.equal(flagged.answers[0].support, 'disputed');
  const notes = (await call(alice, 'GET', '/api/notifications')).data.notifications;
  assert.ok(notes.some((n) => n.kind === 'answer_fact' && n.payload.link.id === x.id));
  assert.ok((await call(alice, 'GET', `/api/projects/${pid}/questions`)).data.questions.find((o) => o.id === x.id).answer_at_risk);
  assert.equal((await call(alice, 'POST', `/api/answers/${id}/revoke`, {})).status, 422, 'a reason is required');
  assert.equal((await call(ai, 'POST', `/api/answers/${id}/revoke`, { note: 'x' })).status, 403);
  const back = await call(alice, 'POST', `/api/answers/${id}/revoke`, { note: 'Fact denied' });
  assert.equal(back.data.status, 'active');
  assert.equal(back.data.answers[0].state, 'revoked');
  assert.equal(back.data.answers[0].ratified_by, alice.id, 'the record is kept');
});

test('API: a negative answer refutes, and a broken dependency blocks ratification', async () => {
  const x = await addQ(alice, { title: 'Negative' });
  const f = await addFact({ kind: 'counterexample', labels: ['counterexample'] });
  await review(alice, f, 'correct');
  const id = (await propose(ai, x, f, 'negative')).data.id;
  assert.equal((await call(alice, 'POST', `/api/answers/${id}/ratify`)).data.status, 'refuted');

  const base = await addFact();
  const top = await addFact({ depends_on: [base.id] });
  await review(alice, top, 'correct');
  await review(bob, base, 'incorrect');
  const y = await addQ(alice, { title: 'Broken chain' });
  const a2 = (await propose(ai, y, top)).data.id;
  assert.equal((await getQ(y.id)).answers[0].support, 'chain_broken');
  assert.equal((await call(alice, 'POST', `/api/answers/${a2}/ratify`)).status, 409);
  assert.equal((await call(alice, 'POST', `/api/answers/${a2}/reject`, {})).status, 422);
  assert.equal((await call(alice, 'POST', `/api/answers/${a2}/reject`, { note: 'Relies on a denied lemma' })).status, 200);
  assert.equal((await getQ(y.id)).answers[0].closed_note, 'Relies on a denied lemma');
});

test('API: messages and comments can mention questions and strategies', async () => {
  const x = await addQ(alice, { title: 'Mentioned question' });
  const sid = (await call(alice, 'POST', `/api/questions/${x.id}/strategies`, { title: 'Mentioned strategy' })).data.id;
  const text = `See @{question:${x.id}} and @{strategy:${sid}}`;
  const shared = await call(alice, 'POST', `/api/projects/${pid}/conversations`, { subject: 'Shared', body_text: text, participant_ids: [bob.id] });
  assert.equal(shared.status, 201, JSON.stringify(shared.data));
  await call(alice, 'POST', `/api/projects/${pid}/conversations`, { subject: 'Secret subject', body_text: text, participant_ids: [] });
  const c = await call(bob, 'POST', '/api/comments', { target_type: 'oquestion', target_id: x.id, body_text: `Compare @{strategy:${sid}}` });
  assert.equal(c.status, 201);
  const back = async (who, type, id) => (await call(who, 'GET', `/api/projects/${pid}/backlinks?type=${type}&target=${id}`)).data.backlinks;
  const forAlice = await back(alice, 'question', x.id);
  assert.ok(forAlice.some((b) => b.label === 'Secret subject'));
  const forBob = await back(bob, 'question', x.id);
  assert.ok(forBob.some((b) => b.label === 'Shared'));
  assert.ok(!forBob.some((b) => b.label === 'Secret subject'), 'a private conversation stays private');
  assert.ok((await back(bob, 'strategy', sid)).some((b) => b.kind === 'comment' && b.link.view === 'questions'));
  const names = await call(bob, 'GET', `/api/projects/${pid}/mentionables`);
  assert.ok(names.data.questions.some((o) => o.id === x.id));
  assert.equal(names.data.strategies.find((o) => o.id === sid).question_id, x.id);
  assert.equal((await call(bob, 'GET', `/api/strategies/${sid}`)).data.question_id, x.id);
  assert.equal((await call(eve, 'GET', `/api/strategies/${sid}`)).status, 403);
  const msg = (await call(ai, 'GET', `/api/conversations/${shared.data.id}`)).data;
  const round = JSON.stringify(msg);
  assert.ok(round.includes(`data-type=\\"question\\"`) || round.includes(`@{question:${x.id}}`));
  const unknown = await call(alice, 'POST', `/api/projects/${pid}/conversations`, { subject: 'Unknown', body_text: 'See @{question:99999}', participant_ids: [] });
  assert.equal(unknown.status, 201, 'an unknown reference stays as plain text');
  assert.equal((await call(alice, 'DELETE', `/api/strategies/${sid}`)).status, 200);
  assert.ok(!(await call(bob, 'GET', `/api/projects/${pid}/mentionables`)).data.strategies.some((o) => o.id === sid));
});
