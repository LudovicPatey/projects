// A member writes "@AI ..." in a comment. An AI reads the instruction, replies in the thread, and starts what it asks among the
// actions possible on what the comment is on, each through its own checks: a variant of a fact is checked by another company and
// added by a member beside the fact, which stays; a correction and a repair start their loops; a question gets strategies and
// sub-questions, a file a new extraction, a notation entry a proposed change. An unclear instruction gets a reply and nothing else.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { correctionView } from '../public/assets/js/repair-model.js';

const ANN = '0000-0002-1825-0097';
let app; let ann; let key;
const project = async (title) => (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
const F = (ref, deps = []) => ({ ref, title: ref, kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: `($\\mathsf{RCA}_0$) ${ref} holds.`, proof_text: `By $\\Sigma^0_1$ induction, for ${ref}.`, depends_on: deps });
const facts = async (pid, list) => Object.fromEntries((await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: list })).data.created.map((x) => [x.ref, x.id]));
const claim = (pid, kind, model) => app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: model, ai_model: model, project_id: pid, kinds: [kind], models: { [kind]: [model] }, features: ['procedures', 'review'], capabilities: ['document', 'web_search'] });
const answer = (t, model, ans) => app.call(key, 'POST', `/api/ai/tasks/${t.id}/answer`, { lease: t.lease, ai_model: model, generation_seconds: 20, answer: ans });
const fact = async (fid) => (await app.call(ann, 'GET', `/api/facts/${fid}`)).data;
const comment = (who, fid, text, type = 'fact') => app.call(who, 'POST', '/api/comments', { target_type: type, target_id: fid, body_text: text });
const thread = async (fid, type = 'fact') => JSON.stringify((await app.call(ann, 'GET', `/api/comments?type=${type}&id=${fid}`)).data);
const variant = { title: 'lemma (RCA)', statement: '($\\mathsf{RCA}$) lemma holds.', proof: 'By induction on all formulas, as RCA allows.', why: 'Over RCA instead of RCA_0.' };

before(async () => {
  app = await startApp();
  ann = await app.signIn(ANN);
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('an @AI instruction on a fact becomes a variant, checked by another company and added by a member beside the fact', async () => {
  const pid = await project('Variants');
  const id = await facts(pid, [F('lemma'), F('uses', ['lemma'])]);
  await comment(key, id.lemma, '@AI make a variant over RCA');
  assert.equal((await claim(pid, 'instruct', 'gpt-5.5')).data.task, null, 'an AI cannot instruct the AI');
  await comment(ann, id.lemma, '@AI please add a variant of this lemma over RCA, with full induction.');
  let t = (await claim(pid, 'instruct', 'gpt-5.5')).data.task;
  assert.equal(t.kind, 'instruct');
  assert.equal(t.context.fact.fact_id, id.lemma);
  assert.deepEqual(t.context.used_by.map((x) => x.title), ['uses']);
  assert.ok(t.context.actions_allowed.variant && t.context.thread.length === 1);
  assert.equal((await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'instruct', source_type: 'fact', source_id: id.lemma })).status, 422, 'not asked by hand');
  const r = await answer(t, 'gpt-5.5', { summary: 'A variant over RCA.', reply: 'I read it as: the same lemma over RCA.', actions: [{ action: 'variant', text: '', items: [variant] }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const replies = (await thread(id.lemma));
  assert.match(replies, /I read it as/); assert.match(replies, /1 variant proposed/);
  let f = await fact(id.lemma);
  assert.equal(f.corrections[0].mode, 'variant'); assert.equal(f.corrections[0].state, 'verify');
  assert.equal(correctionView(f.corrections[0]).title, 'Variant of the statement');
  assert.equal((await claim(pid, 'fix_check', 'gpt-5.5')).data.task, null, 'not checked by the company that wrote it');
  t = (await claim(pid, 'fix_check', 'claude-sonnet-5-5')).data.task;
  await answer(t, 'claude-sonnet-5-5', { summary: '', checks: [{ correction_id: t.context.corrections[0].correction_id, proposal: 0, verdict: 'correct', explanation: 'Full induction gives it.' }] });
  f = await fact(id.lemma);
  assert.equal(f.corrections[0].state, 'decide');
  assert.equal(correctionView(f.corrections[0]).decide.label, 'Add as variants');
  const a = await app.call(ann, 'POST', `/api/corrections/${f.corrections[0].id}/apply`, { chosen: [0] });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  f = await fact(id.lemma);
  assert.equal(f.retracted_at, null, 'the fact stays'); assert.equal(f.superseded_by.length, 0);
  assert.equal(f.variants.length, 1);
  const nf = await fact(a.data.new_facts[0]);
  assert.equal(nf.variant_of[0].id, id.lemma); assert.equal(nf.title, 'lemma (RCA)');
  assert.equal((await claim(pid, 'relink', 'gpt-5.5')).data.task, null, 'the facts that rely on it are not touched');
  // Undo retracts the variant only.
  await app.call(ann, 'POST', `/api/corrections/${f.corrections[0].id}/undo`, {});
  assert.ok((await fact(nf.id)).retracted_at); assert.equal((await fact(id.lemma)).retracted_at, null);
});

test('correct, repair and review actions start their own loops; an unclear instruction starts nothing', async () => {
  const pid = await project('Actions');
  const id = await facts(pid, [F('a'), F('b')]);
  await comment(ann, id.a, '@AI the base is wrong, it should allow induction; step 2 also skips a case. And review it.');
  let t = (await claim(pid, 'instruct', 'gpt-5.5')).data.task;
  const r = await answer(t, 'gpt-5.5', { summary: '', reply: 'Three things.', actions: [
    { action: 'correct', text: 'The base system should be RCA.', items: [] },
    { action: 'repair', text: 'Step 2 skips the case n = 0.', items: [] },
    { action: 'review', text: '', items: [] },
    { action: 'source_check', text: '', items: [] }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = await fact(id.a);
  assert.equal(f.corrections[0].state, 'revise'); assert.equal(f.corrections[0].mode, 'correction');
  assert.equal(f.repairs[0].state, 'repair');
  const replies = (await thread(id.a));
  assert.match(replies, /Correction of the statement started/); assert.match(replies, /Repair of the proof started/);
  assert.match(replies, /Independent review queued/); assert.match(replies, /Not started: Only a result cited/);
  t = (await claim(pid, 'proof_repair', 'claude-sonnet-5-5')).data.task;
  assert.match(JSON.stringify(t.context), /skips the case n = 0/, 'the repairer reads the objection');
  // Unclear: a reply, and nothing else.
  await comment(ann, id.b, '@AI hmm?');
  t = (await claim(pid, 'instruct', 'gpt-5.5')).data.task;
  await answer(t, 'gpt-5.5', { summary: '', reply: 'I am not sure what you would like: a variant, a correction, a review?', actions: [] });
  const g = await fact(id.b);
  assert.equal(g.corrections.length, 0); assert.equal(g.repairs.length, 0);
  assert.match((await thread(id.b)), /not sure what you would like/);
});

test('on a question: strategies and sub-questions written by the AI, a search, a check of the answers; an action of another object is refused', async () => {
  const pid = await project('Questions');
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Does RCA_0 prove HT for sums of two?' })).data;
  const id = await facts(pid, [F('half')]);
  await app.call(ann, 'POST', `/api/questions/${q.id}/answers`, { answer: 'positive', fact_id: id.half, body_text: 'It does.' });
  await comment(ann, q.id, '@AI suggest a strategy and split this into sub-questions; also look for new facts with apartness, and check the answer.', 'oquestion');
  const t = (await claim(pid, 'instruct', 'gpt-5.5')).data.task;
  assert.equal(t.context.commented_on.type, 'oquestion');
  assert.equal(t.context.question.title, 'Does RCA_0 prove HT for sums of two?');
  assert.ok(t.context.actions_allowed.strategy && !t.context.actions_allowed.variant, 'the actions of a question');
  assert.equal(t.context.facts.length, 1);
  const r = await answer(t, 'gpt-5.5', { summary: '', reply: 'Here is how I read it.', actions: [
    { action: 'strategy', text: '', items: [{ title: 'Code the jump with apartness', statement: 'Encode the halting set in the colors.', proof: '', why: '' }] },
    { action: 'subquestion', text: '', items: [{ title: 'Does it hold for three colors?', statement: 'The same with three colors.', proof: '', why: '' }] },
    { action: 'derive', text: 'Use apartness.', items: [] },
    { action: 'check_answers', text: '', items: [] }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const shown = (await app.call(ann, 'GET', `/api/questions/${q.id}`)).data;
  assert.match(JSON.stringify(shown), /Code the jump with apartness/);
  const sub = (await app.call(ann, 'GET', `/api/projects/${pid}/questions`)).data;
  assert.match(JSON.stringify(sub), /Does it hold for three colors\?/);
  const queue = JSON.stringify((await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks);
  assert.match(queue, /"kind":"derive"/); assert.match(queue, /Use apartness/); assert.match(queue, /"kind":"review"/);
  const replies = await thread(q.id, 'oquestion');
  assert.match(replies, /1 strategy added as an idea/); assert.match(replies, /1 sub-question added/); assert.match(replies, /Search for new facts queued/); assert.match(replies, /Answers checked: Independent review queued/);
  // An action that belongs to a fact is refused here, and said so.
  await comment(ann, q.id, '@AI make a variant', 'oquestion');
  const u = (await claim(pid, 'instruct', 'gpt-5.5')).data.task;
  await answer(u, 'gpt-5.5', { summary: '', reply: 'A variant of what?', actions: [{ action: 'variant', text: '', items: [] }] });
  assert.match(await thread(q.id, 'oquestion'), /Not started: \\"variant\\" is not an action here/);
});

test('on a file, a notation entry and a conversation: a new extraction, a proposed change, and privacy kept', async () => {
  const pid = await project('Objects');
  const form = new FormData();
  form.set('title', 'Notes'); form.set('origin', 'human'); form.set('pdf', new Blob(['%PDF-1.4\n%%EOF\n'], { type: 'application/pdf' }), 'n.pdf');
  const doc = await (await fetch(`${app.base}/api/projects/${pid}/documents`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf, Accept: 'application/json' }, body: form })).json();
  // The upload queued its own extraction: taken and finished, so that the instruction's extraction is the one waiting.
  const first = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'x', ai_model: 'gpt-5.5', project_id: pid, kinds: ['extract'] })).data.task;
  if (first) await app.call(key, 'POST', `/api/ai/tasks/${first.id}/complete`, { lease: first.lease, ai_model: 'gpt-5.5', summary: 'ok' });
  await comment(ann, doc.id, '@AI you missed Lemma 1, extract it again', 'document');
  let t = (await claim(pid, 'instruct', 'gpt-5.5')).data.task;
  await answer(t, 'gpt-5.5', { summary: '', reply: 'I will extract it again.', actions: [{ action: 'extract', text: 'Lemma 1 was missed.', items: [] }] });
  const queue = (await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.tasks;
  assert.ok(queue.some((x) => x.kind === 'extract' && /Lemma 1 was missed/.test(x.prompt_text || '')), 'an extraction with the instruction');
  assert.match(await thread(doc.id, 'document'), /Extraction of facts queued, with your instruction/);
  const n = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{FS}(X)', meaning_text: 'The finite sums of $X$.' })).data;
  await comment(ann, n.id, '@AI FS should include 0 in this project', 'notation');
  t = (await claim(pid, 'instruct', 'gpt-5.5')).data.task;
  assert.equal(t.context.entry.symbol, '\\mathrm{FS}(X)');
  await answer(t, 'gpt-5.5', { summary: '', reply: 'A new entry with 0.', actions: [{ action: 'change', text: '', items: [{ title: '\\mathrm{FS}(X)', statement: 'The finite sums of $X$, and $0$.', proof: '', why: 'The member asks for 0.' }] }] });
  const entries = (await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data;
  const list = entries.entries || entries;
  assert.equal(list.filter((e) => e.symbol === '\\mathrm{FS}(X)').length, 2, 'proposed beside the old one');
  assert.equal(list.find((e) => e.id === n.id).status, 'proposed', 'the old one is not changed');
  // A private conversation: its extraction is asked on its page, where its participants confirm.
  const bob = await app.signIn('0000-0001-5109-3700'); const carol = await app.signIn('0000-0002-1694-233X');
  for (const o of ['0000-0001-5109-3700', '0000-0002-1694-233X']) await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: o });
  const c = (await app.call(ann, 'POST', `/api/projects/${pid}/conversations`, { subject: 'Private', participant_ids: [bob.id], body_text: 'Lemma 2 holds.' })).data;
  assert.equal((await comment(ann, c.id, '@AI extract the facts', 'conversation')).status, 201);
  t = (await claim(pid, 'instruct', 'gpt-5.5')).data.task;
  assert.equal(t.context.conversation.every_member_reads_it, false, 'carol is not in it');
  await answer(t, 'gpt-5.5', { summary: '', reply: 'Extracting.', actions: [{ action: 'extract', text: '', items: [] }] });
  assert.match(await thread(c.id, 'conversation'), /Not started: this conversation is private/);
  assert.ok(carol);
});

test('a client from before instructions answers an @AI comment as a question; one that follows them takes it as an instruction', async () => {
  const pid = await project('Old clients');
  const id = await facts(pid, [F('old')]);
  await comment(ann, id.old, '@AI is step 2 right?');
  const old = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'old', ai_model: 'gpt-5.5', project_id: pid, kinds: ['ask'] })).data.task;
  assert.equal(old.kind, 'ask', 'answered as before');
  assert.equal((await app.call(key, 'POST', `/api/ai/tasks/${old.id}/complete`, { lease: old.lease, ai_model: 'gpt-5.5', reply_text: 'Yes, step 2 is right.', summary: 'ok' })).status, 200);
  assert.match(await thread(id.old), /step 2 is right/);
  await comment(ann, id.old, '@AI then review it');
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'new', ai_model: 'gpt-5.5', project_id: pid, kinds: ['ask', 'instruct'], features: ['procedures', 'review'], capabilities: ['document'] })).data.task;
  assert.equal(t.kind, 'instruct'); assert.equal(t.recipe.procedure, 'instruct');
  assert.ok(t.context.actions_allowed.review);
});
