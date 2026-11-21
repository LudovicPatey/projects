// Global search in the top bar: results from everything the user can see, grouped by kind.
import { api } from './api.js';
import { store, go } from './store.js';
import { foldText } from './util.js';
import { resolveTarget, searchHelp } from './help/content.js';

const ICONS = { fact: 'graph', conversation: 'mail', file: 'files', reference: 'book', comment: 'comment', person: 'user', project: 'home', help: 'help' };
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');

export const GlobalSearch = {
  data() {
    return { q: '', open: false, loading: false, result: null, error: null, active: 0, scope: 'project', expanded: null, shortcut: isMac ? '⌘K' : 'Ctrl K' };
  },
  computed: {
    pid() { return store.route.name === 'project' ? store.route.pid : null; },
    scoped() { return !!this.pid && this.scope === 'project'; },
    terms() { return [...new Set(foldText(this.q).split(/\s+/).filter(Boolean))]; },
    groups() {
      if (!this.result) return [];
      if (this.expanded) return this.result.groups.filter((g) => g.type === this.expanded);
      return this.helpGroup ? [...this.result.groups, this.helpGroup] : this.result.groups;
    },
    helpGroup() {
      if (!this.ready) return null;
      const found = searchHelp(this.q, 3);
      if (!found.length) return null;
      return { type: 'help', label: 'Help', total: found.length, results: found.map((a) => ({ type: 'help', id: a.slug, project_id: this.pid || 0, title: a.title, snippet: a.snippet, field: null, badge: null })) };
    },
    totalFound() { return (this.result?.total || 0) + (this.expanded ? 0 : this.helpGroup?.total || 0); },
    flat() { return this.groups.flatMap((g) => g.results); },
    ready() { return this.q.trim().length >= 2; },
    activeId() { return this.open && this.flat[this.active] ? this.optionId(this.flat[this.active]) : null; },
    placeholder() { return this.pid ? 'Search this project…' : 'Search all your projects…'; },
  },
  watch: {
    q() { this.expanded = null; this.schedule(); },
    scope() { this.expanded = null; this.run(); },
    pid() { this.result = null; if (this.q) this.run(); },
    'store.route'() { this.open = false; },
    activeId(id) { if (id) this.$nextTick(() => document.getElementById(id)?.scrollIntoView({ block: 'nearest' })); },
  },
  created() { this.store = store; this.icons = ICONS; },
  mounted() {
    this.onKey = (e) => {
      const typing = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey)) {
        e.preventDefault();
        this.$refs.input.focus();
        this.$refs.input.select();
        this.open = true;
      }
    };
    this.onDown = (e) => { if (!this.$el.contains(e.target)) this.open = false; };
    window.addEventListener('keydown', this.onKey);
    document.addEventListener('mousedown', this.onDown);
  },
  unmounted() {
    clearTimeout(this.timer);
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('mousedown', this.onDown);
  },
  template: `<div class="gsearch" role="search" data-tour="search">
    <div class="gs-box" :class="{focus: open}">
      <icon name="search" :size="16"/>
      <input ref="input" v-model="q" type="search" :placeholder="placeholder" aria-label="Search" role="combobox" autocomplete="off" spellcheck="false"
        aria-controls="gs-results" aria-autocomplete="list" :aria-expanded="open && ready" :aria-activedescendant="activeId"
        @focus="open = true" @click="open = true" @input="open = true" @keydown="onInputKey">
      <button v-if="q" class="icon-btn xs" type="button" title="Clear" aria-label="Clear search" @mousedown.prevent @click="clear"><icon name="x" :size="14"/></button>
      <kbd v-else>{{ shortcut }}</kbd>
    </div>
    <div v-if="open && ready" class="gs-pop">
      <div class="gs-head">
        <div v-if="pid" class="seg small gs-scope" role="group" aria-label="Search scope">
          <button type="button" :class="{on: scope === 'project'}" :aria-pressed="scope === 'project'" @mousedown.prevent @click="scope = 'project'">This project</button>
          <button type="button" :class="{on: scope === 'all'}" :aria-pressed="scope === 'all'" @mousedown.prevent @click="scope = 'all'">All projects</button>
        </div>
        <span class="muted small" aria-live="polite">{{ loading ? 'Searching…' : result ? totalFound + (totalFound === 1 ? ' result' : ' results') : '' }}</span>
      </div>
      <div id="gs-results" class="gs-list" role="listbox" aria-label="Search results">
        <div v-if="error" class="empty">{{ error }}</div>
        <div v-else-if="result && !totalFound && !loading" class="empty">No result for “{{ q.trim() }}”.<br><small>PDF contents are not searched, only titles, descriptions and file names.</small></div>
        <section v-for="g in groups" :key="g.type" class="gs-group" role="group" :aria-label="g.label">
          <header><span>{{ g.label }}</span><b>{{ g.total }}</b><span class="grow"></span>
            <button v-if="expanded === g.type" type="button" class="link-btn" @mousedown.prevent @click="collapse">Back to all</button>
            <button v-else-if="g.total > g.results.length" type="button" class="link-btn" @mousedown.prevent @click="expand(g.type)">Show all</button>
          </header>
          <a v-for="r in g.results" :id="optionId(r)" :key="optionId(r)" class="gs-item" :class="{active: flat[active] === r}" role="option" :aria-selected="flat[active] === r"
             :href="href(r)" @mousemove="active = flat.indexOf(r)" @click="close">
            <span class="gs-icon" :class="r.type"><icon :name="icons[r.type]" :size="15"/></span>
            <span class="gs-text">
              <span class="gs-title"><math-text :text="r.title" :highlight="terms"/><code v-if="r.type === 'fact' || r.type === 'reference'" class="key">{{ r.badge }}</code></span>
              <span v-if="r.snippet" class="gs-snippet"><em v-if="r.field && showField(r)">{{ r.field }}:</em> <math-text :text="r.snippet" :highlight="terms"/></span>
            </span>
            <span class="gs-meta"><span v-if="r.type !== 'fact' && r.type !== 'reference' && r.badge" class="tag">{{ r.badge }}</span>
              <span v-if="!scoped && r.type !== 'project' && r.type !== 'help'" class="gs-project">{{ r.project_title }}</span></span>
          </a>
        </section>
      </div>
      <footer class="gs-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></footer>
    </div>
  </div>`,
  methods: {
    optionId(r) { return `gs-${r.type}-${r.project_id}-${r.id}`; },
    showField(r) { return !['message', 'comment', 'statement', 'question'].includes(r.field); },
    href(r) {
      if (r.type === 'help') return resolveTarget(`help:${r.id}`, this.pid);
      const l = r.link;
      const q = l.query ? '?' + new URLSearchParams(l.query) : '';
      return `#/p/${r.project_id}/${l.view}${l.id ? '/' + l.id : ''}${q}`;
    },
    schedule() {
      clearTimeout(this.timer);
      if (!this.ready) { this.result = null; this.loading = false; this.error = null; this.seq = (this.seq || 0) + 1; return; }
      this.loading = true;
      this.timer = setTimeout(() => this.run(), 170);
    },
    async run(type = this.expanded) {
      clearTimeout(this.timer);
      if (!this.ready) return;
      const seq = this.seq = (this.seq || 0) + 1;
      const p = new URLSearchParams({ q: this.q.trim() });
      if (this.pid) p.set('project', this.pid);
      if (this.scoped) p.set('scope', 'project');
      if (type) p.set('type', type);
      this.loading = true;
      try {
        const r = await api.get('api/search?' + p);
        if (seq !== this.seq) return;
        this.result = r; this.error = null; this.active = 0;
      } catch (e) {
        if (seq === this.seq) { this.error = e.message; this.result = null; }
      }
      if (seq === this.seq) this.loading = false;
    },
    expand(type) { this.expanded = type; this.run(type); },
    collapse() { this.expanded = null; this.run(null); },
    clear() { this.q = ''; this.result = null; this.$refs.input.focus(); },
    close() { this.open = false; this.$refs.input.blur(); },
    onInputKey(e) {
      const n = this.flat.length;
      if (e.key === 'Escape') { e.stopPropagation(); if (this.open && this.q) this.open = false; else this.q = ''; this.$refs.input.blur(); }
      else if (e.key === 'ArrowDown' && n) { e.preventDefault(); this.open = true; this.active = (this.active + 1) % n; }
      else if (e.key === 'ArrowUp' && n) { e.preventDefault(); this.active = (this.active - 1 + n) % n; }
      else if (e.key === 'Enter' && n && this.open) { e.preventDefault(); const r = this.flat[this.active]; this.close(); go(this.href(r).slice(1)); }
    },
  },
};
