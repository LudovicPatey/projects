import { api } from '../api.js';
import { store, link, attempt, toast, refreshCounters } from '../store.js';
import { Kpi, StackBar } from '../dashboard.js';
import { TASK_SEGMENTS } from '../ai-model.js';
import { ADMIN_ACTIONS, ADMIN_OPTIONS, confirmed, describeChanges, hasChanges } from '../admin-model.js';

/** Maintenance of the project, for its owners. */
export const AdminView = {
  components: { Kpi, StackBar },
  props: { pid: Number },
  data() { return { d: null, options: {}, open: null, typed: '', preview: null, busy: false, last: null, keys: [], keyForm: { label: '', days: 7 }, newKey: null }; },
  computed: {
    owner() { return store.project?.my_role === 'owner'; },
    title() { return store.project?.title || ''; },
    groups() {
      const byKey = Object.fromEntries((this.d?.actions || []).map((a) => [a.action, a]));
      const of = (g) => Object.entries(ADMIN_ACTIONS).filter(([, m]) => m.group === g).map(([k, m]) => ({ key: k, ...m, preview: byKey[k] }));
      return [{ key: 'facts', title: 'Facts and extraction', icon: 'graph', items: of('facts') }, { key: 'ai', title: 'AI queue', icon: 'sparkles', items: of('ai') }];
    },
    canRun() { return this.open && this.preview && hasChanges(this.preview.changes) && (!this.open.destructive || confirmed(this.typed, this.title)); },
  },
  created() { this.optionLabels = ADMIN_OPTIONS; this.segments = TASK_SEGMENTS; },
  async mounted() { if (this.owner) { await this.load(); await this.loadKeys(); } },
  methods: {
    link, describeChanges, hasChanges,
    async load() { const r = await attempt(() => api.get(`api/projects/${this.pid}/admin`)); if (r) this.d = r; },
    async loadKeys() { const r = await attempt(() => api.get(`api/projects/${this.pid}/audit-keys`)); if (r) this.keys = r.keys; },
    async createKey() {
      const r = await attempt(() => api.post(`api/projects/${this.pid}/audit-keys`, { label: this.keyForm.label, days: +this.keyForm.days }));
      if (!r) return;
      this.keys = r.keys; this.keyForm.label = '';
      this.newKey = { token: r.token, site: location.origin + location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '') };
    },
    async revokeKey(k) {
      if (!confirm(`Revoke the audit key "${k.label}"? Anyone using it loses access at once.`)) return;
      const r = await attempt(() => api.del(`api/projects/${this.pid}/audit-keys/${k.id}`), 'Audit key revoked');
      if (r) this.keys = r.keys;
    },
    async copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied', 'success'); } catch { toast('Select the text and copy it', 'error'); } },
    when(s) { return s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; },
    opts(key) { return this.options[key] || (this.options[key] = {}); },
    query(key) { return Object.entries(this.opts(key)).filter(([, v]) => v).map(([k]) => (k === 'all' ? 'mode=all' : `${k}=1`)).join('&'); },
    async start(item) {
      this.open = { key: item.key, title: item.title, text: item.text, destructive: item.preview?.destructive, options: item.options };
      this.typed = ''; this.preview = null;
      await this.refreshPreview();
    },
    async refreshPreview() {
      const k = this.open.key;
      this.preview = await attempt(() => api.get(`api/projects/${this.pid}/admin/preview?action=${k}${this.query(k) ? '&' + this.query(k) : ''}`));
    },
    async run() {
      if (!this.canRun || this.busy) return;
      this.busy = true;
      const opts = this.opts(this.open.key);
      const r = await attempt(() => api.post(`api/projects/${this.pid}/admin`, { action: this.open.key, confirm: this.typed, options: { requeue: !!opts.requeue, notation: !!opts.notation, mode: opts.all ? 'all' : '' } }));
      this.busy = false;
      if (!r) return;
      this.last = { title: this.open.title, text: describeChanges(r.changes), backup: r.backup };
      toast(`${this.open.title}: done`, 'success');
      this.open = null;
      await this.load(); refreshCounters();
    },
  },
  template: `<div class="page wide admin-page">
    <header class="page-title"><span class="sh-icon"><icon name="settings" :size="22"/></span><div><h1>Administration</h1><p>Maintenance of this project. Only its owners see this page.</p></div></header>
    <div v-if="!owner" class="d-empty">Only the owners of this project can administer it.</div>
    <div v-else-if="!d" class="d-empty">Loading…</div>
    <template v-else>
      <div class="kpi-grid admin-kpis">
        <kpi icon="graph" :value="d.summary.facts" label="facts" :sub="d.summary.reviews + ' reviews · ' + d.summary.proofs + ' other proofs'" :href="link('facts')" tone="teal"/>
        <kpi icon="book" :value="d.summary.references" label="references" :sub="d.summary.reference_pdfs + ' with a PDF'" :href="link('bib')" tone="amber"/>
        <kpi icon="files" :value="d.summary.files" label="files" :href="link('files')" tone="violet"/>
        <kpi icon="sparkles" :value="d.summary.tasks.pending" label="AI tasks waiting" :sub="d.summary.tasks.failed + ' failed'" :href="link('ai')" :tone="d.summary.tasks.failed ? 'warn' : 'neutral'"/>
        <kpi icon="book" :value="d.summary.notation" label="notation entries" :href="link('facts', null, {mode: 'notation'})"/>
        <kpi icon="users" :value="d.summary.members" label="members" :href="link('members')" tone="blue"/>
      </div>
      <p v-if="last" class="admin-result" role="status"><icon name="check-circle" :size="15"/><span><b>{{ last.title }}.</b> {{ last.text }}.<template v-if="last.backup"> Backup made first: <code>{{ last.backup }}</code>.</template></span></p>
      <div class="admin-grid">
        <section v-for="g in groups" :key="g.key" class="panel">
          <header class="ai-head"><h2><icon :name="g.icon" :size="15"/> {{ g.title }}</h2></header>
          <stack-bar v-if="g.key === 'ai'" :counts="d.summary.tasks" :segments="segments" label="AI tasks by status"/>
          <article v-for="a in g.items" :key="a.key" class="admin-action" :class="{danger: a.preview?.destructive}">
            <span class="action-icon" :class="a.preview?.destructive ? 't-bad' : 't-info'"><icon :name="a.icon" :size="15"/></span>
            <div class="admin-action-main"><b>{{ a.title }}</b><p>{{ a.text }}</p>
              <small class="muted">Now: {{ describeChanges(a.preview?.changes) }}<template v-if="a.preview?.destructive"> · a verified backup is made first</template></small></div>
            <button class="btn sm" :class="{danger: a.preview?.destructive}" @click="start(a)">{{ a.preview?.destructive ? 'Review…' : 'Run…' }}</button>
          </article>
        </section>
        <section class="panel audit-panel">
          <header class="ai-head"><h2><icon name="key" :size="15"/> Audit access</h2></header>
          <p class="muted small">An audit key lets an auditor, a person or an AI, read this project's facts, notation and reviews through the audit API. It is read-only, works only for this project, expires, and can be revoked at any time. Private conversations stay hidden, and no email or ORCID iD is shared.</p>
          <div class="audit-form"><input v-model="keyForm.label" placeholder="Who it is for, e.g. Claude audit" aria-label="Label of the audit key" maxlength="120">
            <select v-model.number="keyForm.days" aria-label="How long it lasts"><option :value="1">1 day</option><option :value="7">7 days</option><option :value="30">30 days</option></select>
            <button class="btn primary sm" @click="createKey"><icon name="plus" :size="13"/> Create a key</button></div>
          <div v-if="newKey" class="audit-new" role="status">
            <b>Copy this key now: it is shown only once.</b>
            <div class="audit-token"><code>{{ newKey.token }}</code><button class="btn sm" @click="copy(newKey.token)"><icon name="copy" :size="13"/> Copy</button></div>
            <p class="muted small">To download everything for an audit, from a computer set up for this project:</p>
            <pre class="audit-cmd">OQ_AUDIT_URL={{ newKey.site }} OQ_AUDIT_KEY=&lt;the key&gt; npm run audit:fetch</pre>
            <button class="link-btn" @click="newKey = null">Done</button>
          </div>
          <div v-for="k in keys" :key="k.id" class="audit-key" :class="{off: !k.active}">
            <div class="audit-key-main"><b>{{ k.label }}</b> <code>{{ k.prefix }}…</code>
              <small class="muted">by {{ k.created_by }} · {{ k.revoked_at ? 'revoked ' + when(k.revoked_at) : (k.active ? 'expires ' + when(k.expires_at) : 'expired') }} · {{ k.uses ? k.uses + ' request' + (k.uses > 1 ? 's' : '') + ', last ' + when(k.last_used_at) : 'never used' }}</small></div>
            <button v-if="k.active" class="btn sm danger" :title="explain('audit.revoke')" @click="revokeKey(k)">Revoke</button>
          </div>
          <div v-if="!keys.length" class="d-empty">No audit key yet.</div>
        </section>
        <section class="panel">
          <header class="ai-head"><h2><icon name="settings" :size="15"/> Project</h2></header>
          <div class="admin-links">
            <a class="d-row" :href="link('overview')"><icon name="edit" :size="14"/><span class="d-title">Edit the title, the open question and the status</span></a>
            <a class="d-row" :href="link('members')"><icon name="users" :size="14"/><span class="d-title">Members, owners and AI agents</span></a>
            <a class="d-row" :href="link('facts', null, {mode: 'notation'})"><icon name="book" :size="14"/><span class="d-title">Project notation</span></a>
            <a class="d-row" :href="'api/projects/' + pid + '/export'" download><icon name="download" :size="14"/><span class="d-title">Download a copy of the project</span></a>
          </div>
          <p class="muted small">The whole platform is backed up by its administrator. Server commands: <code>php bin/admin.php --project {{ pid }}</code>, or <code>npm run admin -- --project {{ pid }}</code> from a computer set up to deploy.</p>
        </section>
      </div>
    </template>
    <modal v-if="open" :title="open.title" @close="open = null">
      <p>{{ open.text }}</p>
      <label v-for="o in open.options" :key="o" class="check"><input type="checkbox" v-model="opts(open.key)[o]" @change="refreshPreview"> {{ optionLabels[o] }}</label>
      <div class="admin-preview" :class="{danger: open.destructive}"><b>{{ open.destructive ? 'This deletes' : 'This changes' }}:</b> {{ preview ? describeChanges(preview.changes) : '…' }}
        <p v-if="preview?.changes.ratified_answers" class="admin-warn"><icon name="lightbulb" :size="14"/> {{ preview.changes.ratified_answers }} ratified answer{{ preview.changes.ratified_answers > 1 ? 's' : '' }} will be deleted. The status of their questions does not change.</p></div>
      <template v-if="open.destructive">
        <p class="muted small">A verified backup of the whole platform is made first, so the administrator can restore it. It cannot be undone here.</p>
        <label class="field"><span>Type the title of the project to confirm: <b>{{ title }}</b></span><input v-model="typed" autocomplete="off" spellcheck="false"></label>
      </template>
      <template #footer><button class="btn ghost" @click="open = null">Cancel</button><button class="btn" :class="open.destructive ? 'danger' : 'primary'" :disabled="!canRun || busy" @click="run">{{ busy ? 'Working…' : open.title }}</button></template>
    </modal>
  </div>`,
};
