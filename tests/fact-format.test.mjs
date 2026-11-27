// The reading view of a fact changes the layout and never the mathematics.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { factTitle, formatFactHtml, kindCounts, kindOf, parseExternalRefs, texLine } from '../public/assets/js/fact-format.js';

const STATEMENT = '<p>Conventions. FIN is the set of nonempty finite subsets of ω. An infinite block sequence is Y=(y_i)_{i∈ω} with y_i&lt;y_{i+1}.<br>- F left-matches Y if for every q there is p with f(p∪q)=f(p);<br>- F full-matches Y.<br>Every full-match is a left-match.</p><p>Theorem.<br>(a) For every f:FIN→{0,1} there are F and Y.<br>(b) For every integer K≥1 there is an A-computable f.<br>Consequently no F works.</p>';
const PROOF = '<p>PROOF OF (a). Suppose (a) fails. Put<br>N_n = 2^{K+1}(n+2K+3), δ = 2^{-K}/(4K)<br>Let q_{n+1} be the first such q, and<br>(1) f(p∪q_{n+1})=1-f(p) for all n.</p><p>Claim: for all k≥1, f(y_i^n)=0.</p><p>Proof of the Layer Lemma. If there are no pairs, any g works.</p><p>(i) Injectivity. The map is injective.</p><p>Activation. Say R_n is active.</p>';

const formulas = (h) => [...h.matchAll(/class="ff-math">\$([\s\S]*?)\$<\/span>/g)].map((m) => m[1]);

test('the reading view adds structure and typesets formulas in LaTeX', () => {
  const s = formatFactHtml(STATEMENT);
  assert.match(s, /data-env="definition" data-title="Conventions"/); assert.match(s, /data-env="theorem" data-title="Theorem"/);
  assert.match(s, /ff-label">\(a\)/); assert.match(s, /ff-label">-/);
  const texS = formulas(s);
  assert.ok(texS.includes('Y=(y_{i})_{i\\in \\omega }'), texS.join(' | ')); assert.ok(texS.some((t) => t.includes('f:\\mathrm{FIN}\\to \\{ 0,1\\} ')));
  const p = formatFactHtml(PROOF); const tex = formulas(p);
  assert.match(p, /data-env="proof" data-title="PROOF OF \(a\)"/); assert.match(p, /data-env="proof" data-title="Proof of the Layer Lemma"/);
  assert.match(p, /ff-eq"><span class="ff-label">\(1\)/); assert.match(p, /data-env="claim" data-title="Claim"/); assert.match(p, /<b class="ff-lead">Injectivity\.<\/b>/);
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

const open = (h) => (h.match(/<section\b/g) || []).length; const shut = (h) => (h.match(/<\/section>/g) || []).length;
const envs = (h) => [...h.matchAll(/data-env="(\w+)" data-title="([^"]*)"/g)].map((m) => `${m[1]}:${m[2]}`);

test('a text reads as definitions, statements and proofs, with lemmas inside their proof', () => {
  const html = '<p>Definition. A set is good if it is nice.</p><p>Lemma 1. Every set is good.</p><p>Proof. Trivial.</p><p>Theorem 2. All is well.</p><p>PROOF OF (a). Start.</p><p>Layer Lemma: some g works.</p><p>Proof of the Layer Lemma. Take g.</p><p>Hence done.</p><p>PROOF OF (b). End.</p>';
  const out = formatFactHtml(html);
  assert.deepEqual(envs(out), ['definition:Definition', 'lemma:Lemma 1', 'proof:Proof', 'theorem:Theorem 2', 'proof:PROOF OF (a)', 'lemma:Layer Lemma', 'proof:Proof of the Layer Lemma', 'proof:PROOF OF (b)']);
  assert.equal(open(out), shut(out));
  const part = out.slice(out.indexOf('PROOF OF (a)'), out.indexOf('data-title="PROOF OF (b)"'));
  assert.ok(part.includes('Layer Lemma') && part.includes('Hence done'), 'the lemma and its proof stay in this part');
  const second = formatFactHtml('<p>Lemma 1. A holds.</p><p>Proof. Yes.</p><p>Lemma 2. B holds.</p><p>Proof. Yes.</p>');
  assert.deepEqual(envs(second), ['lemma:Lemma 1', 'proof:Proof', 'lemma:Lemma 2', 'proof:Proof']);
  assert.ok(second.indexOf('</section>', second.indexOf('data-title="Proof"')) < second.indexOf('Lemma 2'), 'a new lemma ends the previous proof');
});

test('a mention of a result inside a sentence does not start a block', () => {
  assert.deepEqual(envs(formatFactHtml('<p>By Theorem 3. we conclude, using the Lemma.</p>')), []);
});

test('facts are counted by the kind they display', () => {
  const facts = [{ kind: 'lemma', display_kind: 'theorem' }, { kind: 'lemma' }, { kind: 'definition' }, { kind: 'theorem' }];
  assert.equal(kindOf(facts[0]), 'theorem');
  assert.deepEqual(kindCounts(facts).map((k) => [k.key, k.n]), [['theorem', 2], ['lemma', 1], ['definition', 1]]);
});

test('a Danus fact shows the kind its text announces, and other kinds are never changed', () => {
  const php = `require 'src/FactKind.php'; use App\\FactKind as K;
  $c = [['lemma','danus',"Conventions. FIN is a set.\\nTheorem.\\n(a) Yes.",'theorem'],['lemma','danus','Definition. X is good.','definition'],['lemma','danus','Definition. X. Lemma 2. Y.','lemma'],['lemma','danus','Every set is good by Theorem 3.','lemma'],['theorem','danus','Lemma 1. Y.','theorem'],['lemma','oq-client','Theorem. Y.','lemma'],['lemma',null,'Theorem. Y.','lemma']];
  foreach ($c as [$k,$t,$s,$w]) if (K::of($k,$t,$s) !== $w) { echo "wrong: $s"; exit(1); }`;
  execFileSync('php', ['-r', php], { encoding: 'utf8' });
});

test('a preview is never cut inside a formula, so it still typesets', async () => {
  const { clipMath } = await import('../public/assets/js/fact-format.js');
  assert.equal(clipMath('short $x$', 220), 'short $x$');
  const long = 'Let $U$ be a semigroup and $\\{A_i\\}$ a sequence of sets. Then there are sequences $S = \\{s_i\\}$ such that $FS(\\{s_j\\}_{j\\ge i}) \\subseteq A_i$ for all $i$.';
  const c = clipMath(long, 120);
  assert.ok(c.endsWith('…')); assert.equal((c.match(/(?<!\\)\$/g) || []).length % 2, 0, c);
  assert.ok(!c.includes('FS('), 'the formula it would have cut is left out');
  assert.equal(clipMath('a cost of \\$5 and more words here', 12), 'a cost of…', 'an escaped dollar is text');
  assert.equal(clipMath('$$\\sum_i x_i$$ and then a long tail of words', 20), '$$\\sum_i x_i$$ and…');
});

test('titles that spell a Greek letter out read as that letter, and the hyphen of a system name stays a hyphen', () => {
  assert.equal(texLine("provable in Pi^1_1-CA_0"), 'provable in $\\Pi ^{1}_{1}\\text{-}\\mathrm{CA}_{0}$');
  assert.equal(texLine('Pi^1_infty-TI_0'), '$\\Pi ^{1}_{\\infty }\\text{-}\\mathrm{TI}_{0}$');
  assert.equal(texLine('over RCA_0 + ISigma^0_2'), 'over $\\mathrm{RCA}_{0} + \\mathrm{I}\\Sigma ^{0}_{2}$');
  assert.equal(texLine('ACA_0^+'), '$\\mathrm{ACA}_{0}^{+}$');
  assert.equal(texLine('Pi is a number'), 'Pi is a number', 'a word without a script is prose');
});

test('LaTeX a title already writes is left as it is', () => {
  assert.equal(texLine('Strong $\\Sigma^0_1$-bounding in $\\mathsf{RCA}_0$'), 'Strong $\\Sigma^0_1$-bounding in $\\mathsf{RCA}_0$');
});

test('lowercase letters spelled out in a formula, and scripts in parentheses, as live titles write them', () => {
  assert.equal(texLine('computable in alpha^(omega+1)'), 'computable in $\\alpha ^{(\\omega +1)}$');
  assert.equal(texLine('solution computable in the (omega+1)-st jump'), 'solution computable in the $(\\omega +1)$-st jump');
  assert.equal(texLine('a countable coded beta-model'), 'a countable coded $\\beta $-model');
  assert.equal(texLine('the alpha and omega of it'), 'the alpha and omega of it', 'prose keeps its words');
});
