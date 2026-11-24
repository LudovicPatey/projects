import { api } from '../api.js';
import { link, attempt, toast } from '../store.js';
import { timeAgo } from '../util.js';
import { Kpi, StackBar } from '../dashboard.js';
import { NOTATION_SEGMENTS, asMath, entryBody, entryError, toRewrite } from '../notation-model.js';

const entryEditor = `<div class="notation-edit">
  <label class="field"><span>Symbol (LaTeX)</span><input v-model="editing.symbol"></label>
  <label class="field"><span>Meaning</span><textarea v-model="editing.meaning" rows="3"></textarea></label>
  <label class="field"><span>How sources differ</span><textarea v-model="editing.note" rows="2"></textarea></label>
  <p v-if="editing.agreed" class="muted small">Changing the symbol or its meaning makes it a proposal again.</p>
  <div class="row-end"><button class="btn ghost sm" @click="editing = null">Cancel</button><button class="btn primary sm" @click="save">Save</button></div></div>`;

const entryView = (by, actions) => `<div class="notation-symbol"><math-text :text="asMath(e.symbol)"/></div>
  <div class="notation-body"><rich-content :html="e.meaning_html"/>
    <p v-if="e.note_text" class="notation-note"><icon name="lightbulb" :size="13"/> <math-text :text="e.note_text"/></p>
    <ul v-if="e.variants.length" class="notation-variants"><li v-for="(v, i) in e.variants" :key="i"><math-text :text="asMath(v.symbol)"/> <span><math-text :text="v.meaning"/></span><small v-if="v.where">{{ v.where }}</small></li></ul>
    <small class="muted">${by}<template v-if="e.definition_label"> · defined in <a :href="link('facts', e.definition_fact_id)">{{ e.definition_label }}</a></template></small></div>
  <div class="notation-actions">${actions}</div>`;

/** The project's notation, inside Facts: agreed meanings, proposals, and how far facts follow them. */
export const NotationPanel = {
  components: { Kpi, StackBar },
  props: { pid: Number, focus: Number },
  emits: ['mode'],
  data() { return { d: null, facts: [], draft: { symbol: '', meaning: '', note: '', fact: '' }, editing: null, busy: false }; },
  computed: {
    agreed() { return (this.d?.entries || []).filter((e) => e.status === 'agreed'); },
    proposed() { return (this.d?.entries || []).filter((e) => e.status === 'proposed'); },
    rejected() { return (this.d?.entries || []).filter((e) => e.status === 'rejected'); },
    remaining() { return toRewrite(this.d?.progress); },
    error() { return entryError(this.draft); },
    definitions() { return this.facts.filter((f) => !f.retracted_at); },
  },
  created() { this.segments = NOTATION_SEGMENTS; },
  async mounted() {
    await this.load();
    this.facts = (await attempt(() => api.get(`api/projects/${this.pid}/facts`)))?.facts || [];
    this.timer = setInterval(() => { if (!document.hidden && !this.editing) this.load(); }, 20000);
  },
  unmounted() { clearInterval(this.timer); },
  methods: {
    timeAgo, link, asMath,
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
      if (r) { this.draft = { symbol: '', meaning: '', note: '', fact: '' }; await this.load(); }
    },
    edit(e) { this.editing = { id: e.id, symbol: e.symbol, meaning: e.meaning_text, note: e.note_text, fact: e.definition_fact_id || '', agreed: e.status === 'agreed' }; },
    async save() {
      const problem = entryError(this.editing);
      if (problem) return toast(problem, 'error');
      const r = await attempt(() => api.patch(`api/notation/${this.editing.id}`, entryBody(this.editing)), 'Entry saved');
      if (r) { this.editing = null; await this.load(); }
    },
    async decide(e, status) {
      if (status === 'agreed' && !confirm(`Agree that ${e.symbol} has this meaning in the whole project? Facts are rewritten in this notation when a member asks.`)) return;
      if (await attempt(() => api.post(`api/notation/${e.id}/status`, { status }), { agreed: 'Agreed', rejected: 'Rejected', proposed: 'Reopened' }[status])) await this.load();
    },
    fromDefinition(x) {
      this.draft = { symbol: '', meaning: x.statement_text, note: '', fact: x.id };
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
      <div class="seg small mode-seg"><button @click="$emit('mode', 'list')"><icon name="list" :size="13"/> List</button><button @click="$emit('mode', 'graph')"><icon name="graph" :size="13"/> Graph</button><button class="on" aria-pressed="true"><icon name="book" :size="13"/> Notation</button></div></header>
    <div v-if="!d" class="d-empty">Loading…</div>
    <template v-else>
      <div class="kpi-grid notation-kpis">
        <kpi icon="check-circle" :value="d.progress.agreed" label="agreed symbols" tone="good"/>
        <kpi icon="lightbulb" :value="d.progress.proposed" label="proposals to decide" :tone="d.progress.proposed ? 'warn' : 'neutral'"/>
        <kpi icon="graph" :value="(d.progress.current + d.progress.unchanged) + ' / ' + d.progress.facts" label="facts in project notation" tone="accent"/>
        <kpi icon="clock" :value="d.progress.queued" label="being rewritten" tone="neutral"/>
      </div>
      <div class="notation-grid">
        <div class="notation-main">
          <section class="panel">
            <header class="ai-head"><h2><icon name="graph" :size="15"/> Facts and the agreed notation</h2></header>
            <stack-bar :counts="d.progress" :segments="segments" label="Facts by notation"/>
            <p class="muted small">Rewriting never changes a fact's reviewed text. Each fact shows its version in the project's notation, and a person can confirm that it says the same.</p>
            <div class="row-gap"><button class="btn primary sm" :disabled="!agreed.length || !remaining" @click="rewriteAll"><icon name="sparkles" :size="14"/> Rewrite {{ remaining }} fact{{ remaining === 1 ? '' : 's' }}</button>
              <span v-if="!agreed.length" class="muted small">Agree on at least one symbol first.</span></div>
          </section>
          <section class="panel">
            <header class="ai-head"><h2><icon name="check-circle" :size="15"/> Agreed</h2><small>{{ agreed.length }}</small></header>
            <div v-if="!agreed.length" class="d-empty">Nothing agreed yet. Agree on a proposal below.</div>
            <article v-for="e in agreed" :key="e.id" class="notation-entry" :data-notation="e.id" :class="{flash: focus === e.id}">
              <template v-if="editing?.id === e.id">${entryEditor}</template>
              <template v-else>${entryView('Agreed by {{ e.decided_by_name }} {{ timeAgo(e.decided_at) }}', '<button class="btn sm" @click="edit(e)">Edit</button><button class="btn sm" @click="decide(e, \'proposed\')">Reopen</button>')}</template>
            </article>
          </section>
          <section class="panel">
            <header class="ai-head"><h2><icon name="lightbulb" :size="15"/> Proposed</h2><small>Agree on one meaning per symbol</small></header>
            <div v-if="!proposed.length" class="d-empty">No proposal. Ask the AI to compare the facts' notations, or propose one yourself.</div>
            <article v-for="e in proposed" :key="e.id" class="notation-entry" :data-notation="e.id" :class="{flash: focus === e.id}">
              <template v-if="editing?.id === e.id">${entryEditor}</template>
              <template v-else>${entryView('Proposed by {{ e.author_name }}<template v-if="e.author_kind === \'agent\'"> · {{ e.ai_model }}</template> {{ timeAgo(e.created_at) }}', '<button class="btn sm endorse" @click="decide(e, \'agreed\')"><icon name="check" :size="13"/> Agree</button><button class="btn sm" @click="edit(e)">Edit</button><button class="btn sm" @click="decide(e, \'rejected\')">Reject</button>')}</template>
            </article>
            <details v-if="rejected.length" class="ai-decided"><summary>Rejected ({{ rejected.length }})</summary>
              <div v-for="e in rejected" :key="e.id" class="d-row"><math-text :text="asMath(e.symbol)"/><span class="d-title">{{ e.meaning_text }}</span><button class="btn xs" @click="decide(e, 'proposed')">Reopen</button><button class="btn xs" @click="remove(e)">Delete</button></div></details>
          </section>
          <section v-if="d.definitions.length" class="panel" id="notation-definitions">
            <header class="ai-head"><h2><icon name="book" :size="15"/> Definitions from the facts</h2><small>{{ d.definitions.filter((x) => !x.entry).length }} without an entry</small></header>
            <p class="muted small">Definitions are conventions, not results: they are no longer listed or checked among the facts. Give each one an entry, so that the project agrees on its symbol.</p>
            <article v-for="x in d.definitions" :key="x.id" class="notation-def">
              <div class="notation-def-main"><a :href="link('facts', x.id)"><code class="key">{{ x.label }}</code> <math-text :text="x.title"/></a>
                <p class="muted small"><math-text :text="x.statement_text.slice(0, 400)"/></p>
                <small v-if="x.used_by" class="muted">Used by {{ x.used_by }} fact{{ x.used_by > 1 ? 's' : '' }}</small></div>
              <div class="notation-actions"><a v-if="x.entry" class="chip-link" :href="link('facts', null, {mode: 'notation', notation: x.entry.id})"><math-text :text="asMath(x.entry.symbol)"/> · {{ x.entry.status }}</a>
                <button v-else class="btn sm" @click="fromDefinition(x)">Make an entry</button></div>
            </article>
          </section>
        </div>
        <aside class="notation-side">
          <section class="panel">
            <header class="ai-head"><h2><icon name="sparkles" :size="15"/> Compare the papers</h2></header>
            <p class="muted small">An AI client reads every fact, finds symbols that sources use with different meanings, and proposes one notation. People decide.</p>
            <ai-action kind="notation" label="Ask AI to propose a notation"/>
          </section>
          <section class="panel" id="notation-propose">
            <header id="notation-propose-head" class="ai-head"><h2><icon name="plus" :size="15"/> Propose an entry</h2></header>
            <label class="field"><span>Symbol (LaTeX)</span><input v-model="draft.symbol" placeholder="\\mathrm{FS}(X)"></label>
            <p v-if="draft.symbol.trim()" class="notation-preview"><math-text :text="asMath(draft.symbol)"/></p>
            <label class="field"><span>Meaning</span><textarea v-model="draft.meaning" rows="3" placeholder="The sums of finitely many elements of $X$, including the empty sum $0$."></textarea></label>
            <label class="field"><span>How sources differ (optional)</span><textarea v-model="draft.note" rows="2" placeholder="Some papers exclude 0. Here that set is written $\\mathrm{NS}(X)$."></textarea></label>
            <label class="field"><span>Definition fact (optional)</span><select v-model="draft.fact"><option value="">None</option><option v-for="f in definitions" :key="f.id" :value="f.id">{{ f.label }}: {{ f.title }}</option></select></label>
            <button class="btn primary block" :disabled="!!error || busy" @click="propose">Propose</button>
          </section>
        </aside>
      </div>
    </template>
  </div>`,
};
