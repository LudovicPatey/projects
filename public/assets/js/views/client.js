// The AI client: where to get it, and how the platform and the computers of the team work together.
import { api } from '../api.js';
import { store } from '../store.js';
import { GITHUB_REPO, RELEASES_URL, SOURCE_URL, SYSTEMS, clientCommand, detectSystem, downloadPlan, formatSize, mergeRelease } from '../client-download.js';

export const ArchitectureDiagram = {
  template: `<figure class="arch" aria-label="The platform stores the research. Each member's computer takes tasks, runs the AI with their own account, and returns checked results.">
    <div class="arch-side">
      <p class="arch-label">On each member's computer</p>
      <div class="arch-node"><span class="arch-icon ai"><icon name="sparkles" :size="19"/></span><div><b>AI client</b><small>Runs Claude or ChatGPT with your own account</small></div></div>
      <div class="arch-node"><span class="arch-icon"><icon name="graph" :size="19"/></span><div><b>Prove new facts, optional</b><small>AI agents search for proofs in an isolated machine</small></div></div>
      <div class="arch-node"><span class="arch-icon"><icon name="clock" :size="19"/></span><div><b>Your usage limits</b><small>Checked before work starts</small></div></div>
    </div>
    <div class="arch-flow" aria-hidden="true">
      <div><span>Takes a task</span><i class="to-left"></i></div>
      <div><span>Returns checked results</span><i class="to-right"></i></div>
    </div>
    <div class="arch-side platform">
      <p class="arch-label">On the shared platform</p>
      <div class="arch-node"><span class="arch-icon"><icon name="layers" :size="19"/></span><div><b>Work queue</b><small>New papers, @AI questions, requests</small></div></div>
      <div class="arch-node"><span class="arch-icon"><icon name="target" :size="19"/></span><div><b>Structured research</b><small>Questions, facts, files, references</small></div></div>
      <div class="arch-node"><span class="arch-icon good"><icon name="check-circle" :size="19"/></span><div><b>Human validation</b><small>People endorse and ratify</small></div></div>
    </div>
  </figure>`,
};

export const ClientView = {
  components: { ArchitectureDiagram },
  data() { return { info: null, copied: false, failed: false, releasesUrl: RELEASES_URL, sourceUrl: SOURCE_URL }; },
  computed: {
    site() { return (location.origin + location.pathname).replace(/\/$/, ''); },
    system() { return store.clientSystem || detectSystem({ userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform || '', touchPoints: navigator.maxTouchPoints || 0 }); },
    plan() { return downloadPlan(this.system, this.info); },
    command() { return clientCommand(this.system, this.site); },
    otherSystems() { return Object.entries(SYSTEMS).filter(([k]) => k !== this.system); },
  },
  async mounted() {
    store.project = null;
    try {
      const ua = navigator.userAgentData;
      if (ua?.getHighEntropyValues && ua.platform === 'macOS') {
        const { architecture } = await ua.getHighEntropyValues(['architecture']);
        store.clientSystem = detectSystem({ userAgent: navigator.userAgent, platform: 'macOS', architecture });
      }
    } catch { /* the default detection stays */ }
    try { this.info = await api.get('api/client/info'); } catch { this.failed = true; this.info = { installers: [] }; }
    if (!['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
      try {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (r.ok) this.info = mergeRelease(this.info, await r.json());
      } catch { /* the page keeps what the platform offers */ }
    }
  },
  methods: {
    formatSize,
    systemName(k) { return SYSTEMS[k]?.label || k; },
    href(x) { return x.url || `api/client/download?system=${encodeURIComponent(x.system)}`; },
    async copy() {
      try { await navigator.clipboard.writeText(this.command); this.copied = true; setTimeout(() => { this.copied = false; }, 1500); } catch { /* the text stays selectable */ }
    },
  },
  template: `<div class="page wide client-page">
    <header class="page-title"><span class="sh-icon"><icon name="download" :size="22"/></span><div><h1>AI client</h1><p>Let your computer work for your projects, with your own AI account and within your limits.</p></div><div v-if="info?.version" class="title-kpis"><div><b>{{ info.version }}</b><span>latest version</span></div></div></header>
    <section class="panel client-hero">
      <div class="client-main">
        <p class="eyebrow">{{ plan.phone ? 'On a computer' : 'For ' + plan.label }}</p>
        <template v-if="plan.phone"><h2>The client runs on a computer</h2><p>Open this page on a Mac, Windows or Linux computer to install it.</p></template>
        <template v-else-if="plan.installer">
          <h2>Download the desktop app</h2><p>It includes everything it needs. Open it, connect your account, and choose your limits.</p>
          <a class="btn primary client-btn" :href="href(plan.installer)" download><icon name="download" :size="17"/> Download for {{ plan.label }}</a>
          <small class="muted"><template v-if="plan.installer.version">Version {{ plan.installer.version }} · </template>{{ formatSize(plan.installer.size) }}</small>
          <details v-if="plan.installer.sha256" class="client-hash"><summary>File checksum</summary><code>{{ plan.installer.sha256 }}</code></details>
        </template>
        <template v-else>
          <h2>Start the client with one command</h2>
          <p>The installable app for your system is not published yet. This opens the same graphic interface in your browser. It needs Python 3.8 or later.</p>
          <div class="help-cmd"><pre tabindex="0"><code>{{ command }}</code></pre><button type="button" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button></div>
          <div class="row-gap"><a class="btn" href="api/client/oq.py" download><icon name="download" :size="15"/> Download the client file</a><a class="btn" href="#/help?a=ai-setup"><icon name="help" :size="15"/> Step-by-step guide</a></div>
        </template>
      </div>
      <img src="assets/img/guide/app-home.webp" width="1560" height="1140" alt="The Home page of the AI client, with its status, usage meters and projects" loading="lazy">
    </section>
    <div class="client-grid">
      <section class="panel"><h2><icon name="sparkles" :size="15"/> What it does</h2><ul class="client-list"><li>Extracts facts from new papers</li><li>Answers <code>@AI</code> in discussions</li><li>Suggests references for people to validate</li><li>Proves new facts when you press Start</li></ul></section>
      <section class="panel"><h2><icon name="clock" :size="15"/> You stay in control</h2><ul class="client-list"><li>Set daily caps and working hours</li><li>Limit its share of your ChatGPT usage</li><li>Uses your subscription, not a paid API key</li><li>Give each proof search a time and usage limit</li><li>Optionally keep regular backups of your projects</li></ul></section>
      <section class="panel"><h2><icon name="terminal" :size="15"/> Other ways to run it</h2>
        <a v-for="x in plan.others" :key="x.system" class="d-row" :href="href(x)" download><icon name="download" :size="14"/><span class="d-title">{{ systemName(x.system) }}</span><small>{{ formatSize(x.size) }}</small></a>
        <a class="d-row" :href="releasesUrl" target="_blank" rel="noopener noreferrer"><icon name="download" :size="14"/><span class="d-title">All releases on GitHub</span><span class="chev">↗</span></a>
        <a class="d-row" :href="sourceUrl" target="_blank" rel="noopener noreferrer"><icon name="code" :size="14"/><span class="d-title">Source code (AGPL-3.0)</span><span class="chev">↗</span></a>
        <a class="d-row" href="#/help?a=ai-app"><icon name="terminal" :size="14"/><span class="d-title">Command line, for servers</span><span class="chev">›</span></a>
        <a class="d-row" href="#/help?a=ai-setup-claude"><icon name="help" :size="14"/><span class="d-title">Guide for Claude</span><span class="chev">›</span></a>
        <a class="d-row" href="#/help?a=ai-setup-chatgpt"><icon name="help" :size="14"/><span class="d-title">Guide for ChatGPT</span><span class="chev">›</span></a>
      </section>
    </div>
    <section class="panel"><h2>How the computing is shared</h2><architecture-diagram/></section>
  </div>`,
};

/** A compact invitation on the dashboards. */
export const ClientCard = {
  template: `<section class="panel client-card"><span class="sh-icon"><icon name="download" :size="20"/></span><div><b>Get the AI client</b><span>Let your computer process papers and AI requests, within the limits you set.</span></div><a class="btn primary" href="#/client"><icon name="download" :size="15"/> Download</a></section>`,
};
