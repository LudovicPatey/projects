// Rich-text editor (Quill 2) with @mentions of researchers, files and bibliography entries,
// and a renderer for stored rich text (KaTeX for $...$ math, clickable mentions).
import { store, go } from './store.js';
import { escapeHtml } from './util.js';

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

const FORMATS = ['bold', 'italic', 'underline', 'strike', 'link', 'blockquote', 'code-block', 'code', 'list', 'header', 'indent', 'mention', 'script'];

const MENTION_ICONS = { user: 'user', document: 'files', bib: 'book', fact: 'graph' };

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
      <div v-for="(it, i) in menu.items" :key="it.type + it.id" class="mi" :class="{active: i === menu.index}"
           @mousedown.prevent="pick(it)" @mouseenter="menu.index = i">
        <icon :name="it.agent ? 'bot' : icons[it.type]" :size="14"/><span class="mi-label">{{ it.label }}</span><small>{{ it.sub }}</small>
      </div>
      <div v-if="!menu.items.length" class="mi empty">No match for “{{ menu.query }}”</div>
    </div>
  </div>`,
  created() { this.icons = MENTION_ICONS; },
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
        if (e.key === 'ArrowDown' && n) { this.menu.index = (this.menu.index + 1) % n; this.stop(e); return; }
        if (e.key === 'ArrowUp' && n) { this.menu.index = (this.menu.index - 1 + n) % n; this.stop(e); return; }
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
      const start = Math.max(0, sel.index - 60);
      const before = this.q.getText(start, sel.index - start);
      const m = before.match(/(?:^|\s)@([^\s@]{0,40})$/u);
      if (!m) return this.close();
      this.menu.query = m[1];
      this.menu.start = sel.index - m[1].length - 1;
      this.menu.items = this.search(m[1]);
      this.menu.index = 0;
      const b = this.q.getBounds(this.menu.start);
      const c = this.$refs.editor;
      this.menu.top = c.offsetTop + b.top + b.height + 4;
      this.menu.left = Math.max(0, Math.min(c.offsetLeft + b.left, c.clientWidth - 260));
      this.menu.open = true;
    },
    search(query) {
      const q = query.toLowerCase();
      const has = (...xs) => xs.some((x) => String(x || '').toLowerCase().includes(q));
      const mm = store.mentionables;
      return [
        ...mm.users.filter((u) => has(u.name, u.orcid)).slice(0, 6)
          .map((u) => ({ type: 'user', id: u.id, label: u.name, sub: u.kind === 'agent' ? 'AI agent' : u.orcid, agent: u.kind === 'agent' })),
        ...(mm.facts || []).filter((f) => has(f.label, f.title)).slice(0, 6)
          .map((f) => ({ type: 'fact', id: f.id, label: f.label, sub: f.title })),
        ...mm.documents.filter((d) => has(d.title)).slice(0, 5)
          .map((d) => ({ type: 'document', id: d.id, label: d.title, sub: d.origin === 'ai' ? 'AI file' : 'Human file' })),
        ...mm.bib.filter((b) => has(b.cite_key, b.title, b.authors)).slice(0, 5)
          .map((b) => ({ type: 'bib', id: b.id, label: b.cite_key, sub: b.title })),
      ];
    },
    pick(it) {
      const len = this.menu.query.length + 1;
      const at = this.menu.start;
      this.q.deleteText(at, len, 'user');
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
  props: { text: String },
  template: `<span class="math-text" ref="el"></span>`,
  mounted() { this.paint(); },
  beforeUnmount() { clearTimeout(this.retry); },
  watch: { text() { this.paint(); } },
  methods: {
    paint() {
      const el = this.$refs.el;
      if (!el) return;
      el.textContent = String(this.text || '').replace(/@\{\w+:([^}]+)\}/g, '$1').replace(/\$\$/g, '$');
      if (!el.textContent.includes('$') && !el.textContent.includes('\\(')) return;
      if (window.renderMathInElement) {
        window.renderMathInElement(el, { delimiters: [{ left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }], throwOnError: false });
      } else {
        this.retry = setTimeout(() => this.paint(), 400); // KaTeX is loaded with defer
      }
    },
  },
};

/** Displays sanitized rich text coming from the server. */
export const RichContent = {
  props: { html: String },
  template: `<div class="rich" v-html="html" @click="onClick"></div>`,
  mounted() { this.decorate(); },
  watch: { html() { this.$nextTick(() => this.decorate()); } },
  methods: {
    decorate() {
      const el = this.$el;
      el.querySelectorAll('.mention').forEach((n) => {
        n.classList.add('mention-' + n.dataset.type);
        if (n.dataset.type === 'user' && +n.dataset.id === store.user?.id) n.classList.add('me');
      });
      if (window.renderMathInElement) renderMath(el);
      else setTimeout(() => renderMath(el), 500); // KaTeX is loaded with defer
    },
    onClick(e) {
      const m = e.target.closest('.mention');
      if (!m) return;
      const pid = store.project?.id;
      const { type, id } = m.dataset;
      if (type === 'document') go(`/p/${pid}/files/${id}`);
      else if (type === 'bib') go(`/p/${pid}/bib/${id}`);
      else if (type === 'fact') go(`/p/${pid}/facts/${id}`);
      else if (type === 'user') go(`/p/${pid}/members?user=${id}`);
    },
  },
};
