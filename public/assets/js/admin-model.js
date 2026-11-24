// The Admin page of a project: what each maintenance action does, without dependency, so that it can be unit tested.

export const ADMIN_ACTIONS = {
  cancel_waiting: { icon: 'x', group: 'ai', title: 'Cancel the waiting AI tasks', text: 'Every task that no AI client has taken yet is cancelled. Running tasks finish.', options: [] },
  retry_failed: { icon: 'history', group: 'ai', title: 'Try the failed AI tasks again', text: 'Every failed task waits again for an AI client, with its attempts reset.', options: [] },
  requeue_extraction: { icon: 'sparkles', group: 'facts', title: 'Extract what is not extracted yet', text: 'Queues an extraction for each file and reference PDF that has none waiting or finished. It uses the subscription of the members whose clients run it.', options: [] },
  reset_extraction: { icon: 'history', group: 'facts', title: 'Reset the extraction status', text: 'Forgets every extraction of files and reference PDFs, so that each one shows as not extracted. Facts already extracted stay.', options: ['requeue'] },
  clear_notation: { icon: 'book', group: 'facts', title: 'Clear the project notation', text: 'Deletes the proposals that nobody agreed on. With the option, also deletes agreed entries and the facts rewritten in them.', options: ['all'] },
  reset_facts: { icon: 'graph', group: 'facts', title: 'Empty the facts database', text: 'Deletes every fact with its revisions, reviews, other proofs, Lean proofs, comments and rewrites, the answers they support, and the AI tasks about facts. Extraction starts over. The bibliography, its PDFs, files, conversations, questions and members stay.', options: ['notation', 'requeue'] },
};

export const ADMIN_OPTIONS = {
  requeue: 'Then extract every file and reference PDF again',
  notation: 'Also delete the project notation',
  all: 'Also delete agreed entries and the rewritten facts',
};

const WORDS = {
  tasks: ['AI task', 'AI tasks'], facts: ['fact', 'facts'], reviews: ['review', 'reviews'], proofs: ['other proof', 'other proofs'], lean: ['Lean proof', 'Lean proofs'],
  comments: ['comment on facts', 'comments on facts'], answers: ['answer', 'answers'], ratified_answers: ['ratified answer', 'ratified answers'], question_links: ['link from questions', 'links from questions'],
  notation: ['notation entry', 'notation entries'], entries: ['notation entry', 'notation entries'], rephrasings: ['rewritten fact', 'rewritten facts'],
  files: ['file', 'files'], reference_pdfs: ['reference PDF', 'reference PDFs'], queued: ['extraction queued', 'extractions queued'], queued_after: ['extraction queued afterwards', 'extractions queued afterwards'],
};

/** "12 facts, 3 reviews": the non-zero changes, in words. */
export function describeChanges(changes) {
  const parts = Object.entries(changes || {}).filter(([, n]) => +n > 0).map(([k, n]) => `${n} ${(WORDS[k] || [k, k])[+n === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(', ') : 'Nothing to change';
}

/** The typed confirmation of a destructive action: the project title, whatever the case and spaces around it. */
export const confirmed = (typed, title) => String(typed || '').trim().toLowerCase() === String(title || '').trim().toLowerCase() && !!String(title || '').trim();

export const hasChanges = (changes) => Object.values(changes || {}).some((n) => +n > 0);
