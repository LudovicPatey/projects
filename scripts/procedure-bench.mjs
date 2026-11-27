// Runs the platform's AI procedures with a real model on a copy of real data, and checks what they produced. The live site is never
// touched: a throwaway local platform is seeded from an audit export (npm run audit:fetch), and the real client (client/oq.py) runs
// its sweeps with the AI tool of this computer. It writes a report to read: automatic checks, then each result for a person to judge.
//
//   node scripts/procedure-bench.mjs --export audit/<folder> [--facts 1199-1208,1275-1292] [--provider claude|codex] [--model M]
//                                    [--second-provider codex] [--tasks 12] [--timeout 900]
//
// --second-provider runs the proof reviews again with another tool, as a second model would on the platform.
// --no-limits lifts the usage limits of the bench's own client (see below).
// --repair (with --second-provider) then alternates the two tools on the repairs of proofs the reviews found flawed, as clients of
// two companies would, until no step is due or 2 × ProofRepair::ROUNDS runs have passed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from '../tests/harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const exportDir = opt('--export');
if (!exportDir) { console.error('Give --export audit/<folder> (npm run audit:fetch writes one).'); process.exit(1); }
const ranges = opt('--facts', '1199-1208,1275-1292').split(',').flatMap((r) => { const [a, b] = r.split('-').map(Number); return Array.from({ length: (b || a) - a + 1 }, (_, i) => a + i); });
const provider = opt('--provider', 'claude'); const model = opt('--model', ''); const second = opt('--second-provider', '');
const maxTasks = Number(opt('--tasks', '12')); const timeout = Number(opt('--timeout', '900'));
const out = path.join(ROOT, exportDir, `bench-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`);
fs.mkdirSync(out, { recursive: true });
const log = (m) => { console.log(m); fs.appendFileSync(path.join(out, 'run.log'), m + '\n'); };

// ---- a copy of the sample ----------------------------------------------------------------------------------------------------
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, exportDir, 'facts.json'), 'utf8'));
const notation = JSON.parse(fs.readFileSync(path.join(ROOT, exportDir, 'notation.json'), 'utf8'));
const wanted = new Set(ranges);
const sample = facts.filter((f) => wanted.has(f.id) && !f.retracted_at);
const app = await startApp({ config: { sweeps: { quiet_minutes: 0, check_minutes: 0, rewrite_hours: 0, source_hours: 0, check_hours: 0, second_hours: 0, symbols_hours: 0, review_hours: 0, consolidate_hours: 0 } } });
const ann = await app.signIn('0000-0002-1825-0097');
const pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Procedure bench', question_html: '<p>A copy of real data, for testing the AI procedures.</p>' })).data.id;
const key = (await app.call(ann, 'POST', '/api/me/keys', { name: 'bench' })).data.token;
const bib = new Map();
for (const s of sample.flatMap((f) => f.sources || [])) {
  if (s.type !== 'bib' || !s.label || bib.has(s.label)) continue;
  const r = await app.call(ann, 'POST', `/api/projects/${pid}/bib`, { fields: { title: s.label, author: s.author?.name || 'Unknown', year: '2000' }, cite_key: `b${bib.size + 1}` });
  bib.set(s.label, r.data.created?.[0]);
}
const byModel = new Map();
for (const f of sample) { const m = f.ai_model || 'unspecified'; if (!byModel.has(m)) byModel.set(m, []); byModel.get(m).push(f); }
const ids = new Map();
for (const [m, list] of byModel) {
  // Dependencies inside the sample first, so that each batch only names facts already there or in it.
  const r = await app.call({ token: key }, 'POST', `/api/projects/${pid}/facts/batch`, { format: 'native', ai_model: m, facts: list.map((f) => ({
    ref: `f${f.id}`, title: f.title, kind: f.kind, labels: f.labels?.length ? f.labels : ['conclusion'], method: f.method || 'extracted',
    statement_text: f.statement_text, proof_text: f.proof_text || '', glossary: f.glossary || undefined,
    depends_on: (f.deps || []).filter((d) => wanted.has(d.id)).map((d) => ids.get(d.id) ? String(ids.get(d.id)) : `f${d.id}`),
    external_refs: f.external_refs || undefined,
    sources: (f.sources || []).filter((s) => s.type === 'bib' && bib.get(s.label)).map((s) => ({ type: 'bib', id: bib.get(s.label), quote: s.quote || '', page: s.page || undefined, covers: s.covers || 'statement' })),
  })) });
  if (r.status >= 300) { log(`! facts of ${m} refused: ${JSON.stringify(r.data).slice(0, 400)}`); continue; }
  for (const c of r.data.created) ids.set(Number(c.ref.slice(1)), c.id);
  for (const e of r.data.errors || []) log(`! ${e.ref}: ${e.error}`);
}
for (const e of notation.entries.filter((x) => ['agreed', 'local'].includes(x.status))) {
  const r = await app.call(ann, 'POST', `/api/projects/${pid}/notation`, { symbol: e.symbol, meaning_text: e.meaning || e.symbol, note_text: e.note || '', variants: e.variants || [], ...(e.params?.length ? { params: e.params.filter((p) => p.type).length ? e.params : undefined } : {}) });
  if (r.status < 300) await app.call(ann, 'POST', `/api/notation/${r.data.id}/status`, { status: e.status });
}
log(`Copied ${ids.size} of ${sample.length} facts, ${bib.size} references and the agreed and local notation → ${app.base}, project ${pid}.`);

// ---- the real client ----------------------------------------------------------------------------------------------------------
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-bench-'));
const env = { ...process.env, OQ_CONFIG_DIR: cfg, OQ_URL: app.base, OQ_KEY: key, PATH: `${path.join(os.homedir(), '.local/bin')}:${process.env.PATH}` };
const client = (argv) => spawnSync('python3', [path.join(ROOT, 'client/oq.py'), ...argv], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
client(['procedures', '--on', 'proof_review']); client(['procedures', '--auto', 'on']);
// --no-limits: this throwaway client may use the whole subscription and has no daily cap (0), so that a long run is not cut short.
// The limits of the computer's own client, in its own configuration folder, are not touched.
if (args.includes('--no-limits')) client(['limits', '--max-session-percent', '100', '--max-weekly-percent', '100', '--tasks-per-day', '0', '--minutes-per-day', '0', '--tokens-per-day', '0']);
const run = (prov, limit, only = null) => {
  const started = Date.now();
  const r = client(['run', '--once', '--project', String(pid), '--provider', prov, ...(model && prov === provider ? ['--model', model] : []), '--limit', String(limit), '--timeout', String(timeout), '--name', 'bench', ...(only ? ['--only', only] : [])]);
  fs.appendFileSync(path.join(out, 'client.log'), `\n===== ${prov}${only ? ` (${only})` : ''} =====\n${r.stdout}\n${r.stderr}`);
  log(`${prov}${only ? ` (${only})` : ''}: client stopped with exit ${r.status} after ${Math.round((Date.now() - started) / 1000)} s.`);
};
if (!args.includes('--seed-only')) {
  run(provider, maxTasks);
  if (second) run(second, 4);
  if (second && args.includes('--repair')) {
    const due = async () => (await Promise.all([...ids.values()].map(async (id) => (await app.call(ann, 'GET', `/api/facts/${id}`)).data.repairs?.[0]?.state))).filter((s) => s === 'repair' || s === 'check').length;
    for (let i = 0; i < 6 && await due(); i++) run(i % 2 ? second : provider, 6, 'proof_repair,repair_check');
  }
}

// ---- what came out -------------------------------------------------------------------------------------------------------------
const get = async (u) => (await app.call(ann, 'GET', u)).data;
const ai = await get(`/api/projects/${pid}/ai`);
const n = await get(`/api/projects/${pid}/notation`);
const detail = [];
for (const [orig, id] of ids) detail.push({ orig, ...(await get(`/api/facts/${id}`)) });
const checks = []; const flag = (ok, what) => checks.push(`${ok ? '✓' : '✗'} ${what}`);
const tasks = ai.tasks || [];
for (const t of tasks) flag(t.status === 'done', `task ${t.id} ${t.kind}${t.source_type ? ` (${t.source_type})` : ''}: ${t.status}${t.error_text ? ` — ${t.error_text}` : ''}${t.summary_text ? ` — ${t.summary_text}` : ''}`);
for (const s of n.shared) {
  if (!s.classes?.length) continue;
  flag(!s.unclassified.length, `${s.symbol}: every wording in a group (${s.meanings.length} wordings, ${s.classes.length} groups)`);
  flag(s.classes.every((c) => c.label.trim()), `${s.symbol}: every group has a label`);
}
for (const e of n.entries) for (const p of e.params || []) if (p.type && /not a (variable|parameter)/i.test(p.type)) flag(false, `${e.symbol}: "${p.name}" typed "${p.type}" is still listed as a parameter`);
const rewrites = detail.flatMap((f) => (f.rephrasings || []).filter((x) => x.current && !x.unchanged).map((x) => ({ f, x })));
flag(rewrites.every(({ x }) => x.check_verdict), `every rewrite checked (${rewrites.filter(({ x }) => x.check_verdict).length} of ${rewrites.length})`);
const reviews = detail.flatMap((f) => (f.reviews || []).filter((v) => v.reviewer_kind === 'agent').map((v) => ({ f, v })));
flag(reviews.every(({ v }) => (v.body_text || v.body_html || '').trim() || v.verdict === 'correct'), `every gap or error explained (${reviews.length} AI reviews)`);
flag(reviews.every(({ f, v }) => (v.ai_model || '').toLowerCase() !== (f.ai_model || '').toLowerCase()), 'no model reviewed a proof it wrote');
const repairs = detail.flatMap((f) => f.repairs || []);
flag(repairs.every((r) => !['repair', 'check'].includes(r.state)), `every repair settled (${repairs.map((r) => r.state).join(', ') || 'none started'})`);

// ---- the report ------------------------------------------------------------------------------------------------------------------
const md = [`# Procedure bench, ${new Date().toISOString().slice(0, 16)}`, '', `Facts ${ranges[0]}–${ranges.at(-1)} of ${exportDir}, run with ${provider}${model ? ` (${model})` : ''}${second ? ` then ${second} for proof reviews` : ''}.`, '',
  '## Automatic checks', '', ...checks.map((c) => `- ${c}`), '',
  '## Symbols: groups of wordings and decisions', ''];
for (const s of n.shared) {
  md.push(`### ${s.symbol} (${s.facts} facts)${s.entry ? ` → entry ${s.entry.status}` : ''}`, '');
  for (const c of s.classes || []) md.push(`- **${c.label}** → ${c.entry ? `${c.entry.symbol} (${c.entry.status})` : 'no entry'}: ${c.meanings.map((i) => `“${s.meanings[i].meaning}”`).join('; ')}`);
  for (const i of s.unclassified || []) md.push(`- not grouped: “${s.meanings[i].meaning}”`);
  md.push('');
}
md.push('## Notation entries the AI wrote or typed', '');
for (const e of n.entries.filter((x) => x.decided_by_kind === 'consolidation' || (x.params || []).some((p) => p.type))) {
  md.push(`- ${e.symbol} (${e.status}): ${e.meaning_text}${(e.params || []).length ? ` — parameters: ${e.params.map((p) => `${p.name}: ${p.type || '?'}`).join('; ')}` : ''}${e.fixed?.length ? ` — not parameters: ${e.fixed.join(', ')}` : ''}`);
}
md.push('', '## Rewrites in the project notation, with their check', '');
for (const { f, x } of rewrites) md.push(`### ${f.label} — ${x.check_verdict || 'not checked'}${x.check_note ? `: ${x.check_note}` : ''}`, '', `Original: ${f.statement_text}`, '', `Rewrite: ${x.statement_text || x.statement_html}`, '');
md.push('## Proof reviews', '');
for (const { f, v } of reviews) md.push(`### ${f.label} — ${v.verdict} (${v.ai_model}; proof written by ${f.ai_model})`, '', (v.body_text || v.body_html || '').replace(/<[^>]+>/g, ''), '');
md.push('## Repairs of proofs', '');
for (const f of detail) for (const r of f.repairs || []) {
  md.push(`### ${f.label} — ${r.state}, round ${r.round} of ${r.rounds}`, '');
  for (const x of r.steps) md.push(`- **${x.step}** by ${x.model || x.person || '?'}: ${x.verdict || x.outcome || ''}${x.proof_id ? ` (proof ${x.proof_id})` : ''}`, '', `  ${String(x.text || '').replace(/\n/g, '\n  ')}`, '');
  const p = (f.proofs || []).find((y) => y.id === r.proof_id);
  if (p) md.push('Repaired proof:', '', (p.body_text || p.body_html || '').replace(/<[^>]+>/g, ''), '');
}
md.push('## Source checks', '');
for (const f of detail) for (const c of f.source_checks || []) md.push(`- ${f.label}: ${c.verdict}${c.had_source ? ' (with the source)' : ' (without the source text)'} — ${(c.body_text || c.body_html || '').replace(/<[^>]+>/g, '').slice(0, 300)}`);
fs.writeFileSync(path.join(out, 'report.md'), md.join('\n') + '\n');
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ tasks, notation: n, facts: detail }, null, 1));
log(`\nReport: ${path.relative(ROOT, path.join(out, 'report.md'))}\n${checks.filter((c) => c.startsWith('✗')).length} automatic checks failed.`);
fs.rmSync(cfg, { recursive: true, force: true });
app.stop();
