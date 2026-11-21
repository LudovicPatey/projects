import { api } from '../api.js';
import { store, go, link, attempt, toast, refreshCounters, unreadCount, markRead } from '../store.js';
import { timeAgo, fullDate, parseDate } from '../util.js';

const first = (r) => (Array.isArray(r) ? r[0] : r);

export const ConversationsView = {
  props: { pid: Number, id: Number, query: Object },
  data() {
    return {
      list: [], listLoaded: false, folder: 'inbox', search: '',
      conv: null, convError: null, composing: false,
      draft: { subject: '', participants: [] }, sending: false,
      pending: null, threads: [], activeThread: null,
      adding: false, addSel: [], editingMsg: null, selBtn: null, flashId: null,
    };
  },
  computed: {
    me() { return store.user.id; },
    members() { return store.mentionables.users.filter((u) => u.id !== this.me); },
    folders() {
      const inbox = this.list.filter((c) => !c.archived);
      return [
        { k: 'inbox', label: 'Inbox', n: inbox.filter((c) => unreadCount('conversation', c.id)).length },
        { k: 'starred', label: 'Starred', n: 0 },
        { k: 'archived', label: 'Archived', n: 0 },
      ];
    },
    filtered() {
      const q = this.search.toLowerCase();
      return this.list.filter((c) => {
        if (this.folder === 'inbox' && c.archived) return false;
        if (this.folder === 'starred' && !c.starred) return false;
        if (this.folder === 'archived' && !c.archived) return false;
        if (!q) return true;
        return c.subject.toLowerCase().includes(q) || c.snippet.toLowerCase().includes(q)
          || c.participants.some((p) => p.name.toLowerCase().includes(q));
      });
    },
    commentsByMsg() {
      const m = {};
      for (const t of this.threads) if (t.anchor?.message_id) m[t.anchor.message_id] = (m[t.anchor.message_id] || 0) + 1 + t.replies.length;
      return m;
    },
    notInConv() {
      if (!this.conv) return [];
      const ids = new Set(this.conv.participants.map((p) => p.id));
      return store.mentionables.users.filter((u) => !ids.has(u.id));
    },
  },
  watch: {
    id: { immediate: true, handler() { this.onRoute(); } },
    'query.message'(m) { if (m && this.conv) this.showMessage(+m); },
    'query.compose': { immediate: true, handler(v) { if (v) this.startCompose(); } },
  },
  mounted() {
    this.loadList();
    this.timer = setInterval(() => { this.loadList(); if (this.conv && !this.editingMsg) this.loadConv(true); }, 20000);
    document.addEventListener('selectionchange', this.onSelChange);
  },
  unmounted() {
    clearInterval(this.timer);
    document.removeEventListener('selectionchange', this.onSelChange);
  },
  template: `<div class="cols3">
  <section class="col col-list">
    <header class="col-head"><h2>Conversations</h2>
      <div class="row-gap"><mark-all-read type="conversation"/><button class="btn primary sm" @click="startCompose"><icon name="edit" :size="14"/> New</button></div></header>
    <div class="col-tools">
      <div class="seg">
        <button v-for="f in folders" :key="f.k" :class="{on: folder === f.k}" @click="folder = f.k">
          {{ f.label }}<b v-if="f.n" class="seg-n">{{ f.n }}</b></button>
      </div>
      <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Search conversations"></div>
    </div>
    <div class="list">
      <a v-for="c in filtered" :key="c.id" class="li conv-li" :href="link('conversations', c.id)"
         :class="{active: c.id === id, unread: !!unreadOf(c.id), 'is-new': !!unreadOf(c.id)}">
        <div class="li-top">
          <span class="li-who">{{ who(c) }}</span>
          <span class="li-time">{{ timeAgo(c.last_message_at) }}</span>
          <unread-badge type="conversation" :id="c.id"/>
        </div>
        <div class="li-subject">{{ c.subject }}</div>
        <div class="li-snippet"><math-text :text="c.snippet"/></div>
        <div class="li-meta">
          <span v-if="c.message_count > 1"><icon name="mail" :size="12"/> {{ c.message_count }}</span>
          <span v-if="c.comment_count"><icon name="comment" :size="12"/> {{ c.comment_count }}</span>
          <span class="grow"></span>
          <icon v-if="c.starred" name="star" :size="13" class="starred"/>
        </div>
      </a>
      <div v-if="listLoaded && !filtered.length" class="empty">No conversations here.</div>
    </div>
  </section>

  <section class="col col-main" ref="main">
    <template v-if="composing">
      <header class="col-head"><h2>New conversation</h2>
        <button class="icon-btn" @click="composing=false" title="Discard"><icon name="x"/></button></header>
      <div class="compose">
        <label class="field"><span>Subject</span><input v-model="draft.subject" placeholder="e.g. Reduction to the bounded-degree case" autofocus></label>
        <div class="field"><span>Participants <small class="muted">— only they will see this conversation</small></span>
          <div class="people-pick">
            <label v-for="u in members" :key="u.id" class="person-chip" :class="{on: draft.participants.includes(u.id)}">
              <input type="checkbox" :value="u.id" v-model="draft.participants"><avatar :name="u.name" :id="u.id" :kind="u.kind" :size="20"/> {{ u.name }}
            </label>
            <button class="link-btn" v-if="members.length" @click="draft.participants = draft.participants.length === members.length ? [] : members.map(u => u.id)">
              {{ draft.participants.length === members.length ? 'None' : 'Everyone' }}</button>
            <span v-if="!members.length" class="muted small">You are the only member of this project for now.</span>
          </div>
        </div>
        <div class="field grow-field"><span>Message</span>
          <rich-editor ref="newEd" :min-height="220" placeholder="Write your message… (@ to mention people, files or references; $…$ for LaTeX; Ctrl+Enter to send)" @submit="createConv"/></div>
        <div class="row-end"><button class="btn ghost" @click="composing=false">Discard</button>
          <button class="btn primary" :disabled="sending" @click="createConv"><icon name="mail" :size="15"/> Send</button></div>
      </div>
    </template>

    <template v-else-if="conv">
      <header class="conv-head">
        <div class="conv-title">
          <h2>{{ conv.subject }}</h2>
          <div class="conv-actions">
            <button class="icon-btn" :class="{starred: conv.starred}" @click="flag({starred: !conv.starred})" :title="conv.starred ? 'Unstar' : 'Star'"><icon name="star"/></button>
            <button class="icon-btn" @click="flag({archived: !conv.archived})" :title="conv.archived ? 'Move to inbox' : 'Archive'"><icon name="archive"/></button>
            <button class="icon-btn" @click="markUnread" title="Mark as unread"><icon name="mail-unread"/></button>
            <button class="icon-btn" @click="leave" title="Leave conversation"><icon name="logout"/></button>
          </div>
        </div>
        <div class="chips">
          <span v-for="p in conv.participants" :key="p.id" class="chip" :class="{'chip-ai': p.kind === 'agent'}"><avatar :name="p.name" :id="p.id" :kind="p.kind" :size="18"/>{{ p.id === me ? 'You' : p.name }}</span>
          <button v-if="notInConv.length" class="chip add" @click="adding = !adding"><icon name="user-plus" :size="13"/> Add</button>
        </div>
        <div v-if="adding" class="add-people">
          <label v-for="u in notInConv" :key="u.id" class="person-chip" :class="{on: addSel.includes(u.id)}">
            <input type="checkbox" :value="u.id" v-model="addSel"><avatar :name="u.name" :id="u.id" :kind="u.kind" :size="20"/> {{ u.name }}</label>
          <button class="btn primary sm" :disabled="!addSel.length" @click="addPeople">Add to conversation</button>
          <small class="muted">New participants will see the whole history.</small>
        </div>
      </header>
      <div class="messages" ref="msgs" @mouseup="onMsgMouseUp">
        <article v-for="m in conv.messages" :key="m.id" class="msg" :data-mid="m.id"
                 :class="{mine: m.author_id === me, fresh: isNew(m), flash: flashId === m.id, commented: !!commentsByMsg[m.id], 'by-agent': m.author_kind === 'agent'}">
          <avatar :name="m.author_name" :id="m.author_id" :kind="m.author_kind" :size="36"/>
          <div class="msg-main">
            <div class="msg-head">
              <strong>{{ m.author_name }}</strong>
              <span v-if="isNew(m)" class="new-tag">New</span>
              <ai-meta v-if="m.author_kind === 'agent'" :model="m.author_model" :user="m.ai_user_name" :ms="m.ai_generation_ms"/>
              <a v-else class="muted small orcid" :href="'https://orcid.org/' + m.author_orcid" target="_blank" rel="noopener">{{ m.author_orcid }}</a>
              <span class="grow"></span>
              <span class="muted small" :title="fullDate(m.created_at)">{{ fullDate(m.created_at) }}<template v-if="m.edited_at"> · edited</template></span>
              <button v-if="commentsByMsg[m.id]" class="comment-count" @click="showMsgComments(m)" title="Show comments"><icon name="comment" :size="12"/> {{ commentsByMsg[m.id] }}</button>
              <button class="icon-btn xs" title="Comment on this message" @click="commentOn(m)"><icon name="comment" :size="14"/></button>
              <button v-if="m.author_id === me" class="icon-btn xs" title="Edit" @click="editingMsg = m.id"><icon name="edit" :size="14"/></button>
            </div>
            <div v-if="editingMsg === m.id">
              <rich-editor ref="editEd" :initial-html="m.body_html" autofocus @submit="saveEdit(m)" @cancel="editingMsg = null"/>
              <div class="row-end"><button class="btn ghost sm" @click="editingMsg = null">Cancel</button>
                <button class="btn primary sm" @click="saveEdit(m)">Save</button></div>
            </div>
            <rich-content v-else :html="m.body_html" class="msg-body"/>
          </div>
        </article>
      </div>
      <div class="composer">
        <rich-editor ref="replyEd" compact placeholder="Reply to everyone… (@ mentions, $…$ LaTeX, Ctrl+Enter to send)" @submit="send"/>
        <div class="composer-actions"><button class="btn primary" :disabled="sending" @click="send"><icon name="reply" :size="15"/> Send</button></div>
      </div>
      <button v-if="selBtn" class="sel-btn" :style="{top: selBtn.top + 'px', left: selBtn.left + 'px'}" @mousedown.prevent="commentOnSelection">
        <icon name="comment" :size="14"/> Comment</button>
    </template>
    <div v-else-if="convError" class="placeholder">{{ convError }}</div>
    <section-home v-else kind="conversations"><button class="btn primary" @click="startCompose"><icon name="plus" :size="15"/> New conversation</button></section-home>
  </section>

  <section class="col col-comments">
    <comments-panel v-if="conv" target-type="conversation" :target-id="conv.id" :pending="pending"
      v-model:active-id="activeThread" :describe="describe"
      @threads="threads = $event" @anchor-click="onThreadClick" @cancel-pending="pending = null" @created="pending = null" @activity="loadConv(true)"/>
    <section-activity v-else kind="conversations"/>
  </section>
</div>`,
  methods: {
    timeAgo, fullDate, link,
    unreadOf(id) { return unreadCount('conversation', id); },
    who(c) {
      const others = c.participants.filter((p) => p.id !== this.me);
      if (!others.length) return 'Only you';
      const names = others.map((p) => p.name.split(' ')[0]);
      return names.length > 3 ? names.slice(0, 3).join(', ') + ` +${names.length - 3}` : names.join(', ');
    },
    describe(t) {
      const m = this.conv?.messages.find((x) => x.id === t.anchor?.message_id);
      return m ? `On ${m.author_name}'s message · ${timeAgo(m.created_at)}` : 'On a message';
    },
    isNew(m) {
      if (!this.conv?.last_read_at) return m.author_id !== this.me;
      return m.author_id !== this.me && parseDate(m.created_at) > parseDate(this.conv.last_read_at);
    },
    /** Opens the message a reference points to. */
    showMessage(mid) {
      this.$nextTick(() => {
        this.$refs.msgs?.querySelector(`[data-mid="${mid}"]`)?.scrollIntoView({ block: 'center' });
        this.flashId = mid;
        setTimeout(() => { this.flashId = null; }, 1600);
      });
    },
    onRoute() {
      this.pending = null; this.selBtn = null; this.editingMsg = null; this.adding = false;
      this.activeThread = this.query?.comment ? +this.query.comment : null;
      if (this.id) { this.composing = false; this.loadConv(); } else { this.conv = null; }
    },
    async loadList() {
      try {
        const r = await api.get(`api/projects/${this.pid}/conversations`);
        this.list = r.conversations;
        this.listLoaded = true;
      } catch (e) { /* ignore */ }
    },
    async loadConv(silent = false) {
      const id = this.id;
      try {
        const c = await api.get(`api/conversations/${id}`);
        if (id !== this.id) return;
        const grew = !this.conv || this.conv.id !== c.id || c.messages.length !== this.conv.messages.length;
        if (silent && this.conv?.id === c.id) c.last_read_at = this.conv.last_read_at; // keep "new" markers
        this.conv = c;
        this.convError = null;
        const item = this.list.find((x) => x.id === id);
        if (item) item.unread = 0;
        markRead('conversation', c.id, c.last_activity_id);
        if (this.query?.message && this.seenMessage !== `${id}:${this.query.message}`) {
          this.seenMessage = `${id}:${this.query.message}`;
          this.showMessage(+this.query.message);
        } else if (grew) this.$nextTick(() => this.scrollToEnd(!silent));
      } catch (e) {
        this.conv = null;
        this.convError = e.message;
      }
    },
    scrollToEnd(toFirstNew) {
      const box = this.$refs.msgs;
      if (!box) return;
      const fresh = toFirstNew && box.querySelector('.msg.fresh');
      if (fresh) fresh.scrollIntoView({ block: 'start' });
      else box.scrollTop = box.scrollHeight;
    },
    startCompose() {
      this.draft = { subject: '', participants: [] };
      this.composing = true;
      if (this.id) go(`/p/${this.pid}/conversations?compose=1`);
    },
    async createConv() {
      const html = first(this.$refs.newEd)?.getHTML();
      if (!this.draft.subject.trim()) return toast('Please enter a subject', 'error');
      if (!html) return toast('The message is empty', 'error');
      this.sending = true;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/conversations`, {
        subject: this.draft.subject, participant_ids: this.draft.participants, body_html: html,
      }));
      this.sending = false;
      if (!r) return;
      this.composing = false;
      await this.loadList();
      go(`/p/${this.pid}/conversations/${r.id}`);
    },
    async send() {
      const ed = first(this.$refs.replyEd);
      const html = ed?.getHTML();
      if (!html) return;
      this.sending = true;
      const r = await attempt(() => api.post(`api/conversations/${this.conv.id}/messages`, { body_html: html }));
      this.sending = false;
      if (!r) return;
      ed.clear();
      await this.loadConv(true);
      this.$nextTick(() => this.scrollToEnd(false));
      this.loadList();
    },
    async saveEdit(m) {
      const html = first(this.$refs.editEd)?.getHTML();
      if (!html) return;
      if (await attempt(() => api.patch(`api/messages/${m.id}`, { body_html: html }))) {
        this.editingMsg = null;
        this.loadConv(true);
      }
    },
    async flag(f) {
      if (await attempt(() => api.patch(`api/conversations/${this.conv.id}/flags`, f))) {
        Object.assign(this.conv, f);
        this.loadList();
      }
    },
    async markUnread() {
      if (await attempt(() => api.patch(`api/conversations/${this.conv.id}/flags`, { unread: true }))) {
        await this.loadList();
        refreshCounters();
        go(`/p/${this.pid}/conversations`);
      }
    },
    async leave() {
      if (!confirm('Leave this conversation? You will no longer see it unless someone adds you back.')) return;
      if (await attempt(() => api.post(`api/conversations/${this.conv.id}/leave`))) {
        await this.loadList();
        go(`/p/${this.pid}/conversations`);
      }
    },
    async addPeople() {
      if (await attempt(() => api.post(`api/conversations/${this.conv.id}/participants`, { user_ids: this.addSel }), 'Participants added')) {
        this.adding = false; this.addSel = [];
        this.loadConv(true); this.loadList();
      }
    },
    // ----- comments anchored on messages -----
    commentOn(m, quote = '') {
      this.pending = { anchor: { message_id: m.id, ...(quote ? { quote } : {}) }, label: `On ${m.author_name}'s message` };
      this.selBtn = null;
    },
    onSelChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { this.selBtn = null; }
    },
    onMsgMouseUp() {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) { this.selBtn = null; return; }
        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
        const body = node?.closest('.msg-body');
        const art = node?.closest('.msg');
        if (!body || !art) { this.selBtn = null; return; }
        const rect = range.getBoundingClientRect();
        const main = this.$refs.main.getBoundingClientRect();
        this.selBtn = {
          top: rect.top - main.top - 38, left: Math.min(rect.left - main.left + rect.width / 2 - 50, main.width - 120),
          mid: +art.dataset.mid, quote: sel.toString().replace(/\s+/g, ' ').trim().slice(0, 2000),
        };
      }, 0);
    },
    commentOnSelection() {
      const m = this.conv.messages.find((x) => x.id === this.selBtn.mid);
      if (m) this.commentOn(m, this.selBtn.quote);
      window.getSelection()?.removeAllRanges();
    },
    showMsgComments(m) {
      const t = this.threads.find((x) => x.anchor?.message_id === m.id);
      if (t) this.activeThread = t.id;
    },
    onThreadClick(t) {
      if (!t.anchor?.message_id) return;
      const el = this.$refs.msgs?.querySelector(`[data-mid="${t.anchor.message_id}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      this.flashId = t.anchor.message_id;
      setTimeout(() => { this.flashId = null; }, 1600);
    },
  },
};
