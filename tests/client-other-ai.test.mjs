// When the main AI is at its own limit (Claude's subscription), the other AI signed in on the computer keeps doing what it can do
// alone: the independent reviews and checks, offered with its models only. Work that needs the main AI waits, and your own caps
// (daily tasks, hours, pause) still hold both.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const CLIENT = path.resolve('client/oq.py');

const run = (setup) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-other-'));
  const out = spawnSync('python3', ['-c', `
import importlib.util, json, sys, time, argparse
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
oq.shutil.which = lambda t: "/bin/" + t
oq.tool_signed_in = lambda t: True
oq.UsageReader.read = staticmethod(lambda p: None)
oq.lean_conf = lambda: None
oq.refresh_procedures = lambda api: [{"id": "proof_review", "runnable": True, "independent": True}, {"id": "notation_settle", "runnable": True}]
oq.procedure_on = lambda limits, pid: True
oq.known_model = lambda tool, m: m or ("claude-opus-5-5" if tool == "claude" else "gpt-6.1-sol")
oq.chosen_model = lambda tool, kind: "claude-opus-5-5" if tool == "claude" else "gpt-6.1-sol"
${setup}
class Api:
    url = "http://x"
    def post(self, path, body): self.body = body; return {"task": None}
api = Api()
opts = argparse.Namespace(provider="claude", model=None, kinds=list(oq.KINDS), project=None, timeout=60, interval=60, once=True, limit=None)
oq.work_once(api, opts, "mac (claude)")
b = getattr(api, "body", None)
print(json.dumps({"kinds": b and b["kinds"], "models": b and b["models"], "ai_model": b and b["ai_model"], "hold": opts.hold and opts.hold[0]}))
`, CLIENT], { encoding: 'utf8', env: { ...process.env, OQ_CONFIG_DIR: dir } });
  return JSON.parse(out.stdout || `{"error": ${JSON.stringify(out.stderr.slice(-800))}}`);
};

test('Claude at its limit: ChatGPT takes the independent reviews and checks, with its own models only', () => {
  const r = run('oq.Ledger().block("Claude usage limit reached.", time.time() + 3600, "claude")');
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.kinds.sort(), ['proof_review', 'review']);
  assert.deepEqual(r.models, { review: ['gpt-6.1-sol'], proof_review: ['gpt-6.1-sol'] }, 'no Claude model is offered');
  assert.equal(r.ai_model, 'gpt-6.1-sol');
  assert.match(r.hold, /Meanwhile ChatGPT keeps doing the independent reviews and checks/);
});

test('your own caps hold both AIs; without a limit, everything is claimed as before', () => {
  const paused = run('oq.save_limits({"paused": True})');
  assert.equal(paused.kinds, null, 'a pause stops all work'); assert.match(paused.hold, /Paused/);
  const free = run('');
  assert.ok(free.kinds.includes('extract') && free.kinds.includes('review'));
  assert.equal(free.ai_model, 'claude');
});

test('a rate limit or an overloaded service holds the work instead of failing the task', () => {
  const out = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
def kind(text):
    try: oq.check_limit_text(text); return None
    except oq.LimitReached as e: return str(e)
live = 'e,"num_turns":1,"subtype":"success","api_error_status":429,"api_error_type":"rate_limit_error","api_error_origin":"first_party","a'
print(json.dumps([kind(live), kind('{"api_error_status":529,"api_error_type":"overloaded_error"}'), kind("Claude stopped: the proof has a gap at step 2")]))
`, CLIENT], { encoding: 'utf8' });
  const [limit, busy, other] = JSON.parse(out.stdout || '[]');
  assert.match(limit || '', /limit is reached/, out.stderr);
  assert.match(busy || '', /overloaded/);
  assert.equal(other, null, 'an ordinary error still fails the task');
});

test('the model recorded is the one asked for, not Claude Code\'s helper that read the web pages', () => {
  const out = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
usage = {"claude-sonnet-5-5": {"outputTokens": 900}, "claude-haiku-5-5": {"outputTokens": 4000}}
print(json.dumps([oq.model_that_ran("sonnet", usage), oq.model_that_ran("claude-sonnet-5-5", usage), oq.model_that_ran("opus", usage), oq.model_that_ran("sonnet", {})]))
`, CLIENT], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.stdout || '[]'), ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', null], out.stderr);
});
