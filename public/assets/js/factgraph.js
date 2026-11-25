// Dependency graph of the fact database, drawn on a canvas so it stays fluid with
// thousands of facts. Layered layout: a fact sits below everything it depends on.
// Only what is on screen is drawn, labels are fitted once, and a grid finds the fact under the pointer.
// Starred facts stand out, and keep their name when the graph is zoomed out.
export const STATUS = {
  unchecked: { label: 'Unchecked', color: '#667085', bg: '#f2f4f7' },
  ai_checked: { label: 'AI-checked', color: '#7c3aed', bg: '#f3edff' },
  human_checked: { label: 'Human-checked', color: '#0f766e', bg: '#e6f6f3' },
  double_checked: { label: 'Human + AI checked', color: '#15803d', bg: '#dcfce7' },
  accepted: { label: 'Citation accepted', color: '#0f766e', bg: '#e6f6f3' },
  source_confirmed: { label: 'Source confirmed by AI', color: '#7c3aed', bg: '#f3edff' },
  definition: { label: 'Definition', color: '#475467', bg: '#eef0f3' },
  proof_disputed: { label: 'Proof disputed', color: '#a16207', bg: '#fef9c3' },
  disputed: { label: 'Disputed', color: '#b45309', bg: '#fff6e6' },
  retracted: { label: 'Retracted', color: '#b42318', bg: '#fdecea' },
};

export const PROOF_COLOR = { human: '#0f766e', ai: '#7c3aed', mixed: '#d97706', none: '#98a2b3' };
export const PROOF_LABEL = { human: 'Human proof', ai: 'AI proof', mixed: 'Human + AI proof', none: 'No proof' };

const W = 204, H = 50, GAP_X = 26, GAP_Y = 62, CELL = 256;

function layout(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const deps = new Map(nodes.map((n) => [n.id, []]));
  const users = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edges) {
    if (ids.has(a) && ids.has(b)) { deps.get(a).push(b); users.get(b).push(a); }
  }
  // Longest path from the roots (Kahn's algorithm).
  const level = new Map(nodes.map((n) => [n.id, 0]));
  const left = new Map(nodes.map((n) => [n.id, deps.get(n.id).length]));
  const queue = nodes.filter((n) => !left.get(n.id)).map((n) => n.id);
  for (let i = 0; i < queue.length; i++) {
    for (const u of users.get(queue[i])) {
      level.set(u, Math.max(level.get(u), level.get(queue[i]) + 1));
      left.set(u, left.get(u) - 1);
      if (!left.get(u)) queue.push(u);
    }
  }
  const layers = [];
  for (const n of nodes) (layers[level.get(n.id)] ||= []).push(n.id);
  // Barycenter sweeps reduce edge crossings.
  const order = new Map();
  const index = () => layers.forEach((l) => l?.forEach((id, i) => order.set(id, i - (l.length - 1) / 2)));
  index();
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0;
    const seq = down ? layers : [...layers].reverse();
    for (const l of seq) {
      if (!l) continue;
      const score = new Map(l.map((id) => {
        const near = (down ? deps : users).get(id);
        return [id, near.length ? near.reduce((s, x) => s + order.get(x), 0) / near.length : order.get(id)];
      }));
      l.sort((a, b) => score.get(a) - score.get(b));
      l.forEach((id, i) => order.set(id, i - (l.length - 1) / 2));
    }
  }
  const pos = new Map();
  layers.forEach((l, y) => l?.forEach((id) => pos.set(id, { x: order.get(id) * (W + GAP_X), y: y * (H + GAP_Y) })));
  // A grid of the canvas, so that finding the fact under the pointer does not scan them all.
  const grid = new Map();
  for (const [id, q] of pos) {
    const key = `${Math.floor(q.x / CELL)},${Math.floor(q.y / CELL)}`;
    (grid.get(key) || grid.set(key, []).get(key)).push(id);
  }
  return { pos, deps, users, grid };
}

function reach(start, next) {
  const seen = new Set();
  const stack = [...(next.get(start) || [])];
  while (stack.length) {
    const x = stack.pop();
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(next.get(x) || []));
  }
  return seen;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function fit(c, text, max) {
  if (c.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (c.measureText(text.slice(0, m) + '…').width <= max) lo = m; else hi = m - 1;
  }
  return text.slice(0, lo) + '…';
}

export const FactGraph = {
  props: { nodes: Array, edges: Array, selected: Number, unread: Object, emphasis: { type: Boolean, default: true } },
  emits: ['select'],
  data() { return { zoomPct: 100, hint: null }; },
  template: `<div class="fg" ref="box">
    <canvas ref="canvas" role="img" :aria-label="'Dependency graph of ' + nodes.length + ' facts, ' + nodes.filter((n) => n.stars).length + ' starred'"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointerleave="leave" @wheel.prevent="wheel"></canvas>
    <div class="fg-tools">
      <button class="icon-btn sm" title="Zoom in" @click="zoomBy(1.25)"><icon name="zoom-in" :size="16"/></button>
      <span class="pdfv-zoom">{{ zoomPct }}%</span>
      <button class="icon-btn sm" title="Zoom out" @click="zoomBy(0.8)"><icon name="zoom-out" :size="16"/></button>
      <button class="btn xs" @click="fitView">Fit</button>
    </div>
    <div v-if="hint" class="fg-hint" :style="{left: hint.x + 'px', top: hint.y + 'px'}">
      <b>{{ hint.n.label }}</b><span v-if="hint.n.stars" class="fg-hint-star"> ★ {{ hint.n.stars }}</span><div>{{ hint.n.title }}</div>
      <div class="muted small">{{ proofLabel[hint.n.proof_origin] }} · entered by {{ hint.n.ai_model }} · {{ status[hint.n.status].label }}</div>
      <div class="muted small" v-if="hint.n.labels.length">{{ hint.n.labels.join(', ').replaceAll('_', ' ') }}</div>
    </div>
  </div>`,
  created() { this.status = STATUS; this.proofLabel = PROOF_LABEL; this.view = { x: 0, y: 0, k: 1 }; this.drag = null; this.g = null; },
  mounted() {
    this.rebuild(true);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.$refs.box);
    this.resize();
  },
  beforeUnmount() { this.ro?.disconnect(); cancelAnimationFrame(this.raf); },
  watch: {
    nodes() { this.rebuild(); },
    edges() { this.rebuild(); },
    selected() { this.computeFocus(); this.reveal(); this.draw(); },
    unread() { this.draw(); },
  },
  methods: {
    /** Polling replaces the arrays: keep the user's view unless the set of facts changed. */
    rebuild(first = false) {
      const sig = this.nodes.map((n) => n.id).join(',');
      const changed = sig !== this.sig;
      this.sig = sig;
      this.g = layout(this.nodes, this.edges);
      this.byId = new Map(this.nodes.map((n) => [n.id, n]));
      this.labels = new Map(); // fitted once per fact, not at every frame
      this.computeFocus();
      if (first || changed) this.fitView(); else this.draw();
    },
    /** Pans just enough to bring the selected fact into view. */
    reveal() {
      const p = this.selected && this.g.pos.get(this.selected);
      const box = this.$refs.box;
      if (!p || !box?.clientWidth) return;
      const v = this.view, m = 16;
      const l = v.x + (p.x - W / 2) * v.k, r = v.x + (p.x + W / 2) * v.k;
      const t = v.y + (p.y - H / 2) * v.k, b = v.y + (p.y + H / 2) * v.k;
      if (r - l > box.clientWidth - 2 * m || l < m) v.x += m - l;
      else if (r > box.clientWidth - m) v.x -= r - box.clientWidth + m;
      if (t < m) v.y += m - t;
      else if (b > box.clientHeight - m) v.y -= b - box.clientHeight + m;
    },
    computeFocus() {
      const s = this.selected;
      this.focus = s && this.g.pos.has(s) ? { up: reach(s, this.g.deps), down: reach(s, this.g.users) } : null;
    },
    resize() {
      const box = this.$refs.box;
      if (!box) return;
      const dpr = window.devicePixelRatio || 1;
      const cv = this.$refs.canvas;
      cv.width = box.clientWidth * dpr;
      cv.height = box.clientHeight * dpr;
      cv.style.width = box.clientWidth + 'px';
      cv.style.height = box.clientHeight + 'px';
      if (!this.fitted || !this.userMoved) this.fitView();
      else { this.reveal(); this.draw(); }
    },
    fitView() {
      const box = this.$refs.box;
      if (!box || !box.clientWidth) return;
      const pts = [...this.g.pos.values()];
      if (!pts.length) return this.draw();
      this.fitted = true;
      this.userMoved = false;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity; // no spread: graphs can be huge
      for (const q of pts) { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
      minX -= W / 2; maxX += W / 2; minY -= H / 2; maxY += H / 2;
      const k = Math.max(0.02, Math.min(1.1, (box.clientWidth - 48) / (maxX - minX), (box.clientHeight - 48) / (maxY - minY)));
      this.view = { k, x: box.clientWidth / 2 - k * (minX + maxX) / 2, y: box.clientHeight / 2 - k * (minY + maxY) / 2 };
      this.zoomPct = Math.round(k * 100);
      this.draw();
    },
    zoomBy(f, cx, cy) {
      const box = this.$refs.box;
      const v = this.view;
      cx ??= box.clientWidth / 2; cy ??= box.clientHeight / 2;
      const k = Math.max(0.02, Math.min(3, v.k * f));
      v.x = cx - (cx - v.x) * (k / v.k);
      v.y = cy - (cy - v.y) * (k / v.k);
      v.k = k;
      this.userMoved = true;
      this.zoomPct = Math.round(k * 100);
      this.draw();
    },
    wheel(e) {
      const r = this.$refs.canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else { this.userMoved = true; this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.draw(); }
    },
    at(e) {
      const r = this.$refs.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - this.view.x) / this.view.k, y = (e.clientY - r.top - this.view.y) / this.view.k;
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) {
        for (const id of this.g.grid.get(`${i},${j}`) || []) {
          const p = this.g.pos.get(id);
          if (Math.abs(x - p.x) <= W / 2 && Math.abs(y - p.y) <= H / 2) return id;
        }
      }
      return null;
    },
    down(e) {
      this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
      this.$refs.canvas.setPointerCapture(e.pointerId);
    },
    move(e) {
      if (this.drag) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) { this.drag.moved = true; this.userMoved = true; }
        this.view.x = this.drag.vx + dx; this.view.y = this.drag.vy + dy;
        this.hint = null;
        return this.draw();
      }
      const id = this.at(e);
      this.$refs.canvas.style.cursor = id ? 'pointer' : 'grab';
      if (id === this.hover) {
        if (this.hint) { const r = this.$refs.canvas.getBoundingClientRect(); this.hint.x = e.clientX - r.left + 14; this.hint.y = e.clientY - r.top + 14; }
        return;
      }
      this.hover = id;
      const r = this.$refs.canvas.getBoundingClientRect();
      this.hint = id ? { n: this.byId.get(id), x: e.clientX - r.left + 14, y: e.clientY - r.top + 14 } : null;
      this.draw();
    },
    up(e) {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved) this.$emit('select', this.at(e));
    },
    leave() { this.hover = null; this.hint = null; this.draw(); },
    labelOf(c, n, reserved) {
      const key = `${n.id}:${reserved}:${n.label}:${n.title}`;
      let v = this.labels.get(n.id);
      if (!v || v.key !== key) {
        c.font = '600 12px ui-monospace, Menlo, monospace';
        const label = fit(c, n.label, W - 14 - reserved);
        c.font = '11px -apple-system, "Segoe UI", sans-serif';
        v = { key, label, title: fit(c, n.title, W - 20) };
        this.labels.set(n.id, v);
      }
      c.font = '600 12px ui-monospace, Menlo, monospace';
      return v;
    },
    draw() {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.paint());
    },
    paint() {
      const cv = this.$refs.canvas;
      if (!cv) return;
      const c = cv.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const { x, y, k } = this.view;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
      c.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
      const f = this.focus, s = this.selected;
      const lit = (id) => !f || id === s || f.up.has(id) || f.down.has(id);
      const { pos } = this.g;
      // The part of the graph on screen, with a margin: nothing else is drawn.
      const box = this.$refs.box;
      const vx0 = -x / k - W, vy0 = -y / k - H, vx1 = (box.clientWidth - x) / k + W, vy1 = (box.clientHeight - y) / k + H;
      const shown = (q) => q.x >= vx0 && q.x <= vx1 && q.y >= vy0 && q.y <= vy1;
      const crowded = this.edges.length > 3000 && k < 0.12;

      for (const [a, b, via] of this.edges) {
        const pa = pos.get(a), pb = pos.get(b);
        if (!pa || !pb) continue;
        if (!shown(pa) && !shown(pb) && !(Math.min(pa.y, pb.y) < vy1 && Math.max(pa.y, pb.y) > vy0 && Math.min(pa.x, pb.x) < vx1 && Math.max(pa.x, pb.x) > vx0)) continue;
        if (crowded && !(f && (f.up.has(b) || f.down.has(a) || a === s || b === s))) continue;
        const on = f && ((a === s || f.down.has(a)) && (b === s || f.down.has(b)) || (a === s || f.up.has(a)) && (b === s || f.up.has(b)));
        const broken = ['retracted', 'disputed'].includes(this.byId.get(b).status);
        c.globalAlpha = f && !on ? 0.1 : on ? 0.95 : 0.55;
        c.strokeStyle = broken ? '#b42318' : on ? '#4338ca' : '#98a2b3';
        c.lineWidth = (on ? 1.8 : 1.1) / Math.max(k, 0.5);
        c.setLineDash(broken ? [5, 4] : []);
        const y1 = pb.y + H / 2, y2 = pa.y - H / 2, m = (y1 + y2) / 2;
        c.beginPath(); c.moveTo(pb.x, y1); c.bezierCurveTo(pb.x, m, pa.x, m, pa.x, y2 - 5); c.stroke();
        c.setLineDash([]);
        c.fillStyle = c.strokeStyle;
        c.beginPath(); c.moveTo(pa.x, y2); c.lineTo(pa.x - 4, y2 - 7); c.lineTo(pa.x + 4, y2 - 7); c.closePath(); c.fill();
        if (via && k >= 0.3) { // a link of the key facts, through other facts
          const lx = (pa.x + pb.x) / 2, ly = m;
          c.globalAlpha = Math.max(c.globalAlpha, 0.85);
          c.font = '600 10.5px -apple-system, "Segoe UI", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
          const t = `via ${via} fact${via > 1 ? 's' : ''}`, tw = c.measureText(t).width + 10;
          roundRect(c, lx - tw / 2, ly - 8, tw, 16, 8); c.fillStyle = '#fff'; c.fill(); c.lineWidth = 1 / k; c.strokeStyle = '#d0d5dd'; c.stroke();
          c.fillStyle = '#475467'; c.fillText(t, lx, ly + 0.5);
        }
      }
      const starred = [];

      for (const n of this.nodes) {
        const p = pos.get(n.id);
        if (!p || !shown(p)) continue;
        const st = STATUS[n.status] || STATUS.unchecked;
        const star = this.emphasis && n.stars > 0;
        if (star) starred.push(n);
        const nx = p.x - W / 2, ny = p.y - H / 2;
        c.globalAlpha = lit(n.id) ? 1 : 0.22;
        if (k < 0.08) { // far out, a fact is a mark of its status, at least a few pixels wide
          const mw = Math.max(W, 4 / k), mh = Math.max(H, 4 / k);
          c.fillStyle = star ? '#ca8a04' : n.id === s ? '#4338ca' : st.color;
          c.fillRect(p.x - mw / 2, p.y - mh / 2, mw, mh);
          continue;
        }
        roundRect(c, nx, ny, W, H, 7);
        c.fillStyle = st.bg; c.fill();
        c.lineWidth = n.id === s ? 3 : star ? 2.6 : n.id === this.hover ? 2 : 1.2;
        c.strokeStyle = n.id === s ? '#4338ca' : star ? '#ca8a04' : st.color;
        if (n.chain === 'broken') c.setLineDash([5, 3]);
        c.stroke();
        c.setLineDash([]);
        c.save(); roundRect(c, nx, ny, W, H, 7); c.clip();
        c.fillStyle = PROOF_COLOR[n.proof_origin] || PROOF_COLOR.none;
        c.fillRect(nx, ny, 5, H);
        c.restore();
        if (k < 0.32) continue;
        c.textBaseline = 'middle'; c.textAlign = 'left';
        c.fillStyle = '#1c2230'; c.font = '600 12px ui-monospace, Menlo, monospace';
        const right = n.lean === 'compiled' ? 34 : 8;
        const starW = star ? 34 : 0;
        const fitted = this.labelOf(c, n, right + starW);
        c.fillText(fitted.label, nx + 11, p.y - 11);
        c.fillStyle = '#475467'; c.font = '11px -apple-system, "Segoe UI", sans-serif';
        c.fillText(fitted.title, nx + 11, p.y + 9);
        if (star) {
          c.fillStyle = '#a16207'; c.font = '700 11px -apple-system, sans-serif'; c.textAlign = 'right';
          c.fillText(`★ ${n.stars}`, nx + W - 8 - right, p.y - 11);
          c.textAlign = 'left';
        }
        if (n.lean === 'compiled') {
          roundRect(c, nx + W - 35, ny + 5, 30, 15, 4);
          c.fillStyle = '#1e40af'; c.fill();
          c.fillStyle = '#fff'; c.font = '700 9.5px -apple-system, sans-serif';
          c.fillText('Lean', nx + W - 31, ny + 13);
        }
      }
      // Zoomed out, the starred facts keep a readable name, at screen size.
      if (k < 0.32 && starred.length <= 400) {
        c.globalAlpha = 1;
        const fs = 12 / k;
        c.font = `700 ${fs}px -apple-system, "Segoe UI", sans-serif`; c.textAlign = 'center'; c.textBaseline = 'bottom';
        for (const n of starred) {
          const p = pos.get(n.id);
          const t = `★ ${n.title.length > 40 ? n.title.slice(0, 39) + '…' : n.title}`;
          const tw = c.measureText(t).width + 8 / k;
          roundRect(c, p.x - tw / 2, p.y - H / 2 - fs * 1.45, tw, fs * 1.3, 4 / k);
          c.fillStyle = 'rgba(255, 251, 235, .95)'; c.fill();
          c.fillStyle = '#854d0e'; c.fillText(t, p.x, p.y - H / 2 - fs * 0.25);
        }
        c.textAlign = 'left';
      }
      // iPhone-style counters, drawn last so that no node covers them.
      for (const n of this.nodes) {
        const count = this.unread?.[n.id];
        const p = pos.get(n.id);
        if (!count || !p || !shown(p)) continue;
        const bx = p.x + W / 2 - 2, by = p.y - H / 2 + 2, r = 10 / Math.max(k, 0.55);
        c.globalAlpha = 1;
        c.beginPath(); c.arc(bx, by, r, 0, Math.PI * 2);
        c.fillStyle = '#ff3b30'; c.fill();
        c.lineWidth = 2 / Math.max(k, 0.55); c.strokeStyle = '#fff'; c.stroke();
        c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = `700 ${11 / Math.max(k, 0.55)}px -apple-system, sans-serif`;
        c.fillText(count > 9 ? '9+' : String(count), bx, by + 0.5);
      }
      c.globalAlpha = 1;
    },
  },
};
