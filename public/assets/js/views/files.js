import { api } from '../api.js';
import { store, go, link, attempt, toast, refreshMentionables, unreadCount, markRead, markItemUnread } from '../store.js';
import { timeAgo, fullDate, fileSize, isTextFile } from '../util.js';

/** Upload form used both for a new file and for a new version. */
const UploadForm = {
  props: { mode: String, doc: Object },
  emits: ['done', 'cancel'],
  data() {
    return {
      title: '', description: '', origin: '', aiModel: this.doc?.ai_model || '', genSeconds: '', notes: '', keepSources: true,
      pdf: null, sources: [], progress: null,
    };
  },
  template: `<form class="upload-form" @submit.prevent="submit">
    <template v-if="mode === 'new'">
      <label class="field"><span>Title</span><input v-model="title" required placeholder="e.g. Proof sketch of Lemma 3"></label>
      <div class="field"><span>Who wrote this file?</span>
        <div class="origin-pick">
          <label class="origin-opt human" :class="{on: origin === 'human'}"><input type="radio" value="human" v-model="origin">
            <icon name="user" :size="22"/><b>Human</b><small>Written by one or more researchers</small></label>
          <label class="origin-opt ai" :class="{on: origin === 'ai'}"><input type="radio" value="ai" v-model="origin">
            <icon name="bot" :size="22"/><b>AI</b><small>Generated (mostly) by an AI system</small></label>
        </div>
      </div>
      <label class="field" v-if="origin === 'ai'"><span>AI system / model <small class="muted">(required)</small></span>
        <input v-model="aiModel" required placeholder="e.g. Claude Opus 5.5, AlphaProof…"></label>
      <label class="field" v-if="origin === 'ai'"><span>Generation time in seconds <small class="muted">(optional, only if measured)</small></span>
        <input v-model="genSeconds" type="number" min="0" step="any"></label>
      <label class="field"><span>Description <small class="muted">(optional)</small></span>
        <textarea v-model="description" rows="2" placeholder="What does this file contain?"></textarea></label>
    </template>
    <label class="field" v-if="mode === 'version' && doc.origin === 'ai'"><span>AI model of this version <small class="muted">(required)</small></span>
      <input v-model="aiModel" required></label>
    <label class="field" v-if="mode === 'version' && doc.origin === 'ai'"><span>Generation time in seconds <small class="muted">(optional, only if measured)</small></span>
      <input v-model="genSeconds" type="number" min="0" step="any"></label>
    <div class="field"><span>PDF <small class="muted">(required)</small></span>
      <input type="file" accept="application/pdf,.pdf" @change="pdf = $event.target.files[0] || null"></div>
    <div class="field"><span>LaTeX sources <small class="muted">(optional — .tex, .bib, figures, or a .zip)</small></span>
      <input type="file" multiple @change="sources = [...$event.target.files]">
      <label v-if="mode === 'version' && hasPrevSources" class="check"><input type="checkbox" v-model="keepSources" :disabled="sources.length > 0">
        Keep the sources of the current version if none are uploaded</label></div>
    <label class="field"><span>Version notes <small class="muted">(optional)</small></span>
      <input v-model="notes" :placeholder="mode === 'new' ? 'Initial version' : 'What changed?'"></label>
    <div v-if="progress !== null" class="progress"><div :style="{width: (progress * 100) + '%'}"></div></div>
    <div class="row-end">
      <button type="button" class="btn ghost" @click="$emit('cancel')">Cancel</button>
      <button class="btn primary" :disabled="progress !== null"><icon name="upload" :size="15"/> {{ mode === 'new' ? 'Upload file' : 'Upload new version' }}</button>
    </div>
  </form>`,
  computed: {
    hasPrevSources() { return this.doc?.versions?.find((v) => v.is_current)?.files.some((f) => f.role !== 'pdf'); },
  },
  methods: {
    async submit() {
      if (this.mode === 'new' && !this.title.trim()) return toast('Please give a title', 'error');
      if (this.mode === 'new' && !this.origin) return toast('Please state whether a human or an AI wrote this file', 'error');
      const isAi = this.mode === 'new' ? this.origin === 'ai' : this.doc.origin === 'ai';
      if (isAi && !this.aiModel.trim()) return toast('AI-generated content must state its model', 'error');
      if (!this.pdf) return toast('Please choose a PDF file', 'error');
      const fd = new FormData();
      fd.append('pdf', this.pdf);
      this.sources.forEach((f) => fd.append('sources[]', f));
      fd.append('notes', this.notes);
      if (isAi && this.genSeconds !== '') fd.append('generation_seconds', this.genSeconds);
      let url;
      if (this.mode === 'new') {
        fd.append('title', this.title); fd.append('description', this.description);
        fd.append('origin', this.origin); fd.append('ai_model', this.aiModel);
        url = `api/projects/${store.project.id}/documents`;
      } else {
        fd.append('keep_sources', this.keepSources ? '1' : '0');
        if (isAi) fd.append('ai_model', this.aiModel);
        url = `api/documents/${this.doc.id}/versions`;
      }
      this.progress = 0;
      try {
        const r = await api.upload(url, fd, (p) => { this.progress = p; });
        toast(this.mode === 'new' ? 'File uploaded' : 'New version uploaded', 'success');
        this.$emit('done', r);
      } catch (e) { toast(e.message, 'error'); }
      this.progress = null;
    },
  },
};

export const FilesView = {
  components: { UploadForm },
  props: { pid: Number, id: Number, query: Object },
  data() {
    return {
      docs: [], loaded: false, filter: 'all', search: '',
      doc: null, docError: null, tab: 'preview', uploading: false, newVersion: false, editing: null,
      threads: [], pending: null, activeThread: null, allVersions: false,
      textPreview: null, backlinks: [],
    };
  },
  computed: {
    filtered() {
      const q = this.search.toLowerCase();
      return this.docs.filter((d) => (this.filter === 'all' || d.origin === this.filter)
        && (!q || d.title.toLowerCase().includes(q) || (d.description || '').toLowerCase().includes(q)));
    },
    counts() {
      return { all: this.docs.length, human: this.docs.filter((d) => d.origin === 'human').length, ai: this.docs.filter((d) => d.origin === 'ai').length };
    },
    version() {
      if (!this.doc) return null;
      const vid = this.query?.v ? +this.query.v : null;
      return this.doc.versions.find((v) => v.id === vid) || this.doc.versions.find((v) => v.is_current) || this.doc.versions[0];
    },
    pdfUrl() { return this.version?.pdf_file_id ? `api/files/${this.version.pdf_file_id}` : null; },
    sources() { return this.version ? this.version.files.filter((f) => f.role !== 'pdf') : []; },
    highlights() {
      const h = this.threads.filter((t) => t.anchor?.rects && t.anchor.version_id === this.version?.id)
        .map((t) => ({ id: t.id, page: t.anchor.page, rects: t.anchor.rects, resolved: t.resolved }));
      if (this.pending?.anchor.rects) h.push({ id: 'pending', page: this.pending.anchor.page, rects: this.pending.anchor.rects });
      return h;
    },
    canDelete() { return this.doc && (this.doc.created_by === store.user.id || store.project.my_role === 'owner'); },
  },
  watch: {
    id: { immediate: true, handler() { this.onRoute(); } },
    'query.v'() { this.pending = null; this.textPreview = null; },
    'query.upload': { immediate: true, handler(v) { if (v) this.uploading = true; } },
  },
  mounted() { this.loadList(); },
  template: `<div class="cols3">
  <section class="col col-list">
    <header class="col-head"><h2>Files</h2>
      <div class="row-gap"><mark-all-read type="document"/><button class="btn primary sm" @click="startUpload"><icon name="upload" :size="14"/> Upload</button></div></header>
    <div class="col-tools">
      <div class="seg">
        <button :class="{on: filter==='all'}" @click="filter='all'">All <b class="seg-n plain">{{ counts.all }}</b></button>
        <button :class="{on: filter==='human'}" @click="filter='human'" class="seg-human"><icon name="user" :size="13"/> Human <b class="seg-n plain">{{ counts.human }}</b></button>
        <button :class="{on: filter==='ai'}" @click="filter='ai'" class="seg-ai"><icon name="bot" :size="13"/> AI <b class="seg-n plain">{{ counts.ai }}</b></button>
      </div>
      <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Search files"></div>
    </div>
    <div class="list">
      <a v-for="d in filtered" :key="d.id" class="li file-li" :class="['o-' + d.origin, {active: d.id === id, 'is-new': !!unreadOf(d.id)}]" :href="link('files', d.id)">
        <div class="file-icon" :class="d.origin"><icon :name="d.origin === 'ai' ? 'bot' : 'user'" :size="18"/></div>
        <div class="file-text">
          <div class="li-subject li-with-badge"><span>{{ d.title }}</span><unread-badge type="document" :id="d.id"/></div>
          <div class="li-snippet">v{{ d.current_version_no }} · {{ timeAgo(d.updated_at) }} · {{ d.created_by_name }}</div>
          <div class="li-meta">
            <origin-badge :origin="d.origin" :model="d.ai_model"/>
            <ai-meta :model="d.ai_model" :user="d.ai_user_name" :ms="d.ai_generation_ms"/>
            <span v-if="d.source_count" title="LaTeX sources"><icon name="code" :size="12"/> {{ d.source_count }}</span>
            <span v-if="d.version_count > 1" title="Versions"><icon name="history" :size="12"/> {{ d.version_count }}</span>
            <span v-if="d.open_threads" title="Open comment threads"><icon name="comment" :size="12"/> {{ d.open_threads }}</span>
          </div>
        </div>
      </a>
      <div v-if="loaded && !filtered.length" class="empty">No files{{ filter !== 'all' ? ' in this category' : '' }}.</div>
    </div>
  </section>

  <section class="col col-main">
    <template v-if="uploading">
      <header class="col-head"><h2>Upload a file</h2></header>
      <div class="pad"><upload-form mode="new" @done="onCreated" @cancel="uploading=false"/></div>
    </template>
    <template v-else-if="doc && version">
      <div class="doc-banner" :class="doc.origin">
        <icon :name="doc.origin === 'ai' ? 'bot' : 'user'" :size="16"/>
        <span v-if="doc.origin === 'ai'"><b>AI-generated file.</b> <ai-meta :model="version.ai_model || doc.ai_model" :user="version.ai_user_name" :ms="version.ai_generation_ms"/> Check carefully before relying on it.</span>
        <span v-else><b>Human-written file</b></span>
      </div>
      <header class="doc-head">
        <div class="doc-title">
          <h2>{{ doc.title }}</h2>
          <div class="muted small">Created by {{ doc.created_by_name }} · {{ fullDate(doc.created_at) }}</div>
          <p v-if="doc.description" class="doc-desc"><math-text :text="doc.description_shown ?? doc.description" :macros="doc.tex_macros"/></p>
        </div>
        <div class="doc-actions">
          <select class="version-select" :value="version.id" @change="selectVersion(+$event.target.value)">
            <option v-for="v in doc.versions" :key="v.id" :value="v.id">v{{ v.version_no }}{{ v.is_current ? ' (current)' : '' }} — {{ timeAgo(v.created_at) }}</option>
          </select>
          <button class="btn sm" :title="explain('file.newVersion')" @click="newVersion = true"><icon name="upload" :size="14"/> New version</button>
          <ai-action kind="extract" source-type="document" :source-id="doc.id"/>
          <ai-action kind="ask" source-type="document" :source-id="doc.id" label="Ask AI"/>
          <button v-if="!version.is_current" class="btn sm warn" :title="explain('file.restore')" @click="restore(version)"><icon name="restore" :size="14"/> Restore v{{ version.version_no }}</button>
          <a class="btn sm" :href="'api/versions/' + version.id + '/zip'" title="PDF + sources as .zip"><icon name="download" :size="14"/> .zip</a>
          <button class="icon-btn" title="Mark as unread" @click="markItemUnread('document', doc.id)"><icon name="mail-unread"/></button>
          <button class="icon-btn" title="Edit details" @click="startEdit"><icon name="edit"/></button>
          <button v-if="canDelete" class="icon-btn" title="Delete file" @click="remove"><icon name="trash"/></button>
        </div>
      </header>
      <div v-if="!version.is_current" class="old-version-note">
        You are viewing <b>version {{ version.version_no }}</b>. The current version is v{{ doc.versions.find(v => v.is_current)?.version_no }}.
        <a :href="link('files', doc.id)">Go to current</a></div>
      <nav class="tabs">
        <button :class="{on: tab==='preview'}" @click="tab='preview'"><icon name="eye" :size="14"/> PDF</button>
        <button :class="{on: tab==='sources'}" @click="tab='sources'"><icon name="code" :size="14"/> Sources <b v-if="sources.length" class="seg-n plain">{{ sources.length }}</b></button>
        <button :class="{on: tab==='versions'}" @click="tab='versions'"><icon name="history" :size="14"/> Versions <b class="seg-n plain">{{ doc.versions.length }}</b></button>
        <button :class="{on: tab==='links'}" @click="tab='links'; loadBacklinks()"><icon name="at" :size="14"/> Mentions</button>
      </nav>
      <pdf-viewer v-show="tab==='preview'" ref="pdf" :src="pdfUrl" :download-url="pdfUrl + '?download=1'" :highlights="highlights" :active-id="activeThread"
        @selection="onSelection" @highlight-click="activeThread = $event"/>
      <div v-if="tab==='sources'" class="pad scroll">
        <div v-if="!sources.length" class="empty">No LaTeX sources for this version. Upload a new version to add them.</div>
        <table v-else class="table">
          <thead><tr><th>File</th><th>Type</th><th>Size</th><th></th></tr></thead>
          <tbody><tr v-for="f in sources" :key="f.id">
            <td><icon :name="f.role === 'bib' ? 'book' : 'code'" :size="14"/> {{ f.filename }}</td>
            <td>{{ f.role === 'bib' ? 'Bibliography' : 'Source' }}</td><td>{{ fileSize(f.size) }}</td>
            <td class="right">
              <button v-if="isTextFile(f.filename)" class="btn xs" @click="preview(f)"><icon name="eye" :size="13"/> View</button>
              <a class="btn xs" :href="'api/files/' + f.id + '?download=1'"><icon name="download" :size="13"/></a></td>
          </tr></tbody>
        </table>
        <div v-if="textPreview" class="text-preview"><div class="tp-head"><b>{{ textPreview.name }}</b>
          <button class="icon-btn xs" @click="textPreview=null"><icon name="x" :size="14"/></button></div>
          <pre>{{ textPreview.text }}</pre></div>
      </div>
      <div v-if="tab==='versions'" class="pad scroll">
        <div class="timeline">
          <div v-for="v in doc.versions" :key="v.id" class="tl-item" :class="{current: v.is_current, viewing: v.id === version.id}">
            <div class="tl-dot"></div>
            <div class="tl-body">
              <div class="tl-head"><b>Version {{ v.version_no }}</b>
                <span v-if="v.is_current" class="tag green">current</span>
                <span v-if="v.restored_from_no" class="tag">restored from v{{ v.restored_from_no }}</span>
                <span class="grow"></span><span class="muted small">{{ fullDate(v.created_at) }}</span></div>
              <div class="muted small">by {{ v.uploaded_by_name }} · {{ v.files.length }} file{{ v.files.length > 1 ? 's' : '' }}</div>
              <ai-meta :model="v.ai_model" :user="v.ai_user_name" :ms="v.ai_generation_ms"/>
              <div v-if="v.notes" class="tl-notes">{{ v.notes }}</div>
              <div class="tl-actions">
                <button class="btn xs" @click="selectVersion(v.id); tab='preview'"><icon name="eye" :size="13"/> View</button>
                <a class="btn xs" :href="'api/files/' + v.pdf_file_id + '?download=1'"><icon name="download" :size="13"/> PDF</a>
                <a class="btn xs" :href="'api/versions/' + v.id + '/zip'"><icon name="download" :size="13"/> .zip</a>
                <button v-if="!v.is_current" class="btn xs warn" :title="explain('file.restore')" @click="restore(v)"><icon name="restore" :size="13"/> Restore</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="tab==='links'" class="pad scroll">
        <div v-if="!backlinks.length" class="empty">This file has not been @mentioned yet.</div>
        <a v-for="(b, i) in backlinks" :key="i" class="backlink" :href="link(b.link.view, b.link.id, b.link.query)">
          <icon :name="b.kind === 'message' ? 'mail' : b.kind === 'question' ? 'target' : 'comment'" :size="14"/> {{ b.label }} <span class="muted small">{{ timeAgo(b.at) }}</span></a>
      </div>
    </template>
    <div v-else-if="docError" class="placeholder">{{ docError }}</div>
    <section-home v-else kind="files"><button class="btn primary" @click="startUpload"><icon name="upload" :size="15"/> Upload a file</button></section-home>
  </section>

  <section class="col col-comments">
    <template v-if="doc && version && !uploading">
      <comments-panel target-type="document" :target-id="doc.id" :pending="pending" v-model:active-id="activeThread"
        :filter="threadFilter" :describe="describe"
        @threads="threads = $event" @anchor-click="onThreadClick" @cancel-pending="pending = null" @created="pending = null" @activity="loadDoc"/>
      <label class="check all-versions"><input type="checkbox" v-model="allVersions"> Show comments of all versions</label>
    </template>
    <section-activity v-else kind="files"/>
  </section>

  <modal v-if="newVersion" title="Upload a new version" @close="newVersion=false">
    <upload-form mode="version" :doc="doc" @done="onNewVersion" @cancel="newVersion=false"/>
  </modal>
  <modal v-if="editing" title="Edit file details" @close="editing=null">
    <form @submit.prevent="saveEdit">
      <label class="field"><span>Title</span><input v-model="editing.title" required></label>
      <div class="field"><span>Written by</span>
        <div class="origin-pick">
          <label class="origin-opt human" :class="{on: editing.origin === 'human'}"><input type="radio" value="human" v-model="editing.origin"><icon name="user" :size="20"/><b>Human</b></label>
          <label class="origin-opt ai" :class="{on: editing.origin === 'ai'}"><input type="radio" value="ai" v-model="editing.origin"><icon name="bot" :size="20"/><b>AI</b></label>
        </div></div>
      <label class="field" v-if="editing.origin === 'ai'"><span>AI system / model <small class="muted">(required)</small></span><input v-model="editing.ai_model" required></label>
      <label class="field"><span>Description</span><textarea v-model="editing.description" rows="3"></textarea></label>
      <div class="row-end"><button type="button" class="btn ghost" @click="editing=null">Cancel</button><button class="btn primary">Save</button></div>
    </form>
  </modal>
</div>`,
  methods: {
    timeAgo, fullDate, fileSize, isTextFile, link, markItemUnread,
    unreadOf(id) { return unreadCount('document', id); },
    threadFilter(t) { return this.allVersions || !t.anchor?.version_id || t.anchor.version_id === this.version?.id; },
    describe(t) {
      const v = this.doc?.versions.find((x) => x.id === t.anchor?.version_id);
      return (v ? `v${v.version_no}` : 'Deleted version') + (t.anchor?.page ? ` · page ${t.anchor.page}` : '');
    },
    async loadList() {
      try {
        this.docs = (await api.get(`api/projects/${this.pid}/documents`)).documents;
        this.loaded = true;
      } catch (e) { /* ignore */ }
    },
    onRoute() {
      this.pending = null; this.textPreview = null; this.backlinks = [];
      this.activeThread = this.query?.comment ? +this.query.comment : null;
      if (this.id) { this.uploading = false; this.loadDoc(); } else { this.doc = null; }
    },
    async loadDoc() {
      const id = this.id;
      try {
        const d = await api.get(`api/documents/${id}`);
        if (id !== this.id) return;
        this.doc = d; this.docError = null;
        markRead('document', d.id, d.last_activity_id);
        if (this.tab === 'links') this.loadBacklinks();
      } catch (e) { this.doc = null; this.docError = e.message; }
    },
    async loadBacklinks() {
      if (!this.doc) return;
      this.backlinks = (await attempt(() => api.get(`api/projects/${this.pid}/backlinks?type=document&target=${this.doc.id}`)))?.backlinks || [];
    },
    startUpload() { this.uploading = true; if (this.id) go(`/p/${this.pid}/files?upload=1`); },
    async onCreated(d) {
      this.uploading = false;
      await this.loadList();
      refreshMentionables();
      go(`/p/${this.pid}/files/${d.id}`);
    },
    async onNewVersion(d) {
      this.newVersion = false;
      this.doc = d;
      this.loadList();
      go(`/p/${this.pid}/files/${d.id}`);
    },
    selectVersion(vid) {
      const v = this.doc.versions.find((x) => x.id === vid);
      go(`/p/${this.pid}/files/${this.doc.id}` + (v && !v.is_current ? `?v=${vid}` : ''));
    },
    async restore(v) {
      if (!confirm(`Restore version ${v.version_no}? A new version identical to v${v.version_no} will be created; no history is lost.`)) return;
      const d = await attempt(() => api.post(`api/documents/${this.doc.id}/versions/${v.id}/restore`), `Version ${v.version_no} restored`);
      if (d) { this.doc = d; this.loadList(); go(`/p/${this.pid}/files/${d.id}`); }
    },
    startEdit() { this.editing = { title: this.doc.title, origin: this.doc.origin, ai_model: this.doc.ai_model || '', description: this.doc.description || '' }; },
    async saveEdit() {
      const d = await attempt(() => api.patch(`api/documents/${this.doc.id}`, this.editing), 'Saved');
      if (d) { this.doc = d; this.editing = null; this.loadList(); refreshMentionables(); }
    },
    async remove() {
      if (!confirm(`Delete “${this.doc.title}” and all its versions?`)) return;
      if (await attempt(() => api.del(`api/documents/${this.doc.id}`), 'File deleted')) {
        await this.loadList(); refreshMentionables(); go(`/p/${this.pid}/files`);
      }
    },
    async preview(f) {
      try {
        const res = await fetch(`api/files/${f.id}?download=1`, { credentials: 'same-origin' });
        const text = await res.text();
        this.textPreview = { name: f.filename, text: text.length > 400000 ? text.slice(0, 400000) + '\n…' : text };
      } catch (e) { toast(e.message, 'error'); }
    },
    onSelection(s) {
      this.pending = { anchor: { version_id: this.version.id, page: s.page, quote: s.quote, rects: s.rects }, label: `v${this.version.version_no} · page ${s.page}` };
    },
    onThreadClick(t) {
      if (t.anchor?.version_id && t.anchor.version_id !== this.version.id) {
        this.selectVersion(t.anchor.version_id);
        setTimeout(() => this.$refs.pdf?.scrollToHighlight(t.id), 1200);
        return;
      }
      this.tab = 'preview';
      this.$nextTick(() => this.$refs.pdf?.scrollToHighlight(t.id));
    },
  },
};
