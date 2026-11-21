import { api, setCsrf } from './api.js';
import { store, go, loadProject, refreshCounters, link } from './store.js';
import { registerCommon } from './components.js';
import { RichEditor, RichContent, MathText } from './editor.js';
import { PdfViewer } from './pdfviewer.js';
import { CommentsPanel } from './comments.js';
import { ConversationsView } from './views/conversations.js';
import { FilesView } from './views/files.js';
import { BibView } from './views/bib.js';
import { FactsView } from './views/facts.js';
import { QuestionsView } from './views/questions.js';
import { LandingPage } from './views/landing.js';
import { GlobalSearch } from './search.js';
import { HelpView } from './views/help.js';
import { TourGuide } from './tour.js';
import { FeedbackDialog, FeedbackView, openFeedback } from './views/feedback.js';
import { RefPreview } from './refs-client.js';
import { SectionActivity, SectionHome } from './dashboard.js';
import { VIEW_HELP } from './help/content.js';
import { ProjectsView, OverviewView, MembersView, ProfileView, NotificationsDrawer } from './views/misc.js';

const App = {
  data() { return { ready: false, showNotifs: false, projectError: null }; },
  computed: {
    store() { return store; },
    route() { return store.route; },
    nav() {
      const t = store.counters.totals || {};
      return [
        { view: 'overview', icon: 'home', label: 'Overview', badge: t.question },
        { view: 'questions', icon: 'target', label: 'Questions', badge: (t.oquestion || 0) + (t.strategy || 0) },
        { view: 'conversations', icon: 'mail', label: 'Mail', badge: t.conversation },
        { view: 'facts', icon: 'graph', label: 'Facts', badge: t.fact },
        { view: 'files', icon: 'files', label: 'Files', badge: t.document },
        { view: 'bib', icon: 'book', label: 'Biblio', badge: t.bib },
        { view: 'members', icon: 'users', label: 'People', badge: t.member },
      ];
    },
    isHelp() { return store.route.name === 'help' || store.route.view === 'help'; },
    helpHome() { return store.route.name === 'project' ? `#/p/${store.route.pid}/help` : '#/help'; },
    contextHelp() {
      const r = store.route;
      if (r.name === 'project') return `#/p/${r.pid}/help?a=${VIEW_HELP[r.view] || 'welcome'}`;
      return `#/help?a=${r.name === 'profile' ? 'account' : r.name === 'feedback' ? 'feedback' : 'create-project'}`;
    },
    listViews() { return ['questions', 'conversations', 'facts', 'files', 'bib']; },
    itemOpen() { const r = store.route; return !!(r.id || r.query?.compose || r.query?.upload); },
    backLink() { return link(store.route.view, null, store.route.query?.mode ? { mode: store.route.query.mode } : null); },
    unreadTotal() { return Object.values(store.counters.totals || {}).reduce((a, b) => a + b, 0); },
    projectInitials() {
      const t = store.project?.title;
      if (!t) return '?';
      const skip = new Set(['the', 'and', 'for', 'with', 'from', 'une', 'les', 'des']);
      const words = t.split(/[\s\u2013\u2014-]+/u).filter((w) => w.length > 2 && !skip.has(w.toLowerCase()));
      return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || t[0].toUpperCase();
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
        store.counters = { ...store.counters, totals: {}, unread: {} };
        try { await loadProject(pid); refreshCounters(); } catch (e) { this.projectError = e.message; }
      },
    },
    'store.project.title'() { this.setTitle(); },
    unreadTotal() { this.setTitle(); },
  },
  async mounted() {
    try {
      const me = await api.get('api/me');
      setCsrf(me.csrf);
      store.user = me.user;
      store.toursSeen = me.tours_seen || [];
      store.dev = me.dev;
      if (me.user && store.route.pid) {
        try { await loadProject(store.route.pid); } catch (e) { this.projectError = e.message; }
      }
    } catch (e) { /* server error: show login */ }
    this.ready = true;
    if (store.user) {
      refreshCounters();
      setInterval(refreshCounters, 15000);
    }
  },
  template: `
  <div v-if="!ready" class="boot">Loading…</div>
  <landing-page v-else-if="!store.user"/>
  <div v-else class="shell">
    <nav class="rail">
      <a class="rail-logo" href="#/projects" :title="store.project ? store.project.title + ' — switch project' : 'All projects'">
        {{ store.project ? projectInitials : '?' }}</a>
      <template v-if="store.project && route.name === 'project'">
        <a v-for="it in nav" :key="it.view" class="rail-item" :class="{on: route.view === it.view}" :href="link(it.view)" :title="it.label" :data-tour="'nav-' + it.view">
          <icon :name="it.icon" :size="21"/><span>{{ it.label }}</span><b v-if="it.badge" class="badge">{{ it.badge > 99 ? '99+' : it.badge }}</b></a>
      </template>
      <a v-else class="rail-item" :class="{on: route.name === 'projects'}" href="#/projects" title="Projects" data-tour="nav-projects"><icon name="grid" :size="21"/><span>Projects</span></a>
      <div class="grow"></div>
      <a class="rail-item" :class="{on: isHelp}" :href="helpHome" title="Help center" data-tour="help"><icon name="help" :size="21"/><span>Help</span></a>
      <a class="rail-item" :class="{on: route.name === 'feedback'}" href="#/feedback" title="Report a bug or request a feature" data-tour="feedback" @click.prevent="feedbackClick"><icon name="megaphone" :size="21"/><span>Feedback</span><b v-if="store.counters.feedback" class="badge">{{ store.counters.feedback }}</b></a>
      <button class="rail-item" :class="{on: showNotifs}" @click="showNotifs = !showNotifs" title="Notifications" data-tour="alerts">
        <icon name="bell" :size="21"/><span>Alerts</span><b v-if="store.counters.notifications" class="badge">{{ store.counters.notifications }}</b></button>
      <a class="rail-item" href="#/profile" :title="store.user.name" data-tour="profile"><avatar :name="store.user.name" :id="store.user.id" :size="30"/></a>
    </nav>
    <div class="app-column">
    <header class="topbar">
      <a class="topbar-title ellipsis" :href="store.project && route.name === 'project' ? link('overview') : '#/projects'">{{ store.project && route.name === 'project' ? store.project.title : 'Open Questions' }}</a>
      <global-search/>
      <span class="topbar-side"><a v-if="!isHelp" class="btn ghost sm" :href="contextHelp" title="Help about this page"><icon name="help" :size="16"/> Help</a></span>
    </header>
    <main class="main" :class="{'item-open': itemOpen}">
      <a v-if="route.name === 'project' && itemOpen && listViews.includes(route.view)" class="mobile-back" :href="backLink"><span aria-hidden="true">‹</span> Back to list</a>
      <projects-view v-if="route.name === 'projects'"/>
      <profile-view v-else-if="route.name === 'profile'"/>
      <help-view v-else-if="route.name === 'help'" :pid="null" :query="route.query"/>
      <feedback-view v-else-if="route.name === 'feedback'" :id="route.id"/>
      <template v-else-if="route.name === 'project'">
        <div v-if="projectError" class="placeholder"><p>{{ projectError }}</p><a class="btn" href="#/projects">Back to projects</a></div>
        <template v-else-if="store.project && store.project.id === route.pid">
          <overview-view v-if="route.view === 'overview'"/>
          <help-view v-else-if="route.view === 'help'" :pid="route.pid" :query="route.query"/>
          <questions-view v-else-if="route.view === 'questions'" :pid="route.pid" :id="route.id" :query="route.query"/>
          <conversations-view v-else-if="route.view === 'conversations'" :pid="route.pid" :id="route.id" :query="route.query"/>
          <facts-view v-else-if="route.view === 'facts'" :pid="route.pid" :id="route.id" :query="route.query"/>
          <files-view v-else-if="route.view === 'files'" :pid="route.pid" :id="route.id" :query="route.query"/>
          <bib-view v-else-if="route.view === 'bib'" :pid="route.pid" :id="route.id" :query="route.query"/>
          <members-view v-else-if="route.view === 'members'" :query="route.query"/>
        </template>
        <div v-else class="placeholder">Loading project…</div>
      </template>
    </main>
    </div>
    <notifications-drawer v-if="showNotifs" @close="showNotifs = false"/>
    <tour-guide/>
    <feedback-dialog/>
    <ref-preview/>
  </div>
  <div class="toasts"><div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">{{ t.message }}</div></div>`,
  methods: {
    link,
    /** From another page it opens the form, which remembers that page. On the Feedback page it stays there. */
    feedbackClick() { if (store.route.name === 'feedback') go('/feedback'); else openFeedback(); },
    setTitle() {
      const t = store.project?.title;
      const n = t ? this.unreadTotal : 0;
      document.title = (n ? `(${n > 99 ? '99+' : n}) ` : '') + (t ? `${t} — Open Questions` : 'Open Questions');
    },
  },
};

const app = Vue.createApp(App);
registerCommon(app);
app.component('rich-editor', RichEditor);
app.component('rich-content', RichContent);
app.component('math-text', MathText);
app.component('pdf-viewer', PdfViewer);
app.component('comments-panel', CommentsPanel);
app.component('conversations-view', ConversationsView);
app.component('files-view', FilesView);
app.component('bib-view', BibView);
app.component('facts-view', FactsView);
app.component('questions-view', QuestionsView);
app.component('landing-page', LandingPage);
app.component('global-search', GlobalSearch);
app.component('help-view', HelpView);
app.component('tour-guide', TourGuide);
app.component('feedback-view', FeedbackView);
app.component('feedback-dialog', FeedbackDialog);
app.component('ref-preview', RefPreview);
app.component('section-home', SectionHome);
app.component('section-activity', SectionActivity);
app.component('projects-view', ProjectsView);
app.component('overview-view', OverviewView);
app.component('members-view', MembersView);
app.component('profile-view', ProfileView);
app.component('notifications-drawer', NotificationsDrawer);
app.mount('#app');
