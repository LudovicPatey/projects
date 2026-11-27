// Data an AI pass is still due on says so, with which pass, what it will do and what a person should do meanwhile, so that nobody takes
// it for final or fixes by hand what an AI is about to do.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { PENDING_PASSES, pendingView } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Pending', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('the notice names the pass, what it does, when it runs and what a person should do meanwhile', () => {
  assert.deepEqual(pendingView(null), []);
  assert.deepEqual(pendingView([{ sweep: 'unknown', open: false }]), []);
  const [v] = pendingView([{ sweep: 'review', open: true }]);
  assert.equal(v.name, 'Proof review');
  assert.match(v.text, /referees the proof.*Queued now.*People can review it too\./);
  assert.match(pendingView([{ sweep: 'rewrite', open: false }])[0].text, /once nobody has added facts for a while.*No need to rewrite it by hand\./);
  for (const k of ['rewrite', 'check', 'source', 'review', 'types', 'second']) assert.ok(PENDING_PASSES[k], k);
  for (const [file, re] of [['views/facts.js', /<ai-pending (?:compact )?:items="fact.ai_pending" :questions="fact.ai_questions"\/>/], ['views/notation.js', /<ai-pending :items="e.ai_pending"\/>/], ['views/consolidation.js', /<ai-pending v-if="s.status === 'proposed'" :items="s.ai_pending"/]]) {
    assert.match(fs.readFileSync(`public/assets/js/${file}`, 'utf8'), re, file);
  }
});

test('a fact says which passes it waits for, and loses them once done', async () => {
  const batch = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'm', facts: [
    { ref: 'p', title: 'Proved', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'P.' },
  ] })).data.created;
  const id = batch[0].id;
  const pending = async () => (await app.call(ann, 'GET', `/api/facts/${id}`)).data.ai_pending.map((p) => p.sweep);
  assert.deepEqual(await pending(), ['review'], 'a proof nobody reviewed waits for the proof review');
  await app.call(ann, 'POST', `/api/facts/${id}/reviews`, { verdict: 'correct', comment_text: 'Fine.' });
  assert.deepEqual(await pending(), [], 'reviewed: final');
});

test('an agreed entry nobody typed waits for the notation review', async () => {
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'Y \\leq X', meaning_text: '$Y \\subseteq FU(X)$.' })).data;
  await app.call(ann, 'POST', `/api/notation/${e.id}/status`, { status: 'agreed' });
  const entry = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.entries.find((x) => x.id === e.id);
  assert.deepEqual((await entry()).ai_pending, [{ sweep: 'types', open: false }]);
  await app.call(ann, 'PATCH', `/api/notation/${e.id}`, { params: [{ name: 'X', type: 'block sequences' }, { name: 'Y', type: 'block sequences' }] });
  assert.deepEqual((await entry()).ai_pending, []);
});
