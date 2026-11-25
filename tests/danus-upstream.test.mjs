// Following the original Danus: the copies of what we adapt, the pin, and the audit of upstream changes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const manifest = JSON.parse(fs.readFileSync('third_party/danus/manifest.json', 'utf8'));
const local = path.join(os.homedir(), '.config/open-questions/danus-native/danus');

test('we keep a copy of every Danus file the native prover adapts, with its license, at the commit the client installs', () => {
  assert.equal(fs.readFileSync('client/oq.py', 'utf8').match(/^DANUS_COMMIT = "([0-9a-f]{40})"/m)[1], manifest.commit, 'one pin for the copies and the installed Danus');
  assert.match(fs.readFileSync('third_party/danus/upstream/LICENSE', 'utf8'), /Apache License\s+Version 2\.0/);
  for (const file of Object.keys(manifest.adapted)) assert.ok(fs.existsSync(path.join('third_party/danus/upstream', file)), file);
  for (const where of Object.values({ ...manifest.adapted, ...manifest.integration })) {
    for (const name of where.match(/\b(PROVER_[A-Z]+|DANUS_[A-Z_]+|DanusRun\.\w+)/g) || []) {
      assert.ok(fs.readFileSync('client/oq.py', 'utf8').includes(name.replace('DanusRun.', 'def ')), `${name} still exists in the client`);
    }
  }
  assert.equal(JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts['danus:upstream'], 'node scripts/danus-upstream.mjs');
});

test('the audit reports what changed upstream, and checks that our integration still fits', { skip: !fs.existsSync(path.join(local, '.git')) }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-upstream-'));
  try {
    // An upstream with one new commit on the branch we follow: a change to the worker's contract.
    const up = path.join(tmp, 'up');
    execFileSync('git', ['clone', '--quiet', local, up]);
    execFileSync('git', ['-C', up, 'checkout', '--quiet', '-B', manifest.branch, manifest.commit]);
    fs.appendFileSync(path.join(up, 'agents/contracts/worker.md'), '\n- A new rule for workers.\n');
    execFileSync('git', ['-C', up, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '--quiet', '-am', 'Workers: a new rule']);
    const report = path.join(tmp, 'report.md');
    const r = spawnSync('node', ['scripts/danus-upstream.mjs', '--report', report], { encoding: 'utf8', env: { ...process.env, DANUS_UPSTREAM_URL: up, DANUS_UPSTREAM_DIR: path.join(tmp, 'cache') } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 commit\(s\) since/); assert.match(r.stdout, /Adapted files changed: agents\/contracts\/worker\.md\./);
    assert.match(r.stdout, /Integration files changed: none/); assert.match(r.stdout, /macOS patch: applies\. Merge: runs with its storage code\./);
    const text = fs.readFileSync(report, 'utf8');
    assert.match(text, /Workers: a new rule/); assert.match(text, /### agents\/contracts\/worker\.md[\s\S]*Used by client\/oq\.py PROVER_WORKER[\s\S]*\+- A new rule for workers\./);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
