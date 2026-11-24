// Dropdowns keep one look everywhere, and the in-browser layout auditor stays usable (AGENTS.md, "Visual check").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const appCss = fs.readFileSync('public/assets/css/app.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const clientCss = (fs.readFileSync('client/oq.py', 'utf8').match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const rules = (css) => [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const targetsSelect = (selector) => selector.split(',').some((s) => /(^|[\s>+~])select(?![-\w])|\.version-select\b/.test(s.trim()) && !/::?selection/.test(s));
const rightPadding = (value) => {
  const v = value.trim().split(/\s+/).map((x) => parseFloat(x));
  return v.length === 1 ? v[0] : v[1];
};

for (const [where, css] of [['platform', appCss], ['AI client', clientCss]]) {
  test(`${where}: every dropdown has the custom arrow`, () => {
    const base = rules(css).filter((r) => /(^|,)\s*select\s*(,|$)/.test(r.selector) && /appearance\s*:\s*none/.test(r.body));
    assert.ok(base.some((r) => /padding(-right)?\s*:/.test(r.body)), 'the base select rule sets the room for the arrow');
    assert.ok(base.length, `the ${where} needs a base select rule with appearance: none`);
    assert.ok(base.some((r) => /background(-image)?\s*:[^;]*svg/.test(r.body)), 'the base select rule draws the arrow');
  });

  test(`${where}: no rule removes the arrow or lets text run under it`, () => {
    // A rule shared with text fields sets their padding: the dedicated select rule after it must restore the arrow's room.
    const shared = (sel) => /\b(input|textarea)\b/.test(sel);
    for (const r of rules(css).filter((x) => targetsSelect(x.selector) && !shared(x.selector))) {
      for (const [, prop, value] of r.body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
        if (prop === 'background' && !/svg/.test(value)) assert.fail(`${r.selector}: "background:" erases the arrow, use background-color`);
        if (prop === 'appearance' && value.trim() !== 'none') assert.fail(`${r.selector}: appearance must stay none`);
        if (prop === 'padding' && rightPadding(value) < 20) assert.fail(`${r.selector}: padding-right ${rightPadding(value)}px leaves no room for the arrow`);
        if (prop === 'padding-right' && parseFloat(value) < 20) assert.fail(`${r.selector}: padding-right ${value} leaves no room for the arrow`);
      }
    }
  });
}

test('small dropdowns sit beside small buttons', () => {
  const sm = rules(appCss).find((r) => r.selector === 'select.sm');
  assert.ok(sm, 'select.sm exists');
  const views = fs.readdirSync('public/assets/js/views').map((f) => fs.readFileSync(`public/assets/js/views/${f}`, 'utf8')).join('\n');
  // A member card footer holds a role dropdown and a Remove or Leave button of the same height.
  assert.match(views, /<footer><select v-if="isOwner" class="sm"/);
  assert.doesNotMatch(views, /class="btn xs" @click="removeM/);
});

test('the layout auditor is valid and checks what AGENTS.md promises', () => {
  const code = fs.readFileSync('scripts/visual-audit.js', 'utf8');
  assert.doesNotThrow(() => new Function(code));
  for (const check of ['page is', 'squeezed text', 'off screen', 'native dropdown', 'dropdown without its arrow', 'run under its arrow', 'dropdown cuts', 'uneven row', 'menu outside the window']) assert.ok(code.includes(check), check);
  const agents = fs.readFileSync('AGENTS.md', 'utf8');
  assert.match(agents, /scripts\/visual-audit\.js/);
});
