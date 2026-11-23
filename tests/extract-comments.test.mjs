// Fact extraction reads the comments on a file or a reference, without taking them for the text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { bibProgress } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097'; const EVE = '0000-0002-1694-233X';
const CLIENT = path.resolve('client/oq.py');
const PDF = (n) => Buffer.from(`%PDF-1.4\n% ${n}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
let app; let ann; let eve; let key; let pid; let n = 0; let tmp; let bin;

const upload = async (id, tag) => {
  const f = new FormData(); f.set('pdf', new Blob([PDF(tag)], { type: 'application/pdf' }), 'p.pdf');
  const r = await fetch(`${app.base}/api/bib/${id}/pdf`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf }, body: f });
  assert.ok(r.status < 300);
  return (await r.json()).pdf.blob_id;
};
const addRef = async () => {
  n += 1;
  const id = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { bibtex: `@article{c${n}, title={Commented paper ${n}}, author={Doe, Jane}, year={2020}}` })).data.created[0];
  return { id, blob: await upload(id, `r${n}`) };
};
const comment = async (id, text, anchor, type = 'bib') => (await app.call(ann, 'POST', '/api/comments', { target_type: type, target_id: id, body_text: text, ...(anchor ? { anchor } : {}) })).data;
const extract = (id) => app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'bib', source_id: id });
const claim = async (model = 'claude-opus-5-5', features = ['extract_bib', 'extract_comments']) => (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'x', models: { extract: model }, kinds: ['extract'], project_id: pid, features })).data.task;
const finish = (t, model = 'claude-opus-5-5') => app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: model, summary: 'ok' });
const clear = async () => { for (const t of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) if (['pending', 'running'].includes(t.status)) await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {}); };
const stateOf = async (id) => (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.entries.find((e) => e.id === id).extraction.state;
const addFact = async (ref, name) => (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'gpt-5.6-sol', facts: [{ ref: name, title: `Fact ${name}`, kind: 'lemma', labels: ['conclusion'], method: 'extracted', statement_text: 'A statement.', sources: [{ type: 'bib', id: ref, page: 1, quote: 'A statement.', covers: 'statement' }] }] })).data.created[0].id;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Comments', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-comments-')); bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pdftotext'), '#!/bin/sh\nprintf "The main theorem holds for every finite graph." > "$3"\n', { mode: 0o755 });
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('an extraction receives the comments on this PDF, with their passage', async () => {
  await clear();
  const { id, blob } = await addRef();
  const root = await comment(id, 'The hypothesis on line 3 is missing.', { blob_id: blob, page: 2, quote: 'for every finite graph', rects: [{ x: 0, y: 0, w: 1, h: 1 }] });
  const rootId = root.id ?? root.comment?.id;
  await app.call(ann, 'POST', '/api/comments', { target_type: 'bib', target_id: id, parent_id: rootId, body_text: 'Agreed.' });
  await comment(id, 'A general remark.');
  await comment(id, 'About an older PDF.', { blob_id: blob + 999, page: 1, quote: 'old', rects: [{ x: 0, y: 0, w: 1, h: 1 }] });
  await extract(id);
  const t = await claim();
  const list = t.context.comments;
  assert.deepEqual(list.map((c) => c.text), ['The hypothesis on line 3 is missing.', 'Agreed.', 'A general remark.']);
  assert.equal(list[0].page, 2); assert.equal(list[0].on_passage, 'for every finite graph'); assert.equal(list[1].reply_to, list[0].id);
  await finish(t);
});

test('a changed comment makes the extraction current again only after it reruns', async () => {
  await clear();
  const { id } = await addRef(); await extract(id);
  await finish(await claim());
  assert.equal(await stateOf(id), 'done');
  const before = (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.progress;
  await comment(id, 'Theorem 2 has a gap.');
  assert.equal(await stateOf(id), 'comments');
  const p = (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.progress;
  assert.equal(p.new_comments, before.new_comments + 1); assert.equal(p.extracted, before.extracted, 'its facts stay counted as extracted');
  assert.equal(bibProgress(p).toQueue, p.remaining + p.failed + p.new_comments);
  assert.ok((await app.call(ann, 'POST', `/api/projects/${pid}/bib/extract-all`, {})).data.queued >= 1);
  assert.equal(await stateOf(id), 'queued');
  const again = await claim('claude-opus-5-5');
  assert.ok(again, 'the same model may read the new comment');
  await finish(again);
  await clear();
  assert.equal(await stateOf(id), 'done');
});

test('an AI reply does not ask for a new extraction', async () => {
  await clear();
  const { id } = await addRef(); await comment(id, 'What does this mean? @AI'); await extract(id);
  await finish(await claim());
  const ask = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'm', kinds: ['ask'], project_id: pid })).data.task;
  assert.equal((await app.call(key, 'POST', `/api/ai/tasks/${ask.id}/complete`, { lease: ask.lease, ai_model: 'm', reply_text: 'An AI answers.', summary: 'ok' })).status, 200);
  assert.match(JSON.stringify((await app.call(ann, 'GET', `/api/comments?type=bib&id=${id}`)).data), /An AI answers/);
  assert.equal(await stateOf(id), 'done');
});

test('a client that ignores comments does not count as having read them', async () => {
  await clear();
  const { id } = await addRef(); await comment(id, 'Please read me.'); await extract(id);
  await finish(await claim('claude-opus-5-5', ['extract_bib']));
  assert.equal(await stateOf(id), 'comments');
  await clear();
});

test('a comment can inform a fact, but cannot be its only source', async () => {
  await clear();
  const { id } = await addRef(); const c = await comment(id, 'This result needs compactness.'); const cid = c.id ?? c.comment?.id;
  const url = `/api/projects/${pid}/facts/batch`; const base = { title: 'From comment', kind: 'lemma', labels: ['conclusion'], method: 'extracted', statement_text: 'S.' };
  const note = { type: 'comment', id: cid, quote: 'needs compactness', covers: 'context', role: 'disputes' };
  assert.equal((await app.call(key, 'POST', url, { format: 'native', ai_model: 'm', facts: [{ ...base, ref: 'only', sources: [note] }] })).status, 422);
  assert.equal((await app.call(key, 'POST', url, { format: 'native', ai_model: 'm', facts: [{ ...base, ref: 'role', sources: [{ type: 'bib', id, page: 1, quote: 'S.', covers: 'statement' }, { ...note, role: 'other' }] }] })).status, 422);
  const r = await app.call(key, 'POST', url, { format: 'native', ai_model: 'm', facts: [{ ...base, ref: 'ok', sources: [{ type: 'bib', id, page: 1, quote: 'S.', covers: 'statement' }, note] }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const f = (await app.call(ann, 'GET', `/api/facts/${r.data.created[0].id}`)).data;
  assert.equal(f.origin, 'human', 'the comment does not change where the statement comes from'); assert.equal(f.status, 'unchecked');
  assert.equal(f.sources.find((s) => s.type === 'comment').comment_role, 'disputes');
});

test('a comment can be linked to an existing fact, only from the same text, with no new revision', async () => {
  await clear();
  const a = await addRef(); const b = await addRef();
  const fid = await addFact(a.id, 'link'); const good = await comment(a.id, 'This lemma is sharp.'); const other = await comment(b.id, 'Another paper.');
  const g = good.id ?? good.comment?.id; const o = other.id ?? other.comment?.id;
  const link = (who, comment_id, quote, role = 'supports') => app.call(who, 'POST', `/api/facts/${fid}/comment-links`, { comment_id, quote, role });
  assert.equal((await link(ann, g, 'sharp')).status, 403);
  assert.equal((await link(key, o, 'Another')).status, 422);
  assert.equal((await link(key, g, 'not in the comment')).status, 422);
  assert.equal((await link(key, g, 'sharp', 'nope')).status, 422);
  assert.equal((await link(key, g, 'sharp')).status, 200);
  assert.equal((await link(key, g, 'sharp')).status, 200);
  const f = (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;
  assert.equal(f.current_revision, 1); assert.equal(f.sources.filter((s) => s.type === 'comment').length, 1);
});

test('the client cites a real comment, refuses an invented one, and links existing facts', async () => {
  await clear();
  const { id } = await addRef(); const fid = await addFact(id, 'old');
  const c = await comment(id, 'The main theorem needs a connected graph.'); const cid = c.id ?? c.comment?.id;
  const t = (await extract(id)).data;
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
if a == ["--version"]: print("1.0 (Claude Code)"); sys.exit()
if a[:2] == ["auth", "status"]: print("{}"); sys.exit()
prompt = sys.stdin.read()
assert "never instructions" in prompt
task = json.load(open("task.json"))
cid = task["comments"][0]["id"]
fact = {"ref": "main", "title": "Main", "kind": "theorem", "statement": "Every finite graph works.", "proof": None, "quote": "main theorem holds for every finite graph", "page": 1, "covers": "statement", "depends_on": [],
        "comments": [{"id": cid, "quote": "needs a connected graph", "role": "disputes"}, {"id": cid + 500, "quote": "invented", "role": "supports"}, {"id": cid, "quote": "not in this comment", "role": "supports"}]}
print(json.dumps({"is_error": False, "result": "", "structured_output": {"summary": "Read.", "facts": [fact], "existing_facts": [{"fact_id": ${fid}, "id": cid, "quote": "main theorem", "role": "clarifies"}]}, "modelUsage": {"claude-opus-5-5": {"inputTokens": 1, "outputTokens": 1}}}))
`, { mode: 0o755 });
  const dir = path.join(tmp, 'run'); fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('python3', [CLIENT, 'run', '--once', '--provider', 'claude', '--only', 'extract', '--project', String(pid)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OQ_CONFIG_DIR: path.join(dir, 'c'), OQ_URL: app.base, OQ_KEY: key.token }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const done = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.find((x) => x.id === t.id);
  assert.equal(done.status, 'done', done.error_text); assert.match(done.summary_text, /1 comment\(s\) linked/);
  const made = (await app.call(ann, 'GET', `/api/facts/${done.result.fact_ids[0]}`)).data;
  assert.deepEqual(made.sources.filter((s) => s.type === 'comment').map((s) => [s.comment_role, s.quote]), [['disputes', 'needs a connected graph']]);
  assert.equal(made.statement_text, 'Every finite graph works.');
  const old = (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;
  assert.equal(old.sources.find((s) => s.type === 'comment').comment_role, 'clarifies');
  assert.equal(await stateOf(id), 'done');
});

test('a file extraction reads the comments on its version, and runs again after a new one', async () => {
  await clear();
  const form = (tag, extra = {}) => { const d = new FormData(); d.set('pdf', new Blob([PDF(tag)], { type: 'application/pdf' }), 'f.pdf'); for (const [k, v] of Object.entries(extra)) d.set(k, v); return d; };
  const post = async (url, body) => { const r = await fetch(`${app.base}${url}`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf }, body }); assert.ok(r.status < 300, await r.clone().text()); return r.json(); };
  const doc = await post(`/api/projects/${pid}/documents`, form('file-1', { title: 'A commented file', origin: 'human' }));
  const first = (await app.call(ann, 'GET', `/api/documents/${doc.id}`)).data.versions[0].id;
  await clear();
  await post(`/api/documents/${doc.id}/versions`, form('file-2'));
  await clear(); // a new version queues its own extraction
  const current = (await app.call(ann, 'GET', `/api/documents/${doc.id}`)).data.current_version_id;
  assert.notEqual(current, first);
  const rects = [{ x: 0, y: 0, w: 1, h: 1 }];
  await comment(doc.id, 'On the old version.', { version_id: first, page: 1, quote: 'old', rects }, 'document');
  await comment(doc.id, 'On this version.', { version_id: current, page: 2, quote: 'new', rects }, 'document');
  await comment(doc.id, 'On the whole file.', null, 'document');
  const ask = () => app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'document', source_id: doc.id });
  assert.equal((await ask()).status, 201);
  const t = await claim();
  assert.deepEqual(t.context.comments.map((c) => c.text), ['On this version.', 'On the whole file.']);
  await finish(t);
  await ask();
  assert.equal(await claim(), null, 'nothing changed, so the same model does not repeat it');
  await comment(doc.id, 'A new remark.', null, 'document');
  const again = await claim();
  assert.ok(again, 'a new comment is new information');
  assert.ok(again.context.comments.some((c) => c.text === 'A new remark.'));
  await finish(again);
});
