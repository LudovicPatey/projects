// Rich-text editor (Quill 2) with @mentions of researchers, files and bibliography entries,
// and a renderer for stored rich text (KaTeX for $...$ math, clickable mentions).
import { store } from './store.js';
import { REF_TYPES, parseRefQuery, sortRefs } from './references.js';
import { hydrateChips, openChip, searchRefs } from './refs-client.js';
import { escapeHtml, markTerms } from './util.js';
import { mentionMatches, mentionQuery } from './questions-model.js';
import { askAiPrefix, offersAskAi } from './ai-model.js';

const Embed = Quill.import('blots/embed');

class MentionBlot extends Embed {
  static blotName = 'mention';
  static tagName = 'span';
  static className = 'mention';

  static create(value) {
    const node = super.create(value);
    node.setAttribute('data-type', value.type);
    node.setAttribute('data-id', value.id);
    node.setAttribute('data-label', value.label);
    node.textContent = '@' + value.label;
    if (String(value.label).includes('$') && window.renderMathInElement) window.renderMathInElement(node, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false });
    return node;
  }

  static value(node) {
    return { type: node.getAttribute('data-type'), id: node.getAttribute('data-id'), label: node.getAttribute('data-label') };
  }

  html() {
    const v = MentionBlot.value(this.domNode);
    return `<span class="mention" data-type="${escapeHtml(v.type)}" data-id="${escapeHtml(v.id)}" data-label="${escapeHtml(v.label)}">@${escapeHtml(v.label)}</span>`;
  }
}
Quill.register(MentionBlot);
// Quill draws inline code and code blocks with the same icon.
Quill.import('ui/icons')['code-block'] = '<svg viewBox="0 0 18 18"><rect class="ql-stroke" x="2.5" y="3" width="13" height="12" rx="1.5" fill="none"/><polyline class="ql-stroke" points="7 7 5 9 7 11" fill="none"/><polyline class="ql-stroke" points="11 7 13 9 11 11" fill="none"/></svg>';

const FORMATS = ['bold', 'italic', 'underline', 'strike', 'link', 'blockquote', 'code-block', 'code', 'list', 'header', 'indent', 'mention', 'script'];


export const RichEditor = {
  props: {
    placeholder: { type: String, default: 'Write… (@ to mention, $x^2$ for LaTeX)' },
    initialHtml: { type: String, default: '' },
    compact: Boolean,
    autofocus: Boolean,
    minHeight: { type: Number, default: 0 },
  },
  emits: ['submit', 'cancel', 'change'],
  data() {
    return { menu: { open: false, items: [], index: 0, top: 0, left: 0, start: 0, query: '' } };
  },
  template: `<div class="rte" :class="{compact}">
    <div ref="editor" :style="minHeight ? {minHeight: minHeight + 'px'} : null"></div>
    <div v-if="menu.open" class="mention-menu" :style="{top: menu.top + 'px', left: menu.left + 'px'}">
      <template v-for="(it, i) in menu.items" :key="it.type + it.id"><div v-if="!i || menu.items[i - 1].type !== it.type" class="mi-group">{{ it.type === 'askai' ? 'AI' : types[it.type].plural }}</div>
      <div class="mi" :class="{active: i === menu.index}"
           @mousedown.prevent="pick(it)" @mouseenter="menu.index = i">
        <icon :name="it.type === 'askai' ? 'sparkles' : it.agent ? 'bot' : types[it.type].icon" :size="14"/><span class="mi-label"><math-text :text="it.label"/></span><small>{{ it.sub }}</small>
      </div></template>
      <div v-if="!menu.items.length" class="mi empty">No match for “{{ menu.query }}”</div>
      <div class="mi-hint">Narrow with <code>fact:</code> <code>q:</code> <code>file:</code> <code>msg:</code> <code>lean:</code></div>
    </div>
  </div>`,
  created() { this.types = REF_TYPES; },
  mounted() {
    const toolbar = this.compact
      ? [['bold', 'italic', 'code'], ['link', 'blockquote'], [{ list: 'bullet' }]]
      : [['bold', 'italic', 'underline', 'strike'], [{ header: 2 }, { header: 3 }], ['blockquote', 'code-block', 'code'],
         [{ list: 'ordered' }, { list: 'bullet' }], [{ script: 'sub' }, { script: 'super' }], ['link', 'clean']];
    const q = new Quill(this.$refs.editor, {
      theme: 'snow',
      placeholder: this.placeholder,
      formats: FORMATS,
      modules: { toolbar },
    });
    this.q = Vue.markRaw(q);
    const bar = q.getModule('toolbar').container;
    bar.querySelector('.ql-code-block')?.setAttribute('title', 'Code block');
    bar.querySelector('.ql-code')?.setAttribute('title', 'Inline code');
    if (this.initialHtml) this.setHTML(this.initialHtml);
    q.on('text-change', (_d, _o, source) => {
      this.$emit('change');
      // The selection is only updated after text-change: check on the next tick.
      if (source === 'user') setTimeout(() => this.checkMention(), 0);
    });
    q.on('selection-change', (range) => { if (!range) this.close(); });
    // Capture phase on the container so we run before Quill's own keyboard handling.
    this.$refs.editor.addEventListener('keydown', this.onKey, true);
    if (this.autofocus) this.$nextTick(() => this.focus());
  },
  beforeUnmount() { this.$refs.editor?.removeEventListener('keydown', this.onKey, true); },
  methods: {
    onKey(e) {
      if (this.menu.open) {
        const n = this.menu.items.length;
        if (e.key === 'ArrowDown' && n) { this.menu.index = (this.menu.index + 1) % n; this.reveal(); this.stop(e); return; }
        if (e.key === 'ArrowUp' && n) { this.menu.index = (this.menu.index - 1 + n) % n; this.reveal(); this.stop(e); return; }
        if ((e.key === 'Enter' || e.key === 'Tab') && n) { this.pick(this.menu.items[this.menu.index]); this.stop(e); return; }
        if (e.key === 'Escape') { this.close(); this.stop(e); return; }
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { this.stop(e); this.$emit('submit'); return; }
      if (e.key === 'Escape') this.$emit('cancel');
    },
    stop(e) { e.preventDefault(); e.stopImmediatePropagation(); },
    checkMention() {
      const sel = this.q.getSelection();
      if (!sel) return this.close();
      const start = Math.max(0, sel.index - 80);
      const before = this.q.getText(start, sel.index - start);
      const query = mentionQuery(before);
      if (query === null) return this.close();
      const parsed = parseRefQuery(query);
      const local = this.search(parsed.term).filter((x) => !parsed.type || x.type === parsed.type);
      const items = this.withAskAi(query, mentionMatches(query, sortRefs(local)));
      if (items === null) return this.close();
      this.menu.query = query;
      this.menu.start = sel.index - query.length - 1;
      this.menu.items = items;
      this.menu.index = 0;
      const b = this.q.getBounds(this.menu.start);
      const c = this.$refs.editor;
      this.menu.top = c.offsetTop + b.top + b.height + 4;
      this.menu.left = Math.max(0, Math.min(c.offsetLeft + b.left, c.clientWidth - 340));
      this.menu.open = true;
      this.fetchRefs(query, parsed);
    },
    /** Every other kind of object comes from the server, which applies the reader's access. */
    fetchRefs(query, parsed) {
      clearTimeout(this.refTimer);
      this.refTimer = setTimeout(async () => {
        const found = await searchRefs(parsed.term, parsed.type);
        if (!this.menu.open || this.menu.query !== query) return;
        const rows = found.filter((x) => x.state === 'ok').map((x) => ({ type: x.type, id: x.id, label: x.label, sub: x.type === 'user' ? x.subtitle : (x.subtitle || x.title), agent: x.status === 'agent' }));
        const items = this.withAskAi(query, mentionMatches(query, sortRefs(rows)));
        if (items === null) return this.close();
        const current = this.menu.items[this.menu.index];
        this.menu.items = items;
        const at = current ? items.findIndex((x) => x.type === current.type && x.id === current.id) : 0;
        this.menu.index = Math.max(0, at);
      }, 130);
    },
    reveal() { this.$nextTick(() => this.$el.querySelector('.mi.active')?.scrollIntoView({ block: 'nearest' })); },
    search(query) {
      const q = query.toLowerCase();
      const has = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(q));
      const mm = store.mentionables;
      return [
        ...mm.users.filter((u) => has(u.name, u.orcid)).slice(0, 6)
          .map((u) => ({ type: 'user', id: u.id, label: u.name, sub: u.kind === 'agent' ? 'AI agent' : u.orcid, agent: u.kind === 'agent' })),
        ...(mm.questions || []).filter((x) => has(x.title)).slice(0, 5)
          .map((x) => ({ type: 'question', id: x.id, label: x.title, sub: 'Question' })),
        ...(mm.strategies || []).filter((x) => has(x.title, x.question)).slice(0, 5)
          .map((x) => ({ type: 'strategy', id: x.id, label: x.title, sub: 'Strategy' })),
        ...(mm.facts || []).filter((f) => has(f.label, f.title)).slice(0, 6)
          .map((f) => ({ type: 'fact', id: f.id, label: f.label, sub: f.title })),
        ...mm.documents.filter((d) => has(d.title)).slice(0, 5)
          .map((d) => ({ type: 'document', id: d.id, label: d.title, sub: d.origin === 'ai' ? 'AI file' : 'Human file' })),
        ...mm.bib.filter((b) => has(b.cite_key, b.title, b.authors)).slice(0, 5)
          .map((b) => ({ type: 'bib', id: b.id, label: b.title || b.cite_key, sub: b.cite_key })),
      ];
    },
    withAskAi(query, items) {
      if (items === null || !offersAskAi(query)) return items;
      return [{ type: 'askai', id: 0, label: 'Ask AI', sub: 'Any member’s AI client answers here' }, ...items];
    },
    pick(it) {
      const len = this.menu.query.length + 1;
      const at = this.menu.start;
      this.q.deleteText(at, len, 'user');
      if (it.type === 'askai') {
        this.q.insertText(at, '@AI ', 'user');
        this.q.setSelection(at + 4, 0, 'user');
        this.close();
        return;
      }
      this.q.insertEmbed(at, 'mention', { type: it.type, id: it.id, label: it.label }, 'user');
      this.q.insertText(at + 1, ' ', 'user');
      this.q.setSelection(at + 2, 0, 'user');
      this.close();
    },
    close() { this.menu.open = false; },
    isEmpty() {
      return this.q.getContents().ops.every((op) => typeof op.insert === 'string' && !op.insert.trim());
    },
    getHTML() { return this.isEmpty() ? '' : this.q.getSemanticHTML(); },
    setHTML(html) {
      this.q.setContents(this.q.clipboard.convert({ html: html || '' }), 'silent');
    },
    clear() { this.q.setContents([], 'silent'); this.close(); },
    /** Makes the draft a visible question to the AI. */
    askAi() {
      const add = askAiPrefix(this.isEmpty() ? '' : this.q.getText());
      if (add) this.q.insertText(0, add, 'user');
    },
    focus() { this.q.focus(); this.q.setSelection(this.q.getLength(), 0); },
  },
};

const MATH_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false },
];

export function renderMath(el) {
  if (window.renderMathInElement) {
    window.renderMathInElement(el, { delimiters: MATH_DELIMITERS, throwOnError: false, ignoredClasses: ['mention'] });
  }
}

/** One line of plain text with its LaTeX rendered, for titles and previews in lists. */
export const MathText = {
  props: { text: String, highlight: Array },
  template: `<span class="math-text" ref="el"></span>`,
  mounted() { this.paint(); },
  beforeUnmount() { clearTimeout(this.retry); },
  watch: { text() { this.paint(); }, highlight() { this.paint(); } },
  methods: {
    paint() {
      const el = this.$refs.el;
      if (!el) return;
      el.textContent = String(this.text || '').replace(/@\{\w+:([^}]+)\}/g, '$1').replace(/\$\$/g, '$');
      if (el.textContent.includes('$') || el.textContent.includes('\\(')) {
        if (window.renderMathInElement) {
          window.renderMathInElement(el, { delimiters: [{ left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }], throwOnError: false });
        } else {
          this.retry = setTimeout(() => this.paint(), 400); // KaTeX is loaded with defer
        }
      }
      markTerms(el, this.highlight);
    },
  },
};

/** Displays sanitized rich text coming from the server. */
export const RichContent = {
  props: { html: String },
  template: `<div class="rich" v-html="html" @click="onClick" @keydown.enter="onClick"></div>`,
  mounted() { this.decorate(); },
  watch: { html() { this.$nextTick(() => this.decorate()); } },
  methods: {
    decorate() {
      const el = this.$el;
      el.querySelectorAll('.mention').forEach((n) => {
        n.classList.add('mention-' + n.dataset.type);
        if (n.dataset.type === 'user' && +n.dataset.id === store.user?.id) n.classList.add('me');
      });
      hydrateChips(el);
      if (window.renderMathInElement) renderMath(el);
      else setTimeout(() => renderMath(el), 500); // KaTeX is loaded with defer
    },
    onClick(e) {
      const m = e.target.closest('.mention');
      if (!m) return;
      e.preventDefault();
      openChip(m);
    },
  },
};
