// The reference system of rich text, and the dashboards built on it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { REF_ORDER, REF_TYPES, activityVerb, parseRefQuery, refHref, sortRefs, statusInfo } from '../public/assets/js/references.js';
import { ARTICLES } from '../public/assets/js/help/content.js';
import { startApp } from './harness.mjs';

test('browser and server know the same reference types', () => {
  const php = fs.readFileSync('src/References.php', 'utf8').match(/TYPES = \[([\s\S]*?)\];/)[1];
  const server = [...php.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...server].sort(), [...REF_ORDER].sort());
  const icons = fs.readFileSync('public/assets/js/components.js', 'utf8');
  for (const t of REF_ORDER) {
    assert.ok(REF_TYPES[t].label && REF_TYPES[t].plural, t);
    assert.ok(icons.includes(`${REF_TYPES[t].icon}:`) || icons.includes(`'${REF_TYPES[t].icon}':`), `no icon for ${t}`);
  }
  const aliases = REF_ORDER.flatMap((t) => REF_TYPES[t].aliases);
  assert.equal(new Set(aliases).size, aliases.length, 'an alias points to one type');
});

test('the @ menu understands type filters', () => {
  assert.deepEqual(parseRefQuery('fact:lemma 3'), { type: 'fact', term: 'lemma 3' });
  assert.deepEqual(parseRefQuery('q:'), { type: 'question', term: '' });
  assert.deepEqual(parseRefQuery('MSG:hello'), { type: 'message', term: 'hello' });
  assert.deepEqual(parseRefQuery('thm:reduction'), { type: null, term: 'thm:reduction' }, 'a fact label is not a filter');
  assert.deepEqual(parseRefQuery('plain words'), { type: null, term: 'plain words' });
  assert.deepEqual(sortRefs([{ type: 'user', id: 1 }, { type: 'fact', id: 2 }, { type: 'question', id: 3 }, { type: 'fact', id: 4 }]).map((x) => x.id), [3, 2, 4, 1]);
});

test('links, statuses and activity wording', () => {
  assert.equal(refHref({ link: { view: 'questions', id: 4, query: { strategy: 9 } } }, 2), '#/p/2/questions/4?strategy=9');
  assert.equal(refHref({ link: { view: 'overview' } }, 2), '#/p/2/overview');
  assert.equal(refHref({ link: null }, 2), null);
  assert.deepEqual(statusInfo('ratified'), { label: 'Ratified', tone: 'good' });
  assert.equal(statusInfo(null), null);
  assert.equal(statusInfo('strange_state').label, 'strange state');
  assert.equal(activityVerb('ratified'), 'ratified an answer to');
  assert.equal(activityVerb('unknown'), 'updated');
});

test('the help explains every reference type', () => {
  const a = ARTICLES.find((x) => x.slug === 'references');
  assert.ok(a);
  const text = JSON.stringify(a.blocks).toLowerCase();
  for (const t of REF_ORDER) assert.ok(text.includes(REF_TYPES[t].label.toLowerCase()), REF_TYPES[t].label);
});

// ---------------------------------------------------------------------- API

const ALICE = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X';
let app; let alice; let bob; let eve; let key; let pid; let other; const ids = {};
const resolve = async (who, keys, project = pid) => (await app.call(who, 'GET', `/api/projects/${project}/refs/resolve?keys=${encodeURIComponent(keys.join(','))}`));
const SECRET = 'Zanzibar confidential plan';

before(async () => {
  app = await startApp();
  const { call, signIn } = app;
  alice = await signIn(ALICE); bob = await signIn(BOB); eve = await signIn(EVE);
  pid = (await call(alice, 'POST', '/api/projects', { title: 'P', question_html: '<p>x</p>' })).data.id;
  other = (await call(eve, 'POST', '/api/projects', { title: 'Other', question_html: '<p>y</p>' })).data.id;
  await call(alice, 'POST', `/api/projects/${pid}/members`, { orcid: BOB });
  key = { token: (await call(alice, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  ids.question = (await call(alice, 'POST', `/api/projects/${pid}/questions`, { title: 'Open $x$' })).data.id;
  const st = await call(alice, 'POST', `/api/questions/${ids.question}/strategies`, { title: 'Plan', body_text: 'Idea' });
  ids.strategy = st.data.id; ids.revision = st.data.question.strategies[0].revisions[0].id;
  ids.fact = (await call(key, 'POST', `/api/projects/${pid}/facts`, { title: 'Key lemma', kind: 'lemma', labels: ['conclusion'], method: 'deduced', ai_model: 'm', statement_text: 'S', proof_text: 'P' })).data.id;
  ids.review = (await call(bob, 'POST', `/api/facts/${ids.fact}/reviews`, { verdict: 'correct' })).data.reviews[0].id;
  ids.lean = (await call(key, 'POST', `/api/facts/${ids.fact}/lean`, { code: 'theorem t : True := trivial', ai_model: 'm' })).data.lean_proofs[0].id;
  ids.answer = (await call(key, 'POST', `/api/questions/${ids.question}/answers`, { answer: 'positive', fact_id: ids.fact, body_text: 'Why', ai_model: 'm' })).data.id;
  ids.bib = (await call(alice, 'POST', `/api/projects/${pid}/bib`, { bibtex: '@article{smith2020, title={A title}, author={Smith, A.}, year={2020}}' })).data.created[0];
  ids.conversation = (await call(alice, 'POST', `/api/projects/${pid}/conversations`, { subject: SECRET, body_text: `Body ${SECRET}`, participant_ids: [] })).data.id;
  ids.message = (await call(alice, 'GET', `/api/conversations/${ids.conversation}`)).data.messages[0].id;
  ids.comment = (await call(alice, 'POST', '/api/comments', { target_type: 'conversation', target_id: ids.conversation, body_text: `Note ${SECRET}` })).data.id;
  ids.publicComment = (await call(bob, 'POST', '/api/comments', { target_type: 'fact', target_id: ids.fact, body_text: 'Public note' })).data.id;
});
after(() => app?.stop());

test('API: every kind of object can be resolved and linked', async () => {
  const keys = ['question', 'strategy', 'revision', 'answer', 'fact', 'review', 'lean', 'conversation', 'message', 'comment', 'bib'].map((t) => `${t}:${ids[t]}`);
  keys.push(`user:${bob.id}`, `project:${pid}`);
  const refs = (await resolve(alice, keys)).data.refs;
  for (const k of keys) {
    assert.equal(refs[k]?.state, 'ok', k);
    assert.ok(refs[k].label, k);
    assert.ok(refs[k].link?.view, k);
    assert.equal(refs[k].text, undefined, 'the full text is not sent');
  }
  assert.equal(refs[`strategy:${ids.strategy}`].link.query.strategy, ids.strategy);
  assert.equal(refs[`message:${ids.message}`].link.query.message, ids.message);
  assert.equal(refs[`comment:${ids.comment}`].link.query.comment, ids.comment);
  assert.equal(refs[`lean:${ids.lean}`].link.query.tab, 'lean');
});

test('API: a private conversation stays private in references', async () => {
  const keys = ['conversation', 'message', 'comment'].map((t) => `${t}:${ids[t]}`);
  const seen = await resolve(bob, [...keys, 'conversation:987654']);
  for (const k of keys) {
    assert.equal(seen.data.refs[k].state, 'private', k);
    assert.equal(seen.data.refs[k].link, null);
  }
  assert.equal(seen.data.refs['conversation:987654'].state, 'private', 'hidden and missing look the same');
  assert.ok(!JSON.stringify(seen.data).includes('Zanzibar'));
  assert.ok(!JSON.stringify((await app.call(bob, 'GET', `/api/projects/${pid}/refs?q=Zanzibar`)).data).includes('Zanzibar'));
  assert.ok((await app.call(alice, 'GET', `/api/projects/${pid}/refs?q=Zanzibar`)).data.results.length >= 2);
  assert.ok(!JSON.stringify((await app.call(bob, 'GET', `/api/projects/${pid}/dashboard`)).data).includes('Zanzibar'), 'nor in the dashboard');
  // A label sent by the browser cannot carry a private title into a public place.
  const forged = `<p><span class="mention" data-type="conversation" data-id="${ids.conversation}" data-label="${SECRET}">@x</span></p>`;
  const c = await app.call(alice, 'POST', '/api/comments', { target_type: 'fact', target_id: ids.fact, body_html: forged });
  assert.equal(c.status, 201);
  const threads = (await app.call(bob, 'GET', `/api/comments?type=fact&id=${ids.fact}`)).data.threads;
  assert.ok(!JSON.stringify(threads).includes('Zanzibar'));
  assert.ok(JSON.stringify(threads).includes(`conversation #${ids.conversation}`));
});

test('API: references respect project boundaries and input', async () => {
  assert.equal((await resolve(eve, [`fact:${ids.fact}`])).status, 403);
  assert.equal((await app.call(eve, 'GET', `/api/projects/${pid}/refs?q=x`)).status, 403);
  assert.equal((await app.call(eve, 'GET', `/api/projects/${pid}/dashboard`)).status, 403);
  const cross = (await resolve(eve, [`fact:${ids.fact}`, `question:${ids.question}`, `project:${pid}`, `user:${alice.id}`], other)).data.refs;
  for (const v of Object.values(cross)) assert.equal(v.state, 'missing');
  assert.deepEqual(Object.keys((await resolve(alice, ['nonsense:1', 'fact:abc', "fact:1' OR 1=1"])).data.refs), []);
  assert.equal((await app.call(alice, 'GET', `/api/projects/${pid}/refs?q=x&type=nope`)).status, 422);
  const email = await app.call(alice, 'PATCH', '/api/me', { email: 'private@example.org' });
  assert.equal(email.status, 200);
  assert.ok(!JSON.stringify((await app.call(bob, 'GET', `/api/projects/${pid}/refs?q=private@example`)).data.results).includes('example.org'));
});

test('API: references written as text by an AI client or agent', async () => {
  const agent = { token: (await app.call(alice, 'POST', `/api/projects/${pid}/agents`, { name: 'Bot', ai_model: 'm' })).data.token };
  const text = `See @{answer:${ids.answer}}, @{lean:${ids.lean}}, @{revision:${ids.revision}}, @{message:${ids.message}} and @{project:${pid}}`;
  const made = await app.call(agent, 'POST', '/api/comments', { target_type: 'oquestion', target_id: ids.question, body_text: text });
  assert.equal(made.status, 201);
  const html = (await app.call(alice, 'GET', `/api/comments?type=oquestion&id=${ids.question}`)).data.threads.at(-1).body_html;
  for (const t of ['answer', 'lean', 'revision', 'message', 'project']) assert.ok(html.includes(`data-type="${t}"`), t);
  assert.ok(!html.includes('Zanzibar'));
  const back = await app.call(alice, 'GET', `/api/projects/${pid}/backlinks?type=answer&target=${ids.answer}`);
  assert.ok(back.data.backlinks.length >= 1);
});

test('API: the dashboard counts and work lists', async () => {
  const d = (await app.call(alice, 'GET', `/api/projects/${pid}/dashboard`)).data;
  assert.equal(d.questions.total, 1);
  assert.equal(d.questions.roots[0].pending, 1);
  assert.ok(d.actions.some((a) => a.kind === 'ratify'));
  assert.equal(d.facts.endorsed, 1);
  assert.equal(d.conversations.total, 1);
  assert.equal((await app.call(bob, 'GET', `/api/projects/${pid}/dashboard`)).data.conversations.total, 0);
  assert.ok(d.activity.length > 0);
  assert.equal(d.people[alice.id].questions, 1);
  const feed = async (who, section) => (await app.call(who, 'GET', `/api/projects/${pid}/activity?section=${section}`));
  assert.ok((await feed(alice, 'facts')).data.activity.every((x) => x.ref.type === 'fact'));
  assert.ok((await feed(alice, 'conversations')).data.activity.length >= 1);
  assert.equal((await feed(bob, 'conversations')).data.activity.length, 0, 'a private conversation stays out of the feed');
  assert.equal((await feed(eve, 'facts')).status, 403);
  assert.equal((await feed(alice, 'nope')).status, 422);
  const list = (await app.call(alice, 'GET', '/api/projects')).data.projects[0];
  assert.equal(list.counts.questions, 1);
  assert.ok(list.people.length >= 2);
  assert.ok(!JSON.stringify(list.people).includes('email'));
});
