// The reference system of rich text. No dependency, so that it can be unit tested.
// KEEP THIS IN SYNC with src/References.php: tests/references.test.mjs fails otherwise.

export const REF_TYPES = {
  question: { label: 'Question', plural: 'Questions', icon: 'target', aliases: ['q', 'question', 'questions'] },
  strategy: { label: 'Strategy', plural: 'Strategies', icon: 'route', aliases: ['s', 'strategy', 'strategies'] },
  revision: { label: 'Strategy version', plural: 'Strategy versions', icon: 'history', aliases: ['rev', 'revision'] },
  answer: { label: 'Answer', plural: 'Answers', icon: 'check-circle', aliases: ['a', 'answer', 'answers'] },
  fact: { label: 'Fact', plural: 'Facts', icon: 'graph', aliases: ['f', 'fact', 'facts'] },
  review: { label: 'Fact review', plural: 'Fact reviews', icon: 'eye', aliases: ['review', 'reviews'] },
  proof: { label: 'Other proof', plural: 'Other proofs', icon: 'check-circle', aliases: ['proof', 'proofs'] },
  notation: { label: 'Notation', plural: 'Notation', icon: 'book', aliases: ['notation', 'symbol', 'def'] },
  lean: { label: 'Lean proof', plural: 'Lean proofs', icon: 'code', aliases: ['lean'] },
  document: { label: 'File', plural: 'Files', icon: 'files', aliases: ['file', 'files', 'doc', 'document'] },
  version: { label: 'File version', plural: 'File versions', icon: 'layers', aliases: ['version', 'v'] },
  bib: { label: 'Reference', plural: 'References', icon: 'book', aliases: ['bib', 'ref', 'cite', 'reference'] },
  suggestion: { label: 'Suggested reference', plural: 'Suggested references', icon: 'lightbulb', aliases: ['suggestion', 'suggested'] },
  conversation: { label: 'Conversation', plural: 'Conversations', icon: 'mail', aliases: ['conv', 'conversation', 'mail'] },
  message: { label: 'Message', plural: 'Messages', icon: 'reply', aliases: ['msg', 'message', 'messages'] },
  comment: { label: 'Comment', plural: 'Comments', icon: 'comment', aliases: ['comment', 'comments'] },
  aitask: { label: 'AI task', plural: 'AI tasks', icon: 'sparkles', aliases: ['task', 'tasks', 'aitask'] },
  user: { label: 'Person', plural: 'People', icon: 'user', aliases: ['user', 'person', 'people', 'who'] },
  project: { label: 'Project', plural: 'Project', icon: 'home', aliases: ['project'] },
};

export const REF_ORDER = Object.keys(REF_TYPES);

const ALIASES = new Map(REF_ORDER.flatMap((t) => REF_TYPES[t].aliases.map((a) => [a, t])));

export const refKey = (type, id) => `${type}:${id}`;

/** "fact:lemma" searches among facts. A word that is not a type stays part of the search. */
export function parseRefQuery(query) {
  const m = String(query).match(/^([a-z]+):(.*)$/i);
  const type = m ? ALIASES.get(m[1].toLowerCase()) : null;
  return type ? { type, term: m[2].trim() } : { type: null, term: String(query).trim() };
}

export function sortRefs(items) {
  const rank = (t) => { const i = REF_ORDER.indexOf(t); return i < 0 ? 99 : i; };
  return items.map((x, i) => [x, i]).sort((a, b) => rank(a[0].type) - rank(b[0].type) || a[1] - b[1]).map(([x]) => x);
}

export function refHref(item, pid) {
  const l = item?.link;
  if (!l || !pid) return null;
  const q = l.query ? new URLSearchParams(Object.entries(l.query).map(([k, v]) => [k, String(v)])).toString() : '';
  return `#/p/${pid}/${l.view}${l.id ? '/' + l.id : ''}${q ? '?' + q : ''}`;
}

const STATUS = {
  open: ['Open', 'neutral'], active: ['In progress', 'info'], partial: ['Partial result', 'warn'], solved: ['Solved', 'good'], refuted: ['Refuted', 'bad'], abandoned: ['Abandoned', 'off'],
  idea: ['Idea', 'neutral'], blocked: ['Blocked', 'warn'], succeeded: ['Succeeded', 'good'], failed: ['Failed', 'bad'],
  proposed: ['Awaiting ratification', 'warn'], ratified: ['Ratified', 'good'], rejected: ['Rejected', 'bad'], revoked: ['Revoked', 'bad'], withdrawn: ['Withdrawn', 'off'],
  unchecked: ['Unchecked', 'neutral'], ai_checked: ['AI-checked', 'info'], human_checked: ['Human-checked', 'good'], double_checked: ['Human + AI checked', 'good'], accepted: ['Citation accepted', 'good'], source_confirmed: ['Source confirmed by AI', 'info'], proof_disputed: ['Proof disputed', 'warn'], definition: ['Definition', 'neutral'], disputed: ['Disputed', 'bad'], retracted: ['Retracted', 'off'],
  correct: ['Correct', 'good'], gap: ['Gap', 'warn'], incorrect: ['Incorrect', 'bad'], compiles: ['Reported compiling', 'good'], fails: ['Reported failing', 'bad'], incomplete: ['Contains sorry', 'warn'],
  suggested: ['Awaiting validation', 'warn'], accepted: ['Accepted', 'good'], task_pending: ['Waiting for an AI client', 'neutral'], task_running: ['Running', 'info'], task_done: ['Done', 'good'], task_failed: ['Failed', 'bad'], task_cancelled: ['Cancelled', 'off'],
  human: ['Human', 'good'], ai: ['AI', 'info'], owner: ['Owner', 'info'], member: ['Member', 'neutral'], agent: ['AI agent', 'info'], solved_project: ['Solved', 'good'], archived: ['Archived', 'off'],
};

/** Readable status with its tone. The tone is always shown together with the words. */
export function statusInfo(status) {
  if (!status) return null;
  const s = STATUS[status];
  return s ? { label: s[0], tone: s[1] } : { label: String(status).replaceAll('_', ' '), tone: 'neutral' };
}

const VERBS = {
  created: 'added', updated: 'updated', status: 'changed the status of', comment: 'commented on', comment_edit: 'edited a comment on', revision: 'revised',
  review: 'reviewed', retracted: 'retracted', reinstated: 'reinstated', message: 'wrote in', answer: 'proposed an answer to', ratified: 'ratified an answer to',
  rejected: 'rejected an answer to', revoked: 'revoked an answer to', withdrawn: 'withdrew an answer to', answer_fact: 'changed the fact behind', link: 'linked an item to',
  joined: 'added', version: 'uploaded a new version of', restored: 'restored', lean: 'added a Lean proof to', proof: 'proposed a proof of', lean_check: 'checked the Lean proof of', new: 'started',
};

export const activityVerb = (kind) => VERBS[kind] || 'updated';
