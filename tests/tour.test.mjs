// First-use tutorial: content, trigger and placement, plus the server rules for storing progress.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { TOUR_KINDS, buildSteps, placeBubble, tourToStart } from '../public/assets/js/help/tour-steps.js';
import { articleBySlug } from '../public/assets/js/help/content.js';

const shell = ['public/assets/js/main.js', 'public/assets/js/search.js', 'public/assets/js/views/misc.js'].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const navViews = [...fs.readFileSync('public/assets/js/main.js', 'utf8').matchAll(/\{ view: '(\w+)', icon:/g)].map((m) => m[1]);
const viewport = { width: 1000, height: 700 };
const bubble = { width: 300, height: 200 };
const inside = (p) => p.left >= 0 && p.top >= 0 && p.left + bubble.width <= viewport.width && p.top + bubble.height <= viewport.height;

test('every step points at an element that exists in the interface', () => {
  for (const kind of TOUR_KINDS) {
    const steps = buildSteps(kind, { title: 'P', role: 'member' });
    assert.equal(new Set(steps.map((s) => s.id)).size, steps.length, kind);
    assert.equal(steps[0].target, null, 'starts with a welcome');
    for (const s of steps) {
      assert.ok(s.title && s.text, s.id);
      if (!s.target) continue;
      const known = s.target.startsWith('nav-') && s.target !== 'nav-projects' ? navViews.includes(s.target.slice(4)) : shell.includes(`data-tour="${s.target}"`);
      assert.ok(known, `${kind}: no data-tour="${s.target}" in the interface`);
    }
  }
  assert.ok(shell.includes(':data-tour="\'nav-\' + it.view"'));
});

test('every menu area is presented by the project tour', () => {
  // Owners see every menu area. Members do not have the Admin page, and their tour does not mention it.
  const targets = buildSteps('project', { role: 'owner' }).map((s) => s.target);
  for (const v of navViews) assert.ok(targets.includes(`nav-${v}`), `the tour does not present ${v}`);
  assert.equal(buildSteps('project', { role: 'member' }).some((s) => s.target === 'nav-admin'), false);
});

test('the project tour adapts to the project and the role', () => {
  const owner = buildSteps('project', { title: 'Collatz', role: 'owner' });
  const member = buildSteps('project', { title: 'Collatz', role: 'member' });
  assert.match(owner[0].title, /Collatz/);
  assert.match(owner[0].text, /an owner/);
  assert.match(member[0].text, /a member/);
  assert.match(owner.find((s) => s.id === 'members').text, /Add researchers/);
  assert.doesNotMatch(member.find((s) => s.id === 'members').text, /Add researchers/);
});

test('the tour opens once per kind, on the right pages', () => {
  const home = { name: 'projects' }; const project = { name: 'project', pid: 2 };
  assert.equal(tourToStart({ route: home }), 'home');
  assert.equal(tourToStart({ route: home, seen: ['home'] }), null);
  assert.equal(tourToStart({ route: project, projectLoaded: false }), null);
  assert.equal(tourToStart({ route: project, projectLoaded: true, seen: ['home'] }), 'project');
  assert.equal(tourToStart({ route: project, projectLoaded: true, seen: ['project'] }), null);
  assert.equal(tourToStart({ route: home, running: true }), null);
  for (const name of ['profile', 'help']) assert.equal(tourToStart({ route: { name } }), null);
});

test('the bubble stays on screen and points at its target', () => {
  const rail = { left: 0, right: 76, top: 100, bottom: 160 };
  const right = placeBubble(rail, bubble, viewport, 'right');
  assert.equal(right.side, 'right');
  assert.equal(right.left, 90);
  assert.equal(right.top + right.arrow, 130);
  const low = placeBubble({ left: 0, right: 76, top: 640, bottom: 695 }, bubble, viewport, 'right');
  assert.ok(inside(low));
  assert.equal(low.top + low.arrow, 667.5);
  assert.equal(placeBubble({ left: 800, right: 990, top: 10, bottom: 50 }, bubble, viewport, 'right').side, 'bottom');
  assert.equal(placeBubble(null, bubble, viewport).side, 'none');
  assert.ok(inside(placeBubble(null, bubble, viewport)));
  const full = placeBubble({ left: 0, right: 1000, top: 0, bottom: 700 }, bubble, viewport, 'right');
  assert.equal(full.side, 'none');
  assert.ok(inside(full));
});

test('the tutorial is documented in the help center', () => {
  const a = articleBySlug('tutorial');
  assert.ok(a);
  assert.ok(a.blocks.some((b) => b.type === 'tour'), 'the article offers to replay it');
});

test('the server stores only known tutorials', () => {
  const php = `require 'src/Tours.php'; use App\\Tours; echo json_encode([
    Tours::parse(null), Tours::parse('project,home,evil'), Tours::merge(null, ['project']), Tours::merge('project', ['home', 'home']),
    Tours::merge('home', []), Tours::merge('home', ['evil']), Tours::merge('home', 'project'), Tours::merge('home', ['a' => 'home']),
  ]);`;
  assert.deepEqual(JSON.parse(execFileSync('php', ['-r', php], { encoding: 'utf8' })),
    [[], ['home', 'project'], 'project', 'home,project', 'home', null, null, null]);
});
