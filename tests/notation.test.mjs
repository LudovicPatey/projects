// The project's notation: one meaning per symbol, facts rewritten in it, and definitions kept out of the results.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { asMath, entryBody, entryError, rephrasingState, shownRephrasing, toRewrite } from '../public/assets/js/notation-model.js';
import { AI_KINDS, requestBody } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
const CLIENT = path.resolve('client/oq.py');
const FEATURES = ['extract_bib', 'extract_comments', 'extract_conversation', 'review', 'lean', 'notation'];
let app; let ann; let bob; let key; let pid; let tmp; let bin; let n = 0;

const facts = async (list) => {
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: list });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  return Object.fromEntries(r.data.created.map((x) => [x.ref, x.id]));
};
const propose = (body, who = ann) => app.call(who, 'POST', `/api/projects/${pid}/notation`, body);
const decide = (id, status, who = ann) => app.call(who, 'POST', `/api/notation/${id}/status`, { status });
const notation = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data;
const claim = async (features = FEATURES) => (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', kinds: ['notation'], project_id: pid, features })).data.task;
const clear = async () => { for (const t of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) if (['pending', 'running'].includes(t.status)) await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {}); };
const fakeClaude = (output) => fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a == ["--version"]: print("1.0 (Claude Code)"); sys.exit()
if a[:2] == ["auth", "status"]: print("{}"); sys.exit()
prompt = sys.stdin.read()
task = json.load(open("task.json"))
out = ${output}
print(json.dumps({"is_error": False, "result": "", "structured_output": out, "modelUsage": {"claude-opus-5-5": {"inputTokens": 1, "outputTokens": 1}}}))
`, { mode: 0o755 });
const runClient = (only) => {
  n += 1;
  const dir = path.join(tmp, `run${n}`); fs.mkdirSync(dir, { recursive: true });
  return spawnSync('python3', [CLIENT, 'run', '--once', '--provider', 'claude', '--only', only, '--project', String(pid)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OQ_CONFIG_DIR: path.join(dir, 'c'), OQ_URL: app.base, OQ_KEY: key.token }, encoding: 'utf8', timeout: 60000 });
};

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Hindman', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-notation-')); bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pdftotext'), '#!/bin/sh\nprintf "Definition. FS(X) is the set of non-empty finite sums of X. Theorem 2. Every coloring has a monochromatic FS(X)." > "$3"\n', { mode: 0o755 });
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('the interface helpers', () => {
  assert.equal(asMath('$\\mathrm{FS}(X)$'), '$\\mathrm{FS}(X)$'); assert.equal(asMath('NS(X)'), '$NS(X)$');
  assert.ok(entryError({ symbol: '', meaning: 'x' })); assert.ok(entryError({ symbol: 'x', meaning: ' ' })); assert.equal(entryError({ symbol: 'x', meaning: 'y' }), null);
  assert.deepEqual(entryBody({ symbol: ' FS ', meaning: ' m ', note: '', fact: '4' }), { symbol: 'FS', meaning_text: 'm', note_text: '', definition_fact_id: 4 });
  assert.equal(toRewrite({ none: 3, stale: 2, unfaithful: 1, queued: 2 }), 4);
  const fact = { current_revision: 1, rephrasings: [{ current: true, unchanged: false, check_verdict: null, revision_no: 1 }] };
  assert.ok(shownRephrasing(fact, true)); assert.equal(shownRephrasing(fact, false), null);
  assert.equal(shownRephrasing({ rephrasings: [{ current: true, check_verdict: 'unfaithful' }] }, true), null);
  assert.equal(rephrasingState({ current_revision: 1, rephrasings: [{ current: false, revision_no: 1 }] }).tone, 'warn');
  assert.deepEqual(requestBody({ kind: 'notation', prompt: '' }), { kind: 'notation' }); assert.equal(AI_KINDS.notation.needs, null);
});

test('people agree on one meaning per symbol, and only people', async () => {
  const fs1 = (await propose({ symbol: '$\\mathrm{FS}(X)$', meaning_text: 'The finite sums of $X$, including $0$.', note_text: 'Hindman excludes 0.' })).data;
  assert.equal(fs1.symbol, '\\mathrm{FS}(X)'); assert.equal(fs1.status, 'proposed');
  assert.equal((await decide(fs1.id, 'agreed', key)).status, 403);
  assert.equal((await decide(fs1.id, 'agreed')).status, 200);
  const other = (await propose({ symbol: '\\mathrm{FS} (X)', meaning_text: 'The non-empty finite sums.' }, bob)).data;
  assert.equal((await decide(other.id, 'agreed', bob)).status, 409); // one agreed meaning per symbol
  assert.equal((await app.call(ann, 'DELETE', `/api/notation/${fs1.id}`)).status, 409);
  assert.equal((await app.call(ann, 'DELETE', `/api/notation/${other.id}`)).status, 200); // owner
  const edited = (await app.call(ann, 'PATCH', `/api/notation/${fs1.id}`, { meaning_text: 'The sums of finitely many elements of $X$, with the empty sum $0$.' })).data;
  assert.equal(edited.status, 'proposed'); // a changed meaning must be agreed again
  await decide(fs1.id, 'agreed');
  assert.equal((await propose({ symbol: 'x', meaning_text: '' })).status, 422);
});

test('an AI meeting a known symbol with another meaning records a clash, not a duplicate', async () => {
  const merged = await app.call(key, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{FS}(X)', meaning_text: 'The non-empty finite sums of $X$.', where: 'Hindman 1974, p. 2', ai_model: 'claude-opus-5-5' });
  assert.equal(merged.status, 200); assert.equal(merged.data.merged, true);
  assert.deepEqual(merged.data.variants.map((v) => v.where), ['Hindman 1974, p. 2']);
  assert.equal((await app.call(key, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{FS}(X)', meaning_text: 'The non-empty finite sums of $X$', ai_model: 'claude-opus-5-5' })).status, 409);
  const ns = await app.call(key, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{NS}(X)', meaning_text: '$\\mathrm{FS}(X) \\setminus \\{0\\}$.', ai_model: 'claude-opus-5-5' });
  assert.equal(ns.status, 201); assert.equal(ns.data.author_kind, 'agent'); assert.equal(ns.data.ai_model, 'claude-opus-5-5');
  await decide(ns.data.id, 'agreed');
});

test('definitions leave the results: no status to check, no warning on facts using them', async () => {
  const ids = await facts([
    { ref: 'd', title: 'Finite sums', kind: 'definition', labels: ['conclusion'], method: 'deduced', statement_text: 'FS(X) is the set of non-empty finite sums of X.' },
    { ref: 't', title: 'Hindman', kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: 'Every finite coloring has a monochromatic FS(X).', proof_text: 'By ultrafilters.', depends_on: ['d'] },
  ]);
  const graph = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts;
  assert.equal(graph.find((f) => f.id === ids.d).status, 'definition');
  assert.equal(graph.find((f) => f.id === ids.t).chain, 'ok');
  const dash = (await app.call(ann, 'GET', `/api/projects/${pid}/dashboard`)).data;
  assert.equal(dash.facts.by_status.definition, undefined);
  let defs = (await notation()).definitions;
  assert.equal(defs.find((x) => x.id === ids.d).entry, null); assert.equal(defs.find((x) => x.id === ids.d).used_by, 1);
  const e = (await propose({ symbol: '\\mathrm{FS}^+(X)', meaning_text: 'The non-empty finite sums.', definition_fact_id: ids.d })).data;
  defs = (await notation()).definitions;
  assert.equal(defs.find((x) => x.id === ids.d).entry.id, e.id);
  const refs = (await app.call(ann, 'GET', `/api/projects/${pid}/refs/resolve?keys=${encodeURIComponent(`notation:${e.id}`)}`)).data.refs;
  assert.equal(refs[`notation:${e.id}`].link.query.notation, e.id);
});

test('notation tasks go only to clients that handle them, with the right context', async () => {
  await clear();
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'A question' })).data;
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'notation', source_type: 'question', source_id: q.id ?? q.question?.id })).status, 422);
  const t = await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'notation' });
  assert.equal(t.status, 201);
  assert.equal(await claim(['review']), null);
  const got = await claim();
  assert.ok(got.context.fact_texts.length >= 2);
  assert.ok(got.context.notation.some((x) => x.status === 'proposed')); // proposals are visible when proposing
  await app.call(key, 'POST', `/api/ai/tasks/${got.id}/complete`, { lease: got.lease, ai_model: 'claude-opus-5-5', summary: 'ok' });
});

test('a fact is rewritten in the agreed notation without touching its reviewed text', async () => {
  await clear();
  const { a } = await facts([{ ref: 'a', title: 'Sums', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'Every FS(X) is infinite.', proof_text: 'Take sums.' }]);
  await app.call(ann, 'POST', `/api/facts/${a}/reviews`, { verdict: 'correct' });
  assert.equal((await app.call(ann, 'POST', `/api/facts/${a}/rephrasings`, { statement_text: 'x' })).status, 403);
  const p0 = (await notation()).progress;
  assert.ok(p0.none >= 1);
  const q = await app.call(ann, 'POST', `/api/projects/${pid}/notation/rephrase-all`, {});
  assert.ok(q.data.queued >= 1);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/notation/rephrase-all`, {})).data.queued, 0); // not twice
  const task = await claim();
  assert.equal(task.source_type, 'fact');
  assert.ok(task.context.notation.every((x) => x.status === 'agreed')); // a rewrite follows only what was agreed
  const target = task.source_id;
  const r = await app.call(key, 'POST', `/api/facts/${target}/rephrasings`, { ai_model: 'claude-opus-5-5', statement_text: 'Every $\\mathrm{NS}(X)$ is infinite.', proof_text: 'Take sums.', uses: [{ symbol: 'FS(X)', meaning_here: 'non-empty sums', project_symbol: '\\mathrm{NS}(X)' }] });
  assert.equal(r.status, 201);
  let f = (await app.call(ann, 'GET', `/api/facts/${target}`)).data;
  const x = f.rephrasings[0];
  assert.equal(x.current, true); assert.equal(x.uses[0].project_symbol, '\\mathrm{NS}(X)');
  if (target === a) { assert.equal(f.status, 'human_checked'); assert.match(f.statement_html, /Every FS\(X\) is infinite/); }
  assert.equal((await app.call(ann, 'POST', `/api/fact-rephrasings/${x.id}/check`, { verdict: 'unfaithful' })).status, 422);
  f = (await app.call(ann, 'POST', `/api/fact-rephrasings/${x.id}/check`, { verdict: 'faithful' })).data;
  assert.equal(f.rephrasings[0].check_verdict, 'faithful');
  // A new agreed entry makes every rewrite out of date.
  const e = (await propose({ symbol: '\\omega', meaning_text: 'The natural numbers.' })).data;
  await decide(e.id, 'agreed');
  f = (await app.call(ann, 'GET', `/api/facts/${target}`)).data;
  assert.equal(f.rephrasings[0].current, false);
  assert.ok((await notation()).progress.stale >= 1);
  await clear();
});

test('the client proposes entries, rewrites a fact, and extraction keeps definitions in each fact', async () => {
  await clear();
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'notation' });
  fakeClaude(`{"summary": "Compared.", "entries": [{"symbol": "\\\\mathrm{IP}(X)", "meaning": "The IP set of $X$.", "note": None, "variants": [], "definition_fact_id": None}, {"symbol": "\\\\mathrm{NS}(X)", "meaning": "$\\\\mathrm{FS}(X) \\\\setminus \\\\{0\\\\}$.", "note": None, "variants": [], "definition_fact_id": None}]} if "review the notation of the whole project" in prompt else None`);
  let r = runClient('notation');
  assert.equal(r.status, 0, r.stderr);
  const ip = (await notation()).entries.find((x) => x.symbol === '\\mathrm{IP}(X)');
  assert.ok(ip); assert.equal(ip.status, 'proposed');
  const done = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.find((t) => t.kind === 'notation' && t.status === 'done' && /proposed/.test(t.summary_text || ''));
  assert.ok(done, 'the task reports what it proposed');

  const { b } = await facts([{ ref: 'b', title: 'Rewrite me', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'FS(X) avoids 0.', proof_text: 'Non-empty sums.' }]);
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'notation', source_type: 'fact', source_id: b });
  fakeClaude(`{"summary": "Done.", "unchanged": False, "statement": "$\\\\mathrm{NS}(X)$ avoids 0.", "proof": "Non-empty sums.", "uses": [{"symbol": "FS(X)", "meaning_here": "non-empty sums", "project_symbol": "\\\\mathrm{NS}(X)"}]} if task["fact"]["id"] == ${b} and "again in the project" in prompt else None`);
  r = runClient('notation');
  assert.equal(r.status, 0, r.stderr);
  const fb = (await app.call(ann, 'GET', `/api/facts/${b}`)).data;
  assert.match(fb.rephrasings[0].statement_html, /NS/); assert.match(fb.statement_html, /FS\(X\) avoids 0/);

  const ref = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { bibtex: '@article{h74, title={Finite sums}, author={Hindman, N.}, year={1974}}' })).data.created[0];
  const form = new FormData(); form.set('pdf', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'p.pdf');
  await fetch(`${app.base}/api/bib/${ref}/pdf`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf }, body: form });
  await clear();
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'bib', source_id: ref });
  const before_ = (await notation()).entries.length;
  fakeClaude(`{"summary": "Read.", "facts": [{"ref": "def", "title": "FS", "kind": "definition", "statement": "FS(X) is the set of non-empty finite sums.", "proof": None, "quote": "FS(X) is the set of non-empty finite sums of X", "page": 1, "covers": "statement", "depends_on": [], "message_id": None, "comments": [], "local_notation": []}, {"ref": "t2", "title": "Monochromatic sums", "kind": "theorem", "statement": "Every coloring has a monochromatic $\\\\mathrm{FS}(X)$.", "proof": None, "quote": "Every coloring has a monochromatic FS(X)", "page": 1, "covers": "statement", "depends_on": [], "message_id": None, "comments": [], "local_notation": [{"symbol": "\\\\mathrm{FS}(X)", "meaning": "The non-empty finite sums of elements of $X$."}]}], "existing_facts": []} if "notation" in task else None`);
  r = runClient('extract');
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await notation()).entries.length, before_, 'extraction proposes no project notation');
  const graph = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts;
  assert.equal(graph.some((f) => f.title === 'FS' && f.kind === 'definition'), false, 'no definition fact is created');
  const t2 = graph.find((f) => f.title === 'Monochromatic sums');
  assert.ok(t2, 'the theorem is saved');
  const full = (await app.call(ann, 'GET', `/api/facts/${t2.id}`)).data;
  assert.match(String(full.glossary['\\mathrm{FS}(X)'] ?? JSON.stringify(full.glossary)), /non-empty finite sums/, 'the symbol is defined in the fact itself');
});

test('members discuss a notation entry, and the AI reads the discussion', async () => {
  const e = (await propose({ symbol: '\\mathrm{IP}^*(X)', meaning_text: 'The dual of the IP sets.' })).data;
  const outsider = await app.signIn('0000-0002-9079-593X');
  assert.equal((await app.call(outsider, 'POST', '/api/comments', { target_type: 'notation', target_id: e.id, body_text: 'x' })).status, 403);
  const c = await app.call(bob, 'POST', '/api/comments', { target_type: 'notation', target_id: e.id, body_text: 'Most papers write $\\mathrm{IP}^\\star$ here.' });
  assert.equal(c.status, 201);
  const listed = (await app.call(ann, 'GET', `/api/comments?type=notation&id=${e.id}`)).data;
  assert.equal((listed.threads || listed.comments || listed).length, 1);
  const entry = (await notation()).entries.find((x) => x.id === e.id);
  assert.equal(entry.comment_count, 1); assert.equal(entry.open_threads, 1);
  await clear();
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'notation' });
  const t = await claim();
  assert.match(t.context.notation.find((x) => x.id === e.id).comments[0].text, /Most papers/);
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'claude-opus-5-5', summary: 'ok' });
  assert.equal((await app.call(ann, 'DELETE', `/api/notation/${e.id}`)).status, 200);
  assert.equal((await app.call(ann, 'GET', `/api/comments?type=notation&id=${e.id}`)).status, 404);
});

test('a local notation is unfolded by rewrites, and a general notion lists its settings', async () => {
  const before_ = (await notation()).hash;
  const local = (await propose({ symbol: 'B \\oplus C', meaning_text: '$B \\cup C$ where $\\max B < \\min C$.' })).data;
  assert.equal((await decide(local.id, 'local', key)).status, 403);
  assert.equal((await decide(local.id, 'local')).status, 200);
  const after_ = await notation();
  assert.notEqual(after_.hash, before_, 'rewrites made before must be redone');
  assert.equal(after_.progress.local, 1);
  const ip = await app.call(key, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{IP}\\text{-set}', meaning_text: 'A set containing $\\mathrm{FP}(x_n)$ for some sequence, in any semigroup.', ai_model: 'claude-opus-5-5',
    variants: [{ symbol: '\\mathrm{IP}', meaning: 'Contains $\\mathrm{FS}(X)$ for an infinite $X \\subseteq \\mathbb{N}$.', where: '$(\\mathbb{N}, +)$, Hindman', relation: 'instance' }, { symbol: '\\mathrm{IP}', meaning: 'Something else.', where: 'x', relation: 'weird' }] });
  assert.deepEqual(ip.data.variants.map((v) => v.relation), ['instance', 'clash']);
  const merged = await app.call(key, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{IP}\\text{-set}', meaning_text: 'Contains $\\mathrm{FU}(B_n)$ for a block sequence.', where: '$(\\mathrm{FIN}, \\cup)$', relation: 'instance', ai_model: 'claude-opus-5-5' });
  assert.equal(merged.data.variants.at(-1).relation, 'instance');
  const { b } = await facts([{ ref: 'b', title: 'Uses local', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'B ⊕ C is a block.', proof_text: 'P.' }]);
  await clear();
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'notation', source_type: 'fact', source_id: b });
  const t = await claim();
  assert.ok(t.context.notation.some((x) => x.status === 'local'), 'a rewrite knows what to unfold');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
  await clear();
});

test('each fact keeps its own notation, and symbols defined in several facts are offered to make global', async () => {
  const mk = (ref, meaning) => ({ ref, title: `Uses ${ref}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'A block sequence works.', proof_text: 'P.', glossary: { '\\mathrm{FU}(B)': meaning } });
  const made = await facts([mk('u1', 'Finite unions of the blocks.'), mk('u2', 'Finite unions of the blocks'), mk('u3', 'Something else.')]);
  let shared = (await notation()).shared.find((s) => s.symbol === '\\mathrm{FU}(B)');
  assert.equal(shared.facts, 3); assert.equal(shared.meanings.length, 2); assert.deepEqual(shared.meanings[0].facts.sort(), [made.u1, made.u2].sort()); assert.equal(shared.entry, null);
  const e = (await propose({ symbol: '\\mathrm{FU}(B)', meaning_text: 'Finite unions of the blocks.', facts: [made.u1, made.u2, 999999] })).data;
  assert.deepEqual(e.facts.sort(), [made.u1, made.u2].sort(), 'only facts of the project');
  shared = (await notation()).shared.find((s) => s.symbol === '\\mathrm{FU}(B)');
  assert.equal(shared.entry.id, e.id);
  // A rewrite carries its own local notation, which then replaces the original glossary.
  await decide(e.id, 'agreed');
  await app.call(key, 'POST', `/api/facts/${made.u3}/rephrasings`, { ai_model: 'claude-opus-5-5', statement_text: 'A block sequence works.', proof_text: 'P.', local_notation: [{ symbol: '\\mathrm{FU}^*(B)', meaning: 'Something else.' }] });
  const f = (await app.call(ann, 'GET', `/api/facts/${made.u3}`)).data;
  assert.deepEqual(f.rephrasings[0].local, { '\\mathrm{FU}^*(B)': 'Something else.' });
  shared = (await notation()).shared.find((s) => s.symbol === '\\mathrm{FU}(B)');
  assert.ok(!shared || shared.meanings.every((m) => !m.facts.includes(made.u3)), 'the rewritten fact no longer defines the clashing symbol');
  await clear();
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'notation' });
  const t = await claim();
  assert.ok(t.context.local_notation.some((s) => s.symbol === '\\mathrm{FU}(B)'), 'the review sees every fact\'s own notation');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
  await clear();
  // The client turns a model's local notation into the fact's glossary.
  const out = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
task = {"id": 1, "kind": "derive", "context": {"facts": []}}
answer = {"facts": [{"ref": "a", "title": "T", "kind": "lemma", "statement": "S.", "proof": "P.", "quote": None, "page": None, "covers": None, "depends_on": [], "local_notation": [{"symbol": "x \\\\oplus y", "meaning": "a sum"}, {"symbol": "", "meaning": "no"}]}]}
items, dropped = oq.fact_items(task, answer, None)
print(json.dumps(items[0].get("glossary")))
`, CLIENT], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.stdout), { 'x \\oplus y': 'a sum' }, out.stderr);
});

test('a parametric term has one entry per setting, named with the setting in parentheses', async () => {
  assert.equal(asMath('full-match (HT)'), 'full-match (HT)'); assert.equal(asMath('homogeneous (pairs)'), 'homogeneous (pairs)');
  assert.equal(asMath('\\mathrm{FU}(B_n) (FUT)'), '$\\mathrm{FU}(B_n)$ (FUT)'); assert.equal(asMath('B \\oplus C'), '$B \\oplus C$');
  const ht = (await propose({ symbol: 'full-match (HT)', meaning_text: 'For Hindman\'s theorem (HT): …' })).data;
  const fut = (await propose({ symbol: 'full-match (FUT)', meaning_text: 'For the finite union theorem (FUT): …' })).data;
  const general = (await propose({ symbol: 'full-match', meaning_text: 'In any semigroup: …' })).data;
  for (const e of [ht, fut, general]) assert.equal((await decide(e.id, 'agreed')).status, 200, e.symbol);
  const agreed = (await notation()).entries.filter((e) => e.status === 'agreed' && e.symbol.startsWith('full-match')).map((e) => e.symbol).sort();
  assert.deepEqual(agreed, ['full-match', 'full-match (FUT)', 'full-match (HT)']);
  const out = spawnSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
print(oq.danus_notation([{"symbol": "full-match (HT)", "meaning": "m"}, {"symbol": "\\\\mathrm{NS}(X)", "meaning": "n"}]))
`, CLIENT], { encoding: 'utf8' });
  assert.match(out.stdout, /^- full-match \(HT\): m$/m); assert.match(out.stdout, /^- \$\\mathrm\{NS\}\(X\)\$: n$/m);
});

test('one notion written in several ways is offered once, and proof variables are not offered', async () => {
  const mk = (ref, glossary) => ({ ref, title: `Spelling ${ref}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'P.', glossary });
  await facts([mk('s1', { 'FS(Y)': 'Non-empty finite sums of Y.', x_n: 'The n-th element.' }), mk('s2', { '\\mathrm{FS}(Z)': 'Non-empty finite sums of Z.', x_n: 'Another element.' }),
    mk('s3', { '\\mathrm{FS}(Y)': 'Finite sums of Y.', '(\\mu)': 'A measure.' }), mk('s4', { '(\\mathcal U)': 'An ultrafilter.', '(\\mu)': 'A measure.' })]);
  const shared = (await notation()).shared;
  const fs_ = shared.filter((s) => /FS/.test(s.symbol));
  assert.equal(fs_.length, 1, JSON.stringify(fs_.map((s) => s.symbol)));
  assert.ok(fs_[0].spellings.includes('FS(Y)') && fs_[0].spellings.includes('\\mathrm{FS}(Z)'));
  assert.equal(shared.some((s) => s.symbol === 'x_n'), false, 'a variable of one proof is not a notation');
  assert.ok(shared.some((s) => s.symbol === '(\\mu)'), 'a named principle in parentheses stays its own notion');
  assert.equal(shared.some((s) => s.symbol === '(\\mathcal U)'), false, 'and is not confused with another');
  // An AI proposal meeting the same notion under another spelling, with another meaning, records a variant on it.
  const before_ = (await notation()).entries;
  assert.ok(before_.some((x) => /FS\}?\(X\)/.test(x.symbol)), 'an entry for FS exists');
  const r = await app.call(key, 'POST', `/api/projects/${pid}/notation`, { symbol: 'FS(H)', meaning_text: 'Finite sums, with 0.', ai_model: 'claude-opus-5-5' });
  assert.ok(r.status < 300 || r.status === 409, JSON.stringify(r.data));
  const after_ = (await notation()).entries;
  assert.equal(after_.some((x) => x.symbol === 'FS(H)'), false, 'no second entry for the same notion');
  assert.ok(after_.some((x) => x.variants.some((v) => v.symbol === 'FS(H)')), 'recorded as a variant');
});
