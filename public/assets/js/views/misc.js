import { api } from '../api.js';
import { store, go, link, attempt, toast, refreshProject, refreshMentionables, refreshCounters } from '../store.js';
import { timeAgo, fullDate } from '../util.js';

const first = (r) => (Array.isArray(r) ? r[0] : r);

export const LoginScreen = {
  data() { return { orcid: '0000-0002-1825-0097', name: 'Josiah Carberry', error: new URLSearchParams(location.search).get('login_error') }; },
  computed: { dev() { return store.dev; } },
  template: `<div class="login">
    <div class="login-card">
      <div class="logo-big">?</div>
      <h1>Open Questions</h1>
      <p class="muted">A collaborative platform where researchers and AI work together on open problems.</p>
      <p v-if="error" class="error-box">ORCID sign-in was cancelled or failed ({{ error }}).</p>
      <a class="btn orcid" href="auth/login">
        <svg width="22" height="22" viewBox="0 0 256 256" aria-hidden="true"><circle cx="128" cy="128" r="128" fill="#fff"/><path fill="#A6CE39" d="M86.3 186.2H70.9V79.1h15.4v107.1zM108.9 79.1h41.6c39.6 0 57 28.3 57 53.6 0 27.5-21.5 53.6-56.8 53.6h-41.8V79.1zm15.4 93.3h24.5c34.9 0 42.9-26.5 42.9-39.7C191.7 111.2 178 93 148 93h-23.7v79.4zM88.7 56.8c0 5.5-4.5 10.1-10.1 10.1s-10.1-4.6-10.1-10.1c0-5.6 4.5-10.1 10.1-10.1s10.1 4.6 10.1 10.1z"/></svg>
        Sign in with ORCID</a>
      <p class="muted small">Your ORCID iD is your account. We only read your public name.</p>
      <form v-if="dev" class="dev-login" action="auth/dev-login" method="get">
        <p class="small"><b>Development mode</b> — log in as any ORCID iD:</p>
        <input name="orcid" v-model="orcid"><input name="name" v-model="name" placeholder="Name">
        <button class="btn sm">Dev login</button>
      </form>
    </div></div>`,
};

export const ProjectsView = {
  data() { return { projects: [], canCreate: false, loaded: false, creating: false, title: '', busy: false }; },
  async mounted() {
    store.project = null;
    const r = await attempt(() => api.get('api/projects'));
    if (r) { this.projects = r.projects; this.canCreate = r.can_create; }
    this.loaded = true;
  },
  template: `<div class="page">
    <header class="page-head"><div><h1>Your research projects</h1>
      <p class="muted">Each project is organised around one open question.</p></div>
      <button v-if="canCreate" class="btn primary" @click="creating = true"><icon name="plus" :size="16"/> New project</button></header>
    <div class="project-grid">
      <a v-for="p in projects" :key="p.id" class="project-card" :href="'#/p/' + p.id">
        <div class="pc-top"><span class="tag" :class="{green: p.status==='solved'}">{{ p.status }}</span><span class="muted small">{{ p.role }}</span></div>
        <h3>{{ p.title }}</h3>
        <div class="muted small"><icon name="users" :size="13"/> {{ p.members }} researcher{{ p.members > 1 ? 's' : '' }} · updated {{ timeAgo(p.updated_at) }}</div>
      </a>
      <div v-if="loaded && !projects.length" class="empty big">
        You are not part of any project yet. Ask a project owner to add your ORCID iD
        <code>{{ store.user.orcid }}</code><template v-if="canCreate">, or create a new project</template>.</div>
    </div>
    <modal v-if="creating" title="New research project" wide @close="creating=false">
      <label class="field"><span>Title</span><input v-model="title" placeholder="e.g. The union-closed sets conjecture" autofocus></label>
      <div class="field"><span>The open question</span>
        <rich-editor ref="qEd" :min-height="160" placeholder="State the problem precisely. LaTeX between $…$ is rendered."/></div>
      <template #footer><button class="btn ghost" @click="creating=false">Cancel</button>
        <button class="btn primary" :disabled="busy" @click="create">Create project</button></template>
    </modal>
  </div>`,
  computed: { store() { return store; } },
  methods: {
    timeAgo,
    async create() {
      if (!this.title.trim()) return toast('A title is required', 'error');
      this.busy = true;
      const r = await attempt(() => api.post('api/projects', { title: this.title, question_html: first(this.$refs.qEd).getHTML() }));
      this.busy = false;
      if (r) go(`/p/${r.id}`);
    },
  },
};

export const OverviewView = {
  data() { return { editing: false, title: '' }; },
  computed: {
    p() { return store.project; },
    isOwner() { return this.p.my_role === 'owner'; },
  },
  template: `<div class="page">
    <header class="page-head">
      <div><span class="tag" :class="{green: p.status==='solved'}">{{ p.status }}</span>
        <h1 v-if="!editing">{{ p.title }}</h1>
        <input v-else class="title-input" v-model="title"></div>
      <div class="row-gap" v-if="isOwner">
        <select :value="p.status" @change="setStatus($event.target.value)" title="Project status">
          <option value="open">Open</option><option value="solved">Solved</option><option value="archived">Archived</option></select>
        <button v-if="!editing" class="btn" @click="startEdit"><icon name="edit" :size="15"/> Edit question</button>
      </div>
    </header>
    <section class="question-card">
      <h4>Open question</h4>
      <template v-if="editing">
        <rich-editor ref="qEd" :initial-html="p.question_html" :min-height="200"/>
        <div class="row-end"><button class="btn ghost" @click="editing=false">Cancel</button><button class="btn primary" @click="save">Save</button></div>
      </template>
      <rich-content v-else :html="p.question_html || '<p><em>No statement yet.</em></p>'" class="question"/>
    </section>
    <div class="stats">
      <a class="stat" :href="link('files')"><icon name="user" :size="20"/><b>{{ p.stats.documents_human }}</b><span>human files</span></a>
      <a class="stat ai" :href="link('files')"><icon name="bot" :size="20"/><b>{{ p.stats.documents_ai }}</b><span>AI files</span></a>
      <a class="stat" :href="link('bib')"><icon name="book" :size="20"/><b>{{ p.stats.bib }}</b><span>references</span></a>
      <a class="stat" :href="link('conversations')"><icon name="mail" :size="20"/><b>{{ p.stats.conversations }}</b><span>conversations</span></a>
    </div>
    <div class="overview-grid">
      <section class="card"><h4>Recent files</h4>
        <div v-if="!p.recent_documents.length" class="empty">No files yet.</div>
        <a v-for="d in p.recent_documents" :key="d.id" class="row-link" :href="link('files', d.id)">
          <origin-badge :origin="d.origin"/><span class="ellipsis">{{ d.title }}</span><span class="grow"></span><span class="muted small">{{ timeAgo(d.updated_at) }}</span></a>
      </section>
      <section class="card"><h4>Researchers <a class="small" :href="link('members')">manage</a></h4>
        <div class="row-link" v-for="m in p.members" :key="m.id"><avatar :name="m.name" :id="m.id" :kind="m.kind" :size="24"/>
          <span>{{ m.name }}</span><span class="grow"></span><span class="muted small">{{ m.kind === 'agent' ? 'AI agent' : m.role }}</span></div>
      </section>
    </div>
  </div>`,
  methods: {
    timeAgo, link,
    startEdit() { this.title = this.p.title; this.editing = true; },
    async save() {
      if (await attempt(() => api.patch(`api/projects/${this.p.id}`, { title: this.title, question_html: first(this.$refs.qEd).getHTML() }), 'Saved')) {
        this.editing = false; refreshProject();
      }
    },
    async setStatus(s) { if (await attempt(() => api.patch(`api/projects/${this.p.id}`, { status: s }))) refreshProject(); },
  },
};

export const MembersView = {
  props: { query: Object },
  data() { return { orcid: '', role: 'member', busy: false, agents: [], agentForm: { name: '', ai_model: '' }, newToken: null, snippet: '' }; },
  computed: {
    p() { return store.project; },
    isOwner() { return this.p.my_role === 'owner'; },
    me() { return store.user.id; },
    highlight() { return this.query?.user ? +this.query.user : null; },
    humans() { return this.p.members.filter((m) => m.kind !== 'agent'); },
    baseUrl() { return (location.origin + location.pathname).replace(/\/$/, ''); },
  },
  mounted() { this.loadAgents(); },
  template: `<div class="page">
    <header class="page-head"><div><h1>Researchers</h1><p class="muted">Everyone listed here can see the files, the bibliography and the conversations they take part in.</p></div></header>
    <form v-if="isOwner" class="card add-member" @submit.prevent="add">
      <h4>Add a researcher by ORCID iD</h4>
      <div class="row-gap">
        <input v-model="orcid" placeholder="0000-0000-0000-0000 or https://orcid.org/…" class="grow">
        <select v-model="role"><option value="member">Member</option><option value="owner">Owner</option></select>
        <button class="btn primary" :disabled="busy"><icon name="user-plus" :size="15"/> Add</button></div>
      <p class="muted small">They do not need to have signed in before: their public ORCID name is fetched automatically, and they gain access at their first ORCID sign-in.</p>
    </form>
    <table class="table members">
      <thead><tr><th>Name</th><th>ORCID iD</th><th>Role</th><th>Joined</th><th></th></tr></thead>
      <tbody><tr v-for="m in humans" :key="m.id" :class="{hl: m.id === highlight}">
        <td><div class="row-gap"><avatar :name="m.name" :id="m.id" :size="28"/><div><b>{{ m.name }}</b><span v-if="m.id === me" class="muted"> (you)</span>
          <div class="muted small" v-if="m.affiliation">{{ m.affiliation }}</div>
          <div class="muted small" v-if="!m.has_logged_in">has not signed in yet</div></div></div></td>
        <td><a :href="'https://orcid.org/' + m.orcid" target="_blank" rel="noopener" class="orcid-link">{{ m.orcid }}</a></td>
        <td><select v-if="isOwner" :value="m.role" @change="setRole(m, $event.target.value)"><option value="member">Member</option><option value="owner">Owner</option></select>
          <span v-else>{{ m.role }}</span></td>
        <td class="muted small">{{ timeAgo(m.joined_at) }}</td>
        <td class="right"><button v-if="isOwner && m.id !== me" class="btn xs" @click="removeM(m)">Remove</button>
          <button v-if="m.id === me" class="btn xs" @click="removeM(m)">Leave</button></td>
      </tr></tbody>
    </table>

    <section class="card agents-card">
      <h4><icon name="bot" :size="15"/> AI agents</h4>
      <p class="muted small agents-intro">AI agents take part through the API with a secret token: they read the question, files and bibliography,
        write in the conversations they are added to, comment, and upload files. Everything they write is labelled as AI,
        and the files they upload are always flagged <origin-badge origin="ai"/>. They cannot modify human-written files.
        API documentation: <code>docs/AGENT_API.md</code>.</p>
      <table class="table" v-if="agents.length">
        <thead><tr><th>Agent</th><th>Activity</th><th>Token</th><th>Last active</th><th></th></tr></thead>
        <tbody><tr v-for="a in agents" :key="a.id" :class="{hl: a.id === highlight}">
          <td><div class="row-gap"><avatar :name="a.name" :id="a.id" kind="agent" :size="28"/><div><b>{{ a.name }}</b>
            <div class="muted small">{{ a.ai_model || 'model not specified' }}</div></div></div></td>
          <td class="small">{{ a.messages }} message{{ a.messages == 1 ? '' : 's' }} · {{ a.documents }} file{{ a.documents == 1 ? '' : 's' }}</td>
          <td><code v-if="a.token">{{ a.token.token_prefix }}…</code><span v-else-if="isOwner" class="muted small">revoked</span><span v-else class="muted small">—</span></td>
          <td class="muted small">{{ a.last_used_at ? timeAgo(a.last_used_at) : 'never' }}</td>
          <td class="right"><template v-if="isOwner">
            <button class="btn xs" @click="rotate(a)" title="Revoke the current token and create a new one"><icon name="key" :size="12"/> New token</button>
            <button class="btn xs" @click="removeAgent(a)">Remove</button></template></td>
        </tr></tbody>
      </table>
      <div v-else class="muted small pad-y">No AI agent in this project yet.</div>
      <form v-if="isOwner" class="row-gap agent-form" @submit.prevent="createAgent">
        <input v-model="agentForm.name" placeholder="Agent name, e.g. Prover" required>
        <input v-model="agentForm.ai_model" placeholder="AI system / model, e.g. Claude Opus 5.5" class="grow">
        <button class="btn primary" :disabled="busy"><icon name="plus" :size="15"/> Create agent</button>
      </form>
    </section>

    <modal v-if="newToken" :title="'API token for ' + newToken.name" wide @close="newToken = null">
      <p class="warn-box"><b>Copy this token now — it will not be shown again.</b> Anyone holding it can act as this agent in this project.</p>
      <div class="row-gap"><input class="grow mono" readonly :value="newToken.token" @focus="$event.target.select()">
        <button class="btn" @click="copy(newToken.token)"><icon name="copy" :size="14"/> Copy</button></div>
      <h4 class="mt">Quick start</h4>
      <pre class="snippet">{{ snippet }}</pre>
      <button class="btn sm" @click="copy(snippet)"><icon name="copy" :size="13"/> Copy example</button>
      <template #footer><button class="btn primary" @click="newToken = null">Done</button></template>
    </modal>
  </div>`,
  methods: {
    timeAgo,
    async loadAgents() {
      const r = await attempt(() => api.get(`api/projects/${this.p.id}/agents`));
      if (r) this.agents = r.agents;
    },
    async createAgent() {
      this.busy = true;
      const r = await attempt(() => api.post(`api/projects/${this.p.id}/agents`, this.agentForm), 'Agent created');
      this.busy = false;
      if (!r) return;
      this.newToken = { name: this.agentForm.name, token: r.token };
      this.agentForm = { name: '', ai_model: '' };
      this.agents = r.agents;
      refreshProject(); refreshMentionables();
    },
    async rotate(a) {
      if (!confirm(`Create a new token for ${a.name}? The current token stops working immediately.`)) return;
      const r = await attempt(() => api.post(`api/projects/${this.p.id}/agents/${a.id}/token`));
      if (r) { this.newToken = { name: a.name, token: r.token }; this.agents = r.agents; }
    },
    async removeAgent(a) {
      if (!confirm(`Remove ${a.name}? Its token is revoked; its past messages and files are kept.`)) return;
      const r = await attempt(() => api.del(`api/projects/${this.p.id}/agents/${a.id}`), 'Agent removed');
      if (r) { this.agents = r.agents; refreshProject(); refreshMentionables(); }
    },
    copy(t) { navigator.clipboard?.writeText(t); toast('Copied'); },
    async add() {
      this.busy = true;
      const r = await attempt(() => api.post(`api/projects/${this.p.id}/members`, { orcid: this.orcid, role: this.role }), 'Researcher added');
      this.busy = false;
      if (r) { this.orcid = ''; this.p.members = r.members; refreshMentionables(); }
    },
    async setRole(m, role) {
      const r = await attempt(() => api.patch(`api/projects/${this.p.id}/members/${m.id}`, { role }));
      if (r) this.p.members = r.members; else refreshProject();
    },
    async removeM(m) {
      const self = m.id === this.me;
      if (!confirm(self ? 'Leave this project?' : `Remove ${m.name} from the project?`)) return;
      const r = await attempt(() => api.del(`api/projects/${this.p.id}/members/${m.id}`));
      if (!r) return;
      if (self) go('/projects'); else { this.p.members = r.members; refreshMentionables(); }
    },
  },
  watch: {
    newToken(v) {
      if (!v) return;
      const B = this.baseUrl, T = v.token;
      this.snippet = `# What is going on in the project?
curl -H "Authorization: Bearer ${T}" ${B}/api/agent/context

# Reply in a conversation the agent was added to (plain text, @mentions, LaTeX)
curl -X POST -H "Authorization: Bearer ${T}" -H "Content-Type: application/json" \\
  -d '{"body_text": "Proof idea for @{document:12}: apply $H(X) \\\\le \\\\log_2 |X|$."}' \\
  ${B}/api/conversations/ID/messages

# Upload an AI-written PDF (+ LaTeX sources)
curl -H "Authorization: Bearer ${T}" -F title="Lemma 3, proof attempt" \\
  -F pdf=@lemma3.pdf -F "sources[]=@lemma3.tex" ${B}/api/projects/${this.p.id}/documents`;
    },
  },
};

export const ProfileView = {
  data() { return { form: { name: store.user.name, affiliation: store.user.affiliation || '', email: store.user.email || '' } }; },
  computed: { user() { return store.user; } },
  template: `<div class="page narrow">
    <header class="page-head"><h1>Your profile</h1></header>
    <form class="card" @submit.prevent="save">
      <div class="row-gap"><avatar :name="user.name" :id="user.id" :size="48"/>
        <div>ORCID iD: <a :href="'https://orcid.org/' + user.orcid" target="_blank" rel="noopener" class="orcid-link">{{ user.orcid }}</a></div></div>
      <label class="field"><span>Display name</span><input v-model="form.name"></label>
      <label class="field"><span>Affiliation</span><input v-model="form.affiliation"></label>
      <label class="field"><span>Email <small class="muted">(only visible to you)</small></span><input v-model="form.email" type="email"></label>
      <div class="row-end"><button type="button" class="btn ghost" @click="logout"><icon name="logout" :size="15"/> Sign out</button>
        <button class="btn primary">Save</button></div>
    </form>
  </div>`,
  methods: {
    async save() {
      if (await attempt(() => api.patch('api/me', this.form), 'Profile saved')) Object.assign(store.user, this.form);
    },
    async logout() { await api.post('api/logout'); location.href = './'; },
  },
};

const KIND_LABEL = {
  mention: 'mentioned you', reply: 'replied to a thread you follow', added: 'added you to the project',
  added_to_conversation: 'added you to a conversation',
};

export const NotificationsDrawer = {
  emits: ['close'],
  data() { return { items: [], loaded: false }; },
  async mounted() { await this.load(); },
  template: `<div class="drawer-back" @mousedown.self="$emit('close')"><aside class="drawer">
    <header class="col-head"><h2>Notifications</h2>
      <div class="row-gap"><button class="link-btn" @click="readAll">Mark all read</button>
        <button class="icon-btn" @click="$emit('close')"><icon name="x"/></button></div></header>
    <div class="list">
      <div v-if="loaded && !items.length" class="empty">Nothing yet. You will be notified when someone @mentions you or replies to your comments.</div>
      <button v-for="n in items" :key="n.id" class="notif" :class="{unread: !n.read_at}" @click="open(n)">
        <avatar :name="n.payload.by?.name" :id="n.payload.by?.id" :size="30"/>
        <div><div><b>{{ n.payload.by?.name }}</b> {{ label(n.kind) }}</div>
          <div class="notif-ex" v-if="n.payload.excerpt">“{{ n.payload.excerpt }}”</div>
          <div class="muted small">{{ n.project_title }} · {{ timeAgo(n.created_at) }}</div></div>
      </button>
    </div></aside></div>`,
  methods: {
    timeAgo,
    label(k) { return KIND_LABEL[k] || k; },
    async load() {
      const r = await attempt(() => api.get('api/notifications'));
      if (r) this.items = r.notifications;
      this.loaded = true;
    },
    async open(n) {
      if (!n.read_at) { await api.post('api/notifications/read', { ids: [n.id] }); refreshCounters(); }
      const l = n.payload.link || {};
      let path = `/p/${n.project_id}/${l.view || 'overview'}` + (l.id ? `/${l.id}` : '');
      if (l.comment) path += `?comment=${l.comment}`;
      go(path);
      this.$emit('close');
    },
    async readAll() { await api.post('api/notifications/read', {}); refreshCounters(); this.load(); },
  },
};
