// Notation in the text of a fact: each use, in a formula, of a symbol of the project or of one the fact defines for itself
// is marked, so that a reader sees its meaning by pointing at it. Without dependency, so that it can be unit tested.

import { paramsOf, relationPattern } from './notation-params.js';

const FONT = '(?:mathrm|mathsf|mathbf|mathit|mathcal|mathbb|mathfrak|operatorname|textrm|text)';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name of a symbol, without its arguments: FS(X) is written FS(H) as well, and \mathrm{FU}(B_n) is FU. */
function head(symbol) {
  // An axiom named after its symbol, such as (\mu) for the existence of Feferman's \mu, is that symbol.
  const s = String(symbol || '').trim().replace(/^\$+|\$+$/g, '').trim().replace(/^\(\s*(\\[A-Za-z]+)\s*\)$/, '$1');
  return s.replace(/\s*[(_^].*$/s, '').trim() || s;
}

/** One key per notion, whatever its font or arguments: \mathrm{FS}(X) and FS(H) are both "fs". */
export function notationKey(symbol) {
  return head(symbol).replace(new RegExp(`\\\\${FONT}\\s*\\{([^{}]*)\\}`, 'g'), '$1').replace(/[\s{}]/g, '').toLowerCase();
}

/**
 * What to look for in LaTeX: a name of two letters or more in any font (\mathrm{FIN}, \operatorname{FIN} or FIN),
 * one letter only in its font (\mathbb{N}, never a bare N, which is a variable), or else the exact spelling.
 * A relation written with parameters, "Y \leq X", is found between objects written with its letters only (see relationPattern).
 * Null when it is too short to be found safely.
 */
export function symbolPattern(symbol, params = null) {
  const h = head(symbol);
  const wrapped = h.match(new RegExp(`^\\\\${FONT}\\s*\\{\\s*([A-Za-z][A-Za-z0-9]*)\\s*\\}$`));
  const bare = h.match(/^([A-Za-z][A-Za-z0-9]*)$/);
  const word = (wrapped || bare)?.[1];
  if (word && word.length >= 2) return `\\\\${FONT}\\s*\\{\\s*${esc(word)}\\s*\\}|(?<![\\\\A-Za-z])${esc(word)}(?![A-Za-z])`;
  if (wrapped) return `${esc(h).replace(/\\\{\s*/, '\\{\\s*').replace(/\s*\\\}$/, '\\s*\\}')}`;
  if (word) return null;
  const rel = relationPattern(h, params || paramsOf({ symbol: h }));
  if (rel) return rel;
  if (h.length < 3) return null;
  return esc(h) + (/[A-Za-z]$/.test(h) ? '(?![A-Za-z])' : '');
}

/** The arguments of \text{…} and its kind: text, not formula, where a mark would break the formula. */
function textRanges(math) {
  const out = [];
  const re = /\\(?:text|textrm|textit|textbf|mbox|hbox)\s*\{/g;
  let m;
  while ((m = re.exec(math))) {
    let depth = 1, i = re.lastIndex;
    for (; i < math.length && depth; i++) { if (math[i] === '\\') i++; else if (math[i] === '{') depth++; else if (math[i] === '}') depth--; }
    out.push([m.index, i]);
  }
  return out;
}

/** The subscript and superscript written right after a name: "_0^\\omega" gives {sub: "0", sup: "\\omega"}. */
function scriptsOf(text) {
  const out = {}; let i = 0; const t = String(text || '');
  while (i < t.length) {
    while (t[i] === ' ') i++;
    const mark = t[i];
    if (mark !== '_' && mark !== '^') break;
    i++; while (t[i] === ' ') i++;
    let arg;
    if (t[i] === '{') { let depth = 1, j = i + 1; for (; j < t.length && depth; j++) { if (t[j] === '\\') j++; else if (t[j] === '{') depth++; else if (t[j] === '}') depth--; } arg = t.slice(i + 1, j - 1); i = j; }
    else if (t[i] === '\\') { const m = t.slice(i).match(/^\\[A-Za-z]+|^\\./); arg = m ? m[0] : '\\'; i += arg.length; }
    else { arg = t[i] ?? ''; i++; }
    // Spaces do not count, except one after a command, which ends it: "\\le n" is not "\\len".
    out[mark === '_' ? 'sub' : 'sup'] = arg.replace(/(\\[A-Za-z]+)\s+(?=[A-Za-z])/g, '$1\u0000').replace(/\s+/g, '').replace(/\u0000/g, ' ');
  }
  return out;
}

/** How well the scripts of a use fit an entry's: its parameters (n and k in \\mathsf{HT}^{=n}_k) stand for any value, other letters for themselves (\\le_c is not \\le_T). -1 when they do not fit. */
function scriptFit(entry, used) {
  const own = scriptsOf(String(entry.symbol || '').replace(/^\$+|\$+$/g, '').trim().slice(head(entry.symbol).length));
  const names = new Set((entry.params || []).map((p) => p.name));
  let score = 0;
  for (const k of ['sub', 'sup']) {
    if (own[k] === undefined && used[k] === undefined) { score += 1; continue; }
    if (own[k] === undefined || used[k] === undefined) return -1;
    const re = own[k].split(/(\\[A-Za-z]+|[A-Za-z])/).map((x) => (x && !x.startsWith('\\') && /^[A-Za-z]$/.test(x) && names.has(x) ? '.+?' : x === ' ' ? ' ?' : esc(x))).join('');
    if (!new RegExp(`^${re}$`).test(used[k])) return -1;
    // The more it fixes, the better it fits: "=n" fits "=2" better than "A" does.
    score += 2 + own[k].replace(/(?<!\\[A-Za-z]*)[A-Za-z](?![A-Za-z])/g, '').replace(/\s/g, '').length / 100;
  }
  return score;
}

/**
 * Marks the notation in formulas. `preProcess` rewrites the LaTeX of one formula before KaTeX renders it:
 * each use becomes \htmlClass{oq-nt oq-nt-<i>}{…}, where i is the index of its entry in `entries`.
 */
export function notationMarker(entries) {
  const all = (entries || []).map((e, i) => ({ i, entry: { symbol: e.symbol, params: paramsOf(e) }, re: symbolPattern(e.symbol, e.params ? paramsOf(e) : null), size: head(e.symbol).length })).filter((e) => e.re);
  // Entries with one name, such as \mathsf{RCA}_0 and \mathsf{RCA}^\omega_0, or \mathsf{HT} and \mathsf{HT}^{=n}_k, are one group: its
  // scripts decide which one a use is (scriptFit), and a use none of them fits is left unmarked rather than given a wrong meaning.
  const groups = new Map();
  for (const e of all) { const g = groups.get(e.re); if (g) g.members.push(e); else groups.set(e.re, { re: e.re, size: e.size, members: [e] }); }
  const list = [...groups.values()];
  // The longest names first: FUT is not found as FU.
  list.sort((a, b) => b.size - a.size);
  if (!list.length) return { preProcess: (math) => math, count: 0 };
  const SCRIPTS = '((?:\\s*[_^]\\s*(?:\\{(?:[^{}]|\\{[^{}]*\\})*\\}|\\\\[A-Za-z]+|[^\\s{}\\\\]))*)';
  // Each group is one alternative, and a group of several also captures the scripts that follow the name.
  // An entry written with scripts must fit them even alone (\\mathsf{RCA}^\\omega_0 is not \\mathsf{RCA}_0); one without scripts, alone,
  // marks its name whatever follows (\\mathbb N in \\mathbb N^2).
  const scripted = (m) => Object.keys(scriptsOf(String(m.entry.symbol || '').replace(/^\$+|\$+$/g, '').trim().slice(head(m.entry.symbol).length))).length > 0;
  for (const g of list) g.choose = g.members.length > 1 || scripted(g.members[0]);
  const re = new RegExp(list.map((g) => (g.choose ? `((?:${g.re})${SCRIPTS})` : `((?:${g.re})())`)).join('|'), 'g');
  return {
    count: all.length,
    preProcess(math) {
      if (math.includes('\\htmlClass')) return math; // marked already, or written by hand: left as it is
      const text = textRanges(math);
      return math.replace(re, (...args) => {
        const at = args[args.length - 2];
        const whole = args[0];
        if (text.some(([a, b]) => at > a && at < b && !(at === a && at + whole.length === b))) return whole;
        const g = args.slice(1, 2 * list.length + 1).findIndex((x, k) => k % 2 === 0 && x !== undefined) / 2;
        const group = list[g];
        let pick = group.members[0];
        if (group.choose) {
          const used = scriptsOf(args[2 * g + 2] || '');
          const ranked = group.members.map((m) => [scriptFit(m.entry, used), m]).filter(([sc]) => sc >= 0).sort((x, y) => y[0] - x[0]);
          if (!ranked.length) return whole;
          pick = ranked[0][1];
        }
        const marked = `\\htmlClass{oq-nt oq-nt-${pick.i}}{${whole}}`;
        // Right after a bare _ or ^ (f_\\alpha), a command needs braces to be a script: f_{\\htmlClass{…}{\\alpha}}.
        return /[_^]\s*$/.test(math.slice(0, at)) ? `{${marked}}` : marked;
      });
    },
  };
}

/** KaTeX may only add the classes of these marks: nothing a text could use to change the page. */
export const trustMarks = (ctx) => ctx.command === '\\htmlClass' && /^oq-nt oq-nt-\d+$/.test(ctx.class || '');

/**
 * The entries a fact's text is marked with: what the fact defines for itself first, then the local entries of its paper
 * (a symbol the field writes its own way, kept out of the project notation), then the agreed project notation for the
 * symbols neither defines. A fact may so use a standard symbol that the project gives another meaning.
 */
export function factNotation(local, project, paper = []) {
  const own = (local || []).map(([symbol, meaning]) => ({ symbol, meaning: String(meaning ?? ''), source: 'fact' }));
  const mine = new Set(own.map((x) => notationKey(x.symbol)));
  const theirs = (paper || []).filter((e) => !mine.has(notationKey(e.symbol))).map((e) => ({ symbol: e.symbol, meaning_html: e.meaning_html, source: 'paper', id: e.id, params: e.params || [] }));
  theirs.forEach((e) => mine.add(notationKey(e.symbol)));
  return [...own, ...theirs, ...(project || []).filter((e) => !mine.has(notationKey(e.symbol))).map((e) => ({ symbol: e.symbol, meaning_html: e.meaning_html, source: 'project', id: e.id, params: e.params || [] }))];
}
