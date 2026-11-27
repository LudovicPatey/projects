// Procedures: reasoning tasks the platform defines, that clients run without a new release.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let key; let pid; let tmp; let bin;

const claim = (body) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, ...body });
const clear = async () => { for (const t of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) if (['pending', 'running'].includes(t.status)) await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {}); };
const python = (code, env = {}) => spawnSync('python3', ['-c', code, CLIENT], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'c'), ...env }, timeout: 60000 });
const LOAD = 'import importlib.util, json, sys, pathlib\nspec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)\n';

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Procedures', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: ['a', 'b'].map((ref) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: 'P.' })) });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-procedures-')); bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
});
after(() => { app?.stop(); if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the system */ } } });

test('the platform lists its procedures, for clients to offer them', async () => {
  const r = await app.call(key, 'GET', '/api/ai/procedures');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.procedures.map((p) => p.id), ['ask', 'notation', 'consolidate', 'rewrite_check', 'proof_review', 'proof_repair', 'repair_check', 'statement_fix', 'fix_check', 'relink', 'relink_check', 'second_reading', 'source_check']);
  for (const p of r.data.procedures) { assert.ok(p.label && p.description && ['strong', 'fast'].includes(p.tier)); assert.match(p.version, /^[0-9a-f]{12}$/); }
  assert.deepEqual(r.data.capabilities, ['web_search', 'document']);
  assert.equal((await app.call({ token: 'nope' }, 'GET', '/api/ai/procedures')).status, 401);
});

test('a client that runs recipes gets one; others keep their own code, or do not get the task', async () => {
  await clear();
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate', prompt_text: 'Look for duplicates first.' });
  assert.equal((await claim({ kinds: ['consolidate'], features: [] })).data.task, null, 'a client from before consolidation');
  let t = (await claim({ kinds: ['consolidate'], features: ['consolidate'] })).data.task;
  assert.ok(t); assert.equal(t.recipe, undefined, 'a client with its own code gets no recipe');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
  t = (await claim({ kinds: ['consolidate'], features: ['procedures'], capabilities: [] })).data.task;
  assert.equal(t.recipe.procedure, 'consolidate');
  assert.match(t.recipe.instructions, /consolidate the facts database/); assert.match(t.recipe.instructions, /Look for duplicates first\./, 'the member\'s request is part of it');
  assert.equal(t.recipe.schema.type, 'object'); assert.deepEqual(t.recipe.capabilities, []); assert.equal(t.recipe.tier, 'strong');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
});

test('a question to the AI reads the statements of the facts, and the whole of those it cites', async () => {
  const facts = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts;
  const a = facts.find((f) => f.title === 'a'); const b = facts.find((f) => f.title === 'b');
  const asked = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'ask', prompt_text: `Is @{fact:${a.label}} the same as @{fact:${b.id}}?` })).data.id;
  for (const features of [['procedures'], []]) {
    const t = (await claim({ kinds: ['ask'], features, capabilities: ['document'] })).data.task;
    assert.ok(t, `claimed with ${features}`);
    assert.equal(t.context.facts.find((f) => f.id === a.id).statement, 'S a.', 'older clients get the statements too');
    assert.deepEqual(t.context.cited_facts.map((f) => [f.id, f.statement, f.proof]).sort(), [[a.id, 'S a.', 'P.'], [b.id, 'S b.', 'P.']].sort(), 'cited by label or by id');
    if (t.recipe) assert.match(t.recipe.instructions, /cited_facts/);
    await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
  }
  await app.call(ann, 'POST', `/api/ai/tasks/${asked}/cancel`, {});
});

test('the platform checks the answer against the schema, then applies it itself', async () => {
  const t = (await claim({ kinds: ['consolidate'], features: ['procedures'] })).data.task;
  const send = (answer, extra = {}) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 12, answer, ...extra });
  let r = await send({ summary: 'x' });
  assert.equal(r.status, 422); assert.match(r.data.error, /answer\.suggestions is missing/);
  r = await send({ summary: 'x', suggestions: [{ kind: 'merge', fact: 'a' }] });
  assert.equal(r.status, 422);
  assert.equal((await send({ summary: 'x', suggestions: [] }, { lease: 'wrong' })).status, 409);
  const none = { ref: null, statement: null, notation: null, confidence: 'low' };
  r = await send({ summary: 'Read all.', suggestions: [{ kind: 'topics', fact: 'lem:a', other_fact: null, new_kind: null, title: null, topics: ['Tag'], ...none, reason: 'Its subject.' },
    { kind: 'same', fact: 'lem:a', other_fact: 'lem:a', new_kind: null, title: null, topics: [], ...none, reason: 'invalid' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'done'); assert.match(r.data.summary_text, /^1 change proposed, 1 set aside/); assert.equal(r.data.ai_generation_ms, 12000);
  const s = (await app.call(ann, 'GET', `/api/projects/${pid}/consolidation`)).data.suggestions[0];
  assert.deepEqual(s.data.topics, ['Tag']); assert.equal(s.task_id, t.id); assert.equal(s.ai_model, 'claude-opus-5-5');
  assert.equal((await send({ summary: 'again', suggestions: [] })).status, 409, 'a finished task takes no second answer');
});

test('only procedures take an answer, and only from the client holding the task', async () => {
  await clear();
  const fid = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts[0].id;
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'review', source_type: 'fact', source_id: fid });
  const t = (await claim({ kinds: ['review'], features: ['review', 'procedures'], ai_model: 'gpt-5.6-sol' })).data.task;
  assert.ok(t); assert.equal(t.recipe, undefined, 'a review is not a procedure yet');
  assert.equal((await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, answer: { summary: 'x' } })).status, 422);
  assert.equal((await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, answer: { summary: 'x' } })).status, 403);
  await clear();
});

test('the client runs a procedure it has no code for, with the model its user chose', () => {
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a == ["--version"]: print("1.0 (Claude Code)"); sys.exit()
prompt = sys.stdin.read()
task = json.load(open("task.json"))
assert prompt.startswith("You are working for a team") and "TASK: say yes." in prompt and task["facts"] == [1], prompt
assert a[a.index("--tools") + 1] == "Read" and a[a.index("--model") + 1] == "sonnet", a
print(json.dumps({"is_error": False, "result": "", "structured_output": {"summary": "ok", "verdict": "yes"}, "modelUsage": {"claude-sonnet-5-5": {"inputTokens": 1, "outputTokens": 1}}}))
`, { mode: 0o755 });
  const r = python(`${LOAD}
class FakeApi:
    url, key = "https://example.test", "SECRET"
    def __init__(self): self.posts = []
    def post(self, path, body=None): self.posts.append((path, body)); return {"summary_text": "applied"}
    def get(self, path): return {"procedures": [{"id": "summarize", "label": "Summarize", "description": "D", "tier": "fast", "capabilities": []}, {"id": "shell_thing", "label": "X", "capabilities": ["shell"]}, {"id": "Bad id!"}]}
api = FakeApi()
oq.load_config = lambda: {"url": api.url}
rows = oq.refresh_procedures(api, 0)
print(json.dumps([[x["id"], x["runnable"]] for x in rows]))
limits = oq.clean_limits({"procedures": {"summarize": True, "extract": True, "bad id": True}})
print(json.dumps(limits["procedures"]), oq.procedure_on(limits, "summarize"), oq.procedure_on(oq.clean_limits({}), "summarize"), oq.procedure_on(oq.clean_limits({"auto_procedures": True}), "summarize"))
print(oq.chosen_model("claude", "summarize"), oq.chosen_model("claude", "consolidate"))
import argparse, os
os.chdir(sys.argv[1].rsplit("/", 2)[0])
opts = argparse.Namespace(provider="claude", model=None, timeout=60)
task = {"id": 7, "kind": "summarize", "lease": "L", "source_type": None, "source_id": None, "prompt_text": None, "context": {"facts": [1]},
        "recipe": {"instructions": "TASK: say yes.", "schema": {"type": "object", "properties": {"summary": {"type": "string"}, "verdict": {"type": "string"}}, "required": ["summary", "verdict"], "additionalProperties": False}, "capabilities": []}}
print(json.dumps(oq.process_procedure(api, task, opts)))
print(json.dumps(api.posts[-1]))
task["recipe"]["capabilities"] = ["shell"]
print(json.dumps(oq.process_procedure(api, task, opts)))
print(json.dumps(api.posts[-1]))
`);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(out[0]), [['summarize', true], ['shell_thing', false]], 'a capability the client lacks is not runnable');
  assert.equal(out[1], '{"summarize": true} True False True', 'a new procedure is off until its user turns it on, or allows new ones');
  assert.equal(out[2], 'sonnet opus', 'a fast procedure runs on a fast model by default');
  assert.deepEqual(JSON.parse(out[3]), { answered: true, summary: 'applied' });
  const [where, body] = JSON.parse(out[4]);
  assert.equal(where, '/api/ai/tasks/7/answer'); assert.deepEqual(body.answer, { summary: 'ok', verdict: 'yes' }); assert.equal(body.ai_model, 'claude-sonnet-5-5'); assert.equal(body.lease, 'L');
  const failed = JSON.parse(out[5]); const failPost = JSON.parse(out[6]);
  assert.equal(failed.answered, true); assert.equal(failPost[0], '/api/ai/tasks/7/fail'); assert.equal(failPost[1].final, true); assert.match(failPost[1].error, /shell/);
});

test('the model runs without shell or file tools, and web search only when the recipe asks', () => {
  const r = python(`${LOAD}
import pathlib
w = pathlib.Path("/tmp")
print(json.dumps(oq.provider_command("claude", w / "s", {}, w / "o", w, "opus", False)))
print(json.dumps(oq.provider_command("claude", w / "s", {}, w / "o", w, "opus", True)))
print(json.dumps(oq.provider_command("codex", w / "s", {}, w / "o", w, None, False)))
`);
  assert.equal(r.status, 0, r.stderr);
  const [plain, web, codex] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(plain[plain.indexOf('--tools') + 1], 'Read'); assert.equal(web[web.indexOf('--tools') + 1], 'Read,WebSearch');
  assert.ok(codex.includes('read-only') && !codex.includes('--search'));
});

test('a review judges the proof against its dependencies, without the web, and the source check runs unless turned off', () => {
  const r = python(`${LOAD}
import argparse, pathlib
calls = []
oq.run_ai = lambda *a: calls.append(a[5]) or ({"verdict": "correct", "explanation": "ok", "summary": "ok"}, "gpt-5.6-sol", 1)
oq.guard = lambda tool: (True, "", None, None)
class Api:
    key = "K"
    def post(self, path, body=None): return {}
task = {"id": 1, "kind": "review", "lease": "L", "ai_model": "gpt-5.6-sol", "prompt_text": None, "source_type": "fact", "source_id": 3, "context": {"fact": {"id": 3}}}
oq.process_review(Api(), task, argparse.Namespace(timeout=60), pathlib.Path("/tmp"))
print(json.dumps(calls))
print("Do not search the web" in oq.INSTRUCTIONS["review"], "cited" in oq.INSTRUCTIONS["review"], "as a fact of its own" in oq.INSTRUCTIONS["extract"])
print(oq.procedure_on(oq.clean_limits({}), "source_check"), oq.procedure_on(oq.clean_limits({"procedures": {"source_check": False}}), "source_check"))
print(oq.procedure_on(oq.clean_limits({}), "rewrite_check"), oq.procedure_on(oq.clean_limits({}), "second_reading"), oq.procedure_on(oq.clean_limits({"procedures": {"second_reading": False}}), "second_reading"))
`);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(out[0]), [false], 'no web search for a review');
  assert.equal(out[1], 'True True True');
  assert.equal(out[2], 'True False', 'this release knows the source check: on until its user turns it off');
  assert.equal(out[3], 'True True False', 'and the checks of rewrites and the second reading');
});

test('oq.py procedures lists the platform\'s work and turns it on or off', async () => {
  const cfg = path.join(tmp, 'cli');
  const run = (...args) => spawnSync('python3', [CLIENT, 'procedures', ...args], { encoding: 'utf8', env: { ...process.env, HOME: tmp, OQ_CONFIG_DIR: cfg, OQ_URL: app.base, OQ_KEY: key.token }, timeout: 30000 });
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /consolidate\s+on/); assert.match(r.stdout, /New procedures: off until you turn them on/);
  r = run('--on', 'nothing');
  assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /No procedure nothing/);
  r = run('--auto', 'on');
  assert.match(r.stdout, /turned on automatically/);
});

test('every kind of work fits the database column, as MySQL cuts longer values', () => {
  const schema = fs.readFileSync('sql/schema.mysql.sql', 'utf8');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS ai_tasks'));
  const width = +table.match(/\n\s*kind VARCHAR\((\d+)\)/)[1];
  const php = spawnSync('php', ['-r', 'require "src/bootstrap.php"; echo json_encode(App\\Controllers\\AiTaskController::kinds());'], { encoding: 'utf8' });
  assert.equal(php.status, 0, php.stderr);
  for (const k of JSON.parse(php.stdout)) assert.ok(k.length <= width, `${k} is longer than ai_tasks.kind (${width})`);
  const client = fs.readFileSync(CLIENT, 'utf8').match(/PROCEDURE_ID = re\.compile\(r"\[a-z\]\[a-z0-9_\]\{1,(\d+)\}"\)/);
  assert.ok(client && +client[1] + 1 <= width, 'a procedure name the client accepts fits the column');
  assert.match(fs.readFileSync('src/Db.php', 'utf8'), /MODIFY kind VARCHAR\(40\)/, 'existing databases get the wider column');
});

test('the AI page shows a task of a kind it does not know, such as a new procedure', () => {
  const view = fs.readFileSync('public/assets/js/views/ai.js', 'utf8');
  assert.doesNotMatch(view, /kinds\[t\.kind\]\.(?!\?)/);
});
