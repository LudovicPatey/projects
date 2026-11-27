// The searchable fact picker: one field to choose a fact among hundreds, by words of its label, title or statement, with the
// keyboard or the mouse. Its logic is in fact-picker-model.js, which is tested.
import { api, expandFacts } from './api.js';
import { store } from './store.js';
import { plainTex } from './fact-badges.js';
import { searchFacts, asksServer, serverIds, describe, countLine, moveActive, placeList } from './fact-picker-model.js';

// The project's facts, loaded once per project for the pickers of pages that do not hold them (the questions page).
const loaded = new Map();
function projectFacts(pid) {
  if (!loaded.has(pid)) loaded.set(pid, api.get(`api/projects/${pid}/facts?compact=1`).then(expandFacts).catch(() => { loaded.delete(pid); return []; }));
  return loaded.get(pid);
}

let uid = 0;

/**
 * v-model is the chosen fact's id, or null. `facts` are the facts to choose from, in the order to offer them; without it, the
 * picker loads the project's facts. `exclude` lists ids that cannot be chosen (the fact itself), and `filter` any other rule;
 * retracted facts are left out unless `with-retracted`. `effect` says what choosing a fact changes, under the field.
 */
export const FactPicker = {
  props: {
    modelValue: [Number, String], facts: Array, exclude: { type: Array, default: () => [] }, filter: Function, withRetracted: Boolean,
    label: { type: String, default: 'Fact' }, placeholder: { type: String, default: 'Search by label, title or words of the statement' },
    effect: String, sm: Boolean, clearable: { type: Boolean, default: true },
  },
  emits: ['update:modelValue'],
  data() { return { id: 'fp' + ++uid, own: null, query: '', open: false, active: -1, found: [], pos: {}, editing: false }; },
  computed: {
    list() { return this.facts || this.own || []; },
    chosen() { const v = +this.modelValue; return v ? this.list.find((f) => f.id === v) || { id: v, label: '', title: `Fact #${v}` } : null; },
    shown() { return this.chosen ? describe(this.chosen) : null; },
    result() { return searchFacts(this.list, this.query, { exclude: this.exclude, filter: this.filter, withRetracted: this.withRetracted, found: this.found }); },
    rows() { return this.result.items.map((f) => ({ f, d: describe(f) })); },
    count() { return countLine(this.result, this.query); },
    // One array per query, so that moving through the list does not draw every formula again.
    marks() { const q = this.query.trim(); return q ? q.split(/\s+/) : null; },
    searching() { return this.editing || !this.chosen; },
  },
  watch: {
    query(q) {
      this.active = this.rows.length && q.trim() ? 0 : -1;
      clearTimeout(this.timer);
      this.found = [];
      if (!asksServer(q) || !store.project) return;
      // The page holds only the start of each statement: the server reads them whole, and adds what it finds.
      this.timer = setTimeout(async () => {
        try { const r = await api.get(`api/projects/${store.project.id}/refs?type=fact&q=${encodeURIComponent(q.trim())}`); if (q === this.query) this.found = serverIds(r.results); } catch { /* the local matches stay */ }
      }, 250);
    },
  },
  async created() { if (!this.facts && store.project) this.own = await projectFacts(store.project.id); },
  mounted() {
    this.place = () => { if (this.open) this.measure(); };
    window.addEventListener('scroll', this.place, true);
    window.addEventListener('resize', this.place);
  },
  unmounted() { clearTimeout(this.timer); window.removeEventListener('scroll', this.place, true); window.removeEventListener('resize', this.place); },
  methods: {
    plainTex,
    measure() {
      const box = this.$refs.input?.getBoundingClientRect();
      if (!box) return;
      const win = { width: document.documentElement.clientWidth, height: window.innerHeight };
      // Inside a dialog, in line with it; elsewhere, inside the main area, not over the side rail.
      const main = (this.$el.closest('.modal') || document.querySelector('.main'))?.getBoundingClientRect();
      const p = placeList(box, win, main ? { area: { left: main.left, right: main.right } } : {});
      this.pos = { left: p.left + 'px', width: p.width + 'px', maxHeight: p.maxHeight + 'px', ...(p.top !== undefined ? { top: p.top + 'px' } : { bottom: p.bottom + 'px' }) };
    },
    show() { if (this.open) return; this.open = true; this.measure(); },
    hide() { this.open = false; this.active = -1; if (this.chosen) { this.editing = false; this.query = ''; } },
    change() { this.editing = true; this.$nextTick(() => { this.$refs.input?.focus(); this.show(); }); },
    pick(f) { this.$emit('update:modelValue', f.id); this.query = ''; this.editing = false; this.open = false; this.active = -1; },
    clear() { this.$emit('update:modelValue', null); this.editing = false; this.query = ''; this.$nextTick(() => this.$refs.input?.focus()); },
    blur(e) { if (!this.$el.contains(e.relatedTarget)) this.hide(); },
    key(e) {
      if (['ArrowDown', 'ArrowUp'].includes(e.key) || (this.open && ['Home', 'End'].includes(e.key) && this.rows.length)) {
        e.preventDefault(); this.show();
        this.active = moveActive(this.active, e.key, this.rows.length);
        this.$nextTick(() => document.getElementById(this.id + '-' + this.active)?.scrollIntoView({ block: 'nearest' }));
      } else if (e.key === 'Enter') {
        if (!this.open) return;
        e.preventDefault();
        const row = this.rows[this.active] || (this.rows.length === 1 ? this.rows[0] : null);
        if (row) this.pick(row.f);
      } else if (e.key === 'Escape' && (this.open || this.editing)) {
        e.stopPropagation(); // closes the list, not the dialog around it
        this.hide();
      }
    },
  },
  template: `<div class="fact-picker" :class="{sm, open}">
    <div v-if="!searching" class="fp-chosen">
      <button type="button" class="fp-current" :title="'Chosen: ' + (shown.label || shown.title) + '. Click to choose another fact.'" :aria-label="label + ': ' + plainTex(shown.title) + '. Choose another fact'" @click="change">
        <span class="fp-title"><math-text :text="shown.title"/></span>
        <span class="fp-meta"><span>{{ shown.kind }}</span><span v-if="shown.cited">cited result</span><span v-if="shown.label" class="fp-key">{{ shown.label }}</span><span v-if="shown.status" class="fp-state" :class="'t-' + shown.status.tone" :title="shown.status.title"><icon :name="shown.status.icon" :size="12"/>{{ shown.status.word }}</span></span>
      </button>
      <button v-if="clearable" type="button" class="icon-btn fp-clear" :aria-label="'Clear the chosen ' + label.toLowerCase()" title="Clears this choice. Nothing is saved until you confirm the form." @click="clear"><icon name="x" :size="14"/></button>
    </div>
    <div v-else class="fp-search"><icon name="search" :size="14" class="fp-icon"/>
      <input ref="input" v-model="query" type="search" role="combobox" autocomplete="off" spellcheck="false" :placeholder="placeholder" :aria-label="label"
        :aria-expanded="open" :aria-controls="id + '-list'" :aria-activedescendant="active >= 0 ? id + '-' + active : null" aria-autocomplete="list"
        @focus="show" @click="show" @input="show" @keydown="key" @blur="blur">
      <button v-if="chosen" type="button" class="link-btn small fp-keep" @mousedown.prevent @click="hide">Keep {{ shown.label || 'the current fact' }}</button>
    </div>
    <small v-if="effect" class="fp-effect">{{ effect }}</small>
    <div v-if="open && searching" class="fp-pop" :style="pos" @mousedown.prevent>
      <ul :id="id + '-list'" class="fp-list" role="listbox" :aria-label="label">
        <li v-for="(r, i) in rows" :id="id + '-' + i" :key="r.f.id" role="option" class="fp-opt" :class="{active: i === active, on: r.f.id === chosen?.id}" :aria-selected="i === active" @mousemove="active = i" @click="pick(r.f)">
          <span class="fp-title"><math-text :text="r.d.title" :highlight="marks"/></span>
          <span class="fp-meta"><span>{{ r.d.kind }}</span><span v-if="r.d.cited">cited result</span><span v-if="r.d.label" class="fp-key">{{ r.d.label }}</span><span v-if="r.d.status" class="fp-state" :class="'t-' + r.d.status.tone" :title="r.d.status.title"><icon :name="r.d.status.icon" :size="12"/>{{ r.d.status.word }}</span></span>
        </li>
      </ul>
      <p class="fp-count" role="status">{{ count }}<span v-if="rows.length" class="fp-keys"> ↑↓ to move, Enter to choose, Esc to close.</span></p>
    </div>
  </div>`,
};
