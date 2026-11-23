// The reading view of a fact changes the layout and never the mathematics.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { factTitle, formatFactHtml, parseExternalRefs, texLine } from '../public/assets/js/fact-format.js';

const STATEMENT = '<p>Conventions. FIN is the set of nonempty finite subsets of ω. An infinite block sequence is Y=(y_i)_{i∈ω} with y_i&lt;y_{i+1}.<br>- F left-matches Y if for every q there is p with f(p∪q)=f(p);<br>- F full-matches Y.<br>Every full-match is a left-match.</p><p>Theorem.<br>(a) For every f:FIN→{0,1} there are F and Y.<br>(b) For every integer K≥1 there is an A-computable f.<br>Consequently no F works.</p>';
const PROOF = '<p>PROOF OF (a). Suppose (a) fails. Put<br>N_n = 2^{K+1}(n+2K+3), δ = 2^{-K}/(4K)<br>Let q_{n+1} be the first such q, and<br>(1) f(p∪q_{n+1})=1-f(p) for all n.</p><p>Claim: for all k≥1, f(y_i^n)=0.</p><p>Proof of the Layer Lemma. If there are no pairs, any g works.</p><p>(i) Injectivity. The map is injective.</p><p>Activation. Say R_n is active.</p>';

const formulas = (h) => [...h.matchAll(/class="ff-math">\$([\s\S]*?)\$<\/span>/g)].map((m) => m[1]);

test('the reading view adds structure and typesets formulas in LaTeX', () => {
  const s = formatFactHtml(STATEMENT);
  assert.match(s, /<h5 class="ff-head">Conventions\.<\/h5>/); assert.match(s, /<h5 class="ff-head">Theorem\.<\/h5>/);
  assert.match(s, /ff-label">\(a\)/); assert.match(s, /ff-label">-/);
  const texS = formulas(s);
  assert.ok(texS.includes('Y=(y_{i})_{i\\in \\omega }'), texS.join(' | ')); assert.ok(texS.some((t) => t.includes('f:\\mathrm{FIN}\\to \\{ 0,1\\} ')));
  const p = formatFactHtml(PROOF); const tex = formulas(p);
  assert.match(p, /<h5 class="ff-head">PROOF OF \(a\)\.<\/h5>/); assert.match(p, /<h5 class="ff-head">Proof of the Layer Lemma\.<\/h5>/);
  assert.match(p, /ff-eq"><span class="ff-label">\(1\)/); assert.match(p, /<b class="ff-lead">Claim:<\/b>/); assert.match(p, /<b class="ff-lead">Injectivity\.<\/b>/);
  assert.ok(tex.some((t) => t.startsWith('N_{n} = 2^{K+1}(n+2K+3)')), tex.join(' | '));
  assert.ok(tex.includes('q_{n+1}'), tex.join(' | ')); assert.ok(tex.includes('f(y_{i}^{n})=0'), tex.join(' | '));
});

test('a formula that cannot be converted exactly stays as written', () => {
  for (const bad of ['x_i_j', 'x_', 'a=b%c', 'f(x}={y']) assert.ok(!formatFactHtml(`<p>Then ${bad} holds.</p>`).includes('ff-math">$' + bad), bad);
  assert.ok(formatFactHtml('<p>Then x_i_j holds.</p>').includes('x_i_j'));
});

test('labels, prose and the article "a" are not typeset', () => {
  const out = formatFactHtml('<p>By (H) and (a), a finite set is a good choice. A set works.</p>');
  assert.equal(formulas(out).length, 0);
  assert.deepEqual(formulas(formatFactHtml('<p>The set A is (f⊕X)-computable.</p>')), ['A', '(f\\oplus X)']);
});

test('titles get their formulas in LaTeX', () => {
  assert.equal(texLine('For every f:FIN→{0,1} there is…'), 'For every $f:\\mathrm{FIN}\\to \\{ 0,1\\} $ there is…');
});

test('LaTeX, code, citations and ordinary words are left alone', () => {
  const html = '<p>See $x_i^2$ and \\(y_{n}\\), <code>a_b</code>, <span class="mention" data-id="1">@q_1</span>, left-matches and t_i.</p>';
  const out = formatFactHtml(html);
  for (const x of ['$x_i^2$', '\\(y_{n}\\)', '<code>a_b</code>', '@q_1', 'left-matches']) assert.ok(out.includes(x), x);
  assert.deepEqual(formulas(out), ['t_{i}']);
});

test('rich text with its own structure, and empty text, are not touched', () => {
  const list = '<ul><li>one</li></ul>';
  assert.equal(formatFactHtml(list), list); assert.equal(formatFactHtml(''), ''); assert.equal(formatFactHtml(null), '');
  assert.equal(formatFactHtml('plain text'), 'plain text');
});

test('a title cut from the statement shows the main result, and a real title is kept', () => {
  const text = 'Conventions. FIN is the set of nonempty finite subsets of ω, identified with ω through a fixed bijection.\nTheorem.\n(a) For every f and every infinite block sequence X, there are a finite F and an infinite block sequence Y, computable from f and X, with F<Y.';
  const shown = factTitle(text.slice(0, 90), text);
  assert.match(shown, /^Theorem\. \(a\) For every f/); assert.ok(shown.endsWith('…') && shown.length <= 121);
  assert.equal(factTitle('Carlson theorem', text), 'Carlson theorem');
  assert.equal(factTitle('A precise title that is long enough to look like a full sentence of a theorem', text), 'A precise title that is long enough to look like a full sentence of a theorem');
  assert.match(factTitle(text.slice(0, 90), `<p>${text.replace('\n', '<br>').replace('F&lt;', 'F<')}</p>`, true), /^Theorem/);
});

test('references cut at commas by older imports are put back together', () => {
  const stored = ['{"key": "AS-LLL"', 'authors": ["Alon', '"Spencer"]', 'title": "The Probabilistic Method', '"year": 2016', '"cited_for": "Lovász Local Lemma', 'general case (Lemma 5.1.1)"}',
    '{"key": "CarlsonRM"', 'title": "The reverse mathematics of Carlson\'s theorem for located words', 'arxiv": "2208.03152', '"cited_for": "Definition 3.4', 'the half-match and full-match terminology"}'];
  const [a, b] = parseExternalRefs(stored);
  assert.deepEqual([a.key, a.authors, a.title, a.year, a.citedFor], ['AS-LLL', 'Alon, Spencer', 'The Probabilistic Method', '2016', 'Lovász Local Lemma, general case (Lemma 5.1.1)']);
  assert.equal(b.link.href, 'https://arxiv.org/abs/2208.03152'); assert.equal(b.citedFor, 'Definition 3.4, the half-match and full-match terminology');
});

test('references never produce an unsafe link, and unreadable ones stay visible', () => {
  assert.equal(parseExternalRefs([{ title: 'x', url: 'javascript:alert(1)', arxiv: '"><img', doi: 'nope' }])[0].link, null);
  assert.equal(parseExternalRefs([{ doi: 'https://doi.org/10.1000/xyz' }])[0].link.href, 'https://doi.org/10.1000/xyz');
  assert.deepEqual(parseExternalRefs(['{broken']), [{ raw: '{broken' }]);
  assert.deepEqual(parseExternalRefs(null), []);
});

test('the client reads Danus references as JSON, commas included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-refs-')); const f = path.join(dir, 'abcdabcdabcdabcd.md');
  try {
    const refs = [{ key: 'K', authors: ['Alon', 'Spencer'], title: 'A, B', cited_for: 'Lemma 2.1, statement' }];
    fs.writeFileSync(f, `---\nfact_id: abcdabcdabcdabcd\npredecessors: [1111111111111111, 2222222222222222]\nglossary_introduces: {}\nexternal_refs: ${JSON.stringify(refs)}\n---\n\n## statement\nS\n\n## proof\nP\n`);
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
r = oq.parse_danus(pathlib.Path(sys.argv[2])); print(json.dumps([r["external_refs"], r["predecessors"]]))
`, path.resolve('client/oq.py'), f], { env: { ...process.env, OQ_CONFIG_DIR: path.join(dir, 'c') }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), [refs, ['1111111111111111', '2222222222222222']]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
