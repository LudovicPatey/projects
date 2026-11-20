// PDF viewer based on PDF.js: lazy page rendering, selectable text layer,
// highlight overlay for anchored comments, and text-selection → comment.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build';
let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS}/pdf.min.mjs`).then((m) => {
      m.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
      return m;
    });
  }
  return pdfjsPromise;
}

function mergeRects(rects) {
  rects.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last && Math.abs(r[1] - last[1]) < 0.004 && Math.abs(r[3] - last[3]) < 0.01 && r[0] <= last[0] + last[2] + 0.012) {
      const right = Math.max(last[0] + last[2], r[0] + r[2]);
      last[0] = Math.min(last[0], r[0]);
      last[2] = right - last[0];
    } else out.push([...r]);
  }
  return out.map((r) => r.map((v) => Math.round(v * 100000) / 100000));
}

export const PdfViewer = {
  props: {
    src: String,
    downloadUrl: String,
    highlights: { type: Array, default: () => [] }, // [{id, page, rects:[[x,y,w,h]...], resolved}]
    activeId: [Number, String],
  },
  emits: ['selection', 'highlight-click'],
  data() { return { numPages: 0, zoom: 1, currentPage: 1, loading: false, error: null }; },
  template: `<div class="pdfv">
    <div class="pdfv-bar">
      <button class="icon-btn sm" @click="setZoom(zoom / 1.2)" title="Zoom out"><icon name="zoom-out" :size="16"/></button>
      <span class="pdfv-zoom">{{ Math.round(zoom * 100) }}%</span>
      <button class="icon-btn sm" @click="setZoom(zoom * 1.2)" title="Zoom in"><icon name="zoom-in" :size="16"/></button>
      <button class="btn ghost xs" @click="setZoom(1)">Fit width</button>
      <span class="grow"></span>
      <span class="muted small" v-if="numPages">Page {{ currentPage }} / {{ numPages }}</span>
      <a v-if="src" class="icon-btn sm" :href="src" target="_blank" title="Open in a new tab"><icon name="external" :size="16"/></a>
      <a v-if="downloadUrl" class="icon-btn sm" :href="downloadUrl" title="Download"><icon name="download" :size="16"/></a>
    </div>
    <div class="pdfv-scroll" ref="scroll" @mouseup="onMouseUp" @scroll.passive="onScroll">
      <div v-if="loading" class="pdfv-msg">Loading PDF…</div>
      <div v-if="error" class="pdfv-msg error">{{ error }}</div>
      <div class="pdfv-pages" ref="pages"></div>
    </div>
  </div>`,
  created() { this.r = Vue.markRaw({ doc: null, task: null, pageEls: [], sizes: [], rendered: new Set(), token: 0, observer: null, width: 0 }); },
  mounted() {
    this.load();
    this.ro = new ResizeObserver(() => {
      const w = this.$refs.scroll?.clientWidth || 0;
      if (this.r.doc && Math.abs(w - this.r.width) > 40) {
        clearTimeout(this.roTimer);
        this.roTimer = setTimeout(() => this.layout(), 150);
      }
    });
    this.ro.observe(this.$refs.scroll);
  },
  beforeUnmount() {
    this.ro?.disconnect();
    this.r.observer?.disconnect();
    this.r.task?.destroy();
  },
  watch: {
    src() { this.load(); },
    highlights: { deep: true, handler() { this.redrawHighlights(); } },
    activeId() { this.redrawHighlights(); },
  },
  methods: {
    async load() {
      const r = this.r;
      r.observer?.disconnect();
      if (r.task) { r.task.destroy(); r.task = null; }
      r.doc = null; r.sizes = []; this.numPages = 0; this.error = null;
      this.$refs.pages.innerHTML = '';
      if (!this.src) return;
      this.loading = true;
      try {
        const lib = await pdfjs();
        r.task = lib.getDocument({ url: this.src, withCredentials: true, disableRange: true, disableStream: true, isEvalSupported: false });
        const doc = await r.task.promise;
        r.doc = doc;
        const first = await doc.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        r.sizes[1] = { w: vp.width, h: vp.height };
        this.numPages = doc.numPages;
        this.layout();
      } catch (e) {
        if (e?.name !== 'AbortException') this.error = 'Could not load the PDF: ' + (e.message || e);
      } finally {
        this.loading = false;
      }
    },
    scale() {
      const base = this.r.sizes[1]?.w || 600;
      return Math.max(0.2, ((this.r.width - 32) / base) * this.zoom);
    },
    layout() {
      const r = this.r;
      if (!r.doc) return;
      r.token++;
      r.width = this.$refs.scroll.clientWidth;
      const scale = this.scale();
      const pagesEl = this.$refs.pages;
      const keepTop = this.$refs.scroll.scrollTop / Math.max(1, this.$refs.scroll.scrollHeight);
      pagesEl.innerHTML = '';
      r.pageEls = []; r.rendered = new Set();
      r.observer?.disconnect();
      r.observer = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.renderPage(+e.target.dataset.page);
      }, { root: this.$refs.scroll, rootMargin: '600px 0px' });
      for (let n = 1; n <= r.doc.numPages; n++) {
        const size = r.sizes[n] || r.sizes[1];
        const div = document.createElement('div');
        div.className = 'pv-page';
        div.dataset.page = n;
        div.style.width = size.w * scale + 'px';
        div.style.height = size.h * scale + 'px';
        pagesEl.appendChild(div);
        r.pageEls[n] = div;
        r.observer.observe(div);
      }
      this.$refs.scroll.scrollTop = keepTop * this.$refs.scroll.scrollHeight;
    },
    async renderPage(n) {
      const r = this.r;
      if (r.rendered.has(n)) return;
      r.rendered.add(n);
      const token = r.token;
      const lib = await pdfjs();
      const page = await r.doc.getPage(n);
      if (token !== r.token) return;
      const base = page.getViewport({ scale: 1 });
      r.sizes[n] = { w: base.width, h: base.height };
      const vp = page.getViewport({ scale: this.scale() });
      const div = r.pageEls[n];
      div.innerHTML = '';
      div.style.width = vp.width + 'px';
      div.style.height = vp.height + 'px';
      div.style.setProperty('--scale-factor', vp.scale);
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      const hl = document.createElement('div');
      hl.className = 'pv-hl';
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      div.append(canvas, hl, tl);
      try {
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
        if (token !== r.token) return;
        const textLayer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
        await textLayer.render();
      } catch (e) { console.warn('render page', n, e); }
      this.drawHighlights(n);
    },
    drawHighlights(n) {
      const div = this.r.pageEls[n];
      const layer = div?.querySelector('.pv-hl');
      if (!layer) return;
      layer.innerHTML = '';
      for (const h of this.highlights) {
        if (+h.page !== n || !h.rects) continue;
        for (const [x, y, w, hh] of h.rects) {
          const el = document.createElement('div');
          el.className = 'pv-hl-rect' + (h.id === this.activeId ? ' active' : '') + (h.resolved ? ' resolved' : '') + (h.id === 'pending' ? ' pending' : '');
          Object.assign(el.style, { left: x * 100 + '%', top: y * 100 + '%', width: w * 100 + '%', height: hh * 100 + '%' });
          layer.appendChild(el);
        }
      }
    },
    redrawHighlights() { for (const n of this.r.rendered) this.drawHighlights(n); },
    setZoom(z) { this.zoom = Math.min(4, Math.max(0.3, z)); this.layout(); },
    onScroll() {
      const st = this.$refs.scroll.scrollTop + this.$refs.scroll.clientHeight / 3;
      const els = this.r.pageEls;
      for (let n = 1; n < els.length; n++) {
        if (els[n] && els[n].offsetTop + els[n].offsetHeight > st) { this.currentPage = n; break; }
      }
    },
    onMouseUp(e) {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return this.hitTest(e);
        const range = sel.getRangeAt(0);
        const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        const pageEl = node?.closest('.pv-page');
        if (!pageEl || !this.$refs.pages.contains(pageEl)) return;
        const pr = pageEl.getBoundingClientRect();
        const rects = [];
        for (const cr of range.getClientRects()) {
          const x1 = Math.max(cr.left, pr.left), y1 = Math.max(cr.top, pr.top);
          const x2 = Math.min(cr.right, pr.right), y2 = Math.min(cr.bottom, pr.bottom);
          if (x2 - x1 < 1 || y2 - y1 < 1) continue;
          if ((y2 - y1) / pr.height > 0.08) continue; // ignore layout boxes
          rects.push([(x1 - pr.left) / pr.width, (y1 - pr.top) / pr.height, (x2 - x1) / pr.width, (y2 - y1) / pr.height]);
        }
        const quote = sel.toString().replace(/\s+/g, ' ').trim();
        if (!quote || !rects.length) return;
        this.$emit('selection', { page: +pageEl.dataset.page, quote: quote.slice(0, 2000), rects: mergeRects(rects).slice(0, 80) });
      }, 0);
    },
    hitTest(e) {
      const pageEl = e.target.closest?.('.pv-page');
      if (!pageEl) return;
      const pr = pageEl.getBoundingClientRect();
      const x = (e.clientX - pr.left) / pr.width, y = (e.clientY - pr.top) / pr.height;
      const n = +pageEl.dataset.page;
      const hit = this.highlights.find((h) => +h.page === n && h.id !== 'pending' && h.rects?.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh));
      if (hit) this.$emit('highlight-click', hit.id);
    },
    scrollToHighlight(id) {
      const h = this.highlights.find((x) => x.id === id);
      if (!h) return;
      const el = this.r.pageEls[h.page];
      if (!el) return;
      const top = el.offsetTop + (h.rects?.[0]?.[1] || 0) * el.offsetHeight - 120;
      this.$refs.scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    },
  },
};
