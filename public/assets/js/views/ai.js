import { api, expandFacts } from '../api.js';
import { store, link, attempt, refreshCounters, toast } from '../store.js';
import { timeAgo, fullDate } from '../util.js';
import { Pill, Kpi, StackBar } from '../dashboard.js';
import { bibProgress, privateExtractionNotice, clientStatus, computeTime, timeByKind, CLIENT_PERIODS, AI_KINDS, TASK_SEGMENTS, TASK_STATUS, filterTasks, requestBody, requestError, resultLinks, suggestionLink, taskActions, taskTitle, queueGroups, groupSummary, kindInfo } from '../ai-model.js';

export const AiView = {
  components: { Pill, Kpi, StackBar },
  props: { pid: Number, id: Number, query: Object },
  data() {
    return { d: null, filter: 'all', period: 'd7', draft: { kind: 'bib', prompt: '', document: '', question: '', fact: '' }, documents: [], references: [], conversations: [], questions: [], facts: [], busy: false, timer: null, bibData: null, openGroups: {} };
  },
  computed: {
    tasks() { return filterTasks(this.d?.tasks || [], this.filter); },
    queue() { return queueGroups(this.d?.groups, this.d?.tasks, this.filter); },
    task() { return (this.d?.tasks || []).find((t) => t.id === this.id) || null; },
    proposed() { return (this.d?.suggestions || []).filter((s) => s.status === 'proposed'); },
    decided() { return (this.d?.suggestions || []).filter((s) => s.status !== 'proposed' && !(s.auto_added && s.status === 'accepted')).slice(0, 5); },
    autoAdded() { return (this.d?.suggestions || []).filter((s) => s.auto_added && s.status === 'accepted').slice(0, 10); },
    error() { return requestError(this.draft); },
    online() { return this.d?.clients || []; },
    actions() { return this.task ? taskActions(this.task, { me: store.user.id, owner: store.project?.my_role === 'owner' }) : {}; },
    bib() { return bibProgress(this.bibData); },
    computers() { return this.d?.computers?.clients || []; },
    totals() { return this.d?.computers?.totals?.[this.period] || { done: 0, failed: 0, ms: 0, by_kind: {}, groups: null }; },
    groups() { const z = { done: 0, failed: 0, ms: 0, facts: 0 }; return { standard: z, proving: z, ...(this.totals.groups || {}) }; },
    kindTimes() { return timeByKind(this.totals.by_kind); },
    open() { return (this.d?.counts.pending || 0) + (this.d?.counts.running || 0); },
  },
  created() { this.kinds = AI_KINDS; this.periods = CLIENT_PERIODS; this.statuses = TASK_STATUS; this.segments = TASK_SEGMENTS; },
  async mounted() {
    await this.load();
    const [docs, qs, bib, facts, convs] = await Promise.all([attempt(() => api.get(`api/projects/${this.pid}/documents`)), attempt(() => api.get(`api/projects/${this.pid}/questions`)), attempt(() => api.get(`api/projects/${this.pid}/bib`)), attempt(() => api.get(`api/projects/${this.pid}/facts?compact=1`)), attempt(() => api.get(`api/projects/${this.pid}/conversations`))]);
    this.conversations = convs?.conversations || [];
    this.facts = expandFacts(facts).filter((f) => !f.retracted_at);
    this.references = (bib?.entries || []).filter((e) => e.has_pdf);
    this.bibData = bib?.progress || null;
    this.documents = docs?.documents || (Array.isArray(docs) ? docs : []);
    this.questions = qs?.questions || [];
    this.timer = setInterval(() => { if (!document.hidden) this.load(); }, 15000);
  },
  unmounted() { clearInterval(this.timer); },
  watch: {
    'query.suggestion': { handler() { this.reveal(); } },
  },
  methods: {
    link, timeAgo, fullDate, taskTitle, groupSummary, kindInfo, resultLinks, suggestionLink, clientStatus, computeTime,
    async load() {
      const r = await attempt(() => api.get(`api/projects/${this.pid}/ai`));
      if (r) { this.d = r; this.$nextTick(() => this.reveal()); }
    },
    reveal() {
      const id = this.query?.suggestion;
      if (id) this.$el?.querySelector?.(`[data-suggestion="${id}"]`)?.scrollIntoView({ block: 'center' });
    },
    share(ms) { return this.totals.ms ? Math.round((100 * ms) / this.totals.ms) : 0; },
    resultHref(x) { return link(x.view, x.id, x.query || null); },
    async send() {
      if (this.error || this.busy) return;
      const conv = this.draft.kind === 'extract' && String(this.draft.document).startsWith('conv:') ? this.conversations.find((c) => c.id === +String(this.draft.document).slice(5)) : null;
      if (conv?.private && !confirm(privateExtractionNotice())) return;
      this.busy = true;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/ai/tasks`, requestBody({ ...this.draft, publishPrivate: !!conv?.private })), 'Request added to the queue');
      this.busy = false;
      if (r) { this.draft.prompt = ''; await this.load(); }
    },
    async extractAll() {
      const n = this.bib.toQueue;
      if (!confirm(`Queue ${n} PDF${n > 1 ? 's' : ''} for fact extraction? Each one uses the AI subscription of the member whose client processes it.`)) return;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/bib/extract-all`, {}));
      if (r) { this.bibData = r.progress; toast(`${r.queued} added to the AI queue`, 'success'); await this.load(); }
    },
    async act(verb) {
      if (await attempt(() => api.post(`api/ai/tasks/${this.task.id}/${verb}`, {}))) await this.load();
    },
    async decide(s, verb) {
      if (verb === 'undo' && !confirm(`Take “${s.title}” out of the bibliography?`)) return;
      const r = await attempt(() => api.post(`api/bib-suggestions/${s.id}/${verb}`, {}), { accept: 'Added to the bibliography', reject: 'Suggestion rejected', undo: 'Taken out of the bibliography' }[verb]);
      if (r) { await this.load(); refreshCounters(); }
    },
  },
  template: `<div class="page wide ai-page">
    <header class="page-title"><span class="sh-icon"><icon name="sparkles" :size="22"/></span><div><h1>AI work</h1><p>The platform keeps the requests and results. The computing happens on the computers of the team.</p></div>
      <a class="btn" href="#/client"><icon name="download" :size="15"/> Get the AI client</a></header>
    <div v-if="!d" class="d-empty">Loading…</div>
    <template v-else>
      <section class="ai-banner" :class="online.length ? 'is-on' : 'is-off'" role="status">
        <span class="ai-dot" aria-hidden="true"></span>
        <div v-if="online.length"><b>{{ online.length }} AI client{{ online.length > 1 ? 's' : '' }} running</b><span>{{ online.map((c) => c.user_name + ' · ' + (c.ai_model || c.name)).join(', ') }}</span></div>
        <div v-else><b>No AI client is running</b><span>{{ open ? open + ' task' + (open > 1 ? 's wait' : ' waits') + ' until a member starts one.' : 'Requests will wait until a member starts one.' }}</span></div>
        <a v-if="!online.length" class="btn sm primary" href="#/client">Get the client</a>
      </section>
      <div class="kpi-grid ai-kpis">
        <kpi icon="clock" :value="d.counts.pending" label="waiting" tone="neutral"/>
        <kpi icon="sparkles" :value="d.counts.running" label="running" tone="accent"/>
        <kpi icon="check-circle" :value="d.counts.done" label="done" tone="good"/>
        <kpi icon="book" :value="proposed.length" label="references to validate" :tone="proposed.length ? 'warn' : 'neutral'"/>
      </div>
      <div class="ai-grid">
        <div class="ai-main">
          <section class="panel" id="ai-clients">
            <header class="ai-head"><h2><icon name="clock" :size="15"/> AI clients</h2>
              <div class="seg small" role="group" aria-label="Period"><button v-for="p in periods" :key="p[0]" :class="{on: period === p[0]}" :aria-pressed="period === p[0]" @click="period = p[0]">{{ p[1] }}</button></div></header>
            <div class="ai-compute">
              <div><b>{{ computeTime(totals.ms) }}</b><small>computing in all</small></div>
              <div><b>{{ computeTime(groups.standard.ms) }}</b><small><i class="ai-swatch is-standard" aria-hidden="true"></i>standard tasks · {{ groups.standard.done }} done</small></div>
              <div><b>{{ computeTime(groups.proving.ms) }}</b><small><i class="ai-swatch is-proving" aria-hidden="true"></i>proving new facts · {{ groups.proving.facts }} fact{{ groups.proving.facts === 1 ? '' : 's' }}</small></div>
              <div><b>{{ computers.filter((c) => c.online).length }}</b><small>online now</small></div>
            </div>
            <div v-if="totals.ms" class="ai-split" role="img" :aria-label="'Standard tasks ' + share(groups.standard.ms) + '%, proving new facts ' + share(groups.proving.ms) + '%'"><span class="is-standard" :style="{width: share(groups.standard.ms) + '%'}"></span><span class="is-proving" :style="{width: share(groups.proving.ms) + '%'}"></span></div>
            <p v-if="kindTimes.length" class="ai-kind-times"><span v-for="k in kindTimes" :key="k.kind" class="chip">{{ k.label }} · {{ computeTime(k.ms) }} <small>{{ k.share }}%</small></span></p>
            <div class="ai-clients">
              <article v-for="c in computers" :key="c.user_id + c.name" class="ai-client" :class="'is-' + clientStatus(c).tone">
                <span class="ai-client-dot" :title="clientStatus(c).label" aria-hidden="true"></span>
                <div class="ai-client-main">
                  <b>{{ c.name }}</b>
                  <small>{{ c.user_name }}<template v-if="c.ai_model"> · {{ c.ai_model }}</template><template v-if="c.version"> · v{{ c.version }}</template><span v-if="c.outdated" class="pill t-warn" :title="'Version ' + d.computers.latest_version + ' is available'">Update available</span></small>
                  <small class="ai-client-now"><span class="sr-only">{{ clientStatus(c).label }}: </span><a v-if="c.working?.id" :href="link('ai', c.working.id)">{{ clientStatus(c).text }}</a><template v-else>{{ clientStatus(c).text }}</template><template v-if="clientStatus(c).since"> · {{ clientStatus(c).since }}</template><template v-if="!c.online && c.last_seen_at"> · seen {{ timeAgo(c.last_seen_at) }}</template></small>
                </div>
                <div class="ai-client-stats"><b>{{ computeTime(c.stats[period].ms) }}</b><small>{{ c.stats[period].done }} done<template v-if="c.stats[period].failed"> · {{ c.stats[period].failed }} failed</template></small><small v-if="c.stats[period].proving_ms">{{ computeTime(c.stats[period].proving_ms) }} proving</small></div>
              </article>
              <div v-if="!computers.length" class="d-empty">No AI client has worked on this project yet.</div>
            </div>
            <p class="ai-note">Proving new facts means proof searches. Standard tasks are extraction, questions, references, reviews and Lean. Time is measured by each client on the tasks it finished or that failed for good, in this project.</p>
          </section>
          <section v-if="proposed.length || decided.length || autoAdded.length" class="panel" id="ai-suggestions">
            <header class="ai-head"><h2><icon name="lightbulb" :size="15"/> Suggested references</h2><small>Check the source before accepting</small></header>
            <p class="muted small">A reference whose DOI or arXiv record has the same title and first author is added to the bibliography at once, when the project lets the AI apply what it is sure of. The others wait here.</p>
            <article v-for="s in proposed" :key="s.id" class="ai-sugg" :data-suggestion="s.id" :class="{active: +query?.suggestion === s.id}">
              <div class="ai-sugg-main"><b><math-text :text="s.title"/></b>
                <small>{{ [s.authors, s.year, s.venue].filter(Boolean).join(' · ') }}</small>
                <p>{{ s.reason_text }}</p>
                <div class="ai-sugg-meta"><a v-if="suggestionLink(s)" :href="suggestionLink(s).href" target="_blank" rel="noopener noreferrer">{{ suggestionLink(s).label }} ↗</a><span class="badge ai">{{ s.ai_model }}</span><span v-if="s.ai_user_name">via {{ s.ai_user_name }}</span></div>
              </div>
              <div class="ai-sugg-actions"><button class="btn sm primary" @click="decide(s, 'accept')"><icon name="check" :size="13"/> Accept</button><button class="btn sm" @click="decide(s, 'reject')">Reject</button></div>
            </article>
            <div v-if="!proposed.length" class="d-empty">Nothing to validate.</div>
            <details v-if="autoAdded.length" class="ai-decided" open><summary>Added automatically ({{ autoAdded.length }})</summary>
              <div v-for="s in autoAdded" :key="s.id" class="d-row"><span class="pill t-good">{{ s.verified_by === 'arxiv' ? 'arXiv' : 'Crossref' }}</span><a class="d-title" :href="s.bib_id ? link('bib', s.bib_id) : undefined"><math-text :text="s.title"/></a><small class="muted">{{ timeAgo(s.decided_at) }}</small>
                <button class="btn xs" @click="decide(s, 'undo')" title="Take it out of the bibliography">Take back</button></div>
            </details>
            <details v-if="decided.length" class="ai-decided"><summary>Recently handled ({{ decided.length }})</summary>
              <a v-for="s in decided" :key="s.id" class="d-row" :href="s.bib_id ? link('bib', s.bib_id) : undefined"><pill :status="s.status"/><span class="d-title"><math-text :text="s.title"/></span><small>{{ s.decided_by_name }}</small></a>
            </details>
          </section>
          <section class="panel">
            <header class="ai-head"><h2><icon name="layers" :size="15"/> Queue</h2>
              <div class="seg small"><button v-for="f in [['all','All'],['open','Open'],['done','Done'],['failed','Failed']]" :key="f[0]" :class="{on: filter === f[0]}" @click="filter = f[0]">{{ f[1] }}</button></div></header>
            <stack-bar :counts="d.counts" :segments="segments" label="Tasks by status"/>
            <div class="ai-list">
              <div v-for="g in queue" :key="g.group" class="ai-qgroup" :class="{open: openGroups[g.group]}">
                <button type="button" class="ai-row ai-group" :aria-expanded="!!openGroups[g.group]" @click="openGroups[g.group] = !openGroups[g.group]">
                  <span class="action-icon t-info"><icon :name="kindInfo(g.group === 'notation_rephrase' ? 'notation' : g.group)?.icon || 'sparkles'" :size="14"/></span>
                  <span class="ai-row-main"><b>{{ g.label }}</b>
                    <span class="ai-progress" role="img" :aria-label="groupSummary(g)"><i v-for="s in segments" v-show="g.counts[s[0]]" :key="s[0]" :style="{flexGrow: g.counts[s[0]], background: s[2]}"></i><i v-if="g.counts.cancelled" :style="{flexGrow: g.counts.cancelled}" class="off"></i></span>
                    <small>{{ groupSummary(g) }}</small></span>
                  <icon name="chevron" :size="15"/>
                </button>
                <template v-if="openGroups[g.group] || g.tasks.some((x) => x.id === id)">
                  <a v-for="t in g.tasks.slice(0, 60)" :key="t.id" class="ai-row ai-row-in" :class="{active: t.id === id}" :href="t.id === id ? link('ai') : link('ai', t.id)">
                    <span class="ai-row-main"><b><math-text :text="t.subject || taskTitle(t)"/></b><small>{{ t.requested_by_name || 'Platform' }} · {{ timeAgo(t.created_at) }}<template v-if="t.ai_model"> · {{ t.ai_model }}</template><template v-if="t.waits_for?.length"> · after {{ t.waits_for.length }} other task{{ t.waits_for.length > 1 ? 's' : '' }}</template><template v-if="t.already_done_by?.length"> · waits for a model not weaker than {{ t.already_done_by.join(', ') }}</template></small></span>
                    <span class="pill" :class="'t-' + statuses[t.status].tone">{{ statuses[t.status].short }}</span>
                  </a>
                  <small v-if="g.tasks.length > 60" class="muted ai-more">And {{ g.tasks.length - 60 }} more.</small>
                </template>
              </div>
              <div v-if="!queue.length" class="d-empty">No task here. Upload a file, write @AI in a discussion, or make a request.</div>
            </div>
          </section>
        </div>
        <aside class="ai-side">
          <section v-if="task" class="panel ai-detail">
            <header class="ai-head"><h2>Task #{{ task.id }}</h2><a class="icon-btn" :href="link('ai')" title="Close"><icon name="x" :size="15"/></a></header>
            <b class="ai-detail-title"><math-text :text="taskTitle(task)"/></b>
            <p><span class="pill" :class="'t-' + statuses[task.status].tone">{{ statuses[task.status].label }}</span></p>
            <p v-if="task.prompt_text" class="ai-quote">{{ task.prompt_text }}</p>
            <p v-if="task.summary_text">{{ task.summary_text }}</p>
            <p v-if="task.error_text" class="ai-error"><icon name="x" :size="14"/> {{ task.error_text }}</p>
            <div v-if="resultLinks(task).length" class="ai-results"><a v-for="x in resultLinks(task)" :key="x.label" class="chip-link" :href="resultHref(x)">{{ x.label }}</a></div>
            <dl class="ai-task-meta">
              <div><dt>Requested by</dt><dd>{{ task.requested_by_name || 'Platform' }}</dd></div>
              <div><dt>Created</dt><dd :title="fullDate(task.created_at)">{{ timeAgo(task.created_at) }}</dd></div>
              <div v-if="task.claimed_by_name"><dt>Computed by</dt><dd>{{ task.claimed_by_name }}</dd></div>
              <div v-if="task.ai_model"><dt>Model</dt><dd>{{ task.ai_model }}</dd></div>
              <div v-if="task.ai_generation_ms"><dt>Time</dt><dd>{{ (task.ai_generation_ms / 1000).toFixed(0) }} s</dd></div>
              <div v-if="task.attempts"><dt>Attempts</dt><dd>{{ task.attempts }}</dd></div>
            </dl>
            <div class="row-gap"><button v-if="actions.retry" class="btn sm" @click="act('retry')">Try again</button><button v-if="actions.cancel" class="btn sm danger" @click="act('cancel')">Cancel</button></div>
          </section>
          <section class="panel ai-form">
            <header class="ai-head"><h2><icon name="plus" :size="15"/> New request</h2></header>
            <div class="ai-choices" role="radiogroup" aria-label="What should the AI do?">
              <label v-for="(k, key) in kinds" :key="key" :class="{on: draft.kind === key}"><input type="radio" name="ai-kind" :value="key" v-model="draft.kind"><icon :name="k.icon" :size="15"/><span>{{ k.label }}</span></label>
            </div>
            <p class="ai-hint">{{ kinds[draft.kind].hint }}</p>
            <label v-if="draft.kind === 'extract'" class="field"><span>File, reference or conversation</span><select v-model="draft.document"><option value="">Choose…</option><optgroup v-if="documents.length" label="Files"><option v-for="f in documents" :key="f.id" :value="f.id">{{ f.title }}</option></optgroup><optgroup v-if="references.length" label="References with a PDF"><option v-for="b in references" :key="b.id" :value="'bib:' + b.id">{{ b.title }}</option></optgroup><optgroup v-if="conversations.length" label="Your conversations"><option v-for="c in conversations" :key="c.id" :value="'conv:' + c.id">{{ c.subject }}{{ c.private ? ' (private)' : '' }}</option></optgroup></select></label>
            <button v-if="draft.kind === 'extract' && bib.toQueue" class="btn block" @click="extractAll"><icon name="sparkles" :size="14"/> Extract all {{ bib.toQueue }} remaining reference PDFs</button>
            <label v-if="kinds[draft.kind].needs === 'fact'" class="field"><span>Fact</span><select v-model="draft.fact"><option value="">Choose…</option><option v-for="f in facts" :key="f.id" :value="f.id">{{ f.label }}: {{ f.title }}</option></select></label>
            <label v-if="draft.kind === 'derive'" class="field"><span>Toward a question (optional)</span><select v-model="draft.question"><option value="">The whole project</option><option v-for="q in questions" :key="q.id" :value="q.id">{{ q.title }}</option></select></label>
            <label class="field"><span>{{ draft.kind === 'ask' ? 'Your question' : 'Instructions (optional)' }}</span><textarea v-model="draft.prompt" rows="3" maxlength="4000" :placeholder="draft.kind === 'bib' ? 'For example: work on sunflower bounds since 2019' : ''"></textarea></label>
            <button class="btn primary block" :disabled="!!error || busy" @click="send">Add to the queue</button>
            <p class="ai-note">The next member's AI client to run will process it, with the model that member chose for this work.</p>
          </section>
        </aside>
      </div>
    </template>
  </div>`,
};
