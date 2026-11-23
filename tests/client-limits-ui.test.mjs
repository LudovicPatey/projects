// The "What this computer may do" checkboxes of the client keep every kind of work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync('client/oq.py', 'utf8');
const KINDS = JSON.parse(source.match(/^KINDS = (\[.*\])$/m)[1]);
const handler = source.match(/if\(t\.dataset\.k\)\{(draft\.kinds=.*?)\}if\('danus'/)[1];
const toggle = (checked, changed) => {
  const boxes = KINDS.map((k) => ({ checked: k === changed ? !checked.includes(k) : checked.includes(k), dataset: { k } }));
  const draft = { kinds: [...checked] };
  new Function('t', 'draft', 'document', handler)(boxes.find((b) => b.dataset.k === changed), draft, { querySelectorAll: () => boxes });
  return draft.kinds;
};

test('every kind of work has a checkbox', () => {
  for (const k of KINDS) assert.ok(source.includes(`['${k}','`), k);
});

test('changing one checkbox keeps review and Lean', () => {
  assert.deepEqual(toggle(['extract', 'ask', 'bib', 'review', 'lean'], 'bib'), ['extract', 'ask', 'review', 'lean']);
  assert.deepEqual(toggle(['extract', 'review'], 'lean'), ['extract', 'review', 'lean']);
  assert.deepEqual(toggle(['extract', 'review', 'lean'], 'review'), ['extract', 'lean']);
});
