import { api } from '../api.js';
import { link, attempt, toast, store } from '../store.js';
import { timeAgo } from '../util.js';
import { Kpi } from '../dashboard.js';
import { groupSuggestions, suggestionText } from '../consolidation-model.js';

/** Consolidation, inside Facts: what an AI proposes after reading the whole database, for people to accept or reject. */
export const ConsolidationPanel = {
  components: { Kpi },
  props: { pid: Number },
  emits: ['mode'],
  data() { return { d: null, busy: false, open: {} }; },
  computed: {
    groups() { return groupSuggestions(this.d?.suggestions || []); },
    waiting() { return this.groups.reduce((n, g) => n + g.items.length, 0); },
    decided() { return (this.d?.suggestions || []).filter((s) => s.status !== 'proposed').slice(0, 60); },
    owner() { return store.project?.my_role === 'owner'; },
  },
  async mounted() {
    await this.load();
    this.timer = setInterval(() => { if (!document.hidden && !this.busy) this.load(); }, 30000);
  },
  unmounted() { clearInterval(this.timer); },
  methods: {
    timeAgo, link, suggestionText,
    async load() {
      const r = await attempt(() => api.get(`api/projects/${this.pid}/consolidation`));
      if (r) this.d = r;
    },
    fact(id) { return this.d?.facts?.[id] || null; },
    ownerOnly(s) { return ['same', 'question'].includes(s.kind) && !this.owner; },
    async decide(s, accept) {
      if (accept && s.kind === 'same' && !confirm(`Merge ${this.fact(s.other_fact_id)?.label} into ${this.fact(s.fact_id)?.label}? Its sources, links, stars and proof move to the kept fact, and it leaves the list.`)) return;
      if (accept && s.kind === 'question' && !confirm(`Make ${this.fact(s.fact_id)?.label} an open question? The remark leaves the facts.`)) return;
      this.busy = true;
      const r = await attempt(() => api.post(`api/fact-suggestions/${s.id}/${accept ? 'accept' : 'reject'}`, {}), accept ? 'Applied' : 'Rejected');
      this.busy = false;
      if (r) await this.load();
    },
    async bulk(g, accept) {
      const items = g.items.filter((s) => !this.ownerOnly(s));
      if (!items.length) return;
      if (!confirm(`${accept ? 'Accept' : 'Reject'} the ${items.length} proposal${items.length > 1 ? 's' : ''} of “${g.title}”?`)) return;
      this.busy = true;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/consolidation/bulk`, { decision: accept ? 'accept' : 'reject', ids: items.map((s) => s.id) }));
      this.busy = false;
      if (r) { toast(`${r.done} done${r.failed.length ? `, ${r.failed.length} could not be applied` : ''}`, r.failed.length ? 'error' : 'success'); await this.load(); }
    },
  },
  template: `<div class="page wide consolidation-page">
    <header class="page-title"><span class="sh-icon"><icon name="layers" :size="22"/></span><div><h1>Consolidate the facts</h1><p>Extraction reads one source at a time. An AI then reads the whole database and proposes what only the whole shows. People decide.</p></div>
      <div class="seg small mode-seg"><button @click="$emit('mode', 'list')"><icon name="list" :size="13"/> List</button><button @click="$emit('mode', 'graph')"><icon name="graph" :size="13"/> Graph</button><button @click="$emit('mode', 'notation')"><icon name="book" :size="13"/> Notation</button><button class="on" aria-pressed="true"><icon name="layers" :size="13"/> Consolidate</button></div></header>
    <div v-if="!d" class="d-empty">Loading…</div>
    <template v-else>
      <div class="kpi-grid notation-kpis">
        <kpi icon="lightbulb" :value="waiting" label="to decide" :tone="waiting ? 'warn' : 'neutral'"/>
        <kpi icon="layers" :value="d.counts.same" label="duplicates" tone="accent"/>
        <kpi icon="graph" :value="d.counts.depends" label="missing links" tone="accent"/>
        <kpi icon="tag" :value="d.topics.length" label="subject tags" tone="neutral"/>
      </div>
      <div class="notation-grid">
        <div class="notation-main">
          <section v-if="!groups.length" class="panel"><div class="d-empty">No proposal waiting. A consolidation is queued after each round of extractions, and you can ask for one at any time.</div></section>
          <section v-for="g in groups" :key="g.kind" class="panel">
            <header class="ai-head"><h2>{{ g.title }}</h2><small>{{ g.items.length }}</small></header>
            <p class="muted small">{{ g.help }}<template v-if="(g.kind === 'same' || g.kind === 'question') && !owner"> Only an owner applies these.</template></p>
            <div v-if="g.items.length > 1" class="row-gap"><button class="btn sm" :disabled="busy || g.items.every(ownerOnly)" @click="bulk(g, true)"><icon name="check" :size="13"/> Accept all</button><button class="btn sm" :disabled="busy" @click="bulk(g, false)">Reject all</button></div>
            <article v-for="s in g.items.slice(0, open[g.kind] ? 1000 : 40)" :key="s.id" class="cons-item">
              <div class="cons-main">
                <b class="cons-what"><math-text :text="suggestionText(s, d.facts)"/></b>
                <div class="cons-facts">
                  <a v-for="id in [s.fact_id, s.other_fact_id].filter(Boolean)" :key="id" class="cons-fact" :href="link('facts', id)">
                    <code class="key">{{ fact(id)?.label }}</code> <span class="muted small"><math-text :text="(fact(id)?.excerpt || '').slice(0, 220)"/></span></a>
                </div>
                <p class="cons-reason small"><icon name="sparkles" :size="12"/> <math-text :text="s.reason_text"/> <ai-meta compact :model="s.ai_model" :user="s.ai_user_name" :ms="s.ai_generation_ms"/></p>
              </div>
              <div class="notation-actions">
                <button class="btn sm endorse" :disabled="busy || ownerOnly(s)" :title="ownerOnly(s) ? 'Only an owner applies this' : ''" @click="decide(s, true)"><icon name="check" :size="13"/> Accept</button>
                <button class="btn sm" :disabled="busy" @click="decide(s, false)">Reject</button>
              </div>
            </article>
            <button v-if="g.items.length > 40 && !open[g.kind]" class="link-btn small" @click="open[g.kind] = true">Show the {{ g.items.length - 40 }} others</button>
          </section>
          <details v-if="decided.length" class="panel ai-decided"><summary>Decided ({{ decided.length }})</summary>
            <div v-for="s in decided" :key="s.id" class="d-row"><span class="pill" :class="s.status === 'accepted' ? 't-good' : 't-off'">{{ s.status }}</span><span class="d-title"><math-text :text="suggestionText(s, d.facts)"/></span><small class="muted">{{ s.decided_by_name || '' }} {{ s.decided_at ? timeAgo(s.decided_at) : '' }}</small></div>
          </details>
        </div>
        <aside class="notation-side">
          <section class="panel">
            <header class="ai-head"><h2><icon name="sparkles" :size="15"/> Ask for a consolidation</h2></header>
            <p class="muted small">An AI client reads every fact with its source, its dependencies and its tags. It proposes merges, dependencies across sources, corrected kinds, open questions and subject tags. It never repeats a proposal that people rejected.</p>
            <p v-if="d.waiting" class="muted small"><icon name="clock" :size="12"/> A consolidation is {{ d.waiting.status === 'running' ? 'running' : 'waiting for an AI client' }}.</p>
            <ai-action v-else kind="consolidate" label="Ask AI to consolidate"/>
          </section>
          <section class="panel">
            <header class="ai-head"><h2><icon name="tag" :size="15"/> Subject tags</h2><small>{{ d.topics.length }}</small></header>
            <p class="muted small">Free tags, set by people or proposed by the AI. Filter the list and the graph by tag.</p>
            <div v-if="!d.topics.length" class="d-empty">No tag yet.</div>
            <div class="topic-cloud"><a v-for="t in d.topics.slice(0, 60)" :key="t.topic" class="topic-chip" :href="link('facts', null, {topic: t.topic})">{{ t.topic }} <small>{{ t.facts }}</small></a></div>
          </section>
        </aside>
      </div>
    </template>
  </div>`,
};
