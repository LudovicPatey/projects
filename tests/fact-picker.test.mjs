// Choosing a fact among hundreds: a searchable picker replaces every dropdown that listed all facts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { words, score, searchFacts, allowed, asksServer, serverIds, describe, countLine, moveActive, placeList, SHOWN } from '../public/assets/js/fact-picker-model.js';

const facts = [
  { id: 1, label: 'thm:main', title: 'Every $\\mathcal{F}$-sunflower of size $k$ contains a core', kind: 'theorem', status: 'human_checked', statement_text: 'Let $\\mathcal F$ be a family.' },
  { id: 2, label: 'lem:2.3', title: 'A bound for block sequences', kind: 'lemma', status: 'unchecked', statement_text: 'For every $X \\leq Y$ the Ramsey property holds.' },
  { id: 3, label: 'lem:2.30', title: 'Hindman for finite unions', kind: 'lemma', status: 'ai_checked', statement_text: '', basis: 'cited' },
  { id: 4, label: 'def:fs', title: 'Finite sums', kind: 'definition', status: 'definition', statement_text: '$\\mathrm{FS}(X)$ is the set of finite sums.' },
  { id: 5, label: 'lem:old', title: 'A withdrawn sunflower bound', kind: 'lemma', status: 'retracted', retracted_at: '2026-01-01', statement_text: '' },
];

test('words read LaTeX commands and braces as separators, without case or accent', () => {
  assert.deepEqual(words('Every $\\mathcal{F}$-sunflower'), ['every', 'mathcal', 'f', 'sunflower']);
  assert.deepEqual(words('Théorème de Hindman'), ['theoreme', 'de', 'hindman']);
  assert.deepEqual(words('lem:2.3'), ['lem:2.3'], 'a label stays one word');
  assert.deepEqual(words('holds.'), ['holds'], 'punctuation around a word is not part of it');
});

test('a search matches the label, the title, the kind and the statement, best first', () => {
  const ids = (q, o) => searchFacts(facts, q, o).items.map((f) => f.id);
  assert.deepEqual(ids('lem:2.3'), [2, 3], 'the exact label first, then the labels that start with it');
  assert.deepEqual(ids('sunflower'), [1], 'retracted facts are left out');
  assert.deepEqual(ids('ramsey'), [2], 'words of the statement');
  assert.deepEqual(ids('definition'), [4], 'the kind');
  assert.deepEqual(ids('HINDMAN unions'), [3], 'every term must appear, in any case');
  assert.deepEqual(ids('hindman sunflower'), []);
  assert.deepEqual(ids('fin'), [3, 4], 'a term matches the start of a word');
  assert.deepEqual(ids('2.3'), [2, 3], 'part of a label');
  assert.equal(score(facts[0], ['core']), 2, 'in the title');
  assert.equal(score(facts[0], ['family']), 3, 'only in the statement');
});

test('an empty query offers every fact in the caller\'s order', () => {
  const r = searchFacts([facts[3], facts[0], facts[1]], '');
  assert.deepEqual(r.items.map((f) => f.id), [4, 1, 2]);
  assert.equal(r.total, 3);
  assert.equal(r.more, false);
});

test('excluded, filtered and retracted facts cannot be chosen', () => {
  assert.equal(allowed(facts[0], { exclude: [1] }), false, 'the fact itself');
  assert.equal(allowed(facts[4]), false, 'retracted');
  assert.equal(allowed(facts[4], { withRetracted: true }), true);
  assert.equal(allowed(facts[1], { filter: (f) => f.basis === 'cited' }), false);
  assert.deepEqual(searchFacts(facts, '', { exclude: [1, 2] }).items.map((f) => f.id), [3, 4]);
  assert.equal(searchFacts(facts, '', { exclude: [1, 2] }).of, 2, 'counts only what can be chosen');
});

test('the server\'s matches in the whole statements come after the local ones, never twice and never excluded', () => {
  const r = searchFacts(facts, 'core', { found: [4, 1, 5, 99], exclude: [] });
  assert.deepEqual(r.items.map((f) => f.id), [1, 4], 'the local match first; retracted and unknown ids left out');
  assert.deepEqual(searchFacts(facts, 'core', { found: [4], exclude: [4] }).items.map((f) => f.id), [1]);
  assert.deepEqual(serverIds([{ type: 'fact', id: 4, state: 'ok' }, { type: 'question', id: 7 }, { type: 'fact', id: 8, state: 'missing' }]), [4]);
  assert.equal(asksServer('a'), false, 'one letter is not worth a request');
  assert.equal(asksServer('ab'), true);
});

test('hundreds of facts are shown a page at a time, and the count says how to narrow them', () => {
  const many = Array.from({ length: 240 }, (_, i) => ({ id: i + 1, label: `lem:${i + 1}`, title: `Lemma about $x_{${i}}$`, kind: 'lemma', status: 'unchecked' }));
  const r = searchFacts(many, '');
  assert.equal(r.items.length, SHOWN);
  assert.equal(r.total, 240);
  assert.ok(r.more);
  assert.match(countLine(r, ''), /^40 of 240 facts shown: type more words/);
  assert.equal(countLine(searchFacts(many, 'lem:17'), 'lem:17'), '11 matching facts.');
  assert.match(countLine(searchFacts(many, 'zzz'), 'zzz'), /^No fact matches “zzz”/);
  assert.equal(countLine(searchFacts([], ''), ''), 'No fact to choose from yet.');
});

test('each result says its title, kind, label and state, the state with its word', () => {
  const d = describe(facts[2]);
  assert.equal(d.title, 'Hindman for finite unions');
  assert.equal(d.kind, 'Lemma');
  assert.equal(d.label, 'lem:2.30');
  assert.equal(d.cited, true);
  assert.equal(d.status.word, 'AI-checked');
  assert.match(d.status.title, /no person has yet/);
  assert.equal(describe({ id: 9 }).title, 'Fact #9', 'a fact not loaded yet still says something');
});

test('the keyboard moves through the list and wraps around', () => {
  assert.equal(moveActive(-1, 'ArrowDown', 3), 0);
  assert.equal(moveActive(2, 'ArrowDown', 3), 0);
  assert.equal(moveActive(-1, 'ArrowUp', 3), 2);
  assert.equal(moveActive(0, 'ArrowUp', 3), 2);
  assert.equal(moveActive(1, 'Home', 3), 0);
  assert.equal(moveActive(0, 'End', 3), 2);
  assert.equal(moveActive(5, 'x', 3), 2, 'a shorter list keeps the row inside it');
  assert.equal(moveActive(0, 'ArrowDown', 0), -1);
});

test('the list opens inside the window: below the field, or above near the bottom, never wider than a phone', () => {
  const win = { width: 1440, height: 900 };
  const below = placeList({ left: 100, top: 200, bottom: 236, width: 400 }, win);
  assert.deepEqual([below.left, below.width, below.top], [100, 400, 240]);
  const above = placeList({ left: 100, top: 800, bottom: 836, width: 400 }, win);
  assert.equal(above.top, undefined);
  assert.equal(above.bottom, 104);
  const phone = placeList({ left: 30, top: 100, bottom: 136, width: 120 }, { width: 375, height: 700 });
  assert.ok(phone.left >= 8 && phone.left + phone.width <= 375 - 8, 'inside the window with a margin');
  assert.ok(phone.width >= 300, 'wide enough to read a title on a narrow field');
  assert.ok(phone.maxHeight >= 120);
  const beside = placeList({ left: 110, top: 100, bottom: 136, width: 120 }, { width: 375, height: 700 }, { area: { left: 96, right: 375 } });
  assert.ok(beside.left >= 104 && beside.left + beside.width <= 367, 'inside the main area, not over the side rail');
});

test('no dropdown lists every fact: each fact choice uses the picker and says what it changes', () => {
  const dir = new URL('../public/assets/js/views/', import.meta.url);
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/<select[\s\S]*?<\/select>/g)) {
      assert.doesNotMatch(m[0], /v-for="\w+ in (facts|factOptions|definitions|mentionables\.facts)"|basis === 'cited'|\{\{ f\.label \}\}/, `${file}: a fact dropdown remains`);
    }
    for (const m of src.matchAll(/<fact-picker\b[^>]*>/g)) assert.match(m[0], /\b:?effect=|:clearable="false"/, `${file}: the choice says what it changes`);
  }
  const common = fs.readFileSync(new URL('../public/assets/js/components.js', import.meta.url), 'utf8');
  assert.match(common, /app\.component\('fact-picker', FactPicker\)/);
  const help = fs.readFileSync(new URL('../public/assets/js/help/content.js', import.meta.url), 'utf8');
  assert.match(help, /Choosing a fact/, 'the help says how to choose a fact');
});
