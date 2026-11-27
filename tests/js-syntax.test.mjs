// Every module of the interface parses: one stray quote in a help text leaves the whole app blank, and no other test loads every
// module the way the browser does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);

/** The text of the backtick strings of a module, where its Vue templates are written. */
function templateStrings(src) {
  const out = []; let inside = false; let depth = 0; let cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!inside) { if (c === '`' && src[i - 1] !== '\\') { inside = true; cur = ''; } continue; }
    // Inside ${...} is JavaScript, where \' is a correct escape: only the template's own text is looked at.
    if (depth) { if (c === '{') depth++; else if (c === '}') depth--; continue; }
    if (c === '\\') { cur += c + src[i + 1]; i++; continue; }
    if (c === '$' && src[i + 1] === '{') { depth = 1; i++; continue; }
    if (c === '`') { inside = false; out.push(cur); continue; }
    cur += c;
  }
  return out;
}

test('no template escapes a quote: \\\' inside a backtick string becomes a bare quote that ends a Vue expression early', () => {
  const bad = files('public/assets/js').filter((f) => templateStrings(fs.readFileSync(f, 'utf8')).some((t) => t.includes("\\'") && /[:@]\w+="[^"]*\\'/.test(t)));
  assert.deepEqual(bad, [], 'write ’ or use other quotes');
});

/** The template text of each backtick string, as the browser sees it: escapes resolved, ${…} left out. */
function templatesAsRendered(src) {
  return templateStrings(src).map((t) => t.replace(/\\(n|t|\\|`|'|"|\$)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c)));
}

test('every expression of every template compiles: one that does not leaves its whole page blank', () => {
  const bad = [];
  const check = (f, e) => {
    if (!e.trim()) return;
    try { new Function(`return (${e})`); } catch { try { new Function(e); } catch (err) { bad.push(`${f}: ${err.message}: ${e.slice(0, 120)}`); } }
  };
  for (const f of files('public/assets/js')) {
    for (const t of templatesAsRendered(fs.readFileSync(f, 'utf8'))) {
      if (!/<[a-z]/i.test(t)) continue; // not a template
      // Bound attributes and events; v-for, v-slot and #slots have their own syntax.
      for (const m of t.matchAll(/\s(?::|@|v-(?!for|slot)[\w-]+)[\w.:-]*(?:\[[^\]]*\])?="([^"]*)"/g)) check(f, m[1]);
      for (const m of t.matchAll(/\{\{([\s\S]*?)\}\}/g)) check(f, m[1]);
    }
  }
  assert.deepEqual(bad, []);
});

test('every interface module parses', () => {
  const broken = files('public/assets/js').filter((f) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status !== 0);
  assert.deepEqual(broken, []);
});

test('no component defines the same option twice: the later one silently replaces the earlier, as a second created() did', () => {
  const twice = [];
  for (const f of files('public/assets/js')) {
    for (const block of fs.readFileSync(f, 'utf8').split(/\n(?:export )?const \w+ = \{\n/).slice(1)) {
      const body = block.split(/\n\};\n/)[0];
      const seen = new Map();
      for (const m of body.matchAll(/^  (created|mounted|unmounted|beforeUnmount|data|methods|computed|watch|props|emits|components|template)\b/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
      for (const [k, n] of seen) if (n > 1) twice.push(`${f}: ${k}`);
    }
  }
  assert.deepEqual(twice, []);
});
