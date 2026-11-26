// Notation in the text of a fact: each use, in a formula, of a symbol of the project or of one the fact defines for itself
// is marked, so that a reader sees its meaning by pointing at it. Without dependency, so that it can be unit tested.

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
 * Null when it is too short to be found safely.
 */
export function symbolPattern(symbol) {
  const h = head(symbol);
  const wrapped = h.match(new RegExp(`^\\\\${FONT}\\s*\\{\\s*([A-Za-z][A-Za-z0-9]*)\\s*\\}$`));
  const bare = h.match(/^([A-Za-z][A-Za-z0-9]*)$/);
  const word = (wrapped || bare)?.[1];
  if (word && word.length >= 2) return `\\\\${FONT}\\s*\\{\\s*${esc(word)}\\s*\\}|(?<![\\\\A-Za-z])${esc(word)}(?![A-Za-z])`;
  if (wrapped) return `${esc(h).replace(/\\\{\s*/, '\\{\\s*').replace(/\s*\\\}$/, '\\s*\\}')}`;
  if (word || h.length < 3) return null;
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

/**
 * Marks the notation in formulas. `preProcess` rewrites the LaTeX of one formula before KaTeX renders it:
 * each use becomes \htmlClass{oq-nt oq-nt-<i>}{…}, where i is the index of its entry in `entries`.
 */
export function notationMarker(entries) {
  const list = (entries || []).map((e, i) => ({ i, re: symbolPattern(e.symbol), size: head(e.symbol).length })).filter((e) => e.re);
  // The longest names first: FUT is not found as FU.
  list.sort((a, b) => b.size - a.size);
  if (!list.length) return { preProcess: (math) => math, count: 0 };
  const re = new RegExp(list.map((e) => `(${e.re})`).join('|'), 'g');
  return {
    count: list.length,
    preProcess(math) {
      if (math.includes('\\htmlClass')) return math; // marked already, or written by hand: left as it is
      const text = textRanges(math);
      return math.replace(re, (...args) => {
        const at = args[args.length - 2];
        const found = args.slice(1, list.length + 1).findIndex((g) => g !== undefined);
        const whole = args[0];
        if (text.some(([a, b]) => at > a && at < b && !(at === a && at + whole.length === b))) return whole;
        return `\\htmlClass{oq-nt oq-nt-${list[found].i}}{${whole}}`;
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
  const theirs = (paper || []).filter((e) => !mine.has(notationKey(e.symbol))).map((e) => ({ symbol: e.symbol, meaning_html: e.meaning_html, source: 'paper', id: e.id }));
  theirs.forEach((e) => mine.add(notationKey(e.symbol)));
  return [...own, ...theirs, ...(project || []).filter((e) => !mine.has(notationKey(e.symbol))).map((e) => ({ symbol: e.symbol, meaning_html: e.meaning_html, source: 'project', id: e.id }))];
}
