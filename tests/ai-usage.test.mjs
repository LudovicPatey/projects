// A person may make 40 AI requests in any 24 hours. The interface shows where they stand, and only their own requests count: the
// upkeep the platform queues while their client asks for work counts for nobody.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { usageView } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid;

before(async () => {
  app = await startApp({ config: { sweeps: { quiet_minutes: 0, check_minutes: 0 } } }); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Usage', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('each request counts, the platform\'s own upkeep does not, and the 41st waits with how long', async () => {
  const usage = async () => (await app.call(ann, 'GET', '/api/me/ai-usage')).data;
  assert.deepEqual(await usage(), { used: 0, limit: 40, window_hours: 24, next_free_at: null });
  // Facts make sweeps due; a client asking for work queues them on the owner's account: they are not requests.
  await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'm', facts: [{ ref: 'a', title: 'a', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'P.' }] });
  await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds: ['ask'], features: ['procedures'], capabilities: [] });
  assert.ok((await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.some((t) => t.source_type === 'sweep'), 'a sweep was queued');
  assert.equal((await usage()).used, 0, 'sweeps count for nobody');
  const first = await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'ask', prompt_text: 'Question 0?' });
  assert.equal(first.status, 201); assert.equal(first.data.usage.used, 1, 'the answer says where the person stands');
  assert.ok(Date.parse(first.data.usage.next_free_at) > Date.now() + 23 * 3600000);
  for (let i = 1; i < 40; i++) assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'ask', prompt_text: `Question ${i}?` })).status, 201);
  const page = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data;
  assert.equal(page.usage.used, 40, 'the AI page shows it too');
  const refused = await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'ask', prompt_text: 'One more?' });
  assert.equal(refused.status, 429);
  assert.match(refused.data.error, /used your 40 AI requests of the last 24 hours\. The next one is available in (23 h \d+ min|24 h)\./);
});

test('the meter: green, amber near the limit, red at it, with when the next request frees up', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  assert.equal(usageView(null), null);
  const low = usageView({ used: 3, limit: 40, next_free_at: '2026-11-27T09:30:00Z' }, now);
  assert.equal(low.tone, 'good'); assert.equal(low.left, 37); assert.equal(low.pct, 8);
  assert.equal(low.text, '37 left. Each request counts for 24 hours: the oldest frees up in 21 h 30 min.');
  assert.equal(usageView({ used: 33, limit: 40, next_free_at: '2026-11-26T12:20:00Z' }, now).tone, 'warn');
  const full = usageView({ used: 40, limit: 40, next_free_at: '2026-11-26T12:20:00Z' }, now);
  assert.equal(full.tone, 'bad'); assert.equal(full.text, 'Limit reached. The next request is available in 20 min.');
  assert.equal(usageView({ used: 0, limit: 40, next_free_at: null }, now).text, '40 left. Each request counts for 24 hours.');
  const view = fs.readFileSync('public/assets/js/views/ai.js', 'utf8');
  assert.match(view, /class="usage-meter"/); assert.match(view, /role="meter"/);
  assert.match(fs.readFileSync('public/assets/js/components.js', 'utf8'), /:disabled="busy \|\| disabled \|\| full"/, 'every AI button stops at the limit');
});
