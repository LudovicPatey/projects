// The migration of existing facts: previewed, backed up, limited to metadata, repeatable and reversible.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { deployFiles } from '../scripts/lib/deploy.mjs';
import { hasChanges, remoteCommand } from '../scripts/lib/migrate-remote.mjs';
import { parseExternalRefs } from '../public/assets/js/fact-format.js';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097';
const CUT = ['{"key": "AS-LLL"', 'authors": ["Alon', '"Spencer"]', 'title": "The Probabilistic Method', '"year": 2016', '"cited_for": "Lovász Local Lemma', 'general case (Lemma 5.1.1)"}', '{"key": "CarlsonRM"', "title\": \"The reverse mathematics of Carlson's theorem", 'arxiv": "2208.03152', '"cited_for": "Definition 3.4', 'the half-match terminology"}'];
const STATEMENT = `Conventions. FIN is the set of nonempty finite subsets of ω, identified with ω through a fixed computable bijection.\n\nTheorem.\n(a) For every f and every infinite block sequence X, there are a finite F and an infinite block sequence Y, computable from f and X, with F<Y.`;
let app; let ann; let key; let pid; let n = 0;

const php = (...args) => spawnSync('php', ['bin/migrate-facts.php', ...args], { cwd: app.dir, encoding: 'utf8' });
const hex = () => { n += 1; return String(n).padStart(16, 'a'); };
const danus = async (over = {}) => {
  const fact_id = hex();
  const r = await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'danus', ai_model: 'claude-opus-5-5', facts: [{ fact_id, statement: STATEMENT, proof: 'A complete proof of (a).', external_refs: CUT, ...over }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.created[0].id;
};
const get = async (id) => (await app.call(ann, 'GET', `/api/facts/${id}`)).data;
const reset = () => { for (const d of ['migrations', 'backups']) fs.rmSync(path.join(app.dir, 'storage', d), { recursive: true, force: true }); };

before(async () => {
  app = await startApp(); ann = await app.signIn(ANN);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Migration', question_html: '<p>Q</p>' })).data.id;
  key = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('the preview reports the changes and modifies nothing', async () => {
  reset();
  const id = await danus(); const before = await get(id);
  const r = php();
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Preview only/); assert.match(r.stdout, /1 kind\(s\)|\d+ kind\(s\)/);
  assert.doesNotMatch(r.stdout, /Probabilistic|FIN is the set/, 'the short report holds no research text');
  const after = await get(id);
  assert.equal(after.title, before.title); assert.equal(after.kind, 'lemma'); assert.deepEqual(after.external_refs, CUT);
  assert.ok(!fs.existsSync(path.join(app.dir, 'storage/backups')) || !fs.readdirSync(path.join(app.dir, 'storage/backups')).length, 'a preview makes no backup');
  const file = fs.readdirSync(path.join(app.dir, 'storage/migrations')).find((x) => x.startsWith('preview-'));
  assert.equal(fs.statSync(path.join(app.dir, 'storage/migrations', file)).mode & 0o777, 0o600);
});

test('applying repairs metadata only, after a verified backup, and is repeatable', async () => {
  reset();
  const id = await danus();
  await app.call(key, 'POST', `/api/facts/${id}/reviews`, { verdict: 'correct', body_text: 'Checked.', ai_model: 'gpt-5.6-sol' });
  const before = await get(id);
  const r = php('--apply');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Backup created and verified/); assert.match(r.stdout, /Applied:/);
  assert.equal(fs.readdirSync(path.join(app.dir, 'storage/backups')).filter((x) => x.endsWith('.zip')).length, 1);
  const f = await get(id);
  assert.equal(f.kind, 'theorem'); assert.equal(f.display_kind, 'theorem');
  assert.match(f.title, /^Theorem\. \(a\) For every f/); assert.ok(f.title.endsWith('…') && [...f.title].length <= 121);
  const refs = parseExternalRefs(f.external_refs);
  assert.deepEqual(refs.map((x) => x.key), ['AS-LLL', 'CarlsonRM']); assert.equal(refs[0].authors, 'Alon, Spencer');
  assert.equal(refs[0].citedFor, 'Lovász Local Lemma, general case (Lemma 5.1.1)'); assert.equal(refs[1].link.href, 'https://arxiv.org/abs/2208.03152');
  for (const k of ['statement_html', 'proof_html', 'intuition_html', 'current_revision', 'status', 'label', 'updated_at', 'ai_model']) assert.deepEqual(f[k], before[k], k);
  assert.equal(f.revisions.length, before.revisions.length); assert.equal(f.reviews.length, 1);
  const again = php('--apply');
  assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /Nothing to change/);
  assert.equal(fs.readdirSync(path.join(app.dir, 'storage/backups')).filter((x) => x.endsWith('.zip')).length, 1, 'no useless second backup');
});

test('undo restores the values, keeps later edits, and is repeatable', async () => {
  reset();
  const edited = await danus(); const plain = await danus();
  const old = await get(plain);
  assert.equal(php('--apply').status, 0);
  assert.ok((await app.call(key, 'PATCH', `/api/facts/${edited}`, { title: 'A title chosen by a person', ai_model: 'm' })).status < 300);
  const r = php('--undo');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Undone: \d+ value\(s\) restored, 1 edited since then and kept/);
  const a = await get(plain);
  assert.equal(a.title, old.title); assert.equal(a.kind, 'lemma'); assert.deepEqual(a.external_refs, CUT);
  assert.equal((await get(edited)).title, 'A title chosen by a person');
  assert.match(php('--undo').stdout, /already undone/);
  assert.equal((await get(plain)).kind, 'lemma');
  assert.equal(php('--apply').status, 0);
  assert.equal((await get(plain)).kind, 'theorem', 'it can be applied again');
});

test('a value changed between the plan and the update is left alone', () => {
  reset();
  const code = `require 'src/bootstrap.php'; use App\\{Db, FactMigration as M};
  $id = (int)Db::value("SELECT id FROM facts WHERE tool = 'danus' ORDER BY id DESC LIMIT 1");
  Db::update('facts', ['kind' => 'lemma', 'title' => 'x'], 'id = :id', ['id' => $id]);
  $plan = ['changes' => [['type' => 'kind', 'table' => 'facts', 'id' => $id, 'column' => 'kind', 'label' => 'l', 'old' => 'corollary', 'new' => 'theorem']]];
  $r = M::apply($plan, 'b'); echo json_encode([$r['applied'], $r['skipped'], Db::value('SELECT kind FROM facts WHERE id = ?', [$id])]);`;
  assert.deepEqual(JSON.parse(spawnSync('php', ['-r', code], { cwd: app.dir, encoding: 'utf8' }).stdout), [0, 1, 'lemma']);
});

test('what is not an old Danus import, or cannot be repaired, stays as it is', async () => {
  reset();
  const human = (await app.call(key, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: 'm', facts: [{ ref: 'n', title: STATEMENT.slice(0, 90), kind: 'lemma', labels: ['conclusion'], method: 'deduced', statement_text: STATEMENT, proof_text: 'P.', external_refs: CUT }] })).data.created[0].id;
  const titled = await danus({ title: 'A real title', external_refs: [{ key: 'K', title: 'Good, already' }] });
  const broken = await danus({ external_refs: ['{broken', 'not json'] });
  assert.equal(php('--apply').status, 0);
  const h = await get(human); assert.equal(h.kind, 'lemma'); assert.equal(h.title, STATEMENT.slice(0, 90)); assert.deepEqual(h.external_refs, CUT);
  const t = await get(titled); assert.equal(t.title, 'A real title'); assert.deepEqual(t.external_refs, [{ key: 'K', title: 'Good, already' }]);
  assert.deepEqual((await get(broken)).external_refs, ['{broken', 'not json']);
});

test('it runs only from the command line, and refuses unknown options', async () => {
  assert.equal(php('--force').status, 1);
  for (const f of ['migrate-facts.php', 'migrate-facts-preview.php', 'migrate-facts-apply.php', 'migrate-facts-undo.php']) {
    const r = spawnSync('php', ['-r', `$_SERVER['REQUEST_METHOD'] = 'GET'; include 'bin/${f}'; echo 'ran';`], { cwd: app.dir, encoding: 'utf8' });
    assert.doesNotMatch(r.stdout, /ran|Preview|Applied|Undone/, f);
  }
  const web = await fetch(`${app.base}/bin/migrate-facts-apply.php`);
  assert.doesNotMatch(await web.text(), /Applied|Backup created/);
});

test('the scheduled-task files are deployed, and each has one fixed action', () => {
  const remotes = deployFiles('.').map((f) => f.remote);
  for (const f of ['src/FactMigration.php', 'bin/migrate-facts.php', 'bin/migrate-facts-preview.php', 'bin/migrate-facts-apply.php', 'bin/migrate-facts-undo.php']) assert.ok(remotes.includes(f), f);
  assert.doesNotMatch(fs.readFileSync('bin/migrate-facts-preview.php', 'utf8'), /--apply|--undo/);
  assert.match(fs.readFileSync('bin/migrate-facts-apply.php', 'utf8'), /'--apply'/);
  assert.match(fs.readFileSync('bin/migrate-facts-undo.php', 'utf8'), /'--undo'/);
});

test('the SSH command is fixed, quoted and uses a recent PHP', () => {
  const c = remoteCommand('projects', 'apply');
  assert.match(c, /^cd 'projects' \|\| exit 1;/); assert.match(c, /php8\.2\/bin\/php/); assert.match(c, /PHP_VERSION_ID >= 80100/); assert.match(c, /bin\/migrate-facts\.php --apply$/);
  assert.match(remoteCommand('projects', 'preview'), /bin\/migrate-facts\.php$/);
  assert.match(remoteCommand('projects', 'details'), /--details$/); assert.match(remoteCommand('projects', 'undo'), /--undo$/);
  for (const bad of ['a b', 'x;rm', '../up', '$(id)']) assert.throws(() => remoteCommand(bad, 'preview'));
  assert.throws(() => remoteCommand('projects', 'constructor'));
  assert.ok(hasChanges('To update: 1 kind(s), 0 title(s), 0 revision(s) with external references.'));
  assert.ok(!hasChanges('To update: 0 kind(s), 0 title(s), 0 revision(s) with external references.'));
  assert.ok(!hasChanges('something else'));
});

test('over SSH, nothing is applied or undone without the typed confirmation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-ssh-')); const log = path.join(dir, 'log');
  fs.writeFileSync(path.join(dir, 'ssh'), `#!/bin/sh
for a; do last="$a"; done
case "$*" in *"-O exit"*) exit 0;; esac
echo "$last" >> "${log}"
case "$last" in
  *--apply) echo "Applied: 3 change(s)."; exit 0;;
  *--undo) echo "Undone: 3 value(s) restored."; exit 0;;
  *) if [ -f "${dir}/empty" ]; then echo "To update: 0 kind(s), 0 title(s), 0 revision(s) with external references."; elif [ -f "${dir}/down" ]; then echo "failed" >&2; exit 255; else echo "To update: 1 kind(s), 1 title(s), 1 revision(s) with external references."; fi;;
esac
`, { mode: 0o755 });
  const go = (input, ...args) => {
    fs.rmSync(log, { force: true });
    const r = spawnSync('node', ['scripts/migrate-facts.mjs', '--host', 'test.invalid', '--user', 'u', '--dir', 'projects', '--site', 'none', ...args], { input, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 20000 });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...r, applied: calls.some((x) => x.endsWith('--apply')), undone: calls.some((x) => x.endsWith('--undo')), calls: calls.length };
  };
  try {
    let r = go('APPLY\n'); assert.equal(r.status, 0, r.stderr); assert.ok(r.applied); assert.equal(r.calls, 2); assert.match(r.stdout, /Applied/);
    for (const answer of ['no\n', 'apply\n', 'YES\n', '\n', '']) { r = go(answer); assert.ok(!r.applied, JSON.stringify(answer)); assert.equal(r.calls, 1); }
    r = go('APPLY\n', '--preview'); assert.ok(!r.applied); assert.equal(r.calls, 1);
    r = go('UNDO\n', '--undo'); assert.ok(r.undone); assert.equal(r.calls, 1);
    r = go('APPLY\n', '--undo'); assert.ok(!r.undone); assert.equal(r.calls, 0);
    assert.notEqual(go('', '--undo', '--preview').status, 0);
    fs.writeFileSync(path.join(dir, 'empty'), ''); r = go('APPLY\n'); assert.ok(!r.applied); assert.match(r.stdout, /Nothing to apply/); fs.rmSync(path.join(dir, 'empty'));
    fs.writeFileSync(path.join(dir, 'down'), ''); r = go('APPLY\n'); assert.ok(!r.applied); assert.equal(r.status, 255);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
