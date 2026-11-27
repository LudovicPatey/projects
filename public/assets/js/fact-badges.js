// What a fact's card shows as small icons, each with its explanation on hover: where it stands, where its proof comes from, whether
// it is a cited result, and who wrote it. The common case says nothing: the label "conclusion", which almost every fact has, is not
// shown. Without dependency, so that it can be tested.

/** Where a fact stands, as an icon: the tone says how settled it is, the title says what it means and what to do. */
export const STATUS_BADGE = {
  unchecked: { icon: 'clock', tone: 'muted', label: 'Unchecked', title: 'Unchecked: nobody reviewed it yet.' },
  ai_checked: { icon: 'check', tone: 'ai', label: 'AI-checked', title: 'AI-checked: an AI found its proof correct; no person has yet.' },
  human_checked: { icon: 'check', tone: 'good', label: 'Human-checked', title: 'Human-checked: a person found its proof correct.' },
  double_checked: { icon: 'check-circle', tone: 'good', label: 'Human + AI checked', title: 'Checked by a person and by an AI.' },
  accepted: { icon: 'check-circle', tone: 'good', label: 'Citation accepted', title: 'Cited result accepted: a person read the source.' },
  source_confirmed: { icon: 'book', tone: 'ai', label: 'Source confirmed by AI', title: 'An AI found it stated in its source; no person has checked it yet.' },
  definition: { icon: 'book', tone: 'muted', label: 'Definition', title: 'A definition: part of the notation, not checked like a result.' },
  proof_disputed: { icon: 'x', tone: 'warn', label: 'Proof disputed', title: 'Proof disputed: the result is accepted, but its proof has a gap or an error.' },
  disputed: { icon: 'x', tone: 'bad', label: 'Disputed', title: 'Disputed: someone found it wrong. Settle it before relying on it.' },
  retracted: { icon: 'trash', tone: 'bad', label: 'Retracted', title: 'Retracted: withdrawn; what relies on it is flagged.' },
};

/** Where its proof comes from. */
export const PROOF_BADGE = {
  human: { icon: 'user', tone: 'good', label: 'Human proof', title: 'Human proof: a person wrote it.' },
  ai: { icon: 'sparkles', tone: 'ai', label: 'AI proof', title: 'AI proof: an AI wrote it.' },
  mixed: { icon: 'users', tone: 'warn', label: 'Human + AI proof', title: 'Human + AI proof: written by both.' },
  none: { icon: 'help', tone: 'muted', label: 'No proof', title: 'No proof yet.' },
};

const words = (s) => String(s || '').toLowerCase().replace(/\\[a-z]+|[${}^_\\]/g, ' ').match(/[\p{L}\p{N}]{2,}/gu) || [];

/**
 * Whether a fact's statement says more than its title in a card's one line: not when the title's words are most of the statement's
 * opening, "A computable coloring with no Δ_2 solution" over "There is a computable coloring with no Δ_2 solution.". In real projects
 * the statement is usually the precise result its title names, and it stays.
 */
export function statementAddsToTitle(title, statement) {
  const t = words(title); const s = words(statement);
  if (!s.length) return false;
  if (!t.length) return true;
  const opening = new Set(s.slice(0, Math.max(t.length + 4, Math.ceil(t.length * 1.5))));
  return t.filter((w) => opening.has(w)).length / t.length < 0.8 || s.length > t.length * 1.6;
}

/** Labels worth showing: every one but "conclusion", the label of almost every fact. */
export const quietLabels = (labels) => (labels || []).filter((l) => l !== 'conclusion');

/**
 * The icons of a fact, in reading order: its state, a cited result or an outside result in its proof, its proof's origin, and the
 * AI that wrote it (the exact model on hover). Each {key, icon, tone, label, title}.
 */
export function factBadges(f) {
  const out = [];
  const s = STATUS_BADGE[f?.status];
  if (s) out.push({ key: 'status', ...s });
  if (f?.basis === 'cited') out.push({ key: 'cited', icon: 'book', tone: 'muted', label: 'Cited result', title: 'Cited result: stated by another work without its proof. A person who read the source accepts it.' });
  if (f?.incomplete) out.push({ key: 'outside', icon: 'link', tone: 'warn', label: 'Outside result', title: 'Its proof still uses a result of another work that is not a fact of the database yet.' });
  if (f?.basis !== 'cited') { const p = PROOF_BADGE[f?.proof_origin] || PROOF_BADGE.none; out.push({ key: 'proof', ...p }); }
  if (f?.ai_model) {
    const by = [`Written by ${f.ai_model}`, f.ai_user_name && `for ${f.ai_user_name}`].filter(Boolean).join(' ');
    out.push({ key: 'model', icon: 'bot', tone: 'muted', label: f.ai_model, title: `${by}.` });
  }
  return out;
}

/** What a reference's card shows as icons: its PDF, what extraction made of it, and the AI that entered it. */
export function bibBadges(e) {
  const out = [];
  out.push(e?.has_pdf
    ? { key: 'pdf', icon: 'pdf', tone: 'bad', label: 'PDF', title: 'Its PDF is attached: readers open it here, and AI clients extract its facts.' }
    : { key: 'pdf', icon: 'pdf', tone: 'muted', label: 'No PDF', title: 'No PDF yet: upload it to read it here and extract its facts.' });
  const x = e?.extraction?.state;
  const models = (e?.extraction?.models || []).join(', ');
  const ext = { done: ['sparkles', 'good', 'Facts extracted', `Its facts were extracted${models ? ` by ${models}` : ''}.`], queued: ['clock', 'muted', 'Extraction queued', 'Extraction queued: an AI client will read it.'],
    failed: ['x', 'bad', 'Extraction failed', 'Extraction failed: try again from its page.'], comments: ['comment', 'warn', 'New comments', 'New comments since its extraction: extract it again to take them into account.'] }[x];
  if (ext) out.push({ key: 'extraction', icon: ext[0], tone: ext[1], label: ext[2], title: ext[3] });
  if (e?.ai_model) out.push({ key: 'model', icon: 'bot', tone: 'muted', label: e.ai_model, title: `Entered by ${e.ai_model}${e.ai_user_name ? ` for ${e.ai_user_name}` : ''}.` });
  return out;
}
