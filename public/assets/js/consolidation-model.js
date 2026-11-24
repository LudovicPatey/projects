// Consolidation proposals, without the interface: grouping, wording and topic filters, so that they can be tested.

export const SUGGESTION_KINDS = [
  { kind: 'same', title: 'Same result', help: 'Two facts state the same result. Merging keeps the first, with the sources, links, stars and proof of the other.' },
  { kind: 'depends', title: 'Missing dependencies', help: 'A proof uses another fact of the database, often from another source.' },
  { kind: 'question', title: 'Open questions', help: 'A remark asks a question that is still open. Accepting makes it an open question, linked to its source.' },
  { kind: 'kind', title: 'Kinds', help: 'A fact has the wrong kind, for example a remark that is really a lemma.' },
  { kind: 'topics', title: 'Subject tags', help: 'Free tags to find facts by subject. They are added to the fact\'s tags.' },
];

/** Waiting proposals by kind, in the order above, leaving out empty groups. */
export function groupSuggestions(list) {
  return SUGGESTION_KINDS.map((k) => ({ ...k, items: list.filter((s) => s.kind === k.kind && s.status === 'proposed') })).filter((g) => g.items.length);
}

const label = (facts, id) => facts[id]?.label ?? `#${id}`;

/** One line saying what accepting would do. */
export function suggestionText(s, facts) {
  const a = label(facts, s.fact_id); const b = s.other_fact_id ? label(facts, s.other_fact_id) : '';
  switch (s.kind) {
    case 'same': return `Merge ${b} into ${a}`;
    case 'depends': return `${a} relies on ${b}`;
    case 'kind': return `${a} becomes a ${s.data?.kind ?? '?'}`;
    case 'question': return `${a} becomes the open question “${s.data?.title ?? ''}”`;
    case 'topics': return `Tag ${a}: ${(s.data?.topics ?? []).join(', ')}`;
    default: return a;
  }
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
