// A Lean proof may take dependencies as hypotheses, as the informal proof does: it then checks this fact's step alone.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let key; let pid; let tmp; let n = 0;

const python = (body) => execFileSync('python3', ['-c', `
import importlib.util, json, os, pathlib, sys, types
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
oq.data_dir().mkdir(parents=True, exist_ok=True)
${body}
`, CLIENT], { env: { ...process.env, HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, `c${++n}`) }, encoding: 'utf8' });

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Lean', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-lean-'));
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

const fact = (ref, deps = []) => ({ ref, title: `Fact ${ref}`, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `Statement ${ref}.`, proof_text: 'A proof.', depends_on: deps });
const addLean = (id, body) => app.call(key, 'POST', `/api/facts/${id}/lean`, { decl_name: 'main', lean_version: 'v4.36.0', mathlib_rev: 'v4.36.0', ai_model: 'gpt-5.6-sol', ...body });
const compiles = (lid) => app.call(key, 'POST', `/api/fact-lean/${lid}/check`, { status: 'compiles', lean_version: 'v4.36.0', ai_model: 'lean-compiler' });

test('a Lean proof relative to its dependencies is stored, shown and counted apart', async () => {
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [fact('a'), fact('other'), fact('b', ['a'])] })).data.created;
  const [a, other, b] = made.map((x) => x.id);
  const code = 'theorem main (h_a : True) : True := h_a';
  assert.equal((await addLean(b, { code, assumes: [{ fact_id: other, hypothesis: 'h_a' }] })).status, 422, 'only a dependency may be assumed');
  assert.equal((await addLean(b, { code, assumes: [{ fact_id: a, hypothesis: 'h_missing' }] })).status, 422, 'the hypothesis must be in the file');
  const added = await addLean(b, { code, assumes: [{ fact_id: a, hypothesis: 'h_a' }] });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const lid = added.data.lean_proofs[0].id;
  await compiles(lid);
  let f = (await app.call(ann, 'GET', `/api/facts/${b}`)).data;
  assert.equal(f.lean, 'relative');
  assert.deepEqual(f.lean_proofs[0].assumes.map((x) => [x.fact_id, x.hypothesis, x.lean]), [[a, 'h_a', 'none']]);
  assert.equal(f.lean_proofs[0].assumes_json, undefined);

  // Once the dependency has its own Lean proof, a Lean task on the fact sees it, and the card says so.
  const own = await addLean(a, { code: 'theorem main : True := trivial' });
  await compiles(own.data.lean_proofs[0].id);
  f = (await app.call(ann, 'GET', `/api/facts/${b}`)).data;
  assert.equal(f.lean_proofs[0].assumes[0].lean, 'compiled');
  assert.equal(f.lean, 'relative', 'still relative: the two files were not checked together');
  const list = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data;
  assert.equal((list.facts || list).find((x) => x.id === b).lean, 'relative');
  assert.equal((list.facts || list).find((x) => x.id === a).lean, 'compiled');

  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'lean', source_type: 'fact', source_id: b })).status, 201);
  const task = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'x', models: { lean: ['gpt-5.6-sol'] }, kinds: ['lean'], project_id: pid, features: ['review', 'lean'] })).data.task;
  assert.equal(task.context.dependencies[0].id, a);
  assert.match(task.context.dependencies[0].lean.code, /theorem main : True/);
});

test('the client accepts assumed dependencies only as hypotheses of the main theorem', () => {
  python(`
task = {"context": {"dependencies": [{"id": 5, "label": "F5", "statement": "S5"}]}}
ok, err = oq.lean_assumed(task, [{"fact_id": 5, "hypothesis": "h_5"}])
assert err is None and ok[0]["statement"] == "S5"
assert oq.lean_assumed(task, [{"fact_id": 6, "hypothesis": "h_6"}])[0] is None
assert oq.lean_assumed(task, [{"fact_id": 5, "hypothesis": "h 5; #eval"}])[0] is None
assert oq.lean_assumed({"context": {"dependencies": [{"label": "old server, no id"}]}}, [{"fact_id": 5, "hypothesis": "h_5"}])[0] is None
good = "import Mathlib.Tactic\\ntheorem main (n : Nat)\\n    (h_5 : ∀ m : Nat, m + 0 = m) : n + 0 = n := by\\n  exact h_5 n"
assert oq.lean_hypotheses_problem(good, "main", ok) is None
assert oq.lean_hypotheses_problem("theorem helper (h_5 : True) : True := h_5\\ntheorem main : True := trivial", "main", ok)
assert oq.lean_hypotheses_problem("variable (h_5 : False)\\ntheorem main (h_5 : False) : True := trivial", "main", ok)
`);
});

test('a hypothesis that says more than its fact makes the proof count for nothing', () => {
  python(`
class Api:
    key = "secret"; calls = []
    def post(self, url, body):
        self.calls.append((url, body)); return {"lean_proofs": [{"id": 7}]}
oq.lean_conf = lambda: {"lean": "x", "lean_path": "y", "version": "v", "mathlib_rev": "v"}
oq.lean_check = lambda code, decl, conf: (True, "ok")
oq.guard = lambda tool: (True, "", None, {})
oq.review_models = lambda opts: ["claude-fable-5-2"]
task = {"id": 1, "kind": "lean", "lease": "l", "ai_model": "claude-opus-5-5", "prompt_text": None,
        "context": {"fact": {"id": 3, "statement": "S"}, "dependencies": [{"id": 5, "label": "F5", "statement": "S5"}]}}
opts = types.SimpleNamespace(provider="claude", model=None, timeout=10)
answer = {"code": "theorem t (h_5 : False) : True := trivial", "decl_name": "t", "summary": "", "notes": "", "assumes": [{"fact_id": 5, "hypothesis": "h_5"}]}
def scenario(hyps):
    seq = list(hyps); Api.calls = []; seen = []
    def run(tool, prompt, schema, workdir, model, web, timeout):
        if "relation" in schema["properties"]:
            seen.append(json.loads((workdir / "comparison.json").read_text())["assumed"])
            return {"relation": "same", "explanation": "why", "hypotheses": [{"fact_id": 5, "relation": seq.pop(0), "explanation": "h"}]}, model, 1
        assert "h_<id>" in prompt
        return answer, "claude-opus-5-5", 1
    oq.run_ai = run
    try:
        return oq.process_lean(Api(), task, opts, pathlib.Path(os.environ["OQ_CONFIG_DIR"])), seen
    except RuntimeError as e:
        return str(e), seen
r, seen = scenario(["stronger", "stronger", "stronger"])
assert isinstance(r, str) and "stronger" in r and not Api.calls, r
assert seen[0] == [{"fact_id": 5, "hypothesis": "h_5", "statement": "S5"}]
r, seen = scenario(["implied"])
assert Api.calls[0][1]["assumes"] == [{"fact_id": 5, "hypothesis": "h_5"}] and "assuming F5" in r["summary"], (Api.calls, r)
assert "h_5 (implied)" in Api.calls[1][1]["log"]
`);
});
