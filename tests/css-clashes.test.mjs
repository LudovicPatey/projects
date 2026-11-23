// A class name must keep one meaning: same selector, one display; and no app style on the classes of KaTeX or Quill.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const css = fs.readFileSync('public/assets/css/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function rules(start = 0, end = css.length, media = '') {
  const out = []; let i = start;
  while (i < end) {
    const open = css.indexOf('{', i); if (open < 0 || open >= end) break;
    let depth = 1; let j = open + 1;
    while (j < end && depth) { if (css[j] === '{') depth += 1; else if (css[j] === '}') depth -= 1; j += 1; }
    const selector = css.slice(i, open).trim();
    if (selector.startsWith('@media') || selector.startsWith('@supports')) out.push(...rules(open + 1, j - 1, media + selector));
    else if (!selector.startsWith('@')) for (const s of selector.split(/,(?![^()]*\))/)) out.push({ selector: s.trim().replace(/\s+/g, ' '), media, body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

test('a selector never changes its display in a later rule', () => {
  const seen = new Map(); const clashes = [];
  for (const r of rules()) {
    const display = r.body.match(/(?:^|;)\s*display:\s*([^;]+)/)?.[1].replace('!important', '').trim();
    if (!display) continue;
    const key = `${r.media}|${r.selector}`;
    if (seen.has(key) && seen.get(key) !== display) clashes.push(`${r.selector}: ${seen.get(key)} / ${display}`);
    seen.set(key, display);
  }
  assert.deepEqual(clashes, []);
});

test('the classes of KaTeX are not styled as app components', () => {
  const katex = ['base', 'strut', 'mord', 'mop', 'mbin', 'mrel', 'mopen', 'mclose', 'vlist', 'frac', 'sqrt', 'accent', 'root', 'text', 'rule', 'sizing', 'overlay'];
  const bare = new Set(rules().map((r) => r.selector));
  assert.deepEqual(katex.filter((c) => bare.has(`.${c}`)), []);
  assert.match(css, /\.katex \.tag \{ display: block !important;/, 'the app badge .tag is undone inside equations');
});

test('the editor does not cover what follows it', () => {
  assert.match(css, /\.rte \.ql-container\.ql-snow \{ height: auto;/);
});

test('long tabs scroll instead of widening the page', () => {
  assert.match(css, /\.tabs \{[^}]*overflow-x: auto/);
  assert.match(css, /\.tabs > \* \{ flex: none;/);
});

test('the AI label class is used by one component', () => {
  assert.doesNotMatch(fs.readFileSync('public/assets/js/views/ai.js', 'utf8'), /class="ai-meta"/);
});
