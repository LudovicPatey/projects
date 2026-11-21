// Bug reports and feature requests: the dialog available from every page, and the follow-up page.
import { api } from '../api.js';
import { store, go, attempt, refreshCounters } from '../store.js';
import { timeAgo, fullDate } from '../util.js';
import { FEEDBACK_IMPACT, FEEDBACK_KINDS, FEEDBACK_STATUS, MAX_BODY, MAX_TITLE, draftError, filterReports, pageContext, reportCounts } from '../feedback-model.js';

export function openFeedback(kind = 'bug') {
  store.feedbackRequest = { kind, page: pageContext(location.hash) };
}

export const FeedbackDialog = {
  data() { return { kind: 'bug', title: '', body: '', impact: 'normal', include: true, busy: false, sent: null, error: null }; },
  computed: {
    request() { return store.feedbackRequest; },
    meta() { return FEEDBACK_KINDS[this.kind]; },
    client() { return `${navigator.userAgent} · ${innerWidth}×${innerHeight}`.slice(0, 255); },
    invalid() { return !!draftError({ kind: this.kind, title: this.title, body: this.body }); },
  },
  watch: { request(v) { if (v) Object.assign(this, { kind: v.kind, title: '', body: '', impact: 'normal', include: true, sent: null, error: null }); } },
  created() { this.kinds = FEEDBACK_KINDS; this.impacts = FEEDBACK_IMPACT; this.maxTitle = MAX_TITLE; this.maxBody = MAX_BODY; },
  methods: {
    close() { store.feedbackRequest = null; },
    view() { const id = this.sent.id; this.close(); go(`/feedback/${id}`); },
    list() { this.close(); go('/feedback'); },
    async submit() {
      this.error = draftError({ kind: this.kind, title: this.title, body: this.body });
      if (this.error || this.busy) return;
      this.busy = true;
      const body = { kind: this.kind, title: this.title, body_text: this.body, impact: this.impact };
      if (this.include) { body.page = this.request.page || ''; body.client_info = this.client; }
      const r = await attempt(() => api.post('api/feedback', body));
      this.busy = false;
      if (r) { this.sent = r; window.dispatchEvent(new Event('feedback-changed')); }
    },
  },
  template: `<modal v-if="request" :title="sent ? 'Thank you' : 'Send feedback'" wide @close="close">
    <div v-if="sent" class="fb-sent"><span class="action-icon t-good"><icon name="check-circle" :size="22"/></span><div><h4>Report #{{ sent.id }} received</h4><p class="muted">You can follow its status and any answer from the Feedback page. A badge appears there when it changes.</p></div></div>
    <template v-else>
      <div class="fb-kinds" role="radiogroup" aria-label="Type of feedback">
        <button v-for="(k, id) in kinds" :key="id" type="button" role="radio" :aria-checked="kind === id" class="fb-kind" :class="{on: kind === id}" @click="kind = id"><span class="action-icon" :class="'t-' + k.tone"><icon :name="k.icon" :size="17"/></span><span><b>{{ k.label }}</b><small>{{ id === 'bug' ? 'Something does not work' : 'An idea to improve the platform' }}</small></span></button>
      </div>
      <label class="field"><span>Title</span><input v-model="title" :maxlength="maxTitle" :placeholder="meta.titleHint" autofocus></label>
      <label class="field"><span>Description</span><textarea v-model="body" rows="6" :maxlength="maxBody" :placeholder="meta.bodyHint"></textarea></label>
      <div class="field"><span>{{ kind === 'bug' ? 'How much does it block you?' : 'How important is it for you?' }}</span><div class="seg"><button v-for="(l, k) in impacts" :key="k" type="button" :class="{on: impact === k}" :aria-pressed="impact === k" @click="impact = k">{{ l }}</button></div></div>
      <label class="check fb-context"><input type="checkbox" v-model="include"><span>Include the page address <code v-if="request.page">{{ request.page }}</code> and my browser, to help reproduce it</span></label>
      <p class="fb-note"><icon name="lock" :size="13"/> Only you and the platform administrators can read this. Nothing from your projects is attached, so avoid pasting unpublished results.</p>
      <p v-if="error" class="fb-error" role="alert">{{ error }}</p>
    </template>
    <template #footer>
      <template v-if="sent"><button class="btn ghost" @click="close">Close</button><button class="btn primary" @click="view">View my report</button></template>
      <template v-else><button class="btn ghost fb-mine" @click="list">My reports</button><span class="grow"></span><button class="btn ghost" @click="close">Cancel</button><button class="btn primary" :disabled="busy || invalid" @click="submit">Send</button></template>
    </template>
  </modal>`,
};

export const FeedbackView = {
  props: { id: Number },
  data() { return { reports: [], isAdmin: false, loaded: false, scope: 'mine', kind: 'all', status: 'all', search: '', editing: null, reply: '', busy: false }; },
  computed: {
    shown() { return filterReports(this.reports, { kind: this.kind, status: this.status, search: this.search }); },
    counts() { return reportCounts(this.reports); },
    report() { return this.reports.find((r) => r.id === this.id) || null; },
    canEdit() { return this.report?.mine && this.report.status === 'new'; },
    canDelete() { return this.report && (this.isAdmin || (this.report.mine && this.report.status === 'new')); },
    replyChanged() { return this.reply.trim() !== (this.report?.response_text || ''); },
  },
  watch: {
    id() { this.editing = null; this.syncReport(); },
    scope() { this.load(); },
  },
  created() { this.kinds = FEEDBACK_KINDS; this.statuses = FEEDBACK_STATUS; this.impacts = FEEDBACK_IMPACT; this.maxTitle = MAX_TITLE; this.maxBody = MAX_BODY; },
  mounted() {
    this.load();
    this.onChange = () => this.load();
    window.addEventListener('feedback-changed', this.onChange);
  },
  unmounted() { window.removeEventListener('feedback-changed', this.onChange); },
  methods: {
    timeAgo, fullDate,
    newReport(kind) { openFeedback(kind); },
    href(r) { return `#/feedback/${r.id}`; },
    async load() {
      const r = await attempt(() => api.get(`api/feedback${this.scope === 'all' ? '?scope=all' : ''}`));
      this.loaded = true;
      if (!r) return;
      this.reports = r.reports; this.isAdmin = r.is_admin;
      if (this.id && !this.report && r.is_admin && this.scope === 'mine') { this.scope = 'all'; return; }
      this.syncReport();
    },
    async syncReport() {
      const r = this.report;
      this.reply = r?.response_text || '';
      if (r?.unseen) {
        await attempt(() => api.post(`api/feedback/${r.id}/seen`));
        r.unseen = false;
        refreshCounters();
      }
    },
    replace(r) { const i = this.reports.findIndex((x) => x.id === r.id); if (i >= 0) this.reports.splice(i, 1, r); this.reply = r.response_text || ''; },
    startEdit() { const r = this.report; this.editing = { kind: r.kind, title: r.title, body: r.body_text, impact: r.impact }; },
    async saveEdit() {
      const e = this.editing;
      if (draftError(e) || this.busy) return;
      this.busy = true;
      const r = await attempt(() => api.patch(`api/feedback/${this.report.id}`, { kind: e.kind, title: e.title, body_text: e.body, impact: e.impact }), 'Report updated');
      this.busy = false;
      if (r) { this.replace(r); this.editing = null; }
    },
    async setStatus(status) {
      const r = await attempt(() => api.patch(`api/feedback/${this.report.id}`, { status }));
      if (r) this.replace(r); else this.load();
    },
    async saveReply() {
      this.busy = true;
      const r = await attempt(() => api.patch(`api/feedback/${this.report.id}`, { response_text: this.reply }), 'Answer saved');
      this.busy = false;
      if (r) this.replace(r);
    },
    async remove() {
      if (!confirm(`Delete report #${this.report.id}? This cannot be undone.`)) return;
      if (await attempt(() => api.del(`api/feedback/${this.report.id}`), 'Report deleted')) { go('/feedback'); await this.load(); refreshCounters(); }
    },
  },
  template: `<div class="page wide feedback" :class="{'has-item': !!id}">
    <header class="page-title"><span class="sh-icon"><icon name="megaphone" :size="22"/></span><div><h1>Feedback</h1><p>Report a bug or suggest a feature, then follow what happens to it.</p></div>
      <div class="fb-actions"><button class="btn" @click="newReport('feature')"><icon name="lightbulb" :size="15"/> Request a feature</button><button class="btn primary" @click="newReport('bug')"><icon name="bug" :size="15"/> Report a bug</button></div></header>
    <div class="welcome-kpis fb-kpis"><div><b>{{ counts.total }}</b><span>{{ scope === 'all' ? 'reports' : 'your reports' }}</span></div><div><b>{{ counts.bug }}</b><span>bugs</span></div><div><b>{{ counts.feature }}</b><span>feature requests</span></div><div><b>{{ counts.open }}</b><span>open</span></div><div><b>{{ counts.done }}</b><span>done</span></div></div>
    <div class="fb-grid">
      <section class="panel fb-list">
        <div v-if="isAdmin" class="seg small fb-scope" role="group" aria-label="Which reports"><button type="button" :class="{on: scope === 'mine'}" :aria-pressed="scope === 'mine'" @click="scope = 'mine'">Mine</button><button type="button" :class="{on: scope === 'all'}" :aria-pressed="scope === 'all'" @click="scope = 'all'">All reports</button></div>
        <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Search reports…" aria-label="Search reports"></div>
        <div class="fb-filters"><select v-model="kind" aria-label="Filter by type"><option value="all">All types</option><option value="bug">Bugs</option><option value="feature">Features</option></select>
          <select v-model="status" aria-label="Filter by status"><option value="all">All statuses</option><option value="open">Open</option><option v-for="(s, k) in statuses" :key="k" :value="k">{{ s.label }}</option></select></div>
        <a v-for="r in shown" :key="r.id" class="fb-row" :class="{active: r.id === id, 'is-new': r.unseen}" :href="href(r)">
          <span class="action-icon" :class="'t-' + kinds[r.kind].tone"><icon :name="kinds[r.kind].icon" :size="15"/></span>
          <span class="fb-row-main"><b>{{ r.title }}</b><small><span class="pill" :class="'t-' + statuses[r.status].tone">{{ statuses[r.status].label }}</span> #{{ r.id }}<template v-if="!r.mine && r.author"> · {{ r.author }}</template> · {{ timeAgo(r.updated_at) }}</small></span>
          <i v-if="r.unseen" class="unread-dot" title="Updated"></i></a>
        <div v-if="loaded && !shown.length" class="d-empty">{{ reports.length ? 'No report matches this filter.' : 'No report yet.' }}</div>
      </section>

      <section class="panel fb-detail">
        <a v-if="id" class="help-back fb-back" href="#/feedback"><span aria-hidden="true">‹</span> All reports</a>
        <template v-if="report">
          <template v-if="editing">
            <h2>Edit report #{{ report.id }}</h2>
            <div class="field"><span>Type</span><div class="seg"><button v-for="(k, x) in kinds" :key="x" type="button" :class="{on: editing.kind === x}" @click="editing.kind = x">{{ k.label }}</button></div></div>
            <label class="field"><span>Title</span><input v-model="editing.title" :maxlength="maxTitle"></label>
            <label class="field"><span>Description</span><textarea v-model="editing.body" rows="8" :maxlength="maxBody"></textarea></label>
            <div class="field"><span>Impact</span><div class="seg"><button v-for="(l, k) in impacts" :key="k" type="button" :class="{on: editing.impact === k}" @click="editing.impact = k">{{ l }}</button></div></div>
            <div class="row-end"><button class="btn ghost" @click="editing = null">Cancel</button><button class="btn primary" :disabled="busy" @click="saveEdit">Save</button></div>
          </template>
          <template v-else>
            <header class="fb-head"><span class="action-icon" :class="'t-' + kinds[report.kind].tone"><icon :name="kinds[report.kind].icon" :size="18"/></span>
              <div><span class="eyebrow">{{ kinds[report.kind].label }} #{{ report.id }}</span><h2>{{ report.title }}</h2></div>
              <div class="row-gap"><button v-if="canEdit" class="btn sm" @click="startEdit"><icon name="edit" :size="14"/> Edit</button><button v-if="canDelete" class="icon-btn" title="Delete this report" aria-label="Delete this report" @click="remove"><icon name="trash" :size="16"/></button></div></header>
            <ol class="fb-steps" aria-label="Progress"><li v-for="(s, k) in statuses" v-show="k !== 'declined' || report.status === 'declined'" :key="k" :class="{on: report.status === k}"><i></i>{{ s.label }}</li></ol>
            <div v-if="isAdmin" class="fb-admin"><label>Status <select :value="report.status" @change="setStatus($event.target.value)"><option v-for="(s, k) in statuses" :key="k" :value="k">{{ s.label }}</option></select></label><span class="muted small">Administrator</span></div>
            <p class="fb-body">{{ report.body_text }}</p>
            <dl class="fb-meta"><div><dt>Impact</dt><dd>{{ impacts[report.impact] }}</dd></div><div v-if="report.author"><dt>From</dt><dd>{{ report.author }}<code v-if="report.author_orcid"> {{ report.author_orcid }}</code></dd></div>
              <div><dt>Sent</dt><dd :title="fullDate(report.created_at)">{{ timeAgo(report.created_at) }}</dd></div><div v-if="report.project_title"><dt>Project</dt><dd>{{ report.project_title }}</dd></div>
              <div v-if="report.page"><dt>Page</dt><dd><code>{{ report.page }}</code></dd></div><div v-if="report.client_info" class="wide"><dt>Browser</dt><dd>{{ report.client_info }}</dd></div></dl>
            <section v-if="report.response_text && !isAdmin" class="fb-answer"><h3><icon name="reply" :size="14"/> Answer<template v-if="report.responder"> from {{ report.responder }}</template></h3><p>{{ report.response_text }}</p><small class="muted">{{ timeAgo(report.responded_at) }}</small></section>
            <section v-if="isAdmin" class="fb-answer"><h3><icon name="reply" :size="14"/> Answer to the author</h3><textarea v-model="reply" rows="3" :maxlength="maxBody" placeholder="Visible to the author of the report" aria-label="Answer to the author"></textarea><div class="row-end"><button class="btn primary sm" :disabled="busy || !replyChanged" @click="saveReply">Save answer</button></div></section>
          </template>
        </template>
        <div v-else-if="id && loaded" class="d-empty">This report does not exist, or is not yours.</div>
        <div v-else class="fb-welcome"><span class="sh-icon"><icon name="megaphone" :size="24"/></span><h2>Help improve Open Questions</h2><p>Tell us what breaks and what is missing. Reports are private: only you and the administrators can read them.</p><div class="row-gap"><button class="btn" @click="newReport('feature')"><icon name="lightbulb" :size="15"/> Request a feature</button><button class="btn primary" @click="newReport('bug')"><icon name="bug" :size="15"/> Report a bug</button></div></div>
      </section>
    </div>
  </div>`,
};
