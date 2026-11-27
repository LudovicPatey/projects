// An extraction once wrote RCA_0 where the paper said RCA, which allows full induction: a base system is part of a statement.
// Every procedure that writes a statement copies it as the source states it, and every procedure that compares one with its source
// flags a different one. The proof review sees the source's quotes, to compare them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const CLIENT = path.resolve('client/oq.py');

test('the client extracts and rewrites the base system as the source states it, and the prover source check compares it', () => {
  const out = spawnSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
print(json.dumps({k: oq.INSTRUCTIONS[k] for k in ["extract", "extract_conversation", "notation_rephrase"]} | {"prover_source": oq.PROVER_SOURCE_CHECK}))
`, CLIENT], { encoding: 'utf8' });
  const r = JSON.parse(out.stdout || '{}');
  assert.match(r.extract, /Copy the base system and every hypothesis of a result exactly as the document states them/, out.stderr);
  assert.match(r.extract, /\$\\mathsf\{RCA\}\$ is not \$\\mathsf\{RCA\}_0\$/, 'written as LaTeX the model reads');
  assert.match(r.extract, /belongs to the statement and to its "quote"/); assert.match(r.extract, /When the document\nstates none, write none: never guess one/);
  assert.match(r.extract_conversation, /Copy the base system and every hypothesis of a result exactly as the message states them/);
  assert.match(r.extract_conversation, /when it states none, write none rather than guess/);
  assert.match(r.notation_rephrase, /Keep the base system as the fact writes it/);
  assert.match(r.prover_source, /with the same hypotheses and base system; "differs"/);
});

test('the platform procedures that rewrite or compare a statement name its base system', () => {
  const php = `spl_autoload_register(fn($c) => is_file($f = 'src/' . str_replace(['App\\\\', '\\\\'], ['', '/'], $c) . '.php') ? require $f : null);
foreach (['notation' => 'fact', 'source_check' => 'fact', 'proof_review' => 'sweep', 'rewrite_check' => 'sweep', 'consolidate' => 'project'] as $k => $s) $out[$k] = App\\Procedures::recipe(['kind' => $k, 'source_type' => $s], [])['instructions'];
$out['source_check_batch'] = App\\Procedures::recipe(['kind' => 'source_check', 'source_type' => 'sweep'], [])['instructions'];
echo json_encode($out);`;
  const out = spawnSync('php', ['-r', php], { encoding: 'utf8' });
  const r = JSON.parse(out.stdout || '{}');
  assert.match(r.notation ?? '', /The base system belongs to the statement: keep it exactly as the fact writes it/, out.stderr + out.stdout);
  assert.match(r.notation, /add none when the fact has none/);
  for (const k of ['source_check', 'source_check_batch']) assert.match(r[k], /\$\\mathsf\{RCA\}_0\$ where the work says \$\\mathsf\{RCA\}\$/, k);
  assert.match(r.source_check, /a base system the statement adds when the work states none/);
  assert.match(r.rewrite_check, /a base system changed, added or dropped/);
  assert.match(r.proof_review, /Compare the statement's base system and hypotheses with them/);
  assert.match(r.proof_review, /a proof that uses more induction or comprehension than the stated base system gives is a gap/);
  assert.match(r.consolidate, /with the same hypotheses, base system and conclusion/);
});

const CONFIG = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, review_hours: 0, consolidate_hours: 0 } };
let app; let ann; let key; let pid;
before(async () => {
  app = await startApp({ config: CONFIG }); ann = await app.signIn('0000-0002-1825-0097');
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Base systems', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('the proof review reads where each fact was taken from, so that a changed base system shows', async () => {
  const bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'Partial impredicativity in reverse mathematics', author: 'Towsner, H.', year: '2012' }, cite_key: 'tow12' })).data.created[0];
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: [
    { ref: 'ip', title: 'Half-matched IP sets', kind: 'lemma', labels: ['conclusion'], method: 'extracted', statement_text: '($\\mathsf{RCA}_0$) Every IP set contains an IP set half-matched by a finite set.',
      proof_text: 'By induction.', sources: [{ type: 'bib', id: bib, quote: '(RCA) Every IP set contains an IP set half-matched by a finite set', page: 7, covers: 'both' }] },
    { ref: 'none', title: 'Without a source', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'P.' },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = Object.fromEntries(r.data.created.map((x) => [x.ref, x.id]));
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds: ['proof_review'], features: ['procedures', 'review'], capabilities: [] })).data.task;
  assert.ok(t); assert.equal(t.recipe.variant, 'proof_review');
  const ip = t.context.facts.find((f) => f.fact_id === id.ip);
  assert.deepEqual(ip.sources.map((s) => [s.quote, s.page]), [['(RCA) Every IP set contains an IP set half-matched by a finite set', 7]]);
  assert.deepEqual(t.context.facts.find((f) => f.fact_id === id.none).sources, [], 'a fact of its own has no source to compare');
});
