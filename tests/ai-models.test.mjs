// Model choice, the partial order between models, and the bibliography extraction progress.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { bibProgress } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097'; const EVE = '0000-0002-1694-233X';
const CLIENT = path.resolve('client/oq.py');
const pdf = (n) => Buffer.from(`%PDF-1.4\n% ${n}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
let app; let ann; let eve; let key; let pid; let n = 0; let tmp;

const addRef = async (withPdf = true) => {
  n += 1;
  const id = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { bibtex: `@article{m${n}, title={Model paper ${n}}, author={Doe, Jane}, year={2021}}` })).data.created[0];
  if (withPdf) await upload(id, n);
  return id;
};
const upload = async (id, tag) => {
  const f = new FormData(); f.set('pdf', new Blob([pdf(tag)], { type: 'application/pdf' }), 'p.pdf');
  assert.ok((await fetch(`${app.base}/api/bib/${id}/pdf`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf }, body: f })).status < 300);
};
const claim = async (model) => (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude', models: { extract: model }, kinds: ['extract'], project_id: pid, features: ['extract_bib'] })).data.task;
const finish = (t, model) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: model, summary: 'ok' });
const clear = async () => { for (const t of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) if (['pending', 'running'].includes(t.status)) await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {}); };
const progress = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.progress;
const extract = (id) => app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'bib', source_id: id });
const python = (env, body) => execFileSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
${body}
`, CLIENT], { env: { ...process.env, ...env }, encoding: 'utf8' });

before(async () => {
  app = await startApp();
  ann = await app.signIn(ANN); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Models', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-models-'));
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('the order is partial, and reads new releases from their names', () => {
  const php = `require 'src/ModelOrder.php'; use App\\ModelOrder as M;
  $yes = [['claude-opus-5-5','claude-sonnet-5-5'],['claude-sonnet-5-5','claude-haiku-5-5'],['claude-opus-7-0','claude-opus-5-5'],['claude-sonnet-5-5','claude-sonnet-5-5'],['claude-sonnet-4-5-20250929','claude-3-5-sonnet-20241022'],['gpt-5.6-sol','gpt-5.5-sol'],['claude-fable-5-2','claude-fable-5-1']];
  $no = [['claude-sonnet-5-5','claude-opus-5-5'],['claude-opus-4-1','claude-sonnet-5-5'],['claude-sonnet-5-5','claude-opus-4-1'],['claude-opus-5-5','gpt-5.6-sol'],['gpt-5.6-sol','claude-haiku-5-5'],['gpt-5.6-sol','gpt-5.6-mini'],['claude-fable-5-2','claude-opus-5-5'],['claude-opus-5-5','claude-fable-5-2'],['sonnet','sonnet'],['claude (default model)','claude (default model)'],['unknown','unknown']];
  foreach ($yes as [$a,$b]) if (!M::atLeast($a,$b)) { echo "missing $a >= $b"; exit(1); }
  foreach ($no as [$a,$b]) if (M::atLeast($a,$b)) { echo "wrong $a >= $b"; exit(1); }`;
  execFileSync('php', ['-r', php], { encoding: 'utf8' });
});

test('a weaker model does not repeat an extraction, and a stronger or incomparable one can', async () => {
  await clear();
  const id = await addRef();
  await extract(id);
  await finish(await claim('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  const again = (await extract(id)).data;
  assert.deepEqual(again.already_done_by, ['claude-sonnet-5-5']);
  assert.equal(await claim('claude-haiku-5-5'), null);
  assert.equal(await claim('claude-sonnet-5-5'), null);
  const strong = await claim('claude-opus-5-5');
  assert.equal(strong.id, again.id); assert.equal(strong.ai_model, 'claude-opus-5-5');
  await finish(strong, 'claude-opus-5-5');
  await extract(id);
  const other = await claim('gpt-5.6-sol');
  assert.ok(other, 'another provider is not comparable');
  await app.call(key, 'POST', `/api/ai/tasks/${other.id}/release`, { lease: other.lease });
});

test('tasks left to a stronger model do not hide the work behind them', async () => {
  await clear();
  const done = await addRef(); await extract(done);
  await finish(await claim('claude-opus-5-5'), 'claude-opus-5-5');
  await extract(done);
  const next = await addRef(); const t = (await extract(next)).data;
  const got = await claim('claude-haiku-5-5');
  assert.equal(got.id, t.id);
  await app.call(key, 'POST', `/api/ai/tasks/${got.id}/release`, { lease: got.lease });
});

test('progress counts PDFs and extractions, and extract-all queues only what remains', async () => {
  await clear();
  const before = await progress();
  const a = await addRef(); await addRef(); await addRef(false);
  const p = await progress();
  assert.equal(p.total, before.total + 3); assert.equal(p.with_pdf, before.with_pdf + 2);
  assert.equal((await app.call(key, 'POST', `/api/projects/${pid}/bib/extract-all`, {})).status, 403);
  assert.equal((await app.call(eve, 'POST', `/api/projects/${pid}/bib/extract-all`, {})).status, 403);
  const r = await app.call(ann, 'POST', `/api/projects/${pid}/bib/extract-all`, {});
  assert.equal(r.status, 201); assert.equal(r.data.queued, p.remaining + p.failed);
  assert.equal(r.data.progress.remaining, 0);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/bib/extract-all`, {})).data.queued, 0);
  const row = (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.entries.find((e) => e.id === a);
  assert.equal(row.extraction.state, 'queued');
});

test('a replaced PDF is no longer counted as extracted', async () => {
  await clear();
  const id = await addRef(); await extract(id);
  await finish(await claim('claude-opus-5-5'), 'claude-opus-5-5');
  const state = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.entries.find((e) => e.id === id).extraction.state;
  assert.equal(await state(), 'done');
  await upload(id, 'replaced');
  assert.equal(await state(), 'none');
  await extract(id);
  assert.ok(await claim('claude-haiku-5-5'), 'a new PDF is new work, for any model');
});

test('the progress display handles an empty bibliography', () => {
  assert.deepEqual([bibProgress(null).pdfPercent, bibProgress(null).extractedPercent], [0, 0]);
  const p = bibProgress({ total: 4, with_pdf: 2, extracted: 1, failed: 1 });
  assert.deepEqual([p.pdfPercent, p.extractedPercent, p.toQueue], [50, 50, 1]);
});

test('the client resolves its choices, refuses bad names, and forgets old aliases', () => {
  const env = { HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'config') };
  python(env, `
assert oq.chosen_model("claude", "extract") == "sonnet" and oq.chosen_model("claude", "derive") == "opus" and oq.chosen_model("codex", "extract") is None
oq.save_models("claude", {"extract": "claude-opus-5-5", "ask": "auto"})
assert oq.chosen_model("claude", "extract") == "claude-opus-5-5" and oq.chosen_model("claude", "ask") == "sonnet"
for bad in ("--dangerous", "a b", "x" * 90):
    try:
        oq.save_models("claude", {"extract": bad}); raise SystemExit("accepted " + bad)
    except oq.Stop:
        pass
for provider, bad in (("codex", "haiku"), ("codex", "claude-opus-5-5"), ("claude", "gpt-5.6-sol")):
    try:
        oq.save_models(provider, {"extract": bad}); raise SystemExit("accepted " + bad)
    except oq.Stop:
        pass
try:
    oq.save_models("claude", {}, "claude-opus-5-5"); raise SystemExit("proof search accepted Claude")
except oq.Stop:
    pass
oq.remember_alias("sonnet", "claude-sonnet-5-5")
assert oq.known_model("claude", "sonnet") == "claude-sonnet-5-5"
known = oq.load_prefs()["model_aliases"]; known["sonnet"]["at"] = 1; oq.save_prefs(model_aliases=known)
assert oq.known_model("claude", "sonnet") == "sonnet"
`);
});
