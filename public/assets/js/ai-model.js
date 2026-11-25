// The AI work queue: labels and rules of the interface, without dependency, so that they can be unit tested.

export const AI_KINDS = {
  extract: { label: 'Extract facts', short: 'Extraction', icon: 'files', hint: 'Read a file, the PDF of a reference or a conversation, and add the results it states, with exact quotations.', needs: 'document' },
  ask: { label: 'Ask a question', short: 'Question', icon: 'comment', hint: 'Get the opinion of the AI. You can also write @AI in any message or comment.', needs: 'prompt' },
  bib: { label: 'Find references', short: 'References', icon: 'book', hint: 'Search the literature. A person validates each suggestion.', needs: null },
  derive: { label: 'Prove new facts', short: 'Proof search', icon: 'graph', hint: 'Waits until a member starts a proof search from their AI client, with their own time and usage limits. Results arrive unchecked.', needs: null },
  review: { label: 'Independent review', short: 'Review', icon: 'check-circle', hint: 'A model independent of the author checks the proof and records a verdict.', needs: 'fact' },
  notation: { label: 'Review the notation', short: 'Notation', icon: 'book', hint: 'Looks at the notation every fact defines for itself, and proposes making shared symbols global, with one meaning per symbol. The consolidation settles them, and people can confirm or undo its choices.', needs: null },
  consolidate: { label: 'Consolidate the facts', short: 'Consolidation', icon: 'layers', hint: 'Reads the whole facts database and proposes what no single extraction sees: the same result in two sources, missing dependencies, remarks that are open questions, subject tags, and the cited results that proofs use. Queued after each round of extractions. People decide.', needs: null },
  source_check: { label: 'Check the source', short: 'Source check', icon: 'book', hint: 'Reads the source of a result cited without proof, and says whether it states the result as written. Evidence only: a person still accepts the citation.', needs: 'fact' },
  lean: { label: 'Lean proof', short: 'Lean', icon: 'code', hint: 'Writes a Lean proof, kept only if it compiles. A person must still compare the Lean statement with the fact.', needs: 'fact' },
};

export const TASK_STATUS = {
  pending: { label: 'Waiting for an AI client', short: 'Waiting', tone: 'neutral' },
  running: { label: 'Running', short: 'Running', tone: 'info' },
  done: { label: 'Done', short: 'Done', tone: 'good' },
  failed: { label: 'Failed', short: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', short: 'Cancelled', tone: 'off' },
};

export const TASK_SEGMENTS = [['done', 'Done', '#0d9488'], ['running', 'Running', '#4f46e5'], ['pending', 'Waiting', '#98a2b3'], ['failed', 'Failed', '#b42318']];

export function requestError(d) {
  const k = AI_KINDS[d.kind];
  if (!k) return 'Choose what the AI should do.';
  if (k.needs === 'document' && !d.document) return 'Choose a file, a reference or a conversation.';
  if (k.needs === 'fact' && !d.fact) return 'Choose a fact.';
  if (k.needs === 'prompt' && !String(d.prompt || '').trim()) return 'Write your question.';
  if (String(d.prompt || '').length > 4000) return 'The instructions are too long (4000 characters at most).';
  return null;
}

export function requestBody(d) {
  const b = { kind: d.kind };
  const prompt = String(d.prompt || '').trim();
  if (prompt) b.prompt_text = prompt;
  if (d.kind === 'extract') {
    const ref = String(d.document).match(/^(bib|conv):(\d+)$/);
    if (ref?.[1] === 'conv') Object.assign(b, { source_type: 'conversation', source_id: +ref[2] }, d.publishPrivate ? { publish_private: true } : {});
    else Object.assign(b, ref ? { source_type: 'bib', source_id: +ref[2] } : { source_type: 'document', source_id: +d.document });
  }
  else if (AI_KINDS[d.kind]?.needs === 'fact') Object.assign(b, { source_type: 'fact', source_id: +d.fact });
  else if (d.kind === 'derive' && d.question) Object.assign(b, { source_type: 'question', source_id: +d.question });
  return b;
}

export function filterTasks(tasks, filter) {
  if (filter === 'open') return tasks.filter((t) => t.status === 'pending' || t.status === 'running');
  if (filter === 'done') return tasks.filter((t) => t.status === 'done');
  if (filter === 'failed') return tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled');
  return tasks;
}

/** A group of the queue in a few words: a rewrite in the project notation is not a review of the notation. */
export function groupLabel(group) {
  if (group === 'notation_rephrase') return 'Rewrite facts in the project notation';
  if (group === 'source_check') return 'Check the sources of cited results';
  return AI_KINDS[group]?.label || 'AI tasks';
}

/** "3 of 12 done · 1 running · 8 waiting · 1 failed", and why nothing starts when every waiting task waits for others. */
export function groupSummary(g) {
  const c = g.counts || {};
  const finished = (c.done || 0) + (c.failed || 0) + (c.cancelled || 0);
  const parts = [`${c.done || 0} of ${g.total} done`];
  if (c.running) parts.push(`${c.running} running`);
  if (c.pending) parts.push(`${c.pending} waiting`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
  if (g.blocked) parts.push('after other work');
  else if (finished === g.total && g.total) parts.push('finished');
  return parts.join(' · ');
}

/**
 * The queue by kind, in the scheduler's order (the server's): each group with its tasks, those that will run first first.
 * A filter keeps the groups that have tasks in it, with only those tasks.
 */
export function queueGroups(groups, tasks, filter = 'all') {
  return (groups || []).map((g) => ({ ...g, label: groupLabel(g.group), tasks: filterTasks((tasks || []).filter((t) => t.group === g.group), filter) }))
    .filter((g) => filter === 'all' || g.tasks.length);
}

export function taskTitle(t) {
  const k = t.kind === 'notation' && t.source_type === 'fact' ? 'Rewrite in the project notation' : (AI_KINDS[t.kind]?.label || 'AI task');
  if (t.subject) return `${k}: ${t.subject}`;
  if (t.source_type === 'message') return 'Question in a conversation';
  if (t.source_type === 'comment') return 'Question in a comment';
  return k;
}

export const taskActions = (t, { me, owner }) => {
  const mine = owner || t.requested_by === me;
  return { cancel: mine && ['pending', 'running'].includes(t.status), retry: mine && ['failed', 'cancelled'].includes(t.status) };
};

/** Where a finished task put its result. */
export function resultLinks(t) {
  const r = t.result || {};
  const out = (r.fact_ids || []).map((id) => ({ label: `Fact #${id}`, view: 'facts', id }));
  if (r.reply?.type === 'message') out.push({ label: 'Open the answer', view: 'conversations', id: r.reply.conversation_id });
  if (r.reply?.type === 'comment') {
    const view = { oquestion: 'questions', conversation: 'conversations', document: 'files', bib: 'bib', fact: 'facts' }[r.reply.target_type];
    if (view) out.push({ label: 'Open the answer', view, id: r.reply.target_id, query: { comment: r.reply.root } });
    if (r.reply.target_type === 'notation') out.push({ label: 'Open the answer', view: 'facts', id: null, query: { mode: 'notation', notation: r.reply.target_id, comment: r.reply.root } });
  }
  if (t.kind === 'consolidate' && t.status === 'done') out.push({ label: 'Review the proposals', view: 'facts', id: null, query: { mode: 'consolidate' } });
  return out;
}

export function suggestionLink(s) {
  if (s.doi) return { label: `DOI ${s.doi}`, href: `https://doi.org/${encodeURI(s.doi)}` };
  if (s.arxiv) return { label: `arXiv ${s.arxiv}`, href: `https://arxiv.org/abs/${encodeURI(s.arxiv)}` };
  if (/^https?:\/\//i.test(s.url || '')) return { label: 'Open the source', href: s.url };
  return null;
}

/** The bibliography progress: PDFs attached, and PDFs whose facts were extracted. */
export function bibProgress(p) {
  const x = { total: 0, with_pdf: 0, extracted: 0, new_comments: 0, queued: 0, failed: 0, remaining: 0, ...(p || {}) };
  const share = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  return { ...x, pdfPercent: share(x.with_pdf, x.total), extractedPercent: share(x.extracted, x.with_pdf), toQueue: x.remaining + x.failed + x.new_comments };
}

export const EXTRACTION_LABEL = {
  done: 'facts extracted', comments: 'new comments', queued: 'extraction queued', failed: 'extraction failed',
};

export const CLIENT_PERIODS = [['d7', '7 days'], ['d30', '30 days'], ['all', 'All time']];

/** Computing time, short: 45 s, 12 min, 3 h 05 min. A dash when nothing was measured. */
export function computeTime(ms) {
  const n = Math.round(+ms || 0);
  if (n <= 0) return '—';
  if (n < 60000) return `${Math.max(1, Math.round(n / 1000))} s`;
  if (n < 3600000) return `${Math.round(n / 60000)} min`;
  return `${Math.floor(n / 3600000)} h ${String(Math.round(n / 60000) % 60).padStart(2, '0')} min`;
}

/** One line on a project's computing time: what went to standard work and to proving new facts. */
export function aiTimeSummary(t) {
  const s = t?.standard || { ms: 0 }; const p = t?.proving || { ms: 0, facts: 0 };
  if (!s.ms && !p.ms) return 'No AI computing yet';
  return `${computeTime(s.ms)} standard · ${computeTime(p.ms)} proving, ${p.facts} new fact${p.facts === 1 ? '' : 's'}`;
}

/** What a client is doing now. */
export function clientStatus(c, now = Date.now()) {
  if (c.working) {
    const start = c.working.started_at ? Date.parse(c.working.started_at.replace(' ', 'T') + 'Z') : NaN;
    const what = c.working.private ? 'a task in a private conversation' : `${AI_KINDS[c.working.kind]?.short || 'a task'}${c.working.subject ? ': ' + c.working.subject : ''}`;
    return { tone: 'info', label: 'Working', text: `Working on ${what}`, since: Number.isFinite(start) ? computeTime(Math.max(0, now - start)) : null };
  }
  if (c.online) return { tone: 'good', label: 'Online', text: 'Online, waiting for work' };
  return { tone: 'off', label: 'Offline', text: c.last_seen_at ? 'Offline' : 'Not seen since this page started tracking it' };
}

/** Computing time per kind of work, largest first, with its share of the period. */
export function timeByKind(byKind) {
  const rows = Object.entries(byKind || {}).map(([kind, v]) => ({ kind, label: AI_KINDS[kind]?.short || kind, n: v.n, ms: v.ms }));
  const total = rows.reduce((s, r) => s + r.ms, 0);
  return rows.sort((a, b) => b.ms - a.ms).map((r) => ({ ...r, share: total ? Math.round((r.ms / total) * 100) : 0 }));
}

/** What the Ask AI button adds to a draft, so that everyone sees that the AI was asked. */
export function askAiPrefix(text) {
  const t = String(text || '').trim();
  if (!t) return '@AI What is your opinion on this discussion?';
  return /(?<![\w@.])@AI\b/i.test(t) ? '' : '@AI ';
}

/** The line above the reply box while the AI is asked. */
export function opinionStatus(o) {
  if (!o) return null;
  if (o.running) return { tone: 'info', text: 'The AI is preparing its answer.' };
  if (o.waiting) return o.clients
    ? { tone: 'neutral', text: 'The AI was asked. A participant’s AI client will answer here.' }
    : { tone: 'warn', text: 'The AI was asked. It will answer when a participant starts their AI client.' };
  if (o.failed_task) return { tone: 'bad', text: 'The AI could not answer.', task: o.failed_task };
  return null;
}

/** The button of a conversation, from where its extraction stands. */
export function conversationExtraction(x) {
  const state = x?.state || 'none';
  return {
    none: { label: 'Extract facts', disabled: false },
    new_messages: { label: 'Extract new messages', disabled: false },
    failed: { label: 'Extract again', disabled: false },
    queued: { label: 'Extraction queued', disabled: true },
    done: { label: 'Facts extracted', disabled: true },
  }[state] || { label: 'Extract facts', disabled: false };
}

/** What a participant approves before results of a private conversation reach the whole project. */
export const privateExtractionNotice = (outside) => `This conversation is private. ${outside ? `${outside} project member${outside > 1 ? 's' : ''} cannot read it, but ` : 'Project members outside it cannot read it, but '}every member will see the statements and proofs extracted from it. Quotes and links stay hidden from them. The other participants will be notified. Only the messages present now will be read.`;

/** "@AI" is offered first in the @ menu when the text typed so far can still become it. */
export const offersAskAi = (query) => ['', 'a', 'ai'].includes(String(query).toLowerCase());
