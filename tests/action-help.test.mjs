// Members do not know the interface: each action that could mean several things, or reaches further than it looks, says what it
// changes and what it leaves as it is, on hover and in its confirmation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ACTIONS, acceptAction, explain } from '../public/assets/js/action-help.js';
import { groupSuggestions } from '../public/assets/js/consolidation-model.js';

const VIEWS = fs.readdirSync('public/assets/js/views').map((f) => `public/assets/js/views/${f}`);
const source = (f) => fs.readFileSync(f, 'utf8');

test('every action says what it changes and what it leaves, in full sentences', () => {
  for (const [id, a] of Object.entries(ACTIONS)) {
    assert.match(a.changes, /^[A-Z].*\.$/s, `${id}: changes`);
    assert.match(a.keeps, /^[A-Z].*\.$/s, `${id}: keeps`);
  }
  assert.equal(explain('fact.retract'), `${ACTIONS['fact.retract'].changes} Unchanged: ${ACTIONS['fact.retract'].keeps}`);
  assert.equal(explain('nothing'), '');
});

test('the views name only actions that exist', () => {
  for (const f of VIEWS) {
    for (const m of source(f).matchAll(/explain\('([\w.]+)'\)/g)) assert.ok(ACTIONS[m[1]], `${f}: ${m[1]}`);
  }
});

test('accepting a consolidation proposal says what its kind does, for every kind', () => {
  const kinds = ['same', 'depends', 'kind', 'question', 'topics', 'cite', 'progress', 'notation'];
  for (const k of kinds) assert.equal(acceptAction(k), `cons.accept.${k}`, k);
  const groups = groupSuggestions(kinds.map((kind, i) => ({ id: i + 1, kind, status: 'proposed' })));
  for (const g of groups) assert.ok(ACTIONS[acceptAction(g.kind)], g.kind);
  const view = source('public/assets/js/views/consolidation.js');
  assert.match(view, /class="action-help small"><b>Accept:<\/b> \{\{ ACTIONS\[acceptAction\(g\.kind\)\]\.changes \}\}/, 'beside each group');
  assert.match(view, /For each one: \$\{explain\(/, 'in the confirmation of Accept all and Reject all');
});

test('the actions people confuse say how they differ', () => {
  assert.match(ACTIONS['fact.deny'].keeps, /stays in the database/);
  assert.match(ACTIONS['fact.retract'].changes, /for everyone/);
  const facts = source('public/assets/js/views/facts.js');
  for (const id of ['fact.retract', 'fact.deny', 'fact.sameMeaning', 'fact.notSame', 'fact.link', 'proof.gap']) assert.ok(facts.includes(`explain('${id}')`), id);
  assert.match(facts, /Retracting withdraws the fact for every member, not only for you/);
  assert.match(facts, /unlike <b>Retract<\/b>/);
  assert.match(source('public/assets/js/main.js'), /globalProperties\.explain = explain/);
});
