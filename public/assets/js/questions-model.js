// Open questions: tree logic. No dependency, so that it can be unit tested.

// Each status with its icon and what it means, for lists that show the icon alone and explain it on hover. "quiet": the common
// state, which lists leave out (almost every question is open).
export const QUESTION_STATUS = {
  open: { label: 'Open', cls: 'open', icon: 'help', hint: 'Open: nobody settled it yet.', quiet: true },
  active: { label: 'In progress', cls: 'active', icon: 'clock', hint: 'In progress: someone is working on it.' },
  partial: { label: 'Partial result', cls: 'partial', icon: 'check', hint: 'Partial result: part of it is settled.' },
  solved: { label: 'Solved', cls: 'good', icon: 'check-circle', hint: 'Solved: a ratified positive answer.' },
  refuted: { label: 'Refuted', cls: 'bad', icon: 'x', hint: 'Refuted: a ratified negative answer.' },
  abandoned: { label: 'Abandoned', cls: 'off', icon: 'archive', hint: 'Abandoned: no longer pursued.' },
};

export const STRATEGY_STATUS = {
  idea: { label: 'Idea', cls: 'open', icon: 'lightbulb', hint: 'An idea: not tried yet.' },
  active: { label: 'Being tried', cls: 'active', icon: 'route', hint: 'Being tried.' },
  blocked: { label: 'Blocked', cls: 'partial', icon: 'lock', hint: 'Blocked: stuck at a step.' },
  succeeded: { label: 'Succeeded', cls: 'good', icon: 'check-circle', hint: 'Succeeded.' },
  failed: { label: 'Failed', cls: 'bad', icon: 'x', hint: 'Failed: it cannot work as stated.' },
  abandoned: { label: 'Abandoned', cls: 'off', icon: 'archive', hint: 'Abandoned.' },
};

export const PRIORITY = { high: 'High', normal: 'Normal', low: 'Low' };

export const ANSWER_KIND = {
  positive: { label: 'Positive answer', short: 'Yes', status: 'solved' },
  negative: { label: 'Negative answer', short: 'No', status: 'refuted' },
};

export const ANSWER_STATE = {
  proposed: { label: 'Awaiting ratification', cls: 'partial' },
  ratified: { label: 'Ratified', cls: 'good' },
  rejected: { label: 'Rejected', cls: 'bad' },
  revoked: { label: 'Revoked', cls: 'bad' },
  withdrawn: { label: 'Withdrawn', cls: 'off' },
};

export const FACT_SUPPORT = {
  validated: { ok: true, text: 'A human endorsed the current revision of this fact.' },
  unvalidated: { ok: false, text: 'A human must endorse this fact before the answer can be ratified.' },
  disputed: { ok: false, text: 'This fact is denied or disputed. Settle its reviews first.' },
  chain_broken: { ok: false, text: 'This fact relies on a denied, disputed or retracted fact.' },
  proof_disputed: { ok: false, text: 'The result is accepted but no proof of it is. Fix the proof, or propose and check another one.' },
  chain_unproved: { ok: false, text: 'This fact relies on a result whose proof is disputed.' },
  incomplete: { ok: false, text: 'A proof in this fact or below it uses a result of another work directly. Link that result to the fact that states it first.' },
  retracted: { ok: false, text: 'This fact is retracted.' },
  missing: { ok: false, text: 'This fact no longer exists.' },
};

/** The text typed after an @, or null. It can contain spaces, because question titles do. */
export function mentionQuery(before) {
  const m = before.match(/(?:^|\s)@([^\n@]{0,60})$/u);
  return m ? m[1] : null;
}

/** After a space, only titles can still match, and typing goes on normally if none does. */
export function mentionMatches(query, items) {
  if (!query.includes(' ')) return items;
  const titles = items.filter((x) => !['user', 'message', 'comment'].includes(x.type));
  return titles.length ? titles : null;
}

/** What a person can do with a proposed answer. The server enforces the same rules. */
export function answerActions(a, { me, answers = [] } = {}) {
  const proposed = a.state === 'proposed';
  const taken = answers.some((x) => x.state === 'ratified');
  const ok = !!FACT_SUPPORT[a.support]?.ok;
  return {
    ratify: proposed && ok && !taken,
    reject: proposed,
    withdraw: proposed && a.proposed_by === me,
    revoke: a.state === 'ratified',
    review: (proposed || a.state === 'ratified') && !!a.fact && a.fact.status !== 'retracted',
    atRisk: a.state === 'ratified' && !ok,
  };
}

const CLOSED = new Set(['solved', 'refuted', 'abandoned']);
const RANK = { high: 0, normal: 1, low: 2 };

export const isClosed = (status) => CLOSED.has(status);

/** Nested nodes, by priority then age. A question whose parent is missing becomes a root. */
export function buildTree(questions) {
  const nodes = new Map(questions.map((q) => [q.id, { ...q, children: [] }]));
  const roots = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id ? nodes.get(n.parent_id) : null;
    if (parent) parent.children.push(n); else roots.push(n);
  }
  const order = (list) => {
    list.sort((a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || a.id - b.id);
    list.forEach((n) => order(n.children));
    return list;
  };
  return order(roots);
}

/** How many sub-questions, at any depth, are settled. */
export function progress(node) {
  let done = 0;
  let total = 0;
  const walk = (n) => n.children.forEach((c) => { total += 1; if (isClosed(c.status)) done += 1; walk(c); });
  walk(node);
  return { done, total };
}

function matches(n, terms, status) {
  if (status === 'unsettled' && isClosed(n.status)) return false;
  if (status !== 'all' && status !== 'unsettled' && n.status !== status) return false;
  if (!terms.length) return true;
  const text = [n.title, n.statement_text, n.ai_model, n.author, ...(n.strategies || []).map((s) => s.title)].join(' ').toLowerCase();
  return terms.every((t) => text.includes(t));
}

/** Rows to display. A filter keeps the ancestors of a match, so that its context stays visible. */
export function visibleRows(tree, { search = '', status = 'all', collapsed = [] } = {}) {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const filtering = terms.length > 0 || status !== 'all';
  const hidden = new Set(collapsed);
  const rows = [];
  const keep = (n) => matches(n, terms, status) || n.children.some(keep);
  const walk = (list, depth) => {
    for (const n of list) {
      if (filtering && !keep(n)) continue;
      const open = filtering || !hidden.has(n.id);
      rows.push({ node: n, depth, hasChildren: n.children.length > 0, open, dimmed: filtering && !matches(n, terms, status) });
      if (open) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

/** Questions that can become the parent of `id`: never itself or one of its descendants. */
export function validParents(questions, id) {
  if (!id) return questions;
  const banned = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const q of questions) {
      if (q.parent_id && banned.has(q.parent_id) && !banned.has(q.id)) { banned.add(q.id); grew = true; }
    }
  }
  return questions.filter((q) => !banned.has(q.id));
}

/** Unread count of a question, including its strategies. */
export function unreadOf(q, unread = {}) {
  const own = unread.oquestion?.[q.id] || 0;
  return (q.strategies || []).reduce((sum, s) => sum + (unread.strategy?.[s.id] || 0), own);
}

/** A strategy still being worked on comes first, then the most recently changed. */
export function sortStrategies(list) {
  const rank = { active: 0, blocked: 1, idea: 2, succeeded: 3, failed: 4, abandoned: 5 };
  return [...list].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(b.updated_at).localeCompare(String(a.updated_at)) || a.id - b.id);
}
