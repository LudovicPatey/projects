// Facts can be extracted from a conversation, without ever widening who can read it by accident.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { conversationExtraction, privateExtractionNotice, requestBody } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X';
const CLIENT = path.resolve('client/oq.py');
const FEATURES = ['extract_bib', 'extract_comments', 'extract_conversation'];
let app; let ann; let bob; let eve; let annKey; let eveKey; let pid; let tmp; let bin;

const conv = async (subject, text, participants) => (await app.call(ann, 'POST', `/api/projects/${pid}/conversations`, { subject, body_text: text, participant_ids: participants })).data.id;
const ask = (who, id, extra = {}) => app.call(who, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'conversation', source_id: id, ...extra });
const claim = async (key = annKey, features = FEATURES, model = 'claude-opus-5-5') => (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'x', models: { extract: model }, kinds: ['extract'], project_id: pid, features })).data.task;
const finish = (t, key = annKey) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'claude-opus-5-5', summary: 'ok' });
const clear = async () => { for (const t of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) if (['pending', 'running'].includes(t.status)) await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {}); };
const state = async (id) => (await app.call(ann, 'GET', `/api/conversations/${id}`)).data.extraction;
const task = async (id) => (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.find((t) => t.id === id);
const say = async (id, text, who = ann) => (await app.call(who, 'POST', `/api/conversations/${id}/messages`, { body_text: text })).data.id;
const everyone = () => [bob.id, eve.id];

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Talks', question_html: '<p>Q</p>' })).data.id;
  for (const o of [BOB, EVE]) assert.ok((await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: o })).status < 300);
  annKey = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'a' })).data.token };
  eveKey = { token: (await app.call(eve, 'POST', '/api/me/keys', { name: 'e' })).data.token };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-conv-')); bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('the interface helpers describe the state and the sharing', () => {
  assert.deepEqual(requestBody({ kind: 'extract', document: 'conv:5', prompt: '' }), { kind: 'extract', source_type: 'conversation', source_id: 5 });
  assert.equal(requestBody({ kind: 'extract', document: 'conv:5', publishPrivate: true }).publish_private, true);
  assert.equal(conversationExtraction({ state: 'new_messages' }).label, 'Extract new messages');
  assert.equal(conversationExtraction({ state: 'queued' }).disabled, true);
  assert.match(privateExtractionNotice(2), /2 project members cannot read it/);
});

test('a conversation is never queued by itself, and an outsider cannot ask or learn it exists', async () => {
  await clear();
  const id = await conv('Open to all', 'Every finite graph has property P by induction.', everyone());
  assert.equal((await state(id)).state, 'none');
  assert.equal(await claim(), null);
  const hidden = await conv('Only Bob', 'A hidden statement about graphs.', [bob.id]);
  const r = await ask(eve, hidden, { publish_private: true });
  assert.equal(r.status, 404);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'ask', prompt_text: 'x', source_type: 'conversation', source_id: id })).status, 422);
});

test('a private conversation needs explicit approval, reaches only participants and notifies them', async () => {
  await clear();
  const id = await conv('Private idea', 'Lemma: the private bound holds for all n.', [bob.id]);
  assert.equal((await state(id)).private, true);
  assert.equal((await ask(ann, id)).status, 422);
  assert.equal((await ask(ann, id, { publish_private: 'yes' })).status, 422);
  const made = await ask(ann, id, { publish_private: true });
  assert.equal(made.status, 201);
  assert.equal((await app.call(eve, 'GET', `/api/projects/${pid}/ai`)).data.tasks.some((t) => t.id === made.data.id), false);
  assert.equal(await claim(eveKey), null);
  const notes = (await app.call(bob, 'GET', '/api/notifications')).data;
  assert.ok(JSON.stringify(notes).includes('conversation_extract'));
  const t = await claim();
  assert.equal(t.publish_private, true);
  assert.equal(t.context.conversation.messages[0].text.includes('private bound'), true);
  const mid = t.context.conversation.messages[0].id;
  const batch = await app.call(annKey, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', publish_private: true, facts: [{ ref: 'p', title: 'Private bound', kind: 'lemma', labels: ['conclusion'], method: 'extracted', statement_text: 'The private bound holds.', sources: [{ type: 'message', id: mid, quote: 'the private bound holds', covers: 'statement' }] }] });
  assert.equal(batch.status, 201);
  await finish(t);
  const seen = (await app.call(eve, 'GET', `/api/facts/${batch.data.created[0].id}`)).data;
  assert.equal(seen.sources[0].hidden, true); assert.equal(seen.sources[0].quote, null); assert.equal(seen.sources[0].link, null);
  assert.equal((await state(id)).state, 'done');
});

test('later messages are not read, and editing an approved message stops the task', async () => {
  await clear();
  const id = await conv('Snapshot', 'Claim: the approved statement is true.', [bob.id]);
  const first = await ask(ann, id, { publish_private: true });
  await say(id, 'A secret written after the approval.', bob);
  const t = await claim();
  assert.deepEqual(t.context.conversation.messages.map((m) => m.text.includes('secret')), [false]);
  await finish(t);
  assert.equal((await state(id)).state, 'new_messages');
  const id2 = await conv('Edited', 'Claim: this text was approved.', [bob.id]);
  const m = (await app.call(ann, 'GET', `/api/conversations/${id2}`)).data.messages[0].id;
  const second = await ask(ann, id2, { publish_private: true });
  await app.call(ann, 'PATCH', `/api/messages/${m}`, { body_text: 'Claim: this text was changed afterward.' });
  assert.equal(await claim(), null);
  const failed = await task(second.data.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error_text, /edited after/);
  assert.ok(first.data.id);
});

test('a conversation that becomes private needs a new approval', async () => {
  await clear();
  const id = await conv('Was open', 'Claim: this one was open to everybody.', everyone());
  const t = await ask(ann, id);
  assert.equal(t.status, 201);
  await app.call(eve, 'POST', `/api/conversations/${id}/leave`, {});
  assert.equal(await claim(), null);
  const after_ = await task(t.data.id);
  assert.equal(after_.status, 'failed'); assert.match(after_.error_text, /became private/);
});

test('an older client is not offered it, and a stronger result is not repeated', async () => {
  await clear();
  const id = await conv('Models', 'Claim: models are ordered by strength here.', everyone());
  await ask(ann, id);
  assert.equal(await claim(annKey, ['extract_bib', 'extract_comments']), null);
  await finish(await claim());
  const again = await ask(ann, id);
  assert.equal(again.status, 201);
  assert.equal(await claim(annKey, FEATURES, 'claude-sonnet-5-5'), null);
  await clear();
});

test('the client cites the exact message, drops an invented quote, and links a comment', async () => {
  await clear();
  const id = await conv('Real run', 'Theorem: every planar graph here is five colorable.', everyone());
  const second = await say(id, 'Maybe all graphs are, but that is only a wild guess.', bob);
  const k = (await app.call(bob, 'POST', '/api/comments', { target_type: 'conversation', target_id: id, body_text: 'The planar case needs care at degree five.', anchor: { message_id: second } })).data;
  const cid = k.id ?? k.comment?.id;
  const t = (await ask(ann, id)).data;
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a == ["--version"]: print("1.0 (Claude Code)"); sys.exit()
if a[:2] == ["auth", "status"]: print("{}"); sys.exit()
prompt = sys.stdin.read()
assert "A discussion is informal" in prompt
c = json.load(open("task.json"))["conversation"]["messages"]
base = {"kind": "theorem", "proof": None, "page": None, "covers": "statement", "depends_on": [], "comments": []}
good = {**base, "ref": "good", "title": "Planar", "statement": "Every planar graph is five colorable.", "quote": "every planar graph here is five colorable", "message_id": c[0]["id"], "comments": [{"id": ${cid}, "quote": "needs care at degree five", "role": "clarifies"}]}
wrong = {**base, "ref": "wrong", "title": "Wrong message", "statement": "S.", "quote": "every planar graph here is five colorable", "message_id": c[1]["id"]}
made = {**base, "ref": "made", "title": "Invented", "statement": "S.", "quote": "a sentence nobody ever wrote here", "message_id": c[0]["id"]}
print(json.dumps({"is_error": False, "result": "", "structured_output": {"summary": "Read.", "facts": [good, wrong, made], "existing_facts": []}, "modelUsage": {"claude-opus-5-5": {"inputTokens": 1, "outputTokens": 1}}}))
`, { mode: 0o755 });
  const dir = path.join(tmp, 'run'); fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('python3', [CLIENT, 'run', '--once', '--provider', 'claude', '--only', 'extract', '--project', String(pid)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OQ_CONFIG_DIR: path.join(dir, 'c'), OQ_URL: app.base, OQ_KEY: annKey.token }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const done = await task(t.id);
  assert.equal(done.status, 'done', done.error_text);
  assert.equal(done.result.fact_ids.length, 1); assert.match(done.summary_text, /2 set aside/);
  const f = (await app.call(ann, 'GET', `/api/facts/${done.result.fact_ids[0]}`)).data;
  assert.equal(f.sources[0].type, 'message'); assert.equal(f.sources[0].link.id, id);
  assert.deepEqual(f.sources.filter((s) => s.type === 'comment').map((s) => s.comment_role), ['clarifies']);
});
