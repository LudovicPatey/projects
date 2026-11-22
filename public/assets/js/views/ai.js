import { api } from '../api.js';
import { store, link, attempt, refreshCounters, toast } from '../store.js';
import { timeAgo, fullDate } from '../util.js';
import { Pill, Kpi, StackBar } from '../dashboard.js';
import { AI_KINDS, TASK_SEGMENTS, TASK_STATUS, filterTasks, requestBody, requestError, resultLinks, suggestionLink, taskActions, taskTitle } from '../ai-model.js';

export const AiView = {
  components: { Pill, Kpi, StackBar },
  props: { pid: Number, id: Number, query: Object },
  data() {
    return { d: null, filter: 'all', draft: { kind: 'bib', prompt: '', document: '', question: '' }, documents: [], questions: [], busy: false, timer: null };
  },
  computed: {
    tasks() { return filterTasks(this.d?.tasks || [], this.filter); },
    task() { return (this.d?.tasks || []).find((t) => t.id === this.id) || null; },
    proposed() { return (this.d?.suggestions || []).filter((s) => s.status === 'proposed'); },
    decided() { return (this.d?.suggestions || []).filter((s) => s.status !== 'proposed').slice(0, 5); },
    error() { return requestError(this.draft); },
    online() { return this.d?.clients || []; },
    actions() { return this.task ? taskActions(this.task, { me: store.user.id, owner: store.project?.my_role === 'owner' }) : {}; },
    open() { return (this.d?.counts.pending || 0) + (this.d?.counts.running || 0); },
  },
  created() { this.kinds = AI_KINDS; this.statuses = TASK_STATUS; this.segments = TASK_SEGMENTS; },
  async mounted() {
    await this.load();
    const [docs, qs] = await Promise.all([attempt(() => api.get(`api/projects/${this.pid}/documents`)), attempt(() => api.get(`api/projects/${this.pid}/questions`))]);
    this.documents = docs?.documents || (Array.isArray(docs) ? docs : []);
    this.questions = qs?.questions || [];
    this.timer = setInterval(() => { if (!document.hidden) this.load(); }, 15000);
  },
  unmounted() { clearInterval(this.timer); },
  watch: {
    'query.suggestion': { handler() { this.reveal(); } },
  },
  methods: {
    link, timeAgo, fullDate, taskTitle, resultLinks, suggestionLink,
    async load() {
      const r = await attempt(() => api.get(`api/projects/${this.pid}/ai`));
      if (r) { this.d = r; this.$nextTick(() => this.reveal()); }
    },
    reveal() {
      const id = this.query?.suggestion;
      if (id) this.$el?.querySelector?.(`[data-suggestion="${id}"]`)?.scrollIntoView({ block: 'center' });
    },
    resultHref(x) { return link(x.view, x.id, x.query || null); },
    async send() {
      if (this.error || this.busy) return;
      this.busy = true;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/ai/tasks`, requestBody(this.draft)), 'Request added to the queue');
      this.busy = false;
      if (r) { this.draft.prompt = ''; await this.load(); }
    },
    async act(verb) {
      if (await attempt(() => api.post(`api/ai/tasks/${this.task.id}/${verb}`, {}))) await this.load();
    },
    async decide(s, verb) {
      const r = await attempt(() => api.post(`api/bib-suggestions/${s.id}/${verb}`, {}), verb === 'accept' ? 'Added to the bibliography' : 'Suggestion rejected');
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
          <section v-if="proposed.length || decided.length" class="panel" id="ai-suggestions">
            <header class="ai-head"><h2><icon name="lightbulb" :size="15"/> Suggested references</h2><small>Check the source before accepting</small></header>
            <article v-for="s in proposed" :key="s.id" class="ai-sugg" :data-suggestion="s.id" :class="{active: +query?.suggestion === s.id}">
              <div class="ai-sugg-main"><b><math-text :text="s.title"/></b>
                <small>{{ [s.authors, s.year, s.venue].filter(Boolean).join(' · ') }}</small>
                <p>{{ s.reason_text }}</p>
                <div class="ai-sugg-meta"><a v-if="suggestionLink(s)" :href="suggestionLink(s).href" target="_blank" rel="noopener noreferrer">{{ suggestionLink(s).label }} ↗</a><span class="badge ai">{{ s.ai_model }}</span><span v-if="s.ai_user_name">via {{ s.ai_user_name }}</span></div>
              </div>
              <div class="ai-sugg-actions"><button class="btn sm primary" @click="decide(s, 'accept')"><icon name="check" :size="13"/> Accept</button><button class="btn sm" @click="decide(s, 'reject')">Reject</button></div>
            </article>
            <div v-if="!proposed.length" class="d-empty">Nothing to validate.</div>
            <details v-if="decided.length" class="ai-decided"><summary>Recently handled ({{ decided.length }})</summary>
              <a v-for="s in decided" :key="s.id" class="d-row" :href="s.bib_id ? link('bib', s.bib_id) : undefined"><pill :status="s.status"/><span class="d-title"><math-text :text="s.title"/></span><small>{{ s.decided_by_name }}</small></a>
            </details>
          </section>
          <section class="panel">
            <header class="ai-head"><h2><icon name="layers" :size="15"/> Queue</h2>
              <div class="seg small"><button v-for="f in [['all','All'],['open','Open'],['done','Done'],['failed','Failed']]" :key="f[0]" :class="{on: filter === f[0]}" @click="filter = f[0]">{{ f[1] }}</button></div></header>
            <stack-bar :counts="d.counts" :segments="segments" label="Tasks by status"/>
            <div class="ai-list">
              <a v-for="t in tasks" :key="t.id" class="ai-row" :class="{active: t.id === id}" :href="t.id === id ? link('ai') : link('ai', t.id)">
                <span class="action-icon t-info"><icon :name="kinds[t.kind].icon" :size="14"/></span>
                <span class="ai-row-main"><b><math-text :text="taskTitle(t)"/></b><small>{{ t.requested_by_name || 'Platform' }} · {{ timeAgo(t.created_at) }}<template v-if="t.ai_model"> · {{ t.ai_model }}</template></small></span>
                <span class="pill" :class="'t-' + statuses[t.status].tone">{{ statuses[t.status].short }}</span>
              </a>
              <div v-if="!tasks.length" class="d-empty">No task here. Upload a file, write @AI in a discussion, or make a request.</div>
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
            <dl class="ai-meta">
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
            <label v-if="draft.kind === 'extract'" class="field"><span>File</span><select v-model="draft.document"><option value="">Choose a file…</option><option v-for="f in documents" :key="f.id" :value="f.id">{{ f.title }}</option></select></label>
            <label v-if="draft.kind === 'derive'" class="field"><span>Toward a question (optional)</span><select v-model="draft.question"><option value="">The whole project</option><option v-for="q in questions" :key="q.id" :value="q.id">{{ q.title }}</option></select></label>
            <label class="field"><span>{{ draft.kind === 'ask' ? 'Your question' : 'Instructions (optional)' }}</span><textarea v-model="draft.prompt" rows="3" maxlength="4000" :placeholder="draft.kind === 'bib' ? 'For example: work on sunflower bounds since 2019' : ''"></textarea></label>
            <button class="btn primary block" :disabled="!!error || busy" @click="send">Add to the queue</button>
            <p class="ai-note">The next member's AI client to run will process it, with that member's AI account.</p>
          </section>
        </aside>
      </div>
    </template>
  </div>`,
};
