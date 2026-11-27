// Comment threads panel (third column). Threads are not conversations: a root
// comment, optionally anchored (PDF selection, message), plus flat replies.
import { api } from './api.js';
import { store, attempt } from './store.js';
import { timeAgo, fullDate } from './util.js';
import { aiInstructionHint } from './ai-model.js';

const first = (r) => (Array.isArray(r) ? r[0] : r);

export const CommentsPanel = {
  props: {
    targetType: String,
    targetId: Number,
    pending: Object,            // {anchor: {...}, label: '...'} — selection waiting to be commented
    activeId: [Number, String],
    filter: Function,           // thread => bool (e.g. only current version)
    describe: Function,         // thread => label of its anchor
    title: { type: String, default: 'Comments' },
  },
  emits: ['threads', 'anchor-click', 'cancel-pending', 'created', 'update:activeId', 'activity'],
  data() {
    return { threads: [], loading: true, showResolved: false, composing: false, replyTo: null, editing: null, busy: false, freshIds: [], lastActivity: null };
  },
  computed: {
    me() { return store.user?.id; },
    visible() {
      let t = this.threads;
      if (this.filter) t = t.filter(this.filter);
      return t;
    },
    shown() { return this.visible.filter((t) => this.showResolved || !t.resolved || t.id === this.activeId); },
    resolvedCount() { return this.visible.filter((t) => t.resolved).length; },
    aiHint() { return aiInstructionHint(this.targetType); },
  },
  watch: {
    targetId() { this.composing = false; this.replyTo = null; this.freshIds = []; this.lastActivity = null; this.load(); },
    pending(v) { if (v) this.composing = false; },
    activeId(v) { if (v) this.$nextTick(() => this.scrollTo(v)); },
  },
  mounted() {
    this.load();
    this.timer = setInterval(() => { if (!this.replyTo && !this.editing && !this.composing && !this.pending) this.load(true); }, 30000);
  },
  unmounted() { clearInterval(this.timer); },
  template: `<div class="comments">
    <header class="col-head">
      <h2>{{ title }} <span class="count" v-if="visible.length">{{ visible.length }}</span></h2>
      <button class="btn sm" @click="composing = !composing; $emit('cancel-pending')" :class="{primary: !composing}">
        <icon name="plus" :size="14"/> Comment</button>
    </header>
    <div class="comments-tools" v-if="resolvedCount">
      <label class="check"><input type="checkbox" v-model="showResolved"> Show resolved ({{ resolvedCount }})</label>
    </div>
    <div class="comments-scroll" ref="scroll">
      <div v-if="pending" class="thread composing anchored">
        <div class="t-anchor"><span class="t-anchor-label">{{ pending.label }}</span>
          <blockquote v-if="pending.anchor.quote">{{ pending.anchor.quote }}</blockquote></div>
        <rich-editor ref="newEd" compact autofocus placeholder="Comment on this passage…" @submit="create" @cancel="$emit('cancel-pending')"/>
        <p class="ai-hint"><icon name="sparkles" :size="12"/><span>{{ aiHint }}</span></p>
        <div class="row-end"><button class="btn ghost sm" @click="$emit('cancel-pending')">Cancel</button>
          <button class="btn primary sm" :disabled="busy" @click="create">Comment</button></div>
      </div>
      <div v-else-if="composing" class="thread composing">
        <rich-editor ref="newEd" compact autofocus placeholder="General comment…" @submit="create" @cancel="composing=false"/>
        <p class="ai-hint"><icon name="sparkles" :size="12"/><span>{{ aiHint }}</span></p>
        <div class="row-end"><button class="btn ghost sm" @click="composing=false">Cancel</button>
          <button class="btn primary sm" :disabled="busy" @click="create">Comment</button></div>
      </div>

      <div v-if="loading" class="empty">Loading…</div>
      <div v-else-if="!shown.length && !pending && !composing" class="empty">
        No comments yet.<br><small>Select text to comment on a passage, or add a general comment.</small></div>

      <div v-for="t in shown" :key="t.id" class="thread" :data-tid="t.id"
           :class="{active: t.id === activeId, resolved: t.resolved, anchored: !!t.anchor}"
           @click="select(t)">
        <div v-if="t.anchor" class="t-anchor">
          <span class="t-anchor-label">{{ describe ? describe(t) : '' }}</span>
          <blockquote v-if="t.anchor.quote">{{ t.anchor.quote }}</blockquote>
        </div>
        <div v-for="c in [t, ...t.replies]" :key="c.id" class="c-item" :class="{reply: c !== t, fresh: freshIds.includes(c.id)}">
          <div class="c-head">
            <avatar :name="c.author_name" :id="c.author_id" :kind="c.author_kind" :size="22"/>
            <strong>{{ c.author_name }}</strong><span v-if="freshIds.includes(c.id)" class="new-tag">New</span>
            <span class="muted small" :title="fullDate(c.created_at)">{{ timeAgo(c.created_at) }}<template v-if="c.edited_at"> · edited</template></span>
            <span class="grow"></span>
            <template v-if="c.author_id === me && editing !== c.id">
              <button class="icon-btn xs" title="Edit" @click.stop="editing = c.id"><icon name="edit" :size="13"/></button>
              <button class="icon-btn xs" title="Delete" @click.stop="remove(c)"><icon name="trash" :size="13"/></button>
            </template>
          </div>
          <ai-meta :model="c.author_model" :user="c.ai_user_name" :ms="c.ai_generation_ms" class="c-ai"/>
          <div v-if="editing === c.id" @click.stop>
            <rich-editor ref="editEd" compact autofocus :initial-html="c.body_html" @submit="saveEdit(c)" @cancel="editing=null"/>
            <div class="row-end"><button class="btn ghost sm" @click="editing=null">Cancel</button>
              <button class="btn primary sm" @click="saveEdit(c)">Save</button></div>
          </div>
          <rich-content v-else :html="c.body_html"/>
        </div>
        <div class="t-actions" @click.stop>
          <button class="link-btn" @click="replyTo = replyTo === t.id ? null : t.id"><icon name="reply" :size="13"/> Reply</button>
          <button class="link-btn" @click="toggleResolved(t)"><icon name="check-circle" :size="13"/> {{ t.resolved ? 'Reopen' : 'Resolve' }}</button>
          <span class="grow"></span>
          <span v-if="t.resolved" class="tag">Resolved</span>
        </div>
        <div v-if="replyTo === t.id" class="reply-box" @click.stop>
          <rich-editor ref="replyEd" compact autofocus placeholder="Reply…" @submit="reply(t)" @cancel="replyTo=null"/>
        <p class="ai-hint"><icon name="sparkles" :size="12"/><span>{{ aiHint }}</span></p>
          <div class="row-end"><button class="btn ghost sm" @click="replyTo=null">Cancel</button>
            <button class="btn primary sm" :disabled="busy" @click="reply(t)">Reply</button></div>
        </div>
      </div>
    </div>
  </div>`,
  methods: {
    timeAgo, fullDate,
    async load(silent = false) {
      if (!this.targetId) return;
      if (!silent) this.loading = true;
      try {
        const r = await api.get(`api/comments?type=${this.targetType}&id=${this.targetId}`);
        this.threads = r.threads;
        this.freshIds = [...new Set([...this.freshIds, ...(r.fresh_ids || [])])];
        const before = this.lastActivity;
        this.lastActivity = r.last_activity_id ?? null;
        if (before !== null && r.last_activity_id !== before) this.$emit('activity');
        this.$emit('threads', r.threads);
        if (this.activeId) this.$nextTick(() => this.scrollTo(this.activeId));
      } catch (e) { /* shown elsewhere */ }
      this.loading = false;
    },
    select(t) {
      this.$emit('update:activeId', t.id);
      this.$emit('anchor-click', t);
    },
    scrollTo(id) {
      const el = this.$refs.scroll?.querySelector(`[data-tid="${id}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    async create() {
      const ed = first(this.$refs.newEd);
      const html = ed?.getHTML();
      if (!html) return;
      this.busy = true;
      const r = await attempt(() => api.post('api/comments', {
        target_type: this.targetType, target_id: this.targetId, body_html: html, anchor: this.pending?.anchor || null,
      }));
      this.busy = false;
      if (!r) return;
      this.composing = false;
      this.$emit('created', r.id);
      this.$emit('update:activeId', r.id);
      await this.load(true);
    },
    async reply(t) {
      const html = first(this.$refs.replyEd)?.getHTML();
      if (!html) return;
      this.busy = true;
      const r = await attempt(() => api.post('api/comments', { target_type: this.targetType, target_id: this.targetId, parent_id: t.id, body_html: html }));
      this.busy = false;
      if (!r) return;
      this.replyTo = null;
      await this.load(true);
    },
    async saveEdit(c) {
      const html = first(this.$refs.editEd)?.getHTML();
      if (!html) return;
      if (await attempt(() => api.patch(`api/comments/${c.id}`, { body_html: html }))) {
        this.editing = null;
        await this.load(true);
      }
    },
    async toggleResolved(t) {
      if (await attempt(() => api.patch(`api/comments/${t.id}`, { resolved: !t.resolved }))) await this.load(true);
    },
    async remove(c) {
      if (!confirm(c.parent_id ? 'Delete this reply?' : 'Delete this comment and its replies?')) return;
      if (await attempt(() => api.del(`api/comments/${c.id}`))) await this.load(true);
    },
  },
};
