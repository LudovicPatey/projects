// Downloads one project's facts through the audit API, for an audit on this computer (docs/AGENT_API.md, "Audit API").
//
//   OQ_AUDIT_URL=https://projects.example.org OQ_AUDIT_KEY=oqa_… npm run audit:fetch
//
// The key comes from the environment, never from a file of the repository, and is never printed.
// Everything is written to audit/ (git-ignored): project.json, graph.json, notation.json, facts.json, and facts/*.md to read.
import fs from 'node:fs';
import path from 'node:path';

process.chdir(path.resolve(import.meta.dirname, '..'));
const fail = (m) => { console.error(m); process.exit(1); };
const site = String(process.env.OQ_AUDIT_URL || '').replace(/\/+$/, '');
const key = String(process.env.OQ_AUDIT_KEY || '');
if (!site || !key) fail('Set OQ_AUDIT_URL and OQ_AUDIT_KEY: an owner creates the key in Admin, Audit access.');
if (!/^oqa_[0-9a-f]{48}$/.test(key)) fail('OQ_AUDIT_KEY does not look like an audit key (oqa_…).');
let url;
try { url = new URL(site); } catch { fail('OQ_AUDIT_URL is not an address.'); }
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (url.protocol !== 'https:' && !local) fail('The key is only sent over https.');

const get = async (route) => {
  const r = await fetch(`${site}${route}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) fail(`${route}: ${body.error || `HTTP ${r.status}`}`);
  return body;
};

const project = await get('/api/audit/project');
const graph = await get('/api/audit/graph');
const notation = await get('/api/audit/notation');
const facts = [];
for (let offset = 0; offset !== null;) {
  const page = await get(`/api/audit/facts?offset=${offset}`);
  facts.push(...page.facts);
  process.stdout.write(`\r${facts.length} / ${page.total} facts`);
  offset = page.next;
}
process.stdout.write('\n');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = path.join('audit', `${url.hostname}-project-${project.project.id}-${stamp}`);
fs.mkdirSync(path.join(dir, 'facts'), { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));
write('project.json', project); write('graph.json', graph); write('notation.json', notation); write('facts.json', facts);
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 80);
for (const f of facts) {
  const lines = [`# ${f.label}: ${f.title}`, '', `kind: ${f.display_kind || f.kind} · status: ${f.status} · chain: ${f.chain} · method: ${f.method} · model: ${f.ai_model || ''}`, '',
    '## Statement', '', f.statement_text || '', ''];
  if (f.proof_text) lines.push('## Proof', '', f.proof_text, '');
  const own = Object.entries(f.glossary || {});
  if (own.length) lines.push('## Notation in this fact', '', ...own.map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`), '');
  if (f.deps?.length) lines.push('## Depends on', '', ...f.deps.map((d) => `- ${d.label}: ${d.title}`), '');
  if (f.sources?.length) lines.push('## Sources', '', ...f.sources.map((s) => `- ${s.label || s.type}${s.page ? `, p. ${s.page}` : ''} (${s.covers})${s.quote ? `: "${s.quote}"` : ''}`), '');
  const reviews = (f.reviews || []).filter((v) => v.revision_no === f.current_revision);
  if (reviews.length) lines.push('## Reviews', '', ...reviews.map((v) => `- ${v.verdict}${v.statement_verdict && v.verdict !== 'correct' ? ` (result: ${v.statement_verdict})` : ''} by ${v.reviewer_name}${v.ai_model ? ` (${v.ai_model})` : ''}${v.body_text ? `: ${v.body_text}` : ''}`), '');
  fs.writeFileSync(path.join(dir, 'facts', `${String(f.id).padStart(6, '0')}-${safe(f.label)}.md`), lines.join('\n'));
}
console.log(`Saved to ${dir}: ${facts.length} facts, ${graph.edges.length} dependencies, ${notation.entries.length} notation entries.`);
