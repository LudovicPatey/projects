// Reading suggestions from the consolidation, and the continuous lead of the native prover.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let bob; let key; let pid; let qid; let id; let tmp; let bin;

const propose = async (x) => (await app.call(key, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ reason: 'It settles pairs.', ...x }] })).data;
const reading = async (who) => (await app.call(who, 'GET', `/api/projects/${pid}/dashboard`)).data.reading;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Reading', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB, role: 'member' });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  qid = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Triples?' })).data.id;
  const F = (ref) => ({ ref, title: ref, kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `P ${ref}.` });
  id = Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'gpt-5.6-sol', facts: [F('key'), F('other'), F('third')] })).data.created.map((x) => [x.ref, x.id]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-lead-')); bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.mkdirSync(path.join(tmp, 'c')); fs.writeFileSync(path.join(tmp, 'c/config.json'), JSON.stringify({ url: app.base, key: key.token }));
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('the consolidation flags real progress, and every member finds it among their reading suggestions', async () => {
  assert.deepEqual(await reading(ann), []);
  const r = await propose({ kind: 'progress', fact: id.key, confidence: 'high' });
  assert.equal(r.applied.length, 1, 'confident: applied at once');
  const low = await propose({ kind: 'progress', fact: id.other, confidence: 'low' });
  assert.equal(low.applied.length, 0, 'unsure: it waits for people');
  assert.equal((await propose({ kind: 'progress', fact: id.key, confidence: 'high' })).skipped[0].reason, 'This fact is already marked as worth reading.');
  for (const who of [ann, bob]) assert.deepEqual((await reading(who)).map((x) => [x.id, x.reason, x.model]), [[id.key, 'It settles pairs.', 'claude-opus-5-5']]);
  const f = (await app.call(ann, 'GET', `/api/facts/${id.key}`)).data;
  assert.equal(f.worth_reading.reason, 'It settles pairs.');
  assert.equal(f.history[0].kind, 'progress');
  const ctx = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate' })).data;
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds: ['consolidate'], features: ['procedures'], capabilities: [] })).data.task;
  assert.equal(t.context.fact_texts.find((x) => x.id === id.key).worth_reading, true);
  assert.match(t.recipe.instructions, /"progress"/); assert.ok(t.recipe.schema.properties.suggestions.items.properties.kind.enum.includes('progress'));
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease }); await app.call(ann, 'POST', `/api/ai/tasks/${ctx.id}/cancel`, {});
});

test('it leaves a member\'s suggestions once they open it, review it or set it aside; undoing the flag removes it', async () => {
  await app.call(ann, 'POST', `/api/projects/${pid}/read`, { items: [{ type: 'fact', id: id.key }] });
  assert.deepEqual(await reading(ann), [], 'opened since it was flagged');
  assert.equal((await reading(bob)).length, 1, 'others still have it');
  assert.equal((await app.call(key, 'POST', `/api/facts/${id.key}/reading/dismiss`, {})).status, 403);
  const r = await app.call(bob, 'POST', `/api/facts/${id.key}/reading/dismiss`, {});
  assert.equal(r.status, 200); assert.deepEqual(r.data.reading, []);
  const t = await propose({ kind: 'progress', fact: id.third, confidence: 'high' });
  await app.call(bob, 'POST', `/api/facts/${id.third}/reviews`, { verdict: 'correct' });
  assert.deepEqual(await reading(bob), [], 'reviewed');
  assert.equal((await reading(ann))[0].id, id.third);
  assert.equal((await app.call(bob, 'POST', `/api/fact-suggestions/${t.created[0]}/undo`, {})).status, 200);
  assert.deepEqual(await reading(ann), []); assert.equal((await app.call(ann, 'GET', `/api/facts/${id.third}`)).data.worth_reading, null);
});

test('a continuous campaign: a client that offers to lead runs a lead session whenever none runs; the others work', async () => {
  const c = (await app.call(key, 'POST', `/api/projects/${pid}/prover/campaigns`, { question_id: qid, lead_mode: 'continuous' })).data;
  assert.equal(c.lead_mode, 'continuous');
  const claim = (body) => app.call(key, 'POST', `/api/prover/campaigns/${c.id}/rounds`, { engine: 'claude', ai_model: 'claude-opus-5-5', ...body });
  const lead = (await claim({ offer_lead: true })).data.round;
  assert.equal(lead.kind, 'lead'); assert.equal(lead.session, true);
  assert.equal((await claim({ offer_lead: true })).data.round.kind, 'worker', 'one lead session at a time');
  await app.call(key, 'POST', `/api/prover/rounds/${lead.id}/lead`, { summary: 'A', guidance: 'G', lanes: [{ title: 'L', task: 'T' }] });
  await app.call(key, 'POST', `/api/prover/rounds/${lead.id}/lead`, { summary: 'A', guidance: 'G', lanes: [{ title: 'L', task: 'T' }] });
  const s = (await app.call(ann, 'GET', `/api/projects/${pid}/prover/campaigns`)).data.campaigns[0];
  const strategy = (await app.call(ann, 'GET', `/api/strategies/${s.strategy_id}`)).data;
  assert.equal(strategy.revisions?.length ?? strategy.strategy?.current_revision ?? 1, 1, 'the same guidance twice is one revision');
  await app.call(key, 'POST', `/api/prover/rounds/${lead.id}/finish`, { seconds: 3600 });
  const next = (await claim({ offer_lead: true })).data.round;
  assert.equal(next.session, true, 'the next session takes over at once');
  await app.call(key, 'POST', `/api/prover/rounds/${next.id}/finish`, { seconds: 1 });
  assert.equal((await claim({})).data.round.kind, 'worker', 'a client that does not offer to lead works, while the lead is recent');
  assert.equal((await app.call(bob, 'POST', `/api/prover/campaigns/${c.id}/status`, { lead_mode: 'chaos' })).status, 422);
  assert.equal((await app.call(bob, 'POST', `/api/prover/campaigns/${c.id}/status`, { lead_mode: 'periodic' })).data.lead_mode, 'periodic');
  await app.call(bob, 'POST', `/api/prover/campaigns/${c.id}/status`, { lead_mode: 'continuous' });
});

test('the lead session steers with its own tools, and a worker rereads its lane', async () => {
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, os, subprocess, sys
a = sys.argv[1:]; sys.stdin.read()
srv = json.loads(a[a.index("--mcp-config") + 1])["mcpServers"]["prover"] if "--mcp-config" in a else None
if not srv:
    print(json.dumps({"is_error": False, "result": "", "structured_output": {"ok": "ok"}, "modelUsage": {"claude-opus-5-5": {}}})); sys.exit()
p = subprocess.Popen([srv["command"]] + srv["args"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
n = [0]
def rpc(method, params=None):
    n[0] += 1; p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": n[0], "method": method, "params": params or {}}) + "\\n"); p.stdin.flush()
    return json.loads(p.stdout.readline())
rpc("initialize", {})
names = [t["name"] for t in rpc("tools/list")["result"]["tools"]]
call = lambda name, args={}: json.loads(rpc("tools/call", {"name": name, "arguments": args})["result"]["content"][0]["text"])
role = srv["args"][srv["args"].index("--role") + 1]
if role == "lead":
    out = {"names": names, "state": call("state"), "set": call("set_guidance", {"summary": "Two routes.", "elaboration": "Handover.", "guidance": "Push ultrafilters.", "lanes": [{"title": "Ultrafilters", "task": "Build one."}, {"title": "Counterexamples", "task": "Try triples."}]}),
           "fact": call("fact_submit", {"title": "x", "statement": "s", "proof": "p"}), "note": call("note_add", {"kind": "conclusion", "claim": "c", "evidence": "e"}),
           "direction": call("note_add", {"kind": "direction", "claim": "Literature: Milliken 1975."}), "wait": call("wait", {"minutes": 0.02}), "state2": call("state")}
else:
    out = {"names": names, "guidance": call("guidance_read")}
json.dump(out, open(os.environ["HOME"] + "/" + role + ".json", "w"))
p.stdin.close(); p.wait()
print(json.dumps({"is_error": False, "result": role + " done", "modelUsage": {"claude-opus-5-5": {}}}))
`, { mode: 0o755 });
  const run = (extra) => spawnSync('python3', [CLIENT, 'prove', 'run', '--project', String(pid), '--question', String(qid), '--workers', '1', '--once', '--provider', 'claude', '--model', 'claude-opus-5-5', '--verifier', 'claude', ...extra],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'c'), OQ_PROVER_POLL: '0.2', OQ_PROVER_BEAT: '0.5', OQ_PROVER_LEAD_SECONDS: '5' }, timeout: 120000 });
  let r = run(['--lead', '--lead-mode', 'continuous']);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /round \d+, lead session/);
  const lead = JSON.parse(fs.readFileSync(path.join(tmp, 'lead.json')));
  assert.deepEqual(lead.names, ['note_search', 'note_add', 'fact_search', 'fact_read', 'state', 'set_guidance', 'wait'].filter((x) => lead.names.includes(x)).length === 7 ? lead.names : null, 'only the lead tools');
  assert.ok(!lead.names.includes('fact_submit')); assert.match(lead.fact.error, /The lead has no tool fact_submit/);
  assert.match(lead.note.error, /records only plans, directions/); assert.ok(lead.direction.id);
  assert.ok(lead.state.minutes_left >= 0 && lead.state.minutes_left <= 1); assert.equal(lead.set.saved, true);
  assert.equal(lead.wait.new_notes, 0); assert.deepEqual(lead.state2.new_notes.map((x) => x.claim), ['Literature: Milliken 1975.'], 'what changed since its last look');
  r = run([]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /lane \d: (Ultrafilters|Counterexamples)/);
  const worker = JSON.parse(fs.readFileSync(path.join(tmp, 'worker.json')));
  assert.ok(worker.names.includes('guidance_read')); assert.ok(!worker.names.includes('set_guidance'));
  assert.equal(worker.guidance.guidance, 'Push ultrafilters.'); assert.ok(['Ultrafilters', 'Counterexamples'].includes(worker.guidance.your_lane.title));
});

test('a lead whose session ends early is woken when the workers report, or at the next beat', async () => {
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, os, subprocess, sys
a = sys.argv[1:]; prompt = sys.stdin.read()
srv = json.loads(a[a.index("--mcp-config") + 1])["mcpServers"]["prover"] if "--mcp-config" in a else None
if not srv:
    print(json.dumps({"is_error": False, "result": "", "structured_output": {"ok": "ok"}, "modelUsage": {"claude-opus-5-5": {}}})); sys.exit()
with open(os.environ["HOME"] + "/sessions.log", "a") as f: f.write(("woken" if "You are woken up again: call state" in prompt else "first") + "\\n")
print(json.dumps({"is_error": False, "result": "Nothing new.", "modelUsage": {"claude-opus-5-5": {}}}))
`, { mode: 0o755 });
  const c = (await app.call(key, 'POST', `/api/projects/${pid}/prover/campaigns`, { lead_mode: 'continuous' })).data;
  const r = spawnSync('python3', [CLIENT, 'prove', 'run', '--project', String(pid), '--workers', '1', '--once', '--lead', '--provider', 'claude', '--model', 'claude-opus-5-5', '--verifier', 'claude'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'c'), OQ_PROVER_POLL: '0.1', OQ_PROVER_BEAT: '1', OQ_PROVER_LEAD_SECONDS: '6' }, timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /lead session/);
  const log = fs.readFileSync(path.join(tmp, 'sessions.log'), 'utf8').trim().split('\n');
  assert.equal(log[0], 'first'); assert.ok(log.length >= 3 && log.slice(1).every((x) => x === 'woken'), `the lead was woken at each beat: ${log}`);
  const round = (await app.call(ann, 'GET', `/api/prover/campaigns/${c.id}`)).data.recent_rounds[0];
  assert.equal(round.kind, 'lead'); assert.ok(round.seconds <= 3, 'only the time it worked counts, not the waiting');
});
