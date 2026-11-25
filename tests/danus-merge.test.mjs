// A proof search builds on the project's database: every run first merges the platform's facts and strategies into Danus.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const EVE = '0000-0003-1415-9265';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let key; let pid; let qid; let id; let tmp;

const LOAD = 'import importlib.util, json, sys, pathlib\nspec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)\n';
const python = (code, env = {}) => spawnSync('python3', ['-c', code, CLIENT], { encoding: 'utf8', env: { ...process.env, HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'c'), ...env }, timeout: 60000 });

// A small stand-in for Danus's storage, with the same functions and the same rules: content-addressed facts, a refused
// revoked predecessor, revocation of everything built on a fact, and typed shared memory.
const STUB = {
  'danus/__init__.py': '',
  'danus/execution/__init__.py': '',
  'danus/execution/layout.py': 'import os, pathlib\ndef project_dir(name):\n    return pathlib.Path(os.environ["DANUS_AGENTS_ROOT"]) / name\n',
  'danus/core/__init__.py': `import hashlib, json, pathlib, shutil
class FactGraph:
    def __init__(self, root):
        self.facts = pathlib.Path(root) / "fact_graph" / "facts"; self.revoked = pathlib.Path(root) / "fact_graph" / "_revoked"
    def exists(self, fid): return (self.facts / f"{fid}.md").exists()
    def add(self, *, problem_id, author, statement, proof, predecessors=None, glossary_introduces=None, external_refs=None, intuition=""):
        for p in predecessors or []:
            if (self.revoked / f"{p}.md").exists(): raise ValueError("predecessor_revoked: " + p)
        fid = hashlib.sha256(json.dumps([problem_id, sorted(predecessors or []), sorted((glossary_introduces or {}).items()), statement, proof]).encode()).hexdigest()[:16]
        self.facts.mkdir(parents=True, exist_ok=True)
        (self.facts / f"{fid}.md").write_text(json.dumps({"author": author, "predecessors": predecessors or [], "statement": statement, "proof": proof, "refs": external_refs or []}))
        return fid
    def descendants(self, fid):
        out = []
        for p in self.facts.glob("*.md"):
            if fid in json.loads(p.read_text())["predecessors"]: out += [p.stem] + self.descendants(p.stem)
        return out
    def revoke(self, fid, reason):
        ids = [fid] + self.descendants(fid); self.revoked.mkdir(parents=True, exist_ok=True)
        for x in ids:
            if (self.facts / f"{x}.md").exists(): shutil.move(str(self.facts / f"{x}.md"), str(self.revoked / f"{x}.md"))
        return ids
class GlobalMemory:
    def __init__(self, root): self.dir = pathlib.Path(root) / "global_memory"
    def append(self, kind, claim, evidence, author, *, verifiable=None, links=None, glossary=None, **extra):
        if verifiable and not evidence.strip(): raise ValueError("evidence")
        self.dir.mkdir(parents=True, exist_ok=True)
        n = sum(1 for _ in self.dir.glob("*.jsonl")) * 1000 + len((self.dir / f"{kind}.jsonl").read_text().splitlines() if (self.dir / f"{kind}.jsonl").exists() else [])
        gid = f"{kind[:2]}{n:06d}"
        with open(self.dir / f"{kind}.jsonl", "a") as f: f.write(json.dumps({"id": gid, "kind": kind, "claim": claim, "evidence": evidence, "author": author, "verifiable": verifiable, "links": links or {}, **extra}) + "\\n")
        return gid
`,
};

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Merge', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  qid = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Triples?' })).data.id;
  const F = (ref, extra) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `P ${ref}.`, ...extra });
  id = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    F('base'), F('above', { depends_on: ['base'] }), F('loose', { depends_on: ['above'] }), F('doubt'),
  ] })).data.created.map((x) => [x.ref, x.id]));
  for (const f of ['base', 'above', 'doubt']) await app.call(ann, 'POST', `/api/facts/${id[f]}/reviews`, { verdict: 'correct' });
  await app.call(ann, 'POST', `/api/facts/${id.doubt}/reviews`, { verdict: 'incorrect', statement: 'false', body_text: 'Counterexample.' });
  await app.call(ann, 'POST', `/api/questions/${qid}/strategies`, { title: 'Use ultrafilters', body_text: 'Idempotents.', status: 'active' });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-merge-'));
  for (const [f, text] of Object.entries(STUB)) { fs.mkdirSync(path.dirname(path.join(tmp, 'stub', f)), { recursive: true }); fs.writeFileSync(path.join(tmp, 'stub', f), text); }
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('the platform gives a proof search every fact, what it may build on, and the question\'s strategies', async () => {
  const r = await app.call(key, 'GET', `/api/projects/${pid}/proving-context?question=${qid}`);
  assert.equal(r.status, 200);
  const f = Object.fromEntries(r.data.facts.map((x) => [x.title, x]));
  assert.equal(f.base.trusted, true); assert.equal(f.above.trusted, true); assert.deepEqual(f.above.deps, [id.base]);
  assert.equal(f.loose.trusted, false, 'nobody checked it'); assert.equal(f.doubt.trusted, false, 'disputed'); assert.equal(f.doubt.status, 'disputed');
  assert.equal(f.above.statement, 'S above.'); assert.equal(f.above.proof, 'P above.'); assert.equal(f.above.revision, 1);
  assert.deepEqual(r.data.strategies.map((s) => [s.title, s.status, s.body]), [['Use ultrafilters', 'active', 'Idempotents.']]);
  const eve = await app.signIn(EVE);
  assert.equal((await app.call(eve, 'GET', `/api/projects/${pid}/proving-context`)).status, 403);
});

test('the merge puts established facts in the graph, the others in memory as claims, and only adds what changed', async () => {
  const ctx = (await app.call(key, 'GET', `/api/projects/${pid}/proving-context?question=${qid}`)).data;
  const root = path.join(tmp, 'projects'); fs.mkdirSync(path.join(root, 'oq1q1'), { recursive: true });
  const run = (data) => {
    const r = python(`${LOAD}\nimport subprocess, os\np = subprocess.run([sys.executable, "-c", oq.DANUS_MERGE, "oq1q1"], input=sys.stdin.read() if False else ${JSON.stringify(JSON.stringify(data))}, capture_output=True, text=True, env={**os.environ, "PYTHONPATH": ${JSON.stringify(path.join(tmp, 'stub'))}, "DANUS_AGENTS_ROOT": ${JSON.stringify(root)}})\nprint(p.stdout.strip() or p.stderr)`);
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const first = run({ facts: ctx.facts, strategies: ctx.strategies, own_strategies: [] });
  assert.deepEqual([first.facts, first.claims, first.strategies, first.building_on], [2, 1, 1, 2]);
  const map = JSON.parse(fs.readFileSync(path.join(root, 'oq1q1/platform_map.json'))).facts;
  const facts = path.join(root, 'oq1q1/fact_graph/facts');
  const above = JSON.parse(fs.readFileSync(path.join(facts, `${map[id.above].danus}.md`)));
  assert.equal(above.author, 'platform'); assert.deepEqual(above.predecessors, [map[id.base].danus], 'its dependencies are Danus ids');
  const claim = JSON.parse(fs.readFileSync(path.join(root, 'oq1q1/global_memory/conclusion.jsonl'), 'utf8').trim());
  assert.equal(claim.claim, 'S loose.'); assert.equal(claim.evidence, 'P loose.'); assert.equal(claim.verifiable, true); assert.equal(claim.platform_id, id.loose);
  assert.equal(map[id.loose].gm, claim.id); assert.equal(map[id.doubt].danus, null);
  assert.match(fs.readFileSync(path.join(root, 'oq1q1/global_memory/direction.jsonl'), 'utf8'), /Use ultrafilters \(a strategy of the team, active\)/);
  assert.deepEqual(run({ facts: ctx.facts, strategies: ctx.strategies }), { facts: 0, claims: 0, known: 0, revoked: 0, strategies: 0, building_on: 2 }, 'nothing new');
  // The base is disputed on the platform: it leaves Danus, with what was built on it.
  const changed = ctx.facts.map((f) => (f.id === id.base ? { ...f, status: 'disputed', trusted: false } : f.id === id.above ? { ...f, trusted: false } : f));
  const third = run({ facts: changed, strategies: ctx.strategies, own_strategies: [ctx.strategies[0].id] });
  assert.equal(third.revoked, 2); assert.equal(third.building_on, 0); assert.equal(third.claims, 1, 'the fact above becomes a claim to check');
});

test('a merge on the real Danus, when this computer has it', { skip: !fs.existsSync(path.join(os.homedir(), '.config/open-questions/danus-native/danus/runtime/venv/bin/python')) }, async () => {
  const ctx = (await app.call(key, 'GET', `/api/projects/${pid}/proving-context?question=${qid}`)).data;
  const home = path.join(os.homedir(), '.config/open-questions/danus-native/danus');
  const root = path.join(tmp, 'real'); fs.mkdirSync(path.join(root, 'oq9'), { recursive: true });
  const code = spawnSync('python3', ['-c', `${LOAD}print(oq.DANUS_MERGE)`, CLIENT], { encoding: 'utf8' }).stdout;
  const r = spawnSync(path.join(home, 'runtime/venv/bin/python'), ['-c', code, 'oq9'], { cwd: home, input: JSON.stringify({ facts: ctx.facts, strategies: ctx.strategies }), encoding: 'utf8', env: { ...process.env, DANUS_AGENTS_ROOT: root } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.building_on, 2); assert.equal(out.claims, 1);
  const files = fs.readdirSync(path.join(root, 'oq9/fact_graph/facts'));
  assert.equal(files.length, 2); assert.match(fs.readFileSync(path.join(root, 'oq9/fact_graph/facts', files[0]), 'utf8'), /author: platform/);
});

test('back on the platform: merged facts are not sent again, and Danus facts built on them rely on the platform facts', () => {
  const g = path.join(tmp, 'push/fact_graph/facts'); fs.mkdirSync(g, { recursive: true });
  const fact = (fid, author, preds, st) => fs.writeFileSync(path.join(g, `${fid}.md`), `---\nfact_id: ${fid}\nauthor: ${author}\npredecessors: [${preds.join(', ')}]\n---\n\n## statement\n\n${st}\n\n## proof\n\nP.\n`);
  fact('aaaaaaaaaaaaaaaa', 'platform', [], 'Merged.'); fact('bbbbbbbbbbbbbbbb', 'w1', ['aaaaaaaaaaaaaaaa'], 'New.'); fact('cccccccccccccccc', 'w1', [], 'Sent before.');
  const r = python(`${LOAD}
class Api:
    posts = []
    def post(self, path, body=None): self.posts.append(body); return {"created": [{"id": 50}], "skipped": []}
api = Api()
print(json.dumps(oq.danus_push(api, pathlib.Path(${JSON.stringify(path.join(tmp, 'push/fact_graph'))}), 1, "m", False, skip={"cccccccccccccccc"}, translate={"aaaaaaaaaaaaaaaa": 7})))
print(json.dumps([[f["fact_id"], f["predecessors"], "author" in f] for f in api.posts[0]["facts"]]))
`);
  assert.equal(r.status, 0, r.stderr);
  const [res, sent] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(res, [[50], 0]); assert.deepEqual(sent, [['bbbbbbbbbbbbbbbb', ['7'], false]]);
});

test('the verifier\'s verdicts on the team\'s claims become reviews, and Danus\'s summary a strategy of the question', () => {
  const g = path.join(tmp, 'sync'); fs.mkdirSync(path.join(g, 'global_memory'), { recursive: true });
  const line = (x) => `${JSON.stringify(x)}\n`;
  fs.writeFileSync(path.join(g, 'global_memory/verification.jsonl'), line({ verdict: 'wrong', evidence: 'Step 2 fails.', links: { source_id: 'g1' } }) + line({ verdict: 'correct', fact_id: 'ffffffffffffffff', links: { source_id: 'g1' } }) + line({ verdict: 'wrong', evidence: 'No.', links: { source_id: 'g2' } }) + line({ verdict: 'correct', fact_id: 'eeee', links: { source_id: 'other' } }));
  fs.writeFileSync(path.join(g, 'global_memory/elaboration.jsonl'), line({ claim: 'Pairs are done.', evidence: 'Triples remain.' }));
  const r = python(`${LOAD}
oq.load_config = lambda: {"url": "https://example.test"}
class Api:
    calls = []
    def post(self, p, body=None): self.calls.append(["POST", p, body]); return {"id": 33}
    def patch(self, p, body=None): self.calls.append(["PATCH", p, body]); return {}
api = Api(); run = oq.DanusRun()
s = run.write(model="gpt-x", question_id=5, project_id=1)
g = pathlib.Path(${JSON.stringify(g)})
print(json.dumps(run.checks(api, g, {"11": {"gm": "g1"}, "12": {"gm": "g2"}}, s)))
run.checks(api, g, {"11": {"gm": "g1"}, "12": {"gm": "g2"}}, s)
run.share_strategy(api, g, s, "oq1q5"); run.share_strategy(api, g, s, "oq1q5")
(g / "global_memory" / "master_guidance.jsonl").write_text(json.dumps({"claim": "Try colorings of triples.", "evidence": ""}) + "\\n")
run.share_strategy(api, g, s, "oq1q5")
print(json.dumps(api.calls))
print(json.dumps(oq.danus_memo("oq1q5")))
`);
  assert.equal(r.status, 0, r.stderr);
  const [promoted, calls, memo] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(promoted, { ffffffffffffffff: 11 }, 'the verified fact is the platform fact, not a new one');
  const reviews = calls.filter((c) => c[1].endsWith('/reviews'));
  assert.deepEqual(reviews.map((c) => [c[1], c[2].verdict, c[2].ai_model]), [['/api/facts/11/reviews', 'correct', 'gpt-x'], ['/api/facts/12/reviews', 'gap', 'gpt-x']], 'once each');
  assert.match(reviews[1][2].body_text, /did not accept this proof as written\. No\./);
  const strat = calls.filter((c) => !c[1].endsWith('/reviews'));
  assert.deepEqual(strat.map((c) => [c[0], c[1]]), [['POST', '/api/questions/5/strategies'], ['PATCH', '/api/strategies/33']], 'created once, then revised when it changes');
  assert.match(strat[0][2].body_text, /State of the search[\s\S]*Pairs are done\.[\s\S]*Triples remain\./); assert.match(strat[1][2].body_text, /Next steps[\s\S]*colorings of triples/);
  assert.equal(memo.strategy, 33);
});

test('runs on one question share one Danus project, which a later run continues', () => {
  const r = python(`${LOAD}
print(oq.danus_question({"question_id": 4}), oq.danus_question({"source_type": "question", "source_id": 6}), oq.danus_question({"source_type": "fact", "source_id": 6}))
print("source_id" in oq.DANUS_DATABASE_NOTE and "do not prove them again" in oq.DANUS_DATABASE_NOTE)
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['4 6 None', 'True']);
  const src = fs.readFileSync(CLIENT, 'utf8');
  assert.match(src, /name = f"oq\{s\['project_id'\]\}q\{qid\}" if qid else f"oq\{s\['project_id'\]\}"/);
  assert.match(src, /self\.merge\(api, dm, vm, s, name\)\n\s+p = dm\.sh\(vm, f"cd \{DANUS_HOME\} && bin\/danus start/, 'every start merges first, resumes included');
});
