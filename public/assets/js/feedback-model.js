// Bug reports and feature requests: logic without dependency, so that it can be unit tested.

export const FEEDBACK_KINDS = {
  bug: { label: 'Bug report', short: 'Bug', icon: 'bug', tone: 'bad', titleHint: 'What goes wrong?', bodyHint: 'What did you do, what did you expect, and what happened instead?' },
  feature: { label: 'Feature request', short: 'Feature', icon: 'lightbulb', tone: 'info', titleHint: 'What would you like?', bodyHint: 'What are you trying to do, and how would this help?' },
};

export const FEEDBACK_STATUS = {
  new: { label: 'Received', tone: 'neutral' },
  planned: { label: 'Planned', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'warn' },
  done: { label: 'Done', tone: 'good' },
  declined: { label: 'Declined', tone: 'off' },
};

export const FEEDBACK_IMPACT = { minor: 'Minor', normal: 'Normal', blocking: 'Blocking' };

export const MAX_TITLE = 160;
export const MAX_BODY = 8000;

/** The address of the current page, without its query, which may hold search terms. */
export function pageContext(hash) {
  const page = String(hash || '').split('?')[0];
  return /^#\/(p\/\d+(\/[a-z]+(\/\d+)?)?|projects|profile|help|feedback(\/\d+)?)$/.test(page) ? page : null;
}

export function draftError(d) {
  if (!FEEDBACK_KINDS[d.kind]) return 'Choose a bug report or a feature request.';
  if (!d.title.trim()) return 'A short title is required.';
  if (d.title.trim().length > MAX_TITLE) return `The title is too long (${MAX_TITLE} characters at most).`;
  if (!d.body.trim()) return 'Please describe it.';
  if (d.body.trim().length > MAX_BODY) return `The description is too long (${MAX_BODY} characters at most).`;
  return null;
}

export function filterReports(list, { kind = 'all', status = 'all', search = '' } = {}) {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((r) => (kind === 'all' || r.kind === kind)
    && (status === 'all' || (status === 'open' ? !['done', 'declined'].includes(r.status) : r.status === status))
    && terms.every((t) => `${r.title} ${r.body_text} ${r.author || ''}`.toLowerCase().includes(t)));
}

export function reportCounts(list) {
  const c = { total: list.length, bug: 0, feature: 0, open: 0, done: 0 };
  for (const r of list) {
    c[r.kind] += 1;
    if (r.status === 'done') c.done += 1;
    if (!['done', 'declined'].includes(r.status)) c.open += 1;
  }
  return c;
}
