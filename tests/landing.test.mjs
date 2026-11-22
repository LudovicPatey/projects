// The front page must follow the features of the platform.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const landing = fs.readFileSync('public/assets/js/views/landing.js', 'utf8');
const main = fs.readFileSync('public/assets/js/main.js', 'utf8');
const block = landing.match(/FRONT_PAGE_COVERAGE = \{([\s\S]*?)\n\};/)[1];
const coverage = Object.fromEntries([...block.matchAll(/(\w+): ('([^']+)'|false)/g)].map((m) => [m[1], m[3] ?? false]));
const body = landing.replace(/FRONT_PAGE_COVERAGE = \{[\s\S]*?\n\};/, '');

test('the front page takes a position on every menu area', () => {
  const views = [...main.matchAll(/\{ view: '(\w+)', icon:/g)].map((m) => m[1]);
  assert.ok(views.length >= 8);
  for (const v of views) assert.ok(v in coverage, `Decide how the front page presents "${v}" in FRONT_PAGE_COVERAGE`);
  for (const v of Object.keys(coverage)) assert.ok(views.includes(v), `"${v}" is no longer a menu area`);
});

test('each declared section really is on the front page', () => {
  for (const [view, section] of Object.entries(coverage)) if (section) assert.ok(body.includes(section), `${view}: "${section}" is not on the front page`);
});

test('the agent instructions require the front page check', () => {
  const agents = fs.readFileSync('AGENTS.md', 'utf8');
  assert.match(agents, /\*\*Front page\.\*\*/);
  assert.ok(agents.includes('FRONT_PAGE_COVERAGE'));
});
