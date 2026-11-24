import { api } from '../api.js';
import { store, go, link, attempt, toast, refreshProject, refreshMentionables, refreshCounters, markRead, markAllRead } from '../store.js';
import { timeAgo, fullDate } from '../util.js';
import { aiTimeSummary, computeTime } from '../ai-model.js';
import { FACT_SEGMENTS, PROOF_SEGMENTS, QUESTION_SEGMENTS, STRATEGY_SEGMENTS, dashboardComponents } from '../dashboard.js';

const first = (r) => (Array.isArray(r) ? r[0] : r);

export const ProjectsView = {
  data() { return { projects: [], canCreate: false, loaded: false, creating: false, title: '', busy: false }; },
  async mounted() {
    store.project = null;
    const r = await attempt(() => api.get('api/projects'));
    if (r) { this.projects = r.projects; this.canCreate = r.can_create; }
    this.loaded = true;
  },
  components: dashboardComponents,
  template: `<div class="page wide">
    <header class="welcome">
      <div><span class="eyebrow">Your workspace</span><h1>Welcome back, {{ firstName }}</h1>
        <p>{{ projects.length ? summary : 'Gather researchers and AI around an open problem.' }}</p></div>
      <button v-if="canCreate" class="btn primary" data-tour="new-project" @click="creating = true"><icon name="plus" :size="16"/> New project</button>
    </header>
    <client-card/>
    <div v-if="projects.length" class="welcome-kpis">
      <div><b>{{ projects.length }}</b><span>{{ projects.length === 1 ? 'project' : 'projects' }}</span></div><div><b>{{ totals.questions }}</b><span>questions</span></div>
      <div><b>{{ totals.facts }}</b><span>facts</span></div><div><b>{{ totals.files }}</b><span>files</span></div><div :class="{hot: totals.unread}"><b>{{ totals.unread }}</b><span>unread</span></div>
    </div>
    <div class="project-grid rich-grid">
      <a v-for="p in projects" :key="p.id" class="project-card" :href="'#/p/' + p.id">
        <b v-if="p.unread" class="ios-badge card-badge" :aria-label="p.unread + ' unread'">{{ p.unread > 99 ? '99+' : p.unread }}</b>
        <div class="pc-head"><span class="pc-mono" :style="{background: tint(p.id)}">{{ initials(p.title) }}</span>
          <div><h3><math-text :text="p.title"/></h3><div class="pc-tags"><pill :status="p.status === 'solved' ? 'solved_project' : p.status"/><span class="pill t-neutral">{{ p.role === 'owner' ? 'Owner' : 'Member' }}</span></div></div></div>
        <p class="pc-text"><math-text :text="p.question_text || 'No statement yet.'"/></p>
        <div class="pc-progress"><div><span>Questions settled</span><b>{{ p.counts.settled }}/{{ p.counts.questions }}</b></div><i><span :style="{width: (p.counts.questions ? 100 * p.counts.settled / p.counts.questions : 0) + '%'}"></span></i></div>
        <div class="pc-stats"><span title="Facts"><icon name="graph" :size="14"/> {{ p.counts.facts }}</span><span title="Files"><icon name="files" :size="14"/> {{ p.counts.files }}</span><span title="References"><icon name="book" :size="14"/> {{ p.counts.references }}</span><span v-if="p.ai_time" :title="'AI computing: ' + aiTimeSummary(p.ai_time)"><icon name="clock" :size="14"/> {{ computeTime(p.ai_time.standard.ms + p.ai_time.proving.ms) }}</span>
          <span class="grow"></span><span class="stack-av"><avatar v-for="u in p.people" :key="u.id" :name="u.name" :id="u.id" :kind="u.kind" :size="24"/></span></div>
        <footer>Updated {{ timeAgo(p.updated_at) }} · {{ p.members }} {{ p.members === 1 ? 'member' : 'members' }}</footer>
      </a>
      <div v-if="loaded && !projects.length" class="d-hero-empty"><span class="sh-icon"><icon name="target" :size="24"/></span><h3>No project yet</h3>
        <p>Ask a project owner to add your ORCID iD <code>{{ store.user.orcid }}</code><template v-if="canCreate">, or create a new project</template>.</p></div>
    </div>
    <modal v-if="creating" title="New research project" wide @close="creating=false">
      <label class="field"><span>Title</span><input v-model="title" placeholder="e.g. The union-closed sets conjecture" autofocus></label>
      <div class="field"><span>The open question</span>
        <rich-editor ref="qEd" :min-height="160" placeholder="State the problem precisely. LaTeX between $…$ is rendered."/></div>
      <template #footer><button class="btn ghost" @click="creating=false">Cancel</button>
        <button class="btn primary" :disabled="busy" @click="create">Create project</button></template>
    </modal>
  </div>`,
  computed: {
    store() { return store; },
    firstName() { return String(store.user.name || '').split(/\s+/)[0]; },
    totals() { return this.projects.reduce((t, p) => ({ questions: t.questions + p.counts.questions, facts: t.facts + p.counts.facts, files: t.files + p.counts.files, unread: t.unread + (p.unread || 0) }), { questions: 0, facts: 0, files: 0, unread: 0 }); },
    summary() { const n = this.totals.unread; return n ? `${n} new ${n === 1 ? 'item awaits' : 'items await'} you across your projects.` : 'You are up to date across your projects.'; },
  },
  methods: {
    timeAgo, computeTime, aiTimeSummary,
    initials(t) { return String(t).split(/[\s–—-]+/u).filter((w) => w.length > 2 && !['the', 'and', 'for', 'with'].includes(w.toLowerCase())).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'; },
    tint(id) { return ['#4338ca', '#0f766e', '#7c3aed', '#b45309', '#0369a1', '#be185d'][id % 6]; },
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
  components: dashboardComponents,
  data() { return { editing: false, title: '', d: null }; },
  computed: {
    p() { return store.project; },
    isOwner() { return this.p.my_role === 'owner'; },
    questionUnread() { return store.counters.unread?.question?.[this.p.id] || 0; },
    people() { return this.p.members.map((m) => ({ ...m, c: this.d?.people?.[m.id] || {} })); },
  },
  created() { this.seg = { QUESTION_SEGMENTS, STRATEGY_SEGMENTS, FACT_SEGMENTS, PROOF_SEGMENTS }; },
  mounted() { this.load(); },
  watch: {
    questionUnread: { immediate: true, handler(n) { if (n) refreshProject().then(() => markRead('question', this.p.id, this.p.last_activity_id)); } },
  },
  template: `<div class="page wide overview">
    <section class="hero">
      <div class="hero-main">
        <div class="hero-tags"><span class="eyebrow">Main problem</span><pill :status="p.status === 'solved' ? 'solved_project' : p.status"/></div>
        <h1 v-if="!editing"><math-text :text="p.title"/></h1><input v-else class="title-input" v-model="title" aria-label="Project title">
        <template v-if="editing">
          <rich-editor ref="qEd" :initial-html="p.question_html" :min-height="180"/>
          <div class="row-end"><button class="btn ghost" @click="editing=false">Cancel</button><button class="btn primary" @click="save">Save</button></div>
        </template>
        <rich-content v-else :html="p.question_html || '<p><em>No statement yet.</em></p>'" class="question"/>
        <div v-if="!editing" class="hero-actions">
          <a class="btn" :href="'api/projects/' + p.id + '/export'" download title="Download everything you can see in this project as a .zip" @click="preparing"><icon name="download" :size="15"/> Download project</a>
          <a class="btn" href="#/client" title="Download the AI client for your computer"><icon name="sparkles" :size="15"/> Get the AI client</a>
          <template v-if="isOwner"><button class="btn" @click="startEdit"><icon name="edit" :size="15"/> Edit</button>
          <select :value="p.status" @change="setStatus($event.target.value)" aria-label="Project status"><option value="open">Open</option><option value="solved">Solved</option><option value="archived">Archived</option></select></template>
        </div>
      </div>
      <div v-if="d" class="hero-side"><ring :done="d.questions.settled" :total="d.questions.total" :size="118" caption="questions settled"/><b>Questions settled</b>
        <span>{{ d.questions.big }} big {{ d.questions.big === 1 ? 'question' : 'questions' }}, {{ d.questions.strategies }} {{ d.questions.strategies === 1 ? 'strategy' : 'strategies' }}</span></div>
    </section>

    <template v-if="d">
    <div class="kpis">
      <kpi icon="target" :value="d.questions.total" label="Questions" :sub="d.questions.settled + ' settled'" :href="link('questions')"/>
      <kpi icon="graph" :value="d.facts.total" label="Facts" :sub="d.facts.endorsed + ' endorsed'" :href="link('facts')" tone="teal"/>
      <kpi icon="files" :value="d.files.total" label="Files" :sub="d.files.human + ' human, ' + d.files.ai + ' AI'" :href="link('files')" tone="violet"/>
      <kpi icon="book" :value="d.bib.total" label="References" :sub="d.bib.with_pdf + ' with PDF'" :href="link('bib')" tone="amber"/>
      <kpi icon="mail" :value="d.conversations.total" label="Conversations" :sub="d.conversations.messages + ' messages'" :href="link('conversations')" tone="blue"/>
      <kpi icon="clock" :value="computeTime(d.ai_time.standard.ms + d.ai_time.proving.ms)" label="AI computing" :sub="aiTimeSummary(d.ai_time)" :href="link('ai')"/>
    </div>
    <div class="dash">
      <div class="dash-col">
        <section class="panel"><header><h2><icon name="bell" :size="15"/> Needs your attention</h2></header><action-list :actions="d.actions"/></section>
        <section class="panel"><header><h2><icon name="target" :size="15"/> Big questions</h2><a :href="link('questions')">All questions ›</a></header>
          <a v-for="q in d.questions.roots" :key="q.id" class="big-q" :href="link('questions', q.id)">
            <div class="big-q-top"><i v-if="q.priority === 'high'" class="q-high" title="High priority">!</i><b><math-text :text="q.title"/></b><pill :status="q.status"/></div>
            <div v-if="q.total" class="big-q-bar"><i><span :style="{width: 100 * q.done / q.total + '%'}"></span></i><small>{{ q.done }}/{{ q.total }} sub-questions settled</small></div>
            <small v-else class="muted">{{ q.strategies }} {{ q.strategies === 1 ? 'strategy' : 'strategies' }}</small></a>
          <div v-if="!d.questions.roots.length" class="d-empty"><icon name="target" :size="20"/> <a :href="link('questions')">State the first question</a></div></section>
        <section class="panel"><header><h2><icon name="graph" :size="15"/> State of knowledge</h2><a :href="link('facts', null, {mode: 'graph'})">Fact graph ›</a></header>
          <div class="chart-grid"><div><h3>Questions</h3><stack-bar :counts="d.questions.by_status" :segments="seg.QUESTION_SEGMENTS" label="Questions by status"/></div>
          <div><h3>Strategies</h3><stack-bar :counts="d.questions.strategy_by_status" :segments="seg.STRATEGY_SEGMENTS" label="Strategies by status"/></div>
          <div><h3>Fact verification</h3><stack-bar :counts="d.facts.by_status" :segments="seg.FACT_SEGMENTS" label="Facts by verification status"/></div>
          <div><h3>Proof origin</h3><stack-bar :counts="d.facts.by_proof" :segments="seg.PROOF_SEGMENTS" label="Facts by proof origin"/></div></div></section>
      </div>
      <div class="dash-col">
        <section class="panel"><header><h2><icon name="history" :size="15"/> Recent activity</h2></header><activity-feed :items="d.activity"/></section>
        <section class="panel"><header><h2><icon name="users" :size="15"/> Team</h2><a :href="link('members')">People ›</a></header>
          <a v-for="m in people" :key="m.id" class="team-row" :href="link('members', null, {user: m.id})"><avatar :name="m.name" :id="m.id" :kind="m.kind" :size="32"/><span><b>{{ m.name }}</b><small>{{ m.kind === 'agent' ? (m.ai_model || 'AI agent') : (m.role === 'owner' ? 'Owner' : 'Member') }}</small></span>
            <span v-if="m.c.ai_online" class="team-ai" title="Their AI client is running"><icon name="sparkles" :size="11"/> AI on</span>
            <span class="team-n" title="Facts entered and reviews"><icon name="graph" :size="12"/> {{ (m.c.facts || 0) + (m.c.reviews || 0) }}</span></a></section>
        <section class="panel"><header><h2><icon name="files" :size="15"/> Recent files</h2><a :href="link('files')">All files ›</a></header>
          <a v-for="f in d.files.recent" :key="f.id" class="d-row" :href="link('files', f.id)"><origin-badge :origin="f.origin"/><span class="d-title">{{ f.title }}</span><small>{{ timeAgo(f.updated_at) }}</small></a>
          <div v-if="!d.files.recent.length" class="d-empty">No file yet.</div></section>
      </div>
    </div>
    </template>
    <div v-else class="placeholder">Loading…</div>
  </div>`,
  methods: {
    timeAgo, link, computeTime, aiTimeSummary,
    async load() { try { this.d = await api.get(`api/projects/${this.p.id}/dashboard`); } catch (e) { toast(e.message, 'error'); } },
    preparing() { toast('Preparing your copy. The download starts when it is ready.'); },
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
  data() { return { orcid: '', role: 'member', busy: false, agents: [], agentForm: { name: '', ai_model: '' }, newToken: null, snippet: '', contrib: {} }; },
  computed: {
    p() { return store.project; },
    isOwner() { return this.p.my_role === 'owner'; },
    me() { return store.user.id; },
    highlight() { return this.query?.user ? +this.query.user : null; },
    humans() { return this.p.members.filter((m) => m.kind !== 'agent'); },
    baseUrl() { return (location.origin + location.pathname).replace(/\/$/, ''); },
    newMembers() { return store.counters.totals?.member || 0; },
  },
  mounted() { this.loadAgents(); this.loadContrib(); },
  template: `<div class="page wide">
    <header class="page-title"><span class="sh-icon"><icon name="users" :size="22"/></span><div><h1>People</h1><p>Everyone here can see the files, facts, questions and bibliography, and the conversations they take part in.</p></div>
      <div class="title-kpis"><div><b>{{ humans.length }}</b><span>researchers</span></div><div><b>{{ agents.length }}</b><span>AI agents</span></div></div></header>
    <form v-if="isOwner" class="panel add-member" @submit.prevent="add">
      <header><h2><icon name="user-plus" :size="15"/> Add a researcher by ORCID iD</h2></header>
      <div class="row-gap wrap-sm">
        <input v-model="orcid" placeholder="0000-0000-0000-0000 or https://orcid.org/…" class="grow" aria-label="ORCID iD">
        <select v-model="role" aria-label="Role"><option value="member">Member</option><option value="owner">Owner</option></select>
        <button class="btn primary" :disabled="busy"><icon name="user-plus" :size="15"/> Add</button></div>
      <p class="muted small">They do not need to have signed in before. Their public ORCID name is fetched automatically, and they gain access at their first ORCID sign-in.</p>
    </form>
    <h2 class="group-title">Researchers <span>{{ humans.length }}</span></h2>
    <div class="people-grid">
      <article v-for="m in humans" :key="m.id" class="person" :class="{hl: m.id === highlight}">
        <header><avatar :name="m.name" :id="m.id" :size="46"/><div><h3>{{ m.name }}<small v-if="m.id === me"> you</small></h3><p>{{ m.affiliation || 'No affiliation given' }}</p>
          <a :href="'https://orcid.org/' + m.orcid" target="_blank" rel="noopener" class="orcid-link">{{ m.orcid }}</a></div></header>
        <dl class="contrib"><div><dd>{{ c(m).questions }}</dd><dt>Questions</dt></div><div><dd>{{ c(m).strategies }}</dd><dt>Strategies</dt></div><div><dd>{{ c(m).facts }}</dd><dt>Facts</dt></div><div><dd>{{ c(m).reviews }}</dd><dt>Reviews</dt></div><div><dd>{{ c(m).files }}</dd><dt>Files</dt></div></dl>
        <footer><select v-if="isOwner" class="sm" :value="m.role" :aria-label="'Role of ' + m.name" @change="setRole(m, $event.target.value)"><option value="member">Member</option><option value="owner">Owner</option></select>
          <span v-else class="pill" :class="m.role === 'owner' ? 't-info' : 't-neutral'">{{ m.role === 'owner' ? 'Owner' : 'Member' }}</span>
          <span class="muted small">{{ m.has_logged_in ? 'joined ' + timeAgo(m.joined_at) : 'has not signed in yet' }}</span><span class="grow"></span>
          <button v-if="isOwner && m.id !== me" class="btn sm" @click="removeM(m)">Remove</button><button v-if="m.id === me" class="btn sm" @click="removeM(m)">Leave</button></footer>
      </article>
    </div>

    <h2 class="group-title"><icon name="bot" :size="16"/> AI agents <span>{{ agents.length }}</span></h2>
    <p class="muted small group-intro">Agents work through the API with a secret token. Everything they write is labelled as AI, and they cannot modify human-written files or ratify an answer.</p>
    <div class="people-grid">
      <article v-for="a in agents" :key="a.id" class="person agent" :class="{hl: a.id === highlight}">
        <header><avatar :name="a.name" :id="a.id" kind="agent" :size="46"/><div><h3>{{ a.name }}</h3>
          <p><button v-if="isOwner" type="button" class="link-btn" title="Change the model" @click="setModel(a)">{{ a.ai_model || 'Set model (required to write)' }}</button><span v-else>{{ a.ai_model || 'model not set' }}</span></p>
          <code v-if="a.token">{{ a.token.token_prefix }}…</code><span v-else-if="isOwner" class="muted small">token revoked</span></div></header>
        <dl class="contrib"><div><dd>{{ a.messages }}</dd><dt>Messages</dt></div><div><dd>{{ a.documents }}</dd><dt>Files</dt></div><div><dd>{{ c(a).facts }}</dd><dt>Facts</dt></div><div><dd>{{ c(a).reviews }}</dd><dt>Reviews</dt></div></dl>
        <footer><span class="muted small">{{ a.last_used_at ? 'active ' + timeAgo(a.last_used_at) : 'never active' }}</span><span class="grow"></span>
          <template v-if="isOwner"><button class="btn xs" @click="rotate(a)" title="Revoke the current token and create a new one"><icon name="key" :size="12"/> New token</button><button class="btn xs" @click="removeAgent(a)">Remove</button></template></footer>
      </article>
      <form v-if="isOwner" class="person new-agent" @submit.prevent="createAgent">
        <h3><icon name="plus" :size="15"/> New AI agent</h3>
        <input v-model="agentForm.name" placeholder="Name, e.g. Prover" aria-label="Agent name" required>
        <input v-model="agentForm.ai_model" placeholder="AI model, e.g. claude-opus-5-5" aria-label="AI model" required>
        <button class="btn primary" :disabled="busy">Create agent</button>
      </form>
      <div v-if="!agents.length && !isOwner" class="d-empty">No AI agent in this project yet.</div>
    </div>

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
    c(m) { return this.contrib[m.id] || { questions: 0, strategies: 0, facts: 0, reviews: 0, files: 0 }; },
    async loadContrib() { try { this.contrib = (await api.get(`api/projects/${this.p.id}/dashboard`)).people; } catch { this.contrib = {}; } },
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
    async setModel(a) {
      const m = prompt(`AI model behind ${a.name}. Past content keeps the model it was written with.`, a.ai_model || '');
      if (m === null) return;
      const r = await attempt(() => api.patch(`api/projects/${this.p.id}/agents/${a.id}`, { ai_model: m }), 'Model updated');
      if (r) this.agents = r.agents;
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
    newMembers: { immediate: true, handler(n) { if (n) { refreshProject(); this.loadAgents(); setTimeout(() => { if (store.route.view === 'members') markAllRead('member'); }, 1200); } } },
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
  data() { return { form: { name: store.user.name, affiliation: store.user.affiliation || '', email: store.user.email || '' }, keys: [], keyName: '', newKey: null, busy: false, projects: [] }; },
  computed: {
    user() { return store.user; },
    baseUrl() { return (location.origin + location.pathname).replace(/\/$/, ''); },
    setup() { return `export OQ_URL=${this.baseUrl}\nexport OQ_KEY=${this.newKey?.token || ''}`; },
    instructions() {
      return `You are my AI client for the Open Questions research platform.
The base URL is in $OQ_URL and my API key is in $OQ_KEY. Send it as "Authorization: Bearer $OQ_KEY". Never print it or write it to a file.

1. GET /api/projects to list my projects, then GET /api/projects/{id}/context for the question, members, files, bibliography, facts and conversations. GET /api/fact-format gives the exact fact format.
2. Read the sources: GET /api/files/{id}, GET /api/bib/{id}/pdf, GET /api/conversations/{id}, GET /api/comments?type=...&id=...
3. Propose facts, then submit them with POST /api/projects/{id}/facts/batch, using "dry_run": true first.
   - Extracted from a paper or a discussion: "method": "extracted", with sources giving the page, an exact quote, and "covers" (statement, proof or both). Do not improve or complete the result. If you write a proof the source does not contain, it is recorded as an AI proof. For an uploaded file, add "authors" if the paper names them.
   - New results, for example from Danus: "method": "deduced", with a proof.
   - Give each fact one or more "labels": conclusion, example, counterexample, proof_attempt, plan, dead_end, direction, obstacle, master_guidance, verification, elaboration.
4. Always send "ai_model" with your exact model. Send "generation_seconds" per item only if you actually measured it. Never estimate it. Declare every dependency. Search existing facts first to avoid duplicates.
5. A fact is visible to every project member. Before citing a private conversation, ask me, then send "publish_private": true.

Do not mark anything as verified on my behalf. Humans and other models review the facts.`;
    },
  },
  mounted() { this.loadKeys(); this.loadProjects(); },
  template: `<div class="page wide">
    <section class="profile-hero"><avatar :name="user.name" :id="user.id" :size="72"/>
      <div><span class="eyebrow">Your profile</span><h1>{{ user.name }}</h1><p>{{ user.affiliation || 'Add your affiliation below' }}</p>
        <a :href="'https://orcid.org/' + user.orcid" target="_blank" rel="noopener" class="orcid-link">{{ user.orcid }}</a></div>
      <div class="title-kpis"><div><b>{{ projects.length }}</b><span>{{ projects.length === 1 ? 'project' : 'projects' }}</span></div><div><b>{{ keys.length }}</b><span>API {{ keys.length === 1 ? 'key' : 'keys' }}</span></div></div>
      <button type="button" class="btn" @click="logout"><icon name="logout" :size="15"/> Sign out</button>
    </section>
    <div class="dash">
      <div class="dash-col">
        <form class="panel" @submit.prevent="save"><header><h2><icon name="user" :size="15"/> Identity</h2></header>
          <div class="grid2"><label class="field"><span>Display name</span><input v-model="form.name"></label>
          <label class="field"><span>Affiliation</span><input v-model="form.affiliation"></label></div>
          <label class="field"><span>Email <small class="muted">(only visible to you)</small></span><input v-model="form.email" type="email"></label>
          <div class="row-end"><button class="btn primary">Save</button></div>
        </form>
        <section class="panel keys-card"><header><h2><icon name="key" :size="15"/> Personal API keys</h2></header>
          <p class="muted small">A key lets your AI client read everything you can read, and submit facts, reviews, Lean proofs, questions, strategies and proposed answers. What it writes is labelled with its AI model. It cannot send messages, change files, manage the project or ratify an answer. Treat a key like a password.</p>
          <div v-for="k in keys" :key="k.id" class="key-row"><span class="action-icon t-info"><icon name="key" :size="14"/></span><span class="key-main"><b class="ellipsis">{{ k.name }}</b><code>{{ k.token_prefix }}…</code></span>
            <span class="muted small">{{ k.last_used_at ? 'used ' + timeAgo(k.last_used_at) : 'never used' }}</span>
            <button class="btn xs" @click="revokeKey(k)">Revoke</button></div>
          <div v-if="!keys.length" class="d-empty">No key yet. Create one to connect your AI client.</div>
          <form class="row-gap agent-form" @submit.prevent="createKey">
            <input v-model="keyName" class="grow" required maxlength="120" placeholder="Key name, e.g. Claude Code on my laptop" aria-label="Key name">
            <button class="btn primary" :disabled="busy"><icon name="plus" :size="15"/> Create key</button></form>
        </section>
      </div>
      <div class="dash-col">
        <section class="panel"><header><h2><icon name="grid" :size="15"/> Your projects</h2><a href="#/projects">All ›</a></header>
          <a v-for="p in projects" :key="p.id" class="team-row" :href="'#/p/' + p.id"><span class="pc-mono sm">{{ initial(p.title) }}</span><span><b><math-text :text="p.title"/></b><small>{{ p.role === 'owner' ? 'Owner' : 'Member' }} · {{ p.counts.questions }} questions · {{ p.counts.facts }} facts</small></span><b v-if="p.unread" class="ios-badge">{{ p.unread > 99 ? '99+' : p.unread }}</b></a>
          <div v-if="!projects.length" class="d-empty">No project yet.</div></section>
        <section class="panel tip-panel"><header><h2><icon name="bot" :size="15"/> Working with AI</h2></header>
          <p class="muted small">Your AI client extracts facts from papers and discussions, and proposes answers. You stay in charge: humans endorse facts and ratify answers.</p>
          <a class="btn sm" href="#/client"><icon name="download" :size="14"/> Download the AI client</a></section>
      </div>
    </div>
    <modal v-if="newKey" :title="'API key: ' + newKey.name" wide @close="newKey = null">
      <p class="warn-box"><b>Copy this key now. It will not be shown again.</b> Anyone holding it can read your projects and submit facts in your name.</p>
      <h4>Connect the AI client app</h4>
      <p class="muted small">Open the app, go to <b>Accounts</b>, and paste these two values.</p>
      <label class="key-copy"><span>Personal key</span><input :value="newKey.token" readonly spellcheck="false" aria-label="Personal key" @focus="$event.target.select()"><button type="button" class="btn sm primary" @click="copy(newKey.token)"><icon name="copy" :size="13"/> Copy key</button></label>
      <label class="key-copy"><span>Platform address</span><input :value="baseUrl" readonly spellcheck="false" aria-label="Platform address" @focus="$event.target.select()"><button type="button" class="btn sm" @click="copy(baseUrl)"><icon name="copy" :size="13"/> Copy</button></label>
      <p class="small"><a href="#/client" @click="newKey = null">Don't have the app yet? Download it</a></p>
      <details class="key-advanced"><summary>Command line or another AI client</summary>
        <div class="key-guide"><icon name="terminal" :size="17"/><div>The step-by-step guide tells you when to paste this key.</div><a class="btn sm" href="#/help?a=ai-setup" @click="newKey = null">Open the guide</a></div>
        <h4>1. Set it in the terminal of your AI client</h4>
        <pre class="snippet">{{ setup }}</pre>
        <button class="btn sm" @click="copy(setup)"><icon name="copy" :size="13"/> Copy commands</button>
        <h4 class="mt">2. Give these instructions to your AI client</h4>
        <pre class="snippet wrap">{{ instructions }}</pre>
        <button class="btn sm" @click="copy(instructions)"><icon name="copy" :size="13"/> Copy instructions</button>
      </details>
      <template #footer><button class="btn primary" @click="newKey = null">Done</button></template>
    </modal>
  </div>`,
  methods: {
    timeAgo,
    async copy(t) {
      try { await navigator.clipboard.writeText(t); toast('Copied'); } catch { toast('Could not copy. Select the text and copy it yourself.'); }
    },
    initial(t) { return String(t).split(/[\s\u2013\u2014-]+/u).filter((w) => w.length > 2 && w.toLowerCase() !== 'the').slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'; },
    async loadProjects() { const r = await attempt(() => api.get('api/projects')); if (r) this.projects = r.projects; },
    async loadKeys() { const r = await attempt(() => api.get('api/me/keys')); if (r) this.keys = r.keys; },
    async createKey() {
      this.busy = true;
      const r = await attempt(() => api.post('api/me/keys', { name: this.keyName }), 'Key created');
      this.busy = false;
      if (!r) return;
      this.newKey = { name: this.keyName, token: r.token };
      this.keys = r.keys; this.keyName = '';
    },
    async revokeKey(k) {
      if (!confirm(`Revoke the key “${k.name}”? Clients using it stop working immediately.`)) return;
      const r = await attempt(() => api.del(`api/me/keys/${k.id}`), 'Key revoked');
      if (r) this.keys = r.keys;
    },
    async save() {
      if (await attempt(() => api.patch('api/me', this.form), 'Profile saved')) Object.assign(store.user, this.form);
    },
    async logout() { await api.post('api/logout'); location.href = './'; },
  },
};

const KIND_LABEL = {
  mention: 'mentioned you', reply: 'replied to a thread you follow', added: 'added you to the project',
  added_to_conversation: 'added you to a conversation',
  ai_done: 'completed your AI request',
  conversation_extract: 'asked to share facts from a private conversation',
  answer_proposed: 'proposed an answer to your question', answer_ratified: 'ratified your proposed answer', answer_rejected: 'rejected your proposed answer',
  answer_revoked: 'revoked the ratification of your answer', answer_fact: 'changed a fact behind an answer you ratified',
  fact_review: 'reviewed your fact', fact_proof: 'proposed another proof of your fact', fact_proof_review: 'reviewed your proof', fact_retracted: 'retracted a fact in your dependency chain',
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
          <div class="notif-ex" v-if="n.payload.excerpt && n.kind !== 'added'">“{{ n.payload.excerpt }}”</div>
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
      const q = new URLSearchParams();
      if (l.strategy) q.set('strategy', l.strategy);
      if (l.comment) q.set('comment', l.comment);
      if ([...q].length) path += `?${q}`;
      go(path);
      this.$emit('close');
    },
    async readAll() { await api.post('api/notifications/read', {}); refreshCounters(); this.load(); },
  },
};
