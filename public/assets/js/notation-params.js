// The parameters of a notation entry: the objects it is written with, X and Y in "Y \leq X", each with the type of object it stands for.
// An entry applies to those objects only: "Y \leq X" for infinite block sequences says nothing about \leq between numbers.
// Without dependency, so that it can be unit tested. The same reading as NotationController::paramsOf.

const FONTED = '\\\\(?:mathcal|mathscr|mathfrak|mathbf|boldsymbol)\\s*\\{\\s*[A-Za-z]\\s*\\}';
const TOKEN = new RegExp(`${FONTED}|\\\\(?:mathrm|mathsf|mathit|operatorname|textrm|text|mathbb)\\s*\\{[^{}]*\\}|\\\\[A-Za-z]+|\\\\.|[A-Za-z]+|\\s+|.`, 'gs');
const bare = (s) => String(s || '').trim().replace(/^\$+|\$+$/g, '').trim();
const key = (s) => bare(s).replace(/\s+/g, '');

/** The pieces of a LaTeX symbol: commands, names, single letters, spaces and other characters. */
export const tokens = (latex) => bare(latex).match(TOKEN) || [];

/** A single letter, X, or a letter in a font, \mathcal{D}: what a parameter is written with. */
const isLetter = (t) => /^[A-Za-z]$/.test(t) || new RegExp(`^${FONTED}$`).test(t);

/** A font command written without braces, as in \mathsf D: the letter after it is the name, not a parameter. */
const FONT_CMD = /^\\(?:mathrm|mathsf|mathit|mathbf|mathcal|mathscr|mathfrak|mathbb|boldsymbol|operatorname|textrm|text|rm|sf|bf|it|cal)$/;

/** The indexes of the tokens that are parameters: letters, not the argument of a font command written without braces. */
function paramTokens(toks) {
  const out = new Set();
  let prev = '';
  toks.forEach((t, i) => {
    if (!t.trim()) return;
    if (isLetter(t) && !FONT_CMD.test(prev)) out.add(i);
    prev = t;
  });
  return out;
}

/** The letters a symbol is written with. A symbol that is one letter only, such as \mathcal{U}, is a name, not a parameter. */
export function inferParams(symbol) {
  const toks = tokens(symbol);
  if (toks.filter((t) => t.trim()).length === 1) return [];
  // A term in words, such as P-condition or full-match (HT), has no parameter.
  if (/(?<!\\)\b[A-Za-z]+-[A-Za-z]/.test(bare(symbol)) || toks.some((t) => /^[A-Za-z]{4,}$/.test(t))) return [];
  const out = new Map();
  for (const i of paramTokens(toks)) if (!out.has(key(toks[i]))) out.set(key(toks[i]), toks[i].replace(/\s+/g, ''));
  return [...out.values()];
}

/** The parameters of an entry, {name, type}: those its symbol is written with, typed when someone said so, then any other given. */
export function paramsOf(entry) {
  const given = Array.isArray(entry?.params) ? entry.params.filter((p) => p?.name) : [];
  const type = new Map(given.map((p) => [key(p.name), String(p.type || '')]));
  const out = new Map(inferParams(entry?.symbol).map((n) => [key(n), { name: n, type: type.get(key(n)) || '' }]));
  for (const p of given) if (!out.has(key(p.name))) out.set(key(p.name), { name: bare(p.name), type: String(p.type || '') });
  return [...out.values()];
}

/** The parameters grouped by type, for one line such as "X, Y: infinite block sequences". */
export function paramGroups(params) {
  const by = new Map();
  (params || []).forEach((p, i) => { const t = p.type.trim(); if (!by.has(t)) by.set(t, []); by.get(t).push({ ...p, i }); });
  return [...by.entries()].map(([type, list]) => ({ type, params: list }));
}

/** Whether an entry says what its parameters are: otherwise nothing tells what it applies to. */
export const untyped = (params) => (params || []).some((p) => !p.type.trim());

/**
 * The symbol with each parameter colored: X becomes {\htmlClass{oq-pm oq-pm-0}{X}}, the index of its parameter, so that the page colors
 * it (four colors, in turn) and gives its type on hover. In braces, so that it stays one argument after ^ or _, as in \mathsf{RT}^n_k.
 */
export function colorParams(symbol, params) {
  const idx = new Map((params || []).map((p, i) => [key(p.name), i]));
  if (!idx.size) return bare(symbol);
  const toks = tokens(symbol);
  const at = paramTokens(toks);
  return toks.map((t, i) => (at.has(i) && idx.has(key(t)) ? `{\\htmlClass{oq-pm oq-pm-${idx.get(key(t))}}{${t}}}` : t)).join('');
}

/** KaTeX may add the classes of these colors only. */
export const trustParams = (ctx) => ctx.command === '\\htmlClass' && /^oq-pm oq-pm-\d+$/.test(ctx.class || '');

/** LaTeX that writes the same relation: \le and \leq, \ge and \geq, \ne and \neq. */
const SAME = { '\\le': '\\\\leq?', '\\leq': '\\\\leq?', '\\ge': '\\\\geq?', '\\geq': '\\\\geq?', '\\ne': '\\\\neq?', '\\neq': '\\\\neq?', '\\lt': '(?:\\\\lt|<)', '<': '(?:\\\\lt|<)', '\\gt': '(?:\\\\gt|>)', '>': '(?:\\\\gt|>)' };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What to look for in a formula for an entry written with parameters, such as "Y \leq X": the same relation between objects written with
 * its letters, indexed or primed as a proof writes them (Y_1 \le X_0, X' \leq X), and not between other objects (n \leq m).
 * Null when the symbol has no parameter.
 */
export function relationPattern(symbol, params) {
  const names = new Set((params || []).map((p) => key(p.name)));
  const toks = tokens(symbol);
  if (!names.size || !toks.some((t) => isLetter(t) && names.has(key(t)))) return null;
  const letters = [...names].map((n) => (/^[A-Za-z]$/.test(n) ? `(?<![\\\\A-Za-z_^])${n}(?![A-Za-z])` : esc(n).replace(/\\\{/, '\\s*\\{\\s*').replace(/\\\}$/, '\\s*\\}')));
  const arg = `(?:${letters.join('|')})(?:\\s*(?:'|_\\{[^{}]*\\}|_[A-Za-z0-9]|\\^\\{[^{}]*\\}|\\^[A-Za-z0-9]))*`;
  const parts = [];
  let after = false;
  for (const t of toks) {
    if (!t.trim() || /^\\[,;:! ]$/.test(t)) continue; // spaces, written or not
    if (after && t === "'") continue; // the prime of \mathcal{D}' is the argument's: D' and D are both written with D
    after = isLetter(t) && names.has(key(t));
    if (after) parts.push(arg);
    else parts.push((SAME[t] || esc(t)) + (/^\\[A-Za-z]+$/.test(t) ? '(?![A-Za-z])' : ''));
  }
  return parts.join('(?:\\s|\\\\[,;:! ])*');
}
