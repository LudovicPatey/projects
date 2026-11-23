// Proof search on Claude: an explicit choice, with no shell, scoped files, and its own limits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const CLIENT = path.resolve('client/oq.py');
let tmp; let n = 0;
const fresh = () => { n += 1; const dir = path.join(tmp, `c${n}`); fs.mkdirSync(path.join(dir, 'home'), { recursive: true }); return { ...process.env, HOME: path.join(dir, 'home'), OQ_CONFIG_DIR: path.join(dir, 'config'), OQ_DANUS_BACKEND: '' }; };
const python = (env, body) => execFileSync('python3', ['-c', `
import importlib.util, json, os, pathlib, shutil, stat, subprocess, sys, tempfile, time
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
oq.sys.platform = "darwin"
oq.data_dir().mkdir(parents=True, exist_ok=True)
def refused(fn, *a, **k):
    try:
        fn(*a, **k)
    except oq.Stop:
        return
    raise SystemExit("accepted")
def installed(claude="/bin/echo"):
    m = oq.DanusManager(); m.choose_engine("claude", True); vm = oq.pick_vm()
    (vm.home / "config").mkdir(parents=True, exist_ok=True); (vm.home / "config" / "danus.env").write_text("KEEP=1\\n")
    vm.tools.mkdir(parents=True, exist_ok=True); (vm.tools / "python3").symlink_to(sys.executable)
    oq.shutil.which = lambda name, *a, **k: claude if name == "claude" else None
    return m, vm
def adapter(vm):
    spec = importlib.util.spec_from_file_location("adapter", vm.tools / "adapter.py")
    (vm.tools / "adapter.py").write_text(oq.DANUS_CLAUDE_ADAPTER)
    a = importlib.util.module_from_spec(spec); spec.loader.exec_module(a); return a
${body}
`, CLIENT], { env, encoding: 'utf8' });

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-claude-engine-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('ChatGPT stays the default, and Claude needs consent on a Mac', () => {
  python(fresh(), `
assert oq.danus_engine() == "chatgpt"
m = oq.DanusManager(); refused(m.choose_engine, "claude"); assert oq.danus_engine() == "chatgpt"
refused(m.choose_engine, "other", True)
m.choose_engine("claude", True); assert oq.danus_engine() == "claude" and oq.danus_mode() == "native"
refused(m.choose_mode, "isolated")
m.choose_engine("chatgpt"); assert oq.danus_engine() == "chatgpt"
oq.sys.platform = "linux"; refused(oq.DanusManager().choose_engine, "claude", True)
`);
});

test('switching the engine changes only its own settings', () => {
  python(fresh(), `
m, vm = installed(); path = vm.home / "config" / "danus.env"
assert m.apply_engine(vm) is True
text = path.read_text(); assert "KEEP=1" in text and f"DANUS_CODEX_BIN={vm.tools / 'danus-claude'}" in text
assert stat.S_IMODE((vm.tools / "danus-claude").stat().st_mode) == 0o700 and stat.S_IMODE((vm.tools / "danus-claude.json").stat().st_mode) == 0o600
assert m.apply_engine(vm) is False, "no restart when nothing changed"
m.choose_engine("chatgpt"); assert m.apply_engine(vm) is True
assert path.read_text() == "KEEP=1\\n"
`);
});

test('the adapter has no shell, scoped files, no API keys, and refuses other launches', () => {
  python(fresh(), `
m, vm = installed(); m.apply_engine(vm); a = adapter(vm)
base = ["exec","--model","opus","--config",'model_reasoning_effort="xhigh"',"-C","/tmp/w","--skip-git-repo-check","--sandbox","workspace-write","-c",'approval_policy="never"',"-c",'mcp_servers.write-paper={command="/usr/bin/false",enabled=false}',"-c",'mcp_servers.danus.command="/py"',"-c",'mcp_servers.danus.args=["-m","danus.gateway"]',"-c",'mcp_servers.danus.env.DANUS_ROLE="worker"',"do it"]
p = a.parse(base); assert p["mcp"]["env"]["DANUS_ROLE"] == "worker"
for bad in (base[:-1]+["--dangerously-bypass-approvals-and-sandbox","x"], ["login"], base[:9]+["danger-full-access"]+base[10:], base[:-1]+["-c",'mcp_servers.write-paper={command="x"}',"x"], base[:-1]+["-c",'model_provider="evil"',"x"]):
    try:
        a.parse(bad); raise SystemExit("accepted")
    except a.Refused:
        pass
with tempfile.TemporaryDirectory() as t:
    cmd = a.build(p, {}, pathlib.Path(t))
assert cmd[cmd.index("--tools")+1] == "Read,Write,Edit,Glob,Grep,WebSearch" and not any("Bash" in x for x in cmd)
assert cmd[cmd.index("--permission-mode")+1] == "dontAsk" and cmd[cmd.index("--model")+1] == "opus" and cmd[cmd.index("--effort")+1] == "high"
assert cmd[cmd.index("--setting-sources")+1] == "" and "--strict-mcp-config" in cmd
allowed = cmd[cmd.index("--allowedTools")+1:]
assert not any(x.startswith(("Read(//**", "Write(//**", "Edit(//**")) for x in allowed)
e = a.child_env({"PATH":"/bin","ANTHROPIC_API_KEY":"x","CLAUDE_CODE_OAUTH_TOKEN":"y","OPENAI_API_KEY":"z","CODEX_HOME":"/c"})
assert not {"ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","OPENAI_API_KEY","CODEX_HOME"} & set(e)
`);
});

test('a Claude run needs a time limit, a sign-in, and a Claude model', () => {
  python(fresh(), `
m, vm = installed(); m.save(ready=True)
oq.save_config({"url": "http://127.0.0.1:9", "key": "ouk_test"})
oq.tool_signed_in = lambda name: True; oq.billing_problem = lambda *a: None; oq.danus_block = lambda run: None
run = oq.DanusRun(); run.execute = lambda api: None
refused(run.start, {"project_id": 1, "minutes": 0})
refused(run.start, {"project_id": 1, "minutes": 10, "model": "gpt-5.6-sol"})
oq.tool_signed_in = lambda name: False; refused(run.start, {"project_id": 1, "minutes": 10})
oq.tool_signed_in = lambda name: True
run.start({"project_id": 1, "minutes": 10}, background=False)
s = run.read(); assert s["engine"] == "claude" and s["model"] == "opus"
`);
});

test('usage, the real model, limits and repeated errors are collected', () => {
  python(fresh(), `
m, vm = installed(); run = oq.DanusRun(); run.write(status="running", engine="claude", model="opus", project_id=1)
events = vm.tools / "danus-claude-events.jsonl"
put = lambda *rows: events.write_text("".join(json.dumps(r) + "\\n" for r in rows))
put({"role":"verifier","failed":False,"model":"claude-haiku-5-5","tokens":5}, {"role":"worker","failed":False,"model":"claude-opus-5-5","tokens":7}, "not an event")
run.collect(vm); assert run.read()["model"] == "claude-opus-5-5" and oq.Ledger().read()["tokens"] == 12 and not events.exists()
put({"role":"worker","failed":True,"error":"You have hit your usage limit","tokens":0})
run.collect(vm); assert oq.Ledger().read()["blocked_until"] > time.time()
d = oq.Ledger().read(); d.update(blocked_until=0, blocked_reason=""); oq.Ledger().write(d)
assert oq.danus_block({"engine":"claude","project_id":1}) is None, "no usage percentage is needed"
put(*[{"role":"worker","failed":True,"error":"bad auth","tokens":0}]*2); run.collect(vm)
put({"role":"worker","failed":False,"tokens":1}, {"role":"worker","failed":True,"error":"bad auth","tokens":0}); run.collect(vm)
put(*[{"role":"worker","failed":True,"error":"bad auth","tokens":0}]*2)
try:
    run.collect(vm); raise SystemExit("three errors in a row were ignored")
except RuntimeError as e:
    assert "bad auth" in str(e)
`);
});

test('facts wait for the exact model name, except at the end of a run', () => {
  python(fresh(), `
m, vm = installed(); run = oq.DanusRun(); calls = []
class Graph:
    def fetch_graph(self, *a):
        calls.append(1); return False
s = {"engine": "claude", "model": "opus", "project_id": 1}
run.sync(None, Graph(), vm, "x", pathlib.Path("g"), s); assert not calls
run.sync(None, Graph(), vm, "x", pathlib.Path("g"), s, final=True); assert calls
run.sync(None, Graph(), vm, "x", pathlib.Path("g"), {**s, "model": "claude-opus-5-5"}); assert len(calls) == 2
`);
});
