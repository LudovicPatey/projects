// The AI queue and the local client, end to end, with a stand-in for the AI command.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const EVE = '0000-0002-1694-233X';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let bob; let eve; let annKey; let bobKey; let eveKey; let pid; let tmp; let base;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n');
const claim = (who, body = {}) => app.call(who, 'POST', '/api/ai/tasks/claim', { client_name: 'test', ai_model: 'm', ...body });
const finish = (who, t, extra = {}) => app.call(who, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'test-model', summary: 'ok', ...extra });
const drain = async (who) => { for (;;) { const t = (await claim(who)).data.task; if (!t) return; await app.call(who, 'POST', `/api/ai/tasks/${t.id}/fail`, { lease: t.lease, error: 'x', final: true }); } };
const upload = async (who, title, tex) => {
  const f = new FormData();
  f.set('title', title); f.set('origin', 'human'); f.set('pdf', new Blob([PDF], { type: 'application/pdf' }), 'p.pdf');
  if (tex) f.append('sources[]', new Blob([tex], { type: 'text/plain' }), 'p.tex');
  const r = await fetch(`${base}/api/projects/${pid}/documents`, { method: 'POST', headers: { Cookie: who.cookie, 'X-CSRF-Token': who.csrf, Accept: 'application/json' }, body: f });
  return r.json();
};

before(async () => {
  app = await startApp();
  ann = await app.signIn(ANN); bob = await app.signIn(BOB); eve = await app.signIn(EVE);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Queue', question_html: '<p>Is it true?</p>' })).data.id;
  for (const u of [BOB, EVE]) assert.ok((await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: u })).status < 300);
  const key = async (w) => ({ token: (await app.call(w, 'POST', '/api/me/keys', { name: 'k' })).data.token });
  annKey = await key(ann); bobKey = await key(bob); eveKey = await key(eve);
  base = app.base;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-client-'));
});
after(() => { app?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('API: a new human file is queued once, and an AI upload is not', async () => {
  const d = await upload(ann, 'Paper');
  const t = (await claim(bobKey)).data.task;
  assert.equal(t.kind, 'extract'); assert.equal(t.source_id, d.id);
  assert.ok(t.context.document.files.some((f) => f.role === 'pdf'));
  assert.equal((await claim(eveKey)).data.task, null, 'a claimed task is not offered twice');
  assert.equal((await finish(eveKey, t)).status, 409, 'another client cannot finish it');
  assert.equal((await finish(bobKey, { ...t, lease: 'wrong' })).status, 409);
  const done = await finish(bobKey, t, { generation_seconds: 2 });
  assert.equal(done.data.status, 'done'); assert.equal(done.data.ai_generation_ms, 2000);
  assert.equal((await finish(bobKey, t)).status, 409, 'it cannot be finished twice');
});

test('API: only AI clients claim, only people request or validate', async () => {
  assert.equal((await claim(ann)).status, 403);
  assert.equal((await app.call(annKey, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'bib' })).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/suggestions`, { suggestions: [{}] })).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'nope' })).status, 422);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract' })).status, 422);
});

test('API: @AI in a private conversation reaches only the clients of its participants', async () => {
  await drain(annKey);
  const c = (await app.call(ann, 'POST', `/api/projects/${pid}/conversations`, { subject: 'Private', participant_ids: [bob.id], body_text: 'Start' })).data;
  const cid = c.id;
  await app.call(bob, 'POST', `/api/conversations/${cid}/messages`, { body_text: 'No request here, write to ai@example.org' });
  assert.equal((await claim(eveKey)).data.task, null);
  await app.call(bob, 'POST', `/api/conversations/${cid}/messages`, { body_text: '@AI is this lemma true?' });
  assert.equal((await claim(eveKey)).data.task, null, 'a non-participant client is not given it');
  const list = (await app.call(eve, 'GET', `/api/projects/${pid}/ai`)).data;
  assert.ok(!list.tasks.some((x) => x.conversation_id === cid), 'and does not see it listed');
  const t = (await claim(annKey)).data.task;
  assert.equal(t.kind, 'ask'); assert.ok(t.context.thread.some((m) => m.text.includes('is this lemma')));
  assert.equal((await finish(annKey, t)).status, 422, 'an answer is required');
  assert.equal((await finish(annKey, t, { reply_text: 'Probably, by $x^2 \\ge 0$. @AI again' })).status, 200);
  const msgs = (await app.call(bob, 'GET', `/api/conversations/${cid}`)).data.messages;
  const last = msgs.at(-1);
  assert.equal(last.author_kind, 'agent'); assert.equal(last.author_model, 'test-model'); assert.equal(last.ai_user_id, ann.id);
  assert.equal((await claim(annKey)).data.task, null, 'an AI answer never triggers another request');
  const members = (await app.call(ann, 'GET', `/api/projects/${pid}/mentionables`)).data.users;
  assert.ok(!members.some((u) => u.name === 'AI assistant'), 'the assistant is not a member');
});

test('API: a chip naming an AI agent is not a request', async () => {
  const bot = (await app.call(ann, 'POST', `/api/projects/${pid}/agents`, { name: 'AI Bot', ai_model: 'm' })).data;
  const uid = bot.id ?? bot.user?.id ?? bot.agent?.id;
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Q' })).data;
  await app.call(ann, 'POST', '/api/comments', { target_type: 'oquestion', target_id: q.id, body_text: `Ping @{user:${uid}}` });
  assert.equal((await claim(annKey)).data.task, null);
  await app.call(ann, 'POST', '/api/comments', { target_type: 'oquestion', target_id: q.id, body_text: 'What do you think, @ai?' });
  const t = (await claim(annKey)).data.task;
  assert.equal(t.source_type, 'comment');
  await finish(annKey, t, { reply_text: 'A reply' });
  const threads = (await app.call(ann, 'GET', `/api/comments?type=oquestion&id=${q.id}`)).data;
  const list = threads.threads ?? threads.comments ?? threads;
  assert.ok(list.some((x) => (x.replies || []).some((y) => (y.author_model ?? y.ai_model) === 'test-model')));
});

test('API: an abandoned task returns to the queue, and failures stop after three attempts', async () => {
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', prompt_text: 'Try' })).data;
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', prompt_text: 'Try' })).status, 409);
  let t = (await claim(bobKey)).data.task;
  assert.equal(t.id, q.id);
  assert.equal((await app.call(bobKey, 'POST', `/api/ai/tasks/${t.id}/heartbeat`, { lease: t.lease })).status, 200);
  const failed = await app.call(bobKey, 'POST', `/api/ai/tasks/${t.id}/fail`, { lease: t.lease, error: 'quota' });
  assert.equal(failed.data.status, 'pending');
  assert.equal((await claim(bobKey)).data.task, null, 'it waits before a new attempt');
  assert.equal((await app.call(eve, 'POST', `/api/ai/tasks/${t.id}/cancel`, {})).status, 403);
  assert.equal((await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {})).data.status, 'cancelled');
  assert.equal((await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/retry`, {})).data.status, 'pending');
  t = (await claim(bobKey)).data.task;
  await app.call(bobKey, 'POST', `/api/ai/tasks/${t.id}/fail`, { lease: t.lease, error: 'stop', final: true });
});

test('API: a suggested reference must be checkable, and enters the bibliography only when a person accepts it', async () => {
  const url = `/api/projects/${pid}/ai/suggestions`;
  const good = { title: 'A real paper', authors: 'Doe, J.', year: '2021', venue: 'Annals', doi: '10.1234/abc.5', reason_text: 'Same method.' };
  assert.equal((await app.call(annKey, 'POST', url, { suggestions: [{ title: 'No locator', reason_text: 'x' }], ai_model: 'm' })).status, 422);
  assert.equal((await app.call(annKey, 'POST', url, { suggestions: [{ ...good, reason_text: '' }], ai_model: 'm' })).status, 422);
  assert.equal((await app.call(annKey, 'POST', url, { suggestions: [{ ...good, doi: 'nonsense' }], ai_model: 'm' })).status, 422);
  assert.equal((await app.call(annKey, 'POST', url, { suggestions: [good] })).status, 422, 'the model is required');
  const r = (await app.call(annKey, 'POST', url, { suggestions: [good, { title: 'Second', arxiv: '2101.01234', reason_text: 'Close.' }], ai_model: 'm' })).data;
  assert.equal(r.created.length, 2);
  assert.deepEqual((await app.call(annKey, 'POST', url, { suggestions: [good], ai_model: 'm' })).data.skipped, ['A real paper']);
  const before = (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.entries.length;
  assert.equal(before, 0, 'nothing is added before validation');
  assert.equal((await app.call(annKey, 'POST', `/api/bib-suggestions/${r.created[0]}/accept`, {})).status, 403);
  const ok = (await app.call(bob, 'POST', `/api/bib-suggestions/${r.created[0]}/accept`, {})).data;
  const entry = (await app.call(ann, 'GET', `/api/bib/${ok.bib_id}`)).data;
  assert.equal(entry.doi, '10.1234/abc.5'); assert.equal(entry.ai_model, 'm'); assert.equal(entry.ai_user_id, ann.id); assert.equal(entry.created_by, bob.id);
  assert.equal((await app.call(bob, 'POST', `/api/bib-suggestions/${r.created[0]}/reject`, {})).status, 409);
  assert.equal((await app.call(bob, 'POST', `/api/bib-suggestions/${r.created[1]}/reject`, { note: 'Off topic' })).status, 200);
  const refs = (await app.call(ann, 'GET', `/api/projects/${pid}/refs/resolve?keys=suggestion:${r.created[1]}`)).data;
  assert.equal(Object.values(refs.refs)[0].state, 'ok');
});

// ----- the real client, with a stand-in for the AI command -----

function fakeAi(dir, name) {
  const body = `#!/usr/bin/env python3
import json, os, sys, pathlib
argv = sys.argv[1:]
if argv[:1] == ["app-server"]:
    for line in sys.stdin:
        m = json.loads(line)
        if m.get("id") == 1: print(json.dumps({"id": 1, "result": {}}), flush=True)
        if m.get("id") == 2: print(json.dumps({"id": 2, "result": {"rateLimits": {"primary": {"usedPercent": int(os.environ.get("FAKE_USED", "5")), "windowDurationMins": 300, "resetsAt": 4102444800}, "secondary": {"usedPercent": 1, "windowDurationMins": 10080}}}}), flush=True); sys.exit()
    sys.exit()
if argv[:2] == ["auth", "status"]:
    print(json.dumps({"authMethod": os.environ.get("FAKE_CLAUDE_AUTH", "claude.ai")})); sys.exit()
if argv[:2] == ["login", "status"]:
    print(os.environ.get("FAKE_AUTH", "Logged in using ChatGPT")); sys.exit()
if os.environ.get("FAKE_LIMIT"):
    print("You've hit your session limit · resets 3:45pm", file=sys.stderr); sys.exit(1)
log = pathlib.Path(os.environ["FAKE_LOG"])
with log.open("a") as f: f.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "key": [k for k in os.environ if k.startswith("OQ_")], "paid": sorted(k for k in os.environ if k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"))}) + "\\n")
sys.stdin.read()
task = json.load(open("task.json"))
kind = task["task"]["kind"]
secret = os.environ.get("FAKE_SECRET", "")
if kind == "extract":
    a = {"summary": "Two results", "facts": [
      {"ref": "good", "title": "True lemma", "kind": "lemma", "statement": "For all $n$, $n=n$.", "proof": None, "quote": "every integer equals itself", "page": 1, "covers": "statement", "depends_on": []},
      {"ref": "invented", "title": "Invented", "kind": "theorem", "statement": "False.", "proof": None, "quote": "this sentence is nowhere in the paper", "page": 1, "covers": "statement", "depends_on": ["good"]}]}
elif kind == "ask": a = {"summary": "Answered", "reply": "My opinion " + secret}
elif kind == "bib": a = {"summary": "One found", "suggestions": [{"title": "Found paper", "authors": "Lee", "year": "2020", "venue": None, "doi": "10.5555/found", "arxiv": None, "url": None, "reason": "Relevant"}]}
else: a = {"summary": "Derived", "facts": [{"ref": "new", "title": "Derived fact", "kind": "lemma", "statement": "$1+1=2$.", "proof": "By definition.", "quote": None, "page": None, "covers": None, "depends_on": []}]}
if "${name}" == "claude":
    print(json.dumps({"is_error": False, "result": "", "structured_output": a, "modelUsage": {"fake-claude-1": {"outputTokens": 5}}}))
else:
    open(argv[argv.index("-o") + 1], "w").write(json.dumps(a))
`;
  const p = path.join(dir, name); fs.writeFileSync(p, body, { mode: 0o755 });
}

function oq(args, env = {}, input) {
  const bin = path.join(tmp, 'bin');
  return spawnSync('python3', [CLIENT, ...args], { encoding: 'utf8', input, timeout: 60000,
    env: { PATH: `${bin}:/usr/bin:/bin:/usr/local/bin`, HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'cfg'), FAKE_LOG: path.join(tmp, 'log'), ...env } });
}

for (const provider of ['claude', 'codex']) {
  test(`client with ${provider}: all four kinds of work, read-only and without the key`, async () => {
    await drain(annKey);
    const bin = path.join(tmp, 'bin'); fs.rmSync(bin, { recursive: true, force: true }); fs.mkdirSync(bin, { recursive: true });
    fakeAi(bin, provider);
    fs.rmSync(path.join(tmp, 'log'), { force: true });
    const env = { OQ_URL: base, OQ_KEY: annKey.token, FAKE_SECRET: annKey.token };
    const doc = await upload(ann, `Paper ${provider}`, `Lemma. For $n$, every integer equals itself. ${provider}`);
    const q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: `Goal ${provider}` })).data;
    await app.call(ann, 'POST', '/api/comments', { target_type: 'oquestion', target_id: q.id, body_text: '@AI thoughts?' });
    await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', source_type: 'question', source_id: q.id });
    if (provider === 'claude') await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'bib' });
    oq(['limits', '--only', 'extract,ask,bib,derive'], env);
    const run = oq(['run', '--once', '--provider', provider, '--project', String(pid), '--model', provider === 'codex' ? 'gpt-test' : ''], env);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(!(run.stdout + run.stderr).includes(annKey.token), 'the key is never printed');
    const calls = fs.readFileSync(path.join(tmp, 'log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.length >= 3);
    for (const c of calls) {
      assert.deepEqual(c.key, [], 'the AI process receives no platform credential');
      if (provider === 'codex') { assert.ok(c.argv.includes('read-only')); assert.ok(!c.argv.join(' ').includes('dangerously')); }
      else { const t = c.argv[c.argv.indexOf('--tools') + 1]; assert.ok(['Read', 'Read,WebSearch'].includes(t)); assert.ok(!c.argv.join(' ').includes('bypass')); }
    }
    const facts = (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts;
    const mine = facts.filter((f) => f.external_id?.startsWith('oq-t'));
    assert.ok(mine.some((f) => f.title === 'True lemma' && f.method === 'extracted'));
    assert.ok(!mine.some((f) => f.title === 'Invented'), 'a quotation absent from the document is refused');
    assert.ok(mine.some((f) => f.title === 'Derived fact' && f.method === 'deduced'));
    const data = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data;
    const extract = data.tasks.find((t) => t.source_id === doc.id && t.kind === 'extract');
    assert.equal(extract.status, 'done'); assert.match(extract.summary_text, /1 fact.*1 set aside/);
    assert.equal(extract.ai_model, provider === 'codex' ? 'gpt-test' : 'fake-claude-1');
    const threads = (await app.call(ann, 'GET', `/api/comments?type=oquestion&id=${q.id}`)).data;
    assert.ok(!JSON.stringify(threads).includes(annKey.token), 'an answer containing the key is scrubbed');
    assert.ok((await app.call(ann, 'GET', `/api/questions/${q.id}`)).data.links.some((l) => l.target_type === 'fact'));
    if (provider === 'claude') assert.ok(data.suggestions.some((s) => s.title === 'Found paper' && s.status === 'proposed'));
    assert.ok(data.clients.length >= 1);
  });
}

test('client: setup stores the key privately, and doctor explains what is missing', () => {
  const env = { OQ_KEY: annKey.token, OQ_CONFIG_DIR: path.join(tmp, 'cfg2') };
  const s = oq(['setup', '--url', base], env);
  assert.equal(s.status, 0, s.stderr);
  const file = path.join(tmp, 'cfg2/config.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const bin = path.join(tmp, 'bin'); fs.rmSync(bin, { recursive: true, force: true }); fs.mkdirSync(bin);
  const none = spawnSync('python3', [CLIENT, 'run', '--once'], { encoding: 'utf8', env: { PATH: `${bin}:/nonexistent`.replace('/nonexistent', path.dirname(execFileSync('which', ['python3'], { encoding: 'utf8' }).trim())), HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'cfg2') } });
  assert.equal(none.status, 2); assert.match(none.stderr, /Neither Claude Code nor Codex/);
  assert.equal(oq(['setup', '--url', base], { OQ_KEY: 'wrong', OQ_CONFIG_DIR: path.join(tmp, 'cfg3') }).status, 2);
});

test('client: Danus facts are sent idempotently, and the graph is never modified by a pull', async () => {
  const graph = path.join(tmp, 'danus/fact_graph'); fs.mkdirSync(path.join(graph, 'facts'), { recursive: true });
  const a = 'aaaaaaaaaaaaaaaa'; const b = 'bbbbbbbbbbbbbbbb';
  fs.writeFileSync(path.join(graph, `facts/${b}.md`), `---\nfact_id: ${b}\npredecessors:\n  - ${a}\n---\n\n## statement\n\nSecond $y$.\n\n## proof\n\nFrom the first.\n`);
  fs.writeFileSync(path.join(graph, `facts/${a}.md`), `---\nfact_id: ${a}\npredecessors: []\n---\n\n## statement\n\nFirst $x$.\n\n## proof\n\nDirect.\n`);
  const env = { OQ_URL: base, OQ_KEY: annKey.token };
  const dry = oq(['danus', 'push', graph, '--project', String(pid), '--model', 'dm', '--dry-run'], env);
  assert.match(dry.stdout, /Would create 2/, dry.stderr);
  assert.match(oq(['danus', 'push', graph, '--project', String(pid), '--model', 'dm'], env).stdout, /Created 2/);
  assert.match(oq(['danus', 'push', graph, '--project', String(pid), '--model', 'dm'], env).stdout, /Created 0 fact\(s\), skipped 2/);
  const before = fs.readdirSync(path.join(graph, 'facts')).sort();
  const pull = oq(['danus', 'pull', graph, '--project', String(pid)], env);
  assert.equal(pull.status, 0, pull.stderr);
  assert.deepEqual(fs.readdirSync(path.join(graph, 'facts')).sort(), before);
  const out = fs.readdirSync(path.join(tmp, 'danus/platform_facts'));
  assert.ok(out.length > 0);
  assert.match(fs.readFileSync(path.join(tmp, 'danus/platform_facts', out[0]), 'utf8'), /## statement\n\n\S/);
});

test('client: danus serve turns a derivation task into new facts', async () => {
  await drain(annKey);
  const graph = path.join(tmp, 'serve/fact_graph'); fs.mkdirSync(path.join(graph, 'facts'), { recursive: true });
  const script = path.join(tmp, 'fake_danus.py');
  fs.writeFileSync(script, `import json,sys,pathlib\ntask=json.load(open(sys.argv[1]))\npathlib.Path(sys.argv[2],'facts','cccccccccccccccc.md').write_text('---\\nfact_id: cccccccccccccccc\\npredecessors: []\\n---\\n\\n## statement\\n\\nFrom Danus.\\n\\n## proof\\n\\nDone.\\n')\n`);
  const t = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', prompt_text: 'Serve' })).data;
  const r = oq(['danus', 'serve', graph, '--project', String(pid), '--model', 'dm', '--once', '--command', `python3 ${script} {task} {graph}`], { OQ_URL: base, OQ_KEY: annKey.token });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const done = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.find((x) => x.id === t.id);
  assert.equal(done.status, 'done'); assert.equal(done.result.fact_ids.length, 1);
});

// ----- usage limits, graphic interface and managed Danus -----

const limitEnv = (name, extra = {}) => ({ OQ_URL: base, OQ_KEY: annKey.token, OQ_CONFIG_DIR: path.join(tmp, `limits-${name}`), ...extra });
const useFake = (tool) => { const bin = path.join(tmp, 'bin'); fs.rmSync(bin, { recursive: true, force: true }); fs.mkdirSync(bin, { recursive: true }); fakeAi(bin, tool); fs.rmSync(path.join(tmp, 'log'), { force: true }); };
const aiCalls = () => (fs.existsSync(path.join(tmp, 'log')) ? fs.readFileSync(path.join(tmp, 'log'), 'utf8').trim().split('\n').length : 0);
const waiting = async (prompt) => (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'ask', prompt_text: prompt })).data;
const taskById = async (id) => (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.find((t) => t.id === id);

test('limits: nothing is claimed above the share of the subscription', async () => {
  await drain(annKey); useFake('codex');
  const t = await waiting('above cap');
  const env = limitEnv('cap', { FAKE_USED: '80' });
  assert.equal(oq(['limits', '--max-session-percent', '50'], env).status, 0);
  const r = oq(['run', '--once', '--provider', 'codex', '--project', String(pid)], env);
  assert.match(r.stdout, /On hold: Your session usage is at 80%, and your limit is 50%/);
  assert.equal(aiCalls(), 0, 'no model was called');
  assert.equal((await taskById(t.id)).status, 'pending');
  const ok = oq(['run', '--once', '--provider', 'codex', '--project', String(pid)], { ...env, FAKE_USED: '10' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal((await taskById(t.id)).status, 'done');
});

test('limits: pause, working hours and daily caps stop new work', async () => {
  await drain(annKey); useFake('claude');
  const t = await waiting('capped');
  const env = limitEnv('daily');
  oq(['limits', '--pause'], env);
  assert.match(oq(['run', '--once', '--provider', 'claude', '--project', String(pid)], env).stdout, /Paused by you/);
  oq(['limits', '--resume', '--tasks-per-day', '1'], env);
  fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true });
  const day = new Intl.DateTimeFormat('sv-SE').format(new Date());
  fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'usage.json'), JSON.stringify({ day, tasks: 1, seconds: 0, tokens: 0 }));
  assert.match(oq(['run', '--once', '--provider', 'claude', '--project', String(pid)], env).stdout, /Daily task limit/);
  assert.equal(aiCalls(), 0);
  assert.equal((await taskById(t.id)).status, 'pending');
  assert.equal(oq(['limits', '--hours', '25-3'], env).status, 2);
  assert.equal(oq(['limits', '--max-weekly-percent', '0'], env).status, 2);
  await drain(annKey);
});

test('limits: when the provider says stop, the task goes back without losing an attempt', async () => {
  await drain(annKey); useFake('claude');
  const t = await waiting('hits limit');
  const env = limitEnv('provider', { FAKE_LIMIT: '1' });
  const r = oq(['run', '--once', '--provider', 'claude', '--project', String(pid)], env);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /on hold/);
  const after = await taskById(t.id);
  assert.equal(after.status, 'pending'); assert.equal(after.attempts, 0);
  const again = oq(['run', '--once', '--provider', 'claude', '--project', String(pid)], { ...env, FAKE_LIMIT: '' });
  assert.match(again.stdout, /limit is reached/, 'it stays on hold until the reset');
  assert.equal(aiCalls(), 0);
  await drain(annKey);
});

test('billing: a paid API key is ignored unless its user explicitly allows it', async () => {
  await drain(annKey); useFake('claude');
  const env = limitEnv('billing', { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 'tok-test' });
  await waiting('subscription only');
  assert.equal(oq(['run', '--once', '--provider', 'claude', '--project', String(pid)], env).status, 0);
  let calls = fs.readFileSync(path.join(tmp, 'log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.at(-1).paid, [], 'the default is the subscription');
  assert.match(oq(['limits', '--billing', 'api'], env).stdout, /charged per use/);
  await waiting('api allowed');
  assert.equal(oq(['run', '--once', '--provider', 'claude', '--project', String(pid)], env).status, 0);
  calls = fs.readFileSync(path.join(tmp, 'log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.at(-1).paid, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  assert.equal(oq(['limits', '--billing', 'free'], env).status, 2);
});

test('billing: a tool configured with a paid key is put on hold', async () => {
  await drain(annKey); useFake('codex');
  const t = await waiting('paid codex');
  const env = limitEnv('paid-codex', { FAKE_AUTH: 'Logged in using an API key - sk-...' });
  assert.match(oq(['run', '--once', '--provider', 'codex', '--project', String(pid)], env).stdout, /signed in with a paid API key/);
  assert.equal(aiCalls(), 0); assert.equal((await taskById(t.id)).status, 'pending');
  await drain(annKey); useFake('claude');
  const c = await waiting('paid claude');
  fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.claude/settings.json'), JSON.stringify({ apiKeyHelper: '/bin/echo key' }));
  try {
    assert.match(oq(['run', '--once', '--provider', 'claude', '--project', String(pid)], limitEnv('paid-claude')).stdout, /apiKeyHelper/);
    assert.equal(aiCalls(), 0); assert.equal((await taskById(c.id)).status, 'pending');
  } finally { fs.rmSync(path.join(tmp, '.claude'), { recursive: true, force: true }); await drain(annKey); }
});

test('graphic interface: reachable only with its token, from this computer, and never reveals the key', async () => {
  useFake('claude');
  const env = limitEnv('ui');
  const py = spawn('python3', [CLIENT, 'app', '--no-open'], { env: { PATH: `${path.join(tmp, 'bin')}:/usr/bin:/bin:/usr/local/bin`, HOME: tmp, ...env, FAKE_LOG: path.join(tmp, 'log') } });
  try {
    const url = await new Promise((res, rej) => { py.stdout.on('data', (d) => { const m = String(d).match(/OQ_APP_URL=(\S+)/); if (m) res(m[1]); }); setTimeout(() => rej(new Error('no url')), 8000); });
    const u = new URL(url); const token = u.searchParams.get('t'); const o = u.origin;
    assert.equal((await fetch(`${o}/`)).status, 403);
    assert.equal((await fetch(`${o}/api/state`)).status, 404);
    assert.equal(u.hostname, '127.0.0.1');
    const page = await fetch(url); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    const h = { 'X-OQ-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${o}/api/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${o}/api/stop`, { method: 'POST', headers: { 'X-OQ-Token': token, 'Content-Type': 'text/plain' }, body: '{}' })).status, 403);
    const res = await fetch(`${o}/api/state`, { headers: h }); const text = await res.text();
    assert.equal(JSON.parse(text).connected, true); assert.ok(!text.includes(annKey.token), 'the key stays out of the page');
    assert.equal((await fetch(`${o}/api/limits`, { method: 'POST', headers: h, body: JSON.stringify({ max_session_percent: 500 }) })).status, 422);
    assert.equal((await fetch(`${o}/api/limits`, { method: 'POST', headers: h, body: JSON.stringify({ max_session_percent: 35 }) })).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.OQ_CONFIG_DIR, 'limits.json'))).max_session_percent, 35);
    assert.equal((await fetch(`${o}/api/connect`, { method: 'POST', headers: h, body: JSON.stringify({ url: base, key: 'bad' }) })).status, 422);
  } finally { py.kill(); }
});

// A stand-in for the isolated machine: it records every command, and exposes a fact graph.
function fakeMachine(name) {
  const bin = path.join(tmp, 'bin'); const dir = path.join(tmp, `vm-${name}`); const log = path.join(dir, 'vm.log');
  const facts = path.join(dir, 'data/fact_graph/facts'); fs.mkdirSync(facts, { recursive: true });
  fs.writeFileSync(path.join(facts, `${(name + 'dddddddddddddddd').replace(/[^0-9a-f]/g, 'd').slice(0, 16)}.md`), `---\nfact_id: ${(name + 'dddddddddddddddd').replace(/[^0-9a-f]/g, 'd').slice(0, 16)}\npredecessors: []\n---\n\n## statement\n\nFound by Danus in ${name}.\n\n## proof\n\nVerified.\n`);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "$*" >> "${log}"
case "$1" in inspect) if [ "$2" = "-f" ]; then [ -f "${dir}/mounted" ] && echo 1 || echo 0; exit 0; fi; [ -f "${dir}/exists" ]; exit $?;; run) touch "${dir}/exists"; echo id; exit 0;; start|stop|rm) exit 0;; esac
s="\${@: -1}"
[ -p /dev/stdin ] && cat >/dev/null
case "$s" in *"[ -f "*) if [ -f "${dir}/lost" ]; then rm -f "${dir}/lost"; exit 1; fi;; *"findmnt"*) [ ! -f "${dir}/mounted" ]; exit $?;; *"danus status"*"--json"*) [[ "$s" == *"|| bin/danus new"* ]] && exit 0; echo '[{"worker":"w1","alive":true}]';; *"tar -cf"*) COPYFILE_DISABLE=1 tar -C "${dir}/data" -cf - fact_graph;; esac
exit 0
`, { mode: 0o755 });
  return log;
}
// Codex with a usage level read from a file, so that a test can change it while Danus runs.
function usageCodex(file) {
  fs.writeFileSync(file, '5');
  fs.writeFileSync(path.join(tmp, 'bin', 'codex'), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a[:2] == ["login", "status"]: print("Logged in using ChatGPT"); sys.exit()
if a[:1] == ["app-server"]:
    for line in sys.stdin:
        m = json.loads(line)
        if m.get("id") == 1: print(json.dumps({"id": 1, "result": {}}), flush=True)
        if m.get("id") == 2:
            u = int(open("${file}").read())
            print(json.dumps({"id": 2, "result": {"rateLimits": {"primary": {"usedPercent": u, "windowDurationMins": 300, "resetsAt": 4102444800}, "secondary": {"usedPercent": 1, "windowDurationMins": 10080}}}}), flush=True); sys.exit()
`, { mode: 0o755 });
}
const danusEnv = (name) => limitEnv(`danus-${name}`, { OQ_DANUS_BACKEND: 'docker', OQ_DANUS_POLL: '1' });
const procEnv = (env) => ({ PATH: `${path.join(tmp, 'bin')}:/usr/bin:/bin:/usr/local/bin`, HOME: tmp, FAKE_LOG: path.join(tmp, 'log'), ...env });
const launch = (env, args) => new Promise((resolve) => {
  const c = spawn('python3', [CLIENT, 'danus', 'run', '--project', String(pid), '--model', 'dm', ...args], { env: procEnv(env) });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  launch.last = c; c.on('close', (code) => resolve({ code, out }));
});
const runState = (env) => JSON.parse(fs.readFileSync(path.join(env.OQ_CONFIG_DIR, 'danus_run.json')));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('Danus: installed in isolation, and never started by the ordinary client', async () => {
  await drain(annKey); useFake('codex'); const log = fakeMachine('install');
  const env = danusEnv('install');
  const s = oq(['danus', 'setup'], env);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  const vm = fs.readFileSync(log, 'utf8');
  assert.match(vm, /run -d --name oq-danus/); assert.match(vm, /--cap-drop ALL/); assert.ok(!/ -v | --volume /.test(vm), 'no folder of the computer is mounted');
  assert.ok(!vm.includes(annKey.token), 'the platform key never enters the machine');
  const t = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', prompt_text: 'must wait for Run' })).data;
  fs.writeFileSync(log, '');
  assert.equal(oq(['run', '--once', '--provider', 'codex', '--project', String(pid)], env).status, 0);
  assert.equal((await taskById(t.id)).status, 'pending', 'a derivation request waits for a person to press Run');
  assert.ok(!/danus start/.test(fs.readFileSync(log, 'utf8')));
  assert.equal(aiCalls(), 0);
  await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {});
});

test('Danus run: a person can stop it, and its facts are sent', async () => {
  await drain(annKey); useFake('codex'); const log = fakeMachine('aaa1'); const env = danusEnv('time');
  usageCodex(path.join(tmp, 'u-time')); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Timed' })).data;
  const started = launch(env, ['--question', String(q.id), '--minutes', '0', '--stop-session', '40', '--stop-weekly', '60', '--workers', '2', '--goal', 'try k=3']);
  assert.ok(await until(() => { try { return runState(env).status === 'running'; } catch { return false; } }), 'it runs');
  const st = runState(env);
  assert.equal(st.stop_session, 40); assert.equal(st.workers, 2);
  assert.match(fs.readFileSync(log, 'utf8'), /danus new oq\d+t\d+ --roles high:2/);
  assert.match(fs.readFileSync(log, 'utf8'), /oq-heartbeat[\s\S]*danus stop .* --force/, 'a watchdog stops the workers if the client dies');
  assert.equal(oq(['danus', 'stop'], env).status, 0);
  const r = await started;
  assert.equal(r.code, 0, r.out); assert.match(r.out, /stopped, 1 new fact/);
  const done = await taskById(st.task_id);
  assert.equal(done.status, 'done', done.error_text); assert.match(done.summary_text, /your request/); assert.equal(done.result.fact_ids.length, 1);
  assert.ok((await app.call(ann, 'GET', `/api/questions/${q.id}`)).data.links.some((l) => l.target_type === 'fact'));
  assert.ok((await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.some((f) => f.tool === 'danus' && f.id === done.result.fact_ids[0]));
});

test('Danus run: refuses to start above a limit, unless it may wait', async () => {
  await drain(annKey); useFake('codex'); fakeMachine('bbb2'); const env = danusEnv('refuse');
  const u = path.join(tmp, 'u-refuse'); usageCodex(u); fs.writeFileSync(u, '45'); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  const r = await launch(env, ['--minutes', '60', '--stop-session', '40']);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /cannot start now.*session usage at 45%/s);
  assert.equal((await app.call(annKey, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'bib' })).status, 403, 'a key can record only a Danus run');
  for (const bad of [['--minutes', '-1'], ['--stop-session', '0'], ['--stop-weekly', '101'], ['--workers', '9']]) assert.equal((await launch(env, ['--on-limit', 'resume', ...bad])).code, 2, bad.join(' '));
});

test('Danus run: at a usage stop it ends, or waits and continues after the reset', async () => {
  await drain(annKey); useFake('codex'); let log = fakeMachine('ccc3'); const env = danusEnv('stop');
  const u = path.join(tmp, 'u-stop'); usageCodex(u); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  let started = launch(env, ['--minutes', '0', '--stop-session', '40']);
  assert.ok(await until(() => { try { return runState(env).status === 'running'; } catch { return false; } }));
  fs.writeFileSync(u, '41');
  let r = await started;
  assert.equal(r.code, 0, r.out); assert.match(r.out, /session usage at 41%/);
  assert.match(fs.readFileSync(log, 'utf8'), /danus stop oq\d+t\d+ --force/);

  await drain(annKey); log = fakeMachine('ddd4'); const env2 = danusEnv('resume'); const u2 = path.join(tmp, 'u-resume'); usageCodex(u2);
  fs.mkdirSync(env2.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env2.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  started = launch(env2, ['--minutes', '0', '--stop-session', '40', '--on-limit', 'resume']);
  assert.ok(await until(() => { try { return runState(env2).status === 'running'; } catch { return false; } }));
  fs.writeFileSync(u2, '70');
  assert.ok(await until(() => runState(env2).status === 'waiting', 40000), 'it waits at the limit');
  const stops = () => (fs.readFileSync(log, 'utf8').match(/danus stop oq/g) || []).length;
  assert.ok(stops() >= 1, 'its workers are stopped while it waits');
  const starts = () => (fs.readFileSync(log, 'utf8').match(/bin\/danus start oq/g) || []).length;
  assert.equal(starts(), 1);
  fs.writeFileSync(u2, '3');
  assert.ok(await until(() => runState(env2).status === 'running' && starts() === 2, 60000), 'it continues after the reset');
  assert.equal((fs.readFileSync(log, 'utf8').match(/danus new oq/g) || []).length, 1, 'the same project continues');
  assert.equal(oq(['danus', 'stop'], env2).status, 0);
  r = await started; assert.equal(r.code, 0, r.out);
});

test('Danus run: a cancellation on the platform stops it', async () => {
  await drain(annKey); useFake('codex'); const log = fakeMachine('eee5'); const env = danusEnv('cancel');
  usageCodex(path.join(tmp, 'u-cancel')); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  const waiting2 = (await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', prompt_text: 'from the web' })).data;
  const started = launch(env, ['--task', String(waiting2.id), '--minutes', '0']);
  assert.ok(await until(() => { try { return runState(env).status === 'running'; } catch { return false; } }));
  assert.equal(runState(env).task_id, waiting2.id, 'it takes the chosen request');
  assert.equal((await app.call(ann, 'POST', `/api/ai/tasks/${waiting2.id}/cancel`, {})).status, 200);
  const r = await started;
  assert.equal(r.code, 0, r.out); assert.match(r.out, /cancelled/); assert.match(fs.readFileSync(log, 'utf8'), /danus stop oq\d+t\d+ --force/);
});

test('Danus run: stops at its running time', async () => {
  await drain(annKey); useFake('codex'); const log = fakeMachine('fff6'); const env = { ...danusEnv('duration'), OQ_DANUS_MINUTE: '2' };
  usageCodex(path.join(tmp, 'u-duration')); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  const r = await launch(env, ['--minutes', '1']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /the time limit of 1 minutes/);
  assert.match(fs.readFileSync(log, 'utf8'), /danus stop oq\d+t\d+ --force/);
});

test('Danus safety: the watchdog in the machine stops workers when the client disappears', async () => {
  useFake('codex'); const log = fakeMachine('aaa7'); const env = danusEnv('watchdog');
  usageCodex(path.join(tmp, 'u-watch')); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  await drain(annKey);
  const started = launch(env, ['--minutes', '0']);
  assert.ok(await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('nohup setsid')));
  const line = fs.readFileSync(log, 'utf8').split('\n').find((l) => l.includes('nohup setsid'));
  oq(['danus', 'stop'], env); await started;
  const home = path.join(tmp, 'vmhome'); fs.mkdirSync(path.join(home, 'bin'), { recursive: true }); fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  const marker = path.join(home, 'stopped');
  fs.writeFileSync(path.join(home, 'bin/danus'), `#!/bin/bash\necho "$*" > "${marker}"\n`, { mode: 0o755 });
  const fakes = path.join(home, 'fakes'); fs.mkdirSync(fakes);
  fs.writeFileSync(path.join(fakes, 'stat'), '#!/bin/bash\necho 1000\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fakes, 'setsid'), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 }); // not available on macOS, present in the Linux machine
  const script = line.slice(line.indexOf('bash -lc ') + 9).replaceAll('/opt/danus', home).replace('sleep 30', 'sleep 0.1');
  assert.equal(spawnSync('bash', ['-c', script], { env: { PATH: `${fakes}:/usr/bin:/bin` }, timeout: 5000 }).status, 0);
  assert.ok(await until(() => fs.existsSync(marker), 5000), 'the watchdog fired');
  assert.match(fs.readFileSync(marker, 'utf8'), /^stop oq\d+t\d+ --force/);
});

test('Danus safety: after a crash, a run ends unless it was set to continue', async () => {
  await drain(annKey); useFake('codex'); fakeMachine('bbb8'); const env = danusEnv('crash');
  usageCodex(path.join(tmp, 'u-crash')); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  const started = launch(env, ['--minutes', '0']);
  assert.ok(await until(() => { try { return runState(env).status === 'running'; } catch { return false; } }));
  const id = runState(env).task_id; launch.last.kill('SIGKILL'); await started;
  const state = runState(env); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus_run.json'), JSON.stringify({ ...state, updated_at: 1 }));
  assert.match(oq(['danus', 'status'], env).stdout, /Run: interrupted/);
  const py = spawn('python3', [CLIENT, 'app', '--no-open'], { env: procEnv(env) });
  try {
    await new Promise((res) => py.stdout.on('data', (d) => { if (String(d).includes('OQ_APP_URL')) res(); }));
    assert.ok(await until(() => runState(env).status === 'stopped'), 'it is closed, not relaunched');
    assert.equal((await taskById(id)).status, 'done');
  } finally { py.kill(); }
});

test('audit: the macOS machine has no mount of the home folder, and a machine that can see files is refused', async () => {
  const code = `import importlib.util,sys
s=importlib.util.spec_from_file_location('oq',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(m.LIMA_SPEC)`;
  const spec = spawnSync('python3', ['-c', code, CLIENT], { encoding: 'utf8' }).stdout;
  assert.match(spec, /^base: template:_images\/ubuntu-26\.04$/m, 'the image only, not a template with mounts');
  assert.doesNotMatch(spec, /ubuntu-lts|_default\/mounts|location:/);
  assert.match(fs.readFileSync(CLIENT, 'utf8'), /"--tty=false", "--mount-none"/);
  await drain(annKey); useFake('codex'); const log = fakeMachine('aaa9'); const env = danusEnv('mounted');
  usageCodex(path.join(tmp, 'u-mounted')); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  fs.writeFileSync(path.join(path.dirname(log), 'mounted'), '');
  const r = await launch(env, ['--minutes', '0']);
  assert.match(r.out, /can see files of this computer/);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /bin\/danus start/, 'Danus never started');
  await drain(annKey);
});

test('audit: workers stopped during a computer sleep are restarted', async () => {
  await drain(annKey); useFake('codex'); const log = fakeMachine('bbb9'); const env = danusEnv('sleep');
  usageCodex(path.join(tmp, 'u-sleep')); fs.mkdirSync(env.OQ_CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(env.OQ_CONFIG_DIR, 'danus.json'), '{"ready":true}');
  const started = launch(env, ['--minutes', '0']);
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').match(/bin\/danus start oq/g) || [] : []).length;
  assert.ok(await until(() => starts() === 1));
  fs.writeFileSync(path.join(path.dirname(log), 'lost'), '');
  assert.ok(await until(() => starts() === 2, 20000), 'it restarts');
  assert.equal(oq(['danus', 'stop'], env).status, 0); assert.equal((await started).code, 0);
});

test('audit: a Danus glossary the small reader cannot parse does not corrupt a fact', () => {
  const dir = path.join(tmp, 'glossary'); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'abcdabcdabcdabcd.md');
  fs.writeFileSync(f, '---\nfact_id: abcdabcdabcdabcd\npredecessors: [1111111111111111, 2222222222222222]\nglossary_introduces: {}\nexternal_refs: []\n---\n\n## statement\nS\n\n## proof\nP\n');
  const code = `import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('oq',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.parse_danus(pathlib.Path(sys.argv[2]))))`;
  const r = JSON.parse(spawnSync('python3', ['-c', code, CLIENT, f], { encoding: 'utf8' }).stdout);
  assert.deepEqual(r.predecessors, ['1111111111111111', '2222222222222222']);
  assert.equal(r.glossary_introduces, null); assert.equal(r.external_refs, null);
});

test('audit: a paid Claude sign-in is put on hold', async () => {
  await drain(annKey); useFake('claude');
  const c = await waiting('paid method');
  const out = oq(['run', '--once', '--provider', 'claude', '--project', String(pid)], limitEnv('paid-method', { FAKE_CLAUDE_AUTH: 'api_key' })).stdout;
  assert.match(out, /signed in with a paid API method/);
  assert.equal(aiCalls(), 0); assert.equal((await taskById(c.id)).status, 'pending');
  await drain(annKey);
});

test('audit: Danus labels come from the status log, and the verification trace is not a label', () => {
  const root = path.join(tmp, 'labels'); const mem = path.join(root, 'global_memory'); fs.mkdirSync(path.join(root, 'fact_graph'), { recursive: true }); fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'counterexample.jsonl'), `${JSON.stringify({ id: 'e1', kind: 'counterexample', fact_id: null })}\n`);
  fs.writeFileSync(path.join(mem, 'verification.jsonl'), `${JSON.stringify({ id: 'v1', kind: 'verification', fact_id: 'f1' })}\n${JSON.stringify({ id: 'v2', kind: 'verification', fact_id: 'f2' })}\n`);
  fs.writeFileSync(path.join(mem, '_status.jsonl'), `${JSON.stringify({ id: 'e1', status: 'verified', fact_id: 'f1' })}\n`);
  const code = `import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('oq',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps({k:sorted(v) for k,v in m.danus_labels(pathlib.Path(sys.argv[2])).items()}))`;
  assert.deepEqual(JSON.parse(spawnSync('python3', ['-c', code, CLIENT, path.join(root, 'fact_graph')], { encoding: 'utf8' }).stdout), { f1: ['counterexample'] });
});

test('audit: outsiders and API keys cannot reach what is not theirs', async () => {
  const outsider = await app.signIn('0000-0003-1415-9269');
  const outKey = { token: (await app.call(outsider, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const t = await waiting('audit task');
  const s = (await app.call(annKey, 'POST', `/api/projects/${pid}/ai/suggestions`, { ai_model: 'm', suggestions: [{ title: 'Audit reference', url: 'https://example.org/a', reason_text: 'r' }] })).data.created[0];
  assert.equal((await app.call(outsider, 'GET', `/api/projects/${pid}/ai`)).status, 403);
  assert.equal((await app.call(outsider, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'bib' })).status, 403);
  assert.equal((await app.call(outKey, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive' })).status, 403);
  assert.equal((await app.call(outKey, 'POST', `/api/projects/${pid}/ai/suggestions`, { ai_model: 'm', suggestions: [{ title: 'x', url: 'https://example.org', reason_text: 'r' }] })).status, 403);
  assert.equal((await claim(outKey, { project_id: pid, task_id: t.id })).data.task, null);
  for (const u of [`/api/ai/tasks/${t.id}/cancel`, `/api/ai/tasks/${t.id}/retry`, `/api/bib-suggestions/${s}/accept`, `/api/bib-suggestions/${s}/reject`]) assert.equal((await app.call(outsider, 'POST', u, {})).status, 404, u);
  assert.equal((await fetch(`${base}/api/projects/${pid}/ai`, { headers: { Accept: 'application/json' } })).status, 401);
  assert.equal((await app.call(annKey, 'POST', `/api/conversations/1/messages`, { body_text: 'x' })).status, 403, 'a key cannot write as a person');
  assert.equal((await app.call(annKey, 'POST', '/api/me/keys', { name: 'x' })).status, 403);
  await app.call(ann, 'POST', `/api/bib-suggestions/${s}/reject`, {});
  await drain(annKey);
});

test('audit: a backup restores the AI queue and suggestions', async () => {
  const count = (table) => execFileSync('php', ['-r', `$d=new PDO("sqlite:storage/t.sqlite");echo $d->query("SELECT COUNT(*) FROM ${table}")->fetchColumn();`], { cwd: app.dir, encoding: 'utf8' });
  const before = ['ai_tasks', 'bib_suggestions', 'ai_clients'].map(count);
  assert.ok(before.every((n) => +n > 0));
  const out = execFileSync('php', ['bin/backup.php'], { cwd: app.dir, encoding: 'utf8' });
  const file = out.match(/\S+\.(?:zip|tar\.gz|tgz)/)?.[0] ?? fs.readdirSync(path.join(app.dir, 'storage/backups')).map((f) => path.join(app.dir, 'storage/backups', f))[0];
  assert.equal(spawnSync('php', ['bin/backup.php', '--verify', file], { cwd: app.dir }).status, 0);
  execFileSync('php', ['-r', '$d=new PDO("sqlite:storage/t.sqlite");$d->exec("DELETE FROM bib_suggestions");$d->exec("DELETE FROM ai_clients");'], { cwd: app.dir });
  const r = spawnSync('php', ['bin/restore.php', file, '--yes'], { cwd: app.dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(['ai_tasks', 'bib_suggestions', 'ai_clients'].map(count), before);
});

test('a hostile archive from the machine cannot write outside its folder', () => {
  const dir = path.join(tmp, 'tarcheck'); fs.mkdirSync(dir, { recursive: true });
  const code = `import importlib.util,io,tarfile,sys
s=importlib.util.spec_from_file_location('oq',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
b=io.BytesIO()
with tarfile.open(fileobj=b,mode='w') as t:
    i=tarfile.TarInfo('../evil');i.size=1;t.addfile(i,io.BytesIO(b'x'))
b.seek(0)
try:
    m.safe_extract(tarfile.open(fileobj=b),sys.argv[2]); print('written')
except m.Stop: print('refused')`;
  const r = spawnSync('python3', ['-c', code, CLIENT, path.join(dir, 'in')], { encoding: 'utf8' });
  assert.match(r.stdout, /refused/, r.stderr); assert.ok(!fs.existsSync(path.join(dir, 'evil')));
});

test('installers: the public list is empty until one is published, and a missing file is refused', async () => {
  const info = await (await fetch(`${base}/api/client/info`)).json();
  assert.equal(info.installers.length, 0); assert.match(info.version, /^\d+\.\d+\.\d+$/);
  for (const q of ['mac-arm64', '../../config/config.php', '']) assert.equal((await fetch(`${base}/api/client/download?system=${encodeURIComponent(q)}`)).status, 404);
});

// ----- updates -----

const copyClient = (name, version) => {
  const dir = path.join(tmp, `update-${name}`); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, 'oq.py');
  fs.writeFileSync(file, fs.readFileSync(CLIENT, 'utf8').replace(/^VERSION = "[^"]+"/m, `VERSION = "${version}"`), { mode: 0o755 });
  return file;
};
const runCopy = (file, args, env) => spawnSync('python3', [file, ...args], { encoding: 'utf8', timeout: 30000, env: { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: tmp, ...env } });
const runCopyAsync = (file, args, env) => new Promise((resolve) => {
  const c = spawn('python3', [file, ...args], { env: { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: tmp, ...env } });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
});
const fakeRelease = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });

test('update: an older client finds the new version, installs it, and keeps its previous file', async () => {
  const file = copyClient('old', '0.9.0'); const env = limitEnv('update-old');
  const check = runCopy(file, ['update', '--check'], env);
  assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /is available\. You have 0\.9\.0/);
  assert.match(fs.readFileSync(file, 'utf8'), /VERSION = "0\.9\.0"/, 'checking changes nothing');
  const up = runCopy(file, ['update'], env);
  assert.equal(up.status, 0, up.stderr); assert.match(up.stdout, /Updated to version/);
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(CLIENT, 'utf8'));
  assert.match(fs.readFileSync(`${file}.previous`, 'utf8'), /VERSION = "0\.9\.0"/);
  assert.match(runCopy(file, ['update', '--check'], env).stdout, /up to date/);
});

test('update: a current or newer client is left alone', async () => {
  const file = copyClient('newer', '99.0.0'); const before = fs.readFileSync(file, 'utf8');
  assert.match(runCopy(file, ['update'], limitEnv('update-newer')).stdout, /up to date/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'it never downgrades');
});

test('update: a tampered, invalid or mislabelled file is refused and nothing changes', async () => {
  const good = fs.readFileSync(CLIENT, 'utf8');
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const cases = [
    ['tampered', `${good}\n# changed`, sha(good), '5.0.0', /integrity/],
    ['invalid', 'def broken(:', sha('def broken(:'), '5.0.0', /not valid/],
    ['label', good, sha(good), '5.0.0', /expected version/],
  ];
  for (const [name, body, hash, version, expected] of cases) {
    const s = await fakeRelease((q, r) => { if (q.url.endsWith('/info')) r.end(JSON.stringify({ version, script_sha256: hash, installers: [] })); else r.end(body); });
    const file = copyClient(`bad-${name}`, '0.9.0'); const before = fs.readFileSync(file, 'utf8');
    const res = await new Promise((resolve) => {
      const c = spawn('python3', [file, 'update'], { env: { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, `bad-${name}`), OQ_URL: `http://127.0.0.1:${s.address().port}`, OQ_KEY: 'ouk_test' } });
      let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
    });
    s.close();
    assert.equal(res.code, 2, res.out); assert.match(res.out, expected);
    assert.equal(fs.readFileSync(file, 'utf8'), before, name); assert.ok(!fs.existsSync(`${file}.new`));
  }
});

test('update: code is never fetched over plain HTTP from another machine, and the key is not sent', async () => {
  const code = `import importlib.util,sys
s=importlib.util.spec_from_file_location('oq',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print([m.safe_update_url(u) for u in ['https://a.example','http://a.example','http://127.0.0.1:8080','ftp://a.example','']])
print(m.evaluate_update('1.0.0',{'version':'2.0.0','script_sha256':'a'*64,'installers':[]},True,'mac-arm64')['available'], m.evaluate_update('1.0.0',{'version':'2.0.0','installers':[{'system':'mac-arm64','version':'1.5.0'}]},True,'mac-arm64')['latest'], m.evaluate_update('1.0.0',{'version':'2.0.0','installers':[{'system':'windows','version':'3.0.0'}]},True,'mac-arm64')['available'])
print(m.is_newer('1.10.0','1.9.0'), m.is_newer('1.0.0','1.0.0'), m.is_newer('x','1.0.0'))`;
  const r = spawnSync('python3', ['-c', code, CLIENT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['[True, False, True, False, False]', 'False 1.5.0 False', 'True False False']);
  let auth = null;
  const s = await fakeRelease((q, res) => { auth = q.headers.authorization ?? q.headers['x-api-key'] ?? 'none'; res.end(JSON.stringify({ version: '0.1.0', installers: [] })); });
  const check = await new Promise((resolve) => { const c = spawn('python3', [CLIENT, 'update', '--check'], { env: { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: tmp, OQ_CONFIG_DIR: path.join(tmp, 'nokey'), OQ_URL: `http://127.0.0.1:${s.address().port}`, OQ_KEY: 'ouk_secret' } }); c.on('close', resolve); });
  s.close(); assert.equal(check, 0); assert.equal(auth, 'none');
});

test('update: a failed check never stops the client, and versions stay in sync', async () => {
  const env = { OQ_URL: 'http://127.0.0.1:9', OQ_KEY: annKey.token, OQ_CONFIG_DIR: path.join(tmp, 'offline') };
  assert.equal(runCopy(CLIENT, ['update', '--check'], env).status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.OQ_CONFIG_DIR, 'update.json'))).available, false);
  const version = fs.readFileSync(CLIENT, 'utf8').match(/^VERSION = "([^"]+)"/m)[1];
  assert.equal(JSON.parse(fs.readFileSync('client/desktop/package.json')).version, version);
  const info = await (await fetch(`${base}/api/client/info`)).json();
  assert.equal(info.version, version); assert.match(info.script_sha256, /^[0-9a-f]{64}$/);
});

test('update: a GitHub release is verified, installed, and skipped if it needs a newer platform', async () => {
  const body = fs.readFileSync(CLIENT, 'utf8').replace(/^VERSION = "[^"]+"/m, 'VERSION = "7.0.0"');
  const digest = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
  let notes = 'A release'; let sum = digest; let draft = false;
  const s = await fakeRelease((q, r) => {
    const o = `http://127.0.0.1:${s.address().port}`;
    if (q.url === '/latest') r.end(JSON.stringify({ tag_name: 'v7.0.0', draft, prerelease: false, body: notes, assets: [{ name: 'oq.py', size: body.length, digest: sum, browser_download_url: `${o}/oq.py` }, { name: 'evil.py', digest, browser_download_url: 'https://example.org/x' }] }));
    else r.end(body);
  });
  const env = { ...limitEnv('github'), OQ_RELEASE_URL: `http://127.0.0.1:${s.address().port}/latest` };
  try {
    notes = 'requires-api: 99';
    let file = copyClient('gh-api', '0.9.0');
    assert.doesNotMatch((await runCopyAsync(file, ['update', '--check'], env)).out, /7\.0\.0/, 'it needs a newer platform');
    notes = 'A release'; draft = true;
    assert.doesNotMatch((await runCopyAsync(file, ['update', '--check'], env)).out, /7\.0\.0/, 'a draft is ignored');
    draft = false; sum = `sha256:${'0'.repeat(64)}`;
    file = copyClient('gh-bad', '0.9.0'); const before = fs.readFileSync(file, 'utf8');
    const bad = await runCopyAsync(file, ['update'], env);
    assert.equal(bad.code, 2, bad.out); assert.match(bad.out, /integrity/); assert.equal(fs.readFileSync(file, 'utf8'), before);
    sum = digest; file = copyClient('gh-good', '0.9.0');
    const good = await runCopyAsync(file, ['update'], env);
    assert.equal(good.code, 0, good.out); assert.match(good.out, /Updated to version 7\.0\.0/);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  } finally { s.close(); }
});

test('update: a repository without any release is up to date, not a failed check', async () => {
  const s = await fakeRelease((q, r) => { r.statusCode = 404; r.end('{"message":"Not Found"}'); });
  try {
    const res = await runCopyAsync(CLIENT, ['update', '--check'], { OQ_CONFIG_DIR: path.join(tmp, 'norelease'), OQ_RELEASE_URL: `http://127.0.0.1:${s.address().port}/latest` });
    assert.equal(res.code, 0, res.out); assert.match(res.out, /up to date/);
  } finally { s.close(); }
});

test('update: the graphic client updates, restarts on the same page, and refuses while working', async () => {
  const file = copyClient('ui', '0.9.0'); const env = limitEnv('update-ui');
  const py = spawn('python3', [file, 'app', '--no-open'], { env: { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: tmp, ...env } });
  try {
    const url = await new Promise((res, rej) => { py.stdout.on('data', (d) => { const m = String(d).match(/OQ_APP_URL=(\S+)/); if (m) res(m[1]); }); setTimeout(() => rej(new Error('no url')), 8000); });
    const u = new URL(url); const h = { 'X-OQ-Token': u.searchParams.get('t'), 'Content-Type': 'application/json' };
    const state = async () => (await fetch(`${u.origin}/api/state`, { headers: h })).json();
    assert.equal((await fetch(`${u.origin}/api/update/check`, { method: 'POST', headers: h, body: '{}' })).status, 200);
    const before = await state(); assert.equal(before.update.available, true); assert.equal(before.update.mode, 'script');
    const res = await (await fetch(`${u.origin}/api/update/apply`, { method: 'POST', headers: h, body: '{}' })).json();
    assert.equal(res.restarting, true);
    let after = null;
    assert.ok(await until(async () => { try { after = await state(); return after.version !== '0.9.0'; } catch { return false; } }), 'the new version answers at the same address');
    assert.equal(after.update.available, false);
  } finally { py.kill(); }
});

test('the client is served, and deployed', async () => {
  const r = await fetch(`${base}/api/client/oq.py`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Open Questions AI client/);
  const { deployFiles } = await import(`../scripts/lib/${fs.readdirSync('scripts/lib')[0]}`);
  const remote = JSON.stringify(deployFiles('.'));
  assert.ok(remote.includes('client/oq.py') && remote.includes('client/.htaccess'));
});
