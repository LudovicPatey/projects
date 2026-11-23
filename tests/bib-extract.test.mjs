// Facts can be extracted from the PDF of a bibliography entry, through the AI queue.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const EVE = '0000-0002-1694-233X';
const CLIENT = path.resolve('client/oq.py');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
let app; let ann; let eve; let annKey; let pid; let otherPid; let tmp; let bin; let n = 0;

const addRef = async (withPdf = true) => {
  n += 1;
  const id = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { bibtex: `@article{paper${n}, title={A paper number ${n}}, author={Doe, Jane}, year={2020}}` })).data.created[0];
  if (withPdf) {
    const f = new FormData(); f.set('pdf', new Blob([PDF], { type: 'application/pdf' }), 'p.pdf');
    const r = await fetch(`${app.base}/api/bib/${id}/pdf`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf }, body: f });
    assert.ok(r.status < 300);
  }
  return id;
};
const ask = (who, id, kind = 'extract') => app.call(who, 'POST', `/api/projects/${pid}/ai/tasks`, { kind, source_type: 'bib', source_id: id, ...(kind === 'ask' ? { prompt_text: 'Why?' } : {}) });
const clear = async () => { for (const t of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) if (['pending', 'running'].includes(t.status)) await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {}); };

before(async () => {
  app = await startApp();
  ann = await app.signIn(ANN); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'References', question_html: '<p>Q</p>' })).data.id;
  otherPid = (await app.call(eve, 'POST', '/api/projects', { title: 'Other', question_html: '<p>Q</p>' })).data.id;
  annKey = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-bib-extract-'));
  bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pdftotext'), '#!/bin/sh\nprintf "The main theorem holds for every finite graph." > "$3"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
if a == ["--version"]: print("1.0 (Claude Code)"); sys.exit()
if a[:2] == ["auth", "status"]: print("ok"); sys.exit()
sys.stdin.read()
assert os.path.exists("paper.pdf") and "finite graph" in open("document.txt").read()
assert json.load(open("task.json"))["reference"]["has_pdf"] == 1
fact = lambda ref, quote: {"ref": ref, "title": "Result " + ref, "kind": "theorem", "statement": "Every finite graph works.", "proof": None, "quote": quote, "page": 1, "covers": "statement", "depends_on": []}
print(json.dumps({"is_error": False, "result": "", "structured_output": {"summary": "Read.", "facts": [fact("real", "main theorem holds for every finite graph"), fact("invented", "this sentence is not in the paper at all")]}, "modelUsage": {"m": {"inputTokens": 1, "outputTokens": 1}}}))
`, { mode: 0o755 });
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('only a person can request it, on a reference of the project that has a PDF', async () => {
  await clear();
  const withPdf = await addRef(); const noPdf = await addRef(false);
  assert.equal((await ask(ann, noPdf)).status, 422);
  assert.equal((await ask(annKey, withPdf)).status, 403);
  assert.equal((await ask(ann, withPdf, 'ask')).status, 422);
  assert.equal((await app.call(eve, 'POST', `/api/projects/${otherPid}/ai/tasks`, { kind: 'extract', source_type: 'bib', source_id: withPdf })).status, 404);
  const t = await ask(ann, withPdf);
  assert.equal(t.status, 201); assert.equal(t.data.source_type, 'bib'); assert.match(t.data.subject, /A paper number/);
  assert.equal((await ask(ann, withPdf)).status, 409, 'the same request is not queued twice');
});

test('a client from before this feature is not given these tasks', async () => {
  await clear();
  const id = await addRef(); const t = (await ask(ann, id)).data;
  const old = await app.call(annKey, 'POST', '/api/ai/tasks/claim', { client_name: 'old', ai_model: 'm', kinds: ['extract'], project_id: pid });
  assert.equal(old.data.task, null);
  const now = await app.call(annKey, 'POST', '/api/ai/tasks/claim', { client_name: 'new', ai_model: 'm', kinds: ['extract'], project_id: pid, features: ['extract_bib'] });
  assert.equal(now.data.task.id, t.id);
  assert.equal(now.data.task.context.reference.id, id);
  await app.call(annKey, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: now.data.task.lease });
});

test('the client extracts verified facts, cited to the reference', async () => {
  await clear();
  const id = await addRef(); const t = (await ask(ann, id)).data;
  const dir = path.join(tmp, 'run');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OQ_CONFIG_DIR: path.join(dir, 'c'), OQ_URL: app.base, OQ_KEY: annKey.token };
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('python3', [CLIENT, 'run', '--once', '--provider', 'claude', '--project', String(pid)], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const done = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.find((x) => x.id === t.id);
  assert.equal(done.status, 'done', done.error_text);
  assert.equal(done.result.fact_ids.length, 1, 'the invented quotation is set aside');
  assert.match(done.summary_text, /1 fact\(s\) added, 1 set aside/);
  const fact = (await app.call(ann, 'GET', `/api/facts/${done.result.fact_ids[0]}`)).data;
  const source = fact.sources[0];
  assert.equal(source.type, 'bib'); assert.equal(source.page, 1); assert.equal(source.link.id, id);
  assert.match(source.label, /A paper number/);
  assert.equal(source.author.name, 'Jane Doe');
});

test('a reference that lost its PDF fails with a clear message', () => {
  const script = `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
for ref in (None, {"id": 1, "has_pdf": 0}):
    try:
        oq.prepare_reference(None, ref, pathlib.Path("."), "claude")
        raise SystemExit("accepted")
    except RuntimeError as e:
        assert "no longer has a PDF" in str(e)
`;
  execFileSync('python3', ['-c', script, CLIENT], { env: { ...process.env, OQ_CONFIG_DIR: path.join(tmp, 'x') } });
});
