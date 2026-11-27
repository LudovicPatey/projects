// On Windows, proving runs in a Linux machine of Windows's own subsystem (WSL). When WSL is missing, the client asks Windows
// for approval itself (an administrator window), and otherwise says what stops it, from WSL's own words: an older WSL, or
// virtualization turned off. WSL writes UTF-16 to a pipe.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const CLIENT = path.resolve('client/oq.py');

test('the client reads WSL\'s answers and says what to do', () => {
  const out = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
u16 = lambda s: s.encode("utf-16-le")
cases = {
  "missing": (1, oq.wsl_text(u16("The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'."))),
  "old": (1, oq.wsl_text(u16("Invalid command line option: --name"))),
  "virtualization": (4294967295, oq.wsl_text(u16("WslRegisterDistribution failed with error: 0x80370102\\nPlease enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS."))),
  "fine": (0, oq.wsl_text(b"Default Version: 2\\n")),
  "silent": (1, oq.wsl_text(b"")),
}
print(json.dumps({k: oq.wsl_problem(c, t) for k, (c, t) in cases.items()} | {"text": cases["old"][1], "help": sorted(oq.WSL_HELP)}))
`, CLIENT], { encoding: 'utf8' });
  const r = JSON.parse(out.stdout || '{}');
  assert.equal(r.text, 'Invalid command line option: --name', out.stderr);
  assert.deepEqual([r.missing, r.old, r.virtualization, r.fine, r.silent], ['missing', 'old', 'virtualization', '', 'missing']);
  assert.deepEqual(r.help, ['declined', 'missing', 'old', 'other', 'restart', 'virtualization']);
});

test('the WSL machine asks Windows for administrator approval instead of failing silently', () => {
  const src = spawnSync('grep', ['-n', '-e', '-Verb RunAs', '-e', 'self.elevated("--install", "--no-distribution")', '-e', 'self.elevated("--update")', CLIENT], { encoding: 'utf8' }).stdout;
  assert.match(src, /-Verb RunAs/); assert.match(src, /--no-distribution/); assert.match(src, /--update/);
});
