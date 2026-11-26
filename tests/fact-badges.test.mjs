// A fact's card shows its state as icons that explain themselves on hover, and leaves out what almost every fact says.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { factBadges, quietLabels, statementAddsToTitle, STATUS_BADGE, PROOF_BADGE } from '../public/assets/js/fact-badges.js';
import { STATUS } from '../public/assets/js/factgraph.js';

test('each state, proof and provenance is an icon with its explanation', () => {
  const proved = factBadges({ status: 'unchecked', basis: 'proved', proof_origin: 'ai', ai_model: 'claude-opus-5-5', ai_user_name: 'Ann' });
  assert.deepEqual(proved.map((b) => [b.key, b.icon]), [['status', 'clock'], ['proof', 'sparkles'], ['model', 'bot']]);
  assert.match(proved[0].title, /^Unchecked: nobody reviewed it yet/);
  assert.equal(proved[2].title, 'Written by claude-opus-5-5 for Ann.', 'the exact model, on hover');
  const cited = factBadges({ status: 'source_confirmed', basis: 'cited', incomplete: false });
  assert.deepEqual(cited.map((b) => b.key), ['status', 'cited'], 'a cited result has no proof to describe');
  assert.ok(factBadges({ status: 'unchecked', basis: 'proved', incomplete: true, proof_origin: 'human' }).some((b) => b.key === 'outside'));
  for (const k of Object.keys(STATUS)) assert.ok(STATUS_BADGE[k], `every status has its icon: ${k}`);
  for (const b of [...Object.values(STATUS_BADGE), ...Object.values(PROOF_BADGE)]) assert.ok(b.title.length > b.label.length, 'the hover says more than the word');
});

test('the label "conclusion" is not shown; rarer labels are', () => {
  assert.deepEqual(quietLabels(['conclusion']), []);
  assert.deepEqual(quietLabels(['conclusion', 'counterexample']), ['counterexample']);
  const view = fs.readFileSync('public/assets/js/views/facts.js', 'utf8');
  assert.match(view, /<fact-badges :f="f"\/>/, 'the list shows the icons');
  assert.doesNotMatch(view, /<code class="key">\{\{ f\.label \}\}<\/code>/, 'and no key: the fact page has a Cite button');
  assert.match(view, /@click="cite"/);
});

test('the statement line is left out when it only repeats the title, and kept when it says more', () => {
  assert.equal(statementAddsToTitle('Hindman\'s theorem is provable in ACA_0^+', 'Hindman\'s theorem HT is provable in $\\mathsf{ACA}_0^+$.'), false);
  assert.equal(statementAddsToTitle('Half-matching dichotomy (RCA_0)', '($\\mathsf{RCA}_0$) Let $\\mathcal{S}$ be an IP set, let $\\mathcal{B}$ be finite, and let $c$ be a coloring of $NU(\\mathcal{S})$.'), true);
  assert.equal(statementAddsToTitle('Computable coloring with no c.e. monochromatic IP set', 'There is a computable $c:\\mathcal{P}_{fin}(\\mathbb{N})\\to\\{0,1\\}$ such that if $\\mathcal{S}$ is computably enumerable and generates an IP set, then it is not monochromatic.'), true);
  assert.match(fs.readFileSync('public/assets/js/views/facts.js', 'utf8'), /v-if="search\.trim\(\) \|\| statementAddsToTitle/, 'a search always shows it: it says why the fact matched');
});
