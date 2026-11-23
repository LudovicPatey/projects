import { api } from '../api.js';
import { store, go, link, attempt, toast, refreshMentionables, refreshProject, unreadCount, markRead, markItemUnread } from '../store.js';
import { timeAgo, fullDate } from '../util.js';
import { FactGraph, STATUS, PROOF_LABEL } from '../factgraph.js';
import { factTitle, formatFactHtml, parseExternalRefs, texLine } from '../fact-format.js';

const VERDICTS = {
  correct: { label: 'Correct', cls: 'green' },
  gap: { label: 'Gap', cls: 'amber' },
  incorrect: { label: 'Incorrect', cls: 'red' },
};
const LEAN = {
  none: 'No Lean proof', compiled: 'Lean: reported compiling', unchecked: 'Lean: not checked yet',
  partial: 'Lean: contains sorry', failed: 'Lean: reported failing',
};
const CHAIN = {
  broken: 'Depends on a disputed or retracted fact',
  unchecked: 'Depends on an unchecked fact',
};

const BASIS = {
  message_author: 'author of the message', comment_author: 'author of the comment', bibliography: 'authors in the bibliography',
  client_stated: 'named by the AI client, unconfirmed', file_uploader: 'uploaded the file, may not be the author', ai_model: 'AI model',
};
const COVERS = { statement: 'statement', proof: 'proof', both: 'statement and proof', context: 'context' };

const LabelChips = {
  props: { labels: Array },
  template: `<span class="fact-labels"><span v-for="l in labels" :key="l" class="fact-label" :class="'l-' + l">{{ l.replaceAll('_', ' ') }}</span></span>`,
};

const ProofTag = {
  props: { origin: String },
  computed: { text() { return PROOF_LABEL[this.origin] || PROOF_LABEL.none; } },
  template: `<span class="proof-tag" :class="origin">{{ text }}</span>`,
};

const StatusTag = {
  props: { status: String },
  computed: { s() { return STATUS[this.status]; } },
  template: `<span class="fact-status" :style="{color: s.color, background: s.bg}">{{ s.label }}</span>`,
};

/** Who produced something, always with the model when it is AI. */
const ByLine = {
  props: { name: String, kind: String, model: String, user: String, ms: [Number, String] },
  template: `<span class="row-gap small"><b>{{ name }}</b><ai-meta :model="model" :user="user" :ms="ms"/></span>`,
};

const readView = () => { try { return localStorage.getItem('oq-fact-view') !== 'original'; } catch { return true; } };

export const FactsView = {
  components: { FactGraph, StatusTag, ByLine, LabelChips, ProofTag },
  props: { pid: Number, id: Number, query: Object },
  data() {
    return {
      facts: [], edges: [], loaded: false, search: '', fStatus: 'all', fOrigin: 'all', fLabel: 'all', fLean: 'all', sort: 'recent', lineage: false, showFilters: false,
      fact: null, factError: null, tab: 'content', activeThread: null, backlinks: [],
      readable: readView(), reviewVerdict: 'correct', checkForm: null, trace: null, retracting: null, revView: null, denying: null,
    };
  },
  computed: {
    mode() { return this.query?.mode === 'graph' ? 'graph' : 'list'; },
    me() { return store.user.id; },
    isOwner() { return store.project.my_role === 'owner'; },
    filtered() {
      const q = this.search.toLowerCase();
      let list = this.facts.filter((f) => (this.fStatus === 'all' || f.status === this.fStatus)
        && (this.fOrigin === 'all' || f.proof_origin === this.fOrigin)
        && (this.fLabel === 'all' || f.labels.includes(this.fLabel))
        && (this.fLean === 'all' || (this.fLean === 'with' ? f.lean !== 'none' : f.lean === this.fLean))
        && (!q || [f.label, f.title, f.statement_text, f.ai_model, f.author, f.kind, f.method, f.tool, f.labels.join(' ')].some((x) => String(x || '').toLowerCase().includes(q))));
      if (this.lineage && this.id) {
        const keep = this.lineageOf(this.id);
        list = list.filter((f) => keep.has(f.id));
      }
      const by = { recent: (a, b) => (a.updated_at < b.updated_at ? 1 : -1), label: (a, b) => a.label.localeCompare(b.label),
        used: (a, b) => b.dependents.length - a.dependents.length };
      return [...list].sort(by[this.sort]);
    },
    filteredEdges() {
      const ids = new Set(this.filtered.map((f) => f.id));
      return this.edges.filter(([a, b]) => ids.has(a) && ids.has(b));
    },
    activeFilters() { return [this.fStatus, this.fOrigin, this.fLabel, this.fLean].filter((v) => v !== 'all').length; },
    unreadFacts() { return store.counters.unread?.fact || {}; },
    labelCounts() {
      const c = {};
      for (const f of this.facts) for (const l of f.labels) c[l] = (c[l] || 0) + 1;
      return c;
    },
    labelOptions() { return Object.keys(this.labelCounts).sort(); },
    endorsed() { return this.myReview?.verdict === 'correct'; },
    denied() { return this.myReview?.verdict === 'incorrect'; },
    banner() {
      const f = this.fact, by = f.ai_model, tool = f.tool ? ` with ${f.tool}` : '';
      if (f.method === 'deduced') return { head: 'AI-deduced', rest: `by ${by}${tool}. Check carefully before relying on it.` };
      const entered = `Entered by ${by}. Check it against the source.`;
      if (f.origin === 'human' && f.proof_origin === 'human') return { head: 'Human statement and proof.', rest: entered };
      if (f.origin === 'human' && f.proof_origin === 'ai') return { head: 'Human statement, AI proof.', rest: entered };
      if (f.origin === 'human' && f.proof_origin === 'mixed') return { head: 'Human statement, proof from human and AI sources.', rest: entered };
      if (f.origin === 'human') return { head: 'Human statement, no proof recorded.', rest: entered };
      return { head: 'From AI-written material.', rest: entered };
    },
    counts() {
      const c = { all: this.facts.length };
      for (const f of this.facts) c[f.status] = (c[f.status] || 0) + 1;
      return c;
    },
    canWriteReview() { return this.fact && !this.fact.retracted_at; },
    glossary() { return Object.entries(this.fact?.glossary || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]); },
    myReview() { return this.fact?.reviews.find((v) => v.reviewer_id === this.me && v.reviewer_kind === 'human' && v.revision_no === this.fact.current_revision); },
    currentReviews() { return this.fact.reviews.filter((v) => v.revision_no === this.fact.current_revision); },
    oldReviews() { return this.fact.reviews.filter((v) => v.revision_no !== this.fact.current_revision); },
    canDelete() { return this.fact && (this.fact.created_by === this.me || this.isOwner) && !this.fact.dependents.length; },
    shownRevision() { return this.fact.revisions.find((r) => r.revision_no === this.revView) || null; },
    content() { return this.shownRevision || this.fact; },
    externalRefs() { return parseExternalRefs(this.fact?.external_refs); },
    headTitle() { return this.fact ? texLine(factTitle(this.fact.title, this.fact.statement_html, true)) : ''; },
    gridClass() {
      if (this.mode === 'list') return 'cols3';
      return this.fact || this.factError ? 'facts-graph has-detail' : 'facts-graph';
    },
  },
  watch: { id: { immediate: true, handler() { this.onRoute(); } }, 'query.tab'(t) { if (t) { this.tab = t; if (t === 'trace') this.loadTrace(); } } },
  mounted() {
    this.loadList();
    this.timer = setInterval(() => { if (!this.checkForm && !this.retracting) this.loadList(); }, 30000);
  },
  unmounted() { clearInterval(this.timer); },
  template: `<div :class="gridClass">
  <section v-if="mode === 'graph'" class="col fg-col">
    <header class="col-head"><h2>Facts <span class="count">{{ filtered.length }}<template v-if="filtered.length !== facts.length"> / {{ facts.length }}</template></span></h2>
      <div class="row-gap"><div class="seg small mode-seg"><button @click="setMode('list')"><icon name="list" :size="13"/> List</button><button class="on"><icon name="graph" :size="13"/> Graph</button></div><mark-all-read type="fact"/></div></header>
    <div class="fg-filters">
      <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Search facts…"></div>
      <select v-model="fStatus" aria-label="Filter by status"><option value="all">All statuses</option><option v-for="(s, k) in statuses" :key="k" :value="k">{{ s.label }} ({{ counts[k] || 0 }})</option></select>
      <select v-model="fOrigin" aria-label="Filter by proof origin"><option value="all">Any proof origin</option><option value="human">Human proof</option><option value="ai">AI proof</option><option value="mixed">Human + AI proof</option><option value="none">No proof</option></select>
      <select v-model="fLabel" aria-label="Filter by label"><option value="all">All labels</option><option v-for="l in labelOptions" :key="l" :value="l">{{ pretty(l) }} ({{ labelCounts[l] }})</option></select>
      <label class="check" v-if="id"><input type="checkbox" v-model="lineage"> Only this fact's lineage</label>
    </div>
    <div v-if="loaded && !facts.length" class="placeholder"><icon name="graph" :size="40"/><p>No facts yet. Your AI client adds them with a personal API key.</p><a class="btn primary" href="#/profile"><icon name="key" :size="14"/> Get an API key</a></div>
    <fact-graph v-else :nodes="filtered" :edges="filteredEdges" :selected="id" :unread="unreadFacts" @select="selectNode"/>
    <div class="fg-legend">
      <span v-for="(s, k) in statuses" :key="k"><i :style="{background: s.bg, borderColor: s.color}"></i>{{ s.label }}</span>
      <span><i class="stripe human"></i>Human proof</span><span><i class="stripe ai"></i>AI proof</span><span><i class="stripe mixed"></i>Mixed</span><span><i class="stripe none"></i>No proof</span>
      <span><i class="dashed"></i>Relies on a disputed or retracted fact</span>
      <span><i class="unread-dot"></i>Unread</span>
    </div>
  </section>

  <section v-if="mode === 'list'" class="col col-list">
    <header class="col-head"><h2>Facts</h2>
      <div class="row-gap"><div class="seg small mode-seg"><button class="on"><icon name="list" :size="13"/> List</button><button @click="setMode('graph')"><icon name="graph" :size="13"/> Graph</button></div><mark-all-read type="fact"/></div></header>
    <div class="col-tools">
      <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Search label, statement, model…"></div>
      <div class="filter-bar">
        <button class="btn xs" :class="{on: showFilters}" :aria-expanded="showFilters" @click="showFilters = !showFilters"><icon name="filter" :size="13"/> Filters<b v-if="activeFilters" class="seg-n">{{ activeFilters }}</b></button>
        <button v-if="activeFilters" class="link-btn" @click="clearFilters">Clear</button>
        <span class="grow"></span>
        <select v-model="sort" aria-label="Sort"><option value="recent">Recent</option><option value="label">Label</option><option value="used">Most used</option></select>
      </div>
      <div v-if="showFilters" class="fact-filters">
        <select v-model="fStatus" aria-label="Filter by status"><option value="all">All statuses ({{ counts.all }})</option><option v-for="(s, k) in statuses" :key="k" :value="k">{{ s.label }} ({{ counts[k] || 0 }})</option></select>
        <select v-model="fOrigin" aria-label="Filter by proof origin"><option value="all">Any proof origin</option><option value="human">Human proof</option><option value="ai">AI proof</option><option value="mixed">Human + AI proof</option><option value="none">No proof</option></select>
        <select v-model="fLabel" aria-label="Filter by label"><option value="all">All labels</option><option v-for="l in labelOptions" :key="l" :value="l">{{ pretty(l) }} ({{ labelCounts[l] }})</option></select>
        <select v-model="fLean" aria-label="Filter by Lean"><option value="all">Any Lean</option><option value="with">With Lean</option><option value="compiled">Compiling</option><option value="none">No Lean</option></select>
      </div>
    </div>
    <div class="list">
      <a v-for="f in filtered" :key="f.id" class="li fact-li" :class="['o-' + f.origin, {active: f.id === id, 'is-new': !!unreadOf(f.id)}]" :href="factLink(f.id)">
        <div class="li-top"><code class="key">{{ f.label }}</code><span class="li-time">{{ f.kind }}</span><unread-badge type="fact" :id="f.id"/></div>
        <div class="li-subject"><math-text :text="texLine(factTitle(f.title, f.statement_text))"/></div>
        <div class="li-snippet"><math-text :text="f.statement_text"/></div>
        <div class="li-meta wrap">
          <label-chips :labels="f.labels"/>
          <status-tag :status="f.status"/>
          <proof-tag :origin="f.proof_origin"/>
        </div>
        <div class="li-foot">
          <ai-meta compact :model="f.ai_model" :user="f.ai_user_name" :ms="f.ai_generation_ms"/>
          <span class="grow"></span>
          <span v-if="f.chain === 'broken'" class="chain-warn" :title="chainLabels.broken">⚠</span>
          <span v-if="f.lean !== 'none'" class="lean-tag" :class="f.lean" :title="leanLabels[f.lean]">Lean</span>
          <span v-if="f.endorsed_by.length" class="endorse-count" :title="'Endorsed by ' + f.endorsed_by.map((e) => e.name).join(', ')"><icon name="check" :size="12"/> {{ f.endorsed_by.length }}</span>
          <span v-if="f.comment_count" title="Comments"><icon name="comment" :size="12"/> {{ f.comment_count }}</span>
        </div>
      </a>
      <div v-if="loaded && !filtered.length" class="empty">{{ facts.length ? 'No match.' : 'No facts yet. Your AI client adds them with a personal API key from your profile page.' }}</div>
    </div>
  </section>

  <section v-if="mode === 'list' || fact || factError" class="col col-main">
    <template v-if="fact">
      <div class="doc-banner" :class="fact.origin"><icon :name="fact.origin === 'ai' ? 'bot' : 'user'" :size="16"/>
        <span><b>{{ banner.head }}</b> {{ banner.rest }}</span></div>
      <div v-if="fact.retracted_at" class="fact-alert red"><b>Retracted</b> by {{ fact.retracted_by_name }}, {{ timeAgo(fact.retracted_at) }}: {{ fact.retract_reason }}</div>
      <div v-else-if="fact.chain !== 'ok'" class="fact-alert" :class="fact.chain === 'broken' ? 'red' : 'amber'">{{ chainLabels[fact.chain] }} in its dependency chain.</div>
      <header class="doc-head">
        <div class="doc-title">
          <div class="fact-id"><code class="key big">{{ fact.label }}</code><span>{{ fact.kind }}</span><span>{{ fact.method }}</span><span v-if="fact.tool">{{ fact.tool }}</span><span>revision {{ fact.current_revision }}</span></div>
          <h2 :title="fact.title"><math-text :text="headTitle"/></h2>
          <div class="fact-chips"><label-chips :labels="fact.labels"/><status-tag :status="fact.status"/><proof-tag :origin="fact.proof_origin"/><span class="lean-tag" :class="fact.lean" v-if="fact.lean !== 'none'">{{ leanLabels[fact.lean] }}</span></div>
          <div class="fact-byline"><ai-meta :model="fact.ai_model" :user="fact.ai_user_name" :ms="fact.ai_generation_ms"/><span class="muted small">added by {{ fact.author }} · updated {{ timeAgo(fact.updated_at) }}</span></div>
          <div v-if="fact.endorsed_by.length" class="endorsers"><icon name="check-circle" :size="14"/> Endorsed by
            <a v-for="(e, i) in fact.endorsed_by" :key="e.id" :href="link('members', null, {user: e.id})">{{ e.name }}{{ i < fact.endorsed_by.length - 1 ? ', ' : '' }}</a></div>
          <div v-if="fact.denied_by.length" class="endorsers denied"><icon name="x" :size="14"/> Denied by
            <a v-for="(e, i) in fact.denied_by" :key="e.id" :href="link('members', null, {user: e.id})">{{ e.name }}{{ i < fact.denied_by.length - 1 ? ', ' : '' }}</a></div>
        </div>
        <div class="doc-actions">
          <button v-if="!fact.retracted_at" class="btn sm endorse" :class="{on: endorsed}" :aria-pressed="endorsed" :title="endorsed ? 'Withdraw your endorsement' : 'Endorse this revision: you checked it and consider it correct'" @click="toggleEndorse">
            <icon name="check" :size="14"/> {{ endorsed ? 'Endorsed' : 'Endorse' }}</button>
          <button v-if="!fact.retracted_at" class="btn sm deny" :class="{on: denied}" :aria-pressed="denied" :title="denied ? 'Withdraw your denial' : 'Deny this revision: you found an error'" @click="toggleDeny"><icon name="x" :size="14"/> {{ denied ? 'Denied' : 'Deny' }}</button>
          <ai-action v-if="!fact.retracted_at" kind="review" source-type="fact" :source-id="fact.id" label="AI review"/>
          <ai-action v-if="!fact.retracted_at" kind="lean" source-type="fact" :source-id="fact.id" label="Lean proof"/>
          <ai-action v-if="!fact.retracted_at" kind="ask" source-type="fact" :source-id="fact.id" label="Ask AI"/>
          <ai-action v-if="!fact.retracted_at" kind="derive" source-type="fact" :source-id="fact.id" label="Prove from this"/>
          <button v-if="!fact.retracted_at" class="btn sm warn" @click="retracting = {reason: ''}">Retract</button>
          <button v-else class="btn sm" @click="reinstate">Reinstate</button>
          <button class="icon-btn" title="Mark as unread" @click="markItemUnread('fact', fact.id)"><icon name="mail-unread"/></button>
          <button v-if="canDelete" class="icon-btn" title="Delete fact" @click="remove"><icon name="trash"/></button>
          <button v-if="mode === 'graph'" class="icon-btn" title="Close" @click="closeFact"><icon name="x"/></button>
        </div>
      </header>
      <modal v-if="denying" title="Deny this fact" @close="denying = null">
        <label class="field"><span>What is wrong? Point to the exact step.</span><textarea v-model="denying.reason" rows="4" autofocus></textarea></label>
        <template #footer><button class="btn ghost" @click="denying = null">Cancel</button><button class="btn danger" :disabled="!denying.reason.trim()" @click="submitDeny">Deny fact</button></template>
      </modal>
      <nav class="tabs">
        <button :class="{on: tab==='content'}" @click="tab='content'"><icon name="eye" :size="14"/> Fact</button>
        <button :class="{on: tab==='reviews'}" @click="tab='reviews'"><icon name="check-circle" :size="14"/> Reviews <span class="count">{{ currentReviews.length }}</span></button>
        <button :class="{on: tab==='lean'}" @click="tab='lean'"><icon name="code" :size="14"/> Lean <span class="count">{{ fact.lean_proofs.length }}</span></button>
        <button :class="{on: tab==='deps'}" @click="tab='deps'"><icon name="graph" :size="14"/> Links <span class="count">{{ fact.deps.length + fact.dependents.length }}</span></button>
        <button :class="{on: tab==='trace'}" @click="tab='trace'; loadTrace()"><icon name="history" :size="14"/> Trace</button>
      </nav>

      <div v-if="tab==='content'" class="pad scroll fact-body">
        <div v-if="shownRevision" class="fact-alert amber">Viewing revision {{ revView }}. <button class="link-btn" @click="revView = null">Back to current</button></div>
        <div class="fact-view-switch"><div class="seg small" role="group" aria-label="How the text is shown"><button :class="{on: readable}" :aria-pressed="readable" title="Same content, with headings, lists and formulas typeset in LaTeX" @click="setReadable(true)">Readable</button><button :class="{on: !readable}" :aria-pressed="!readable" title="The text exactly as stored" @click="setReadable(false)">Original</button></div></div>
        <section class="fact-sec statement"><h4>Statement</h4><rich-content :html="shown(content.statement_html)"/></section>
        <section class="fact-sec" v-if="content.proof_html"><h4>Proof</h4><rich-content :html="shown(content.proof_html)"/></section>
        <section class="fact-sec" v-if="content.intuition_html"><h4>Intuition</h4><rich-content :html="shown(content.intuition_html)"/></section>
        <template v-if="!shownRevision">
          <section class="fact-sec" v-if="fact.sources.length"><h4>Sources</h4>
            <div v-for="(x, i) in fact.sources" :key="i" class="fact-source">
              <a v-if="x.link" :href="link(x.link.view, x.link.id, x.link.query)"><icon :name="sourceIcon(x.type)" :size="13"/> {{ x.label }}<template v-if="x.page">, p. {{ x.page }}</template></a>
              <span v-else class="muted"><icon name="mail" :size="13"/> {{ x.label }}</span>
              <span class="tag">{{ covers[x.covers] }}</span>
              <span class="tag" :class="x.is_human ? 'green' : ''">{{ x.is_human ? 'human' : 'AI' }}</span>
              <span v-if="x.author" class="small muted">{{ x.author.name }}</span>
              <blockquote v-if="x.quote">{{ x.quote }}</blockquote>
            </div></section>
          <section class="fact-sec" v-if="glossary.length"><h4>Glossary</h4>
            <dl class="fact-glossary"><template v-for="g in glossary" :key="g[0]"><dt><code>{{ g[0] }}</code></dt><dd>{{ g[1] }}</dd></template></dl></section>
          <section class="fact-sec" v-if="externalRefs.length"><h4>External references <span class="count">{{ externalRefs.length }}</span></h4>
            <ol class="ext-refs"><li v-for="(x, i) in externalRefs" :key="i">
              <code v-if="x.raw" class="ext-raw">{{ x.raw }}</code>
              <template v-else><div class="ext-top"><b><math-text :text="x.title"/></b><code v-if="x.key" class="key">{{ x.key }}</code></div>
                <div v-if="x.authors || x.venue || x.year" class="muted small">{{ [x.authors, x.venue, x.year].filter(Boolean).join(' · ') }}</div>
                <div v-if="x.citedFor" class="ext-cited"><span>Cited for</span> <math-text :text="x.citedFor"/></div>
                <a v-if="x.link" class="ext-link" :href="x.link.href" target="_blank" rel="noopener noreferrer"><icon name="external" :size="12"/> {{ x.link.label }}</a></template>
            </li></ol></section>
        </template>
      </div>

      <div v-if="tab==='reviews'" class="pad scroll">
        <div v-if="canWriteReview" class="card review-form">
          <h4>{{ myReview ? 'Update your review' : 'Review revision ' + fact.current_revision }}</h4>
          <div class="seg"><button v-for="(v, k) in verdicts" :key="k" :class="{on: reviewVerdict === k}" @click="reviewVerdict = k">{{ v.label }}</button></div>
          <rich-editor ref="reviewEd" compact :key="fact.id + '-' + fact.current_revision" :initial-html="myReview?.body_html || ''" :placeholder="reviewVerdict === 'correct' ? 'What did you check? (optional)' : 'Point to the exact step…'"/>
          <div class="row-end"><button class="btn primary sm" @click="submitReview">Submit review</button></div>
        </div>
        
        <div v-if="!currentReviews.length" class="empty">No review of this revision yet.</div>
        <article v-for="v in currentReviews" :key="v.id" class="review">
          <div class="row-gap"><span class="tag" :class="verdicts[v.verdict].cls">{{ verdicts[v.verdict].label }}</span>
            <by-line :name="v.reviewer_name" :model="v.ai_model" :user="v.ai_user_name" :ms="v.ai_generation_ms"/>
            <span v-if="!v.independent" class="tag amber" title="Same model as the author: recorded, but not counted as an independent check">same model as author</span>
            <span class="grow"></span><span class="muted small">{{ timeAgo(v.updated_at) }}</span>
            <button v-if="v.reviewer_id === me && v.reviewer_kind === 'human'" class="icon-btn xs" title="Withdraw" @click="withdraw(v)"><icon name="trash" :size="13"/></button></div>
          <rich-content v-if="v.body_html" :html="v.body_html"/>
        </article>
        <template v-if="oldReviews.length"><h4 class="mt">Earlier revisions</h4>
          <article v-for="v in oldReviews" :key="v.id" class="review old">
            <div class="row-gap"><span class="tag">r{{ v.revision_no }}</span><span class="tag" :class="verdicts[v.verdict].cls">{{ verdicts[v.verdict].label }}</span>
              <by-line :name="v.reviewer_name" :model="v.ai_model" :user="v.ai_user_name" :ms="v.ai_generation_ms"/></div>
            <rich-content v-if="v.body_html" :html="v.body_html"/></article></template>
      </div>

      <div v-if="tab==='lean'" class="pad scroll">
        <div class="row-gap lean-head"><p class="muted small">AI clients submit Lean proofs. The platform stores them but does not run Lean: compile status is what a member or client reports. Also check that the Lean statement says the same thing as the informal one.</p></div>
        <div v-if="!fact.lean_proofs.length" class="empty">No Lean proof yet.</div>
        <article v-for="l in fact.lean_proofs" :key="l.id" class="lean-card" :class="{old: l.revision_no !== fact.current_revision}">
          <div class="row-gap">
            <span class="tag">r{{ l.revision_no }}</span>
            <code v-if="l.decl_name">{{ l.decl_name }}</code>
            <span v-if="+l.incomplete" class="tag red">contains sorry / axiom</span>
            <span v-if="l.check_status === 'compiles'" class="tag green">reported compiling</span>
            <span v-else-if="l.check_status === 'fails'" class="tag red">reported failing</span>
            <span v-else class="tag">not checked</span>
            <span v-if="l.revision_no !== fact.current_revision" class="tag amber">older revision</span>
            <span class="grow"></span>
            <button class="icon-btn xs" title="Copy" @click="copy(l.code)"><icon name="copy" :size="13"/></button>
            <button v-if="l.created_by === me || isOwner" class="icon-btn xs" title="Delete" @click="removeLean(l)"><icon name="trash" :size="13"/></button>
          </div>
          <div class="muted small lean-meta">
            <by-line :name="l.created_by_name" :model="l.ai_model" :user="l.ai_user_name" :ms="l.ai_generation_ms"/>
            <span v-if="l.lean_version">Lean {{ l.lean_version }}</span><span v-if="l.mathlib_rev">Mathlib {{ l.mathlib_rev }}</span>
            <a v-if="l.url" :href="l.url" target="_blank" rel="noopener noreferrer"><icon name="external" :size="12"/> source</a>
          </div>
          <div v-if="l.checked_by" class="muted small">Checked by {{ l.checked_by_name }}, {{ timeAgo(l.checked_at) }} <ai-meta :model="l.check_model" :user="l.check_user_name" :ms="l.check_generation_ms"/></div>
          <pre class="lean-code">{{ l.code }}</pre>
          <pre v-if="l.check_log" class="lean-log">{{ l.check_log }}</pre>
          <div class="row-end"><button class="btn xs" @click="checkForm = {lean: l, status: +l.incomplete ? 'fails' : 'compiles', lean_version: l.lean_version || '', mathlib_rev: l.mathlib_rev || '', log: ''}">Report check</button></div>
        </article>
      </div>

      <div v-if="tab==='deps'" class="pad scroll">
        <h4>Depends on <span class="count">{{ fact.deps.length }}</span></h4>
        <div v-if="!fact.deps.length" class="muted small pad-b">No dependencies.</div>
        <a v-for="d in fact.deps" :key="d.id" class="row-link" :href="factLink(d.id)"><code class="key">{{ d.label }}</code><span class="ellipsis">{{ d.title }}</span><span class="grow"></span><status-tag :status="d.status"/></a>
        <h4 class="mt">Used by <span class="count">{{ fact.dependents.length }}</span></h4>
        <div v-if="!fact.dependents.length" class="muted small pad-b">Nothing depends on this fact yet.</div>
        <a v-for="d in fact.dependents" :key="d.id" class="row-link" :href="factLink(d.id)"><code class="key">{{ d.label }}</code><span class="ellipsis">{{ d.title }}</span><span class="grow"></span><status-tag :status="d.status"/></a>
        <h4 class="mt">Mentioned in</h4>
        <div v-if="!backlinks.length" class="muted small">No mention yet.</div>
        <a v-for="(b, i) in backlinks" :key="i" class="backlink" :href="link(b.link.view, b.link.id, b.link.query)">
          <icon :name="b.kind === 'message' ? 'mail' : b.kind === 'question' ? 'target' : 'comment'" :size="14"/> {{ b.label }} <span class="muted small">{{ timeAgo(b.at) }}</span></a>
      </div>

      <div v-if="tab==='trace'" class="pad scroll">
        <section class="trace-sec"><h4>Origin</h4>
          <div class="row-gap"><proof-tag :origin="fact.proof_origin"/><span class="tag">{{ fact.method }}</span><span v-if="fact.tool" class="tag">{{ fact.tool }}</span>
            <span class="small">Entry written by</span> <ai-meta :model="fact.ai_model" :user="fact.ai_user_name" :ms="fact.ai_generation_ms"/></div>
        </section>
        <section class="trace-sec"><h4>Sources of this fact</h4>
          <div v-if="!fact.sources.length" class="muted small">No source: this fact was produced by AI.</div>
          <div v-for="(x, i) in fact.sources" :key="i" class="trace-row">
            <a v-if="x.link" :href="link(x.link.view, x.link.id, x.link.query)">{{ x.label }}<template v-if="x.page">, p. {{ x.page }}</template></a><span v-else class="muted">{{ x.label }}</span>
            <span class="tag">{{ covers[x.covers] }}</span><span class="tag" :class="x.is_human ? 'green' : ''">{{ x.is_human ? 'human' : 'AI' }}</span>
            <div v-if="x.author" class="small"><b>{{ x.author.name }}</b> <span class="muted">({{ basis[x.author.basis] }})</span>
              <a v-if="x.author.orcid" :href="'https://orcid.org/' + x.author.orcid" target="_blank" rel="noopener" class="orcid-link"> {{ x.author.orcid }}</a></div>
          </div>
        </section>
        <template v-if="trace">
          <section class="trace-sec"><h4>People credited for human proofs <span class="count">including what it builds on</span></h4>
            <div v-if="!trace.human_proof_credits.length" class="muted small">No human proof is recorded in this fact or its dependencies.</div>
            <div v-for="p in trace.human_proof_credits" :key="p.name + p.basis" class="trace-row small"><b>{{ p.name }}</b> <span class="muted">({{ basis[p.basis] }}) · {{ p.facts.length }} fact{{ p.facts.length > 1 ? 's' : '' }}</span>
              <a v-if="p.orcid" :href="'https://orcid.org/' + p.orcid" target="_blank" rel="noopener" class="orcid-link"> {{ p.orcid }}</a></div>
          </section>
          <section class="trace-sec"><h4>Built on <span class="count">{{ trace.ancestor_count }} fact{{ trace.ancestor_count === 1 ? '' : 's' }}</span></h4>
            <div v-if="trace.ancestor_count" class="trace-summary"><template v-for="(n, k) in trace.ancestor_proof_origins" :key="k"><span v-if="n"><proof-tag :origin="k"/> {{ n }}</span></template></div>
            <a v-for="a in trace.ancestors" :key="a.id" class="trace-anc" :style="{paddingLeft: (a.depth - 1) * 12 + 6 + 'px'}" :href="factLink(a.id)">
              <code class="key">{{ a.label }}</code><proof-tag :origin="a.proof_origin"/><status-tag :status="a.status"/>
              <span class="muted small ellipsis">{{ creditText(a) }}</span></a>
            <div v-if="trace.ancestor_count > trace.ancestors.length" class="muted small">Showing the {{ trace.ancestors.length }} closest facts.</div>
          </section>
        </template>
        <h4 class="mt">Revisions</h4>
        <div class="timeline">
        <div v-for="r in fact.revisions" :key="r.id" class="tl-item" :class="{current: r.revision_no === fact.current_revision}">
          <div class="tl-dot"></div><div class="tl-body">
            <div class="tl-head"><b>Revision {{ r.revision_no }}</b><span v-if="r.revision_no === fact.current_revision" class="tag green">current</span>
              <proof-tag :origin="r.proof_origin"/><span class="grow"></span><span class="muted small">{{ fullDate(r.created_at) }}</span></div>
            <by-line :name="r.author_name" :model="r.ai_model" :user="r.ai_user_name" :ms="r.ai_generation_ms"/>
            <div v-if="r.notes" class="tl-notes">{{ r.notes }}</div>
            <div class="tl-actions"><button class="btn xs" @click="revView = r.revision_no === fact.current_revision ? null : r.revision_no; tab = 'content'"><icon name="eye" :size="13"/> View</button></div>
          </div></div>
        </div>
      </div>
    </template>
    <div v-else-if="factError" class="placeholder">{{ factError }}</div>
    <section-home v-else kind="facts"/>
  </section>

  <section v-if="mode === 'list' || fact" class="col col-comments">
    <comments-panel v-if="fact" target-type="fact" :target-id="fact.id" v-model:active-id="activeThread" @created="loadList" @activity="onActivity"/>
    <section-activity v-else kind="facts"/>
  </section>

  <modal v-if="checkForm" title="Report a Lean check" @close="checkForm = null">
    <form @submit.prevent="submitCheck">
      <div class="seg"><button type="button" :disabled="!!+checkForm.lean.incomplete" :class="{on: checkForm.status === 'compiles'}" @click="checkForm.status = 'compiles'">Compiles</button>
        <button type="button" :class="{on: checkForm.status === 'fails'}" @click="checkForm.status = 'fails'">Fails</button></div>
      <div class="grid2 pad-y">
        <label class="field"><span>Lean version</span><input v-model="checkForm.lean_version" :required="checkForm.status === 'compiles'"></label>
        <label class="field"><span>Mathlib revision</span><input v-model="checkForm.mathlib_rev"></label>
      </div>
      <label class="field"><span>Output <small class="muted">(optional)</small></span><textarea v-model="checkForm.log" rows="5" class="mono"></textarea></label>
      <div class="row-end"><button type="button" class="btn ghost" @click="checkForm = null">Cancel</button><button class="btn primary">Report</button></div>
    </form>
  </modal>

  <modal v-if="retracting" :title="'Retract ' + fact.label" @close="retracting = null">
    <form @submit.prevent="submitRetract">
      <p class="warn-box" v-if="fact.dependents.length">Everything that depends on this fact will be flagged. The authors of those facts are notified.</p>
      <label class="field"><span>Reason</span><textarea v-model="retracting.reason" rows="4" required placeholder="What is wrong?"></textarea></label>
      <div class="row-end"><button type="button" class="btn ghost" @click="retracting = null">Cancel</button><button class="btn warn">Retract</button></div>
    </form>
  </modal>
</div>`,
  created() { this.basis = BASIS; this.covers = COVERS; this.statuses = STATUS; this.verdicts = VERDICTS; this.leanLabels = LEAN; this.chainLabels = CHAIN; },
  methods: {
    factTitle, texLine,
    shown(html) { return this.readable ? formatFactHtml(html) : html; },
    setReadable(on) { this.readable = on; try { localStorage.setItem('oq-fact-view', on ? 'readable' : 'original'); } catch { /* the choice lasts for this page only */ } },
    timeAgo, fullDate, link, markItemUnread,
    unreadOf(id) { return unreadCount('fact', id); },
    onActivity() { this.loadList(); if (!this.checkForm && !this.retracting) this.loadFact(); },
    sourceIcon(t) { return { document: 'files', bib: 'book', message: 'mail', comment: 'comment' }[t] || 'link'; },
    factLink(id) { return link('facts', id, this.mode === 'graph' ? { mode: 'graph' } : null); },
    setMode(m) { go(`/p/${this.pid}/facts` + (this.id ? `/${this.id}` : '') + (m === 'graph' ? '?mode=graph' : '')); },
    selectNode(id) { if (id) location.hash = this.factLink(id); else if (this.id) this.closeFact(); },
    closeFact() { this.lineage = false; location.hash = link('facts', null, this.mode === 'graph' ? { mode: 'graph' } : null); },
    lineageOf(id) {
      const up = new Map(), down = new Map();
      for (const [a, b] of this.edges) { (up.get(a) || up.set(a, []).get(a)).push(b); (down.get(b) || down.set(b, []).get(b)).push(a); }
      const keep = new Set([id]);
      for (const next of [up, down]) {
        const stack = [...(next.get(id) || [])];
        const seen = new Set();
        while (stack.length) {
          const x = stack.pop();
          if (seen.has(x)) continue;
          seen.add(x); keep.add(x);
          stack.push(...(next.get(x) || []));
        }
      }
      return keep;
    },
    async loadList() {
      try { const r = await api.get(`api/projects/${this.pid}/facts`); this.facts = r.facts; this.edges = r.edges; this.loaded = true; } catch (e) { /* polling */ }
    },
    onRoute() {
      this.activeThread = this.query?.comment ? +this.query.comment : null;
      this.revView = null; this.backlinks = []; this.trace = null;
      if (['content', 'reviews', 'lean', 'links', 'trace'].includes(this.query?.tab)) this.tab = this.query.tab;
      if (this.id) this.loadFact(); else { this.fact = null; this.factError = null; }
    },
    async loadFact() {
      const id = this.id;
      try {
        const f = await api.get(`api/facts/${id}`);
        if (id !== this.id) return;
        this.setFact(f);
        this.factError = null;
        this.loadBacklinks();
      } catch (e) { this.fact = null; this.factError = e.message; }
    },
    setFact(f) {
      this.fact = f;
      const mine = f.reviews.find((v) => v.reviewer_id === this.me && v.reviewer_kind === 'human' && v.revision_no === f.current_revision);
      this.reviewVerdict = mine?.verdict || 'correct';
      markRead('fact', f.id, f.last_activity_id);
      if (this.tab === 'trace') this.loadTrace();
    },
    clearFilters() { this.fStatus = this.fOrigin = this.fLabel = this.fLean = 'all'; },
    pretty(l) { return l.replaceAll('_', ' '); },
    creditText(a) { return [...new Set(a.credits.map((c) => c.name))].join('; ') || (a.ai_model ? `entered by ${a.ai_model}` : ''); },
    async loadTrace() {
      const id = this.fact?.id;
      if (!id) return;
      const t = await attempt(() => api.get(`api/facts/${id}/trace`));
      if (t && this.fact?.id === id) this.trace = t;
    },
    async toggleEndorse() {
      const url = `api/facts/${this.fact.id}/reviews`;
      if (this.endorsed) await this.refresh(await attempt(() => api.del(`${url}/${this.myReview.id}`), 'Endorsement withdrawn'));
      else await this.refresh(await attempt(() => api.post(url, { verdict: 'correct', body_html: this.myReview?.body_html || '' }), 'Fact endorsed'));
    },
    async loadBacklinks() {
      if (!this.fact) return;
      this.backlinks = (await attempt(() => api.get(`api/projects/${this.pid}/backlinks?type=fact&target=${this.fact.id}`)))?.backlinks || [];
    },
    async refresh(f) { if (f) this.setFact(f); await this.loadList(); },
    async toggleDeny() {
      if (!this.denied) { this.denying = { reason: '' }; return; }
      await this.refresh(await attempt(() => api.del(`api/facts/${this.fact.id}/reviews/${this.myReview.id}`), 'Denial withdrawn'));
    },
    async submitDeny() {
      const f = await attempt(() => api.post(`api/facts/${this.fact.id}/reviews`, { verdict: 'incorrect', body_text: this.denying.reason }), 'Fact denied');
      if (f) { this.denying = null; await this.refresh(f); }
    },
    async submitReview() {
      const body_html = this.$refs.reviewEd?.getHTML() || '';
      await this.refresh(await attempt(() => api.post(`api/facts/${this.fact.id}/reviews`, { verdict: this.reviewVerdict, body_html }), 'Review saved'));
    },
    async withdraw(v) {
      if (!confirm('Withdraw your review?')) return;
      await this.refresh(await attempt(() => api.del(`api/facts/${this.fact.id}/reviews/${v.id}`)));
    },
    async submitCheck() {
      const { lean, ...body } = this.checkForm;
      const f = await attempt(() => api.post(`api/fact-lean/${lean.id}/check`, body), 'Check recorded');
      if (f) { this.checkForm = null; await this.refresh(f); }
    },
    async removeLean(l) {
      if (!confirm('Delete this Lean proof?')) return;
      await this.refresh(await attempt(() => api.del(`api/fact-lean/${l.id}`)));
    },
    async submitRetract() {
      const r = await attempt(() => api.post(`api/facts/${this.fact.id}/retract`, { reason: this.retracting.reason }));
      if (!r) return;
      this.retracting = null;
      toast(r.affected ? `Retracted. ${r.affected} dependent fact${r.affected > 1 ? 's' : ''} flagged.` : 'Retracted', 'success');
      await this.refresh(r);
    },
    async reinstate() { await this.refresh(await attempt(() => api.post(`api/facts/${this.fact.id}/reinstate`), 'Reinstated')); },
    async remove() {
      if (!confirm(`Delete ${this.fact.label}?`)) return;
      if (await attempt(() => api.del(`api/facts/${this.fact.id}`), 'Fact deleted')) {
        await this.loadList(); refreshMentionables(); refreshProject(); this.closeFact();
      }
    },
    copy(t) { navigator.clipboard?.writeText(t); toast('Copied'); },
  },
};
