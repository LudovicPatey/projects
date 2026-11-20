import { api, setCsrf } from './api.js';
import { store, loadProject, refreshCounters, link } from './store.js';
import { registerCommon } from './components.js';
import { RichEditor, RichContent } from './editor.js';
import { PdfViewer } from './pdfviewer.js';
import { CommentsPanel } from './comments.js';
import { ConversationsView } from './views/conversations.js';
import { FilesView } from './views/files.js';
import { BibView } from './views/bib.js';
import { LoginScreen, ProjectsView, OverviewView, MembersView, ProfileView, NotificationsDrawer } from './views/misc.js';

const App = {
  data() { return { ready: false, showNotifs: false, projectError: null }; },
  computed: {
    store() { return store; },
    route() { return store.route; },
    nav() {
      return [
        { view: 'overview', icon: 'home', label: 'Question' },
        { view: 'conversations', icon: 'mail', label: 'Mail', badge: store.counters.conversations },
        { view: 'files', icon: 'files', label: 'Files' },
        { view: 'bib', icon: 'book', label: 'Biblio' },
        { view: 'members', icon: 'users', label: 'People' },
      ];
    },
    projectInitials() {
      const t = store.project?.title;
      if (!t) return '?';
      return t.split(/\s+/).filter((w) => w.length > 2).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || t[0].toUpperCase();
    },
  },
  watch: {
    'route.pid': {
      immediate: false,
      async handler(pid) {
        if (!pid || !store.user) return;
        if (store.project?.id === pid) return;
        this.projectError = null;
        store.project = null;
        try { await loadProject(pid); refreshCounters(); } catch (e) { this.projectError = e.message; }
      },
    },
    'store.project.title'(t) { document.title = t ? `${t} — Open Questions` : 'Open Questions'; },
  },
  async mounted() {
    try {
      const me = await api.get('api/me');
      setCsrf(me.csrf);
      store.user = me.user;
      store.dev = me.dev;
      if (me.user && store.route.pid) {
        try { await loadProject(store.route.pid); } catch (e) { this.projectError = e.message; }
      }
    } catch (e) { /* server error: show login */ }
    this.ready = true;
    if (store.user) {
      refreshCounters();
      setInterval(refreshCounters, 30000);
    }
  },
  template: `
  <div v-if="!ready" class="boot">Loading…</div>
  <login-screen v-else-if="!store.user"/>
  <div v-else class="shell">
    <nav class="rail">
      <a class="rail-logo" href="#/projects" :title="store.project ? store.project.title + ' — switch project' : 'All projects'">
        {{ store.project ? projectInitials : '?' }}</a>
      <template v-if="store.project && route.name === 'project'">
        <a v-for="it in nav" :key="it.view" class="rail-item" :class="{on: route.view === it.view}" :href="link(it.view)" :title="it.label">
          <icon :name="it.icon" :size="21"/><span>{{ it.label }}</span><b v-if="it.badge" class="badge">{{ it.badge > 99 ? '99+' : it.badge }}</b></a>
      </template>
      <a v-else class="rail-item" :class="{on: route.name === 'projects'}" href="#/projects" title="Projects"><icon name="grid" :size="21"/><span>Projects</span></a>
      <div class="grow"></div>
      <button class="rail-item" :class="{on: showNotifs}" @click="showNotifs = !showNotifs" title="Notifications">
        <icon name="bell" :size="21"/><span>Alerts</span><b v-if="store.counters.notifications" class="badge">{{ store.counters.notifications }}</b></button>
      <a class="rail-item" href="#/profile" :title="store.user.name"><avatar :name="store.user.name" :id="store.user.id" :size="30"/></a>
    </nav>
    <main class="main">
      <projects-view v-if="route.name === 'projects'"/>
      <profile-view v-else-if="route.name === 'profile'"/>
      <template v-else-if="route.name === 'project'">
        <div v-if="projectError" class="placeholder"><p>{{ projectError }}</p><a class="btn" href="#/projects">Back to projects</a></div>
        <template v-else-if="store.project && store.project.id === route.pid">
          <overview-view v-if="route.view === 'overview'"/>
          <conversations-view v-else-if="route.view === 'conversations'" :pid="route.pid" :id="route.id" :query="route.query"/>
          <files-view v-else-if="route.view === 'files'" :pid="route.pid" :id="route.id" :query="route.query"/>
          <bib-view v-else-if="route.view === 'bib'" :pid="route.pid" :id="route.id" :query="route.query"/>
          <members-view v-else-if="route.view === 'members'" :query="route.query"/>
        </template>
        <div v-else class="placeholder">Loading project…</div>
      </template>
    </main>
    <notifications-drawer v-if="showNotifs" @close="showNotifs = false"/>
  </div>
  <div class="toasts"><div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div></div>`,
  methods: { link },
};

const app = Vue.createApp(App);
registerCommon(app);
app.component('rich-editor', RichEditor);
app.component('rich-content', RichContent);
app.component('pdf-viewer', PdfViewer);
app.component('comments-panel', CommentsPanel);
app.component('conversations-view', ConversationsView);
app.component('files-view', FilesView);
app.component('bib-view', BibView);
app.component('login-screen', LoginScreen);
app.component('projects-view', ProjectsView);
app.component('overview-view', OverviewView);
app.component('members-view', MembersView);
app.component('profile-view', ProfileView);
app.component('notifications-drawer', NotificationsDrawer);
app.mount('#app');
