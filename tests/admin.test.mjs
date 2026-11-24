// The Admin page of a project, bin/admin.php, and the notation a proof search receives.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';
import { ADMIN_ACTIONS as UI_ACTIONS, confirmed, describeChanges, hasChanges } from '../public/assets/js/admin-model.js';
import { ADMIN_ACTIONS, adminCommand } from '../scripts/lib/migrate-remote.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
const CLIENT = path.resolve('client/oq.py');
let app; let ann; let bob; let key; let pid; let title;

const admin = (action, confirm = '', options = {}, who = ann) => app.call(who, 'POST', `/api/projects/${pid}/admin`, { action, confirm, options });
const preview = async (q) => (await app.call(ann, 'GET', `/api/projects/${pid}/admin/preview?${q}`)).data;
const factCount = async () => (await app.call(ann, 'GET', `/api/projects/${pid}/facts`)).data.facts.length;
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

async function seed() {
  const made = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [
    { ref: 'a', title: 'Base', kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: 'A base statement.', proof_text: 'A proof.' },
    { ref: 'b', title: 'Top', kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: 'A top statement.', proof_text: 'By the base.', depends_on: ['a'] },
  ] })).data.created;
  const [a, b] = made.map((x) => x.id);
  await app.call(ann, 'POST', `/api/facts/${a}/reviews`, { verdict: 'correct' });
  await app.call(bob, 'POST', `/api/facts/${b}/proofs`, { body_text: 'Another proof.' });
  await app.call(ann, 'POST', '/api/comments', { target_type: 'fact', target_id: a, body_text: 'A remark on the base.' });
  const q = (await app.call(ann, 'POST', `/api/projects/${pid}/questions`, { title: 'Is it true?' })).data;
  const qid = q.id ?? q.question?.id;
  await app.call(ann, 'POST', `/api/questions/${qid}/links`, { target_type: 'fact', target_id: b });
  const ref = (await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { bibtex: `@article{k${a}, title={A paper ${a}}, author={Doe, Jane}, year={2020}}` })).data.created[0];
  const f = new FormData(); f.set('pdf', new Blob([PDF], { type: 'application/pdf' }), 'p.pdf');
  await fetch(`${app.base}/api/bib/${ref}/pdf`, { method: 'POST', headers: { Cookie: ann.cookie, 'X-CSRF-Token': ann.csrf }, body: f });
  await app.call(ann, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'extract', source_type: 'bib', source_id: ref });
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'c', ai_model: 'claude-opus-5-5', kinds: ['extract'], project_id: pid, features: ['extract_bib'] })).data.task;
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/complete`, { lease: t.lease, ai_model: 'claude-opus-5-5', summary: 'ok' });
  return { a, b, ref, qid };
}

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  title = 'Admin check';
  pid = (await app.call(ann, 'POST', '/api/projects', { title, question_html: '<p>Q</p>' })).data.id;
  await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB });
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('the page helpers and the SSH command', () => {
  assert.deepEqual(Object.keys(UI_ACTIONS).sort(), [...ADMIN_ACTIONS].sort());
  assert.equal(describeChanges({ facts: 1, reviews: 2, tasks: 0 }), '1 fact, 2 reviews'); assert.equal(describeChanges({ tasks: 0 }), 'Nothing to change');
  assert.equal(hasChanges({ a: 0 }), false); assert.ok(confirmed(' admin CHECK ', 'Admin check')); assert.equal(confirmed('', ''), false);
  assert.match(adminCommand('projects', 3, 'reset_facts', ['--requeue', '--apply']), /bin\/admin\.php --project 3 reset_facts --requeue --apply$/);
  assert.throws(() => adminCommand('projects', '3; rm -rf /', null));
  assert.throws(() => adminCommand('projects', 3, 'drop_tables'));
  assert.throws(() => adminCommand('projects', 3, 'reset_facts', ['--force']));
});

test('only owners, and only people, administer a project', async () => {
  assert.equal((await app.call(bob, 'GET', `/api/projects/${pid}/admin`)).status, 403);
  assert.equal((await admin('cancel_waiting', '', {}, bob)).status, 403);
  assert.equal((await app.call(key, 'GET', `/api/projects/${pid}/admin`)).status, 403);
  const d = (await app.call(ann, 'GET', `/api/projects/${pid}/admin`)).data;
  assert.deepEqual(d.actions.map((x) => x.action).sort(), [...ADMIN_ACTIONS].sort());
  assert.equal(d.actions.find((x) => x.action === 'reset_facts').destructive, true);
});

test('emptying the facts database keeps the bibliography and resets extraction', async () => {
  const s = await seed();
  const p = await preview('action=reset_facts&requeue=1');
  assert.equal(p.changes.facts, 2); assert.equal(p.changes.reviews, 1); assert.equal(p.changes.proofs, 1); assert.equal(p.changes.comments, 1);
  assert.equal(p.changes.question_links, 1); assert.ok(p.changes.tasks >= 1); assert.equal(p.changes.queued_after, 1);
  assert.equal((await admin('reset_facts', 'wrong title')).status, 422);
  const before_ = fs.readdirSync(path.join(app.dir, 'storage')).length;
  const r = await admin('reset_facts', 'admin check', { requeue: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.changes.facts, 2); assert.equal(r.data.changes.queued, 1); assert.ok(r.data.backup, 'a backup is made first');
  assert.ok(fs.readdirSync(path.join(app.dir, 'storage'), { recursive: true }).some((f) => String(f).endsWith(r.data.backup)), 'the backup file exists');
  assert.ok(fs.readdirSync(path.join(app.dir, 'storage')).length >= before_);
  assert.equal(await factCount(), 0);
  const bib = (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data;
  const entry = bib.entries.find((e) => e.id === s.ref);
  assert.ok(entry.has_pdf, 'the PDF stays'); assert.equal(entry.extraction.state, 'queued', 'and is extracted again');
  assert.equal((await app.call(ann, 'GET', `/api/questions/${s.qid}`)).status, 200, 'questions stay');
});

test('resetting extraction keeps the facts; the queue can be cleaned', async () => {
  const s = await seed();
  assert.equal(await factCount(), 2);
  const p = await preview('action=reset_extraction');
  assert.ok(p.changes.tasks >= 1);
  assert.equal((await admin('reset_extraction', title)).status, 200);
  assert.equal(await factCount(), 2);
  const entry = (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.entries.find((e) => e.id === s.ref);
  assert.equal(entry.extraction.state, 'none');
  const q = await admin('requeue_extraction');
  assert.ok(q.data.changes.queued >= 1);
  const cancelled = await admin('cancel_waiting');
  assert.ok(cancelled.data.changes.tasks >= 1); assert.equal(cancelled.data.backup, null, 'no backup for a reversible action');
  assert.equal((await app.call(ann, 'GET', `/api/projects/${pid}/ai`)).data.counts.pending, 0);
});

test('clearing the notation removes proposals, or everything when asked', async () => {
  const e1 = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'A', meaning_text: 'Agreed one.' })).data;
  await app.call(ann, 'POST', `/api/notation/${e1.id}/status`, { status: 'agreed' });
  await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: 'B', meaning_text: 'Only proposed.' });
  assert.equal((await preview('action=clear_notation')).changes.entries, 1);
  await admin('clear_notation', title);
  assert.deepEqual((await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.entries.map((x) => x.symbol), ['A']);
  await admin('clear_notation', title, { mode: 'all' });
  assert.deepEqual((await app.call(ann, 'GET', `/api/projects/${pid}/notation`)).data.entries, []);
});

test('the server command previews, then applies only with --apply', () => {
  const php = (args) => spawnSync('php', ['bin/admin.php', ...args], { cwd: app.dir, encoding: 'utf8' });
  let r = php(['--project', String(pid)]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Admin check/); assert.match(r.stdout, /reset_facts/);
  r = php(['--project', String(pid), 'reset_facts']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Preview only: nothing was changed/);
  assert.notEqual(php(['--project', '999999']).status, 0);
  assert.notEqual(php(['--project', String(pid), 'drop']).status, 0);
  r = php(['--project', String(pid), 'cancel_waiting', '--apply']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Done/);
});

test('a proof search receives the agreed notation and the fact written in it', async () => {
  const fact = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'claude-opus-5-5', facts: [{ ref: 'h', title: 'Hindman', kind: 'theorem', labels: ['conclusion'], method: 'deduced', statement_text: 'FS(X) is monochromatic.', proof_text: 'Ultrafilters.' }] })).data.created[0].id;
  const e = (await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: '\\mathrm{NS}(X)', meaning_text: 'The non-empty finite sums.' })).data;
  await app.call(ann, 'POST', `/api/notation/${e.id}/status`, { status: 'agreed' });
  await app.call(key, 'POST', `/api/facts/${fact}/rephrasings`, { ai_model: 'claude-opus-5-5', statement_text: '$\\mathrm{NS}(X)$ is monochromatic.', proof_text: 'Ultrafilters.' });
  await app.call(key, 'POST', `/api/projects/${pid}/ai/tasks`, { kind: 'derive', source_type: 'fact', source_id: fact });
  const t = (await app.call(key, 'POST', '/api/ai/tasks/claim', { client_name: 'd', ai_model: 'claude-opus-5-5', kinds: ['derive'], project_id: pid })).data.task;
  assert.deepEqual(t.context.notation.map((x) => x.symbol), ['\\mathrm{NS}(X)']);
  assert.match(t.context.fact.statement_in_project_notation, /NS/);
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)
ctx = json.loads(sys.argv[2])
print(json.dumps({"target": oq.danus_target(ctx), "notation": oq.danus_notation(ctx["notation"]), "text": oq.html_text("<p>a &amp; $x&lt;y$</p><p>b</p>")}))
`, CLIENT, JSON.stringify(t.context)], { encoding: 'utf8' });
  const d = JSON.parse(out);
  assert.match(d.target.statement, /NS/); assert.equal(d.target.statement_in_project_notation, undefined);
  assert.match(d.notation, /## Notation/); assert.match(d.notation, /\$\\mathrm\{NS\}\(X\)\$: The non-empty finite sums/);
  assert.equal(d.text, 'a & $x<y$\nb');
  await app.call(key, 'POST', `/api/ai/tasks/${t.id}/release`, { lease: t.lease });
});
