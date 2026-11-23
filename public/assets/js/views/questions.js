// Open questions: a tree of questions and sub-questions, each with proof strategies and their history.
import { api } from '../api.js';
import { store, go, link, attempt, markRead, markItemUnread, refreshCounters, refreshMentionables } from '../store.js';
import { timeAgo, fullDate } from '../util.js';
import { ANSWER_KIND, ANSWER_STATE, FACT_SUPPORT, PRIORITY, QUESTION_STATUS, STRATEGY_STATUS, answerActions, buildTree, isClosed, progress, sortStrategies, unreadOf, validParents, visibleRows } from '../questions-model.js';

const LINK_ICONS = { fact: 'graph', document: 'files', bib: 'book' };
const LINK_GROUPS = { fact: 'Facts', document: 'Files', bib: 'References' };

const StateTag = {
  props: { status: String, map: Object },
  computed: { s() { return this.map[this.status] || { label: this.status, cls: 'off' }; } },
  template: `<span class="q-state" :class="'qs-' + s.cls">{{ s.label }}</span>`,
};

const LinkChips = {
  props: { links: Array },
  emits: ['remove'],
  methods: { link, icon(t) { return LINK_ICONS[t]; } },
  template: `<div v-if="links.length" class="q-links"><span v-for="l in links" :key="l.id" class="q-link">
    <a :href="link(l.view, l.target_id)"><icon :name="icon(l.target_type)" :size="13"/><code v-if="l.code">{{ l.code }}</code><math-text :text="l.title"/></a>
    <button type="button" class="icon-btn xs" title="Remove this link" aria-label="Remove this link" @click="$emit('remove', l)"><icon name="x" :size="12"/></button></span></div>`,
};

export const QuestionsView = {
  components: { StateTag, LinkChips },
  props: { pid: Number, id: Number, query: Object },
  data() {
    return {
      questions: [], loaded: false, search: '', fStatus: 'all', collapsed: [],
      question: null, error: null, activeThread: null, viewedRevision: null, showHistory: true,
      qForm: null, sForm: null, linkForm: null, answerForm: null, noteForm: null, busy: false, showClosed: false, commentsOn: 'strategy', backlinks: [], sBacklinks: [],
    };
  },
  computed: {
    me() { return store.user.id; },
    isOwner() { return store.project.my_role === 'owner'; },
    tree() { return buildTree(this.questions); },
    rows() { return visibleRows(this.tree, { search: this.search, status: this.fStatus, collapsed: this.collapsed }); },
    unread() { return store.counters.unread || {}; },
    unreadTotal() { const t = store.counters.totals || {}; return (t.oquestion || 0) + (t.strategy || 0); },
    node() {
      const find = (list) => { for (const n of list) { if (n.id === this.id) return n; const x = find(n.children); if (x) return x; } return null; };
      return find(this.tree);
    },
    children() { return this.node?.children || []; },
    settled() { return this.node ? progress(this.node) : { done: 0, total: 0 }; },
    strategyBacklinks() { return this.strategy ? this.sBacklinks : []; },
    strategies() { return sortStrategies(this.question?.strategies || []); },
    strategyId() { return this.query?.strategy ? +this.query.strategy : null; },
    strategy() { return this.question?.strategies.find((s) => s.id === this.strategyId) || null; },
    shownRevision() { return this.strategy?.revisions.find((r) => r.revision_no === this.viewedRevision) || null; },
    canDelete() { return this.question && (this.question.created_by === this.me || this.isOwner) && !this.children.length; },
    canDeleteStrategy() { return this.strategy && (this.strategy.created_by === this.me || this.isOwner); },
    parentOptions() { return validParents(this.questions, this.qForm?.id || null); },
    linkOptions() {
      const m = store.mentionables;
      const t = this.linkForm?.type;
      if (t === 'fact') return m.facts.map((x) => ({ id: x.id, label: `${x.label} — ${x.title}` }));
      if (t === 'document') return m.documents.map((x) => ({ id: x.id, label: x.title }));
      if (t === 'bib') return m.bib.map((x) => ({ id: x.id, label: `${x.cite_key} — ${x.title}` }));
      return [];
    },
    onStrategy() { return !!this.strategy && this.commentsOn === 'strategy'; },
    commentType() { return this.onStrategy ? 'strategy' : 'oquestion'; },
    commentId() { return this.onStrategy ? this.strategy.id : this.question?.id; },
    commentTitle() { return this.onStrategy ? 'Comments on this strategy' : 'Comments on this question'; },
    ratifiedAnswer() { return this.question?.answers.find((a) => a.state === 'ratified') || null; },
    pendingAnswers() { return (this.question?.answers || []).filter((a) => a.state === 'proposed').length; },
    closedAnswers() { return (this.question?.answers || []).filter((a) => !['proposed', 'ratified'].includes(a.state)); },
    shownAnswers() { return (this.question?.answers || []).filter((a) => this.showClosed || ['proposed', 'ratified'].includes(a.state)); },
    factOptions() { return store.mentionables.facts || []; },
    noteTitle() { return { reject: 'Reject answer', revoke: 'Revoke ratification', deny: 'Deny fact' }[this.noteForm?.mode]; },
  },
  watch: {
    id: { immediate: true, handler() { this.onRoute(); } },
    'query.rev'() { this.seenRev = null; this.viewedRevision = null; this.followLink(); },
    'query.answer'() { this.seenAnswer = null; if (this.question) this.followLink(); },
    strategyId() { this.viewedRevision = null; this.seenRev = null; this.$nextTick(() => this.question && this.followLink()); this.commentsOn = 'strategy'; this.activeThread = this.query?.comment ? +this.query.comment : null; this.flagRead(); this.loadBacklinks(); },
  },
  created() { this.qStatus = QUESTION_STATUS; this.sStatus = STRATEGY_STATUS; this.priorities = PRIORITY; this.linkGroups = LINK_GROUPS; this.answerKind = ANSWER_KIND; this.answerState = ANSWER_STATE; this.support = FACT_SUPPORT; },
  mounted() {
    this.loadList();
    this.timer = setInterval(() => { if (!this.qForm && !this.sForm && !this.linkForm && !this.answerForm && !this.noteForm) { this.loadList(); if (this.id) this.loadQuestion(); } }, 30000);
  },
  unmounted() { clearInterval(this.timer); },
  template: `<div class="cols3 questions">
  <section class="col col-list">
    <header class="col-head"><h2>Questions <span class="count" v-if="questions.length">{{ questions.length }}</span></h2>
      <div class="row-gap"><button v-if="unreadTotal" class="link-btn mark-all" title="Mark everything here as read" @click="readAll"><icon name="check" :size="13"/> <span>Read all</span></button>
      <button class="btn primary sm" @click="newQuestion(null)"><icon name="plus" :size="14"/> Question</button></div></header>
    <div class="col-tools">
      <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Filter questions…" aria-label="Filter questions"></div>
      <select v-model="fStatus" aria-label="Filter by status"><option value="all">All statuses</option><option value="unsettled">Not settled</option><option v-for="(s, k) in qStatus" :key="k" :value="k">{{ s.label }}</option></select>
    </div>
    <div class="list q-tree" role="tree" aria-label="Questions and sub-questions">
      <div v-for="r in rows" :key="r.node.id" class="q-row" role="treeitem" :aria-expanded="r.hasChildren ? r.open : null" :aria-selected="r.node.id === id" :class="{active: r.node.id === id, dim: r.dimmed, closed: isClosed(r.node.status), 'is-new': !!unreadOf(r.node, unread)}" :style="{paddingLeft: 6 + Math.min(r.depth, 5) * 16 + 'px'}">
        <button v-if="r.hasChildren" type="button" class="q-twist" :class="{open: r.open}" :aria-label="(r.open ? 'Collapse ' : 'Expand ') + r.node.title" @click="toggle(r.node.id)">›</button><span v-else class="q-twist none"></span>
        <a :href="link('questions', r.node.id)">
          <span class="q-title"><i v-if="r.node.priority === 'high'" class="q-high" title="High priority">!</i><math-text :text="r.node.title"/></span>
          <span class="q-meta"><state-tag :status="r.node.status" :map="qStatus"/><span v-if="r.node.strategies.length">{{ r.node.strategies.length }} {{ r.node.strategies.length === 1 ? 'strategy' : 'strategies' }}</span><span v-if="r.hasChildren">{{ progressOf(r.node).done }}/{{ progressOf(r.node).total }} sub</span><span v-if="r.node.pending_answers" class="q-pending">{{ r.node.pending_answers }} to ratify</span><span v-if="r.node.answer_at_risk" class="q-at-risk">Answer at risk</span></span>
        </a>
        <b v-if="unreadOf(r.node, unread)" class="ios-badge">{{ unreadOf(r.node, unread) }}</b>
      </div>
      <div v-if="loaded && !questions.length" class="placeholder"><icon name="target" :size="36"/><p>State the big questions of this project, then split them into sub-questions.</p><button class="btn primary" @click="newQuestion(null)"><icon name="plus" :size="14"/> First question</button></div>
      <div v-else-if="loaded && !rows.length" class="empty">No question matches this filter.</div>
    </div>
  </section>

  <section class="col col-main q-detail">
    <div v-if="error" class="placeholder"><p>{{ error }}</p><a class="btn" :href="link('questions')">All questions</a></div>
    <section-home v-else-if="!id" kind="questions"><button class="btn primary" @click="newQuestion(null)"><icon name="plus" :size="15"/> New question</button></section-home>
    <div v-else-if="!question" class="placeholder">Loading…</div>
    <div v-else class="q-scroll">
      <nav v-if="question.path.length" class="q-path" aria-label="Parent questions"><template v-for="p in question.path" :key="p.id"><a :href="link('questions', p.id)"><math-text :text="p.title"/></a><span aria-hidden="true">›</span></template></nav>
      <header class="q-head">
        <h1><math-text :text="question.title"/></h1>
        <div class="row-gap q-actions">
          <ai-action kind="ask" source-type="question" :source-id="question.id" label="Ask AI"/>
          <ai-action kind="derive" source-type="question" :source-id="question.id"/>
          <button class="icon-btn" title="Mark as unread" aria-label="Mark as unread" @click="markUnread('oquestion', question.id)"><icon name="mail" :size="16"/></button>
          <button class="btn sm" @click="editQuestion"><icon name="edit" :size="14"/> Edit</button>
          <button v-if="canDelete" class="icon-btn" title="Delete this question" aria-label="Delete this question" @click="removeQuestion"><icon name="trash" :size="16"/></button>
        </div>
      </header>
      <div class="q-controls">
        <label>Status <select :value="question.status" :disabled="!!ratifiedAnswer" :title="ratifiedAnswer ? 'Set by the ratified answer' : null" @change="setQuestion({status: $event.target.value})"><option v-for="(s, k) in qStatus" :key="k" :value="k">{{ s.label }}</option></select></label>
        <label>Priority <select :value="question.priority" @change="setQuestion({priority: $event.target.value})"><option v-for="(l, k) in priorities" :key="k" :value="k">{{ l }}</option></select></label>
        <span class="muted small">By <b>{{ question.author }}</b> · <span :title="fullDate(question.updated_at)">updated {{ timeAgo(question.updated_at) }}</span></span>
        <ai-meta :model="question.ai_model" :user="question.ai_user_name" :ms="question.ai_generation_ms"/>
      </div>
      <rich-content v-if="question.statement_html" class="q-statement" :html="question.statement_html"/>
      <p v-else class="muted">No statement yet.</p>
      <link-chips :links="question.links" @remove="removeLink"/>
      <button class="link-btn" @click="openLink(0)"><icon name="link" :size="13"/> Link a fact, file or reference</button>

      <section class="q-section">
        <header><h2>Answer <span v-if="pendingAnswers" class="count">{{ pendingAnswers }} to ratify</span></h2><button v-if="!ratifiedAnswer" class="btn sm" @click="newAnswer"><icon name="plus" :size="14"/> Propose an answer</button></header>
        <p v-if="!question.answers.length" class="muted small">No answer proposed. A human or an AI client can propose a positive or negative answer backed by a fact, and a human must ratify it.</p>
        <article v-for="a in shownAnswers" :key="a.id" :data-answer="a.id" class="q-answer" :class="['a-' + a.state, {risk: actions(a).atRisk}]">
          <div class="q-a-head"><span class="q-verdict" :class="a.answer">{{ answerKind[a.answer].short }}</span><b>{{ answerKind[a.answer].label }}</b><state-tag :status="a.state" :map="answerState"/>
            <span class="grow"></span><span class="muted small">{{ a.proposer }} · <span :title="fullDate(a.created_at)">{{ timeAgo(a.created_at) }}</span></span><ai-meta :model="a.ai_model" :user="a.ai_user_name" :ms="a.ai_generation_ms" compact/></div>
          <div v-if="actions(a).atRisk" class="q-risk" role="alert"><icon name="eye" :size="15"/><span><b>This ratified answer needs attention.</b> {{ support[a.support].text }} The question stays {{ qStatus[question.status].label.toLowerCase() }} until a human revokes the ratification.</span></div>
          <a v-if="a.fact" class="q-a-fact" :href="link('facts', a.fact.id)"><code class="key">{{ a.fact.label }}</code><b><math-text :text="a.fact.title"/></b><span class="q-a-statement"><math-text :text="a.fact.statement_text"/></span></a>
          <p v-else class="muted small">The fact has been deleted.</p>
          <rich-content v-if="a.rationale_html" class="q-statement" :html="a.rationale_html"/>
          <div v-if="a.fact && a.state === 'proposed'" class="q-support" :class="{ok: support[a.support].ok}"><icon :name="support[a.support].ok ? 'check-circle' : 'eye'" :size="14"/> {{ support[a.support].text }}</div>
          <div v-if="a.fact && (a.fact.endorsed_by.length || a.fact.denied_by.length)" class="muted small q-reviewers"><span v-if="a.fact.endorsed_by.length">Endorsed by {{ names(a.fact.endorsed_by) }}.</span> <span v-if="a.fact.denied_by.length">Denied by {{ names(a.fact.denied_by) }}.</span></div>
          <p v-if="a.ratified_by_name" class="small q-decision">Ratified by <b>{{ a.ratified_by_name }}</b> on revision {{ a.ratified_revision }} of the fact · {{ timeAgo(a.ratified_at) }}</p>
          <p v-if="a.closed_by_name" class="small q-decision">{{ answerState[a.state].label }} by <b>{{ a.closed_by_name }}</b> · {{ timeAgo(a.closed_at) }}<template v-if="a.closed_note">: {{ a.closed_note }}</template></p>
          <div v-if="hasActions(a)" class="q-a-actions">
            <template v-if="actions(a).review"><button class="btn sm endorse" :class="{on: a.fact.my_review?.verdict === 'correct'}" :aria-pressed="a.fact.my_review?.verdict === 'correct'" @click="toggleEndorse(a)"><icon name="check" :size="14"/> {{ a.fact.my_review?.verdict === 'correct' ? 'Fact endorsed' : 'Endorse fact' }}</button>
            <button class="btn sm deny" :class="{on: a.fact.my_review?.verdict === 'incorrect'}" :aria-pressed="a.fact.my_review?.verdict === 'incorrect'" @click="toggleDeny(a)"><icon name="x" :size="14"/> {{ a.fact.my_review?.verdict === 'incorrect' ? 'Fact denied' : 'Deny fact' }}</button></template>
            <span class="grow"></span>
            <button v-if="actions(a).withdraw" class="btn ghost sm" @click="withdrawAnswer(a)">Withdraw</button>
            <button v-if="actions(a).reject" class="btn ghost sm" @click="noteForm = {mode: 'reject', answer: a, text: ''}">Reject</button>
            <button v-if="actions(a).revoke" class="btn sm" @click="noteForm = {mode: 'revoke', answer: a, text: ''}">Revoke ratification</button>
            <button v-if="a.state === 'proposed'" class="btn primary sm" :disabled="!actions(a).ratify" :title="actions(a).ratify ? 'Accept this answer and close the question' : support[a.support].text" @click="ratify(a)"><icon name="check-circle" :size="14"/> Ratify</button>
          </div>
        </article>
        <button v-if="closedAnswers.length" class="link-btn" @click="showClosed = !showClosed">{{ showClosed ? 'Hide' : 'Show' }} {{ closedAnswers.length }} earlier {{ closedAnswers.length === 1 ? 'proposal' : 'proposals' }}</button>
      </section>

      <section class="q-section">
        <header><h2>Sub-questions <span v-if="settled.total" class="count">{{ settled.done }}/{{ settled.total }} settled</span></h2><button class="btn sm" @click="newQuestion(question.id)"><icon name="plus" :size="14"/> Sub-question</button></header>
        <div v-if="settled.total" class="q-bar" role="progressbar" :aria-valuenow="settled.done" aria-valuemin="0" :aria-valuemax="settled.total" :aria-label="settled.done + ' of ' + settled.total + ' sub-questions settled'"><span :style="{width: 100 * settled.done / settled.total + '%'}"></span></div>
        <a v-for="c in children" :key="c.id" class="q-child" :href="link('questions', c.id)"><state-tag :status="c.status" :map="qStatus"/><math-text :text="c.title"/><small v-if="c.strategies.length">{{ c.strategies.length }} {{ c.strategies.length === 1 ? 'strategy' : 'strategies' }}</small></a>
        <p v-if="!children.length" class="muted small">No sub-question yet.</p>
      </section>

      <section class="q-section">
        <header><h2>Proof strategies <span v-if="strategies.length" class="count">{{ strategies.length }}</span></h2><button class="btn sm" @click="newStrategy"><icon name="plus" :size="14"/> Strategy</button></header>
        <p v-if="!strategies.length" class="muted small">No strategy yet. Describe an approach, even a tentative one: its history is kept as it evolves.</p>
        <article v-for="s in strategies" :key="s.id" class="q-strategy" :class="{on: s.id === strategyId}">
          <a class="q-s-head" :href="strategyHref(s)" :aria-expanded="s.id === strategyId">
            <state-tag :status="s.status" :map="sStatus"/><b><math-text :text="s.title"/></b>
            <b v-if="unread.strategy?.[s.id]" class="ios-badge">{{ unread.strategy[s.id] }}</b>
            <small><template v-if="s.comment_count"><icon name="comment" :size="11"/> {{ s.comment_count }} · </template>v{{ s.current_revision }} · {{ timeAgo(s.updated_at) }}</small><span class="q-chev" aria-hidden="true">›</span>
          </a>
          <div v-if="s.id === strategyId" class="q-s-body">
            <div class="q-controls">
              <label>Status <select :value="s.status" @change="setStrategy(s, {status: $event.target.value})"><option v-for="(x, k) in sStatus" :key="k" :value="k">{{ x.label }}</option></select></label>
              <span class="grow"></span>
              <button class="btn sm" @click="editStrategy(s)"><icon name="edit" :size="14"/> Revise</button>
              <button class="icon-btn" title="Mark as unread" aria-label="Mark strategy as unread" @click="markUnread('strategy', s.id)"><icon name="mail" :size="16"/></button>
              <button v-if="canDeleteStrategy" class="icon-btn" title="Delete this strategy" aria-label="Delete this strategy" @click="removeStrategy(s)"><icon name="trash" :size="16"/></button>
            </div>
            <div v-if="shownRevision" class="q-old"><span>Viewing version {{ shownRevision.revision_no }}: <b>{{ shownRevision.title }}</b> ({{ sStatus[shownRevision.status]?.label }})</span><button class="link-btn" @click="viewedRevision = null">Back to current</button></div>
            <rich-content v-if="(shownRevision || s).body_html" class="q-statement" :html="(shownRevision || s).body_html"/>
            <p v-else class="muted small">This strategy has no description.</p>
            <link-chips :links="s.links" @remove="removeLink"/>
            <button class="link-btn" @click="openLink(s.id)"><icon name="link" :size="13"/> Link a fact, file or reference</button>
            <template v-if="strategyBacklinks.length"><h3 class="q-h3"><icon name="link" :size="14"/> Mentioned in</h3>
              <a v-for="(b, i) in strategyBacklinks" :key="i" class="backlink" :href="link(b.link.view, b.link.id, b.link.query)"><icon :name="backIcon(b)" :size="14"/> <math-text :text="b.label"/> <span class="muted small">{{ timeAgo(b.at) }}</span></a></template>
            <h3 class="q-h3"><icon name="history" :size="14"/> How it evolved</h3>
            <ol class="q-timeline">
              <li v-for="v in s.revisions" :key="v.id" :class="{now: v.revision_no === s.current_revision, viewing: v.revision_no === viewedRevision}">
                <div><b>v{{ v.revision_no }}</b> <state-tag :status="v.status" :map="sStatus"/> <span>{{ v.change_note }}</span></div>
                <div class="muted small">{{ v.author_name }} <ai-meta :model="v.ai_model" :user="v.ai_user_name" :ms="v.ai_generation_ms" compact/> · <span :title="fullDate(v.created_at)">{{ timeAgo(v.created_at) }}</span>
                  <template v-if="v.revision_no !== s.current_revision"> · <button class="link-btn" @click="viewedRevision = v.revision_no">View</button> · <button class="link-btn" @click="restore(s, v)">Restore</button></template></div>
              </li>
            </ol>
          </div>
        </article>
      </section>

      <section v-if="backlinks.length" class="q-section">
        <header><h2>Mentioned in <span class="count">{{ backlinks.length }}</span></h2></header>
        <a v-for="(b, i) in backlinks" :key="i" class="backlink" :href="link(b.link.view, b.link.id, b.link.query)"><icon :name="backIcon(b)" :size="14"/> <math-text :text="b.label"/> <span class="muted small">{{ timeAgo(b.at) }}</span></a>
      </section>
    </div>
  </section>

  <section class="col col-comments">
    <div v-if="strategy" class="seg small q-comment-tabs" role="group" aria-label="Comments on"><button type="button" :class="{on: commentsOn === 'strategy'}" :aria-pressed="commentsOn === 'strategy'" @click="commentsOn = 'strategy'">Strategy<template v-if="strategy.comment_count"> ({{ strategy.comment_count }})</template></button><button type="button" :class="{on: commentsOn === 'question'}" :aria-pressed="commentsOn === 'question'" @click="commentsOn = 'question'">Question<template v-if="question.comment_count"> ({{ question.comment_count }})</template></button></div>
    <comments-panel v-if="question" :key="commentType + commentId" :target-type="commentType" :target-id="commentId" :title="commentTitle" v-model:active-id="activeThread" @created="reload" @activity="reload"/>
    <section-activity v-else kind="questions"/>
  </section>

  <modal v-if="qForm" :title="qForm.id ? 'Edit question' : (qForm.parent_id ? 'New sub-question' : 'New question')" wide @close="qForm = null">
    <div>
      <label class="field"><span>Title</span><input v-model="qForm.title" maxlength="255" autofocus placeholder="Short statement of the question ($…$ for LaTeX)"></label>
      <label class="field"><span>Part of</span><select v-model.number="qForm.parent_id"><option :value="0">Nothing: this is a big question</option><option v-for="p in parentOptions" :key="p.id" :value="p.id">{{ p.title }}</option></select></label>
      <div class="grid2"><label class="field"><span>Status</span><select v-model="qForm.status"><option v-for="(s, k) in qStatus" :key="k" :value="k">{{ s.label }}</option></select></label>
      <label class="field"><span>Priority</span><select v-model="qForm.priority"><option v-for="(l, k) in priorities" :key="k" :value="k">{{ l }}</option></select></label></div>
      <div class="field"><span>Statement</span><rich-editor ref="qEd" :initial-html="qForm.html" :min-height="130" placeholder="Precise statement, context, why it matters… (@ mentions, $…$ LaTeX)" @submit="saveQuestion"/></div>
    </div>
    <template #footer><button class="btn ghost" @click="qForm = null">Cancel</button><button class="btn primary" :disabled="busy || !qForm.title.trim()" @click="saveQuestion">Save</button></template>
  </modal>

  <modal v-if="sForm" :title="sForm.id ? 'Revise strategy' : 'New proof strategy'" wide @close="sForm = null">
    <div>
      <label class="field"><span>Name</span><input v-model="sForm.title" maxlength="255" autofocus placeholder="For example: induction on the rank"></label>
      <label class="field"><span>Status</span><select v-model="sForm.status"><option v-for="(s, k) in sStatus" :key="k" :value="k">{{ s.label }}</option></select></label>
      <div class="field"><span>Approach</span><rich-editor ref="sEd" :initial-html="sForm.html" :min-height="170" placeholder="Main idea, key steps, what is missing… (@ mentions, $…$ LaTeX)" @submit="saveStrategy"/></div>
      <label class="field"><span>{{ sForm.id ? 'What changed, and why?' : 'Note (optional)' }}</span><input v-model="sForm.note" maxlength="500" :placeholder="sForm.id ? 'For example: step 2 fails for non-compact spaces' : 'First version'"></label>
    </div>
    <template #footer><button class="btn ghost" @click="sForm = null">Cancel</button><button class="btn primary" :disabled="busy || !sForm.title.trim()" @click="saveStrategy">{{ sForm.id ? 'Save new version' : 'Add strategy' }}</button></template>
  </modal>

  <modal v-if="answerForm" title="Propose an answer" wide @close="answerForm = null">
    <p class="muted small">Nothing changes on the question until a human ratifies this answer.</p>
    <div class="field"><span>Answer</span><div class="seg"><button type="button" :class="{on: answerForm.answer === 'positive'}" @click="answerForm.answer = 'positive'">Positive (yes)</button><button type="button" :class="{on: answerForm.answer === 'negative'}" @click="answerForm.answer = 'negative'">Negative (no)</button></div></div>
    <label class="field"><span>Fact that answers it</span><select v-model.number="answerForm.fact"><option :value="0" disabled>Choose a fact…</option><option v-for="f in factOptions" :key="f.id" :value="f.id">{{ f.label }} — {{ f.title }}</option></select></label>
    <p v-if="!factOptions.length" class="muted small">The fact database is empty. Facts are added by AI clients.</p>
    <div class="field"><span>Why does this fact answer the question?</span><rich-editor ref="aEd" :min-height="100" placeholder="Explain the link between the fact and the question… (@ mentions, $…$ LaTeX)" @submit="saveAnswer"/></div>
    <template #footer><button class="btn ghost" @click="answerForm = null">Cancel</button><button class="btn primary" :disabled="busy || !answerForm.fact" @click="saveAnswer">Propose</button></template>
  </modal>

  <modal v-if="noteForm" :title="noteTitle" @close="noteForm = null">
    <label class="field"><span>{{ noteForm.mode === 'deny' ? 'What is wrong? Point to the exact step.' : 'Reason' }}</span><textarea v-model="noteForm.text" rows="4" maxlength="1000" autofocus></textarea></label>
    <p v-if="noteForm.mode === 'revoke'" class="muted small">The question goes back to In progress. The record of this ratification is kept.</p>
    <template #footer><button class="btn ghost" @click="noteForm = null">Cancel</button><button class="btn danger" :disabled="busy || !noteForm.text.trim()" @click="saveNote">{{ noteTitle }}</button></template>
  </modal>

  <modal v-if="linkForm" title="Link an item" @close="linkForm = null">
    <div>
      <label class="field"><span>Type</span><select v-model="linkForm.type" @change="linkForm.target = 0"><option v-for="(l, k) in linkGroups" :key="k" :value="k">{{ l }}</option></select></label>
      <label class="field"><span>Item</span><select v-model.number="linkForm.target"><option :value="0" disabled>Choose…</option><option v-for="o in linkOptions" :key="o.id" :value="o.id">{{ o.label }}</option></select></label>
      <p v-if="!linkOptions.length" class="muted small">Nothing of this type in the project yet.</p>
    </div>
    <template #footer><button class="btn ghost" @click="linkForm = null">Cancel</button><button class="btn primary" :disabled="busy || !linkForm.target" @click="saveLink">Link</button></template>
  </modal>
  </div>`,
  methods: {
    link, timeAgo, fullDate, isClosed, unreadOf,
    progressOf(n) { return progress(n); },
    strategyHref(s) { return s.id === this.strategyId ? link('questions', this.id) : link('questions', this.id, { strategy: s.id }); },
    toggle(id) { this.collapsed = this.collapsed.includes(id) ? this.collapsed.filter((x) => x !== id) : [...this.collapsed, id]; },
    async loadList() {
      const pid = this.pid;
      try { const r = await api.get(`api/projects/${pid}/questions`); if (pid === this.pid) { this.questions = r.questions; this.loaded = true; } } catch { this.loaded = true; }
    },
    onRoute() {
      this.activeThread = this.query?.comment ? +this.query.comment : null;
      this.viewedRevision = null;
      if (this.id) { if (this.question?.id !== this.id) this.question = null; this.loadQuestion(); } else { this.question = null; this.error = null; }
    },
    async loadQuestion() {
      const id = this.id;
      try {
        const q = await api.get(`api/questions/${id}`);
        if (id !== this.id) return;
        this.question = q; this.error = null;
        this.flagRead();
        this.loadBacklinks();
        this.followLink();
      } catch (e) { if (id === this.id) { this.error = e.message; this.question = null; } }
    },
    /** Opens what a reference points to inside the question: a version or an answer. */
    followLink() {
      const rev = this.query?.rev ? +this.query.rev : null;
      if (rev && this.strategy?.revisions.some((v) => v.revision_no === rev) && rev !== this.strategy.current_revision && this.seenRev !== `${this.strategyId}:${rev}`) {
        this.seenRev = `${this.strategyId}:${rev}`;
        this.viewedRevision = rev;
      }
      const aid = this.query?.answer ? +this.query.answer : null;
      if (aid && this.seenAnswer !== aid) {
        this.seenAnswer = aid;
        const a = this.question.answers.find((x) => x.id === aid);
        if (a && !['proposed', 'ratified'].includes(a.state)) this.showClosed = true;
        this.$nextTick(() => { const el = this.$el.querySelector(`[data-answer="${aid}"]`); el?.scrollIntoView({ block: 'center' }); el?.classList.add('flash'); });
      }
    },
    async loadBacklinks() {
      const q = this.question;
      if (!q) { this.backlinks = []; this.sBacklinks = []; return; }
      const get = async (type, id) => { try { return (await api.get(`api/projects/${this.pid}/backlinks?type=${type}&target=${id}`)).backlinks; } catch { return []; } };
      const sid = this.strategyId;
      const [a, b] = await Promise.all([get('question', q.id), sid ? get('strategy', sid) : []]);
      if (q.id !== this.id || sid !== this.strategyId) return;
      this.backlinks = a; this.sBacklinks = b;
    },
    backIcon(b) { return b.kind === 'message' ? 'mail' : b.kind === 'question' ? 'target' : b.kind === 'fact' ? 'graph' : 'comment'; },
    names(list) { return list.map((x) => x.name).join(', '); },
    actions(a) { return answerActions(a, { me: this.me, answers: this.question.answers }); },
    hasActions(a) { const x = this.actions(a); return x.review || x.reject || x.withdraw || x.revoke; },
    newAnswer() { this.answerForm = { answer: 'positive', fact: 0 }; refreshMentionables(); },
    async saveAnswer() {
      const f = this.answerForm;
      if (!f?.fact || this.busy) return;
      this.busy = true;
      const r = await attempt(() => api.post(`api/questions/${this.question.id}/answers`, { answer: f.answer, fact_id: f.fact, body_html: this.$refs.aEd.getHTML() }), 'Answer proposed');
      this.busy = false;
      if (r) { this.answerForm = null; this.question = r.question; this.loadList(); }
    },
    async ratify(a) {
      const k = ANSWER_KIND[a.answer];
      const warn = a.fact.chain === 'unchecked' ? ' This fact relies on facts that nobody has checked yet.' : '';
      if (!confirm(`Ratify this ${a.answer} answer? The question will be marked ${QUESTION_STATUS[k.status].label}.${warn}`)) return;
      const r = await attempt(() => api.post(`api/answers/${a.id}/ratify`), 'Answer ratified');
      if (r) this.question = r;
      await this.reload();
    },
    async withdrawAnswer(a) {
      if (!confirm('Withdraw this proposal?')) return;
      const r = await attempt(() => api.post(`api/answers/${a.id}/withdraw`));
      if (r) { this.question = r; this.loadList(); }
    },
    async toggleEndorse(a) {
      const mine = a.fact.my_review;
      const url = `api/facts/${a.fact.id}/reviews`;
      if (mine?.verdict === 'correct') await attempt(() => api.del(`${url}/${mine.id}`), 'Endorsement withdrawn');
      else await attempt(() => api.post(url, { verdict: 'correct' }), 'Fact endorsed');
      await this.reload();
    },
    async toggleDeny(a) {
      const mine = a.fact.my_review;
      if (mine?.verdict !== 'incorrect') { this.noteForm = { mode: 'deny', answer: a, text: '' }; return; }
      await attempt(() => api.del(`api/facts/${a.fact.id}/reviews/${mine.id}`), 'Denial withdrawn');
      await this.reload();
    },
    async saveNote() {
      const f = this.noteForm;
      if (!f?.text.trim() || this.busy) return;
      this.busy = true;
      const done = f.mode === 'deny'
        ? await attempt(() => api.post(`api/facts/${f.answer.fact.id}/reviews`, { verdict: 'incorrect', body_text: f.text }), 'Fact denied')
        : await attempt(() => api.post(`api/answers/${f.answer.id}/${f.mode}`, { note: f.text }), f.mode === 'reject' ? 'Answer rejected' : 'Ratification revoked');
      this.busy = false;
      if (done) { this.noteForm = null; await this.reload(); }
    },
    flagRead() {
      if (!this.question) return;
      markRead('oquestion', this.question.id, this.question.last_activity_id);
      if (this.strategy) markRead('strategy', this.strategy.id, this.strategy.last_activity_id);
    },
    async reload() { await Promise.all([this.loadList(), this.loadQuestion()]); },
    async markUnread(type, id) { await markItemUnread(type, id); },
    async readAll() {
      await attempt(async () => { await api.post(`api/projects/${this.pid}/read-all`, { type: 'oquestion' }); await api.post(`api/projects/${this.pid}/read-all`, { type: 'strategy' }); });
      await refreshCounters();
    },

    newQuestion(parent) { this.qForm = { id: null, parent_id: parent || 0, title: '', status: 'open', priority: 'normal', html: '' }; },
    editQuestion() { const q = this.question; this.qForm = { id: q.id, parent_id: q.parent_id || 0, title: q.title, status: q.status, priority: q.priority, html: q.statement_html }; },
    async saveQuestion() {
      const f = this.qForm;
      if (!f || !f.title.trim() || this.busy) return;
      this.busy = true;
      const body = { title: f.title, status: f.status, priority: f.priority, parent_id: f.parent_id || null, body_html: this.$refs.qEd.getHTML() };
      const r = await attempt(() => (f.id ? api.patch(`api/questions/${f.id}`, body) : api.post(`api/projects/${this.pid}/questions`, body)), f.id ? 'Question saved' : 'Question added');
      this.busy = false;
      if (!r) return;
      this.qForm = null;
      refreshMentionables();
      await this.loadList();
      if (r.id === this.id) this.question = r; else go(`/p/${this.pid}/questions/${r.id}`);
    },
    async setQuestion(change) {
      const r = await attempt(() => api.patch(`api/questions/${this.question.id}`, change));
      if (r) this.question = r; else this.question = { ...this.question };
      this.loadList();
    },
    async removeQuestion() {
      if (!confirm(`Delete “${this.question.title}” and its strategies?`)) return;
      const parent = this.question.parent_id;
      if (await attempt(() => api.del(`api/questions/${this.question.id}`), 'Question deleted')) { await this.loadList(); go(`/p/${this.pid}/questions${parent ? '/' + parent : ''}`); }
    },

    newStrategy() { this.sForm = { id: null, title: '', status: 'idea', html: '', note: '', base: null }; },
    editStrategy(s) { this.sForm = { id: s.id, title: s.title, status: s.status, html: s.body_html, note: '', base: s.current_revision }; },
    async saveStrategy() {
      const f = this.sForm;
      if (!f || !f.title.trim() || this.busy) return;
      this.busy = true;
      const body = { title: f.title, status: f.status, body_html: this.$refs.sEd.getHTML(), change_note: f.note };
      if (f.id) body.base_revision = f.base;
      const r = await attempt(() => (f.id ? api.patch(`api/strategies/${f.id}`, body) : api.post(`api/questions/${this.question.id}/strategies`, body)), f.id ? 'New version saved' : 'Strategy added');
      this.busy = false;
      if (!r) return;
      this.sForm = null;
      refreshMentionables();
      this.question = r.question;
      this.viewedRevision = null;
      this.loadList();
      if (r.id !== this.strategyId) go(link('questions', this.id, { strategy: r.id }).slice(1));
    },
    async setStrategy(s, change) {
      const r = await attempt(() => api.patch(`api/strategies/${s.id}`, { ...change, base_revision: s.current_revision }));
      if (r) { this.question = r.question; this.loadList(); } else await this.loadQuestion();
    },
    async restore(s, v) {
      if (!confirm(`Restore version ${v.revision_no}? It becomes a new version, and the history is kept.`)) return;
      const r = await attempt(() => api.post(`api/strategies/${s.id}/restore`, { revision_no: v.revision_no }), `Version ${v.revision_no} restored`);
      if (r) { this.question = r.question; this.viewedRevision = null; this.loadList(); }
    },
    async removeStrategy(s) {
      if (!confirm(`Delete the strategy “${s.title}” and its history?`)) return;
      if (await attempt(() => api.del(`api/strategies/${s.id}`), 'Strategy deleted')) { await this.reload(); go(link('questions', this.id).slice(1)); }
    },

    openLink(strategy) { this.linkForm = { strategy, type: 'fact', target: 0 }; },
    async saveLink() {
      const f = this.linkForm;
      this.busy = true;
      const r = await attempt(() => api.post(`api/questions/${this.question.id}/links`, { strategy_id: f.strategy, target_type: f.type, target_id: f.target }));
      this.busy = false;
      if (r) { this.question = r; this.linkForm = null; }
    },
    async removeLink(l) {
      const r = await attempt(() => api.del(`api/question-links/${l.id}`));
      if (r) this.question = r;
    },
  },
};
