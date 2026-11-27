// Consolidation proposals, without the interface: grouping, wording and topic filters, so that they can be tested.
import { asMath } from './notation-model.js';

export const SUGGESTION_KINDS = [
  { kind: 'same', title: 'Same result', help: 'Two facts state the same result. Merging keeps the first, with the sources, links, stars and proof of the other.' },
  { kind: 'depends', title: 'Missing dependencies', help: 'A proof uses another fact of the database, often from another source.' },
  { kind: 'question', title: 'Open questions', help: 'A remark asks a question that is still open. Accepting makes it an open question, linked to its source.' },
  { kind: 'kind', title: 'Kinds', help: 'A fact has the wrong kind, for example a remark that is really a lemma.' },
  { kind: 'cite', title: 'Cited results', help: 'A proof uses a result of another work directly. Accepting links the proof to the fact that states it, written here as a new cited result when there is none, so that the proof relies only on the database.' },
  { kind: 'notation', title: 'Notation', help: 'One notation for the whole project. Accepting adopts the symbol, keeps it local to the facts or sets it aside, and the facts are rewritten in the notation; their reviewed text does not change.' },
  { kind: 'progress', title: 'Worth reading', help: 'A fact that is real progress, worth a person\'s reading. Accepting adds it to every member\'s reading suggestions, on the overview.' },
  { kind: 'topics', title: 'Subject tags', help: 'Free tags to find facts by subject. They are added to the fact\'s tags.' },
];

/** Waiting proposals by kind, in the order above, leaving out empty groups. */
export function groupSuggestions(list) {
  return SUGGESTION_KINDS.map((k) => ({ ...k, items: list.filter((s) => s.kind === k.kind && s.status === 'proposed') })).filter((g) => g.items.length);
}

/** A fact named in a proposal: by its title, in quotes; its key only when it has none. */
const label = (facts, id) => (facts[id]?.title ? `“${facts[id].title}”` : facts[id]?.label ?? `#${id}`);

/** One line saying what accepting would do. */
export function suggestionText(s, facts) {
  const a = label(facts, s.fact_id); const b = s.other_fact_id ? label(facts, s.other_fact_id) : '';
  switch (s.kind) {
    case 'same': return `Merge ${b} into ${a}`;
    case 'depends': return `${a} relies on ${b}`;
    case 'kind': return `${a} becomes a ${s.data?.kind ?? '?'}`;
    case 'question': return `${a} becomes the open question “${s.data?.title ?? ''}”`;
    case 'topics': return `Tag ${a}: ${(s.data?.topics ?? []).join(', ')}`;
    case 'progress': return `${a} is worth reading`;
    case 'notation': return notationText(s.data);
    case 'cite': return b ? `${a} uses ${b}, for ${s.data?.ref_label ?? 'a reference'}` : `${a} uses a new cited result: ${s.data?.title ?? ''}`;
    default: return a;
  }
}

const NOTATION_VERBS = { adopt: 'Adopt', local: 'Keep local', reject: 'Set aside' };

/** A notation decision in words: the symbol as mathematics, and its meaning when it is adopted. */
export function notationText(d) {
  const sym = d?.symbol ? asMath(d.symbol) : '?'; // words as text, formulas as math, as everywhere a symbol is shown
  const verb = NOTATION_VERBS[d?.action] ?? 'Change';
  return d?.action === 'adopt' && d?.meaning ? `${verb} ${sym}: ${d.meaning}` : `${verb} ${sym}`;
}

/** Keeps the facts that have every chosen tag, whatever the case. No tag chosen keeps everything. */
export function topicFilter(chosen) {
  const want = (chosen ?? []).map((t) => t.toLowerCase());
  return (f) => want.every((t) => (f.topics ?? []).some((x) => x.toLowerCase() === t));
}

/** Tags typed in a field, separated by commas. */
export function parseTopics(text) {
  const seen = new Set(); const out = [];
  for (const raw of String(text ?? '').split(',')) {
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out.slice(0, 8);
}

/** Applied by the AI on its own, newest first: what people may want to look over, and undo. */
export const autoApplied = (list) => (list ?? []).filter((s) => s.auto_applied && s.status === 'accepted');

export const CONFIDENCE = { high: 'Confident', medium: 'Probable', low: 'Unsure' };

/** One change in the history of a fact, said from that fact's point of view. */
export function historyText(h, factId) {
  const here = h.fact_id === factId;
  const other = here ? h.other_label : h.fact_label;
  switch (h.kind) {
    case 'same': return here ? `${other} was merged into this fact` : `Merged into ${other}`;
    case 'depends': return here ? `Now relies on ${other}` : `${other} now relies on this fact`;
    case 'kind': return `Kind changed to ${h.data?.kind ?? '?'}`;
    case 'topics': return `Tagged ${(h.data?.topics ?? []).join(', ')}`;
    case 'question': return `Became the open question “${h.data?.title ?? ''}”`;
    case 'progress': return 'Marked as worth reading';
    case 'notation': return `Project notation: ${notationText(h.data)}`;
    case 'cite': return here ? `${h.data?.ref_label ?? 'A reference'} linked to ${other ?? `the new cited result “${h.data?.title ?? ''}”`}` : `${other} relies on this fact for ${h.data?.ref_label ?? 'a reference'}`;
    default: return h.kind;
  }
}

/** The undo button says what it does. */
export const undoLabel = (s) => (s.kind === 'same' ? 'Unmerge' : 'Undo');
