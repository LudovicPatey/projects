// The AI work queue: labels and rules of the interface, without dependency, so that they can be unit tested.

export const AI_KINDS = {
  extract: { label: 'Extract facts', short: 'Extraction', icon: 'files', hint: 'Read a file, the PDF of a reference or a conversation, and add the results it states, with exact quotations.', needs: 'document' },
  ask: { label: 'Ask a question', short: 'Question', icon: 'comment', hint: 'Get the opinion of the AI. You can also write @AI in any message or comment.', needs: 'prompt' },
  bib: { label: 'Find references', short: 'References', icon: 'book', hint: 'Search the literature. A reference whose DOI or arXiv record confirms it is added at once; a person validates the others.', needs: null },
  derive: { label: 'Prove new facts', short: 'Proof search', icon: 'graph', hint: 'Waits until a member starts a proof search from their AI client, with their own time and usage limits. Results arrive unchecked.', needs: null },
  review: { label: 'Independent review', short: 'Review', icon: 'check-circle', hint: 'A model independent of the author checks the proof and records a verdict.', needs: 'fact' },
  notation: { label: 'Review the notation', short: 'Notation', icon: 'book', hint: 'Looks at the notation every fact defines for itself, and proposes making shared symbols global, with one meaning per symbol. The consolidation settles them, and people can confirm or undo its choices.', needs: null },
  consolidate: { label: 'Consolidate the facts', short: 'Consolidation', icon: 'layers', hint: 'Reads the whole facts database and proposes what no single extraction sees: the same result in two sources, missing dependencies, remarks that are open questions, subject tags, and the cited results that proofs use. Queued after each round of extractions. People decide.', needs: null },
  source_check: { label: 'Check the source', short: 'Source check', icon: 'book', hint: 'Reads the source of a result cited without proof, and says whether it states the result as written. Evidence only: a person still accepts the citation.', needs: 'fact' },
  lean: { label: 'Lean proof', short: 'Lean', icon: 'code', hint: 'Writes a Lean proof, kept only if it compiles. A person must still compare the Lean statement with the fact.', needs: 'fact' },
};

/** "3 h 20 min", "12 min": how long until a moment. */
function waitText(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  return min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`;
}

/**
 * A person's AI requests of the last 24 hours, as the interface shows them: a meter that turns amber near the limit and red at it,
 * how many are left, and when the next one frees up. The window slides: each request counts for 24 hours.
 */
export function usageView(u, now = Date.now()) {
  if (!u || !u.limit) return null;
  const left = Math.max(0, u.limit - u.used);
  const pct = Math.min(100, Math.round((100 * u.used) / u.limit));
  const tone = left === 0 ? 'bad' : pct >= 80 ? 'warn' : 'good';
  const next = u.next_free_at ? waitText(Date.parse(u.next_free_at) - now) : null;
  const text = left === 0
    ? `Limit reached. The next request is available in ${next}.`
    : `${left} left. Each request counts for 24 hours${u.used && next ? `: the oldest frees up in ${next}` : ''}.`;
  return { used: u.used, limit: u.limit, left, pct, tone, text, label: `${u.used} of ${u.limit} AI requests in the last 24 hours` };
}

/** Upkeep only the platform queues, as sweeps: shown in the queue, never offered in the request form. */
export const SWEEP_KINDS = {
  rewrite_check: { label: 'Check rewrites in the project notation', short: 'Rewrite check', icon: 'eye', hint: 'A second AI compares each rewrite with its original. One that changes the meaning is not shown. People can overrule it.' },
  notation_settle: { label: 'Settle the project notation', short: 'Notation sweep', icon: 'book', hint: 'Decides the symbols several facts define and the project notation does not have yet: global, local to their paper, or another spelling of an entry.' },
  instruct: { label: 'Follow an @AI instruction on a fact', short: 'Instruction', icon: 'comment', hint: 'An AI reads a member\'s @AI comment on a fact, replies in the thread, and starts what it asks: a variant, a correction, a repair, a review. Each goes through its own checks.' },
  statement_fix: { label: 'Correct statements members flagged', short: 'Correction', icon: 'edit', hint: 'An AI proposes corrected statements a member asked for, each with a proof, checking the source; or says the statement is right as it is.' },
  fix_check: { label: 'Check corrected statements', short: 'Correction check', icon: 'check-circle', hint: 'An AI of another company checks each proposed statement against the request, the source and its proof. A member then chooses which replace the fact.' },
  relink: { label: 'Check facts after a correction', short: 'Relink', icon: 'link', hint: 'An AI reads each fact that relied on a superseded fact: does its proof work with a corrected statement?' },
  relink_check: { label: 'Check those readings', short: 'Relink check', icon: 'check-circle', hint: 'An AI of another company checks each reading. Agreed, the fact relies on the corrected statement, or a repair of its proof starts.' },
  proof_repair: { label: 'Repair proofs a review found flawed', short: 'Proof repair', icon: 'edit', hint: 'An AI of another company than the reviewer repairs the proof, or says why the review is wrong or that the gap cannot be fixed. A repaired proof is added beside the original.' },
  repair_check: { label: 'Check repaired proofs', short: 'Repair check', icon: 'check-circle', hint: 'An AI of the reviewer’s side checks each repair. Rounds go on until both sides agree on a proof or a gap, or three rounds have passed.' },
  proof_review: { label: 'Review proofs nobody reviewed', short: 'Proof review', icon: 'check-circle', hint: 'An independent AI referees each proof nobody reviewed, the facts others rely on first: correct, a gap or an error. It counts like any AI review, and people can review too.' },
  second_reading: { label: 'Second reading of proposals', short: 'Second reading', icon: 'eye', hint: 'Another AI reads again the consolidation proposals it was not sure of, applies those it agrees with and drops the others.' },
};

/**
 * The AI passes an object may still wait for, by sweep: what the pass will do, and what a person should do meanwhile. Shown so that
 * nobody fixes by hand what an AI is about to do, and nobody takes the object for final.
 */
export const PENDING_PASSES = {
  rewrite: { name: 'Rewrite in the project notation', does: 'An AI writes this fact in the agreed notation, beside its reviewed text, which stays as it is.', meanwhile: 'No need to rewrite it by hand.' },
  check: { name: 'Check of the rewrite', does: 'A second AI compares the rewrite in the project notation with the original, and hides it if it changes the meaning.', meanwhile: 'You can still judge it yourself: your verdict wins.' },
  source: { name: 'Check against the source', does: 'An AI looks for this result in its source and records whether the source states it.', meanwhile: 'You can still accept it yourself if you read the source.' },
  review: { name: 'Proof review', does: 'An AI referees the proof against the facts it relies on: correct, a gap or an error. It runs on clients with Review proofs turned on.', meanwhile: 'People can review it too.' },
  types: { name: 'Notation review', does: 'An AI says what the parameters of this entry stand for, and so what the entry applies to.', meanwhile: 'No need to type them by hand, though Edit lets you.' },
  second: { name: 'Second reading', does: 'Another AI reads this proposal again: it applies it if it agrees, and drops it otherwise.', meanwhile: 'You can still accept or reject it yourself.' },
  repair: { name: 'Proof repair', does: 'A review found a flaw: an AI of another company repairs the proof, says why the review is wrong, or that the gap cannot be fixed.', meanwhile: 'No need to repair it by hand; you can still propose another proof.' },
  fix: { name: 'Correction of the statement', does: 'A member asked for a correction: an AI proposes corrected statements with proofs, checking the source, or says it is right as it is.', meanwhile: 'Nothing changes yet; no need to correct it by hand.' },
  fixcheck: { name: 'Check of the correction', does: 'An AI of another company checks each proposed statement against the request, the source and its proof. Then a member chooses which replace this fact.', meanwhile: 'Nothing changes yet.' },
  relink: { name: 'Check after a correction', does: 'A fact this one relied on was superseded by corrected statements: an AI reads this proof with them.', meanwhile: 'No need to relink it by hand.' },
  relcheck: { name: 'Check of that reading', does: 'An AI of another company checks whether this proof works with a corrected statement, or needed the old one.', meanwhile: 'No need to relink it by hand.' },
  recheck: { name: 'Check of the repair', does: 'An AI of the reviewer’s side checks the repaired proof, or the answer to the review. If it still finds a flaw, another round starts.', meanwhile: 'You can review the repaired proof yourself: your verdict counts like any review.' },
};

/** The notice for the passes an object waits for: [{sweep, open}] from the server. Empty when it is in its final state. */
export function pendingView(items) {
  return (items || []).filter((p) => PENDING_PASSES[p?.sweep]).map((p) => {
    const pass = PENDING_PASSES[p.sweep];
    const when = p.open ? 'Queued now: it runs as soon as an AI client takes it.' : 'Queued once nobody has added facts for a while, when an AI client asks for work.';
    return { sweep: p.sweep, name: pass.name, text: `${pass.does} ${when} ${pass.meanwhile}` };
  });
}

/**
 * A question an AI asked people about a fact, as the notice words it: who asks, what, and how a person answers it. The rewrite's
 * question closes when a person checks that rewrite; the source check's, when a person reviews the cited result.
 */
export function questionView(q) {
  if (!q?.text) return null;
  return q.kind === 'rewrite'
    ? { key: `rewrite-${q.fact_id}`, who: 'The AI that wrote it in the project notation asks', text: q.text, answer: 'Answer it by checking that version: Faithful or Unfaithful, under the statement.' }
    : { key: `source-${q.fact_id}`, who: 'The AI that checked its source asks', text: q.text, answer: 'Answer it by reviewing this cited result once you have read the source.' };
}

/** What the interface says about a kind of task, requestable or not. */
export const kindInfo = (kind) => AI_KINDS[kind] || SWEEP_KINDS[kind] || null;

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
  return kindInfo(group)?.label || 'AI tasks';
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
  const k = t.kind === 'notation' && ['fact', 'sweep'].includes(t.source_type) ? 'Rewrite in the project notation'
    : t.kind === 'consolidate' && t.source_type === 'sweep' ? SWEEP_KINDS.notation_settle.label : (kindInfo(t.kind)?.label || 'AI task');
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
  if (['consolidate', 'second_reading'].includes(t.kind) && t.status === 'done') out.push({ label: 'Review the proposals', view: 'facts', id: null, query: { mode: 'consolidate' } });
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
    const what = c.working.private ? 'a task in a private conversation' : `${kindInfo(c.working.kind)?.short || 'a task'}${c.working.subject ? ': ' + c.working.subject : ''}`;
    return { tone: 'info', label: 'Working', text: `Working on ${what}`, since: Number.isFinite(start) ? computeTime(Math.max(0, now - start)) : null };
  }
  if (c.online) return { tone: 'good', label: 'Online', text: 'Online, waiting for work' };
  return { tone: 'off', label: 'Offline', text: c.last_seen_at ? 'Offline' : 'Not seen since this page started tracking it' };
}

/** Computing time per kind of work, largest first, with its share of the period. */
export function timeByKind(byKind) {
  const rows = Object.entries(byKind || {}).map(([kind, v]) => ({ kind, label: kindInfo(kind)?.short || kind, n: v.n, ms: v.ms }));
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

/**
 * What "@AI" in a comment can ask for on each kind of object (src/Instructions.php), for the line under the comment box. Each action
 * goes through its own checks; a question gets an answer.
 */
export const AI_INSTRUCTIONS = {
  fact: 'a variant of this fact, a correction of its statement, a repair of its proof, a review, a Lean proof, a check of its source',
  oquestion: 'a strategy, sub-questions, a search for new facts or for references, a check of the proposed answers',
  strategy: 'a search for new facts that develop it, or for references',
  document: 'a new extraction of its facts, following what you say',
  bib: 'an extraction of facts from its PDF, a search for related works',
  notation: 'a change of this entry, proposed beside it; a rewrite of the facts in the agreed notation',
  conversation: 'an extraction of its facts, when every member can read it',
};

/** The line under a comment box: what @AI can do on this object, and that nothing changes without its checks. */
export function aiInstructionHint(targetType) {
  const can = AI_INSTRUCTIONS[targetType];
  return can ? `Write @AI to ask a question, or for ${can}. An AI replies here; what it starts goes through its usual checks.` : 'Write @AI to ask the AI: it replies here.';
}
