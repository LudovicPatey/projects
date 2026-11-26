import { initials, colorFor, formatDuration } from './util.js';
import { store, unreadCount, markAllRead, attempt } from './store.js';
import { api } from './api.js';
import { AI_KINDS, usageView } from './ai-model.js';

let usageLoad = null;
/** The person's AI requests of the last 24 hours, fetched once for every AI button of the page, again when asked. */
export function loadAiUsage(again = false) {
  if (!store.user) return null;
  if (!usageLoad || again) usageLoad = api.get('api/me/ai-usage').then((u) => { store.aiUsage = u; }).catch(() => { usageLoad = null; });
  return usageLoad;
}

export const ICONS = {
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15v4"/><path d="M17 17h4"/><path d="M5 3v3"/><path d="M3.5 4.500h3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  bug: '<rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="m10 4 1 2"/><path d="m14 4-1 2"/>',
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5A4.6 4.6 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  files: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  'zoom-in': '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
  'zoom-out': '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>',
  reply: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  code: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  pdf: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  'mail-unread': '<path d="M22 10.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h12.5"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/><circle cx="19" cy="17" r="3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  graph: '<circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><path d="m10.5 7.6-4 8.8"/><path d="m13.5 7.6 4 8.8"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  filter: '<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>',
  tag: '<path d="M12.6 2.6 21 11a2 2 0 0 1 0 2.8L13.8 21a2 2 0 0 1-2.8 0L2.6 12.6A2 2 0 0 1 2 11.2V4a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
};

export const Icon = {
  props: { name: String, size: { type: [Number, String], default: 18 } },
  computed: { svg() { return ICONS[this.name] || ''; } },
  template: `<svg class="icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="svg"></svg>`,
};

export const Avatar = {
  props: { name: String, id: [Number, String], size: { type: Number, default: 32 }, kind: String },
  computed: {
    bot() { return this.kind === 'agent'; },
    style() {
      return { width: this.size + 'px', height: this.size + 'px', background: this.bot ? 'var(--ai)' : colorFor(this.id), fontSize: Math.round(this.size * 0.4) + 'px' };
    },
    text() { return initials(this.name); },
  },
  template: `<span class="avatar" :class="{bot}" :style="style" :title="bot ? name + ' (AI agent)' : name">
    <icon v-if="bot" name="bot" :size="Math.round(size * 0.6)"/><template v-else>{{ text }}</template></span>`,
};

/** Small "AI agent" tag shown next to the name of an agent. */
export const AgentTag = {
  props: { model: String, compact: Boolean },
  template: `<span class="agent-tag" :title="model ? 'AI agent — ' + model : 'AI agent'"><icon name="bot" :size="11"/> <template v-if="!compact">AI agent<template v-if="model"> · </template></template><span class="ellipsis">{{ model }}</span></span>`,
};

/** AI provenance: the model, the user it worked for, and the generation time when known. */
export const AiMeta = {
  props: { model: String, user: String, ms: [Number, String], compact: Boolean },
  computed: {
    duration() { return formatDuration(this.ms); },
    title() { return [`AI model: ${this.model}`, this.user && `For: ${this.user}`, this.duration ? `Generation time: ${this.duration}` : 'Generation time not reported'].filter(Boolean).join('\n'); },
  },
  template: `<span v-if="model" class="ai-meta" :class="{compact}" :title="title"><icon name="bot" :size="11"/> <b>{{ model }}</b><span v-if="user && !compact"> · for {{ user }}</span><span v-if="duration"> · {{ duration }}</span></span>`,
};

/** The same AI request from anywhere it is relevant. It joins the queue shown on the AI page. */
export const AiAction = {
  props: { kind: String, sourceType: String, sourceId: Number, label: String, disabled: Boolean, title: String },
  data() { return { busy: false, asking: false, prompt: '' }; },
  computed: {
    info() { return AI_KINDS[this.kind]; },
    text() { return this.label || this.info.label; },
    needsPrompt() { return this.kind === 'ask'; },
    usage() { return usageView(store.aiUsage); },
    full() { return this.usage?.left === 0; },
    tip() {
      const base = this.title || this.info.hint;
      if (!this.usage) return base;
      return this.full ? `${this.usage.label}. ${this.usage.text}` : `${base}\n\nYour AI requests: ${this.usage.used} of ${this.usage.limit} in the last 24 hours.`;
    },
  },
  mounted() { loadAiUsage(); },
  methods: {
    click() { if (this.needsPrompt) this.asking = true; else this.send(); },
    async send() {
      if (this.needsPrompt && !this.prompt.trim()) return;
      this.busy = true;
      const body = { kind: this.kind, ...(this.sourceType ? { source_type: this.sourceType, source_id: this.sourceId } : {}), ...(this.needsPrompt ? { prompt_text: this.prompt.trim() } : {}) };
      const done = await attempt(() => api.post(`api/projects/${store.project.id}/ai/tasks`, body), 'Added to the AI queue. A running AI client will process it.');
      this.busy = false;
      if (done) { this.asking = false; this.prompt = ''; if (done.usage) store.aiUsage = done.usage; this.$emit('queued', done); }
      else loadAiUsage(true); // refused, perhaps at the limit: show where it stands
    },
  },
  emits: ['queued'],
  template: `<button class="btn sm" :class="{'at-limit': full}" :disabled="busy || disabled || full" :title="tip" @click="click"><icon :name="info.icon === 'files' ? 'sparkles' : info.icon" :size="14"/> {{ text }}</button>
  <modal v-if="asking" :title="text" @close="asking = false">
    <label class="field"><span>Your question</span><textarea v-model="prompt" rows="4" maxlength="4000"></textarea></label>
    <p class="muted small">The answer appears on the AI work page.</p>
    <template #footer><button class="btn ghost" @click="asking = false">Cancel</button><button class="btn primary" :disabled="busy || !prompt.trim()" @click="send">Add to the queue</button></template>
  </modal>`,
};

/** Red counter, like the badge of an iPhone app. */
export const UnreadBadge = {
  props: { type: String, id: Number },
  computed: { n() { return unreadCount(this.type, this.id); } },
  template: `<b v-if="n" class="ios-badge" :aria-label="n + ' unread'">{{ n > 99 ? '99+' : n }}</b>`,
};

export const MarkAllRead = {
  props: { type: String },
  computed: { n() { return store.counters.totals?.[this.type] || 0; } },
  methods: { run() { markAllRead(this.type); } },
  template: `<button v-if="n" class="link-btn mark-all" title="Mark everything here as read" aria-label="Mark everything here as read" @click="run"><icon name="check" :size="13"/> <span>Read all</span></button>`,
};

export const Modal = {
  props: { title: String, wide: Boolean },
  emits: ['close'],
  mounted() {
    this.onKey = (e) => { if (e.key === 'Escape') this.$emit('close'); };
    window.addEventListener('keydown', this.onKey);
  },
  unmounted() { window.removeEventListener('keydown', this.onKey); },
  template: `<div class="modal-back" @mousedown.self="$emit('close')">
    <div class="modal" :class="{wide}" role="dialog" aria-modal="true">
      <header class="modal-head"><h3>{{ title }}</h3>
        <button class="icon-btn" @click="$emit('close')" aria-label="Close"><icon name="x"/></button></header>
      <div class="modal-body"><slot/></div>
      <footer class="modal-foot" v-if="$slots.footer"><slot name="footer"/></footer>
    </div></div>`,
};

/** Very visible marker telling whether a file was written by a human or by an AI. */
export const OriginBadge = {
  props: { origin: String, model: String, large: Boolean },
  template: `<span class="origin" :class="[origin, {large}]" :title="origin==='ai' ? ('Written by AI' + (model ? ' — ' + model : '')) : 'Written by a human'">
    <icon :name="origin==='ai' ? 'bot' : 'user'" :size="large ? 16 : 12"/>
    <span>{{ origin==='ai' ? 'AI' : 'Human' }}<template v-if="large && origin==='ai' && model"> · {{ model }}</template></span>
  </span>`,
};

export function registerCommon(app) {
  app.component('icon', Icon);
  app.component('avatar', Avatar);
  app.component('modal', Modal);
  app.component('origin-badge', OriginBadge);
  app.component('agent-tag', AgentTag);
  app.component('ai-meta', AiMeta);
  app.component('ai-action', AiAction);
  app.component('unread-badge', UnreadBadge);
  app.component('mark-all-read', MarkAllRead);
}
