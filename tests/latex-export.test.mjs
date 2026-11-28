// A proved fact whose chain is checked becomes a LaTeX article: its dependencies proved before use, cited results with their sources.
// An AI client with LaTeX compiles it; the platform adds the file, and only for the source it built.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key; let pid; let ids;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const claim = async () => (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'x', kinds: ['latex'], project_id: pid, features: ['latex'] })).data.task;
const ask = (id) => app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'latex', source_type: 'fact', source_id: id });
const send = (t, sha = t.context.latex.sha256) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/document`, { lease: t.lease, sha256: sha, pdf_base64: PDF.toString('base64'), ai_model: 'latex' });

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Matches & colorings', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  const bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { bibtex: '@article{hindman74, title={Finite sums from sequences within cells of a partition of N}, author={Hindman, Neil}, year={1974}, journal={J. Combin. Theory Ser. A}}' })).data.created[0];
  const facts = [
    { ref: 'h', title: "Hindman's theorem", kind: 'theorem', labels: ['conclusion'], method: 'extracted', statement_text: 'For every finite coloring of $\\mathbb N$ there is an infinite $X$ with $FS(X)$ homogeneous.', sources: [{ type: 'bib', id: bib.id ?? bib, page: 3, quote: 'finite sums', covers: 'statement' }] },
    { ref: 'a', title: 'Sums of 50% & more', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'For all $x ∈ X$, $x^* \\le 2$ and_text # 100% ~ safe.', proof_text: 'By **definition**, $x^*\\le 2$. Uses ℕ and λ in text.', depends_on: ['h'], glossary: { '$x^*$': 'the star of $x$' } },
    { ref: 'u', title: 'Unchecked', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'P.', depends_on: ['a'] },
  ];
  const made = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts });
  assert.ok(made.status < 300, JSON.stringify(made.data));
  ids = Object.fromEntries(made.data.created.map((c, i) => [facts[i].ref, c.id]));
  const main = { ref: 'b', title: 'Main result for $\\msf{RCA}_0$', kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: 'Every $X$ computes $\\emptyset\'$.', proof_text: `By @{fact:${ids.a}}, done.`, depends_on: [ids.a] };
  ids.b = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [main] })).data.created[0].id;
  for (const r of ['a', 'b']) assert.equal((await app.call(key, 'POST', `/api/facts/${ids[r]}/reviews`, { verdict: 'correct', body_text: 'Checked.', ai_model: 'gpt-5.6-sol' })).status, 201);
});
after(() => app?.stop());

test('only a proved fact whose chain is checked can be assembled', async () => {
  assert.match((await ask(ids.u)).data.error, /not checked yet/);
  assert.match((await ask(ids.h)).data.error, /cited from another work/);
  assert.equal((await app.call(key, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'latex', source_type: 'fact', source_id: ids.b })).status, 403, 'a person asks for it');
  assert.equal((await ask(ids.b)).status, 201);
  assert.equal((await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'old', ai_model: 'x', kinds: ['latex'], project_id: pid, features: [] })).data.task, null, 'a client without LaTeX is not given it');
});

test('the source proves each dependency before it is used, and cites other works', async () => {
  const t = await claim();
  const { files } = t.context.latex;
  if (process.env.DUMP) for (const [n, c] of Object.entries(files)) (await import('node:fs')).writeFileSync(`${process.env.DUMP}/${n}`, c);
  const tex = files['main.tex'];
  const at = (s) => { const i = tex.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at(`\\label{fact${ids.h}}`) < at(`\\label{fact${ids.a}}`) && at(`\\label{fact${ids.a}}`) < at(`\\label{fact${ids.b}}`));
  at('\\cite[p.~3]{hindman74}'); at('\\section{Results from other works}');
  at(`By Lemma~\\ref{fact${ids.a}}, done.`);
  at('$x^*\\le 2$'); at('$x \\in  X$'); at('and\\_text \\# 100\\% \\~{} safe'); at('Sums of 50\\% \\& more'); at('$\\mathbb{N}$ and $\\lambda$ in text');
  at('\\title{Main result for $\\msf{RCA}_0$}'); at('2 proved facts of the project, each proved before it is used, and 1 result cited from other works.');
  at('\\textbf{definition}'); at('Checked by an independent AI review'); at('\\providecommand{\\msf}');
  at('the star of $x$');
  assert.doesNotMatch(tex, /Unchecked/);
  assert.match(files['refs.bib'], /@article\{hindman74/);
  assert.equal(t.context.latex.sha256, createHash('sha256').update(tex + '\0' + files['refs.bib']).digest('hex'));

  const bad = await send(t, 'f'.repeat(64)); assert.equal(bad.status, 409, JSON.stringify(bad.data));
  const r = await send(t);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const doc = (await app.call(ann, 'GET', `/api/documents/${r.data.document_id}`)).data;
  assert.equal(doc.origin, 'ai'); assert.equal(doc.exported_fact.id, ids.b); assert.equal(doc.ai_model, 'claude-opus-5-5');
  assert.deepEqual(doc.versions[0].files.map((f) => f.filename).sort(), ['document.pdf', 'main.tex', 'refs.bib']);
  assert.match(doc.description, /assembled from the facts of the project/);
  const queue = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks;
  assert.ok(!queue.some((q) => q.kind === 'extract' && q.source_id === doc.id), 'its facts are already the project\'s: no extraction');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'latex', summary: 'Compiled.' });
  assert.match((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'document', source_id: doc.id })).data.error, /assembled from facts/);
  const shown = (await app.call(ann, 'GET', `/api/facts/${ids.b}`)).data.latex;
  assert.equal(shown.problem, null); assert.equal(shown.document.id, doc.id);
  assert.match((await app.call(ann, 'GET', `/api/facts/${ids.u}`)).data.latex.problem, /not checked yet/);

  assert.equal((await ask(ids.b)).status, 201);
  const t2 = await claim(); const again = await send(t2);
  await app.call(key, 'POST', `/api/ai/tasks/${t2.id}/complete`, { lease: t2.lease, ai_model: 'latex', summary: 'Compiled.' });
  assert.equal(again.data.document_id, doc.id, 'asked again, it is a new version of the same file');
  assert.equal((await app.call(ann, 'GET', `/api/documents/${doc.id}`)).data.versions.length, 2);
});

test('rich text becomes LaTeX: formulas kept, the rest escaped', () => {
  const run = (html) => execFileSync('php', ['-r', 'spl_autoload_register(function ($c) { $f = "src/" . str_replace(["App\\\\Controllers\\\\", "App\\\\"], ["Controllers/", ""], $c) . ".php"; if (is_file($f)) require $f; }); echo App\\LatexExport::html($argv[1]);', html], { encoding: 'utf8' });
  assert.equal(run('<p>Let $a_{**}$ and \\(x^*\\) with <em>care</em>: 5\\$ &amp; $$\\sum_i x_i$$</p>'), 'Let $a_{**}$ and \\(x^*\\) with \\emph{care}: 5\\$ \\& $$\\sum_i x_i$$');
  assert.equal(run('<ul><li>one</li><li>$x$</li></ul>'), '\\begin{itemize}\n\\item one\n\\item $x$\n\\end{itemize}');
  assert.equal(run('<p>a<br>b <a href="https://x.org/a#b">link</a> <code>f_x</code></p>'), 'a\\\\\nb \\href{https://x.org/a\\#b}{link} \\texttt{f\\_x}');
});

const TEX = ['/Library/TeX/texbin/pdflatex', '/usr/bin/pdflatex', '/usr/local/bin/pdflatex', '/opt/homebrew/bin/pdflatex'].find((p) => fs.existsSync(p));
test('the AI client compiles the document with LaTeX, in a sandbox, and the platform keeps it', { skip: !TEX && 'no LaTeX on this computer' }, async () => {
  assert.equal((await ask(ids.b)).status, 201);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-latex-'));
  // No AI runs: the stub only lets the client start, as an installed AI tool would.
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0; else echo "{}"; fi\n', { mode: 0o755 });
  const out = spawnSync('python3', [path.resolve('client/oq.py'), 'run', '--once', '--provider', 'claude', '--project', String(pid), '--only', 'latex'],
    { env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, OQ_CONFIG_DIR: path.join(dir, 'c'), OQ_URL: app.base, OQ_KEY: key.token }, encoding: 'utf8', timeout: 240000 });
  fs.rmSync(dir, { recursive: true, force: true });
  if (process.env.SHOW) console.log(out.stdout, out.stderr);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  const task = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.find((t) => t.kind === 'latex' && t.status !== 'cancelled' && t.summary_text?.includes('Compiled the LaTeX document'));
  assert.ok(task, JSON.stringify((await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.filter((t) => t.kind === 'latex').map((t) => [t.status, t.error_text])));
  const docs = (await app.call(ann, 'GET', `/api/projects/${pid}/documents`)).data.documents;
  const doc = (await app.call(ann, 'GET', `/api/documents/${docs.find((d) => d.title.startsWith('Main result')).id}`)).data;
  const pdf = doc.versions[0].files.find((f) => f.role === 'pdf');
  const bytes = Buffer.from(await (await fetch(`${app.base}/api/files/${pdf.id}`, { headers: { Cookie: ann.cookie } })).arrayBuffer());
  assert.ok(bytes.length > 20000 && bytes.subarray(0, 5).toString() === '%PDF-', `a real PDF, ${bytes.length} bytes`);
});
