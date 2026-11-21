// First-use tutorial: speech bubbles pointing at the real interface. It never navigates or changes data.
import { api } from './api.js';
import { store } from './store.js';
import { TOUR_KINDS, buildSteps, placeBubble, tourToStart } from './help/tour-steps.js';

const element = (step) => (step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null);
const visible = (el) => { const r = el?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; };

/** Replays the tutorial matching the current page. */
export function startTour() { store.tourRequest = store.route.name === 'project' && store.project ? 'project' : 'home'; }

export const TourGuide = {
  data() { return { kind: null, steps: [], index: 0, spot: { left: 0, top: 0, width: 0, height: 0 }, place: { left: 0, top: 0, side: 'none', arrow: null } }; },
  computed: {
    step() { return this.steps[this.index] || null; },
    isLast() { return this.index === this.steps.length - 1; },
    auto() {
      const r = store.route;
      return tourToStart({ route: r, projectLoaded: !!store.project && store.project.id === r.pid, seen: store.toursSeen, running: !!this.kind });
    },
    context() { return `${store.route.name}:${store.route.pid || ''}`; },
    request() { return store.tourRequest; },
    spotStyle() { const s = this.spot; return { left: `${s.left}px`, top: `${s.top}px`, width: `${s.width}px`, height: `${s.height}px` }; },
    bubbleStyle() { return { left: `${this.place.left}px`, top: `${this.place.top}px` }; },
    arrowStyle() {
      const p = this.place;
      return p.side === 'left' || p.side === 'right' ? { top: `${p.arrow}px` } : { left: `${p.arrow}px` };
    },
  },
  watch: {
    auto: { immediate: true, handler(kind) {
      clearTimeout(this.timer);
      // Let the page render what the bubbles point at.
      if (kind) this.timer = setTimeout(() => { if (this.auto === kind) this.open(kind); }, 450);
    } },
    request(kind) { if (kind) { store.tourRequest = null; this.open(kind); } },
    context() { if (this.kind) this.close(); },
    index() { this.measure(true); },
  },
  mounted() {
    this.onResize = () => this.measure(false);
    this.onKey = (e) => this.key(e);
    window.addEventListener('resize', this.onResize);
    window.addEventListener('scroll', this.onResize, true);
    window.addEventListener('keydown', this.onKey, true);
  },
  unmounted() {
    clearTimeout(this.timer);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onResize, true);
    window.removeEventListener('keydown', this.onKey, true);
  },
  template: `<div v-if="step" class="tour">
    <div class="tour-block"></div>
    <div class="tour-spot" :style="spotStyle"></div>
    <section ref="bubble" class="tour-bubble" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" :style="bubbleStyle">
      <i v-if="place.arrow !== null" class="tour-arrow" :class="place.side" :style="arrowStyle"></i>
      <p class="tour-count">Step {{ index + 1 }} of {{ steps.length }}</p>
      <h2 id="tour-title">{{ step.title }}</h2>
      <p id="tour-text">{{ step.text }}</p>
      <div class="tour-dots" aria-hidden="true"><span v-for="(s, i) in steps" :key="s.id" :class="{on: i === index}"></span></div>
      <footer>
        <button v-if="!isLast" type="button" class="link-btn" @click="finish(true)">Skip tour</button>
        <span class="grow"></span>
        <button v-if="index" type="button" class="btn sm" @click="index--">Back</button>
        <button ref="next" type="button" class="btn primary sm" @click="next">{{ isLast ? 'Done' : 'Next' }}</button>
      </footer>
    </section>
  </div>`,
  methods: {
    open(kind) {
      this.before = document.activeElement;
      const ctx = { title: store.project?.title, role: store.project?.my_role };
      this.steps = buildSteps(kind, ctx).filter((s) => !s.target || visible(element(s)));
      this.index = 0;
      this.kind = kind;
      this.measure(true);
    },
    close() {
      this.kind = null;
      this.steps = [];
      if (this.before?.isConnected) this.before.focus?.();
    },
    next() { if (this.isLast) this.finish(false); else this.index++; },
    /** Skipping means the person does not want tutorials: both are then marked as seen. */
    finish(skipAll) {
      const seen = skipAll ? TOUR_KINDS : [this.kind];
      store.toursSeen = [...new Set([...store.toursSeen, ...seen])];
      this.close();
      api.patch('api/me', { tours_seen: seen }).catch(() => { /* it will simply be offered again */ });
    },
    key(e) {
      if (!this.step) return;
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.finish(true); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (this.index) this.index--; }
      else if (e.key === 'Tab') {
        const items = [...this.$refs.bubble.querySelectorAll('button')];
        const at = items.indexOf(document.activeElement);
        e.preventDefault();
        items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
      }
    },
    async measure(moved) {
      await this.$nextTick();
      const bubble = this.$refs.bubble;
      if (!this.step || !bubble) return;
      const el = element(this.step);
      if (moved) el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el?.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const pad = 4;
      const target = r ? { left: r.left - pad, right: r.right + pad, top: r.top - pad, bottom: r.bottom + pad } : null;
      this.spot = target ? { left: target.left, top: target.top, width: target.right - target.left, height: target.bottom - target.top }
        : { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0 };
      this.place = placeBubble(target, { width: bubble.offsetWidth, height: bubble.offsetHeight }, viewport, this.step.side);
      if (moved) this.$refs.next?.focus({ preventScroll: true });
    },
  },
};
