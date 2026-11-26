// Every module of the interface parses: one stray quote in a help text leaves the whole app blank, and no other test loads every
// module the way the browser does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);

test('every interface module parses', () => {
  const broken = files('public/assets/js').filter((f) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status !== 0);
  assert.deepEqual(broken, []);
});
