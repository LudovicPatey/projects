// The AI work queue: labels and rules of the interface, without dependency, so that they can be unit tested.

export const AI_KINDS = {
  extract: { label: 'Extract facts', short: 'Extraction', icon: 'files', hint: 'Read a file or the PDF of a reference, and add the results it states, with exact quotations.', needs: 'document' },
  ask: { label: 'Ask a question', short: 'Question', icon: 'comment', hint: 'Get the opinion of the AI. You can also write @AI in any message or comment.', needs: 'prompt' },
  bib: { label: 'Find references', short: 'References', icon: 'book', hint: 'Search the literature. A person validates each suggestion.', needs: null },
  derive: { label: 'Prove new facts', short: 'Proof search', icon: 'graph', hint: 'Waits until a member starts a proof search from their AI client, with their own time and usage limits. Results arrive unchecked.', needs: null },
  review: { label: 'Independent review', short: 'Review', icon: 'check-circle', hint: 'A model independent of the author checks the proof and records a verdict.', needs: 'fact' },
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
  if (k.needs === 'document' && !d.document) return 'Choose a file or a reference.';
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
    const ref = String(d.document).match(/^bib:(\d+)$/);
    Object.assign(b, ref ? { source_type: 'bib', source_id: +ref[1] } : { source_type: 'document', source_id: +d.document });
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

export function taskTitle(t) {
  const k = AI_KINDS[t.kind]?.label || 'AI task';
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
  }
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

/** "@AI" is offered first in the @ menu when the text typed so far can still become it. */
export const offersAskAi = (query) => ['', 'a', 'ai'].includes(String(query).toLowerCase());
