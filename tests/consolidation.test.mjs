// Consolidation: after extractions, an AI reads the whole facts database and proposes what no single extraction saw.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { groupSuggestions, suggestionText, topicFilter } from '../public/assets/js/consolidation-model.js';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700'; const OUT = '0000-0003-1415-9269';
const CLIENT = path.resolve('client/oq.py');
const FEATURES = ['extract_bib', 'extract_comments', 'extract_conversation', 'review', 'lean', 'notation', 'consolidate'];
let app; let ann; let bob; let out; let key; let pid; let tmp; let bin;

const facts = async (list) => {
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: list });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  return Object.fromEntries(r.data.created.map((x) => [x.ref, x.id]));
};
const F = (ref, extra = {}) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `Statement ${ref}.`, proof_text: `Proof ${ref}.`, ...extra });
const suggest = (suggestions, who = key) => app.call(who, 'POST', `/api/projects/${pid}/consolidation`, { ai_model: 'claude-opus-5-5', suggestions });
const list = async (who = ann) => (await app.call(who, 'GET', `/api/projects/${pid}/consolidation`)).data;
const proposal = async (kind, fact) => (await list()).suggestions.find((s) => s.kind === kind && s.fact_id === fact && s.status === 'proposed');
const accept = (sid, who = ann) => app.call(who, 'POST', `/api/fact-suggestions/${sid}/accept`, {});
const graph = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data;

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB); out = await app.signIn(OUT);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Consolidate', question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-consolidate-')); bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
});
after(() => { app?.stop(); if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left for the system */ } } });

test('the interface helpers', () => {
  const s = [{ kind: 'topics', status: 'proposed' }, { kind: 'same', status: 'proposed' }, { kind: 'same', status: 'rejected' }];
  assert.deepEqual(groupSuggestions(s).map((g) => [g.kind, g.items.length]), [['same', 1], ['topics', 1]]);
  const facts_ = { 1: { label: 'thm-a' }, 2: { label: 'lem-b' } };
  assert.match(suggestionText({ kind: 'same', fact_id: 1, other_fact_id: 2 }, facts_), /lem-b.*thm-a/);
  assert.match(suggestionText({ kind: 'kind', fact_id: 1, data: { kind: 'theorem' } }, facts_), /theorem/);
  assert.match(suggestionText({ kind: 'topics', fact_id: 2, data: { topics: ['x', 'y'] } }, facts_), /x, y/);
  const f = topicFilter(['Ramsey theory']);
  assert.equal(f({ topics: ['ramsey theory', 'b'] }), true); assert.equal(f({ topics: [] }), false); assert.equal(topicFilter([])({ topics: [] }), true);
});

test('only AI clients propose, only members read, and proposals are checked', async () => {
  const { a, b } = await facts([F('a'), F('b')]);
  assert.equal((await suggest([{ kind: 'topics', fact: a, topics: ['x'], reason: 'r' }], ann)).status, 403);
  assert.equal((await app.call(out, 'GET', `/api/projects/${pid}/consolidation`)).status, 403);
  const r = await suggest([
    { kind: 'topics', fact: String(a), topics: ['Combinatorics', ' combinatorics ', 'Upper bounds'], reason: 'Its subject.' },
    { kind: 'same', fact: a, other_fact: a, reason: 'x' },
    { kind: 'depends', fact: 'b', other_fact: 'nope', reason: 'x' },
    { kind: 'kind', fact: b, new_kind: 'lemma', reason: 'x' },
    { kind: 'topics', fact: b, topics: ['y'], reason: '' },
  ]);
  assert.equal(r.status, 201); assert.equal(r.data.created.length, 1); assert.equal(r.data.skipped.length, 4);
  assert.deepEqual((await proposal('topics', a)).data.topics, ['Combinatorics', 'Upper bounds']);
  assert.equal((await suggest([{ kind: 'topics', fact: a, topics: ['combinatorics'], reason: 'again' }])).data.skipped.length, 1, 'the same proposal is not repeated');
});

test('tags: accepted, set by people, listed, and shown on facts', async () => {
  const { t } = await facts([F('t')]);
  await suggest([{ kind: 'topics', fact: t, topics: ['Graphs'], reason: 'r' }]);
  const s = await proposal('topics', t);
  assert.equal((await app.call(key, 'POST', `/api/fact-suggestions/${s.id}/accept`, {})).status, 403, 'an AI does not decide');
  assert.equal((await accept(s.id, bob)).status, 200, 'any member decides on tags');
  assert.equal((await accept(s.id)).status, 409);
  let fact = (await graph()).facts.find((f) => f.id === t);
  assert.deepEqual(fact.topics, ['Graphs']);
  const set = await app.call(bob, 'POST', `/api/facts/${t}/topics`, { topics: ['Graphs', 'graphs', '  Colorings  ', ...Array.from({ length: 10 }, (_, i) => `t${i}`)] });
  assert.equal(set.data.topics.length, 8); assert.deepEqual(set.data.topics.slice(0, 2), ['Graphs', 'Colorings']);
  assert.equal((await app.call(key, 'POST', `/api/facts/${t}/topics`, { topics: ['x'] })).status, 403);
  assert.ok((await list()).topics.some((x) => x.topic === 'Colorings' && x.facts === 1));
  const compact = (await app.call(ann, 'GET', `/api/projects/${pid}/facts?compact=1`)).data;
  fact = compact.rows.map((row) => Object.fromEntries(compact.columns.map((c, i) => [c, row[i]]))).find((f) => f.id === t);
  assert.ok(fact.topics.includes('Colorings'));
});

test('a dependency across sources and a kind are applied without a new revision', async () => {
  const { p, q } = await facts([F('p'), F('q')]);
  await app.call(ann, 'POST', `/api/facts/${q}/reviews`, { verdict: 'correct', explanation: 'ok' });
  await suggest([{ kind: 'depends', fact: q, other_fact: p, reason: 'The proof of q cites p.' }, { kind: 'kind', fact: q, new_kind: 'theorem', reason: 'Main result.' }]);
  assert.equal((await accept((await proposal('depends', q)).id)).status, 200);
  assert.equal((await accept((await proposal('kind', q)).id)).status, 200);
  const fq = (await app.call(ann, 'GET', `/api/facts/${q}`)).data;
  assert.deepEqual(fq.deps.map((d) => d.id), [p]); assert.equal(fq.kind, 'theorem'); assert.equal(fq.current_revision, 1, 'its reviews still apply');
  assert.equal(fq.status, 'human_checked');
  await suggest([{ kind: 'depends', fact: p, other_fact: q, reason: 'cycle' }]);
  assert.equal((await accept((await proposal('depends', p)).id)).status, 409, 'a cycle is refused');
});

test('two facts stating the same result are merged: links, stars, sources and the other proof follow', async () => {
  const { keep, dup, user } = await facts([F('keep'), F('dup'), F('user', { depends_on: ['dup'] })]);
  await app.call(bob, 'POST', `/api/facts/${dup}/star`, {});
  const qid = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Q1', statement_text: 'Why?' })).data.id;
  await app.call(ann, 'POST', `/api/questions/${qid}/links`, { target_type: 'fact', target_id: dup });
  await suggest([{ kind: 'same', fact: keep, other_fact: dup, reason: 'Same statement.' }, { kind: 'topics', fact: dup, topics: ['Z'], reason: 'r' }]);
  const s = await proposal('same', keep);
  assert.equal((await accept(s.id, bob)).status, 403, 'only an owner merges');
  const r = await accept(s.id);
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.merged, dup);
  const g = await graph();
  assert.equal(g.facts.some((f) => f.id === dup), false);
  assert.deepEqual(g.facts.find((f) => f.id === user).deps, [keep]);
  const fk = (await app.call(ann, 'GET', `/api/facts/${keep}`)).data;
  assert.equal(fk.stars, 1);
  assert.equal(fk.proof_count, 2, 'the duplicate\'s proof is another proof');
  const opened = (await app.call(ann, 'GET', `/api/facts/${dup}`)).data;
  assert.equal(opened.id, keep); assert.equal(opened.merged_from, 'lem:dup');
  const q = (await app.call(ann, 'GET', `/api/questions/${qid}`)).data;
  assert.ok(JSON.stringify(q).includes(`"target_id":${keep}`), 'the question link follows');
  assert.equal((await list()).suggestions.find((x) => x.kind === 'topics' && x.fact_id === dup).status, 'obsolete');
});

test('a remark asking an open question becomes a question, linked to its source', async () => {
  const ref = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { bibtex: '@article{src1, title={Source}, author={A, B}, year={2001}}' })).data.created[0];
  const { rem, used } = await facts([
    { ref: 'rem', title: 'Is it true for triples?', kind: 'remark', labels: ['direction'], method: 'extracted', statement_text: 'We do not know whether it holds for triples.',
      sources: [{ type: 'bib', id: ref, quote: 'We do not know', covers: 'statement' }] },
    F('used'),
  ]);
  const { dependent } = await facts([F('dependent', { depends_on: [String(used)] })]);
  assert.ok(dependent);
  await suggest([{ kind: 'question', fact: rem, title: 'Does it hold for triples?', reason: 'Open.' }, { kind: 'question', fact: used, title: 'X', reason: 'r' }]);
  assert.equal((await accept((await proposal('question', used)).id)).status, 409, 'a fact others rely on stays');
  const r = await accept((await proposal('question', rem)).id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const q = (await app.call(ann, 'GET', `/api/questions/${r.data.question_id}`)).data;
  assert.equal(q.title, 'Does it hold for triples?'); assert.match(q.statement_html, /triples/); assert.equal(q.ai_model, 'claude-opus-5-5');
  assert.ok(JSON.stringify(q).includes(`"target_type":"bib"`));
  assert.equal((await graph()).facts.some((f) => f.id === rem), false);
});

test('bulk decisions, and rejected proposals are not proposed again', async () => {
  const { u, v } = await facts([F('u'), F('v')]);
  await suggest([{ kind: 'topics', fact: u, topics: ['A'], reason: 'r' }, { kind: 'topics', fact: v, topics: ['B'], reason: 'r' }, { kind: 'kind', fact: v, new_kind: 'remark', reason: 'r' }]);
  const mine = (await list()).suggestions.filter((s) => s.status === 'proposed' && [u, v].includes(s.fact_id));
  const ids = mine.map((s) => s.id);
  let r = await app.call(bob, 'POST', `/api/projects/${pid}/consolidation/bulk`, { decision: 'reject', ids: mine.filter((s) => s.kind === 'kind').map((s) => s.id) });
  assert.equal(r.data.done, 1);
  r = await app.call(bob, 'POST', `/api/projects/${pid}/consolidation/bulk`, { decision: 'accept', ids });
  assert.equal(r.data.done, 2);
  assert.equal((await suggest([{ kind: 'kind', fact: v, new_kind: 'remark', reason: 'again' }])).data.skipped[0].reason, 'People already rejected this proposal.');
});

test('the last extraction queues a consolidation, and only clients that handle it take it', async () => {
  for (const t of (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks) if (['pending', 'running'].includes(t.status)) await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {});
  const ref = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { bibtex: '@article{src2, title={Second}, author={C, D}, year={2002}}' })).data.created[0];
  const form = new FormData(); form.set('pdf', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'p.pdf');
  await fetch(`${app.base}/api/bib/${ref}/pdf`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf }, body: form });
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'bib', source_id: ref });
  const ext = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', kinds: ['extract'], project_id: pid, features: FEATURES })).data.task;
  assert.ok(ext);
  await app.call(key, 'POST', `/api/ai/tasks/${ext.id}/complete`, { lease: ext.lease, ai_model: 'claude-opus-5-5', summary: 'ok' });
  const claim = (features) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', kinds: ['consolidate'], project_id: pid, features });
  assert.equal((await claim(FEATURES.slice(0, -1))).data.task, null, 'an older client does not get it');
  const t = (await claim(FEATURES)).data.task;
  assert.equal(t.kind, 'consolidate');
  assert.ok(t.context.fact_texts.length > 5); assert.ok(Array.isArray(t.context.earlier_suggestions)); assert.ok(t.context.topics.some((x) => x.topic === 'Graphs'));
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate', source_type: 'fact', source_id: 1 })).status, 422);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate' })).status, 409, 'one is already waiting');
  await app.call(ann, 'POST', `/api/ai/tasks/${t.id}/cancel`, {});
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'consolidate' })).status, 201, 'a member can ask for one');
});

test('the client runs a consolidation and posts its proposals', async () => {
  const { w } = await facts([F('w')]);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if a == ["--version"]: print("1.0 (Claude Code)"); sys.exit()
if a[:2] == ["auth", "status"]: print("{}"); sys.exit()
prompt = sys.stdin.read()
task = json.load(open("task.json"))
out = {"summary": "Read all.", "suggestions": [{"kind": "topics", "fact": str(${w}), "other_fact": None, "new_kind": None, "title": None, "topics": ["Client tag"], "reason": "Its subject."}]} if "consolidate the facts database" in prompt and "fact_texts" in task else None
print(json.dumps({"is_error": False, "result": "", "structured_output": out, "modelUsage": {"claude-opus-5-5": {"inputTokens": 1, "outputTokens": 1}}}))
`, { mode: 0o755 });
  const dir = path.join(tmp, 'run'); fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('python3', [CLIENT, 'run', '--once', '--provider', 'claude', '--only', 'consolidate', '--project', String(pid)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, OQ_CONFIG_DIR: path.join(dir, 'c'), OQ_URL: app.base, OQ_KEY: key.token }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = await proposal('topics', w);
  assert.ok(s, r.stdout); assert.deepEqual(s.data.topics, ['Client tag']); assert.equal(s.ai_model, 'claude-opus-5-5'); assert.ok(s.task_id);
  const done = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks.find((t) => t.kind === 'consolidate' && t.status === 'done');
  assert.match(done.summary_text, /1 change proposed/);
});
