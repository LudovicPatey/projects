// The switches of the Work page of the client keep every kind of work.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync('client/oq.py', 'utf8');
const KINDS = JSON.parse(source.match(/^KINDS = (\[.*\])$/m)[1]);
const handler = source.match(/if\(t\.dataset\.k\)\{(draft\.kinds=.*?)\}if\('danus'/)[1];
const toggle = (checked, changed) => {
  const boxes = KINDS.map((k) => ({ checked: k === changed ? !checked.includes(k) : checked.includes(k), dataset: { k }, blur() {} }));
  const draft = { kinds: [...checked] };
  new Function('t', 'draft', 'document', 'render', handler)(boxes.find((b) => b.dataset.k === changed), draft, { querySelectorAll: () => boxes }, () => {});
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

// Each AI's tab of the Work page shows its own models only, and names what "Automatic" means for it.
const grab = (name) => source.match(new RegExp(`^const ${name}=.*;$`, 'm'))[0];
const labels = new Function('S', `${grab('toolName')}\n${grab('short')}\n${grab('autoLabel')}\nreturn autoLabel;`);

test('"Automatic" names the model it stands for, for Claude and for ChatGPT', () => {
  const S = { models: { auto: { claude: { review: 'opus' }, codex: {} }, codex_auto: 'gpt-6-astra', danus_tool: 'codex', danus_default: null,
    suggest: { claude: [{ id: 'opus', label: 'Opus (latest)' }], codex: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] } } };
  const autoLabel = labels(S);
  assert.equal(autoLabel('claude', 'review'), 'Automatic · Opus');
  assert.equal(autoLabel('codex', 'review'), 'Automatic · GPT-6-Astra', 'the model set for ChatGPT, not "your default"');
  assert.equal(autoLabel('codex', 'danus'), 'Automatic · GPT-6-Astra');
  S.models.codex_auto = null;
  assert.equal(autoLabel('codex', 'extract'), 'Automatic · your ChatGPT default');
});

test('each tab offers its own AI’s models, and Proof search only under the AI it runs on', () => {
  assert.match(source, /workRow=\(k,l,d,p\)=>.*pickModel\(k,mv\(p,k\),S\.models\.suggest\[p\]/, 'work rows: the tab’s list');
  assert.match(source, /x\.runnable\?pickModel\(x\.id,mv\(p,x\.id\),S\.models\.suggest\[p\]/, 'platform procedures: the tab’s list');
  assert.match(source, /g==='Proving'&&\(!both\|\|p===S\.models\.danus_tool\)\?danusRow\(\)/);
  assert.match(source, /Here only the models that check its work are used/, 'the other AI’s tab says which rows it serves');
});

test('a section the user opens stays open: the page is drawn again every few seconds', () => {
  const sections = source.match(/<details[^>]*>/g) || [];
  assert.ok(sections.length, 'the Limits page has its Advanced section');
  for (const d of sections) assert.match(d, /data-keep=[\w-]+ \$\{OPEN\.has\('[\w-]+'\)\?'open':''\}/, `remembered: ${d}`);
  assert.match(source, /document\.addEventListener\('toggle',ev=>\{const d=ev\.target;if\(d\?\.dataset\?\.keep\)/);
});

// Stop lets the task under way finish: the page says so at once, with the button disabled, instead of seeming to ignore the click.
test('Stop shows "Stopping" until the task under way is done', () => {
  const hero = source.match(/^const hero=\(\)=>\{[\s\S]*?^ return`<section class="panel hero"><span class=dot><\/span><div><b>Not running[^\n]*$/m)[0];
  const draw = (S) => new Function('S', 'e', 'toolName', 'when', `${hero}\nreturn hero();`)(S, (x) => String(x), (x) => x, (x) => x);
  const busy = draw({ connected: true, running: true, allowed: true, stopping: true, provider: 'claude' });
  assert.match(busy, /<b>Stopping<\/b>/); assert.match(busy, /<button class=btn disabled[^>]*>Stopping…<\/button>/); assert.match(busy, /task under way finishes first/);
  assert.match(draw({ connected: true, running: true, allowed: true, stopping: false, provider: 'claude' }), /data-a=stop>Stop</);
  assert.match(source, /if\(x==='stop'\)\{S\.stopping=true;render\(\);call\('\/api\/stop'\)\}/, 'the click shows it before the client answers');
  assert.match(source, /"stopping": self\.running\(\) and self\.stop_flag\.is_set\(\)/);
});
