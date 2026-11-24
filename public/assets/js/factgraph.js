// Dependency graph of the fact database, drawn on a canvas so it stays fluid with
// thousands of facts. Layered layout: a fact sits below everything it depends on.
export const STATUS = {
  unchecked: { label: 'Unchecked', color: '#667085', bg: '#f2f4f7' },
  ai_checked: { label: 'AI-checked', color: '#7c3aed', bg: '#f3edff' },
  human_checked: { label: 'Human-checked', color: '#0f766e', bg: '#e6f6f3' },
  double_checked: { label: 'Human + AI checked', color: '#15803d', bg: '#dcfce7' },
  proof_disputed: { label: 'Proof disputed', color: '#a16207', bg: '#fef9c3' },
  disputed: { label: 'Disputed', color: '#b45309', bg: '#fff6e6' },
  retracted: { label: 'Retracted', color: '#b42318', bg: '#fdecea' },
};

export const PROOF_COLOR = { human: '#0f766e', ai: '#7c3aed', mixed: '#d97706', none: '#98a2b3' };
export const PROOF_LABEL = { human: 'Human proof', ai: 'AI proof', mixed: 'Human + AI proof', none: 'No proof' };

const W = 204, H = 50, GAP_X = 26, GAP_Y = 62;

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
  return { pos, deps, users };
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
  props: { nodes: Array, edges: Array, selected: Number, unread: Object },
  emits: ['select'],
  data() { return { zoomPct: 100, hint: null }; },
  template: `<div class="fg" ref="box">
    <canvas ref="canvas" role="img" :aria-label="'Dependency graph of ' + nodes.length + ' facts'"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointerleave="leave" @wheel.prevent="wheel"></canvas>
    <div class="fg-tools">
      <button class="icon-btn sm" title="Zoom in" @click="zoomBy(1.25)"><icon name="zoom-in" :size="16"/></button>
      <span class="pdfv-zoom">{{ zoomPct }}%</span>
      <button class="icon-btn sm" title="Zoom out" @click="zoomBy(0.8)"><icon name="zoom-out" :size="16"/></button>
      <button class="btn xs" @click="fitView">Fit</button>
    </div>
    <div v-if="hint" class="fg-hint" :style="{left: hint.x + 'px', top: hint.y + 'px'}">
      <b>{{ hint.n.label }}</b><div>{{ hint.n.title }}</div>
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
      const minX = Math.min(...pts.map((p) => p.x)) - W / 2, maxX = Math.max(...pts.map((p) => p.x)) + W / 2;
      const minY = Math.min(...pts.map((p) => p.y)) - H / 2, maxY = Math.max(...pts.map((p) => p.y)) + H / 2;
      const k = Math.min(1.1, (box.clientWidth - 48) / (maxX - minX), (box.clientHeight - 48) / (maxY - minY));
      this.view = { k, x: box.clientWidth / 2 - k * (minX + maxX) / 2, y: box.clientHeight / 2 - k * (minY + maxY) / 2 };
      this.zoomPct = Math.round(k * 100);
      this.draw();
    },
    zoomBy(f, cx, cy) {
      const box = this.$refs.box;
      const v = this.view;
      cx ??= box.clientWidth / 2; cy ??= box.clientHeight / 2;
      const k = Math.max(0.05, Math.min(3, v.k * f));
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
      for (const [id, p] of this.g.pos) if (Math.abs(x - p.x) <= W / 2 && Math.abs(y - p.y) <= H / 2) return id;
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

      for (const [a, b] of this.edges) {
        const pa = pos.get(a), pb = pos.get(b);
        if (!pa || !pb) continue;
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
      }

      for (const n of this.nodes) {
        const p = pos.get(n.id);
        if (!p) continue;
        const st = STATUS[n.status];
        const nx = p.x - W / 2, ny = p.y - H / 2;
        c.globalAlpha = lit(n.id) ? 1 : 0.22;
        roundRect(c, nx, ny, W, H, 7);
        c.fillStyle = st.bg; c.fill();
        c.lineWidth = n.id === s ? 3 : n.id === this.hover ? 2 : 1.2;
        c.strokeStyle = n.id === s ? '#4338ca' : st.color;
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
        c.fillText(fit(c, n.label, W - 14 - right), nx + 11, p.y - 11);
        c.fillStyle = '#475467'; c.font = '11px -apple-system, "Segoe UI", sans-serif';
        c.fillText(fit(c, n.title, W - 20), nx + 11, p.y + 9);
        if (n.lean === 'compiled') {
          roundRect(c, nx + W - 35, ny + 5, 30, 15, 4);
          c.fillStyle = '#1e40af'; c.fill();
          c.fillStyle = '#fff'; c.font = '700 9.5px -apple-system, sans-serif';
          c.fillText('Lean', nx + W - 31, ny + 13);
        }
      }
      // iPhone-style counters, drawn last so that no node covers them.
      for (const n of this.nodes) {
        const count = this.unread?.[n.id];
        const p = pos.get(n.id);
        if (!count || !p) continue;
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
