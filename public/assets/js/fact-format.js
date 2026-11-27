// A reading view of facts. It adds layout and typesets formulas in LaTeX. Each formula is read back
// and compared with the stored text; if they differ, the original is shown. Dependency-free for tests.
import { spelledGreek } from './bare-tex.js';

const HEAD = /^(PROOF OF [^.]{1,30}\.|Proof of (?:the )?[^.:]{1,50}[.:]|Proof[.:]|(?:Main )?(?:Theorem|Lemma|Proposition|Corollary|Definition|Conventions?|Notation|Setup)(?: \d+(?:\.\d+)*)?[.:])(?:\s+|$)/;
const LEAD = /^(?!(?:By|Using|From|Then|Since|Apply|Applying|See|In|Thus|Hence|Now|And|Let|With|Note|Recall|Given|Following|As|If|For|To|This|The)\b)((?:[A-Z][\w-]* ){0,2}(?:Claim|Lemma|Fact|Observation|Remark|Case \d+|Step \d+)(?: \d+)?[.:]|[A-Z][a-z]{3,}\.)\s+/;
const ITEM = /^\(([ivx]{1,5}|[a-z])\)\s+/;
const NUMBERED = /^\((\d{1,3})\)\s+/;
const BULLET = /^-\s+/;
const OTHER_BLOCKS = /<(?:ul|ol|li|pre|blockquote|h[1-6]|table|div|section)\b/i;

const plain = (html) => String(html).replace(/<[^>]*>/g, '').replace(/[\s_^{}]/g, '');
const bodyText = (html) => String(html).replace(/<[^>]*>/g, '');

const SYMBOLS = {
  '∪': 'cup', '∩': 'cap', '⊆': 'subseteq', '⊂': 'subset', '⊇': 'supseteq', '⊃': 'supset', '∈': 'in', '∉': 'notin', '→': 'to', '↦': 'mapsto',
  '≤': 'le', '≥': 'ge', '≠': 'ne', '≡': 'equiv', '≈': 'approx', '∀': 'forall', '∃': 'exists', '¬': 'neg', '∧': 'land', '∨': 'lor', '⊕': 'oplus',
  '×': 'times', '·': 'cdot', '∘': 'circ', '↾': 'restriction', '∅': 'emptyset', '∞': 'infty', '…': 'ldots',
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'varepsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi',
  π: 'pi', ρ: 'rho', σ: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'varphi', χ: 'chi', ψ: 'psi', ω: 'omega', Γ: 'Gamma', Δ: 'Delta', Θ: 'Theta', Λ: 'Lambda', Ξ: 'Xi', Π: 'Pi', Σ: 'Sigma', Φ: 'Phi', Ψ: 'Psi', Ω: 'Omega',
};
const FUNCTIONS = new Set(['max', 'min', 'exp', 'log', 'sup', 'inf', 'lim', 'gcd', 'det', 'dim', 'ker']);
const UNSYMBOLS = Object.entries(SYMBOLS).map(([c, n]) => [`\\${n} `, c]).sort((x, y) => y[0].length - x[0].length);
const canon = (x) => String(x).replace(/′/g, "'").replace(/[\s_^{}]/g, '');

/** LaTeX for one formula in plain or entity-escaped text. Throws on anything it does not fully understand. */
function toTex(s) {
  let out = ''; let last = '';
  for (let i = 0; i < s.length;) {
    const c = s[i]; const rest = s.slice(i);
    const ent = rest.match(/^&(lt|gt|amp);/);
    if (ent) { out += { lt: '\\lt ', gt: '\\gt ', amp: '\\&amp;' }[ent[1]]; i += ent[0].length; last = ''; continue; }
    if (c === '&' || c === '\\' || c === '$' || c === '%' || c === '#' || c === '~') throw new Error('unsupported');
    if (c === '_' || c === '^') {
      if (c === last || !out) throw new Error('double script');
      let arg; let next;
      if (s[i + 1] === '{') {
        let depth = 0; let j = i + 1;
        for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}' && --depth === 0) break; }
        if (j >= s.length) throw new Error('unbalanced');
        arg = s.slice(i + 2, j); next = j + 1;
      } else {
        const m = s.slice(i + 1).match(/^(\d+|\p{L}|[+∞*])/u);
        if (!m) throw new Error('empty script');
        arg = m[1]; next = i + 1 + m[1].length;
      }
      out += `${c}{${toTex(arg)}}`; i = next; last = c;
      continue;
    }
    if (rest.startsWith('...')) { out += '\\dots '; i += 3; last = ''; continue; }
    if (SYMBOLS[c]) { out += `\\${SYMBOLS[c]} `; i++; last = ''; continue; }
    if (c === '{' || c === '}') { out += `\\${c} `; i++; last = ''; continue; }
    const word = rest.match(/^[A-Za-z]{2,}/);
    if (word) {
      const w = word[0];
      out += FUNCTIONS.has(w) ? `\\${w} ` : w === 'mod' ? '\\operatorname{mod} ' : /^[A-Z]+$/.test(w) ? `\\mathrm{${w}}` : `\\text{${w}}`;
      i += w.length; last = '';
      continue;
    }
    // The induction or comprehension of a scheme, IΣ^0_2: its letter is a name, upright.
    if (/[A-Z]/.test(c) && /^[ΣΠΔ]/.test(s[i + 1] || '')) { out += `\\mathrm{${c}}`; i++; last = ''; continue; }
    // The hyphen of a system's name, Π^1_1-CA_0, is not a minus.
    if (c === '-' && (last === '_' || last === '^' || /[}]$/.test(out)) && /^-[A-Z]{2,}/.test(rest)) { out += '\\text{-}'; i++; last = ''; continue; }
    if (/[A-Za-z0-9\s()[\]+\-=/,:;|!'*.]/.test(c) || c === '′') { out += c === '′' ? "'" : c; i++; if (c !== "'" && c !== '′') last = ''; continue; }
    throw new Error('unsupported');
  }
  return out;
}

/** Reads the LaTeX back, so that a formula is shown only if it holds exactly the original symbols. */
function fromTex(tex) {
  let x = tex.replace(/\\(?:text|mathrm|operatorname)\{([^}]*)\}/g, '$1').replace(/\\dots /g, '...').replace(/\\lt /g, '&lt;').replace(/\\gt /g, '&gt;').replace(/\\&amp;/g, '&amp;').replace(/\\([{}]) /g, '$1');
  for (const f of FUNCTIONS) x = x.split(`\\${f} `).join(f);
  for (const [cmd, c] of UNSYMBOLS) x = x.split(cmd).join(c);
  return x;
}

const safeTex = (raw) => {
  try { const tex = toTex(raw); const back = fromTex(tex); return canon(back) === canon(raw) && !back.includes('\\') ? tex : null; } catch { return null; }
};

const MATH_SIGNAL = /[∪∩⊆⊂⊇⊃∈∉→↦≤≥≠≡≈∀∃¬∧∨⊕×·∘↾∅∞_^=|+{]|&lt;|&gt;/;
const OPERATOR = /^(?:=|≤|≥|≠|≡|≈|&lt;|&gt;|\+|-|∈|∉|⊆|⊂|→|↦|·|×|∪|∩)$/;
const ENDS_IN_OPERATOR = /(?:[=≤≥≠≡≈+∈∉⊆⊂→↦·×∪∩]|&lt;|&gt;)$/;
const core = (w) => w.replace(/[,.;:…]+$/, '');
const balance = (s) => {
  let a = 0; let b = 0;
  for (const c of s) { if (c === '{') a++; else if (c === '}') a--; else if (c === '(') b++; else if (c === ')') b--; }
  return [a, b];
};

function isMathWord(word, previous) {
  const c = core(word);
  if (!c || /^\([^()]\)$/.test(c) || /^\(\d+\)$/.test(c)) return false;
  if (MATH_SIGNAL.test(c) || /^[α-ωΑ-Ω]/.test(c)) return true;
  if (/^[A-Za-z]{1,4}\(.*\)/.test(c) || /^\([\w,]+,[\w,]+\)$/.test(c) || /^\d+[a-zA-Z]$/.test(c)) return true;
  if (/^[b-hj-zB-HJ-Z]$/.test(c)) return true;
  return c === 'A' && !!previous && !/[.:;!?]$/.test(previous);
}

/** Puts the formulas of a text in LaTeX. A formula that cannot be converted exactly stays as written. */
function mathSpans(text) {
  const parts = text.split(/(\s+)/); let out = '';
  for (let i = 0; i < parts.length; i += 2) {
    const word = parts[i]; const sep = parts[i + 1] ?? '';
    const previous = i >= 2 ? parts[i - 2] : '';
    const fn = FUNCTIONS.has(word) && i + 2 < parts.length;
    if (!word || (!fn && !isMathWord(word, previous))) { out += word + sep; continue; }
    let j = i; let raw = word;
    for (let n = 0; n < 16 && j + 2 < parts.length; n++) {
      const [x, y] = balance(raw); const next = parts[j + 2];
      const last = raw.split(/\s+/).pop();
      if (!next || !(x > 0 || y > 0 || ENDS_IN_OPERATOR.test(core(raw)) || OPERATOR.test(core(next)) || FUNCTIONS.has(last))) break;
      raw += parts[j + 1] + next; j += 2;
    }
    let body = core(raw); let tail = raw.slice(body.length);
    if (balance(body)[1] < 0 && body.endsWith(')') && balance(body.slice(0, -1))[1] === 0) { tail = `)${tail}`; body = body.slice(0, -1); }
    const suffix = body.match(/^(.+?)(-(?:[a-z]{3,}|st|nd|rd|th)\b.*)$/);
    if (suffix && !/\s/.test(body)) { tail = suffix[2] + tail; body = suffix[1]; }
    const [bx, by] = balance(body);
    const tex = bx === 0 && by === 0 ? safeTex(body) : null;
    if (!tex) { out += word + sep; continue; }
    out += `<span class="ff-math">$${tex}$</span>${tail}${parts[j + 1] ?? ''}`;
    i = j;
  }
  return out;
}

/** Formulas in plain text become LaTeX. LaTeX already written, code and citation chips are left alone. */
function inline(html) {
  let depth = 0;
  return String(html).split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<(?:code|span|a)\b/i.test(part)) depth++;
      else if (/^<\/(?:code|span|a)>/i.test(part)) depth = Math.max(0, depth - 1);
      return part;
    }
    if (depth) return part;
    if (((part.match(/(?<!\\)\$/g) || []).length) % 2) return part;
    return part.split(/(\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/).map((x, k) => (k % 2 ? x : mathSpans(x))).join('');
  }).join('');
}

const readBack = (html) => String(html).replace(/<span class="ff-math">\$([\s\S]*?)\$<\/span>/g, (_, t) => fromTex(t));

/** One line of plain text, such as a title, with its formulas in LaTeX. */
export function texLine(text) {
  const escaped = spelledGreek(String(text || '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return inline(escaped).replace(/<span class="ff-math">|<\/span>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function block(line, previous) {
  const text = bodyText(line).trim();
  let m = line.match(HEAD);
  if (m) {
    const rest = line.slice(m[0].length);
    return `<p><b class="ff-lead">${inline(m[1])}</b>${rest ? ` ${lead(rest)}` : ''}</p>`;
  }
  m = line.match(NUMBERED);
  if (m) return `<div class="ff-eq"><span class="ff-label">(${m[1]})</span><div>${inline(line.slice(m[0].length))}</div></div>`;
  m = line.match(ITEM);
  if (m) return `<div class="ff-item"><span class="ff-label">(${m[1]})</span><div>${lead(line.slice(m[0].length))}</div></div>`;
  m = line.match(BULLET);
  if (m) return `<div class="ff-item"><span class="ff-label">-</span><div>${lead(line.slice(m[0].length))}</div></div>`;
  if (previous !== null && !/[.;:]$/.test(bodyText(previous).trim()) && text.length <= 120 && /[=≤≥≠≡]/.test(text)) return `<div class="ff-eq"><div>${inline(line)}</div></div>`;
  return `<p>${lead(line)}</p>`;
}

function lead(line) {
  const m = line.match(LEAD);
  return m ? `<b class="ff-lead">${inline(m[1])}</b> ${inline(line.slice(m[0].length))}` : inline(line);
}

const NAMED = /^(?!(?:By|Using|From|Then|Since|Apply|Applying|See|In|Thus|Hence|Now|And|Let|With|Note|Recall|Given|Following|As|If|For|To|This|The)\b)((?:[A-Z][\w-]* ){0,2}(Claim|Lemma|Proposition|Theorem|Corollary)(?: \d+(?:\.\d+)*)?)[.:]\s+/;
const envType = (head) => {
  const h = head.toLowerCase();
  if (h.startsWith('proof')) return 'proof';
  if (/^(?:conventions?|notation|setup|definition)/.test(h)) return 'definition';
  return ['theorem', 'proposition', 'corollary', 'lemma', 'claim'].find((k) => h.includes(k)) || 'theorem';
};
const attr = (x) => bodyText(x).replace(/["<>]/g, '').replace(/[.:]$/, '').trim();

/** Splits a text into definitions, statements and proofs, as in a paper. Claims and lemmas stay inside their proof. */
function environments(paragraphs) {
  let out = ''; let partProof = false; const open = []; const named = new Set();
  const close = (depth = 0) => { while (open.length > depth) { out += '</section>'; open.pop(); } };
  const start = (type, head) => { out += `<section class="ff-env ff-${type}" data-env="${type}" data-title="${attr(head)}"><header class="ff-env-head">${inline(head)}</header>`; };
  const body = (lines, first) => {
    let previous = first;
    return lines.map((line) => { const x = block(line, previous); previous = line; return x; }).join('');
  };
  for (let i = 0; i < paragraphs.length; i++) {
    const lines = paragraphs[i].split(/<br\s*\/?>/i).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) continue;
    const head = lines[0].match(HEAD); const name = head ? null : lines[0].match(NAMED);
    if (!head && !name) { out += body(lines, null); continue; }
    const label = head ? head[1] : lines[0].slice(0, name[1].length + 1);
    const rest = lines[0].slice(head ? head[0].length : name[0].length);
    const type = envType(head ? label : name[2]);
    const after = [...(rest ? [rest] : []), ...lines.slice(1)];
    if (type === 'proof') {
      const about = label.match(/^Proof of (?:the )?(.+?)[.:]$/);
      const inner = about && open.length && named.has(about[1]);
      close(inner ? 1 : 0);
      if (!inner) partProof = /^PROOF OF/.test(label);
      start('proof', label); open.push('proof');
      out += body(after, null);
      continue;
    }
    const nests = open.length && (type === 'claim' || (type === 'lemma' && partProof));
    if (!nests) { close(); named.clear(); partProof = false; }
    if (name) named.add(name[1]);
    start(type, label);
    out += body(after, null);
    if (!after.length && i + 1 < paragraphs.length && !paragraphs[i + 1].match(HEAD) && !paragraphs[i + 1].match(NAMED)) {
      i++;
      out += body(paragraphs[i].split(/<br\s*\/?>/i).map((x) => x.trim()).filter(Boolean), null);
    }
    out += '</section>';
  }
  close();
  return out;
}

/** The reading view of sanitized HTML. Anything it cannot safely lay out is returned unchanged. */
export function formatFactHtml(html) {
  const source = String(html || '');
  if (!source || OTHER_BLOCKS.test(source)) return source;
  const paragraphs = [...source.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  if (!paragraphs.length) return source;
  const out = environments(paragraphs);
  return canon(plain(readBack(out))) === canon(plain(source)) ? `<div class="fact-readable">${out}</div>` : source;
}

/** Labels of the mathematical kinds, in the order they are browsed. */
export const FACT_KINDS = [['theorem', 'Theorems', 'Theorem'], ['proposition', 'Propositions', 'Proposition'], ['lemma', 'Lemmas', 'Lemma'], ['corollary', 'Corollaries', 'Corollary'], ['definition', 'Definitions', 'Definition'], ['conjecture', 'Conjectures', 'Conjecture'], ['remark', 'Remarks', 'Remark']];
export const kindOf = (f) => f?.display_kind || f?.kind || 'lemma';
export const kindLabel = (k) => FACT_KINDS.find((x) => x[0] === k)?.[2] || String(k || '');

/** The kinds present in a list of facts, with their counts. */
export function kindCounts(facts) {
  const n = {};
  for (const f of facts || []) { const k = kindOf(f); n[k] = (n[k] || 0) + 1; }
  return FACT_KINDS.filter(([k]) => n[k]).map(([key, plural]) => ({ key, label: plural, n: n[key] }));
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const htmlText = (html) => decode(String(html || '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]*>/g, ''));

/** A title cut from the statement is replaced, for display, by the start of the main result. */
export function factTitle(title, statement, isHtml = false) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const text = isHtml ? htmlText(statement) : String(statement || '');
  const t = clean(title); const all = clean(text);
  if (t.length < 60 || all === t || !all.startsWith(t)) return title;
  const main = text.match(/(?:^|[\n.]\s+)((?:Main )?(?:Theorem|Lemma|Proposition|Corollary)\b[\s\S]*)/);
  const shown = clean(main ? main[1] : text);
  if (shown.length <= 120) return shown;
  const cut = shown.slice(0, 120); const at = cut.lastIndexOf(' ');
  return `${(at > 60 ? cut.slice(0, at) : cut).replace(/[,;:]$/, '')}…`;
}

/** Older imports stored references cut at each comma. They are put back together for display. */
function repaired(parts) {
  let s = '';
  for (const raw of parts) {
    let x = String(raw).trim();
    const open = ((s.replace(/\\./g, '').match(/"/g) || []).length) % 2 === 1;
    if (!open && (/^[\w -]+":/.test(x) || !/^["{[\d\-tfn]/.test(x))) x = `"${x}"`;
    s += (s ? ', ' : '') + x;
  }
  const value = JSON.parse(`[${s}]`);
  if (!value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) throw new Error('not references');
  return value;
}

function reference(r) {
  const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const authors = Array.isArray(r.authors) ? r.authors.map(text).filter(Boolean).join(', ') : text(r.authors || r.author);
  const arxiv = text(r.arxiv || r.eprint).replace(/^arxiv:/i, ''); const doi = text(r.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ''); const url = text(r.url);
  let link = null;
  if (/^(\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(v\d+)?$/i.test(arxiv)) link = { label: `arXiv:${arxiv}`, href: `https://arxiv.org/abs/${arxiv}` };
  else if (/^10\.\d{4,9}\/\S+$/.test(doi)) link = { label: `doi:${doi}`, href: `https://doi.org/${encodeURI(doi)}` };
  else if (/^https?:\/\/[^\s<>"]+$/i.test(url)) link = { label: 'Open the source', href: url };
  return { key: text(r.key), title: text(r.title) || text(r.key) || 'Reference', authors, year: text(r.year), venue: text(r.venue || r.journal), citedFor: text(r.cited_for), link };
}

/** The references of a fact, ready to display. What cannot be read is shown as its original text. */
export function parseExternalRefs(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return [];
  if (items.every((x) => x && typeof x === 'object')) return items.map(reference);
  try {
    return repaired(items).map(reference);
  } catch {
    return items.map((x) => ({ raw: typeof x === 'string' ? x : JSON.stringify(x) }));
  }
}

/**
 * Text shortened to about `max` characters for a preview, never inside a formula: a cut inside $…$ or $$…$$ moves back to before
 * that formula, so the preview still typesets. Then it ends at a word, with an ellipsis.
 */
export function clipMath(text, max = 220) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let cut = max;
  // Where each formula opens and closes, up to the cut; an escaped \$ is not a delimiter.
  let open = -1;
  for (let i = 0; i < cut; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] !== '$') continue;
    const dbl = s[i + 1] === '$';
    open = open === -1 ? i : -1;
    if (dbl) i++;
  }
  if (open !== -1) cut = open;
  const space = s.lastIndexOf(' ', cut);
  if (space > cut * 0.6) cut = space;
  return s.slice(0, cut).replace(/[\s,;:]+$/, '') + '…';
}
