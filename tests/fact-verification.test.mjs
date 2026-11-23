// Independent AI reviews, and Lean proofs recorded only after a real compile.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { requestBody, requestError } from '../public/assets/js/ai-model.js';

const ANN = '0000-0002-1825-0097'; const EVE = '0000-0002-1694-233X';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let eve; let key; let pid; let n = 0; let tmp;

const addFact = async (model = 'claude-opus-5-5') => {
  n += 1;
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: model, facts: [{ ref: `f${n}`, title: `Fact ${n}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `Statement ${n}.`, proof_text: 'A complete proof.' }] });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  return r.data.created[0].id;
};
const ask = (id, kind = 'review', who = ann) => app.call(who, 'POST', `/api/projects/${pid}/ai/tasks`, { kind, source_type: 'fact', source_id: id });
const claim = async (models, kinds = ['review'], features = ['review', 'lean']) => (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'x', models: { review: models, lean: models }, kinds, project_id: pid, features })).data.task;
const clear = async () => { for (const t of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) if (['pending', 'running'].includes(t.status)) await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {}); };
const python = (body, env = {}) => execFileSync('python3', ['-c', `
import importlib.util, json, os, pathlib, sys, subprocess, types
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
oq.data_dir().mkdir(parents=True, exist_ok=True)
${body}
`, CLIENT], { env: { ...process.env, HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, `c${++n}`), ...env }, encoding: 'utf8' });

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Checks', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-verify-'));
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('only a person requests a check, on a fact of the project', async () => {
  const id = await addFact();
  assert.equal((await ask(id, 'review', key)).status, 403);
  assert.equal((await ask(id, 'review', eve)).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'lean' })).status, 422);
  assert.equal((await ask(id)).status, 201);
  assert.equal((await ask(id)).status, 409);
  await clear();
  assert.equal(requestError({ kind: 'review' }), 'Choose a fact.');
  assert.deepEqual(requestBody({ kind: 'lean', fact: '4' }), { kind: 'lean', source_type: 'fact', source_id: 4 });
});

test('a reviewer must be independent of the author', async () => {
  await clear();
  const id = await addFact('claude-opus-5-5'); const t = (await ask(id)).data;
  for (const m of [['claude-opus-5-5'], ['claude-sonnet-5-5'], ['claude-haiku-5-5'], ['opus'], ['claude'], ['codex']]) assert.equal(await claim(m), null, m[0]);
  const got = await claim(['claude-opus-5-5', 'gpt-5.6-sol']);
  assert.equal(got.id, t.id); assert.equal(got.ai_model, 'gpt-5.6-sol');
  assert.match(got.context.fact.proof, /complete proof/);
  const review = await app.call(key, 'POST', `/api/facts/${id}/reviews`, { verdict: 'correct', body_text: 'Checked.', ai_model: 'gpt-5.6-sol' });
  assert.equal(review.status, 201);
  assert.equal((await app.call(ann, 'GET', `/api/facts/${id}`)).data.status, 'ai_checked');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: got.lease, ai_model: 'gpt-5.6-sol', fact_ids: [id], summary: 'ok' });
  const byFable = await addFact('claude-fable-5-2'); const ft = (await ask(byFable)).data;
  assert.equal(await claim(['fable']), null, 'an alias cannot review its own line');
  const op = await claim(['fable', 'opus']); assert.equal(op.id, ft.id); assert.equal(op.ai_model, 'opus');
  await app.call(key, 'POST', `/api/ai/tasks/${ft.id}/cancel`, {}); await app.call(ann, 'POST', `/api/ai/tasks/${ft.id}/cancel`, {});
  await ask(id);
  assert.equal(await claim(['gpt-5.6-sol']), null, 'the same model does not review the same revision twice');
});

test('the author model cannot review its own fact, even from another account', async () => {
  const id = await addFact('claude-opus-5-5');
  const other = await app.signIn('0000-0001-5109-3700');
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: '0000-0001-5109-3700' });
  const otherKey = { token: (await app.call(other, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  assert.equal((await app.call(otherKey, 'POST', `/api/facts/${id}/reviews`, { verdict: 'correct', body_text: 'Fine.', ai_model: 'claude-opus-5-5' })).status, 403);
});

test('older clients are not given review or Lean tasks', async () => {
  await clear();
  const id = await addFact(); await ask(id); await ask(id, 'lean');
  assert.equal((await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'old', ai_model: 'gpt-5.6-sol', project_id: pid })).data.task, null);
  await clear();
});

test('existing users are offered reviews once, and can turn them off', () => {
  python(`
(oq.data_dir() / "limits.json").write_text(json.dumps({"kinds": ["extract"]}))
assert "review" in oq.load_limits()["kinds"] and "lean" not in oq.load_limits()["kinds"]
oq.save_limits({"kinds": ["extract"]})
assert oq.load_limits()["kinds"] == ["extract"]
`);
});

test('review candidates include every signed-in tool, with no shared credential', () => {
  python(`
oq.tool_signed_in = lambda name: name == "codex"
oq.codex_fallback = lambda wait=False: "gpt-5.6-sol"; oq.codex_models = lambda wait=False: []
o = types.SimpleNamespace(provider="claude", model=None)
assert oq.review_models(o) == ["gpt-5.6-sol", "opus", "fable"], oq.review_models(o)
o.tool_hold = {"codex": 9999999999}
assert oq.review_models(o) == ["opus", "fable"]
assert issubclass(oq.ToolBusy, oq.LimitReached)
ui = oq.UI_HTML
assert "list=mnames" not in ui and "data-msel" in ui and "Other model" in ui
labels = [x["id"] for x in oq.models_public()["suggest"]["claude"]]
assert labels == ["auto", "fable", "opus", "sonnet", "haiku"]
oq.save_models("claude", {"review": "fable"}); assert oq.chosen_model("claude", "review") == "fable"
assert oq.tool_of("opus") == "claude" and oq.tool_of("claude-opus-5-5") == "claude" and oq.tool_of("gpt-5.6-sol") == "codex"
`);
});

test('code that cannot be a proof is refused before anything runs', () => {
  python(`
good = "import Mathlib.Tactic\\n\\ntheorem main_result (n : Nat) : n + 0 = n := by simp"
assert oq.lean_problem(good, "main_result") is None
for bad in ("theorem main_result : 1 = 2 := by sorry", "axiom x : False\\ntheorem main_result : False := x", "import Lean\\ntheorem main_result : True := trivial", "#eval IO.FS.readFile \\"/etc/passwd\\"\\ntheorem main_result : True := trivial", "run_cmd pure ()\\ntheorem main_result : True := trivial", "unsafe def x := 1\\ntheorem main_result : True := trivial", "macro \\"x\\" : tactic => \`(tactic| skip)\\ntheorem main_result : True := trivial", "theorem main_result : 1 = 1 := by native_decide", "theorem other : True := trivial"):
    assert oq.lean_problem(bad, "main_result"), bad
assert oq.lean_problem(good, "bad name; #eval")
`);
});

test('a proof counts only if it compiles with the standard axioms', () => {
  python(`
code = "import Mathlib.Tactic\\ntheorem t : True := trivial"
conf = {"lean": "x", "lean_path": "y", "version": "v", "mathlib_rev": "v"}
def out(stdout, code=0, stderr=""):
    oq.lean_run = lambda *a: types.SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)
    return oq.lean_check(oq.CODE if False else globals()["code"], "t", conf)[0]
assert out("'t' depends on axioms: [propext, Classical.choice, Quot.sound]")
assert out("'t' does not depend on any axioms")
assert not out("'t' depends on axioms: [propext, sorryAx]")
assert not out("'t' depends on axioms: [myAxiom]")
assert not out("Check.lean:2:0: error: unknown tactic\\n't' does not depend on any axioms")
assert not out("'t' does not depend on any axioms", 1)
assert not out("no axiom line")
`);
});

test('compilation has no network and cannot read the user files', () => {
  python(`
t = pathlib.Path(os.environ["HOME"]) / "work"; t.mkdir(exist_ok=True)
p = oq.lean_profile(t); home = os.path.realpath(os.environ["HOME"])
assert "(deny network*)" in p and "(deny file-write*)" in p and f'(deny file-read* (subpath "{home}"))' in p
assert f'(allow file-write* (subpath "{os.path.realpath(t)}")' in p
assert "(allow file-read-metadata)" in p and f'(allow file-read* (literal "{home}")' not in p
oq.sys.platform = "linux"
try:
    oq.lean_run({"lean": "x", "lean_path": "y"}, t / "a", t, 1); raise SystemExit("ran without a sandbox")
except RuntimeError:
    pass
`);
});

test('the client records a review and a compiled Lean proof, and never a failed one', async () => {
  await clear();
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a == ["--version"]: print("1.0"); sys.exit()
if a[:2] == ["auth", "status"]: print("{}"); sys.exit()
schema = json.loads(a[a.index("--json-schema") + 1])
sys.stdin.read()
model = a[a.index("--model") + 1] if "--model" in a else "fable"
if "verdict" in schema["properties"]:
    out = {"summary": "Found a gap.", "verdict": "gap", "explanation": "Step 2 is unjustified."}
elif "relation" in schema["properties"]:
    out = {"relation": "same", "explanation": "Identical."}
else:
    out = {"summary": "s", "decl_name": "main_result", "code": "theorem main_result : True := trivial", "notes": "n"}
print(json.dumps({"is_error": False, "result": "", "structured_output": out, "modelUsage": {("claude-opus-5-5" if "opus" in model else "claude-fable-5-2"): {"inputTokens": 1, "outputTokens": 1}}}))
`, { mode: 0o755 });
  const id = await addFact('gpt-5.6-sol'); const r = (await ask(id)).data; const l = (await ask(id, 'lean')).data;
  const dir = path.join(tmp, 'runc'); fs.mkdirSync(dir, { recursive: true });
  const script = `
import importlib.util, json, os, subprocess, sys, types
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
oq.data_dir().mkdir(parents=True, exist_ok=True); oq.lean_root().mkdir(parents=True, exist_ok=True)
(oq.lean_root() / "lean.json").write_text(json.dumps({"lean": "x", "lean_path": "y", "version": "v4.36.0", "mathlib_rev": "v4.36.0"}))
oq.save_limits({"kinds": ["review", "lean"]})
oq.lean_run = lambda *a: types.SimpleNamespace(returncode=0, stdout="'main_result' does not depend on any axioms", stderr="")
sys.argv = ["oq", "run", "--once", "--provider", "claude", "--project", sys.argv[2], "--only", "review,lean"]
sys.exit(oq.main())
`;
  const out = spawnSync('python3', ['-c', script, CLIENT, String(pid)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OQ_CONFIG_DIR: path.join(dir, 'c'), OQ_URL: app.base, OQ_KEY: key.token }, encoding: 'utf8', timeout: 60000 });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  const tasks = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks;
  assert.equal(tasks.find((t) => t.id === r.id).status, 'done', tasks.find((t) => t.id === r.id).error_text);
  assert.equal(tasks.find((t) => t.id === l.id).status, 'done', tasks.find((t) => t.id === l.id).error_text);
  const f = (await app.call(ann, 'GET', `/api/facts/${id}`)).data;
  assert.equal(f.status, 'disputed'); assert.equal(f.lean_proofs.length, 1);
  assert.equal(f.lean_proofs[0].check_status, 'compiles'); assert.equal(f.lean_proofs[0].lean_version, 'v4.36.0');
  assert.match(tasks.find((t) => t.id === l.id).summary_text, /judged that its statement matches/);
  assert.match(f.lean_proofs[0].check_log, /Statement check by/);
});

test('a compiled file counts only if an independent model says it states the fact', () => {
  python(`
class Api:
    key = "secret"; calls = []
    def post(self, url, body):
        self.calls.append((url, body))
        return {"lean_proofs": [{"id": 7}]}
oq.lean_conf = lambda: {"lean": "x", "lean_path": "y", "version": "v", "mathlib_rev": "v"}
oq.lean_check = lambda code, decl, conf: (True, "ok")
oq.guard = lambda tool: (True, "", None, {})
oq.review_models = lambda opts: ["claude-opus-5-5", "claude-fable-5-2"]
task = {"id": 1, "kind": "lean", "lease": "l", "ai_model": "claude-opus-5-5", "prompt_text": None, "context": {"fact": {"id": 3, "statement": "S"}}}
opts = types.SimpleNamespace(provider="claude", model=None, timeout=10)
def scenario(relations):
    seq = list(relations); Api.calls = []
    def run(tool, prompt, schema, workdir, model, web, timeout):
        if "relation" in schema["properties"]:
            assert model == "claude-fable-5-2", "the author cannot check itself"
            return {"relation": seq.pop(0), "explanation": "why"}, model, 1
        return {"code": "theorem t : True := trivial", "decl_name": "t", "summary": "", "notes": "this was not compiled"}, "claude-opus-5-5", 1
    oq.run_ai = run
    w = pathlib.Path(os.environ["OQ_CONFIG_DIR"]); return oq.process_lean(Api(), task, opts, w)
r = scenario(["same"]); assert [u for u, _ in Api.calls] == ["/api/facts/3/lean", "/api/fact-lean/7/check"] and "not compiled" not in r["summary"]
r = scenario(["negation"]); assert len(Api.calls) == 1 and Api.calls[0][0] == "/api/facts/3/reviews" and Api.calls[0][1]["verdict"] == "incorrect" and "refuted" in r["summary"]
r = scenario(["weaker", "different", "same"]); assert [u for u, _ in Api.calls] == ["/api/facts/3/lean", "/api/fact-lean/7/check"]
try:
    scenario(["weaker", "stronger", "different"]); raise SystemExit("recorded")
except RuntimeError as e:
    assert not Api.calls and "No matching" in str(e)
oq.review_models = lambda opts: ["claude-opus-5-5"]
try:
    scenario(["same"]); raise SystemExit("recorded without an independent check")
except RuntimeError as e:
    assert not Api.calls and "independent" in str(e)
`);
});
