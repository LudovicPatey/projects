// Public front page, shown to visitors who are not signed in.
import { store } from '../store.js';
import { ArchitectureDiagram } from './client.js';
import { SOURCE_URL } from '../client-download.js';

const IMG = 'assets/img/landing/';
const FEATURES = [
  {
    kicker: 'Fact database', title: 'See what is known, and what it rests on',
    text: 'Results become facts with a statement, a proof and an intuition, linked by their dependencies. Browse them as a list or as an interactive graph.',
    points: ['Labels such as conclusion, counterexample, dead end or plan', 'Retracting a fact flags everything built on it', 'Import fact graphs from the Danus prover'],
    img: 'facts-graph.webp', w: 1600, h: 978, alt: 'Dependency graph of facts next to a selected theorem with its statement, proof and intuition',
  },
  {
    kicker: 'Traceability', title: 'Know where every proof comes from',
    text: 'Each fact shows whether its proof comes from a human or an AI, who is credited, which passage it was taken from, and which results it depends on.',
    points: ['Human, AI and mixed proofs are told apart', 'Sources cite a page and an exact quote', 'Every revision is kept'],
    img: 'fact-trace.webp', w: 1551, h: 1239, alt: 'Trace of a fact listing its origin, credited people, the facts it is built on and its revisions',
  },
  {
    kicker: 'Human and AI review', title: 'Trust is earned, one check at a time',
    text: 'Researchers endorse facts in one click. Humans and independent models can mark them correct, point out a gap, or reject them, and Lean proofs can be attached.',
    points: ['A model cannot validate its own work', 'A new revision needs new reviews', 'Lean code containing sorry is detected'],
    img: 'fact-reviews.webp', w: 1551, h: 1239, alt: 'Reviews of a fact by researchers and by an AI model, with the endorsement button',
  },
  {
    kicker: 'Conversations', title: 'Discuss like in your mailbox',
    text: 'Linear conversations with the people you choose, rich text, LaTeX, and @mentions of researchers, files, references and facts. Comment on any passage without derailing the thread.',
    points: ['AI messages show their model, user and generation time', 'Personal read state for each researcher', 'iPhone-style badges for everything new'],
    img: 'conversations.webp', w: 1600, h: 978, alt: 'Three-column conversation view with a list, messages from researchers and an AI agent, and comments',
  },
  {
    kicker: 'Files and bibliography', title: 'Papers, sources and versions in one place',
    text: 'Read PDFs in the browser and comment directly on selected text. Each file keeps its LaTeX sources and full version history, and is clearly marked as human or AI.',
    points: ['Upload new versions and restore old ones', 'A bibliography with DOI, arXiv and BibTeX import', 'A PDF for each reference'],
    img: 'files.webp', w: 1600, h: 978, alt: 'PDF viewer with a highlighted passage and its comment thread, next to a list of human and AI files',
  },
  {
    kicker: 'The AI client', title: 'An app for your computer, with your own limits',
    text: 'The client connects your Claude or ChatGPT account to your projects. It processes new papers, answers @AI and suggests references, then waits whenever you reach a limit you chose.',
    points: ['A graphic interface, and a full command line for servers', 'Choose which projects are active, and pause the others', 'Set daily caps, working hours, and a share of your ChatGPT limits', 'Start proof searches with a time limit and usage stops, in an isolated machine by default', 'Optionally keep regular backups of your projects on your computer'],
    src: 'assets/img/guide/app-home.webp', img: 'app-home.webp', w: 1560, h: 1140, alt: 'The AI client showing its status, usage against the limits, and the waiting work of a project',
  },
];

// KEEP THIS UP TO DATE: where the front page presents each menu area, or false if it deliberately does not.
// tests/landing.test.mjs fails when a menu area is missing or points to a section that no longer exists.
export const FRONT_PAGE_COVERAGE = {
  overview: 'One workspace per open problem', questions: false, conversations: 'Conversations', facts: 'Fact database',
  files: 'Files and bibliography', bib: 'Files and bibliography', ai: 'Decentralized AI computing', members: false,
};

export const LandingPage = {
  components: { ArchitectureDiagram },
  data() {
    return {
      orcid: '0000-0002-1825-0097', name: 'Josiah Carberry', zoom: null,
      error: new URLSearchParams(location.search).get('login_error'),
    };
  },
  computed: { dev() { return store.dev; } },
  created() { this.features = FEATURES; this.IMG = IMG; this.sourceUrl = SOURCE_URL; },
  mounted() {
    this.onKey = (e) => { if (e.key === 'Escape') this.zoom = null; };
    window.addEventListener('keydown', this.onKey);
  },
  unmounted() { window.removeEventListener('keydown', this.onKey); },
  template: `<div class="landing">
    <header class="lp-nav">
      <span class="lp-brand"><span class="lp-logo">?</span> Open Questions</span>
      <a class="btn orcid lp-nav-btn" href="auth/login"><span class="lp-id">iD</span> Sign in with ORCID</a>
    </header>

    <section class="lp-hero">
      <p class="lp-eyebrow">A collaborative platform for research mathematics</p>
      <h1>Solve open questions, with researchers and AI working together</h1>
      <p class="lp-lead">One workspace per open problem: discussions, papers, a shared database of facts, and a clear record of what was proved by whom, and what was produced by AI.</p>
      <p v-if="error" class="error-box lp-error">ORCID sign-in was cancelled or failed ({{ error }}).</p>
      <div class="lp-cta">
        <a class="btn orcid" href="auth/login"><span class="lp-id">iD</span> Sign in with ORCID</a>
        <span class="muted small">Your ORCID iD is your account. We only read your public name.</span>
      </div>
      <form v-if="dev" class="dev-login lp-dev" action="auth/dev-login" method="get">
        <p class="small"><b>Development mode:</b> log in as any ORCID iD</p>
        <div class="row-gap"><input name="orcid" v-model="orcid" aria-label="ORCID iD"><input name="name" v-model="name" placeholder="Name" aria-label="Name"><button class="btn sm">Dev login</button></div>
      </form>
      <button class="lp-shot lp-hero-shot" @click="zoom = features[0]" :aria-label="'Enlarge: ' + features[0].alt">
        <img :src="IMG + features[0].img" :width="features[0].w" :height="features[0].h" :alt="features[0].alt" fetchpriority="high"></button>
    </section>

    <section class="lp-strip" aria-label="Key principles">
      <div><b>Every AI output is labelled</b><span>with its model, its user, and its generation time when measured</span></div>
      <div><b>Your AI, on your computer</b><span>with your own account, within limits you set</span></div>
      <div><b>Humans stay in charge</b><span>they endorse, dispute and retract results</span></div>
      <div><b>Credit is traceable</b><span>from each result back to its sources</span></div>
    </section>

    <section class="lp-arch">
      <p class="lp-kicker">Decentralized AI computing</p>
      <h2>A shared platform, with the AI on your computers</h2>
      <p class="lp-arch-lead">The platform never runs a model. It keeps the research structured and shows what needs doing. Each member can run an AI client at home, and any running client can take the next task.</p>
      <architecture-diagram/>
      <div class="lp-arch-points">
        <div><b>No shared AI bill</b><span>Each member uses their own Claude or ChatGPT account, or none at all.</span></div>
        <div><b>Your limits are respected</b><span>The client pauses at the daily caps and usage limits you choose.</span></div>
        <div><b>People have the last word</b><span>AI proposes facts, answers and references. Researchers validate them.</span></div>
      </div>
    </section>

    <section v-for="(f, i) in features" :key="f.img" class="lp-feature" :class="{flip: i % 2 === 1}">
      <div class="lp-copy">
        <p class="lp-kicker">{{ f.kicker }}</p>
        <h2>{{ f.title }}</h2>
        <p>{{ f.text }}</p>
        <ul><li v-for="p in f.points" :key="p"><icon name="check" :size="15"/> {{ p }}</li></ul>
      </div>
      <button class="lp-shot" @click="zoom = f" :aria-label="'Enlarge: ' + f.alt">
        <img :src="f.src || IMG + f.img" :width="f.w" :height="f.h" :alt="f.alt" loading="lazy"></button>
    </section>

    <section class="lp-final">
      <h2>Bring your open question</h2>
      <p>Sign in with your ORCID iD to join a project, start one, and download the AI client.</p>
      <a class="btn orcid" href="auth/login"><span class="lp-id">iD</span> Sign in with ORCID</a>
    </section>
    <footer class="lp-foot">Free software under the <a :href="sourceUrl + '/blob/master/LICENSE'" rel="noopener noreferrer">AGPL-3.0 license</a> · <a :href="sourceUrl" rel="noopener noreferrer">Source code</a><br>Screenshots show a sample project with fictional researchers.</footer>

    <div v-if="zoom" class="lp-zoom" role="dialog" aria-modal="true" :aria-label="zoom.title" @click="zoom = null">
      <button class="icon-btn" aria-label="Close"><icon name="x" :size="22"/></button>
      <img :src="zoom.src || IMG + zoom.img" :alt="zoom.alt">
    </div>
  </div>`,
};
