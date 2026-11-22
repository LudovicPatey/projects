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

test('the license is complete, declared, and the source code is offered to users', () => {
  const license = fs.readFileSync('LICENSE', 'utf8');
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
  assert.ok(license.includes('13. Remote Network Interaction; Use with the GNU General Public License.'));
  for (const f of ['package.json', 'client/desktop/package.json']) assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).license, 'AGPL-3.0-only', f);
  assert.ok(fs.readFileSync('client/oq.py', 'utf8').includes('SPDX-License-Identifier: AGPL-3.0-only'));
  assert.ok(JSON.parse(fs.readFileSync('client/desktop/package.json', 'utf8')).build.extraResources.some((r) => r.to === 'LICENSE'), 'the app ships the license');
  assert.ok(landing.includes('sourceUrl') && landing.includes('AGPL-3.0'), 'the front page links to the source');
  assert.ok(fs.readFileSync('public/assets/js/views/client.js', 'utf8').includes('Source code (AGPL-3.0)'));
  assert.ok(fs.readFileSync('client/oq.py', 'utf8').includes('Source code (AGPL-3.0)'));
});
