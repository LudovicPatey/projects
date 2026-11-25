// The native prover in the client: the tools process, the gateway that holds the key, the verifier, and full rounds.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let key; let pid; let qid; let checked; let tmp; let bin;

const LOAD = 'import importlib.util, json, sys, pathlib\nspec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)\n';
const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'c') });
const python = (code) => spawnSync('python3', ['-c', code, CLIENT], { encoding: 'utf8', env: env(), timeout: 60000 });

// Claude, played by a script: as a worker it launches the tools process from --mcp-config and calls the tools like Claude would;
// with a schema it answers as the lead, the verifier or the source check.
const FAKE_CLAUDE = `#!/usr/bin/env python3
import json, os, subprocess, sys
a = sys.argv[1:]
prompt = sys.stdin.read()
log = open(os.environ["HOME"] + "/claude.log", "a")
def out(structured=None, result=""):
    print(json.dumps({"is_error": False, "result": result, "structured_output": structured, "modelUsage": {"claude-opus-5-5" if "--mcp-config" in a or "lanes" in prompt else "claude-sonnet-5-5": {"inputTokens": 5, "outputTokens": 5}}}))
if "--mcp-config" in a:
    log.write("worker " + json.dumps(a) + "\\n")
    srv = json.loads(a[a.index("--mcp-config") + 1])["mcpServers"]["prover"]
    p = subprocess.Popen([srv["command"]] + srv["args"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    n = [0]
    def rpc(method, params=None):
        n[0] += 1
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": n[0], "method": method, "params": params or {}}) + "\\n"); p.stdin.flush()
        return json.loads(p.stdout.readline())
    rpc("initialize", {"protocolVersion": "2025-06-18"})
    names = [t["name"] for t in rpc("tools/list")["result"]["tools"]]
    call = lambda name, args: json.loads(rpc("tools/call", {"name": name, "arguments": args})["result"]["content"][0]["text"])
    found = call("fact_search", {"query": "checked lemma"})["results"]
    base = [f for f in found if f["usable"]][0]
    bad = call("fact_submit", {"title": "Bad", "statement": "S bad.", "proof": "WRONG step.", "depends_on": [base["id"]]})
    good = call("fact_submit", {"title": "Good", "statement": "S good.", "proof": "By the checked lemma.", "depends_on": [base["id"]]})
    loose = [f for f in call("fact_search", {"query": "loose"})["results"] if not f["usable"]][0]
    refused = call("fact_submit", {"title": "On loose", "statement": "S x.", "proof": "By loose.", "depends_on": [loose["id"]]})
    verified = call("fact_verify", {"id": loose["id"]})
    cited = call("cite_result", {"title": "Hindman", "statement": "IP sets.", "reference": {"title": "Finite sums", "year": 1974}})
    note = call("note_add", {"kind": "dead_end", "claim": "Induction on k", "evidence": "Fails at 3."})
    seen = call("note_search", {"query": "induction"})["results"]
    p.stdin.close(); p.wait()
    json.dump({"names": names, "bad": bad, "good": good, "refused": refused, "verified": verified, "cited": cited, "note": note, "seen": seen, "argv": a}, open(os.environ["HOME"] + "/worker.json", "w"))
    out(result="Found one lemma.")
elif "lanes" in prompt:
    log.write("lead\\n")
    out({"summary": "Start.", "elaboration": "Nothing yet.", "guidance": "Try ultrafilters.", "lanes": [{"title": "Ultrafilters", "task": "Build one."}], "stop": False})
elif "cite.json" in prompt:
    out({"verdict": "confirmed", "explanation": "Theorem 3.1."})
elif "claim.json" in prompt:
    claim = json.load(open("claim.json"))
    log.write("verify " + json.dumps(claim["cited_facts"]) + "\\n")
    ok = "WRONG" not in claim["proof"]
    out({"verdict": "correct" if ok else "wrong", "report": "Checked." if ok else "Step 1 is wrong.", "repair_hints": "" if ok else "Fix step 1."})
else:
    out({"ok": "ok"})
`;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Prover client', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  qid = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Triples?' })).data.id;
  const F = (ref, st) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: st, proof_text: `Proof of ${ref}.` });
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'gpt-5.6-sol', facts: [F('checked', 'The checked lemma holds.'), F('loose', 'A loose claim.')] })).data.created;
  checked = made[0].id;
  await app.call(ann, 'POST', `/api/facts/${checked}/reviews`, { verdict: 'correct' });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-prover-')); bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.mkdirSync(path.join(tmp, 'c')); fs.writeFileSync(path.join(tmp, 'c/config.json'), JSON.stringify({ url: app.base, key: key.token }));
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('the tools process speaks MCP, and forwards each call with the round\'s token', async () => {
  const seen = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { seen.push([req.headers['x-oq-token'], JSON.parse(b)]); res.end(JSON.stringify({ result: { ok: 1 } })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const p = spawn('python3', [CLIENT, 'prover-tools', '--port', String(server.address().port), '--token', 'T0K'], { env: env() });
  const lines = []; let buf = '';
  p.stdout.on('data', (d) => { buf += d; const parts = buf.split('\n'); buf = parts.pop(); lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l))); });
  const send = (m) => p.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fact_search', arguments: { query: 'x' } } });
  send({ jsonrpc: '2.0', id: 4, method: 'nope' });
  const end = Date.now() + 8000; while (lines.length < 4 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  p.kill(); server.close();
  assert.equal(lines[0].result.serverInfo.name, 'prover'); assert.ok(lines[0].result.capabilities.tools);
  assert.deepEqual(lines[1].result.tools.map((t) => t.name), ['fact_search', 'fact_read', 'note_search', 'note_add', 'fact_submit', 'fact_verify', 'cite_result']);
  assert.deepEqual(JSON.parse(lines[2].result.content[0].text), { ok: 1 }); assert.equal(lines[2].result.isError, false);
  assert.equal(lines[3].error.code, -32601);
  assert.deepEqual(seen, [['T0K', { name: 'fact_search', arguments: { query: 'x' } }]]);
});

test('the AI gets the tools and web search, and no shell or file writing; the gateway refuses a wrong token', () => {
  const r = python(`${LOAD}
class Box:
    def call(self, name, args): return {"called": name, "args": args}
g = oq.ProverGateway(Box())
c = oq.worker_command("claude", g, pathlib.Path("/tmp/w"), "opus", True)
print(json.dumps(c))
print(json.dumps(oq.worker_command("codex", g, pathlib.Path("/tmp/w"), None, True)))
import urllib.request
def post(token):
    req = urllib.request.Request(f"http://127.0.0.1:{g.port}/tool", data=json.dumps({"name": "fact_read", "arguments": {"id": 3}}).encode(), headers={"X-OQ-Token": token, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req) as res: return json.loads(res.read())
    except urllib.error.HTTPError as e: return e.code
print(json.dumps([post("wrong"), post(g.token)]))
g.close()
`);
  assert.equal(r.status, 0, r.stderr);
  const [claude, codex, calls] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,WebSearch'); assert.ok(claude.includes('--strict-mcp-config'));
  assert.ok(claude.includes('mcp__prover')); assert.ok(!claude.join(' ').includes('Bash'));
  const cfg = JSON.parse(claude[claude.indexOf('--mcp-config') + 1]).mcpServers.prover;
  assert.ok(cfg.args.includes('prover-tools')); assert.ok(!JSON.stringify(cfg).includes(key.token), 'the platform key is not given to the AI tool');
  assert.ok(codex.includes('read-only')); assert.match(codex.join(' '), /mcp_servers\.prover=\{command=.*tool_timeout_sec=7200\}/);
  assert.deepEqual(calls, [403, { result: { called: 'fact_read', args: { id: 3 } } }]);
});

test('a full campaign: the lead gives lanes, a worker proves, its verifier judges, and the platform records it all', async () => {
  const run = (args) => spawnSync('python3', [CLIENT, 'prove', 'run', '--project', String(pid), '--question', String(qid), '--workers', '1', '--once', '--provider', 'claude', '--model', 'claude-opus-5-5', '--verifier', 'claude', '--verifier-model', 'claude-sonnet-5-5', ...args], { encoding: 'utf8', env: env(), timeout: 120000 });
  let r = run([]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /round \d+, lead/);
  const c = (await app.call(ann, 'GET', `/api/projects/${pid}/prover/campaigns`)).data.campaigns[0];
  assert.equal(c.guidance.lanes[0].title, 'Ultrafilters'); assert.ok(c.strategy_id);
  r = run([]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /lane 1: Ultrafilters/); assert.match(r.stdout, /done in 0 min\. Found one lemma\./);
  const w = JSON.parse(fs.readFileSync(path.join(tmp, 'worker.json')));
  assert.equal(w.bad.accepted, false); assert.equal(w.bad.repair_hints, 'Fix step 1.');
  assert.equal(w.good.accepted, true); assert.match(w.good.label, /good/);
  assert.match(w.refused.error, /not usable yet/, 'no verifier is spent on a proof that cites an unchecked fact');
  assert.equal(w.verified.accepted, true); assert.equal(w.verified.usable, true, 'once verified, the loose fact is usable');
  assert.equal(w.cited.source_check, 'confirmed'); assert.equal(w.cited.usable, true);
  assert.equal(w.seen[0].claim, 'Induction on k');
  const log = fs.readFileSync(path.join(tmp, 'claude.log'), 'utf8');
  assert.match(log, /verify \[\{"id": \d+, "label": "[^"]+", "statement": "The checked lemma holds\."\}\]/, 'the verifier gets the cited facts, and nothing else of the project');
  const good = (await app.call(ann, 'GET', `/api/facts/${w.good.fact_id}`)).data;
  assert.equal(good.tool, 'prover'); assert.equal(good.ai_model, 'claude-opus-5-5'); assert.equal(good.reviews[0].ai_model, 'claude-sonnet-5-5'); assert.equal(good.status, 'ai_checked');
  const stats = (await app.call(ann, 'GET', `/api/projects/${pid}/prover/stats`)).data.native;
  assert.equal(stats.facts, 2); assert.equal(stats.rejected_by_verifier, 1);
  const rounds = (await app.call(ann, 'GET', `/api/prover/campaigns/${c.id}`)).data.recent_rounds;
  assert.deepEqual(rounds.map((x) => [x.kind, x.status, x.facts, x.rejected]), [['worker', 'done', 1, 1], ['lead', 'done', 0, 0]]);
  const st = spawnSync('python3', [CLIENT, 'prove', 'stats', '--project', String(pid)], { encoding: 'utf8', env: env() });
  assert.match(st.stdout, /native\s+2 facts/); assert.match(st.stdout, /danus\s+0 facts/);
});
