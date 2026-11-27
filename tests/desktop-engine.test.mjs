// The desktop app clears macOS's quarantine mark on its own engine before running it: a marked engine hangs at load, with no window.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { prepareEngine, startFailure, marked } = require('../client/desktop/engine.js');
const mac = process.platform === 'darwin';

test('on a Mac, a marked engine is cleared in place, and an unmarked one is left as it is', { skip: !mac && 'macOS only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-engine-'));
  const file = path.join(dir, 'oq');
  fs.writeFileSync(file, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  spawnSync('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', file]);
  assert.equal(marked(file), true);
  assert.deepEqual(prepareEngine(file, dir), { file, how: 'cleared' });
  assert.equal(marked(file), false);
  assert.deepEqual(prepareEngine(file, dir), { file, how: 'as-is' }, 'nothing to do the next time');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an engine that cannot be cleared in place runs from an unmarked copy in the app’s data folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-engine-'));
  const file = path.join(dir, 'oq'); fs.writeFileSync(file, 'engine');
  const copy = path.join(dir, 'data', 'engine', 'oq');
  // xattr as on a Mac where the app belongs to another account: the original keeps its mark, the copy loses it.
  const run = (cmd, args) => ({ status: args[0] === '-p' ? (args[2] === file || fs.existsSync(copy + '.marked') ? 0 : 1) : 0 });
  assert.deepEqual(prepareEngine(file, path.join(dir, 'data'), { platform: 'darwin', run }), { file: copy, how: 'copied' });
  assert.equal(fs.readFileSync(copy, 'utf8'), 'engine');
  assert.deepEqual(prepareEngine(file, dir, { platform: 'linux', run }), { file, how: 'as-is' }, 'other systems: untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('if the engine still does not start, the user is told the one command that fixes it', () => {
  assert.match(startFailure('/Applications/Open Questions AI.app', 'darwin'), /xattr -dr com\.apple\.quarantine "\/Applications\/Open Questions AI\.app"/);
  assert.doesNotMatch(startFailure('C:\\x', 'win32'), /xattr/);
  const main = fs.readFileSync('client/desktop/main.js', 'utf8');
  assert.match(main, /prepareEngine\(packaged, app\.getPath\('userData'\)\)/);
  assert.match(fs.readFileSync('client/desktop/package.json', 'utf8'), /"engine\.js"/, 'packaged with the app');
});
