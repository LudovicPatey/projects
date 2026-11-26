// Decisions an AI takes so that people do not have to: a second AI checks each rewrite in the project notation, another reading
// settles the consolidation's uncertain proposals, and references confirmed by their DOI or arXiv record join the bibliography.
// People can overrule each one.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const BOB = '0000-0001-5109-3700';
let app; let ann; let bob; let key; let pid; let stub; let base;
const NOW = { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, consolidate_hours: 0 };

const claim = (kinds, p = pid) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', project_id: p, kinds, features: ['procedures', 'notation'], capabilities: ['web_search', 'document'] });
const answer = (t, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: 'claude-opus-5-5', generation_seconds: 12, answer: ans });
const project = async (title) => (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
const facts = (p, list) => app.call(key, 'POST', `/api/projects/${p}/facts/batch`, { format: 'native', ai_model: 'claude-sonnet-5-5', facts: list });

// A stand-in for Crossref and arXiv: the records of two real works, nothing else.
const CROSSREF = { '10.1000/other': { title: ['Something else entirely'], author: [{ family: 'Smith' }] }, '10.1016/0097-3165(74)90093-8': { title: ['Finite sums from sequences within cells of a partition of N'], author: [{ given: 'Neil', family: 'Hindman' }], issued: { 'date-parts': [[1974]] }, 'container-title': ['Journal of Combinatorial Theory, Series A'] } };
const ARXIV = { '2101.00001': { title: 'Ramsey theorems for colourings of pairs', authors: ['Ana Kovač', 'Bo Li'], published: '2021-01-01T00:00:00Z' } };

before(async () => {
  stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/works/')) {
      const m = CROSSREF[decodeURIComponent(u.pathname.slice(7))];
      res.writeHead(m ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(m ? JSON.stringify({ message: m }) : '{}'); return;
    }
    const e = ARXIV[u.searchParams.get('id_list')];
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${e ? `<entry><title>${e.title}</title><published>${e.published}</published>${e.authors.map((a) => `<author><name>${a}</name></author>`).join('')}</entry>` : ''}</feed>`);
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${stub.address().port}`;
  app = await startApp({ config: { sweeps: NOW, bib_check: { crossref: `${base}/works/`, arxiv: `${base}/arxiv?id_list=`, seconds: 10 } } });
  ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  pid = await project('Decides');
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => { app?.stop(); stub?.close(); });

test('a second AI compares each rewrite with its original; an unfaithful one is hidden and tried once more, and a person overrules it', async () => {
  const P = (ref) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `$FS(H)$ is an IP set ${ref}.`, proof_text: 'P.', glossary: { '$FS(H)$': 'the finite sums of H, with 0' } });
  await facts(pid, [P('r1'), P('r2')]);
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'FS(X)', meaning_text: 'The non-empty finite sums of $X$.' })).data;
  await app.call(ann, 'POST', `/api/notation/${e.id}/status`, { status: 'agreed' });
  let t = (await claim(['notation'])).data.task;
  let r = await answer(t, { summary: '', facts: t.context.facts_to_rewrite.map((f) => ({ fact_id: f.fact_id, unchanged: false, statement: f.statement.replace('FS(H)', 'FS(X)'), proof: 'P.', local_notation: [], uses: [{ symbol: 'FS(H)', meaning_here: 'with 0', project_symbol: 'FS(X)' }] })) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [a, b] = t.context.facts_to_rewrite.map((f) => f.fact_id);

  t = (await claim(['rewrite_check'])).data.task;
  assert.ok(t, 'a check sweep was queued'); assert.equal(t.source_type, 'sweep'); assert.equal(t.recipe.variant, 'rewrite_check');
  assert.match(t.recipe.instructions, /"unfaithful" when anything mathematical changed/);
  assert.deepEqual(t.context.rewrites.map((x) => x.fact_id).sort(), [a, b].sort());
  const x = t.context.rewrites.find((y) => y.fact_id === a);
  assert.match(x.original.statement, /FS\(H\)/); assert.match(x.rewrite.statement, /FS\(X\)/); assert.equal(x.rewrite.uses[0].meaning_here, 'with 0');
  const idOf = (fid) => t.context.rewrites.find((y) => y.fact_id === fid).rewrite_id;
  r = await answer(t, { summary: 'Read.', checks: [{ rewrite_id: idOf(a), verdict: 'faithful', note: '' }, { rewrite_id: idOf(b), verdict: 'unfaithful', note: 'The original counts 0 among the sums; the project symbol does not.' }, { rewrite_id: 999999, verdict: 'faithful', note: '' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.summary_text, /^2 rewrites checked, 1 found unfaithful/);

  const fa = (await app.call(ann, 'GET', `/api/facts/${a}`)).data; const fb = (await app.call(ann, 'GET', `/api/facts/${b}`)).data;
  const ra = fa.rephrasings.find((y) => y.current); const rb = fb.rephrasings.find((y) => y.current);
  assert.equal(ra.check_verdict, 'faithful'); assert.equal(ra.checked_by, null); assert.equal(ra.check_ai_model, 'claude-opus-5-5');
  assert.equal(rb.check_verdict, 'unfaithful'); assert.match(rb.check_note, /counts 0/);
  assert.equal((await claim(['rewrite_check'])).data.task, null, 'a checked rewrite is not checked again');

  // The unfaithful fact is rewritten once more, told what went wrong; a second failure is not retried in the same notation.
  t = (await claim(['notation'])).data.task;
  assert.deepEqual(t.context.facts_to_rewrite.map((f) => f.fact_id), [b]);
  assert.match(t.context.facts_to_rewrite[0].earlier_rewrite_problem, /counts 0/);
  assert.match(t.recipe.instructions, /earlier_rewrite_problem/);
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });

  // A person overrules the AI's verdict: theirs replaces it, and no AI checks it again.
  r = await app.call(bob, 'POST', `/api/fact-rephrasings/${ra.id}/check`, { verdict: 'unfaithful', note: 'Not the same: 0.' });
  assert.ok([403, 404].includes(r.status), 'only members check');
  r = await app.call(ann, 'POST', `/api/fact-rephrasings/${ra.id}/check`, { verdict: 'unfaithful', note: 'Not the same: 0.' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const again = (await app.call(ann, 'GET', `/api/facts/${a}`)).data.rephrasings.find((y) => y.current);
  assert.equal(again.check_verdict, 'unfaithful'); assert.equal(again.check_ai_model, null); assert.ok(again.checked_by);
  // A member may not ask for this upkeep: the platform queues it.
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'rewrite_check' })).status, 422);
});

test('a second reading applies the uncertain proposals it agrees with, drops the others, and leaves to people only what needs them', async () => {
  const p = await project('Second');
  const Q = (ref, extra = {}) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `Every coloring of $\\mathbb{N}$ has a monochromatic set ${ref}.`, proof_text: 'P.', ...extra });
  const ids = Object.fromEntries((await facts(p, [Q('s1'), Q('s2'), Q('s3', { kind: 'remark' }), Q('s4')])).data.created.map((x) => [x.ref, String(x.id)]));
  const r = await app.call(key, 'POST', `/api/projects/${p}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [
    { kind: 'same', fact: ids.s1, other_fact: ids.s2, reason: 'The same statement.', confidence: 'medium' },
    { kind: 'kind', fact: ids.s3, new_kind: 'theorem', reason: 'It is a result.', confidence: 'low' },
    { kind: 'depends', fact: ids.s4, other_fact: ids.s1, reason: 'Perhaps uses it.', confidence: 'medium' },
  ] });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.applied.length, 0, 'nothing sure enough to apply at once');
  const t = (await claim(['second_reading'], p)).data.task;
  assert.ok(t); assert.equal(t.recipe.variant, 'second_reading');
  assert.match(t.recipe.instructions, /second, independent reader/);
  assert.equal(t.context.proposals.length, 3);
  const same = t.context.proposals.find((x) => x.kind === 'same');
  assert.match(same.fact.statement, /monochromatic/); assert.match(same.other_fact.statement, /monochromatic/); assert.equal(same.confidence, 'medium');
  const id = (kind) => t.context.proposals.find((x) => x.kind === kind).suggestion_id;
  const done = await answer(t, { summary: '', decisions: [{ suggestion_id: id('same'), verdict: 'apply', reason: 'Equivalent as written.' }, { suggestion_id: id('kind'), verdict: 'drop', reason: 'It has no proof.' }, { suggestion_id: id('depends'), verdict: 'unsure', reason: 'The proof is too short to tell.' }] });
  assert.equal(done.status, 200, JSON.stringify(done.data)); assert.match(done.data.summary_text, /^3 proposals read again \(1 applied, 1 dropped, 1 left to people\)/);

  let list = (await app.call(ann, 'GET', `/api/projects/${p}/consolidation`)).data.suggestions;
  const by = (kind) => list.find((s) => s.kind === kind);
  assert.equal(by('same').status, 'accepted'); assert.equal(by('same').auto_applied, true); assert.equal(by('same').second_verdict, 'apply');
  assert.equal(by('kind').status, 'rejected'); assert.equal(by('kind').second_verdict, 'drop'); assert.equal(by('kind').decided_by, null);
  assert.equal(by('depends').status, 'proposed'); assert.equal(by('depends').second_verdict, 'unsure'); assert.match(by('depends').second_reason, /too short/);
  assert.equal((await claim(['second_reading'], p)).data.task, null, 'each proposal is read again once');

  // People overrule: any member undoes the merge, and brings back what was dropped, which then waits for them.
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${by('same').id}/undo`, {})).status, 200);
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${by('depends').id}/restore`, {})).status, 409, 'only a dropped proposal comes back');
  assert.equal((await app.call(ann, 'POST', `/api/fact-suggestions/${by('kind').id}/restore`, {})).status, 200);
  list = (await app.call(ann, 'GET', `/api/projects/${p}/consolidation`)).data.suggestions;
  assert.equal(by('kind').status, 'proposed'); assert.equal(by('kind').second_verdict, 'kept');
  assert.equal((await claim(['second_reading'], p)).data.task, null, 'a proposal a person brought back is not read again');

  // A project where every change waits for people gets no second reading.
  const off = await project('Off');
  await app.call(ann, 'POST', `/api/projects/${off}/consolidation/settings`, { auto: false });
  const o = (await facts(off, [Q('o1'), Q('o2')])).data.created.map((x) => String(x.id));
  assert.equal((await app.call(key, 'POST', `/api/projects/${off}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions: [{ kind: 'same', fact: o[0], other_fact: o[1], reason: 'Same.', confidence: 'medium' }] })).data.created.length, 1);
  assert.equal((await claim(['second_reading'], off)).data.task, null);
});

test('a suggested reference whose DOI or arXiv record has its title and first author joins the bibliography; the others wait', async () => {
  const p = await project('References');
  const suggest = (pp, suggestions) => app.call(key, 'POST', `/api/projects/${pp}/ai/suggestions`, { ai_model: 'claude-opus-5-5', suggestions });
  const r = await suggest(p, [
    { title: 'Finite sums from sequences within cells of a partition of $\\mathbb{N}$', authors: 'Hindman, Neil', year: '1974', doi: '10.1016/0097-3165(74)90093-8', reason_text: 'The finite sums theorem.' },
    { title: 'A theorem nobody wrote', authors: 'Hindman, Neil', doi: '10.1016/0097-3165(74)90093-8x', reason_text: 'Invented.' },
    { title: 'Finite sums in partitions', authors: 'Smith, Jo', doi: '10.1000/other', reason_text: 'The record of this DOI has another title.' },
    { title: 'Ramsey theorems for colorings of pairs', authors: 'A. Kovač and B. Li', arxiv: '2101.00001', reason_text: 'Pairs.' },
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.added.length, 2, 'the two works whose records match');
  const list = (await app.call(ann, 'GET', `/api/projects/${p}/ai`)).data.suggestions;
  const hind = list.find((s) => s.doi === '10.1016/0097-3165(74)90093-8' && s.authors === 'Hindman, Neil' && s.year === '1974');
  assert.equal(hind.status, 'accepted'); assert.equal(hind.auto_added, true); assert.equal(hind.verified_by, 'crossref'); assert.equal(hind.decided_by, null);
  assert.equal(list.find((s) => s.arxiv === '2101.00001').verified_by, 'arxiv');
  assert.deepEqual(list.filter((s) => s.status === 'proposed').map((s) => s.title).sort(), ['A theorem nobody wrote', 'Finite sums in partitions']);
  const bib = (await app.call(ann, 'GET', `/api/projects/${p}/bib`)).data;
  const entries = bib.entries ?? bib;
  const added = entries.find((b) => b.id === hind.bib_id);
  assert.ok(added, 'in the bibliography'); assert.match(JSON.stringify(added), /Journal of Combinatorial Theory/, 'the venue comes from the record');

  // A member takes one back: it leaves the bibliography.
  const u = await app.call(ann, 'POST', `/api/bib-suggestions/${hind.id}/undo`, {}); assert.equal(u.status, 200, JSON.stringify(u.data));
  const after = (await app.call(ann, 'GET', `/api/projects/${p}/ai`)).data.suggestions.find((s) => s.id === hind.id);
  assert.equal(after.status, 'rejected'); assert.equal(after.bib_id, null);
  const left = (await app.call(ann, 'GET', `/api/projects/${p}/bib`)).data;
  assert.ok(!(left.entries ?? left).some((b) => b.id === hind.bib_id));
  assert.equal((await app.call(ann, 'POST', `/api/bib-suggestions/${list.find((s) => s.status === 'proposed').id}/undo`, {})).status, 409, 'only what was added automatically');

  // Where every change waits for people, nothing is added on its own.
  const off = await project('References off');
  await app.call(ann, 'POST', `/api/projects/${off}/consolidation/settings`, { auto: false });
  const o = await suggest(off, [{ title: 'Ramsey theorems for colourings of pairs', authors: 'Kovač, Ana', arxiv: '2101.00001', reason_text: 'Pairs.' }]);
  assert.equal(o.status, 201); assert.deepEqual(o.data.added, []);
});
