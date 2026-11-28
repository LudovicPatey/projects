// A file's description is often its abstract, pasted with the paper's own macros (\msf{RCA}_0) and cross-references (\ref{...}).
// It renders with the macros its LaTeX source defines, and without the references, in the file page and in the card of a citation.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { startApp } from './harness.mjs';
import { COMMON_MACROS } from '../public/assets/js/bare-tex.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const TEX = '\\documentclass{article}\n\\newcommand{\\msf}{\\mathsf} % sans serif\n\\def\\HT{\\msf{HT}}\n\\newcommand{\\pair}[2]{\\langle #1,#2\\rangle}\n\\DeclareMathOperator{\\Th}{Th}\n\\begin{document}x\\end{document}\n';
const ABSTRACT = 'It is shown that over $\\msf{RCA}_0$, Left match implies Full match (Lemma \\ref{HTmatchlem1}). Then it is shown that Left match implies $\\msf{ACA}$ (Theorem~\\ref{HTmatchth1}).';
let app; let ann;
before(async () => { app = await startApp(); ann = await app.signIn('0000-0002-1825-0097'); });
after(() => app?.stop());

test('a description renders with the macros of its file and without the paper\'s references', async () => {
  const pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Macros', question_html: '<p>Q</p>' })).data.id;
  const f = new FormData();
  f.set('title', 'On Complexity of Left match and Full match'); f.set('origin', 'human'); f.set('description', ABSTRACT);
  f.set('pdf', new Blob([PDF], { type: 'application/pdf' }), 'p.pdf'); f.append('sources[]', new Blob([TEX], { type: 'text/plain' }), 'main.tex');
  const doc = await (await fetch(`${app.base}/api/projects/${pid}/documents`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf, Accept: 'application/json' }, body: f })).json();
  const d = (await app.call(ann, 'GET', `/api/documents/${doc.id}`)).data;
  assert.deepEqual(d.tex_macros, { '\\msf': '\\mathsf', '\\HT': '\\msf{HT}', '\\pair': '\\langle #1,#2\\rangle', '\\Th': '\\operatorname{Th}' });
  assert.equal(d.description_shown, 'It is shown that over $\\msf{RCA}_0$, Left match implies Full match. Then it is shown that Left match implies $\\msf{ACA}$.');
  const item = (await app.call(ann, 'GET', `/api/projects/${pid}/refs/resolve?keys=document:${doc.id}`)).data.refs[`document:${doc.id}`];
  assert.equal(item.tex_macros['\\msf'], '\\mathsf');
  assert.doesNotMatch(item.excerpt, /\\ref/);
});

test('a paper uploaded as a PDF alone keeps its common shorthands readable', () => {
  // The live file "On Complexity of Left match and Full match" has no LaTeX source: \\msf showed in red.
  assert.equal(COMMON_MACROS['\\msf'], '\\mathsf{#1}');
  for (const m of ['\\mrm', '\\mbb', '\\mcal', '\\mbf']) assert.ok(COMMON_MACROS[m], m);
});

test('formulas written by agents reach KaTeX as written, and older damage is repaired', async () => {
  const pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Stars', question_html: '<p>Q</p>' })).data.id;
  const key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const proof = 'Let $j^*=\\max E$ and $s=\\sum_{j\\in E\\setminus\\{j^*\\}}b_j\\in\\Sigma_{j^*}$. Then $V_i^*\\subseteq W^*$, *really*, with $a_{**}$ and \\$5.';
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'gpt-5.6-sol', facts: [{ ref: 'a', title: 'Stars', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S $x^*$ and $y^*$.', proof_text: proof }] });
  const f = (await app.call(ann, 'GET', `/api/facts/${r.data.created[0].id}`)).data;
  assert.match(f.proof_html, /\\{j\^\*\\\}\}b_j\\in\\Sigma_\{j\^\*\}\$/);
  assert.match(f.proof_html, /<em>really<\/em>/, 'text outside formulas keeps its markup');
  for (const m of ['$V_i^*\\subseteq W^*$', '$a_{**}$', '\\$5']) assert.ok(f.proof_html.includes(m), m);
  assert.ok(f.statement_html.includes('$x^*$ and $y^*$'));
  const fix = (html) => execFileSync('php', ['-r', 'require "src/Db.php"; require "src/Sanitizer.php"; echo App\\Sanitizer::unmarkMath($argv[1]);', html], { encoding: 'utf8' });
  assert.equal(fix('<p>$s=\\{j^<em>\\}\\in\\Sigma_{j^</em>}$ and <em>word</em> $a^<strong>$</p>'), '<p>$s=\\{j^*\\}\\in\\Sigma_{j^*}$ and <em>word</em> $a^**$</p>');
  assert.equal(fix('<p>$V^<em>\\subseteq W^</em>$</p>'), '<p>$V^*\\subseteq W^*$</p>');
});
