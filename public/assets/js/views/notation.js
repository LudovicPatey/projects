import { api, expandFacts } from '../api.js';
import { link, attempt, toast } from '../store.js';
import { timeAgo } from '../util.js';
import { Kpi, StackBar } from '../dashboard.js';
import { clipMath } from '../fact-format.js';
import { NOTATION_SEGMENTS, actionEffects, asMath, entryBody, entryError, entryScope, paramsText, sharedDraft, sharedState, wordingGroups, splitVariants, toRewrite } from '../notation-model.js';
import { colorParams, inferParams, paramGroups, trustParams } from '../notation-params.js';

/** A symbol with its parameters in color: pointing at one says what type of object it stands for. */
const NotationSymbol = {
  props: { symbol: String, params: Array },
  template: `<span class="nt-sym" ref="el"></span>`,
  mounted() { this.paint(); },
  beforeUnmount() { clearTimeout(this.retry); },
  watch: { symbol() { this.paint(); }, params() { this.paint(); } },
  methods: {
    paint() {
      const el = this.$refs.el;
      if (!el) return;
      const params = this.params || [];
      const text = params.length ? `$${colorParams(this.symbol, params)}$` : asMath(this.symbol);
      el.textContent = text;
      if (!window.renderMathInElement) { this.retry = setTimeout(() => this.paint(), 400); return; } // KaTeX is loaded with defer
      window.renderMathInElement(el, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false, trust: trustParams });
      if (params.length && el.querySelector('.katex-error')) {
        // Colors that KaTeX cannot place: the symbol as written, uncolored, rather than its source in red.
        el.textContent = asMath(this.symbol);
        window.renderMathInElement(el, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false });
        return;
      }
      el.querySelectorAll('.oq-pm').forEach((n) => {
        const i = [...n.classList].map((c) => c.match(/^oq-pm-(\d+)$/)).find(Boolean);
        const q = i && params[+i[1]];
        if (q) n.title = `${q.name.replace(/\\math[a-z]+\{(\w)\}/, '$1')}: ${q.type || 'type not stated'}`;
      });
    },
  },
};

const entryEditor = `<div class="notation-edit">
  <label class="field"><span>Symbol (LaTeX)</span><input v-model="editing.symbol"></label>
  <label class="field"><span>Meaning</span><textarea v-model="editing.meaning" rows="3"></textarea></label>
  <label v-if="editing.params || inferParams(editing.symbol).length" class="field"><span>Parameters and their types</span><textarea v-model="editing.params" rows="2" placeholder="X, Y: infinite block sequences"></textarea></label>
  <p v-if="editing.params !== undefined && inferParams(editing.symbol).length" class="muted small">One line per type. The entry then applies to these objects only: the same symbol between other objects keeps its own meaning. A letter that is part of the name, such as the W of Weihrauch reducibility, gets the type "not a parameter".</p>
  <label class="field"><span>How sources differ</span><textarea v-model="editing.note" rows="2"></textarea></label>
  <p v-if="editing.agreed" class="muted small">Changing the symbol, its meaning or the types makes it a proposal again.</p>
  <div class="row-end"><button class="btn ghost sm" @click="editing = null">Cancel</button><button class="btn primary sm" @click="save">Save</button></div></div>`;

const entryView = (by, actions) => `<div class="notation-symbol"><notation-symbol :symbol="e.symbol" :params="e.params"/></div>
  <div class="notation-body"><rich-content :html="e.meaning_html"/>
    <div v-if="e.params?.length" class="notation-scope" :class="{untyped: !scopeOf(e).typed}"><span class="scope-label">Applies to</span>
      <span v-for="g in paramGroups(e.params)" :key="g.type" class="pm-group"><template v-for="(p, j) in g.params" :key="p.name"><span class="pm-name" :class="'pm-' + (p.i % 4)"><math-text :text="'$' + p.name + '$'"/></span>{{ j < g.params.length - 1 ? ', ' : '' }}</template>: <math-text v-if="g.type" :text="g.type"/><span v-else class="pm-missing">type not stated yet</span></span>
      <small v-if="!scopeOf(e).typed" class="scope-hint">{{ typesHint(e) }} Until then, the meaning says what the entry applies to.</small>
      <small v-else class="scope-hint">The same symbol between other objects keeps its own meaning.</small></div>
    <ai-pending :items="e.ai_pending"/>
    <p v-if="e.note_text" class="notation-note"><icon name="lightbulb" :size="13"/> <math-text :text="e.note_text"/></p>
    <template v-for="g in [['instances', 'In particular settings'], ['clashes', 'Other meanings in sources']]" :key="g[0]"><div v-if="splitVariants(e.variants)[g[0]].length" class="notation-variants-group" :class="'g-' + g[0]"><small>{{ g[1] }}</small>
      <ul class="notation-variants"><li v-for="(v, i) in splitVariants(e.variants)[g[0]]" :key="i"><math-text :text="asMath(v.symbol)"/> <span><math-text :text="v.meaning"/></span><small v-if="v.where">{{ v.where }}</small></li></ul></div></template>
    <small v-if="e.facts?.length" class="muted">Defined locally in {{ e.facts.length }} fact{{ e.facts.length > 1 ? 's' : '' }}: <template v-for="(id, i) in e.facts.slice(0, 6)" :key="id"><a :href="link('facts', id)">{{ labels.get(id) || '#' + id }}</a>{{ i < Math.min(e.facts.length, 6) - 1 ? ', ' : '' }}</template><template v-if="e.facts.length > 6">…</template></small>
    <small class="muted">${by}<template v-if="e.definition_label"> · defined in <a :href="link('facts', e.definition_fact_id)">{{ e.definition_label }}</a></template></small>
  <details v-if="actionEffects(e).length" class="notation-effects"><summary>What each choice changes</summary>
    <dl><template v-for="r in actionEffects(e)" :key="r.action"><dt>{{ r.action }}</dt><dd><span class="eff-changes"><math-text :text="r.changes"/></span> <span class="eff-keeps"><b>Unchanged:</b> <math-text :text="r.keeps"/></span></dd></template></dl></details></div>
  <div class="notation-actions"><button class="btn sm" :class="{on: talk === e.id}" :aria-pressed="talk === e.id" :title="e.comment_count ? e.comment_count + ' comment(s)' : 'Discuss this entry'" @click="openTalk(e)"><icon name="comment" :size="13"/> {{ e.comment_count ? e.comment_count : 'Discuss' }}<b v-if="e.open_threads" class="seg-n" title="Open threads">{{ e.open_threads }}</b></button>${actions}</div>`;

/** The project's notation, inside Facts: agreed meanings, proposals, and how far facts follow them. */
export const NotationPanel = {
  components: { Kpi, StackBar, NotationSymbol },
  props: { pid: Number, focus: Number, comment: Number },
  emits: ['mode'],
  data() { return { d: null, facts: [], draft: { symbol: '', meaning: '', note: '', fact: '', params: '' }, editing: null, busy: false, talk: this.comment ? this.focus : null }; },
  computed: {
    agreed() { return (this.d?.entries || []).filter((e) => e.status === 'agreed'); },
    proposed() { return (this.d?.entries || []).filter((e) => e.status === 'proposed'); },
    rejected() { return (this.d?.entries || []).filter((e) => e.status === 'rejected'); },
    local() { return (this.d?.entries || []).filter((e) => e.status === 'local'); },
    remaining() { return toRewrite(this.d?.progress); },
    talkEntry() { return (this.d?.entries || []).find((e) => e.id === this.talk) || null; },
    error() { return entryError(this.draft); },
    definitions() { return this.facts.filter((f) => !f.retracted_at); },
    labels() { return new Map(this.facts.map((f) => [f.id, f.label])); },
    candidates() { return (this.d?.shared || []).filter((s) => !s.entry); },
  },
  created() { this.segments = NOTATION_SEGMENTS; },
  async mounted() {
    await this.load();
    this.facts = expandFacts(await attempt(() => api.get(`api/projects/${this.pid}/facts?compact=1`)));
    this.timer = setInterval(() => { if (!document.hidden && !this.editing) this.load(); }, 20000);
  },
  unmounted() { clearInterval(this.timer); },
  methods: {
    /** A figure opens its section: it scrolls there. Nothing to show: not a link. */
    jumpTo(section) {
      if (!section) return {};
      return { role: 'button', tabindex: 0, class: 'kpi-link', title: 'Show them',
        onClick: () => document.querySelector(`[data-nt="${section}"]`)?.scrollIntoView({ block: 'start' }),
        onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } };
    },
    clipMath,
    timeAgo, link, asMath, splitVariants, sharedState, wordingGroups, actionEffects, paramGroups, inferParams,
    scopeOf(e) { return entryScope(e); },
    /** Who gives the missing types: the notation review queued for it, the sweep that settles a proposal, or the members. */
    typesHint(e) {
      if (e.ai_pending?.length) return '';
      if (e.status === 'proposed') return 'The notation sweep gives them when it settles this proposal, or say them with Edit.';
      return 'A notation review read it without typing them: say them with Edit.';
    },
    /** A button's tooltip: what it changes, and what it leaves as it is. */
    effect(e, action) { const r = actionEffects(e).find((x) => x.action === action); return r ? `${r.changes} Unchanged: ${r.keeps}`.replace(/\$/g, '') : ''; },
    async load() {
      const r = await attempt(() => api.get(`api/projects/${this.pid}/notation`));
      if (!r) return;
      this.d = r;
      if (this.focus) this.$nextTick(() => this.$el.querySelector?.(`[data-notation="${this.focus}"]`)?.scrollIntoView({ block: 'center' }));
    },
    async propose() {
      if (this.error || this.busy) return;
      this.busy = true;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/notation`, entryBody(this.draft)), 'Entry proposed');
      this.busy = false;
      if (r) { this.draft = { symbol: '', meaning: '', note: '', fact: '', params: '' }; await this.load(); }
    },
    edit(e) { this.editing = { id: e.id, symbol: e.symbol, meaning: e.meaning_text, note: e.note_text, fact: e.definition_fact_id || '', params: paramsText(e.params || [], e.fixed || []), agreed: e.status === 'agreed' }; },
    async save() {
      const problem = entryError(this.editing);
      if (problem) return toast(problem, 'error');
      const r = await attempt(() => api.patch(`api/notation/${this.editing.id}`, entryBody(this.editing)), 'Entry saved');
      if (r) { this.editing = null; await this.load(); }
    },
    async decide(e, status) {
      if (status === 'agreed' && e.decided_by_kind !== 'consolidation' && !confirm(`Agree that ${e.symbol} has this meaning in the project? ${entryScope(e).text.replace(/\$/g, '')} Facts show and are rewritten in this notation; their reviewed text stays as it is.`)) return;
      if (await attempt(() => api.post(`api/notation/${e.id}/status`, { status }), { agreed: 'Agreed', rejected: 'Rejected', proposed: 'Reopened', local: 'Kept local: rewrites unfold it or define it in the fact' }[status])) await this.load();
    },
    openTalk(e) {
      this.talk = this.talk === e.id ? null : e.id;
      if (this.talk) this.$nextTick(() => this.$el.querySelector?.('.notation-talk')?.scrollIntoView({ block: 'nearest' }));
    },
    fromShared(s) {
      this.draft = { ...sharedDraft(s), params: '' };
      this.$nextTick(() => { const box = this.$el.querySelector('#notation-propose'); box?.scrollIntoView({ block: 'center' }); });
    },
    fromDefinition(x) {
      this.draft = { symbol: '', meaning: x.statement_text, note: '', fact: x.id, params: '' };
      this.$nextTick(() => { const box = this.$el.querySelector('#notation-propose'); box?.scrollIntoView({ block: 'center' }); box?.querySelector('input')?.focus(); });
    },
    async remove(e) {
      if (!confirm('Delete this proposal?')) return;
      if (await attempt(() => api.del(`api/notation/${e.id}`), 'Deleted')) await this.load();
    },
    async rewriteAll() {
      if (!confirm(`Ask the AI clients to rewrite ${this.remaining} fact${this.remaining > 1 ? 's' : ''} in the agreed notation? The reviewed text of each fact does not change.`)) return;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/notation/rephrase-all`, {}));
      if (r) { toast(`${r.queued} added to the AI queue`, 'success'); await this.load(); }
    },
  },
  template: `<div class="page wide notation-page">
    <header class="page-title"><span class="sh-icon"><icon name="book" :size="22"/></span><div><h1>Project notation</h1><p>One meaning per symbol. Facts from papers with other conventions are rewritten in it, and their original text is kept.</p></div>
      <div class="seg small mode-seg"><button @click="$emit('mode', 'list')"><icon name="list" :size="13"/> List</button><button @click="$emit('mode', 'graph')"><icon name="graph" :size="13"/> Graph</button><button class="on" aria-pressed="true"><icon name="book" :size="13"/> Notation</button><button @click="$emit('mode', 'consolidate')"><icon name="layers" :size="13"/> Consolidate</button></div></header>
    <div v-if="!d" class="d-empty">Loading…</div>
    <template v-else>
      <div class="kpi-grid notation-kpis">
        <kpi icon="check-circle" :value="d.progress.agreed" label="agreed symbols" tone="good" v-bind="jumpTo('agreed')"/>
        <kpi icon="lightbulb" :value="d.progress.proposed" label="proposals to decide" :tone="d.progress.proposed ? 'warn' : 'neutral'" v-bind="jumpTo('proposed')"/>
        <kpi icon="graph" :value="(d.progress.current + d.progress.unchanged) + ' / ' + d.progress.facts" label="facts in project notation" tone="accent" v-bind="jumpTo('facts')"/>
        <kpi icon="clock" :value="d.progress.queued" label="being rewritten" tone="neutral" v-bind="jumpTo(d.progress.queued && 'facts')"/>
      </div>
      <div class="notation-grid">
        <div class="notation-main">
          <section class="panel" data-nt="facts">
            <header class="ai-head"><h2><icon name="graph" :size="15"/> Facts and the agreed notation</h2></header>
            <stack-bar :counts="d.progress" :segments="segments" label="Facts by notation"/>
            <p class="muted small">Rewriting never changes a fact's reviewed text. Each fact shows its version in the project's notation, and a person can confirm that it says the same.</p>
            <div class="row-gap"><button class="btn primary sm" :disabled="!agreed.length || !remaining" @click="rewriteAll"><icon name="sparkles" :size="14"/> Rewrite {{ remaining }} fact{{ remaining === 1 ? '' : 's' }}</button>
              <span v-if="!agreed.length" class="muted small">Agree on at least one symbol first.</span></div>
          </section>
          <section v-if="d.shared.length" class="panel" data-nt="shared">
            <header class="ai-head"><h2><icon name="layers" :size="15"/> Defined in several facts</h2><small>{{ candidates.length }} without a project entry</small></header>
            <p class="muted small">Each fact defines the symbols that are not project symbols, so that it reads alone. These symbols are defined in several facts. An AI settles them on its own, thirty at a time, once the project is quiet: it makes a symbol global, keeps it local to its paper, or records it as another spelling of an entry. Its choices appear among the agreed and local entries, and under Consolidate, where any member undoes them.</p>
            <article v-for="s in d.shared.slice(0, 30)" :key="s.symbol" class="notation-shared">
              <div class="notation-symbol"><math-text :text="asMath(s.symbol)"/></div>
              <div class="notation-body"><small v-if="s.spellings?.length > 1" class="muted">Written {{ s.spellings.length }} ways: <template v-for="(w, i) in s.spellings.slice(0, 5)" :key="w"><math-text :text="asMath(w)"/>{{ i < Math.min(s.spellings.length, 5) - 1 ? ', ' : '' }}</template></small><small class="muted">In {{ s.facts }} facts<template v-if="wordingGroups(s).summary"> · {{ wordingGroups(s).summary }}</template><template v-if="s.entry?.clashes"> · <b class="warn-text">{{ s.entry.clashes }} other meaning{{ s.entry.clashes > 1 ? 's' : '' }} in sources</b></template></small>
                <small v-if="sharedState(s)" class="shared-state" :class="'s-' + s.sweep"><icon :name="s.sweep === 'left' ? 'users' : 'sparkles'" :size="12"/> {{ sharedState(s) }}</small>
                <div v-for="b in wordingGroups(s).blocks" :key="b.key" class="wording-group" :class="[b.tone === null ? 'g-plain' : 'g-' + b.tone, {grouped: wordingGroups(s).grouped}]">
                  <div v-if="b.title" class="wording-head"><b>{{ b.title }}</b><template v-if="b.label">: <math-text :text="b.label"/></template>
                    <span v-if="b.entry" class="wording-entry">→ <a :href="link('facts', null, {mode: 'notation', notation: b.entry.id})"><math-text :text="asMath(b.entry.symbol)"/></a> <span class="pill t-neutral">{{ b.entry.word }}</span></span>
                    <span v-else-if="b.key !== 'unread'" class="muted small">· no project entry</span></div>
                  <ul class="notation-variants"><li v-for="(m, i) in b.items" :key="i"><math-text :text="m.meaning"/> <small><template v-for="(id, j) in m.facts.slice(0, 4)" :key="id"><a :href="link('facts', id)">{{ labels.get(id) || '#' + id }}</a>{{ j < Math.min(m.facts.length, 4) - 1 ? ', ' : '' }}</template><template v-if="m.facts.length > 4"> and {{ m.facts.length - 4 }} more</template></small></li></ul></div></div>
              <div class="notation-actions"><span v-if="s.entry" class="pill t-neutral" :title="s.entry.status === 'derived' ? 'An expression in agreed project symbols: it needs no entry of its own' : ''">{{ s.entry.status === 'derived' ? 'from project symbols' : s.entry.status }}</span><button v-else class="btn sm" @click="fromShared(s)">Propose as global</button></div>
            </article>
          </section>
          <section class="panel" data-nt="agreed">
            <header class="ai-head"><h2><icon name="check-circle" :size="15"/> Agreed</h2><small>{{ agreed.length }}</small></header>
            <div v-if="!agreed.length" class="d-empty">Nothing agreed yet. Agree on a proposal below.</div>
            <article v-for="e in agreed" :key="e.id" class="notation-entry" :data-notation="e.id" :class="{flash: focus === e.id}">
              <template v-if="editing?.id === e.id">${entryEditor}</template>
              <template v-else>${entryView('<template v-if="e.decided_by_kind === \'consolidation\'"><span class="pill t-neutral"><icon name="sparkles" :size="11"/> Adopted by the consolidation</span> {{ timeAgo(e.decided_at) }}</template><template v-else>Agreed by {{ e.decided_by_name }} {{ timeAgo(e.decided_at) }}</template>', '<button v-if="e.decided_by_kind === \'consolidation\'" class="btn sm endorse" :title="effect(e, \'Confirm\')" @click="decide(e, \'agreed\')"><icon name="check" :size="13"/> Confirm</button><button class="btn sm" :title="effect(e, \'Edit\')" @click="edit(e)">Edit</button><button class="btn sm" :title="effect(e, \'Reopen\')" @click="decide(e, \'proposed\')">Reopen</button>')}</template>
            </article>
          </section>
          <section class="panel" data-nt="proposed">
            <header class="ai-head"><h2><icon name="lightbulb" :size="15"/> Proposed</h2><small>Agree on one meaning per symbol</small></header>
            <div v-if="!proposed.length" class="d-empty">No proposal. Ask the AI to compare the facts' notations, or propose one yourself.</div>
            <article v-for="e in proposed" :key="e.id" class="notation-entry" :data-notation="e.id" :class="{flash: focus === e.id}">
              <template v-if="editing?.id === e.id">${entryEditor}</template>
              <template v-else>${entryView('Proposed by {{ e.author_name }}<template v-if="e.author_kind === \'agent\'"> · {{ e.ai_model }}</template> {{ timeAgo(e.created_at) }}', '<button class="btn sm endorse" :title="effect(e, \'Agree\')" @click="decide(e, \'agreed\')"><icon name="check" :size="13"/> Agree</button><button class="btn sm" :title="effect(e, \'Local\')" @click="decide(e, \'local\')">Local</button><button class="btn sm" :title="effect(e, \'Edit\')" @click="edit(e)">Edit</button><button class="btn sm" :title="effect(e, \'Reject\')" @click="decide(e, \'rejected\')">Reject</button>')}</template>
            </article>
            <details v-if="local.length" class="ai-decided"><summary>Local, defined within facts ({{ local.length }})</summary>
              <p class="muted small">Too specific to be project symbols. A rewrite unfolds them, or defines them within the fact that uses them.</p>
              <div v-for="e in local" :key="e.id" class="d-row"><math-text :text="asMath(e.symbol)"/><span class="d-title">{{ e.meaning_text }}</span><button class="btn xs" @click="decide(e, 'proposed')">Reopen</button></div></details>
            <details v-if="rejected.length" class="ai-decided"><summary>Rejected ({{ rejected.length }})</summary>
              <div v-for="e in rejected" :key="e.id" class="d-row"><math-text :text="asMath(e.symbol)"/><span class="d-title">{{ e.meaning_text }}</span><button class="btn xs" @click="decide(e, 'proposed')">Reopen</button><button class="btn xs" @click="remove(e)">Delete</button></div></details>
          </section>
          <section v-if="d.definitions.length" class="panel" id="notation-definitions">
            <header class="ai-head"><h2><icon name="book" :size="15"/> Definitions from the facts</h2><small>{{ d.definitions.filter((x) => !x.entry).length }} without an entry</small></header>
            <p class="muted small">Definitions are conventions, not results: they are no longer listed or checked among the facts. Give each one an entry, so that the project agrees on its symbol.</p>
            <article v-for="x in d.definitions" :key="x.id" class="notation-def">
              <div class="notation-def-main"><a :href="link('facts', x.id)"><code class="key">{{ x.label }}</code> <math-text :text="x.title"/></a>
                <p class="muted small"><math-text :text="clipMath(x.statement_text, 400)"/></p>
                <small v-if="x.used_by" class="muted">Used by {{ x.used_by }} fact{{ x.used_by > 1 ? 's' : '' }}</small></div>
              <div class="notation-actions"><a v-if="x.entry" class="chip-link" :href="link('facts', null, {mode: 'notation', notation: x.entry.id})"><math-text :text="asMath(x.entry.symbol)"/> · {{ x.entry.status }}</a>
                <button v-else class="btn sm" @click="fromDefinition(x)">Make an entry</button></div>
            </article>
          </section>
        </div>
        <aside class="notation-side">
          <section v-if="talkEntry" class="panel notation-talk">
            <header class="ai-head"><h2><icon name="comment" :size="15"/> <math-text :text="asMath(talkEntry.symbol)"/></h2><button class="icon-btn" title="Close the discussion" aria-label="Close the discussion" @click="talk = null"><icon name="x" :size="15"/></button></header>
            <p class="muted small">Discuss which meaning the project should use. Comments are visible to every member, and an AI proposing or rewriting the notation reads them. Write @AI to ask its opinion.</p>
            <comments-panel target-type="notation" :target-id="talkEntry.id" :active-id="comment || null" title="Discussion" @activity="load"/>
          </section>
          <section class="panel">
            <header class="ai-head"><h2><icon name="sparkles" :size="15"/> Review the notation</h2></header>
            <p class="muted small">An AI client looks at the whole picture: the notation every fact defines for itself, and the sources. It proposes making shared symbols global, one meaning per symbol, and general definitions for notions that papers state in particular settings. The consolidation then settles the notation on its own, when the project lets it apply changes: people confirm, reopen or undo its choices.</p>
            <ai-action kind="notation" label="Ask AI to review the notation"/>
          </section>
          <section class="panel" id="notation-propose">
            <header id="notation-propose-head" class="ai-head"><h2><icon name="plus" :size="15"/> Propose an entry</h2></header>
            <label class="field"><span>Symbol (LaTeX)</span><input v-model="draft.symbol" placeholder="\\mathrm{FS}(X)"></label>
            <p v-if="draft.symbol.trim()" class="notation-preview"><math-text :text="asMath(draft.symbol)"/></p>
            <label class="field"><span>Meaning</span><textarea v-model="draft.meaning" rows="3" placeholder="The sums of finitely many elements of $X$, including the empty sum $0$."></textarea></label>
            <label v-if="inferParams(draft.symbol).length" class="field"><span>What {{ inferParams(draft.symbol).join(', ') }} stand{{ inferParams(draft.symbol).length > 1 ? '' : 's' }} for</span><textarea v-model="draft.params" rows="2" :placeholder="inferParams(draft.symbol).join(', ') + ': infinite block sequences'"></textarea>
              <small class="muted">The entry applies to these objects only: the same symbol between other objects keeps its own meaning.</small></label>
            <label class="field"><span>How sources differ (optional)</span><textarea v-model="draft.note" rows="2" placeholder="Some papers exclude 0. Here that set is written $\\mathrm{NS}(X)$."></textarea></label>
            <label class="field"><span>Definition fact (optional)</span><select v-model="draft.fact"><option value="">None</option><option v-for="f in definitions" :key="f.id" :value="f.id">{{ f.label }}: {{ f.title }}</option></select></label>
            <button class="btn primary block" :disabled="!!error || busy" @click="propose">Propose</button>
          </section>
        </aside>
      </div>
    </template>
  </div>`,
};
