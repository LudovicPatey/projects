// What the audit of the live project found: source checks made without the source, proofs nobody reviewed, a backlog of rewrites
// taken a few facts an hour, and notation entries that never said what their parameters are.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
// Sweeps run at once, except the rewrites, which rest an hour after a batch that did not fill up.
const CONFIG = { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 5, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, review_hours: 0, consolidate_hours: 0 } };
let app; let ann; let key; let pid;

const claim = (kinds) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: pid, kinds, features: ['procedures', 'notation', 'consolidate', 'review'], capabilities: ['web_search', 'document'] });
const answer = (t, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 12, answer: ans });
const batch = (facts) => app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts });

before(async () => {
  app = await startApp({ config: CONFIG }); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Audit', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('a source check reads the PDF of the reference, says when it could not read, and one made blind is made again once', async () => {
  const bib = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: 'Logical analysis', author: 'Blass, A.', year: '1987' }, cite_key: 'bhs87' })).data.created[0];
  const r = await batch([{ ref: 'cited', title: 'Cited', kind: 'theorem', labels: ['conclusion'], method: 'extracted', statement_text: 'S.', proof_text: '', sources: [{ type: 'bib', id: bib, quote: 'Theorem 1', covers: 'statement' }] }]);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const fid = r.data.created[0].id;
  // Without a PDF: only web search, and the check records that it had no source.
  let t = (await claim(['source_check'])).data.task;
  assert.ok(t); assert.equal(t.context.document, undefined); assert.ok(!t.recipe.capabilities.includes('document'));
  assert.match(t.recipe.instructions, /"unreadable" if you could not read the work at all/);
  assert.equal((await answer(t, { summary: '', checks: [{ fact_id: fid, verdict: 'not_found', where: '', explanation: 'The folder has no text.' }] })).status, 200);
  assert.equal((await claim(['source_check'])).data.task, null, 'no source to read yet: not checked again');
  // The PDF arrives: the result is checked once more, with it.
  const form = new FormData(); form.set('pdf', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'p.pdf');
  await fetch(`${app.base}/api/bib/${bib}/pdf`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf }, body: form });
  t = (await claim(['source_check'])).data.task;
  assert.ok(t, 'checked again'); assert.deepEqual(t.context.cited_results.map((x) => x.id), [fid]);
  assert.equal(t.context.document.files[0].id, `bib/${bib}`); assert.ok(t.recipe.capabilities.includes('document'));
  const pdf = await fetch(`${app.base}/api/files/bib/${bib}`, { headers: { Authorization: `Bearer ${key.token}` } });
  assert.equal(pdf.status, 200); assert.match(Buffer.from(await pdf.arrayBuffer()).toString(), /^%PDF/);
  const done = await answer(t, { summary: '', checks: [{ fact_id: fid, verdict: 'unreadable', where: '', explanation: 'The PDF has no text layer.' }] });
  assert.equal(done.status, 200, JSON.stringify(done.data)); assert.match(done.data.summary_text, /1 with a source it could not read/);
  assert.equal((await claim(['source_check'])).data.task, null, 'checked with its source: never again');
  const f = (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;
  assert.equal(f.source_checks[0].verdict, 'unreadable');
});

test('proofs nobody reviewed are refereed by a sweep, a few at a time, and each review counts like any AI review', async () => {
  const P = (ref, deps = []) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `S ${ref}.`, proof_text: `P ${ref}.`, depends_on: deps });
  const r = await batch([P('base'), P('top', ['base']), P('side')]);
  const id = Object.fromEntries(r.data.created.map((x) => [x.ref, x.id]));
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'proof_review' })).status, 422, 'only the platform queues it');
  const t = (await claim(['proof_review'])).data.task;
  assert.ok(t); assert.equal(t.source_type, 'sweep'); assert.equal(t.recipe.variant, 'proof_review');
  assert.equal(t.context.facts[0].fact_id, id.base, 'the fact others rely on first');
  const top = t.context.facts.find((x) => x.fact_id === id.top);
  assert.equal(top.dependencies[0].label, r.data.created.find((x) => x.ref === 'base').label);
  const done = await answer(t, { summary: '', reviews: [
    { fact_id: id.base, verdict: 'correct', explanation: 'Checked every step.' },
    { fact_id: id.top, verdict: 'gap', explanation: 'The second step uses Lemma 7, not a dependency.' },
    { fact_id: 999999, verdict: 'correct', explanation: 'Not in the batch.' },
  ] });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.match(done.data.summary_text, /^2 proofs reviewed \(1 correct, 1 with a gap\)/);
  const base = (await app.call(ann, 'GET', `/api/facts/${id.base}`)).data;
  assert.equal(base.status, 'ai_checked'); assert.equal(base.reviews[0].reviewer_kind, 'agent'); assert.equal(base.reviews[0].ai_model, 'claude-opus-5-5');
  // What it left out is not read again; nothing is left.
  assert.equal((await claim(['proof_review'])).data.task, null, 'each proof read once');
});

test('a rewrite batch cut by its size limit carries on at once; one that took everything rests', async () => {
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{FIN}', meaning_text: 'The non-empty finite subsets of $\\mathbb N$.' })).data;
  await app.call(ann, 'POST', `/api/notation/${e.id}/status`, { status: 'agreed' });
  // Proofs long enough that two do not fit in one batch.
  const long = 'x'.repeat(30000);
  await batch(['l1', 'l2'].map((ref) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `Every $X\\in\\mathrm{FIN}$ in ${ref}.`, proof_text: long })));
  const rewrite = async () => {
    const t = (await claim(['notation'])).data.task;
    if (!t) return null;
    const r = await answer(t, { summary: '', facts: t.context.facts_to_rewrite.map((f) => ({ fact_id: f.fact_id, unchanged: true, statement: f.statement, proof: f.proof, local_notation: [], uses: [] })) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return t.context.facts_to_rewrite.length;
  };
  const sizes = [];
  for (let n = await rewrite(); n !== null && sizes.length < 20; n = await rewrite()) sizes.push(n);
  assert.ok(sizes.length >= 2, `several batches without waiting an hour: ${sizes}`);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 2, 'every fact that uses FIN taken, each once; the others use no entry and need no rewrite');
});

test('a proof is never put in the batch of the model that wrote it: it waits for another model', async () => {
  const p = (await app.call(ann, 'POST', '/api/projects', { title: 'Own proofs', question_html: '<p>Q</p>' })).data.id;
  const r = await app.call(key, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: [
    { ref: 'own', title: 'own', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'S.', proof_text: 'P.' }] });
  const fid = r.data.created[0].id;
  const claimAs = (model) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: model, project_id: p, kinds: ['proof_review'], features: ['procedures', 'review'], capabilities: [] });
  assert.equal((await claimAs('claude-sonnet-5-5')).data.task, null, 'its own proof is not offered to the model that wrote it');
  const t = (await claimAs('claude-opus-5-5')).data.task;
  assert.ok(t, 'another model still gets it'); assert.deepEqual(t.context.facts.map((f) => f.fact_id), [fid]);
});

test('a source check batch keeps its other results when one of them was deleted meanwhile', async () => {
  const p = (await app.call(ann, 'POST', '/api/projects', { title: 'Deleted', question_html: '<p>Q</p>' })).data.id;
  const bib = (await app.call(ann, 'POST', `/api/projects/${p}/bib`, { fields: { title: 'A book', author: 'X, Y.', year: '2000' }, cite_key: 'xy00' })).data.created[0];
  const C = (ref) => ({ ref, title: ref, kind: 'theorem', labels: ['conclusion'], method: 'extracted', statement_text: `S ${ref}.`, proof_text: '', sources: [{ type: 'bib', id: bib, quote: 'Theorem', covers: 'statement' }] });
  const made = (await app.call(key, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'm', facts: [C('one'), C('two')] })).data.created;
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: p, kinds: ['source_check'], features: ['procedures'], capabilities: ['web_search', 'document'] })).data.task;
  assert.equal(t.context.cited_results.length, 2);
  assert.equal((await app.call(ann, 'DELETE', `/api/facts/${made[1].id}`)).status, 200);
  const done = await app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', answer: { summary: '', checks: made.map((f) => ({ fact_id: f.id, verdict: 'confirmed', where: 'Theorem 1', explanation: 'Stated.' })) } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.match(done.data.summary_text, /^1 cited result checked/);
});
