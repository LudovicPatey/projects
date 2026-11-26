// The project's notation: labels and rules of the interface, without dependency, so that they can be unit tested.
import { paramGroups, paramsOf, untyped } from './notation-params.js';

/** Where the facts stand against the agreed notation. */
export const NOTATION_SEGMENTS = [['current', 'In project notation', '#0d9488'], ['unchanged', 'Already in it', '#5eead4'], ['stale', 'Notation changed since', '#d97706'], ['unfaithful', 'Meaning changed', '#b42318'], ['none', 'Not yet', '#98a2b3']];

/** Facts that a click on "Rewrite" sends to the AI queue. */
export const toRewrite = (p) => Math.max(0, (p?.stale || 0) + (p?.unfaithful || 0) + (p?.none || 0) - (p?.queued || 0));

const looksMath = (s) => /[\\^_{}]/.test(s) || !/[A-Za-z]{3,}/.test(s);
/** A word of a sentence, such as "large," or "full-matches": letters and hyphens, never a command or a single letter. */
const isWord = (t) => /^[A-Za-z][A-Za-z'-]*[A-Za-z][,;:.]?$/.test(t) && !/^[A-Z]{2,}[,;:.]?$/.test(t);

/** The pieces of a text cut at its spaces, except the spaces inside braces: \text{ for a semigroup} stays one piece. */
function spaced(s) {
  const out = [];
  let cur = ''; let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '{') depth++;
    if (c === '}') depth = Math.max(0, depth - 1);
    if (/\s/.test(c) && !depth) { if (cur) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Words as text and the rest as formulas: "C large for \mathcal D" is $C$ large for $\mathcal D$, not one formula in italics. */
function piece(s) {
  // A sentence keeps its words as text, and its one-letter variables become formulas: "homogeneous for $c$". Not the article a or I.
  // So does a piece of single letters and signs, such as (F,X) in "P-branch (F,X)".
  const variable = (t) => /[A-Za-z]/.test(t) && !/[A-Za-z]{2}/.test(t) && !/^[aAI][,;:.]?$/.test(t) && !/^[A-Za-z]-/.test(t);
  if (!looksMath(s)) return s.split(/(\s+)/).map((t) => (variable(t) ? `$${t.replace(/[,;:.]$/, '')}$${t.match(/[,;:.]$/)?.[0] ?? ''}` : t)).join('');
  const parts = spaced(s);
  if (!parts.some(isWord) || parts.every(isWord)) return `$${s}$`;
  const out = [];
  let math = [];
  const flush = () => { if (math.length) out.push(`$${math.join(' ')}$`); math = []; };
  for (const t of parts) { if (isWord(t)) { flush(); out.push(t); } else math.push(t); }
  flush();
  return out.join(' ');
}

/** Text and formulas cut at their dollars, whichever comes first: "F$ full-matches $X" lost its outer dollars, and is $F$ full-matches $X$. */
function dollars(s) {
  const seg = s.split('$');
  const firstIsMath = looksMath(seg[0]) && !spaced(seg[0]).some(isWord);
  return seg.map((x, i) => ((i % 2 === 0) === firstIsMath ? (x.trim() ? `$${x.trim()}$` : '') : x)).join('').replace(/\s+/g, ' ').trim()
    // a formula glued to the next word gets its space back
    .replace(/\$(?=[A-Za-z])/g, (m, at, all) => ((all.slice(0, at).match(/\$/g) || []).length % 2 ? '$ ' : m));
}

/**
 * A notation name for display: LaTeX for symbols, plain text for words such as "full-match",
 * and a setting in parentheses after a space, such as "full-match (HT)", kept as text.
 */
export function asMath(symbol) {
  const raw = String(symbol || '').trim();
  const s = raw.replace(/^\$+|\$+$/g, '');
  // Text with its own formulas, "P-condition, $\le$" or "F$ full-matches $X": each part as what it is, and no dollar shows.
  if (s.includes('$')) return dollars(s);
  // A setting has a name of two letters or more, (HT) or (pairs); (F,X) is a formula.
  const m = s.match(/^(.*\S)\s+\(([^()]*[A-Za-z]{2,}[^()]*)\)$/);
  if (m && !/[\\^_{}]/.test(m[2])) return `${piece(m[1])} (${m[2]})`;
  return piece(s);
}

/** Instances of one general notion, and genuinely different meanings that sources give the symbol. */
export function splitVariants(variants) {
  const all = variants || [];
  return { instances: all.filter((v) => v.relation === 'instance'), clashes: all.filter((v) => v.relation !== 'instance') };
}

export function entryError(d) {
  if (!String(d?.symbol || '').trim()) return 'Give the symbol, for example \\mathrm{FS}(X).';
  if (String(d.symbol).length > 160) return 'The symbol is too long.';
  if (!String(d?.meaning || '').trim()) return 'Say what the symbol means.';
  return null;
}

export const entryBody = (d) => ({ symbol: String(d.symbol).trim(), meaning_text: String(d.meaning).trim(), note_text: String(d.note || '').trim(), definition_fact_id: d.fact ? +d.fact : null, ...(d.facts?.length ? { facts: d.facts } : {}),
  ...(d.params !== undefined ? { params: parseParams(d.params) } : {}) });

const STATUS_WORD = { agreed: 'agreed', local: 'local to its paper', proposed: 'proposed', derived: 'from project symbols' };

/**
 * The wordings of a symbol defined in several facts, in the groups of equivalent ones the symbols sweep recorded: one block per meaning,
 * with its label and the entry it is, then the wordings no sweep compared yet. `summary` says it in a few words: "8 wordings, all
 * equivalent", "5 wordings, 2 different meanings". Without groups, one block of every wording, as the facts give them.
 */
export function wordingGroups(s) {
  const meanings = s?.meanings || [];
  const groups = s?.classes || [];
  const unread = s?.unclassified || [];
  const n = meanings.length;
  const blocks = groups.map((g, i) => {
    const entry = g.entry || (g.decided ? s.entry : null);
    return { key: `g${i}`, tone: i % 4, title: groups.length > 1 ? `Meaning ${i + 1}` : 'One meaning', label: g.label,
      entry: entry && entry.id ? { ...entry, word: STATUS_WORD[entry.status] || entry.status } : null,
      items: g.meanings.map((j) => meanings[j]).filter(Boolean) };
  });
  if (groups.length && unread.length) blocks.push({ key: 'unread', tone: null, title: 'Not compared yet', label: 'new since the last symbols sweep', entry: null, items: unread.map((j) => meanings[j]).filter(Boolean) });
  if (!groups.length) blocks.push({ key: 'all', tone: null, title: '', label: '', entry: null, items: meanings });
  let summary = '';
  if (n > 1 && groups.length === 1 && !unread.length) summary = `${n} wordings, all equivalent`;
  else if (n > 1 && groups.length > 1) summary = `${n} wordings, ${groups.length} different meanings${unread.length ? `, ${unread.length} not compared yet` : ''}`;
  else if (n > 1 && groups.length === 1) summary = `${n} wordings, ${unread.length} not compared yet`;
  else if (n > 1) summary = `${n} wordings, not compared yet`;
  return { summary, blocks, grouped: groups.length > 0 };
}

/**
 * Where a symbol defined in several facts stands with the AI, from the "sweep" the server gives: when its wordings are compared and it
 * is settled, or that the AI left it to the members. Empty once it has an entry.
 */
export function sharedState(s) {
  const what = s?.meanings?.length > 1 ? 'compares its wordings and settles it' : 'settles it';
  switch (s?.sweep) {
    case 'reading': return `The AI ${what} now, in the symbols sweep under way.`;
    case 'next': return `The AI ${what} in the next symbols sweep, once nobody has added facts for a while.`;
    case 'later': return `The AI ${what} in a later symbols sweep: thirty symbols at a time, the most used first.`;
    case 'left': return 'Two symbols sweeps read it without settling it: it is left to the members. Propose it as global, or discuss it.';
    default: return '';
  }
}

/** "X, Y: infinite block sequence", one line per type, as the form writes the parameters. */
export function paramsText(params, fixed = []) {
  return [...paramGroups(params).map((g) => `${g.params.map((p) => p.name).join(', ')}: ${g.type}`),
    ...(fixed.length ? [`${fixed.join(', ')}: not a parameter`] : [])].join('\n');
}

/** The lines of the form back to [{name, type}]. A line without a colon gives names without a type. */
export function parseParams(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const at = line.indexOf(':');
    const names = (at < 0 ? line : line.slice(0, at)).split(',').map((n) => n.trim().replace(/^\$+|\$+$/g, '')).filter(Boolean);
    const type = at < 0 ? '' : line.slice(at + 1).trim();
    for (const name of names) out.push({ name, type });
  }
  return out;
}

const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');
const math = (names) => and(names.map((n) => `$${n}$`));

/**
 * What the entry applies to, in one sentence: its symbol between the objects its parameters stand for. `typed` is false when nobody said
 * what some of them are: then only the meaning tells.
 */
export function entryScope(e) {
  const params = paramsOf(e);
  if (!params.length) return { params, typed: true, text: 'Wherever the symbol is written.' };
  const groups = paramGroups(params).filter((g) => g.type);
  const parts = groups.map((g) => `${math(g.params.map((p) => p.name))} ${g.params.length > 1 ? 'are' : 'is'} ${g.type}`);
  const missing = params.filter((p) => !p.type.trim()).map((p) => p.name);
  const text = parts.length
    ? `Only where ${and(parts)}${missing.length ? `. The type of ${math(missing)} is not stated` : ''}.`
    : `The type of ${math(missing)} is not stated: only the meaning says what the entry applies to.`;
  return { params, typed: !untyped(params), text };
}

/**
 * What each choice on an entry changes, and what it leaves as it is, so that nobody fears that agreeing on "Y \leq X" for block sequences
 * changes \leq everywhere. One row per button the entry shows.
 */
export function actionEffects(e) {
  const scope = entryScope(e);
  const has = scope.params.length > 0;
  const where = has ? (scope.typed ? 'between these objects only' : 'for the objects its meaning describes') : 'wherever it is written';
  const clashes = splitVariants(e.variants).clashes.length;
  const keep = 'The reviewed text of every fact stays as it is: a rewrite is shown beside it.';
  const rows = [];
  if (e.status === 'proposed') {
    rows.push({ action: 'Agree', changes: `It becomes project notation ${where}: facts show this meaning when a reader points at it, and AI rewrites write this notion this way.`,
      keeps: [has ? 'The same symbol between other objects, such as numbers or another order, keeps its own meaning.' : '',
        clashes ? `The ${clashes > 1 ? `${clashes} other meanings` : 'other meaning'} in sources ${clashes > 1 ? 'keep their' : 'keeps its'} symbol, renamed only in a fact that uses both.` : '', keep].filter(Boolean).join(' ') });
    rows.push({ action: 'Local', changes: 'Only the facts that define it, and the other facts of their paper, read the symbol with this meaning.', keeps: 'It is not project notation: other facts, and the symbol anywhere else, are not affected. A rewrite defines it inside the fact, or unfolds it.' });
    rows.push({ action: 'Reject', changes: 'It is set aside, and the AI does not propose it again.', keeps: 'Nothing changes in the facts: each keeps its own definition of the symbol.' });
    rows.push({ action: 'Edit', changes: 'Change the symbol, its meaning, or the types of its parameters, which decide what it applies to.', keeps: 'It stays a proposal: nothing applies until someone agrees.' });
  } else if (e.status === 'agreed') {
    if (e.decided_by_kind === 'consolidation') rows.push({ action: 'Confirm', changes: 'It becomes the team\'s decision: the consolidation no longer changes it.', keeps: 'Nothing changes in the facts.' });
    rows.push({ action: 'Edit', changes: 'Change the symbol, its meaning, or the types of its parameters.', keeps: 'A change to any of them makes it a proposal again, until someone agrees.' });
    rows.push({ action: 'Reopen', changes: 'It goes back to the proposals and stops being project notation: the facts rewritten in it are rewritten again.', keeps: keep });
  }
  return rows;
}


/** A symbol that several facts define for themselves: worth making global when they agree on its meaning. */
export const sharedDraft = (s) => ({ symbol: s.symbol, meaning: s.meanings[0]?.meaning || '', note: s.meanings.length > 1 ? `Facts define it in ${s.meanings.length} ways: the others need another symbol.` : `Defined locally in ${s.facts} facts.`, fact: '', facts: s.meanings[0]?.facts || [] });

/** The rewrite a fact page shows in project notation: one that follows the current notation and that nobody found unfaithful. */
export function shownRephrasing(fact, wantProject) {
  const x = (fact?.rephrasings || []).find((r) => r.current);
  if (!wantProject || !x || x.unchanged || x.check_verdict === 'unfaithful') return null;
  return x;
}

/** A verdict on a rewrite that an AI gave, not a person: people can still overrule it. */
export const checkedByAi = (x) => Boolean(x?.check_verdict && !x.checked_by && x.check_ai_model);

/** One line on how a fact stands against the agreed notation, for its page. */
export function rephrasingState(fact) {
  const all = fact?.rephrasings || [];
  const cur = all.find((r) => r.current);
  const ai = checkedByAi(cur);
  if (cur?.check_verdict === 'unfaithful') {
    return { tone: 'bad', text: ai ? `A second AI found that the version in project notation changes the meaning: ${cur.check_note || ''} The original is shown.` : 'A person found that the version in project notation changes the meaning. The original is shown.' };
  }
  if (cur?.unchanged) return { tone: 'good', text: 'Already written in the project\'s notation.' };
  if (cur) {
    if (cur.check_verdict === 'faithful') return { tone: 'good', text: ai ? 'Shown in the project\'s notation. A second AI compared it with the original and found the same meaning.' : 'Shown in the project\'s notation, checked by a person.' };
    return { tone: 'info', text: 'Shown in the project\'s notation by an AI. A second AI will compare it with the original; you can check it now.' };
  }
  if (all.some((r) => r.revision_no === fact.current_revision)) return { tone: 'warn', text: 'The agreed notation changed since this fact was rewritten.' };
  return null;
}
