// Shared building blocks of the structured pages: figures, charts, work lists and activity.
import { api } from './api.js';
import { store, link } from './store.js';
import { timeAgo, fullDate } from './util.js';
import { REF_TYPES, activityVerb, refHref, statusInfo } from './references.js';

// Fixed colors per status, so that a state looks the same on every page. Each is always labelled.
export const QUESTION_SEGMENTS = [['solved', 'Solved', '#0d9488'], ['refuted', 'Refuted', '#b42318'], ['partial', 'Partial', '#d97706'], ['active', 'In progress', '#4f46e5'], ['open', 'Open', '#98a2b3'], ['abandoned', 'Abandoned', '#d0d5dd']];
export const STRATEGY_SEGMENTS = [['succeeded', 'Succeeded', '#0d9488'], ['failed', 'Failed', '#b42318'], ['blocked', 'Blocked', '#d97706'], ['active', 'Being tried', '#4f46e5'], ['idea', 'Idea', '#98a2b3'], ['abandoned', 'Abandoned', '#d0d5dd']];
export const FACT_SEGMENTS = [['double_checked', 'Human + AI', '#0d9488'], ['human_checked', 'Human-checked', '#2dd4bf'], ['accepted', 'Citation accepted', '#5eead4'], ['ai_checked', 'AI-checked', '#4f46e5'], ['source_confirmed', 'Source confirmed', '#a5b4fc'], ['unchecked', 'Unchecked', '#98a2b3'], ['proof_disputed', 'Proof disputed', '#d97706'], ['disputed', 'Disputed', '#b42318'], ['retracted', 'Retracted', '#d0d5dd']];
export const PROOF_SEGMENTS = [['human', 'Human proof', '#0d9488'], ['mixed', 'Human + AI', '#2dd4bf'], ['ai', 'AI proof', '#4f46e5'], ['none', 'No proof', '#98a2b3']];

const ACTIONS = {
  at_risk: { icon: 'eye', tone: 'bad', label: 'Answer at risk', text: 'The fact behind this answer changed' },
  ratify: { icon: 'check-circle', tone: 'warn', label: 'To ratify', text: 'An answer awaits a human decision' },
  disputed: { icon: 'x', tone: 'bad', label: 'Disputed', text: 'Settle this fact' },
  review: { icon: 'graph', tone: 'info', label: 'To review', text: 'No check from you yet' },
  strategy: { icon: 'route', tone: 'neutral', label: 'No strategy', text: 'Propose an approach' },
};

export const Pill = {
  props: { status: String },
  computed: { s() { return statusInfo(this.status); } },
  template: `<span v-if="s" class="pill" :class="'t-' + s.tone">{{ s.label }}</span>`,
};

export const Kpi = {
  props: { icon: String, value: [Number, String], label: String, sub: String, href: String, tone: { type: String, default: 'accent' } },
  template: `<a class="kpi" :class="'k-' + tone" :href="href"><span class="kpi-icon"><icon :name="icon" :size="18"/></span><span class="kpi-text"><b>{{ value }}</b><span>{{ label }}</span><small v-if="sub">{{ sub }}</small></span></a>`,
};

/** Share of a whole in a few states: a thin stacked bar, a legend and a hover label on each part. */
export const StackBar = {
  props: { counts: Object, segments: Array, label: String },
  computed: {
    parts() { return this.segments.map(([k, name, color]) => ({ k, name, color, n: +(this.counts?.[k] || 0) })).filter((p) => p.n > 0); },
    total() { return this.parts.reduce((a, p) => a + p.n, 0); },
    summary() { return this.parts.map((p) => `${p.name}: ${p.n}`).join(', '); },
  },
  template: `<div class="stack"><div v-if="total" class="stack-bar" role="img" :aria-label="(label ? label + '. ' : '') + summary">
      <span v-for="p in parts" :key="p.k" :style="{flexGrow: p.n, background: p.color}" :title="p.name + ': ' + p.n + ' (' + Math.round(100 * p.n / total) + '%)'"></span></div>
    <div v-else class="stack-bar empty"></div>
    <ul v-if="total" class="stack-legend"><li v-for="p in parts" :key="p.k"><i :style="{background: p.color}"></i>{{ p.name }} <b>{{ p.n }}</b></li></ul></div>`,
};

export const Ring = {
  props: { done: Number, total: Number, size: { type: Number, default: 104 }, caption: String },
  computed: {
    r() { return (this.size - 10) / 2; },
    c() { return 2 * Math.PI * this.r; },
    pct() { return this.total ? Math.round(100 * this.done / this.total) : 0; },
    dash() { return `${this.c * (this.total ? this.done / this.total : 0)} ${this.c}`; },
  },
  template: `<div class="ring" :style="{width: size + 'px', height: size + 'px'}" role="img" :aria-label="done + ' of ' + total + ' ' + (caption || '')">
    <svg :width="size" :height="size"><circle :cx="size / 2" :cy="size / 2" :r="r" class="ring-bg"/><circle v-if="done" :cx="size / 2" :cy="size / 2" :r="r" class="ring-fg" :stroke-dasharray="dash" :transform="'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'"/></svg>
    <div><b>{{ pct }}%</b><small>{{ done }}/{{ total }}</small></div></div>`,
};

export const YearBars = {
  props: { years: Array },
  computed: { max() { return Math.max(1, ...this.years.map((y) => y.n)); } },
  template: `<div class="years" role="img" :aria-label="years.map((y) => y.year + ': ' + y.n).join(', ')"><div v-for="y in years" :key="y.year" class="year" :title="y.year + ': ' + y.n + (y.n === 1 ? ' reference' : ' references')"><span :style="{height: Math.max(8, 100 * y.n / max) + '%'}"></span><small>{{ y.year }}</small></div></div>`,
};

export const ActionList = {
  components: { },
  props: { actions: Array },
  created() { this.meta = ACTIONS; },
  methods: { link },
  template: `<div class="actions"><a v-for="a in actions" :key="a.kind + a.ref" class="action" :href="link(a.link.view, a.link.id)">
    <span class="action-icon" :class="'t-' + meta[a.kind].tone"><icon :name="meta[a.kind].icon" :size="15"/></span>
    <span class="action-text"><span class="action-kind">{{ meta[a.kind].label }} · {{ meta[a.kind].text }}</span><b><code v-if="a.code" class="key">{{ a.code }}</code> <math-text :text="a.title"/></b></span><span class="chev" aria-hidden="true">›</span></a>
    <div v-if="!actions.length" class="d-empty"><icon name="check-circle" :size="20"/> Nothing is waiting for you.</div></div>`,
};

export const ActivityFeed = {
  props: { items: Array },
  computed: { pid() { return store.project?.id; } },
  created() { this.types = REF_TYPES; },
  methods: { timeAgo, fullDate, activityVerb, href(x) { return refHref(x.ref, this.pid); } },
  template: `<ol class="feed"><li v-for="x in items" :key="x.id">
      <avatar v-if="x.actor" :name="x.actor.name" :id="x.actor.id" :kind="x.actor.kind" :size="26"/><span v-else class="feed-ai"><icon name="bot" :size="14"/></span>
      <div><p v-if="(x.count || 1) > 1"><b>{{ x.actor ? x.actor.name : 'An AI client' }}</b> {{ activityVerb(x.kind) }} {{ x.count }} {{ types[x.ref.type].plural.toLowerCase() }}:
        <template v-for="(r, i) in [x.ref, ...(x.more || [])]" :key="r.key"><a :href="href({ ref: r })"><icon :name="types[r.type].icon" :size="12"/> <math-text :text="r.label"/></a>{{ i < (x.more || []).length ? ', ' : '' }}</template><template v-if="x.count > 1 + (x.more || []).length"> and {{ x.count - 1 - x.more.length }} more</template></p>
      <p v-else><b>{{ x.actor ? x.actor.name : 'An AI client' }}</b> {{ activityVerb(x.kind) }} <a :href="href(x)"><icon :name="types[x.ref.type].icon" :size="12"/> <math-text :text="x.ref.label"/></a></p>
      <time :title="fullDate(x.at)">{{ timeAgo(x.at) }}</time></div></li>
    <li v-if="!items.length" class="d-empty">No activity yet.</li></ol>`,
};

export const dashboardComponents = { Pill, Kpi, StackBar, Ring, YearBars, ActionList, ActivityFeed };

/** Shown in the right column of a section while no item is selected. */
export const SectionActivity = {
  components: { ActivityFeed },
  props: { kind: String },
  data() { return { items: null }; },
  async mounted() {
    try {
      this.items = (await api.get(`api/projects/${store.project.id}/activity?section=${this.kind}`)).activity;
    } catch { this.items = []; }
  },
  template: `<div class="section-activity"><header class="col-head"><h2>Recent activity</h2></header><div class="sa-body"><activity-feed v-if="items" :items="items"/></div>
    <p class="sa-hint"><icon name="comment" :size="14"/> Select an item to read and write its comments.</p></div>`,
};

/** Shown in the main column of a section while no item is selected. */
export const SectionHome = {
  components: dashboardComponents,
  props: { kind: String },
  data() { return { d: null }; },
  computed: { pid() { return store.project?.id; } },
  created() { this.seg = { QUESTION_SEGMENTS, STRATEGY_SEGMENTS, FACT_SEGMENTS, PROOF_SEGMENTS }; },
  async mounted() { try { this.d = await api.get(`api/projects/${this.pid}/dashboard`); } catch { this.d = null; } },
  methods: { link, timeAgo },
  template: `<div class="section-home">
    <template v-if="d">
    <template v-if="kind === 'questions'">
      <header><span class="sh-icon"><icon name="target" :size="22"/></span><div><h2>Research questions</h2><p>Big questions, their sub-questions, and the strategies to settle them.</p></div></header>
      <div class="sh-kpis"><div><b>{{ d.questions.big }}</b><span>big questions</span></div><div><b>{{ d.questions.total }}</b><span>questions in all</span></div><div><b>{{ d.questions.settled }}</b><span>settled</span></div><div><b>{{ d.questions.strategies }}</b><span>strategies</span></div></div>
      <section class="panel"><h3>Questions by status</h3><stack-bar :counts="d.questions.by_status" :segments="seg.QUESTION_SEGMENTS" label="Questions by status"/></section>
      <section class="panel"><h3>Strategies by status</h3><stack-bar :counts="d.questions.strategy_by_status" :segments="seg.STRATEGY_SEGMENTS" label="Strategies by status"/></section>
      <section class="panel"><h3>Big questions</h3><a v-for="q in d.questions.roots" :key="q.id" class="d-row" :href="link('questions', q.id)"><pill :status="q.status"/><span class="d-title"><math-text :text="q.title"/></span><small v-if="q.total">{{ q.done }}/{{ q.total }}</small><span class="chev">›</span></a><div v-if="!d.questions.roots.length" class="d-empty">No question yet.</div></section>
    </template>
    <template v-else-if="kind === 'facts'">
      <header><span class="sh-icon"><icon name="graph" :size="22"/></span><div><h2>Fact database</h2><p>What the project knows, how it was proved, and who checked it.</p></div></header>
      <div class="sh-kpis"><div><b>{{ d.facts.total }}</b><span>facts</span></div><div><b>{{ d.facts.endorsed }}</b><span>human-endorsed</span></div><div><b>{{ d.facts.lean }}</b><span>with Lean</span></div><div><b>{{ d.facts.by_status.disputed || 0 }}</b><span>disputed</span></div></div>
      <section class="panel"><h3>Verification</h3><stack-bar :counts="d.facts.by_status" :segments="seg.FACT_SEGMENTS" label="Facts by verification status"/></section>
      <section class="panel"><h3>Origin of the proofs</h3><stack-bar :counts="d.facts.by_proof" :segments="seg.PROOF_SEGMENTS" label="Facts by proof origin"/></section>
      <section class="panel"><h3>What needs you</h3><action-list :actions="d.actions.filter((a) => ['review', 'disputed'].includes(a.kind))"/></section>
    </template>
    <template v-else-if="kind === 'files'">
      <header><span class="sh-icon"><icon name="files" :size="22"/></span><div><h2>Files</h2><p>Papers and notes, with every version and their LaTeX sources.</p></div></header>
      <div class="sh-kpis"><div><b>{{ d.files.total }}</b><span>files</span></div><div><b>{{ d.files.human }}</b><span>by humans</span></div><div><b>{{ d.files.ai }}</b><span>by AI</span></div><div><b>{{ d.files.versions }}</b><span>versions</span></div></div>
      <section class="panel"><h3>Recently updated</h3><a v-for="f in d.files.recent" :key="f.id" class="d-row" :href="link('files', f.id)"><origin-badge :origin="f.origin"/><span class="d-title">{{ f.title }}</span><small>v{{ f.versions }} · {{ timeAgo(f.updated_at) }}</small><span class="chev">›</span></a><div v-if="!d.files.recent.length" class="d-empty">No file yet.</div></section>
    </template>
    <template v-else-if="kind === 'bib'">
      <header><span class="sh-icon"><icon name="book" :size="22"/></span><div><h2>Bibliography</h2><p>The literature of the project, ready to cite anywhere with @.</p></div></header>
      <div class="sh-kpis"><div><b>{{ d.bib.total }}</b><span>references</span></div><div><b>{{ d.bib.with_pdf }}</b><span>with a PDF</span></div><div><b>{{ d.bib.total - d.bib.with_pdf }}</b><span>without a PDF</span></div></div>
      <section v-if="d.bib.years.length" class="panel"><h3>References by year</h3><year-bars :years="d.bib.years"/></section>
      <section class="panel"><h3>Recently added</h3><a v-for="b in d.bib.recent" :key="b.id" class="d-row" :href="link('bib', b.id)"><code class="key">{{ b.cite_key }}</code><span class="d-title">{{ b.title }}</span><small>{{ b.year }}</small><span class="chev">›</span></a><div v-if="!d.bib.recent.length" class="d-empty">No reference yet.</div></section>
    </template>
    <template v-else>
      <header><span class="sh-icon"><icon name="mail" :size="22"/></span><div><h2>Conversations</h2><p>Discussions with the people you choose. Only participants can read them.</p></div></header>
      <div class="sh-kpis"><div><b>{{ d.conversations.total }}</b><span>your conversations</span></div><div><b>{{ d.conversations.messages }}</b><span>messages</span></div></div>
      <section class="panel"><h3>Latest</h3><a v-for="c in d.conversations.recent" :key="c.id" class="d-row" :href="link('conversations', c.id)"><span class="d-icon"><icon name="mail" :size="14"/></span><span class="d-title"><math-text :text="c.subject"/></span><small>{{ c.messages }} msg · {{ timeAgo(c.last_message_at) }}</small><span class="chev">›</span></a><div v-if="!d.conversations.recent.length" class="d-empty">No conversation yet.</div></section>
    </template>
    <div class="sh-cta"><slot/></div>
    </template>
    <div v-else class="placeholder">Loading…</div>
  </div>`,
};
