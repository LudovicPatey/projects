// The scheduler: AI clients take light work someone waits for before heavy background work, a member's own request before the
// same work queued by the platform, and a task only once the tasks it depends on are finished. The page shows the queue by kind.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid; let doc;

const overview = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data;
const claim = (kinds) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds,
  features: ['procedures', 'review', 'notation', 'consolidate', 'extract_bib', 'extract_conversation'], capabilities: ['web_search', 'document'] });
const release = (t) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Scheduler', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const F = (ref) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.' });
  await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: [F('a'), F('b')] });
  const f = new FormData();
  f.set('title', 'Notes'); f.set('origin', 'human'); f.set('pdf', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'p.pdf');
  doc = await (await fetch(`${app.base}/api/projects/${pid}/documents`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf, Accept: 'application/json' }, body: f })).json();
});
after(() => app?.stop());

test('a question to the AI runs before an extraction queued earlier, and a member\'s request before the platform\'s', async () => {
  const tasks = (await overview()).tasks;
  const extract = tasks.find((t) => t.kind === 'extract');
  assert.ok(extract, 'the note was queued for extraction'); assert.equal(extract.priority, 70);
  const asked = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate' })).data;
  assert.equal(asked.priority, 30, 'a member asked: before the same work queued by the platform');
  assert.deepEqual(asked.waits_for, [extract.id], 'a consolidation waits for the extraction adding facts');
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'ask', prompt_text: 'Is lemma a sharp?' })).data;
  assert.equal(q.priority, 0);
  let t = (await claim(['extract', 'ask', 'consolidate'])).data.task;
  assert.equal(t.id, q.id, 'the question first');
  await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {});
  t = (await claim(['extract', 'ask', 'consolidate'])).data.task;
  assert.equal(t.id, extract.id, 'then the extraction: the consolidation waits for it');
  await release(t);
  assert.equal((await claim(['consolidate'])).data.task, null, 'still waiting for the extraction');
  await app.call(ann, 'POST', `/api/ai/tasks/${extract.id}/cancel`, {});
  t = (await claim(['consolidate'])).data.task;
  assert.equal(t.id, asked.id, 'the extraction is over: the consolidation runs');
  await release(t);
});

test('the page shows the queue by kind, with how many are done, running and waiting, and when all of a kind wait for others', async () => {
  const d = await overview();
  const g = Object.fromEntries(d.groups.map((x) => [x.group, x]));
  assert.deepEqual(g.ask.counts, { pending: 0, running: 0, done: 0, failed: 0, cancelled: 1 });
  assert.equal(g.extract.counts.cancelled, 1);
  assert.equal(g.consolidate.counts.pending, 1); assert.equal(g.consolidate.blocked, false);
  assert.equal(d.groups[0].group, 'consolidate', 'what runs next comes first');
  const first = d.tasks.findIndex((t) => t.status !== 'pending' && t.status !== 'running');
  assert.ok(d.tasks.slice(0, first).every((t) => ['pending', 'running'].includes(t.status)), 'open tasks first, in the order they will run');
});
