// The activity feed groups what one actor did to several items of one kind in a row, such as an extraction adding many facts.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid;

const F = (ref) => ({ ref, title: `Fact ${ref}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.' });
const feed = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data.activity;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Feed', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('forty facts added in a row make one line, with the latest two and the count', async () => {
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: Array.from({ length: 40 }, (_, i) => F(`f${i}`)) });
  assert.equal(r.status, 201);
  const lines = (await feed()).filter((x) => x.ref.type === 'fact');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'created'); assert.equal(lines[0].count, 40); assert.equal(lines[0].more.length, 1);
  assert.equal(lines[0].ref.title, 'Fact f39', 'the latest first');
});

test('another action in between starts a new line', async () => {
  await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Triples?' });
  await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [F('g1'), F('g2')] });
  const f = await feed();
  assert.deepEqual(f.slice(0, 3).map((x) => [x.ref.type, x.count]), [['fact', 2], ['question', 1], ['fact', 40]]);
});
