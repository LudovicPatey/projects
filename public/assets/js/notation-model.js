// The project's notation: labels and rules of the interface, without dependency, so that they can be unit tested.

/** Where the facts stand against the agreed notation. */
export const NOTATION_SEGMENTS = [['current', 'In project notation', '#0d9488'], ['unchanged', 'Already in it', '#5eead4'], ['stale', 'Notation changed since', '#d97706'], ['unfaithful', 'Meaning changed', '#b42318'], ['none', 'Not yet', '#98a2b3']];

/** Facts that a click on "Rewrite" sends to the AI queue. */
export const toRewrite = (p) => Math.max(0, (p?.stale || 0) + (p?.unfaithful || 0) + (p?.none || 0) - (p?.queued || 0));

const looksMath = (s) => /[\\^_{}]/.test(s) || !/[A-Za-z]{3,}/.test(s);
const piece = (s) => (looksMath(s) ? `$${s}$` : s);

/**
 * A notation name for display: LaTeX for symbols, plain text for words such as "full-match",
 * and a setting in parentheses after a space, such as "full-match (HT)", kept as text.
 */
export function asMath(symbol) {
  const s = String(symbol || '').trim().replace(/^\$+|\$+$/g, '');
  if (s.includes('$')) return s; // the person wrote the dollars
  const m = s.match(/^(.*\S)\s+\(([^()]*[A-Za-z][^()]*)\)$/);
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

export const entryBody = (d) => ({ symbol: String(d.symbol).trim(), meaning_text: String(d.meaning).trim(), note_text: String(d.note || '').trim(), definition_fact_id: d.fact ? +d.fact : null, ...(d.facts?.length ? { facts: d.facts } : {}) });

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
