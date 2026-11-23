// Proving directly on a Mac is an explicit choice, with its own folder and with the Codex sandbox kept on.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const CLIENT = path.resolve('client/oq.py');
let tmp; let n = 0;
const fresh = () => { n += 1; const dir = path.join(tmp, `c${n}`); fs.mkdirSync(path.join(dir, 'home'), { recursive: true }); return { ...process.env, HOME: path.join(dir, 'home'), OQ_CONFIG_DIR: path.join(dir, 'config'), OQ_DANUS_BACKEND: '' }; };
const python = (env, body) => execFileSync('python3', ['-c', `
import importlib.util, json, os, pathlib, socket, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
oq.sys.platform = "darwin"
oq.data_dir().mkdir(parents=True, exist_ok=True)
${body}
`, CLIENT], { env, encoding: 'utf8' });

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-native-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the isolated machine stays the default, and native needs explicit consent', () => {
  python(fresh(), `
assert oq.danus_mode() == "isolated" and isinstance(oq.pick_vm(), oq.LimaVm)
m = oq.DanusManager()
try:
    m.choose_mode("native")
    raise SystemExit("accepted without consent")
except oq.Stop:
    pass
assert oq.danus_mode() == "isolated"
m.choose_mode("native", True)
assert oq.danus_mode() == "native" and isinstance(oq.pick_vm(), oq.NativeMacVm) and m.state()["native_accepted_at"]
m.choose_mode("isolated")
assert oq.danus_mode() == "isolated"
`);
});

test('the command line refuses native without the risk flag, and other systems refuse it', () => {
  const e = fresh();
  const r = spawnSync('python3', [CLIENT, 'danus', 'setup', '--native'], { env: e, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /accept-risk/);
  assert.ok(!fs.existsSync(path.join(e.OQ_CONFIG_DIR, 'danus-native')));
  python(fresh(), `
oq.sys.platform = "linux"
try:
    oq.DanusManager().choose_mode("native", True)
    raise SystemExit("accepted on Linux")
except oq.Stop:
    pass
`);
});

test('native never starts with the Codex sandbox turned off', () => {
  python(fresh(), `
m = oq.DanusManager(); m.choose_mode("native", True); vm = oq.pick_vm()
for name in ("danus/execution/loop.py", "danus/verify/launcher.py", "danus/authoring/driver.py"):
    f = vm.home / name; f.parent.mkdir(parents=True, exist_ok=True); f.write_text('cmd = [\\n  "--sandbox", "workspace-write",\\n]\\n')
(vm.home / "runtime").mkdir(); (vm.home / "runtime" / "runtime.env").write_text("")
assert vm.sandbox_kept(); m.assert_isolated(vm)
(vm.home / "danus/execution/loop.py").write_text('cmd = [\\n  "--dangerously-bypass-approvals-and-sandbox",\\n]\\n')
assert not vm.sandbox_kept()
try:
    m.assert_isolated(vm)
    raise SystemExit("started without the sandbox")
except oq.Stop:
    pass
`);
});

test('the embedded changes keep the sandbox and the install targets macOS', () => {
  python(fresh(), `
added = [x for x in oq.DANUS_MACOS_PATCH.splitlines() if x.startswith("+")]
removed = [x for x in oq.DANUS_MACOS_PATCH.splitlines() if x.startswith("-")]
assert not any('"--dangerously-bypass' in x for x in added)
assert sum('"--dangerously-bypass' in x for x in removed) == 3
assert any('"--sandbox", "workspace-write"' in x for x in added)
assert "-darwin-" in oq.DANUS_NATIVE_SETUP and oq.DANUS_COMMIT in oq.DANUS_NATIVE_SETUP
`);
});

test('native has its own ports, a clean environment, and removes only its folder', () => {
  const e = { ...fresh(), OPENAI_API_KEY: 'test-value', ANTHROPIC_API_KEY: 'test-value', CODEX_HOME: '/elsewhere', CLAUDE_CODE_OAUTH_TOKEN: 'test-value' };
  python(e, `
vm = oq.NativeMacVm()
assert not any(k in vm.env for k in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN"))
assert vm.env["HOME"] == str(vm.user_home)
assert "/opt/danus" not in " ".join(vm.command("cd /opt/danus && ls"))
c = vm.home / "config"; c.mkdir(parents=True); (c / "danus.env").write_text("VERIFY_PORT=8091\\nDASHBOARD_PORT=8099\\nKEEP=1\\n")
vm.ensure_ports()
text = (c / "danus.env").read_text()
assert "KEEP=1" in text and "VERIFY_PORT=8091" not in text and "DASHBOARD_PORT=8099" not in text
other = oq.data_dir() / "keep.txt"; other.write_text("mine")
vm.remove()
assert not vm.root.exists() and other.read_text() == "mine"
`);
});

test('removing one backend keeps the state of the other', () => {
  python(fresh(), `
m = oq.DanusManager(); m.save(ready=True, ready_modes=["isolated", "native"], mode="native", native_accepted_at=1)
oq.pick_vm = lambda mode=None: None
m.remove("isolated")
d = m.state()
assert d["ready_modes"] == ["native"] and d["ready"] is True and d["mode"] == "native"
`);
});

test('the graphic interface needs its token and consent to change the mode', async () => {
  const e = fresh();
  const child = spawn('python3', [CLIENT, 'app', '--no-open'], { env: { ...e, OQ_BACKUP_POLL: '3600' } });
  try {
    const url = await new Promise((resolve, reject) => {
      let text = ''; child.stdout.on('data', (d) => { text += d; const m = text.match(/OQ_APP_URL=(\S+)/); if (m) resolve(m[1]); });
      child.on('exit', () => reject(new Error('stopped')));
    });
    const u = new URL(url); const token = u.searchParams.get('t');
    const post = (body, t = token) => fetch(`${u.origin}/api/danus/mode`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { 'X-OQ-Token': t } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post({ mode: 'native', accept: true }, '')).status, 403);
    assert.equal((await post({ mode: 'native' })).status, 422);
    assert.equal((await post({ mode: 'native', accept: 'yes' })).status, 422);
    assert.equal((await post({ mode: 'other', accept: true })).status, 422);
    const s = await (await fetch(`${u.origin}/api/state`, { headers: { 'X-OQ-Token': token } })).json();
    assert.equal(s.danus.mode, 'isolated');
  } finally { child.kill(); }
});
