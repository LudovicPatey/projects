// The project's notation: labels and rules of the interface, without dependency, so that they can be unit tested.

/** Where the facts stand against the agreed notation. */
export const NOTATION_SEGMENTS = [['current', 'In project notation', '#0d9488'], ['unchanged', 'Already in it', '#5eead4'], ['stale', 'Notation changed since', '#d97706'], ['unfaithful', 'Meaning changed', '#b42318'], ['none', 'Not yet', '#98a2b3']];

/** Facts that a click on "Rewrite" sends to the AI queue. */
export const toRewrite = (p) => Math.max(0, (p?.stale || 0) + (p?.unfaithful || 0) + (p?.none || 0) - (p?.queued || 0));

/** A symbol as LaTeX between dollars, whatever the person typed. */
export const asMath = (symbol) => `$${String(symbol || '').trim().replace(/^\$+|\$+$/g, '')}$`;

export function entryError(d) {
  if (!String(d?.symbol || '').trim()) return 'Give the symbol, for example \\mathrm{FS}(X).';
  if (String(d.symbol).length > 160) return 'The symbol is too long.';
  if (!String(d?.meaning || '').trim()) return 'Say what the symbol means.';
  return null;
}

export const entryBody = (d) => ({ symbol: String(d.symbol).trim(), meaning_text: String(d.meaning).trim(), note_text: String(d.note || '').trim(), definition_fact_id: d.fact ? +d.fact : null });

/** The rewrite a fact page shows in project notation: one that follows the current notation and that nobody found unfaithful. */
export function shownRephrasing(fact, wantProject) {
  const x = (fact?.rephrasings || []).find((r) => r.current);
  if (!wantProject || !x || x.unchanged || x.check_verdict === 'unfaithful') return null;
  return x;
}

/** One line on how a fact stands against the agreed notation, for its page. */
export function rephrasingState(fact) {
  const all = fact?.rephrasings || [];
  const cur = all.find((r) => r.current);
  if (cur?.check_verdict === 'unfaithful') return { tone: 'bad', text: 'A person found that the version in project notation changes the meaning. The original is shown.' };
  if (cur?.unchanged) return { tone: 'good', text: 'Already written in the project\'s notation.' };
  if (cur) {
    return cur.check_verdict === 'faithful'
      ? { tone: 'good', text: 'Shown in the project\'s notation, checked by a person.' }
      : { tone: 'info', text: 'Shown in the project\'s notation by an AI. Check that it says the same as the original.' };
  }
  if (all.some((r) => r.revision_no === fact.current_revision)) return { tone: 'warn', text: 'The agreed notation changed since this fact was rewritten.' };
  return null;
}
