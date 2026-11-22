// Help center: searchable articles, adapted to the current project with live pointers.
import { api } from '../api.js';
import { store } from '../store.js';
import { foldText } from '../util.js';
import { startTour } from '../tour.js';
import { ARTICLES, CATEGORIES, articleBySlug, inlineTokens, nextSteps, pointerHref, resolveTarget, searchHelp } from '../help/content.js';

const HelpInline = {
  props: { text: String, pid: Number },
  computed: { tokens() { return inlineTokens(this.text).map((t) => (t.t === 'link' ? { ...t, href: resolveTarget(t.target, this.pid) } : t)); } },
  template: `<template v-for="(t, i) in tokens" :key="i"><b v-if="t.t === 'b'">{{ t.v }}</b><code v-else-if="t.t === 'code'">{{ t.v }}</code><template v-else-if="t.t === 'link'"><a v-if="t.href" :href="t.href" :target="t.href.startsWith('http') ? '_blank' : null" :rel="t.href.startsWith('http') ? 'noopener noreferrer' : null">{{ t.v }}</a><b v-else>{{ t.v }}</b></template><template v-else>{{ t.v }}</template></template>`,
};

const HelpBlock = {
  components: { HelpInline },
  props: { block: Object, pid: Number, ctx: Object, index: Number },
  computed: {
    lines() {
      if (this.block.type !== 'live' || !this.ctx) return [];
      try { return this.block.render(this.ctx).filter(Boolean); } catch { return []; }
    },
  },
  data() { return { copied: false }; },
  methods: {
    startTour, href(to) { return pointerHref(to, this.pid); },
    cmdText(text) { return text.replaceAll('{site}', (location.origin + location.pathname).replace(/\/$/, '')); },
    async copyCmd(text) {
      try { await navigator.clipboard.writeText(this.cmdText(text)); this.copied = true; setTimeout(() => { this.copied = false; }, 1500); } catch { /* the text stays selectable */ }
    },
  },
  template: `<h2 v-if="block.type === 'h'" :id="'help-h-' + index"><help-inline :text="block.text" :pid="pid"/></h2>
    <p v-else-if="block.type === 'p'"><help-inline :text="block.text" :pid="pid"/></p>
    <ol v-else-if="block.type === 'steps'" class="help-steps"><li v-for="(x, i) in block.items" :key="i"><help-inline :text="x" :pid="pid"/></li></ol>
    <ul v-else-if="block.type === 'list'"><li v-for="(x, i) in block.items" :key="i"><help-inline :text="x" :pid="pid"/></li></ul>
    <figure v-else-if="block.type === 'shot'" class="help-shot"><img :src="'assets/img/guide/' + block.src" :alt="block.alt" loading="lazy"><figcaption v-if="block.caption"><help-inline :text="block.caption" :pid="pid"/></figcaption></figure>
    <template v-else-if="block.type === 'cmd'"><p v-if="block.os" class="help-os">{{ block.os }}</p><div class="help-cmd"><pre tabindex="0"><code>{{ cmdText(block.text) }}</code></pre><button type="button" @click="copyCmd(block.text)">{{ copied ? 'Copied' : 'Copy' }}</button></div></template>
    <aside v-else-if="block.type === 'tip'" class="help-note tip"><icon name="check-circle" :size="16"/><div><help-inline :text="block.text" :pid="pid"/></div></aside>
    <aside v-else-if="block.type === 'warn'" class="help-note warn"><icon name="eye" :size="16"/><div><help-inline :text="block.text" :pid="pid"/></div></aside>
    <p v-else-if="block.type === 'tour'"><button type="button" class="btn primary" @click="startTour"><icon name="help" :size="16"/> Replay the tour</button></p>
    <div v-else-if="block.type === 'table'" class="help-table"><table>
      <thead><tr><th v-for="c in block.head" :key="c" scope="col">{{ c }}</th></tr></thead>
      <tbody><tr v-for="(r, i) in block.rows" :key="i"><td v-for="(c, j) in r" :key="j"><help-inline :text="c" :pid="pid"/></td></tr></tbody>
    </table></div>
    <section v-else-if="block.type === 'live' && lines.length" class="help-live" aria-label="In this project">
      <header><span class="help-dot"></span> In {{ ctx.project.title }}</header>
      <template v-for="(l, i) in lines" :key="i">
        <pre v-if="l.code" class="help-code"><code>{{ l.code }}</code></pre>
        <div v-else class="help-live-line"><p><help-inline :text="l.text" :pid="pid"/></p>
          <div v-if="l.links.length" class="help-pointers"><a v-for="(x, j) in l.links" :key="j" :href="href(x.to)"><code v-if="x.code">{{ x.code }}</code><math-text :text="x.label"/><icon name="external" :size="12"/></a></div>
        </div>
      </template>
    </section>`,
};

export const HelpView = {
  components: { HelpBlock },
  props: { pid: Number, query: Object },
  data() { return { ctx: null, q: '', projects: [] }; },
  computed: {
    slug() { return this.query?.a || null; },
    article() { return this.slug ? articleBySlug(this.slug) : null; },
    results() { return searchHelp(this.q); },
    searching() { return this.q.trim().length >= 2; },
    groups() { return CATEGORIES.map((c) => ({ ...c, articles: ARTICLES.filter((a) => a.category === c.id) })); },
    category() { return CATEGORIES.find((c) => c.id === this.article?.category); },
    headings() { return (this.article?.blocks || []).map((b, i) => ({ b, i })).filter((x) => x.b.type === 'h'); },
    related() { return (this.article?.related || []).map(articleBySlug).filter(Boolean); },
    neighbours() { const i = ARTICLES.indexOf(this.article); return { prev: ARTICLES[i - 1], next: ARTICLES[i + 1] }; },
    steps() { return this.ctx ? nextSteps(this.ctx) : []; },
    home() { return this.pid ? `#/p/${this.pid}/help` : '#/help'; },
    terms() { return [...new Set(foldText(this.q).split(/\s+/).filter(Boolean))]; },
    hasLive() { return (this.article?.blocks || []).some((b) => b.type === 'live'); },
    unreadKey() { return JSON.stringify(store.counters.totals || {}); },
  },
  watch: {
    pid: { immediate: true, handler() { this.load(); } },
    slug() { this.$nextTick(() => { if (this.$refs.main) this.$refs.main.scrollTop = 0; }); },
    unreadKey() { if (this.pid) this.refresh(); },
  },
  template: `<div class="help" :class="{reading: !!slug}">
    <aside class="help-nav">
      <header><a :href="home"><h1>Help center</h1></a><p v-if="ctx" class="muted small ellipsis">Adapted to {{ ctx.project.title }}</p></header>
      <div class="search"><icon name="search" :size="15"/><input v-model="q" type="search" placeholder="Search the help…" aria-label="Search the help center"></div>
      <nav class="help-index" aria-label="Help articles">
        <template v-if="searching">
          <p class="muted small help-count" aria-live="polite">{{ results.length }} {{ results.length === 1 ? 'article' : 'articles' }}</p>
          <a v-for="r in results" :key="r.slug" class="help-result" :class="{on: r.slug === slug}" :href="articleHref(r.slug)"><b><math-text :text="r.title" :highlight="terms"/></b><span><math-text :text="r.snippet" :highlight="terms"/></span></a>
          <div v-if="!results.length" class="empty">No article for “{{ q.trim() }}”.</div>
        </template>
        <section v-else v-for="g in groups" :key="g.id"><h2><icon :name="g.icon" :size="14"/> {{ g.title }}</h2>
          <a v-for="a in g.articles" :key="a.slug" :class="{on: a.slug === slug}" :aria-current="a.slug === slug ? 'page' : null" :href="articleHref(a.slug)">{{ a.title }}</a></section>
      </nav>
    </aside>

    <main class="help-main" ref="main">
      <a v-if="slug" class="help-back" :href="home"><span aria-hidden="true">‹</span> All help topics</a>
      <article v-if="article" class="help-article">
        <p class="help-crumb">{{ category.title }}</p>
        <h1>{{ article.title }}</h1>
        <p class="help-summary">{{ article.summary }}</p>
        <help-block v-for="(b, i) in article.blocks" :key="article.slug + i" :block="b" :index="i" :pid="pid" :ctx="ctx"/>
        <p v-if="!pid && hasLive" class="help-note tip"><icon name="check-circle" :size="16"/><span>Open this page from a project to see it applied to your data.</span></p>
        <footer v-if="related.length" class="help-related"><h2>Related</h2><div><a v-for="r in related" :key="r.slug" :href="articleHref(r.slug)"><b>{{ r.title }}</b><span>{{ r.summary }}</span></a></div></footer>
        <nav class="help-pager" aria-label="Previous and next article">
          <a v-if="neighbours.prev" :href="articleHref(neighbours.prev.slug)"><small>Previous</small>{{ neighbours.prev.title }}</a><span v-else></span>
          <a v-if="neighbours.next" class="next" :href="articleHref(neighbours.next.slug)"><small>Next</small>{{ neighbours.next.title }}</a>
        </nav>
      </article>
      <div v-else-if="slug" class="placeholder"><p>This help article does not exist.</p><a class="btn" :href="home">All help topics</a></div>

      <div v-else class="help-article help-home">
        <h1>How can we help?</h1>
        <p class="help-summary">Guides for every feature<template v-if="ctx">, with pointers to what is happening in <b>{{ ctx.project.title }}</b></template>.</p>
        <p><button type="button" class="btn" @click="startTour"><icon name="help" :size="16"/> Take the guided tour</button></p>
        <section v-if="steps.length" class="help-live"><header><span class="help-dot"></span> Suggested next steps in this project</header>
          <div class="help-next"><div v-for="s in steps" :key="s.text"><a :href="pointer(s.to)"><icon :name="s.icon" :size="16"/> <span>{{ s.text }}</span></a><a class="how" :href="articleHref(s.help)">How?</a></div></div></section>
        <section v-if="!pid && projects.length" class="help-live"><header><span class="help-dot"></span> Open the help for a project</header>
          <div class="help-pointers"><a v-for="x in projects" :key="x.id" :href="'#/p/' + x.id + '/help'">{{ x.title }}</a></div></section>
        <div class="help-cards"><a v-for="g in groups" :key="g.id" :href="articleHref(g.articles[0].slug)"><span><icon :name="g.icon" :size="18"/></span><b>{{ g.title }}</b><small>{{ g.articles.length }} {{ g.articles.length === 1 ? 'article' : 'articles' }}</small></a></div>
      </div>
    </main>

    <aside v-if="article && headings.length" class="help-toc" aria-label="On this page"><h2>On this page</h2>
      <button v-for="x in headings" :key="x.i" type="button" @click="jump(x.i)">{{ plain(x.b.text) }}</button></aside>
  </div>`,
  methods: {
    startTour,
    articleHref(slug) { return resolveTarget(`help:${slug}`, this.pid); },
    pointer(to) { return pointerHref(to, this.pid); },
    plain(s) { return s.replace(/\*\*|`/g, ''); },
    jump(i) { document.getElementById(`help-h-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    async load() {
      this.ctx = null;
      if (this.pid) { await this.refresh(); return; }
      try { this.projects = (await api.get('api/projects')).projects; } catch { this.projects = []; }
    },
    async refresh() {
      const pid = this.pid;
      try { const c = await api.get(`api/projects/${pid}/help-context`); if (pid === this.pid) this.ctx = c; } catch { /* the guides work without live data */ }
    },
  },
};
