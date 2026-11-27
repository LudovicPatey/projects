import { api, expandFacts, getIfChanged } from '../api.js';
import { store, go, link, attempt, toast, refreshMentionables, refreshProject, unreadCount, markRead, markItemUnread } from '../store.js';
import { timeAgo, fullDate } from '../util.js';
import { FactGraph, STATUS, PROOF_LABEL } from '../factgraph.js';
import { factBadges, quietLabels, statementAddsToTitle } from '../fact-badges.js';
import { repairView } from '../repair-model.js';
import { factTitle, formatFactHtml, kindCounts, kindLabel, kindOf, parseExternalRefs, texLine } from '../fact-format.js';
import { PROOF_STATE, proofTally, resultOnlyBody, stance } from '../fact-proofs.js';
import { asMath, checkedByAi, rephrasingState, shownRephrasing } from '../notation-model.js';
import { factNotation } from '../notation-marks.js';
import { NotationPanel } from './notation.js';
import { ConsolidationPanel } from './consolidation.js';
import { CONFIDENCE, historyText, parseTopics, topicFilter, undoLabel } from '../consolidation-model.js';
import { GRAPH_VIEWS, bestCenter, defaultView, keyGraph, neighborhood } from '../graph-views.js';

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
  unproved: 'Depends on a result whose proof is disputed',
  unchecked: 'Depends on an unchecked fact or a citation nobody accepted',
  incomplete: 'Depends on a proof that still uses an outside result directly',
};
const SOURCE_CHECK = { confirmed: ['The source states it', 'green'], differs: ['The source states something different', 'amber'], not_found: ['Not found in the source', 'amber'], unreadable: ['The source could not be read', ''] };

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

/** A cited result states a result of another work without its proof. A proof that still uses an outside result directly is incomplete. */
const BasisTag = {
  props: { basis: String, incomplete: Boolean },
  template: `<span v-if="basis === 'cited'" class="basis-tag cited" title="A result of another work, stated without its proof. A person who read the source accepts it.">Cited result</span><span v-if="incomplete" class="basis-tag incomplete" title="Its proof uses a result of another work that is not a fact of the database yet">Outside result</span>`,
};

/**
 * A fact's state as small icons: where it stands, its proof, a cited or outside result, the AI that wrote it. Each explains itself on
 * hover; "verbose" adds its word, where there is room (the fact page).
 */
const FactBadges = {
  props: { f: Object, verbose: Boolean, only: Array },
  computed: { badges() { return factBadges(this.f).filter((b) => !(this.verbose && b.key === 'model') && (!this.only || this.only.includes(b.key))); } },
  template: `<span class="fbadges" :class="{verbose}"><span v-for="b in badges" :key="b.key" class="fb" :class="'t-' + b.tone" :title="b.title" role="img" :aria-label="b.title"><icon :name="b.icon" :size="13"/><b v-if="b.count && !verbose" class="fb-n">{{ b.count }}</b><span v-if="verbose" class="fb-label">{{ b.label }}</span></span></span>`,
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
const usedBy = (f) => f.used_by ?? f.dependents?.length ?? 0;
const notationView = () => { try { return localStorage.getItem('oq-fact-notation') !== 'source'; } catch { return true; } };

export const FactsView = {
  components: { FactGraph, BasisTag, StatusTag, FactBadges, ByLine, LabelChips, ProofTag, NotationPanel, ConsolidationPanel },
  props: { pid: Number, id: Number, query: Object },
  data() {
    return {
      facts: [], edges: [], loaded: false, search: '', fStatus: 'all', fOrigin: 'all', fLabel: 'all', fLean: 'all', sort: 'recent', lineage: false, showFilters: false,
      fact: null, factError: null, tab: 'content', activeThread: null, backlinks: [],
      readable: readView(), fKind: 'all', outline: [], reviewVerdict: 'correct', checkForm: null, trace: null, retracting: null, revView: null, denying: null,
      reviewStatement: 'true', resultOnly: null, proposing: null, proofCheck: null, projectNotation: notationView(), unfaithful: null,
      fStar: 'all', fBasis: 'all', refPick: {}, gView: null, gScope: 'all', gDepth: 2, matchIds: new Set(), listTag: null, fTopic: 'all', topicDraft: null, fVerify: 'all',
    };
  },
  computed: {
    mode() { return ['graph', 'notation', 'consolidate'].includes(this.query?.mode) ? this.query.mode : 'list'; },
    sidePanel() { return ['notation', 'consolidate'].includes(this.mode); },
    rephrasing() { return this.shownRevision ? null : shownRephrasing(this.fact, this.projectNotation); },
    currentRephrasing() { return (this.fact?.rephrasings || []).find((r) => r.current && !r.unchanged) || null; },
    notationState() { return this.fact ? rephrasingState(this.fact) : null; },
    statementHtml() { return this.rephrasing ? this.rephrasing.statement_html : this.content.statement_html; },
    proofHtml() { return this.rephrasing && this.rephrasing.proof_html ? this.rephrasing.proof_html : this.content.proof_html; },
    me() { return store.user.id; },
    isOwner() { return store.project.my_role === 'owner'; },
    filtered() {
      const q = this.search.toLowerCase();
      const onTopic = topicFilter(this.fTopic === 'all' ? [] : [this.fTopic]);
      let list = this.results.filter((f) => (this.fKind === 'all' || kindOf(f) === this.fKind) && onTopic(f)
        && (this.fStatus === 'all' || f.status === this.fStatus)
        && (this.fOrigin === 'all' || f.proof_origin === this.fOrigin)
        && (this.fLabel === 'all' || f.labels.includes(this.fLabel))
        && (this.fLean === 'all' || (this.fLean === 'with' ? f.lean !== 'none' : f.lean === this.fLean))
        && (this.fStar === 'all' || (this.fStar === 'mine' ? f.starred : f.stars > 0))
        && (this.fBasis === 'all' || (this.fBasis === 'incomplete' ? f.incomplete : f.basis === this.fBasis))
        && (this.fVerify === 'all' || (f.verify && (this.fVerify === 'todo' || f.verify.waits === this.fVerify)))
        && (!q || [f.label, f.title, f.statement_text, f.ai_model, f.author, f.kind, kindOf(f), f.method, f.tool, f.labels.join(' '), (f.topics || []).join(' ')].some((x) => String(x || '').toLowerCase().includes(q)) || this.matchIds.has(f.id)));
      if (this.lineage && this.id) {
        const keep = this.lineageOf(this.id);
        list = list.filter((f) => keep.has(f.id));
      }
      const by = { recent: (a, b) => (a.updated_at < b.updated_at ? 1 : -1), label: (a, b) => a.label.localeCompare(b.label),
        used: (a, b) => usedBy(b) - usedBy(a), stars: (a, b) => (b.stars || 0) - (a.stars || 0) || usedBy(b) - usedBy(a),
        verify: (a, b) => (b.verify?.score ?? -1) - (a.verify?.score ?? -1) || usedBy(b) - usedBy(a) };
      return [...list].sort(by[this.sort]);
    },
    filteredEdges() {
      const ids = new Set(this.filtered.map((f) => f.id));
      return this.edges.filter(([a, b]) => ids.has(a) && ids.has(b));
    },
    activeFilters() { return [this.fStatus, this.fOrigin, this.fLabel, this.fLean, this.fStar, this.fTopic, this.fBasis, this.fVerify].filter((v) => v !== 'all').length; },
    // Proved facts no person checked yet, and who each one waits for: an AI review that is due, or a person.
    verifyCounts() {
      const c = { todo: 0, ai: 0, person: 0 };
      for (const f of this.results) if (f.verify) { c.todo += 1; c[f.verify.waits] += 1; }
      return c;
    },
    basisCounts() {
      const c = { proved: 0, cited: 0, incomplete: 0 };
      for (const f of this.results) { if (f.basis in c) c[f.basis] += 1; if (f.incomplete) c.incomplete += 1; }
      return c;
    },
    cited() { return this.fact?.basis === 'cited'; },
    // What an outside reference can be linked to: the cited results first, then the other facts.
    linkOptions() {
      const others = this.results.filter((f) => f.id !== this.fact?.id);
      return [...others.filter((f) => f.basis === 'cited'), ...others.filter((f) => f.basis !== 'cited')];
    },
    starCount() { return this.results.filter((f) => f.stars > 0).length; },
    graphView() { return this.gView || defaultView(this.results.length, this.starCount > 0); },
    center() { return this.id && this.filtered.some((f) => f.id === this.id) ? this.id : bestCenter(this.filtered); },
    graphData() {
      if (this.graphView === 'key') return keyGraph(this.filtered, this.filteredEdges, (n) => (this.gScope === 'mine' ? n.starred : n.stars > 0));
      if (this.graphView === 'reading') return keyGraph(this.filtered, this.filteredEdges, (n) => n.worth_reading);
      if (this.graphView === 'around') return this.center ? neighborhood(this.filtered, this.filteredEdges, this.center, this.gDepth) : { nodes: [], edges: [] };
      return { nodes: this.filtered, edges: this.filteredEdges };
    },
    // Definitions are conventions: they live in the project notation, not among the results.
    results() { return this.facts.filter((f) => f.status !== 'definition'); },
    definitionCount() { return this.facts.length - this.results.length; },
    kinds() { return kindCounts(this.results); },
    unreadFacts() { return store.counters.unread?.fact || {}; },
    labelCounts() {
      const c = {};
      for (const f of this.facts) for (const l of f.labels) c[l] = (c[l] || 0) + 1;
      return c;
    },
    labelOptions() { return Object.keys(this.labelCounts).sort(); },
    // Subject tags in use, most used first, written as most facts write them.
    topicOptions() {
      const c = new Map();
      for (const f of this.results) for (const t of f.topics || []) { const k = t.toLowerCase(); const x = c.get(k) || { topic: t, n: 0 }; x.n += 1; c.set(k, x); }
      if (this.fTopic !== 'all' && !c.has(this.fTopic.toLowerCase())) c.set(this.fTopic.toLowerCase(), { topic: this.fTopic, n: 0 });
      return [...c.values()].sort((a, b) => b.n - a.n || a.topic.localeCompare(b.topic));
    },
    endorsed() { return this.myReview?.verdict === 'correct'; },
    denied() { return stance(this.myReview)?.key === 'denied'; },
    resultOnlyOn() { return stance(this.myReview)?.key === 'result_only'; },
    mainFlawed() { return this.fact ? this.currentReviews.some((v) => v.verdict !== 'correct') : false; },
    proofs() { return (this.fact?.proofs || []).filter((p) => p.revision_no === this.fact.current_revision); },
    // The latest repair of the proof, as one exchange between the reviewer's side and the repairer's (src/ProofRepair.php).
    repair() { const r = this.fact?.repairs?.[0]; return r ? repairView(r, (id) => { const i = this.proofs.findIndex((p) => p.id === id); return i < 0 ? null : i + 2; }) : null; },
    repairedProofs() { return new Set((this.fact?.repairs || []).flatMap((r) => (r.steps || []).map((x) => x.proof_id).filter(Boolean))); },
    // A member may ask for a repair when a review of this revision found a flaw and none runs.
    canAskRepair() { return !!this.fact && !this.fact.retracted_at && !this.repair?.open && this.currentReviews.some((v) => v.verdict !== 'correct'); },
    oldProofs() { return (this.fact?.proofs || []).filter((p) => p.revision_no !== this.fact.current_revision); },
    banner() {
      const f = this.fact, by = f.ai_model, tool = f.tool ? ` with ${f.tool}` : '';
      if (f.basis === 'cited') return { head: 'Cited result.', rest: `A result of another work, stated here without its proof. Entered by ${by}. Accept it once you have read the source.` };
      if (f.method === 'deduced') return { head: 'AI-deduced', rest: `by ${by}${tool}. Check carefully before relying on it.` };
      const entered = `Entered by ${by}. Check it against the source.`;
      if (f.origin === 'human' && f.proof_origin === 'human') return { head: 'Human statement and proof.', rest: entered };
      if (f.origin === 'human' && f.proof_origin === 'ai') return { head: 'Human statement, AI proof.', rest: entered };
      if (f.origin === 'human' && f.proof_origin === 'mixed') return { head: 'Human statement, proof from human and AI sources.', rest: entered };
      if (f.origin === 'human') return { head: 'Human statement, no proof recorded.', rest: entered };
      return { head: 'From AI-written material.', rest: entered };
    },
    counts() {
      const c = { all: this.results.length };
      for (const f of this.results) c[f.status] = (c[f.status] || 0) + 1;
      return c;
    },
    canWriteReview() { return this.fact && !this.fact.retracted_at; },
    glossary() { return Object.entries(this.fact?.glossary || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]); },
    // What this fact defines for itself, in the version shown, and the project symbols it relies on.
    localNotation() {
      const own = this.rephrasing ? Object.entries(this.rephrasing.local || {}) : this.glossary;
      return own.map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
    },
    // Revisions and the changes applied to the fact, newest first: one history.
    timeline() {
      if (!this.fact) return [];
      const revs = this.fact.revisions.map((r) => ({ key: `r${r.id}`, at: r.created_at, rev: r }));
      const changes = (this.fact.history || []).map((h) => ({ key: `h${h.id}`, at: h.decided_at, change: h }));
      return [...revs, ...changes].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (a.change ? -1 : 0) + (b.change ? 1 : 0))); // a change follows the revision of the same second
    },
    mergedHere() { return (this.fact?.history || []).filter((h) => h.kind === 'same' && h.status === 'accepted' && h.fact_id === this.fact.id); },
    // The notation marked in the text shown: what this version defines for itself, then the agreed project symbols. None on an older revision.
    notationMarks() { return this.fact && !this.shownRevision ? factNotation(this.localNotation, this.fact.notation, this.fact.local_entries) : []; },
    projectSymbols() { return this.rephrasing ? [...new Set((this.rephrasing.uses || []).map((u) => u.project_symbol).filter(Boolean))] : []; },
    myReview() { return this.fact?.reviews.find((v) => v.reviewer_id === this.me && v.reviewer_kind === 'human' && v.revision_no === this.fact.current_revision); },
    currentReviews() { return this.fact.reviews.filter((v) => v.revision_no === this.fact.current_revision); },
    oldReviews() { return this.fact.reviews.filter((v) => v.revision_no !== this.fact.current_revision); },
    canDelete() { return this.fact && (this.fact.created_by === this.me || this.isOwner) && !this.fact.dependents.length; },
    shownRevision() { return this.fact.revisions.find((r) => r.revision_no === this.revView) || null; },
    content() { return this.shownRevision || this.fact; },
    externalRefs() { return parseExternalRefs(this.fact?.external_refs); },
    // How it came here, said in full on hover of its method.
    originTitle() {
      const f = this.fact; const by = f.ai_model ? ` by ${f.ai_model}` : '';
      if (f.basis === 'cited') return `A result of another work, entered${by} without its proof: accept it once you have read the source.`;
      if (f.method === 'deduced') return `Deduced${by}: an AI proved it here. Check its proof before relying on it.`;
      return `Extracted${by} from its source, below: check it against the source.`;
    },
    headTitle() { return this.fact ? texLine(factTitle(this.fact.title, this.fact.statement_html, true)) : ''; },
    gridClass() {
      if (this.sidePanel) return 'facts-notation';
      if (this.mode === 'list') return 'cols3';
      return this.fact || this.factError ? 'facts-graph has-detail' : 'facts-graph';
    },
  },
  watch: {
    // The list holds excerpts: the server searches the full statements, and its matches join the local ones.
    search(q) {
      clearTimeout(this.matchTimer);
      const words = q.trim();
      if (words.length < 3) { this.matchIds = new Set(); return; }
      this.matchTimer = setTimeout(async () => {
        try {
          const r = await api.get(`api/projects/${this.pid}/facts/match?q=${encodeURIComponent(words)}`);
          if (this.search.trim() === words) this.matchIds = new Set(r.ids);
        } catch { /* the local search still works */ }
      }, 300);
    },
    fact() { this.refreshOutline(); },
    revView() { this.refreshOutline(); },
    projectNotation() { this.refreshOutline(); },
    tab() { this.refreshOutline(); }, id: { immediate: true, handler() { this.onRoute(); } }, 'query.tab'(t) { if (t) { this.tab = t; if (t === 'trace') this.loadTrace(); } }, 'query.topic': { immediate: true, handler(t) { if (t) { this.fTopic = t; this.showFilters = true; } } } },
  mounted() {
    this.loadList();
    this.timer = setInterval(() => { if (!this.checkForm && !this.retracting) this.loadList(); }, 30000);
  },
  unmounted() { clearInterval(this.timer); },
  template: `<div :class="gridClass">
  <notation-panel v-if="mode === 'notation'" :pid="pid" :focus="+(query?.notation || 0)" :comment="+(query?.comment || 0)" @mode="setMode"/>
  <consolidation-panel v-if="mode === 'consolidate'" :pid="pid" @mode="setMode"/>
  <section v-if="mode === 'graph'" class="col fg-col">
    <header class="col-head"><h2>Facts <span class="count">{{ filtered.length }}<template v-if="filtered.length !== results.length"> / {{ results.length }}</template></span></h2>
      <div class="row-gap"><div class="seg small mode-seg narrow-seg" role="group" aria-label="View"><button title="List" aria-label="List" @click="setMode('list')"><icon name="list" :size="13"/> <span class="ms-l">List</span></button><button class="on" aria-pressed="true"><icon name="graph" :size="13"/> <span class="ms-l">Graph</span></button><button title="Notation: the meaning agreed for each symbol" aria-label="Notation" @click="setMode('notation')"><icon name="book" :size="13"/> <span class="ms-l">Notation</span></button><button title="Consolidate: duplicates, links across sources, open questions and subject tags" aria-label="Consolidate" @click="setMode('consolidate')"><icon name="layers" :size="13"/> <span class="ms-l">Consolidate</span></button></div><mark-all-read type="fact"/></div></header>
    <div class="fg-filters">
      <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Search facts…"></div>
      <select v-model="fKind" aria-label="Filter by mathematical type"><option value="all">All types</option><option v-for="k in kinds" :key="k.key" :value="k.key">{{ k.label }} ({{ k.n }})</option></select>
      <select v-model="fStatus" aria-label="Filter by status"><option value="all">All statuses</option><option v-for="(s, k) in statuses" :key="k" :value="k">{{ s.label }} ({{ counts[k] || 0 }})</option></select>
      <select v-model="fOrigin" aria-label="Filter by proof origin"><option value="all">Any proof origin</option><option value="human">Human proof</option><option value="ai">AI proof</option><option value="mixed">Human + AI proof</option><option value="none">No proof</option></select>
      <select v-model="fLabel" aria-label="Filter by label"><option value="all">All labels</option><option v-for="l in labelOptions" :key="l" :value="l">{{ pretty(l) }} ({{ labelCounts[l] }})</option></select>
      <select v-model="fStar" aria-label="Filter by star"><option value="all">Starred or not</option><option value="starred">Starred ({{ starCount }})</option><option value="mine">Starred by me</option></select>
      <select v-model="fBasis" aria-label="Filter by basis"><option value="all">Proved or cited</option><option value="proved">Proved here ({{ basisCounts.proved }})</option><option value="cited">Cited results ({{ basisCounts.cited }})</option><option value="incomplete">Using an outside result ({{ basisCounts.incomplete }})</option></select>
      <select v-if="topicOptions.length || fTopic !== 'all'" v-model="fTopic" aria-label="Filter by subject tag"><option value="all">All subjects</option><option v-for="t in topicOptions" :key="t.topic" :value="t.topic">{{ t.topic }} ({{ t.n }})</option></select>
      <label class="check" v-if="id"><input type="checkbox" v-model="lineage"> Only this fact's lineage</label>
    </div>
    <div v-if="loaded && !facts.length" class="placeholder"><icon name="graph" :size="40"/><p>No facts yet. Your AI client adds them with a personal API key.</p><a class="btn primary" href="#/profile"><icon name="key" :size="14"/> Get an API key</a></div>
    <div v-if="facts.length" class="fg-views">
      <div class="seg small" role="group" aria-label="What the graph shows"><button v-for="(v, k) in graphViews" :key="k" :class="{on: graphView === k}" :aria-pressed="graphView === k" :title="v.hint" @click="gView = k">{{ k === 'key' ? '★ ' : '' }}<icon v-if="k === 'reading'" name="sparkles" :size="12"/> {{ v.label }}</button></div>
      <select v-if="graphView === 'key'" v-model="gScope" class="sm" aria-label="Whose stars"><option value="all">Starred by anyone</option><option value="mine">Starred by me</option></select>
      <select v-if="graphView === 'around'" v-model.number="gDepth" class="sm" aria-label="Depth"><option :value="1">1 step</option><option :value="2">2 steps</option><option :value="3">3 steps</option><option :value="5">5 steps</option><option :value="0">All the lineage</option></select>
      <span class="muted small">{{ graphData.nodes.length }} of {{ results.length }} facts shown<template v-if="graphView === 'around' && center && center !== id"> · around the most starred or used fact</template></span>
    </div>
    <div v-if="facts.length && graphView === 'key' && !graphData.nodes.length" class="placeholder"><span class="kpi-icon"><icon name="star" :size="22"/></span><p>No starred fact {{ gScope === 'mine' ? 'of yours ' : '' }}yet. Star the facts that matter, on their page or in the list. Key facts then show how they rely on each other, however large the database is.</p><button class="btn" @click="gView = 'all'">Show everything</button></div>
    <div v-else-if="facts.length && graphView === 'reading' && !graphData.nodes.length" class="placeholder"><span class="kpi-icon"><icon name="sparkles" :size="22"/></span><p>No fact is marked worth reading yet. The consolidation marks real progress, such as a new result on a question or a key step of a proof, and it then appears in every member's reading suggestions.</p><button class="btn" @click="gView = 'all'">Show everything</button></div>
    <fact-graph v-else-if="facts.length" :nodes="graphData.nodes" :edges="graphData.edges" :selected="id" :unread="unreadFacts" @select="selectNode"/>
    <div class="fg-legend">
      <span v-for="(s, k) in statuses" :key="k"><i :style="{background: s.bg, borderColor: s.color}"></i>{{ s.label }}</span>
      <span><i class="stripe human"></i>Human proof</span><span><i class="stripe ai"></i>AI proof</span><span><i class="stripe mixed"></i>Mixed</span><span><i class="stripe none"></i>No proof</span>
      <span><i class="dashed"></i>Relies on a disputed or retracted fact</span>
      <span><i class="unread-dot"></i>Unread</span>
    </div>
  </section>

  <section v-if="mode === 'list'" class="col col-list">
    <header class="col-head"><h2>Facts</h2>
      <div class="row-gap"><div class="seg small mode-seg compact-seg" role="group" aria-label="View"><button class="on" aria-pressed="true"><icon name="list" :size="13"/> <span class="ms-l">List</span></button><button title="Graph" aria-label="Graph" @click="setMode('graph')"><icon name="graph" :size="13"/> <span class="ms-l">Graph</span></button><button title="Notation: the meaning agreed for each symbol" aria-label="Notation" @click="setMode('notation')"><icon name="book" :size="13"/> <span class="ms-l">Notation</span></button><button title="Consolidate: duplicates, links across sources, open questions and subject tags" aria-label="Consolidate" @click="setMode('consolidate')"><icon name="layers" :size="13"/> <span class="ms-l">Consolidate</span></button></div><mark-all-read type="fact"/></div></header>
    <div class="col-tools">
      <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Search label, statement, model…"></div>
      <button v-if="definitionCount" class="link-btn small definitions-link" @click="setMode('notation')"><icon name="book" :size="13"/> {{ definitionCount }} definition{{ definitionCount > 1 ? 's are' : ' is' }} in the project notation</button>
      <div v-if="kinds.length > 1" class="kind-filter" role="group" aria-label="Filter by mathematical type"><button :class="{on: fKind === 'all'}" :aria-pressed="fKind === 'all'" @click="fKind = 'all'">All <b>{{ results.length }}</b></button><button v-for="k in kinds" :key="k.key" :class="['k-' + k.key, {on: fKind === k.key}]" :aria-pressed="fKind === k.key" @click="fKind = k.key">{{ k.label }} <b>{{ k.n }}</b></button></div>
      <div class="filter-bar">
        <button class="btn xs" :class="{on: showFilters}" :aria-expanded="showFilters" @click="showFilters = !showFilters"><icon name="filter" :size="13"/> Filters<b v-if="activeFilters" class="seg-n">{{ activeFilters }}</b></button>
        <button v-if="activeFilters" class="link-btn" @click="clearFilters">Clear</button>
        <span class="grow"></span>
        <select v-model="sort" aria-label="Sort"><option value="recent">Recent</option><option value="label">Label</option><option value="used">Most used</option><option value="stars">Most starred</option><option value="verify">To verify first</option></select>
      </div>
      <div v-if="showFilters" class="fact-filters">
        <select v-model="fStatus" aria-label="Filter by status"><option value="all">All statuses ({{ counts.all }})</option><option v-for="(s, k) in statuses" :key="k" :value="k">{{ s.label }} ({{ counts[k] || 0 }})</option></select>
        <select v-model="fOrigin" aria-label="Filter by proof origin"><option value="all">Any proof origin</option><option value="human">Human proof</option><option value="ai">AI proof</option><option value="mixed">Human + AI proof</option><option value="none">No proof</option></select>
        <select v-model="fLabel" aria-label="Filter by label"><option value="all">All labels</option><option v-for="l in labelOptions" :key="l" :value="l">{{ pretty(l) }} ({{ labelCounts[l] }})</option></select>
        <select v-model="fStar" aria-label="Filter by star"><option value="all">Starred or not</option><option value="starred">Starred ({{ starCount }})</option><option value="mine">Starred by me</option></select>
        <select v-model="fBasis" aria-label="Filter by basis"><option value="all">Proved or cited</option><option value="proved">Proved here ({{ basisCounts.proved }})</option><option value="cited">Cited results ({{ basisCounts.cited }})</option><option value="incomplete">Using an outside result ({{ basisCounts.incomplete }})</option></select>
        <select v-if="topicOptions.length || fTopic !== 'all'" v-model="fTopic" class="wide-filter" aria-label="Filter by subject tag"><option value="all">All subjects</option><option v-for="t in topicOptions" :key="t.topic" :value="t.topic">{{ t.topic }} ({{ t.n }})</option></select>
        <select v-model="fVerify" aria-label="Filter by what a check waits for" title="Proved facts no person has checked yet: those an AI review is due on, and those that wait for a person"><option value="all">Checked or not</option><option value="todo">To verify ({{ verifyCounts.todo }})</option><option value="ai">AI review due ({{ verifyCounts.ai }})</option><option value="person">Waiting for a person ({{ verifyCounts.person }})</option></select>
        <select v-model="fLean" aria-label="Filter by Lean"><option value="all">Any Lean</option><option value="with">With Lean</option><option value="compiled">Compiling</option><option value="none">No Lean</option></select>
      </div>
    </div>
    <div class="list">
      <a v-for="f in filtered" :key="f.id" class="li fact-li" :class="['o-' + f.origin, {active: f.id === id, 'is-new': !!unreadOf(f.id)}]" :href="factLink(f.id)">
        <div class="li-top"><span class="li-subject"><math-text :text="texLine(factTitle(f.title, f.statement_text))"/></span><button class="star-btn" :class="{on: f.starred}" :aria-pressed="!!f.starred" :title="f.starred ? 'Remove your star' : 'Star this fact: it matters'" :aria-label="(f.starred ? 'Remove your star from ' : 'Star ') + f.label" @click.prevent.stop="toggleStar(f)"><icon name="star" :size="13"/><b v-if="f.stars">{{ f.stars }}</b></button><unread-badge type="fact" :id="f.id"/></div>
        <div v-if="search.trim() || statementAddsToTitle(f.title, f.statement_text)" class="li-snippet"><math-text :text="f.statement_text"/></div>
        <div class="li-foot">
          <fact-badges :f="f"/>
          <span class="kind-word" :class="'k-' + kindOf(f)">{{ kindLabel(kindOf(f)) }}</span>
          <label-chips v-if="quietLabels(f.labels).length" :labels="quietLabels(f.labels)"/>
          <span v-if="f.topics?.length" class="topic-chip sm" :title="'Subject tags: ' + f.topics.join(', ')">{{ f.topics[0] }}</span><span v-if="f.topics?.length > 1" class="topic-more" :title="'Subject tags: ' + f.topics.join(', ')">+{{ f.topics.length - 1 }}</span>
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

  <section v-if="!sidePanel && (mode === 'list' || fact || factError)" class="col col-main">
    <template v-if="fact">
     <div class="fact-scroll" ref="factScroll">
      <div v-if="fact.retracted_at" class="fact-alert red"><b>Retracted</b> by {{ fact.retracted_by_name }}, {{ timeAgo(fact.retracted_at) }}: {{ fact.retract_reason }}</div>
      <header class="fact-head">
        <div class="fact-id"><span class="kind-tag" :class="'k-' + kindOf(fact)">{{ kindLabel(kindOf(fact)) }}</span><span :title="originTitle">{{ fact.method }}<template v-if="fact.tool"> with {{ fact.tool }}</template></span><span :title="'Revision ' + fact.current_revision + ': its history is under Trace'">r{{ fact.current_revision }}</span><span class="fact-when" :title="'Added by ' + fact.author + (fact.ai_model ? ', written by ' + fact.ai_model : '')">updated {{ timeAgo(fact.updated_at) }}</span></div>
        <h2><math-text :text="headTitle"/></h2>
        <div class="fact-state">
          <fact-badges :f="fact" verbose/>
          <button v-if="fact.chain !== 'ok' && !fact.retracted_at" class="fb fb-btn" :class="fact.chain === 'broken' ? 't-bad' : 't-warn'" :title="chainLabels[fact.chain] + ' in its dependency chain. Trace lists what it rests on.'" @click="openTab('trace')"><icon name="link" :size="13"/><span class="fb-label">{{ chainShort[fact.chain] }}</span></button>
          <label-chips v-if="quietLabels(fact.labels).length" :labels="quietLabels(fact.labels)"/>
          <span v-if="fact.lean !== 'none'" class="lean-tag" :class="fact.lean">{{ leanLabels[fact.lean] }}</span>
        </div>
        <div v-if="fact.endorsed_by.length || fact.result_endorsed_by?.length || fact.denied_by.length" class="fact-people">
          <span v-if="fact.endorsed_by.length" class="endorsers"><icon name="check-circle" :size="13"/> Endorsed by <template v-for="(e, i) in fact.endorsed_by" :key="e.id"><a :href="link('members', null, {user: e.id})">{{ e.name }}</a><template v-if="i < fact.endorsed_by.length - 1">, </template></template></span>
          <span v-if="fact.result_endorsed_by?.length" class="endorsers result-only" title="They accept the result, but not its proof"><icon name="check" :size="13"/> Result only: <template v-for="(e, i) in fact.result_endorsed_by" :key="e.id"><a :href="link('members', null, {user: e.id})">{{ e.name }}</a><template v-if="i < fact.result_endorsed_by.length - 1">, </template></template></span>
          <span v-if="fact.denied_by.length" class="endorsers denied" title="They say the result is false: their reasons are under Reviews"><icon name="x" :size="13"/> Denied by <template v-for="(e, i) in fact.denied_by" :key="e.id"><a :href="link('members', null, {user: e.id})">{{ e.name }}</a><template v-if="i < fact.denied_by.length - 1">, </template></template></span>
        </div>
        <p v-if="fact.worth_reading" class="fact-note t-info" :title="fact.worth_reading.model ? 'Marked by ' + fact.worth_reading.model + ', in a consolidation' : 'Marked by a member'"><icon name="eye" :size="13"/><span><b>Worth reading.</b> <math-text :text="fact.worth_reading.reason"/></span></p>
        <p v-if="fact.merged_from" class="fact-note"><icon name="layers" :size="13"/><span>{{ fact.merged_from }} was merged into this fact, as the same result.</span></p>
        <p v-else-if="mergedHere.length" class="fact-note"><icon name="layers" :size="13"/><span>{{ mergedHere.map((h) => h.other_label).join(', ') }} {{ mergedHere.length > 1 ? 'were' : 'was' }} merged into this fact, as the same result. <button class="link-btn" @click="openTab('trace')">History</button></span></p>
        <p v-if="fact.status === 'definition'" class="fact-note t-info"><icon name="book" :size="13"/><span>A definition: it belongs to the project notation, and it is not checked like a result. <button class="link-btn" @click="setMode('notation')">Open the notation</button></span></p>
        <ai-pending compact :items="fact.ai_pending" :questions="fact.ai_questions"/>
        <div class="fact-topics"><icon name="tag" :size="13"/>
          <template v-if="topicDraft === null"><a v-for="t in fact.topics" :key="t" class="topic-chip" :href="link('facts', null, {topic: t})">{{ t }}</a><button class="link-btn small" :title="fact.topics.length ? 'Change its subject tags: they only help to find facts' : 'Add subject tags: they only help to find facts'" @click="topicDraft = fact.topics.join(', ')">{{ fact.topics.length ? 'Edit' : 'Add subject tags' }}</button></template>
          <template v-else><input v-model="topicDraft" class="topic-input" placeholder="Subjects, separated by commas" aria-label="Subject tags, separated by commas" @keydown.enter="saveTopics" @keydown.esc="topicDraft = null"><button class="btn xs primary" @click="saveTopics">Save</button><button class="btn xs ghost" @click="topicDraft = null">Cancel</button></template></div>
      </header>
      <div class="fact-bar">
        <nav class="fact-tabs" aria-label="Parts of this fact">
          <button :class="{on: tab==='content'}" :aria-pressed="tab==='content'" title="Statement, proof, sources and notation" @click="openTab('content')"><icon name="eye" :size="14"/><span class="ft-l">Fact</span></button>
          <button :class="{on: tab==='reviews'}" :aria-pressed="tab==='reviews'" :title="currentReviews.length + ' review' + (currentReviews.length === 1 ? '' : 's') + ' of this revision, and yours'" @click="openTab('reviews')"><icon name="check-circle" :size="14"/><span class="ft-l">Reviews</span><b v-if="currentReviews.length" class="count">{{ currentReviews.length }}</b></button>
          <button :class="{on: tab==='lean'}" :aria-pressed="tab==='lean'" :title="fact.lean_proofs.length + ' Lean proof' + (fact.lean_proofs.length === 1 ? '' : 's')" @click="openTab('lean')"><icon name="code" :size="14"/><span class="ft-l">Lean</span><b v-if="fact.lean_proofs.length" class="count">{{ fact.lean_proofs.length }}</b></button>
          <button :class="{on: tab==='deps'}" :aria-pressed="tab==='deps'" :title="'Relies on ' + fact.deps.length + ', used by ' + fact.dependents.length + ', and where it is mentioned'" @click="openTab('deps')"><icon name="graph" :size="14"/><span class="ft-l">Links</span><b v-if="fact.deps.length + fact.dependents.length" class="count">{{ fact.deps.length + fact.dependents.length }}</b></button>
          <button :class="{on: tab==='trace'}" :aria-pressed="tab==='trace'" title="Origin, what it rests on, credits and history" @click="openTab('trace')"><icon name="history" :size="14"/><span class="ft-l">Trace</span></button>
        </nav>
        <div class="fact-acts">
          <button class="icon-btn star-toggle" :class="{on: fact.starred}" :aria-pressed="!!fact.starred" :title="(fact.starred ? 'Remove your star. ' : 'Star this fact: it matters, and stands out in the graph. ') + (fact.starred_by?.length ? 'Starred by ' + fact.starred_by.map((u) => u.name).join(', ') + '.' : 'Nobody starred it yet.')" :aria-label="fact.starred ? 'Remove your star' : 'Star this fact'" @click="toggleStar(fact)"><icon name="star" :size="15"/><b v-if="fact.stars" class="fb-n">{{ fact.stars }}</b></button>
          <template v-if="!fact.retracted_at">
            <button class="btn sm endorse" :class="{on: endorsed}" :aria-pressed="endorsed" :title="cited ? (endorsed ? 'Withdraw your acceptance' : explain('fact.accept')) : (endorsed ? 'Withdraw your endorsement' : explain('fact.endorse'))" @click="toggleEndorse"><icon name="check" :size="14"/> {{ cited ? (endorsed ? 'Accepted' : 'Accept') : (endorsed ? 'Endorsed' : 'Endorse') }}</button>
            <action-menu icon="x" :label="denied ? 'Denied' : resultOnlyOn ? 'Result only' : ''" :on="denied || resultOnlyOn" :tone="denied ? 'bad' : resultOnlyOn ? 'warn' : ''" title="Disagree: the proof has a flaw, or the result is false">
              <button v-if="!cited" class="menu-item" role="menuitem" :title="explain('fact.resultOnly')" @click="toggleResultOnly"><icon name="check" :size="14"/><span><b>{{ resultOnlyOn ? 'Withdraw: result, not proof' : 'Result, not proof' }}</b><small>The result is right, but its proof has a gap or an error.</small></span></button>
              <button class="menu-item" role="menuitem" :title="explain('fact.deny')" @click="toggleDeny"><icon name="x" :size="14"/><span><b>{{ denied ? 'Withdraw your denial' : 'Deny' }}</b><small>The result itself is false. The fact stays, with your reason.</small></span></button>
            </action-menu>
            <action-menu icon="sparkles" label="AI" title="Ask an AI client to work on this fact: each request joins the AI queue">
              <ai-action v-if="!cited" menu kind="review" source-type="fact" :source-id="fact.id" label="Independent review"/>
              <ai-action v-else menu kind="source_check" source-type="fact" :source-id="fact.id" label="Check the source"/>
              <ai-action menu kind="lean" source-type="fact" :source-id="fact.id" label="Lean proof"/>
              <ai-action menu kind="ask" source-type="fact" :source-id="fact.id" label="Ask a question"/>
              <ai-action v-if="!currentRephrasing && !notationState" menu kind="notation" source-type="fact" :source-id="fact.id" label="Write it in the project notation" title="Write this fact again in the notation agreed by the project"/>
              <ai-action menu kind="derive" source-type="fact" :source-id="fact.id" label="Prove new facts from it"/>
              <button v-if="canAskRepair" class="menu-item" role="menuitem" title="An AI of another company than the reviewer repairs the proof, or answers the review; one of the reviewer's side checks it, for up to three rounds. A repaired proof is added beside the original, which stays as it is." @click="askRepair"><icon name="edit" :size="14"/><span><b>Repair the proof</b><small>Answers the latest review that found a flaw, a person's included.</small></span></button>
            </action-menu>
          </template>
          <action-menu icon="more" title="Cite, mark as unread, retract or delete">
            <button class="menu-item" role="menuitem" :title="'Copies its key, ' + fact.label + ', to cite it in a text or a paper'" @click="cite"><icon name="link" :size="14"/><span><b>Cite</b><small>Copies its key, {{ fact.label }}. Type @ in any text here to link it.</small></span></button>
            <button class="menu-item" role="menuitem" @click="markItemUnread('fact', fact.id)"><icon name="mail" :size="14"/><span><b>Mark as unread</b><small>For you only.</small></span></button>
            <button v-if="!fact.retracted_at" class="menu-item warn" role="menuitem" :title="explain('fact.retract')" @click="retracting = {reason: ''}"><icon name="archive" :size="14"/><span><b>Retract</b><small>Withdraws it for everyone and flags what relies on it. Reinstate undoes it.</small></span></button>
            <button v-else class="menu-item" role="menuitem" :title="explain('fact.reinstate')" @click="reinstate"><icon name="restore" :size="14"/><span><b>Reinstate</b><small>Brings it back for everyone.</small></span></button>
            <button v-if="canDelete" class="menu-item danger" role="menuitem" :title="explain('fact.delete')" @click="remove"><icon name="trash" :size="14"/><span><b>Delete</b><small>Removes it for good: nothing relies on it.</small></span></button>
          </action-menu>
          <button v-if="mode === 'graph'" class="icon-btn" title="Close this fact" aria-label="Close" @click="closeFact"><icon name="x"/></button>
        </div>
      </div>
      <modal v-if="denying" title="Deny this fact" @close="denying = null">
        <p class="muted small">Deny means that the result itself is false. If you believe the result but not its proof, use <b>Result, not proof</b> instead. Denying records your verdict: the fact stays in the database for everyone, unlike <b>Retract</b>.</p>
        <label class="field"><span>What is wrong? Point to the exact step, or give a counterexample.</span><textarea v-model="denying.reason" rows="4" autofocus></textarea></label>
        <template #footer><button class="btn ghost" @click="denying = null">Cancel</button><button class="btn danger" :disabled="!denying.reason.trim()" @click="submitDeny">Deny fact</button></template>
      </modal>
      <modal v-if="resultOnly" title="Accept the result, not the proof" @close="resultOnly = null">
        <p class="muted small">The result counts as believed, and facts using it stay usable, but it is not proved until a proof is accepted. Anyone can then propose another proof.</p>
        <div class="field"><span>The proof has</span><div class="seg" role="group" aria-label="What is wrong with the proof"><button :class="{on: resultOnly.verdict === 'gap'}" :aria-pressed="resultOnly.verdict === 'gap'" @click="resultOnly.verdict = 'gap'">A gap</button><button :class="{on: resultOnly.verdict === 'incorrect'}" :aria-pressed="resultOnly.verdict === 'incorrect'" @click="resultOnly.verdict = 'incorrect'">An error</button></div></div>
        <label class="field"><span>Where? Point to the exact step.</span><textarea v-model="resultOnly.reason" rows="4" autofocus></textarea></label>
        <template #footer><button class="btn ghost" @click="resultOnly = null">Cancel</button><button class="btn primary" :disabled="!resultOnly.reason.trim()" @click="submitResultOnly">Accept the result only</button></template>
      </modal>
      <modal v-if="proposing" :title="proposing.proof ? 'Edit your proof' : 'Propose another proof'" wide @close="proposing = null">
        <p class="muted small">A proof of the current statement of {{ fact.label }}. Others review it on its own. Once a proof is accepted, the fact counts as checked, even if another proof is disputed.</p>
        <rich-editor ref="proofEd" :min-height="220" :initial-html="proposing.proof?.body_html || ''" placeholder="Write the proof. $…$ for LaTeX, @ to cite facts and references."/>
        <template #footer><button class="btn ghost" @click="proposing = null">Cancel</button><button class="btn primary" @click="submitProof">{{ proposing.proof ? 'Save the proof' : 'Propose the proof' }}</button></template>
      </modal>
      <modal v-if="unfaithful" title="The meaning changed" @close="unfaithful = null">
        <label class="field"><span>What does the version in project notation say differently?</span><textarea v-model="unfaithful.note" rows="4" autofocus></textarea></label>
        <template #footer><button class="btn ghost" @click="unfaithful = null">Cancel</button><button class="btn primary" :disabled="!unfaithful.note.trim()" @click="checkRephrasing('unfaithful', unfaithful.note)">Report</button></template>
      </modal>
      <modal v-if="proofCheck" :title="proofCheck.verdict === 'gap' ? 'A gap in this proof' : 'An error in this proof'" @close="proofCheck = null">
        <label class="field"><span>Point to the exact step.</span><textarea v-model="proofCheck.reason" rows="4" autofocus></textarea></label>
        <template #footer><button class="btn ghost" @click="proofCheck = null">Cancel</button><button class="btn primary" :disabled="!proofCheck.reason.trim()" @click="submitProofCheck">Save the review</button></template>
      </modal>

      <div v-if="tab==='content'" class="pad fact-body">
        <div v-if="shownRevision" class="fact-alert amber">Viewing revision {{ revView }}. <button class="link-btn" @click="revView = null">Back to current</button></div>
        <nav v-if="readable && outline.length > 1" class="fact-outline" aria-label="In this fact"><button v-for="(x, i) in outline" :key="i" :class="'k-' + x.type" @click="jump(x)">{{ x.title }}</button></nav>
        <div class="fact-readbar">
          <span v-if="notationState && !shownRevision" class="hover-list fact-nstate" :class="'t-' + notationState.tone" tabindex="0" :aria-label="notationState.text"><icon name="book" :size="13"/><span class="fns-l">{{ notationState.short }}</span>
            <span class="hover-pop" role="group">
              <span><math-text :text="notationState.text"/><template v-if="currentRephrasing?.check_verdict && !checkedByAi(currentRephrasing)"> {{ currentRephrasing.check_verdict === 'faithful' ? 'Confirmed' : 'Reported' }} by {{ currentRephrasing.checked_by_name }}.</template> <ai-meta v-if="currentRephrasing?.check_verdict && checkedByAi(currentRephrasing)" compact :model="currentRephrasing.check_ai_model" :user="currentRephrasing.check_ai_user_name" :ms="currentRephrasing.check_ai_generation_ms"/></span>
              <span v-if="rephrasing?.uses?.length" class="notation-uses"><b>In its source</b><span v-for="(u, i) in rephrasing.uses" :key="i" class="notation-use"><math-text :text="asMath(u.symbol)"/> <small><math-text :text="u.meaning_here"/></small><template v-if="u.project_symbol && u.project_symbol !== u.symbol"> → <math-text :text="asMath(u.project_symbol)"/></template></span></span>
              <span v-if="currentRephrasing || notationState.tone === 'warn' || notationState.tone === 'bad'" class="row-gap">
                <template v-if="currentRephrasing && (!currentRephrasing.check_verdict || checkedByAi(currentRephrasing))"><button class="btn xs endorse" :title="explain('fact.sameMeaning')" @click="checkRephrasing('faithful')"><icon name="check" :size="12"/> Same meaning</button><button class="btn xs deny" :title="explain('fact.notSame')" @click="unfaithful = {note: ''}">Not the same</button></template>
                <button v-else-if="currentRephrasing" class="btn xs" :title="explain('fact.undoCheck')" @click="checkRephrasing('')">Undo</button>
                <ai-action v-if="notationState.tone === 'warn' || notationState.tone === 'bad'" kind="notation" source-type="fact" :source-id="fact.id" label="Rewrite again"/></span>
            </span></span>
          <span class="grow"></span>
          <div v-if="currentRephrasing && !shownRevision" class="seg small" role="group" aria-label="Notation"><button :class="{on: projectNotation}" :aria-pressed="projectNotation" title="Written again in the notation agreed by the project" @click="setNotation(true)">Project</button><button :class="{on: !projectNotation}" :aria-pressed="!projectNotation" title="The notation of its source, as it was reviewed" @click="setNotation(false)">As written</button></div>
          <div class="seg small" role="group" aria-label="How the text is shown"><button :class="{on: readable}" :aria-pressed="readable" title="Same content, with headings, lists and formulas typeset in LaTeX" @click="setReadable(true)">Readable</button><button :class="{on: !readable}" :aria-pressed="!readable" title="The text exactly as stored" @click="setReadable(false)">Original</button></div>
        </div>
        <p v-if="cited && !shownRevision" class="fact-note t-info"><icon name="book" :size="13"/><span>Proofs that use this result rely on its source. <template v-if="fact.status === 'accepted'">A member who read the source accepted it.</template><template v-else>Nobody has accepted it yet: read the source, then click <b>Accept</b>. You can also propose a proof below.</template></span></p>
        <section class="fact-sec statement"><h4>Statement</h4><rich-content :html="shown(statementHtml)" :notation="notationMarks" :fact-refs="fact.text_refs"/></section>
        <section class="fact-sec" v-if="content.proof_html"><h4>Proof<span v-if="!shownRevision && mainFlawed" class="tag amber">Disputed</span><span v-if="!shownRevision && proofs.length" class="tag">1 of {{ proofs.length + 1 }}</span><span class="grow"></span><button v-if="!shownRevision && !fact.retracted_at && !proofs.length && !oldProofs.length && !mainFlawed && fact.status !== 'proof_disputed'" class="link-btn small" title="Propose a different argument, reviewed on its own: one accepted proof is enough for the fact to count as checked" @click="proposing = {proof: null}"><icon name="plus" :size="12"/> Another proof</button></h4><rich-content :html="shown(proofHtml)" :notation="notationMarks" :fact-refs="fact.text_refs"/></section>
        <section v-if="!shownRevision && repair" class="fact-sec repair-sec">
          <h4>Repair of the proof<span class="count">{{ repair.round }}</span><span class="grow"></span><span v-if="repair.asked" class="muted small">{{ repair.asked }}</span></h4>
          <p class="repair-state" :class="'t-' + repair.tone"><icon :name="repair.icon" :size="14"/><span><b>{{ repair.head }}.</b> {{ repair.text }}</span></p>
          <ol class="repair-steps">
            <li v-for="(x, i) in repair.steps" :key="i" :class="'t-' + x.tone"><icon :name="x.icon" :size="13"/>
              <div><span class="repair-who">{{ x.who }}</span> {{ x.what }}<button v-if="x.proof" class="link-btn small" @click="jumpProof(x.proof)">Read it</button>
                <details v-if="x.text"><summary>Why</summary><math-text class="repair-why" :text="x.text"/></details></div></li>
          </ol>
        </section>
        <section v-if="!shownRevision && fact.outside_refs?.length" class="fact-sec outside-refs"><h4>Results used from other works<span class="count">{{ fact.outside_refs.length }}</span></h4>
          <p class="muted small">A proof relies only on facts of the database, so that it can be checked against them. Link each result the proof takes from another work to the fact that states it, usually a cited result. A consolidation proposes these links, and writes the cited results that are missing.</p>
          <div v-for="r in fact.outside_refs" :key="r.key" class="outside-ref" :class="{open: !r.resolved}">
            <div class="outside-ref-top"><icon :name="r.resolved ? 'check-circle' : 'link'" :size="14"/><math-text class="outside-ref-label" :text="r.label"/></div>
            <div v-if="r.fact" class="row-gap small"><span class="muted">Stated by</span><a :href="factLink(r.fact.id)" :title="r.fact.label"><fact-badges :f="r.fact" :only="['status']"/> <math-text :text="r.fact.title"/></a><button class="link-btn small" :title="explain('fact.unlink')" @click="clearRef(r)">Unlink</button></div>
            <div v-else-if="r.not_used" class="row-gap small"><span class="muted">Not used as a result: background only.</span><button class="link-btn small" @click="clearRef(r)">Undo</button></div>
            <div v-else class="outside-ref-act">
              <select v-model="refPick[r.key]" class="sm" :aria-label="'Fact that states ' + r.label"><option :value="undefined" disabled>Fact that states it…</option><option v-for="f in linkOptions" :key="f.id" :value="f.id">{{ f.basis === 'cited' ? 'Cited · ' : '' }}{{ f.label }}: {{ f.title }}</option></select>
              <button class="btn sm" :disabled="!refPick[r.key]" :title="explain('fact.link')" @click="linkRef(r)">Link</button>
              <button class="btn sm ghost" :title="explain('fact.notUsed')" @click="linkRef(r, true)">Not used</button>
            </div>
          </div>
        </section>
        <section v-if="!shownRevision && cited && fact.source_checks?.length" class="fact-sec"><h4>Source checks by AI<span class="count">{{ fact.source_checks.length }}</span></h4>
          <p class="muted small">An AI read the source and said what it states. This is evidence: only a person accepts a citation.</p>
          <article v-for="c in fact.source_checks" :key="c.id" class="review" :class="{old: !c.current}">
            <div class="row-gap"><span class="tag" :class="sourceChecks[c.verdict][1]">{{ sourceChecks[c.verdict][0] }}</span><ai-meta :model="c.ai_model" :user="c.ai_user_name" :ms="c.ai_generation_ms"/>
              <span v-if="!c.independent" class="tag amber" title="The model that wrote this fact: recorded, but not counted">same model as author</span><span v-if="!c.current" class="tag">earlier revision</span>
              <span class="grow"></span><span class="muted small">{{ timeAgo(c.created_at) }}</span></div>
            <rich-content v-if="c.body_html" :html="c.body_html"/>
          </article>
        </section>
        <section v-if="!shownRevision && !fact.retracted_at && (proofs.length || oldProofs.length || cited || mainFlawed || fact.status === 'proof_disputed')" class="fact-sec other-proofs" id="other-proofs">
          <h4>{{ cited ? 'Proofs' : 'Other proofs' }}<span v-if="proofs.length" class="count">{{ proofs.length }}</span><span class="grow"></span><button class="btn sm" @click="proposing = {proof: null}"><icon name="plus" :size="13"/> {{ cited ? 'Propose a proof' : 'Propose another proof' }}</button></h4>
          <p v-if="!proofs.length && cited" class="muted small">With a proof here, this result no longer rests on its source: it becomes a proved fact, checked like the others.</p>
          <p v-else-if="!proofs.length" class="muted small">{{ mainFlawed || fact.status === 'proof_disputed' ? 'The proof above is disputed. A correct proof here is enough for the fact to count as checked.' : 'A different argument can be proposed here, by a person or an AI client, and reviewed on its own.' }}</p>
          <article v-for="p in proofs" :key="p.id" class="alt-proof" :class="{flash: +query?.proof === p.id}" :data-proof="p.id">
            <header class="row-gap"><span class="tag" :class="proofStates[p.state].cls">{{ proofStates[p.state].label }}</span><span v-if="repairedProofs.has(p.id)" class="tag" title="Written by an AI to answer a review that found a flaw: see Repair of the proof">Repair</span>
              <by-line :name="p.author_name" :model="p.author_kind === 'agent' ? p.ai_model : null" :user="p.ai_user_name" :ms="p.ai_generation_ms"/>
              <span class="grow"></span><span class="muted small">{{ timeAgo(p.updated_at) }}</span>
              <template v-if="p.author_id === me && p.author_kind === 'human'"><button class="icon-btn xs" title="Edit your proof" aria-label="Edit your proof" @click="proposing = {proof: p}"><icon name="edit" :size="13"/></button></template>
              <button v-if="p.author_id === me || isOwner" class="icon-btn xs" title="Withdraw this proof" aria-label="Withdraw this proof" @click="removeProof(p)"><icon name="trash" :size="13"/></button></header>
            <rich-content :html="shown(p.body_html)" :notation="notationMarks" :fact-refs="fact.text_refs"/>
            <footer class="alt-proof-foot">
              <span class="muted small">{{ tallyText(p) }}</span><span class="grow"></span>
              <template v-if="!(p.author_id === me && p.author_kind === 'human')">
                <button class="btn sm endorse" :class="{on: myProofVerdict(p) === 'correct'}" :aria-pressed="myProofVerdict(p) === 'correct'" :title="explain('proof.correct')" @click="checkProof(p, 'correct')"><icon name="check" :size="13"/> Correct</button>
                <button class="btn sm" :class="{on: myProofVerdict(p) === 'gap'}" :aria-pressed="myProofVerdict(p) === 'gap'" :title="explain('proof.gap')" @click="checkProof(p, 'gap')">Gap</button>
                <button class="btn sm deny" :class="{on: myProofVerdict(p) === 'incorrect'}" :aria-pressed="myProofVerdict(p) === 'incorrect'" :title="explain('proof.error')" @click="checkProof(p, 'incorrect')">Error</button>
              </template>
            </footer>
            <div v-for="v in p.reviews.filter((x) => x.body_html)" :key="v.id" class="alt-proof-review"><span class="tag" :class="verdicts[v.verdict].cls">{{ verdicts[v.verdict].label }}</span> <b :title="v.reviewer_kind !== 'human' && v.ai_model ? 'An AI client of ' + v.reviewer_name : null">{{ v.reviewer_kind !== 'human' && v.ai_model ? v.ai_model : v.reviewer_name }}</b><rich-content :html="v.body_html"/></div>
          </article>
          <details v-if="oldProofs.length" class="old-proofs"><summary>{{ oldProofs.length }} proof{{ oldProofs.length > 1 ? 's' : '' }} of an earlier statement</summary>
            <article v-for="p in oldProofs" :key="p.id" class="alt-proof old"><header class="row-gap"><span class="tag">r{{ p.revision_no }}</span><by-line :name="p.author_name" :model="p.author_kind === 'agent' ? p.ai_model : null" :user="p.ai_user_name" :ms="p.ai_generation_ms"/></header><rich-content :html="shown(p.body_html)"/></article></details>
        </section>
        <section class="fact-sec" v-if="content.intuition_html"><h4>Intuition</h4><rich-content :html="shown(content.intuition_html)" :notation="notationMarks" :fact-refs="fact.text_refs"/></section>
        <template v-if="!shownRevision">
          <section class="fact-sec" v-if="fact.sources.length"><h4>Sources</h4>
            <div v-for="(x, i) in fact.sources" :key="i" class="fact-source">
              <a v-if="x.link" :href="link(x.link.view, x.link.id, x.link.query)"><icon :name="sourceIcon(x.type)" :size="13"/> {{ x.label }}<template v-if="x.page">, p. {{ x.page }}</template></a>
              <span v-else class="muted"><icon name="mail" :size="13"/> {{ x.label }}</span>
              <span v-if="x.comment_role" class="tag comment-role" :class="'r-' + x.comment_role">{{ {supports: 'Supports this result', disputes: 'Disputes this result', clarifies: 'Clarifies this result'}[x.comment_role] }}</span>
              <span v-else class="tag">{{ covers[x.covers] }}</span>
              <span class="tag" :class="x.is_human ? 'green' : ''">{{ x.is_human ? 'human' : 'AI' }}</span>
              <span v-if="x.author" class="small muted">{{ x.author.name }}</span>
              <blockquote v-if="x.quote">{{ x.quote }}</blockquote>
            </div></section>
          <section class="fact-sec" v-if="localNotation.length || projectSymbols.length"><h4>Notation in this fact</h4>
            <dl v-if="localNotation.length" class="fact-glossary"><template v-for="g in localNotation" :key="g[0]"><dt><math-text :text="asMath(g[0])"/></dt><dd><math-text :text="g[1]"/></dd></template></dl>
            <p v-if="projectSymbols.length" class="fact-project-symbols"><span class="muted small">Project symbols:</span> <a v-for="s in projectSymbols" :key="s" class="notation-use" :href="link('facts', null, {mode: 'notation'})"><math-text :text="asMath(s)"/></a></p></section>
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

      <div v-if="tab==='reviews'" class="pad">
        <div v-if="canWriteReview" class="card review-form">
          <h4>{{ myReview ? 'Update your review' : 'Review revision ' + fact.current_revision }}</h4>
          <div class="field"><span>{{ cited ? 'The citation' : 'The proof' }}</span><div class="seg" role="group" :aria-label="cited ? 'The citation' : 'The proof'"><button v-for="(v, k) in verdicts" :key="k" :class="{on: reviewVerdict === k}" :aria-pressed="reviewVerdict === k" @click="reviewVerdict = k">{{ cited ? citedVerdicts[k] : v.label }}</button></div></div>
          <div v-if="reviewVerdict !== 'correct'" class="field"><span>The result itself</span><div class="seg" role="group" aria-label="The result itself"><button v-for="(l, k) in {true: 'Is true', unsure: 'Not sure', false: 'Is false'}" :key="k" :class="{on: reviewStatement === k}" :aria-pressed="reviewStatement === k" :disabled="k === 'false' && reviewVerdict === 'gap'" @click="reviewStatement = k">{{ l }}</button></div></div>
          <rich-editor ref="reviewEd" compact :key="fact.id + '-' + fact.current_revision" :initial-html="myReview?.body_html || ''" :placeholder="reviewVerdict === 'correct' ? 'What did you check? (optional)' : 'Point to the exact step…'"/>
          <div class="row-end"><button class="btn primary sm" :title="explain('review.submit')" @click="submitReview">Submit review</button></div>
        </div>
        
        <div v-if="!currentReviews.length" class="empty">No review of this revision yet.</div>
        <article v-for="v in currentReviews" :key="v.id" class="review">
          <div class="row-gap"><span class="tag" :class="stance(v).cls">{{ stance(v).label }}</span>
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

      <div v-if="tab==='lean'" class="pad">
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

      <div v-if="tab==='deps'" class="pad">
        <h4>Depends on <span class="count">{{ fact.deps.length }}</span></h4>
        <div v-if="!fact.deps.length" class="muted small pad-b">No dependencies.</div>
        <a v-for="d in fact.deps" :key="d.id" class="row-link" :href="factLink(d.id)" :title="d.label"><fact-badges :f="d" :only="['status']"/><span class="ellipsis"><math-text :text="d.title"/></span></a>
        <h4 class="mt">Used by <span class="count">{{ fact.dependents.length }}</span></h4>
        <div v-if="!fact.dependents.length" class="muted small pad-b">Nothing depends on this fact yet.</div>
        <a v-for="d in fact.dependents" :key="d.id" class="row-link" :href="factLink(d.id)" :title="d.label"><fact-badges :f="d" :only="['status']"/><span class="ellipsis"><math-text :text="d.title"/></span></a>
        <h4 class="mt">Mentioned in</h4>
        <div v-if="!backlinks.length" class="muted small">No mention yet.</div>
        <a v-for="(b, i) in backlinks" :key="i" class="backlink" :href="link(b.link.view, b.link.id, b.link.query)">
          <icon :name="b.kind === 'message' ? 'mail' : b.kind === 'question' ? 'target' : 'comment'" :size="14"/> {{ b.label }} <span class="muted small">{{ timeAgo(b.at) }}</span></a>
      </div>

      <div v-if="tab==='trace'" class="pad">
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
          <section class="trace-sec"><h4>Rests on <span class="count">{{ trace.rests_on.length }} cited result{{ trace.rests_on.length === 1 ? '' : 's' }}</span></h4>
            <div v-if="trace.incomplete.length" class="fact-alert amber small">Not complete: {{ trace.incomplete.map((x) => x.label).join(', ') }} still use{{ trace.incomplete.length === 1 ? 's' : '' }} a result of another work directly.</div>
            <div v-if="!trace.rests_on.length" class="muted small">{{ fact.basis === 'cited' ? 'It is itself a cited result.' : 'No cited result: everything it builds on is proved in the database.' }}</div>
            <template v-else><div class="trace-summary small"><b>{{ trace.rests_on_accepted }}</b> of {{ trace.rests_on.length }} accepted by a member who read the source.</div>
              <a v-for="c in trace.rests_on" :key="c.id" class="trace-anc" :href="factLink(c.id)" :title="c.label"><fact-badges :f="c" :only="['status']"/><span class="small ellipsis"><math-text :text="c.title"/></span></a></template>
          </section>
          <section class="trace-sec"><h4>People credited for human proofs <span class="count">including what it builds on</span></h4>
            <div v-if="!trace.human_proof_credits.length" class="muted small">No human proof is recorded in this fact or its dependencies.</div>
            <div v-for="p in trace.human_proof_credits" :key="p.name + p.basis" class="trace-row small"><b>{{ p.name }}</b> <span class="muted">({{ basis[p.basis] }}) · {{ p.facts.length }} fact{{ p.facts.length > 1 ? 's' : '' }}</span>
              <a v-if="p.orcid" :href="'https://orcid.org/' + p.orcid" target="_blank" rel="noopener" class="orcid-link"> {{ p.orcid }}</a></div>
          </section>
          <section class="trace-sec"><h4>Built on <span class="count">{{ trace.ancestor_count }} fact{{ trace.ancestor_count === 1 ? '' : 's' }}</span></h4>
            <div v-if="trace.ancestor_count" class="trace-summary"><template v-for="(n, k) in trace.ancestor_proof_origins" :key="k"><span v-if="n"><proof-tag :origin="k"/> {{ n }}</span></template></div>
            <a v-for="a in trace.ancestors" :key="a.id" class="trace-anc" :style="{paddingLeft: (a.depth - 1) * 12 + 6 + 'px'}" :href="factLink(a.id)">
              <fact-badges :f="{ status: a.status, proof_origin: a.proof_origin, basis: a.basis }" :only="['status', 'proof']"/>
              <span class="small ellipsis" :title="a.label"><math-text :text="a.title || a.label"/> <span class="muted">{{ creditText(a) }}</span></span></a>
            <div v-if="trace.ancestor_count > trace.ancestors.length" class="muted small">Showing the {{ trace.ancestors.length }} closest facts.</div>
          </section>
        </template>
        <h4 class="mt">Revisions and changes</h4>
        <div class="timeline">
        <template v-for="x in timeline" :key="x.key">
        <div v-if="x.change" class="tl-item tl-change" :class="{undone: x.change.status === 'undone'}">
          <div class="tl-dot"></div><div class="tl-body">
            <div class="tl-head"><b>{{ historyText(x.change, fact.id) }}</b><span v-if="x.change.status === 'undone'" class="tag">undone</span><span class="grow"></span><span class="muted small">{{ fullDate(x.change.decided_at) }}</span></div>
            <div class="small"><template v-if="x.change.auto_applied"><span class="tag">Applied by the AI</span> <ai-meta compact :model="x.change.ai_model"/><span v-if="x.change.confidence" class="muted"> · {{ confidenceLabels[x.change.confidence] }}</span></template>
              <template v-else>Accepted by <b>{{ x.change.decided_by_name }}</b>, proposed by <ai-meta compact :model="x.change.ai_model"/></template>
              <template v-if="x.change.status === 'undone'"> · undone by {{ x.change.undone_by_name }}, {{ timeAgo(x.change.undone_at) }}</template></div>
            <div class="tl-notes"><math-text :text="x.change.reason_text"/></div>
            <div v-if="x.change.can_undo && (x.change.auto_applied || isOwner || !['same', 'question'].includes(x.change.kind))" class="tl-actions"><button class="btn xs" :title="explain(x.change.kind === 'same' ? 'cons.undo.same' : 'fact.undoChange')" @click="undoChange(x.change)"><icon name="restore" :size="13"/> {{ undoLabel(x.change) }}</button></div>
          </div></div>
        <div v-else class="tl-item" :class="{current: x.rev.revision_no === fact.current_revision}"><template v-for="r in [x.rev]" :key="r.id">
          <div class="tl-dot"></div><div class="tl-body">
            <div class="tl-head"><b>Revision {{ r.revision_no }}</b><span v-if="r.revision_no === fact.current_revision" class="tag green">current</span>
              <proof-tag :origin="r.proof_origin"/><span class="grow"></span><span class="muted small">{{ fullDate(r.created_at) }}</span></div>
            <by-line :name="r.author_name" :model="r.ai_model" :user="r.ai_user_name" :ms="r.ai_generation_ms"/>
            <div v-if="r.notes" class="tl-notes">{{ r.notes }}</div>
            <div class="tl-actions"><button class="btn xs" @click="revView = r.revision_no === fact.current_revision ? null : r.revision_no; tab = 'content'"><icon name="eye" :size="13"/> View</button></div>
          </div></template></div>
        </template>
      </div>
     </div>
    </template>
    <div v-else-if="factError" class="placeholder">{{ factError }}</div>
    <section-home v-else kind="facts"/>
  </section>

  <section v-if="mode !== 'notation' && (mode === 'list' || fact)" class="col col-comments">
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
      <p class="muted small">Retracting withdraws the fact for every member, not only for you: to say that you think it is false, use <b>Deny</b>. Reinstate undoes it.</p>
      <p class="warn-box" v-if="fact.dependents.length">Everything that depends on this fact will be flagged. The authors of those facts are notified.</p>
      <label class="field"><span>Reason</span><textarea v-model="retracting.reason" rows="4" required placeholder="What is wrong?"></textarea></label>
      <div class="row-end"><button type="button" class="btn ghost" @click="retracting = null">Cancel</button><button class="btn warn">Retract</button></div>
    </form>
  </modal>
</div>`,
  created() { this.graphViews = GRAPH_VIEWS; this.proofStates = PROOF_STATE; this.basis = BASIS; this.covers = COVERS; this.statuses = STATUS; this.verdicts = VERDICTS; this.leanLabels = LEAN; this.chainLabels = CHAIN; this.chainShort = { broken: 'Rests on a disputed fact', unproved: 'Rests on a disputed proof', unchecked: 'Rests on unchecked facts', incomplete: 'Rests on an outside result' }; this.sourceChecks = SOURCE_CHECK; this.confidenceLabels = CONFIDENCE; this.citedVerdicts = { correct: 'Source states it', gap: 'Not as written', incorrect: 'Result is false' }; },
  methods: {
    factTitle, texLine, kindOf, kindLabel, stance, asMath, checkedByAi,
    jumpProof(id) { this.$el.querySelector?.(`[data-proof="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
    async askRepair() {
      const f = await attempt(() => api.post(`api/facts/${this.fact.id}/repair`, {}), 'Repair queued: an AI of another company will answer the review');
      if (f) await this.refresh(f);
    },
    setNotation(on) { this.projectNotation = on; this.refreshOutline(); try { localStorage.setItem('oq-fact-notation', on ? 'project' : 'source'); } catch { /* the choice lasts for this page only */ } },
    async checkRephrasing(verdict, note = '') {
      const f = await attempt(() => api.post(`api/fact-rephrasings/${this.currentRephrasing.id}/check`, { verdict, note }), verdict ? 'Thank you' : 'Undone');
      if (f) { this.unfaithful = null; await this.refresh(f); }
    },
    shown(html) { return this.readable ? formatFactHtml(html) : html; },
    setReadable(on) { this.readable = on; this.refreshOutline(); try { localStorage.setItem('oq-fact-view', on ? 'readable' : 'original'); } catch { /* the choice lasts for this page only */ } },
    timeAgo, fullDate, link, markItemUnread, quietLabels, statementAddsToTitle,
    /** A fact's key is there to cite it: copied, with what it is for. */
    async cite() {
      try { await navigator.clipboard.writeText(this.fact.label); toast(`Copied ${this.fact.label}: paste it to cite this fact`, 'success'); } catch { toast(`Its key is ${this.fact.label}`, 'info'); }
    },
    unreadOf(id) { return unreadCount('fact', id); },
    onActivity() { this.loadList(); if (!this.checkForm && !this.retracting) this.loadFact(); },
    sourceIcon(t) { return { document: 'files', bib: 'book', message: 'mail', comment: 'comment' }[t] || 'link'; },
    factLink(id) { return link('facts', id, this.mode === 'graph' ? { mode: 'graph' } : null); },
    setMode(m) { go(`/p/${this.pid}/facts` + (this.id && !['notation', 'consolidate'].includes(m) ? `/${this.id}` : '') + (m === 'list' ? '' : `?mode=${m}`)); },
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
      try {
        // A compact list, fetched again only when it changed: large databases stay light to poll.
        const r = await getIfChanged(`api/projects/${this.pid}/facts?compact=1`, this.listTag);
        if (r.changed) { this.facts = expandFacts(r.data); this.edges = r.data.edges; this.listTag = r.etag; }
        this.loaded = true;
      } catch (e) { /* polling */ }
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
      this.reviewStatement = mine?.statement_verdict || (mine?.verdict === 'incorrect' ? 'false' : 'unsure');
      markRead('fact', f.id, f.last_activity_id);
      if (this.query?.proof) { this.tab = 'content'; this.$nextTick(() => this.$el.querySelector?.(`[data-proof="${+this.query.proof}"]`)?.scrollIntoView({ block: 'center' })); }
      if (this.tab === 'trace') this.loadTrace();
    },
    clearFilters() { this.fStatus = this.fOrigin = this.fLabel = this.fLean = this.fStar = this.fTopic = this.fBasis = this.fVerify = 'all'; },
    async saveTopics() {
      const topics = parseTopics(this.topicDraft);
      const r = await attempt(() => api.post(`api/facts/${this.fact.id}/topics`, { topics }), 'Tags saved');
      if (!r) return;
      this.fact = { ...this.fact, topics: r.topics };
      this.topicDraft = null;
      const row = this.facts.find((f) => f.id === this.fact.id);
      if (row) row.topics = r.topics;
    },
    async toggleStar(f) {
      const on = !f.starred;
      const r = await attempt(() => (on ? api.post(`api/facts/${f.id}/star`, {}) : api.del(`api/facts/${f.id}/star`)));
      if (!r) return;
      for (const x of [this.facts.find((y) => y.id === f.id), this.fact?.id === f.id ? this.fact : null]) if (x) { x.starred = r.starred; x.stars = r.stars; }
      if (this.fact?.id === f.id) this.loadFact();
    },
    refreshOutline() {
      this.$nextTick(() => {
        const nodes = [...(this.$el.querySelectorAll?.('.fact-body [data-env]') || [])];
        this.outline = nodes.map((node) => ({ node, type: node.dataset.env, title: node.dataset.title }));
      });
    },
    jump(item) {
      let box = item.node.parentElement;
      while (box && !(box.scrollHeight > box.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (!box) return;
      const bar = this.$el.querySelector('.fact-outline')?.offsetHeight || 0;
      box.scrollTo({ top: box.scrollTop + item.node.getBoundingClientRect().top - box.getBoundingClientRect().top - bar - 20 });
    },
    pretty(l) { return l.replaceAll('_', ' '); },
    creditText(a) { return [...new Set(a.credits.map((c) => c.name))].join('; ') || (a.ai_model ? `entered by ${a.ai_model}` : ''); },
    // A tab of the fact, its top just under the bar: the header above it may have scrolled away.
    openTab(t) {
      this.tab = t;
      if (t === 'trace') this.loadTrace();
      const box = this.$refs.factScroll; const head = box?.querySelector('.fact-head');
      if (box && head && box.scrollTop > head.offsetHeight) box.scrollTop = head.offsetHeight;
    },
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
    historyText, undoLabel,
    async undoChange(h) {
      if (h.kind === 'same' && !confirm(`Unmerge ${h.other_label}? It comes back as its own fact, with its sources, dependencies, proof and stars.`)) return;
      const r = await attempt(() => api.post(`api/fact-suggestions/${h.id}/undo`, {}), h.kind === 'same' ? 'Unmerged' : 'Undone');
      if (r) { await this.loadFact(); await this.loadList(); }
    },
    async linkRef(r, notUsed = false) {
      const body = notUsed ? { ref: r.key, not_used: true } : { ref: r.key, fact_id: this.refPick[r.key] };
      await this.refresh(await attempt(() => api.post(`api/facts/${this.fact.id}/refs`, body), notUsed ? 'Marked as background' : 'Linked'));
    },
    async clearRef(r) { await this.refresh(await attempt(() => api.post(`api/facts/${this.fact.id}/refs`, { ref: r.key, clear: true }), 'Undone')); },
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
      const f = await attempt(() => api.post(`api/facts/${this.fact.id}/reviews`, { verdict: 'incorrect', statement: 'false', body_text: this.denying.reason }), 'Fact denied');
      if (f) { this.denying = null; await this.refresh(f); }
    },
    async submitReview() {
      const body_html = this.$refs.reviewEd?.getHTML() || '';
      const statement = this.reviewVerdict === 'correct' ? 'true' : (this.reviewVerdict === 'gap' && this.reviewStatement === 'false' ? 'unsure' : this.reviewStatement);
      await this.refresh(await attempt(() => api.post(`api/facts/${this.fact.id}/reviews`, { verdict: this.reviewVerdict, statement, body_html }), 'Review saved'));
    },
    async toggleResultOnly() {
      if (!this.resultOnlyOn) { this.resultOnly = { verdict: 'gap', reason: '' }; return; }
      await this.refresh(await attempt(() => api.del(`api/facts/${this.fact.id}/reviews/${this.myReview.id}`), 'Withdrawn'));
    },
    async submitResultOnly() {
      const f = await attempt(() => api.post(`api/facts/${this.fact.id}/reviews`, resultOnlyBody(this.resultOnly.verdict, this.resultOnly.reason)), 'Result accepted, proof disputed');
      if (f) { this.resultOnly = null; await this.refresh(f); }
    },
    myProofVerdict(p) { return p.reviews.find((v) => v.reviewer_id === this.me && v.reviewer_kind === 'human')?.verdict || null; },
    tallyText(p) {
      const t = proofTally(p);
      const parts = [[t.correct, 'correct'], [t.gap, 'gap'], [t.incorrect, 'error']].filter(([n]) => n).map(([n, w]) => `${n} ${w}${n > 1 && w !== 'correct' ? 's' : ''}`);
      return parts.length ? parts.join(' · ') : 'No review yet';
    },
    async submitProof() {
      const body_html = this.$refs.proofEd?.getHTML() || '';
      if (!body_html) return toast('Write the proof first', 'error');
      const p = this.proposing.proof;
      const f = await attempt(() => (p ? api.patch(`api/fact-proofs/${p.id}`, { body_html }) : api.post(`api/facts/${this.fact.id}/proofs`, { body_html })), p ? 'Proof saved. Its earlier reviews were cleared.' : 'Proof proposed');
      if (f) { this.proposing = null; await this.refresh(f); }
    },
    async removeProof(p) {
      if (!confirm('Withdraw this proof and its reviews?')) return;
      await this.refresh(await attempt(() => api.del(`api/fact-proofs/${p.id}`), 'Proof withdrawn'));
    },
    async checkProof(p, verdict) {
      const mine = p.reviews.find((v) => v.reviewer_id === this.me && v.reviewer_kind === 'human');
      if (mine?.verdict === verdict) { await this.refresh(await attempt(() => api.del(`api/fact-proofs/${p.id}/reviews/${mine.id}`), 'Review withdrawn')); return; }
      if (verdict === 'correct') { await this.refresh(await attempt(() => api.post(`api/fact-proofs/${p.id}/reviews`, { verdict }), 'Proof accepted')); return; }
      this.proofCheck = { proof: p, verdict, reason: '' };
    },
    async submitProofCheck() {
      const f = await attempt(() => api.post(`api/fact-proofs/${this.proofCheck.proof.id}/reviews`, { verdict: this.proofCheck.verdict, body_text: this.proofCheck.reason }), 'Review saved');
      if (f) { this.proofCheck = null; await this.refresh(f); }
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
