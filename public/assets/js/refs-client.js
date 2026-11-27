// Live references: chips show what the current reader may see, with a preview card on hover.
import { api } from './api.js';
import { store, go, toast } from './store.js';
import { ICONS } from './components.js';
import { uprightScriptWords } from './bare-tex.js';
import { REF_TYPES, refHref, refKey, statusInfo } from './references.js';

const TTL = 60000;
const cache = new Map();
let queue = new Map();
let timer = null;

const svg = (name, size = 12) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

async function flush() {
  timer = null;
  const pid = store.project?.id;
  const batch = queue;
  queue = new Map();
  if (!pid) { for (const waiters of batch.values()) waiters.forEach((w) => w(null)); return; }
  const keys = [...batch.keys()];
  for (let i = 0; i < keys.length; i += 60) {
    const part = keys.slice(i, i + 60);
    let refs = {};
    try { refs = (await api.get(`api/projects/${pid}/refs/resolve?keys=${encodeURIComponent(part.join(','))}`)).refs; } catch { /* the chip keeps its stored label */ }
    for (const k of part) {
      if (refs[k]) cache.set(`${pid}|${k}`, { at: Date.now(), item: refs[k] });
      batch.get(k).forEach((w) => w(refs[k] || null));
    }
  }
}

export function getRef(key) {
  const hit = cache.get(`${store.project?.id}|${key}`);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.item);
  return new Promise((resolve) => {
    if (!queue.has(key)) queue.set(key, []);
    queue.get(key).push(resolve);
    if (!timer) timer = setTimeout(flush, 30);
  });
}

export async function searchRefs(term, type) {
  const pid = store.project?.id;
  if (!pid) return [];
  const p = new URLSearchParams({ q: term });
  if (type) p.set('type', type);
  try { return (await api.get(`api/projects/${pid}/refs?${p}`)).results; } catch { return []; }
}

function paintLabel(el, text) {
  el.textContent = text;
  if (text.includes('$') && window.renderMathInElement) {
    window.renderMathInElement(el, { delimiters: [{ left: '$', right: '$', display: false }], throwOnError: false, preProcess: uprightScriptWords });
  }
}

/** Turns stored chips into live ones. Text and titles only ever go through textContent. */
export function hydrateChips(root) {
  root.querySelectorAll('.mention[data-type]').forEach(async (n) => {
    const type = n.dataset.type;
    const meta = REF_TYPES[type];
    if (!meta) return;
    if (!n.dataset.live) {
      n.dataset.live = '1';
      n.setAttribute('role', 'link');
      n.setAttribute('tabindex', '0');
      n.innerHTML = `${svg(meta.icon)}<span class="ref-label"></span>`;
      paintLabel(n.querySelector('.ref-label'), n.dataset.label || '');
    }
    const item = await getRef(refKey(type, n.dataset.id));
    if (!item || !n.isConnected) return;
    n.classList.toggle('ref-private', item.state === 'private');
    n.classList.toggle('ref-missing', item.state === 'missing');
    if (item.state === 'private') n.querySelector('svg').outerHTML = svg('lock');
    paintLabel(n.querySelector('.ref-label'), item.label);
    n.setAttribute('aria-label', `${meta.label}: ${item.label}`);
    n.querySelector('.ref-dot')?.remove();
    const s = statusInfo(item.state === 'ok' && type !== 'user' ? item.status : null);
    if (s) {
      const dot = document.createElement('i');
      dot.className = `ref-dot t-${s.tone}`;
      dot.title = s.label;
      n.appendChild(dot);
    }
  });
}

export async function openChip(n) {
  const item = await getRef(refKey(n.dataset.type, n.dataset.id));
  const href = item?.state === 'ok' ? refHref(item, store.project?.id) : null;
  if (href) go(href.slice(1));
  else toast(item?.state === 'private' ? 'This is private: you do not take part in that conversation.' : 'This item no longer exists.', 'error');
}

/** Preview card shown when a reference is hovered or focused. */
export const RefPreview = {
  data() { return { item: null, pos: { left: 0, top: 0 } }; },
  computed: {
    meta() { return this.item ? REF_TYPES[this.item.type] : null; },
    status() { return this.item?.state === 'ok' ? statusInfo(this.item.status) : null; },
    href() { return this.item?.state === 'ok' ? refHref(this.item, store.project?.id) : null; },
    heading() { return this.item?.title || this.item?.label; },
    hint() { return this.item?.state === 'private' ? 'Only its participants can read it.' : 'It has been deleted.'; },
  },
  mounted() {
    this.over = (e) => {
      const chip = e.target.closest?.('.rich .mention[data-type], .rich .fact-ref[data-type]');
      if (chip) { clearTimeout(this.hideT); clearTimeout(this.showT); this.showT = setTimeout(() => this.show(chip), e.type === 'focusin' ? 0 : 220); return; }
      if (e.target.closest?.('.ref-card')) { clearTimeout(this.hideT); return; }
      clearTimeout(this.showT);
      if (this.item) { clearTimeout(this.hideT); this.hideT = setTimeout(() => { this.item = null; }, 180); }
    };
    this.key = (e) => { if (e.key === 'Escape') this.item = null; };
    this.close = () => { clearTimeout(this.showT); this.item = null; };
    document.addEventListener('mouseover', this.over);
    document.addEventListener('focusin', this.over);
    document.addEventListener('keydown', this.key);
    window.addEventListener('hashchange', this.close);
  },
  unmounted() {
    document.removeEventListener('mouseover', this.over);
    document.removeEventListener('focusin', this.over);
    document.removeEventListener('keydown', this.key);
    window.removeEventListener('hashchange', this.close);
  },
  methods: {
    async show(chip) {
      const item = await getRef(refKey(chip.dataset.type, chip.dataset.id));
      if (!item || !chip.isConnected) return;
      const r = chip.getBoundingClientRect();
      const width = Math.min(340, innerWidth - 24);
      const left = Math.max(12, Math.min(r.left, innerWidth - width - 12));
      const below = r.bottom + 230 < innerHeight;
      this.pos = below ? { left: left + 'px', top: r.bottom + 6 + 'px', width: width + 'px' } : { left: left + 'px', bottom: innerHeight - r.top + 6 + 'px', width: width + 'px' };
      this.item = item;
    },
  },
  template: `<aside v-if="item" class="ref-card" :style="pos" role="tooltip">
    <header><span class="ref-type"><icon :name="item.state === 'private' ? 'lock' : meta.icon" :size="13"/> {{ meta.label }}</span><span v-if="status" class="pill" :class="'t-' + status.tone">{{ status.label }}</span></header>
    <h4><math-text :text="heading"/></h4>
    <template v-if="item.state === 'ok'">
      <p v-if="item.subtitle" class="ref-sub"><math-text :text="item.subtitle"/></p>
      <p v-if="item.excerpt" class="ref-excerpt"><math-text :text="item.excerpt" :macros="item.tex_macros"/></p>
      <footer><span v-if="item.by" class="muted small">{{ item.by }}</span><ai-meta :model="item.ai_model" compact/><span class="grow"></span><a v-if="href" :href="href" class="link-btn">Open <icon name="external" :size="11"/></a></footer>
    </template>
    <p v-else class="ref-excerpt">{{ hint }}</p>
  </aside>`,
};
