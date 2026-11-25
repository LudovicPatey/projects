// Follows the original Danus, so that its improvements can be audited and carried over:
// to the native prover, which adapts its instructions, and to the Danus integration of the client.
//
//   npm run danus:upstream                 what changed upstream since the commit we follow, and whether our integration still fits
//   npm run danus:upstream -- --branch main   the same for another branch (main runs its lead agent on Claude Code)
//   npm run danus:upstream -- --vendor     writes the copies of the files we adapt, at the commit we follow
//   npm run danus:upstream -- --accept     after the audit: follow the upstream head (manifest, copies, DANUS_COMMIT in client/oq.py)
//
// The full report goes to cache/danus-upstream-report.md. Environment: DANUS_UPSTREAM_URL and DANUS_UPSTREAM_DIR (for tests).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const here = path.join(root, 'third_party/danus');
const manifestPath = path.join(here, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const branch = option('--branch', manifest.branch);
const url = process.env.DANUS_UPSTREAM_URL || manifest.repository;
const repo = process.env.DANUS_UPSTREAM_DIR || path.join(root, 'cache/danus-upstream');
const reportPath = option('--report', path.join(root, 'cache/danus-upstream-report.md'));
const clientPath = path.join(root, 'client/oq.py');

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };
const pinnedInClient = () => fs.readFileSync(clientPath, 'utf8').match(/^DANUS_COMMIT = "([0-9a-f]{40})"/m)?.[1];

// A local clone, kept in cache/ (never committed), fetched again each time.
if (!fs.existsSync(path.join(repo, '.git'))) {
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--no-checkout', url, repo]);
} else {
  git('remote', 'set-url', 'origin', url);
}
git('fetch', '--quiet', '--prune', 'origin');
const head = git('rev-parse', `origin/${branch}`).trim();
const pin = manifest.commit;
const show = (commit, file) => tryGit('show', `${commit}:${file}`);
const tracked = { ...manifest.adapted, ...manifest.integration };

/** The copies of what the native prover adapts, with the license, at one commit. */
function vendor(commit) {
  const dir = path.join(here, 'upstream');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const file of [...Object.keys(manifest.adapted), 'LICENSE', 'NOTICE']) {
    const text = show(commit, file);
    if (text === null) { if (file !== 'NOTICE') console.log(`missing at ${commit.slice(0, 7)}: ${file}`); continue; }
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

if (flag('--vendor')) {
  vendor(pin);
  console.log(`Copied ${Object.keys(manifest.adapted).length} files and the license of Danus at ${pin.slice(0, 7)} into third_party/danus/upstream.`);
  process.exit(0);
}

if (flag('--accept')) {
  if (head === pin) { console.log('Already following the upstream head.'); process.exit(0); }
  vendor(head);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, branch, commit: head }, null, 2)}\n`);
  const client = fs.readFileSync(clientPath, 'utf8');
  fs.writeFileSync(clientPath, client.replace(/^DANUS_COMMIT = "[0-9a-f]{40}"/m, `DANUS_COMMIT = "${head}"`));
  console.log(`Now following ${branch} at ${head.slice(0, 7)}: manifest, copies and DANUS_COMMIT updated.`);
  console.log('Raise VERSION in client/oq.py and client/desktop/package.json: installed clients move to this Danus with the next release.');
  process.exit(0);
}

// ----- the audit -----
const out = [`# Danus upstream audit`, '', `Following ${manifest.repository}, branch \`${manifest.branch}\` at \`${pin.slice(0, 7)}\`. Compared with \`${branch}\` at \`${head.slice(0, 7)}\`.`, ''];
const say = (...lines) => { out.push(...lines); };
const problems = [];
if (pinnedInClient() !== pin) problems.push(`client/oq.py installs Danus at ${pinnedInClient()?.slice(0, 7)}, but the manifest follows ${pin.slice(0, 7)}.`);
const commits = head === pin ? [] : (tryGit('log', '--oneline', '--no-decorate', `${pin}..${head}`) ?? '').trim().split('\n').filter(Boolean);
const diverged = head !== pin && tryGit('merge-base', '--is-ancestor', pin, head) === null;

say(`## Commits since the pin (${commits.length})`, '');
if (diverged) say('The branch does not contain the pinned commit: it was rewritten, or this is another line of work. Compare the files below.');
for (const c of commits.slice(0, 200)) say(`- ${c}`);
say('');

const changed = { adapted: [], integration: [] };
for (const [group, files] of Object.entries({ adapted: manifest.adapted, integration: manifest.integration })) {
  say(`## ${group === 'adapted' ? 'Files the native prover adapts' : 'Files the Danus integration depends on'}`, '');
  for (const [file, where] of Object.entries(files)) {
    const before = show(pin, file); const after = show(head, file);
    if (after === null) { changed[group].push(file); say(`- **${file}**: removed or moved upstream. Used by ${where}.`); continue; }
    if (before === after) continue;
    changed[group].push(file);
    const diff = tryGit('diff', pin, head, '--', file) ?? '';
    say(`### ${file}`, '', `Used by ${where}.`, '', '```diff', diff.trim(), '```', '');
  }
  if (!changed[group].length) say('No change.', '');
}

// Does our macOS patch still apply, and does the merge still run with Danus's own code, at the head?
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'danus-upstream-'));
const tree = path.join(tmp, 'tree');
let patch = 'not checked'; let merge = 'not checked';
try {
  git('worktree', 'add', '--detach', tree, head);
  const py = (code) => spawnSync('python3', ['-c', `import importlib.util, sys\nspec = importlib.util.spec_from_file_location("oq", sys.argv[1]); oq = importlib.util.module_from_spec(spec); spec.loader.exec_module(oq)\n${code}`, clientPath], { encoding: 'utf8' });
  fs.writeFileSync(path.join(tmp, 'macos.patch'), py('sys.stdout.write(oq.DANUS_MACOS_PATCH)').stdout);
  const apply = spawnSync('git', ['-C', tree, 'apply', '--check', path.join(tmp, 'macos.patch')], { encoding: 'utf8' });
  patch = apply.status === 0 ? 'applies' : `does not apply: ${apply.stderr.trim().split('\n').slice(0, 4).join(' ')}`;
  if (apply.status !== 0) problems.push(`The macOS patch (DANUS_MACOS_PATCH) ${patch}`);
  const projects = path.join(tmp, 'projects'); fs.mkdirSync(path.join(projects, 'audit'), { recursive: true });
  const code = py('sys.stdout.write(oq.DANUS_MERGE)').stdout;
  const sample = { facts: [
    { id: 1, label: 'l1', title: 'a', kind: 'lemma', revision: 1, basis: 'proved', status: 'human_checked', trusted: true, deps: [], statement: 'A.', proof: 'P.', glossary: { B: 'a block' }, external_refs: null },
    { id: 2, label: 'l2', title: 'b', kind: 'lemma', revision: 1, basis: 'proved', status: 'unchecked', trusted: false, deps: [1], statement: 'B.', proof: 'Q.', glossary: null, external_refs: null }],
  strategies: [{ id: 3, title: 'Try X', status: 'abandoned', body: 'No.' }] };
  const run = spawnSync('python3', ['-c', code, 'audit'], { cwd: tree, input: JSON.stringify(sample), encoding: 'utf8', env: { ...process.env, PYTHONPATH: tree, DANUS_AGENTS_ROOT: projects } });
  const result = run.status === 0 ? JSON.parse(run.stdout.trim().split('\n').pop() || '{}') : null;
  merge = result && result.building_on === 1 && result.claims === 1 && result.strategies === 1 ? 'runs with its storage code' : `fails: ${(run.stderr || run.stdout).trim().slice(-300)}`;
  if (!merge.startsWith('runs')) problems.push(`The merge into Danus (DANUS_MERGE) ${merge}`);
} finally {
  tryGit('worktree', 'remove', '--force', tree);
  fs.rmSync(tmp, { recursive: true, force: true });
}
say('## Integration checks at the head', '', `- macOS patch: ${patch}`, `- Merge of the platform's facts: ${merge}`, '');
say('## What to do', '', commits.length || changed.adapted.length || changed.integration.length
  ? '1. Read the changes above. 2. Carry the improvements of the adapted files into client/oq.py (PROVER_*), as text adapted to the platform. 3. Fix the integration if a check fails. 4. Run `npm run danus:upstream -- --accept`, raise the client version, and run `npm test`.'
  : 'Nothing to do: upstream has not changed since the pin.');
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${out.join('\n')}\n`);

console.log(`Danus ${branch}: ${head === pin ? 'at the pinned commit' : `${commits.length} commit(s) since ${pin.slice(0, 7)}${diverged ? ' (diverged)' : ''}`}.`);
console.log(`Adapted files changed: ${changed.adapted.length ? changed.adapted.join(', ') : 'none'}.`);
console.log(`Integration files changed: ${changed.integration.length ? changed.integration.join(', ') : 'none'}.`);
console.log(`macOS patch: ${patch}. Merge: ${merge}.`);
for (const p of problems) console.log(`Problem: ${p}`);
console.log(`Report: ${path.relative(root, reportPath)}`);
process.exit(problems.length ? 2 : 0);
