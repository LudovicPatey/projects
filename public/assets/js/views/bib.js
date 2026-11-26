import { api } from '../api.js';
import { store, go, link, attempt, toast, refreshMentionables, unreadCount, markRead, markItemUnread } from '../store.js';
import { timeAgo, fullDate, fileSize } from '../util.js';
import { EXTRACTION_LABEL, bibProgress } from '../ai-model.js';

const TYPES = ['article', 'inproceedings', 'book', 'incollection', 'phdthesis', 'mastersthesis', 'techreport', 'misc', 'unpublished'];

export const BibView = {
  props: { pid: Number, id: Number, query: Object },
  data() {
    return {
      entries: [], loaded: false, search: '', sort: 'key', extracting: false, progressData: null, extractingAll: false,
      entry: null, entryError: null, tab: 'pdf',
      adding: false, addMode: 'doi', addDoi: '', addBibtex: '', addManual: { entry_type: 'article', title: '', author: '', year: '', journal: '', url: '', doi: '' }, busy: false,
      editBib: null, uploadProgress: null,
      threads: [], pending: null, activeThread: null, allPdfs: false, backlinks: [],
    };
  },
  computed: {
    filtered() {
      const q = this.search.toLowerCase();
      const list = this.entries.filter((e) => !q || [e.cite_key, e.title, e.authors, e.venue, e.year].some((x) => String(x || '').toLowerCase().includes(q)));
      const by = { key: (e) => e.cite_key.toLowerCase(), year: (e) => -(+e.year || 0), added: (e) => -new Date(e.created_at.replace(' ', 'T')).getTime() }[this.sort];
      return [...list].sort((a, b) => (by(a) < by(b) ? -1 : by(a) > by(b) ? 1 : 0));
    },
    pdfUrl() { return this.entry?.has_pdf ? `api/bib/${this.entry.id}/pdf?b=${this.entry.pdf.blob_id}` : null; },
    highlights() {
      const blob = this.entry?.pdf?.blob_id;
      const h = this.threads.filter((t) => t.anchor?.rects && t.anchor.blob_id === blob)
        .map((t) => ({ id: t.id, page: t.anchor.page, rects: t.anchor.rects, resolved: t.resolved }));
      if (this.pending?.anchor.rects) h.push({ id: 'pending', page: this.pending.anchor.page, rects: this.pending.anchor.rects });
      return h;
    },
    progress() { return bibProgress(this.progressData); },
    listed() { return this.entries.find((e) => e.id === this.entry?.id) || null; },
    extractState() { return this.listed?.extraction?.state || 'none'; },
    canDelete() { return this.entry && (this.entry.created_by === store.user.id || store.project.my_role === 'owner'); },
  },
  watch: { id: { immediate: true, handler() { this.onRoute(); } } },
  mounted() { this.loadList(); },
  template: `<div class="cols3">
  <section class="col col-list">
    <header class="col-head"><h2>Bibliography</h2>
      <div class="row-gap">
        <mark-all-read type="bib"/>
        <a class="icon-btn" :href="'api/projects/' + pid + '/bib/export'" title="Export as .bib"><icon name="download" :size="16"/></a>
        <ai-action kind="bib" label="Find" title="Ask an AI client to search the literature for references"/>
        <button class="btn primary sm" @click="adding = true"><icon name="plus" :size="14"/> Add</button></div></header>
    <section v-if="progress.total" class="bib-progress" aria-label="Bibliography progress">
      <div class="bib-progress-row"><span>PDFs</span><b>{{ progress.with_pdf }} / {{ progress.total }}</b></div>
      <div class="progress" role="progressbar" :aria-valuenow="progress.pdfPercent" aria-valuemin="0" aria-valuemax="100" aria-label="References with a PDF"><div :style="{width: progress.pdfPercent + '%'}"></div></div>
      <div class="bib-progress-row"><span>Facts extracted</span><b>{{ progress.extracted }} / {{ progress.with_pdf }}</b></div>
      <div class="progress" role="progressbar" :aria-valuenow="progress.extractedPercent" aria-valuemin="0" aria-valuemax="100" aria-label="PDFs with extracted facts"><div :style="{width: progress.extractedPercent + '%'}"></div></div>
      <div class="bib-progress-foot"><small><template v-if="progress.queued">{{ progress.queued }} queued</template><template v-if="progress.queued && progress.failed"> · </template><template v-if="progress.failed">{{ progress.failed }} failed</template><template v-if="progress.new_comments"><template v-if="progress.queued || progress.failed"> · </template>{{ progress.new_comments }} with new comments</template></small>
        <button v-if="progress.toQueue" class="btn sm" :disabled="extractingAll" :title="explain('bib.extract')" @click="extractAll"><icon name="sparkles" :size="13"/> Extract {{ progress.toQueue }} remaining</button></div>
    </section>
    <div class="col-tools">
      <div class="search"><icon name="search" :size="15"/><input v-model="search" placeholder="Search key, title, author…"></div>
      <div class="seg small">
        <button :class="{on: sort==='key'}" @click="sort='key'">Key</button>
        <button :class="{on: sort==='year'}" @click="sort='year'">Year</button>
        <button :class="{on: sort==='added'}" @click="sort='added'">Recent</button>
      </div>
    </div>
    <div class="list">
      <a v-for="e in filtered" :key="e.id" class="li bib-li" :class="{active: e.id === id, 'is-new': !!unreadOf(e.id)}" :href="link('bib', e.id)">
        <div class="li-top"><code class="key">{{ e.cite_key }}</code><span class="li-time">{{ e.year }}</span><unread-badge type="bib" :id="e.id"/></div>
        <div class="li-subject"><math-text :text="e.title"/></div>
        <div class="li-snippet">{{ e.authors }}</div>
        <div class="li-meta">
          <span v-if="e.has_pdf" class="tag red"><icon name="pdf" :size="11"/> PDF</span>
          <span v-else class="tag muted-tag">no PDF</span>
          <span v-if="extractionLabel[e.extraction?.state]" class="tag" :title="(e.extraction.models || []).join(', ')">{{ extractionLabel[e.extraction.state] }}</span>
          <ai-meta compact :model="e.ai_model" :user="e.ai_user_name" :ms="e.ai_generation_ms"/>
          <span v-if="e.comment_count"><icon name="comment" :size="12"/> {{ e.comment_count }}</span>
          <span class="muted small ellipsis">{{ e.venue }}</span>
        </div>
      </a>
      <div v-if="loaded && !filtered.length" class="empty">{{ entries.length ? 'No match.' : 'The bibliography is empty. Add references by DOI, arXiv id or BibTeX.' }}</div>
    </div>
  </section>

  <section class="col col-main">
    <template v-if="entry">
      <header class="doc-head">
        <div class="doc-title">
          <div class="row-gap"><code class="key big">{{ entry.cite_key }}</code>
            <button class="icon-btn xs" title="Copy \\cite command" @click="copyCite"><icon name="copy" :size="13"/></button>
            <span class="tag">{{ entry.entry_type }}</span></div>
          <h2><math-text :text="entry.title"/></h2>
          <div class="bib-authors">{{ entry.authors }}</div>
          <div class="muted">{{ [entry.venue, entry.year].filter(Boolean).join(', ') }}</div>
          <div class="row-gap small">
            <a v-if="entry.doi" :href="'https://doi.org/' + entry.doi" target="_blank" rel="noopener"><icon name="link" :size="12"/> doi:{{ entry.doi }}</a>
            <a v-if="entry.url" :href="entry.url" target="_blank" rel="noopener"><icon name="external" :size="12"/> {{ shortUrl(entry.url) }}</a>
            <span class="muted">added by {{ entry.added_by }} · {{ timeAgo(entry.created_at) }}</span>
            <ai-meta :model="entry.ai_model" :user="entry.ai_user_name" :ms="entry.ai_generation_ms"/>
          </div>
        </div>
        <div class="doc-actions">
          <label class="btn sm"><icon name="upload" :size="14"/> {{ entry.has_pdf ? 'Replace PDF' : 'Upload PDF' }}
            <input type="file" accept="application/pdf,.pdf" hidden @change="uploadPdf"></label>
          <button class="btn sm" :disabled="extracting || !entry.has_pdf || extractState === 'queued'" :title="!entry.has_pdf ? 'Upload a PDF first' : extractState === 'queued' ? 'Already in the AI queue' : 'Ask an AI client to extract the results stated in this PDF'" @click="extractFacts"><icon name="sparkles" :size="14"/> {{ extractState === 'done' ? 'Extract again' : extractState === 'comments' ? 'Update with comments' : 'Extract facts' }}</button>
          <button v-if="entry.has_pdf" class="icon-btn" title="Remove PDF" @click="removePdf"><icon name="x"/></button>
          <button class="icon-btn" title="Mark as unread" @click="markItemUnread('bib', entry.id)"><icon name="mail-unread"/></button>
          <button v-if="canDelete" class="icon-btn" title="Delete entry" @click="remove"><icon name="trash"/></button>
        </div>
      </header>
      <div v-if="uploadProgress !== null" class="progress"><div :style="{width: (uploadProgress * 100) + '%'}"></div></div>
      <nav class="tabs">
        <button :class="{on: tab==='pdf'}" @click="tab='pdf'"><icon name="eye" :size="14"/> PDF</button>
        <button :class="{on: tab==='bibtex'}" @click="tab='bibtex'; editBib = entry.bibtex"><icon name="code" :size="14"/> BibTeX</button>
        <button :class="{on: tab==='links'}" @click="tab='links'; loadBacklinks()"><icon name="at" :size="14"/> Mentions</button>
      </nav>
      <template v-if="tab==='pdf'">
        <pdf-viewer v-if="entry.has_pdf" ref="pdf" :src="pdfUrl" :download-url="'api/bib/' + entry.id + '/pdf?download=1'"
          :highlights="highlights" :active-id="activeThread" @selection="onSelection" @highlight-click="activeThread = $event"/>
        <label v-else class="dropzone" @dragover.prevent @drop.prevent="dropPdf">
          <icon name="pdf" :size="36"/><p><b>No PDF attached.</b><br>Drop a PDF here or click to upload one.</p>
          <input type="file" accept="application/pdf,.pdf" hidden @change="uploadPdf">
        </label>
      </template>
      <div v-if="tab==='bibtex'" class="pad scroll">
        <textarea class="bibtex-edit" v-model="editBib" spellcheck="false"></textarea>
        <div class="row-end"><button class="btn ghost" :title="explain('bib.reset')" @click="editBib = entry.bibtex">Reset</button>
          <button class="btn primary" :title="explain('bib.saveBibtex')" @click="saveBibtex">Save BibTeX</button></div>
      </div>
      <div v-if="tab==='links'" class="pad scroll">
        <div v-if="!backlinks.length" class="empty">This reference has not been @mentioned yet.</div>
        <a v-for="(b, i) in backlinks" :key="i" class="backlink" :href="link(b.link.view, b.link.id, b.link.query)">
          <icon :name="b.kind === 'message' ? 'mail' : b.kind === 'question' ? 'target' : 'comment'" :size="14"/> {{ b.label }} <span class="muted small">{{ timeAgo(b.at) }}</span></a>
      </div>
    </template>
    <div v-else-if="entryError" class="placeholder">{{ entryError }}</div>
    <section-home v-else kind="bib"><button class="btn primary" @click="adding = true"><icon name="plus" :size="15"/> Add references</button></section-home>
  </section>

  <section class="col col-comments">
    <template v-if="entry">
      <comments-panel target-type="bib" :target-id="entry.id" :pending="pending" v-model:active-id="activeThread"
        :filter="threadFilter" :describe="describe"
        @threads="threads = $event" @anchor-click="onThreadClick" @cancel-pending="pending = null" @created="pending = null" @activity="onActivity"/>
    </template>
    <section-activity v-else kind="bib"/>
  </section>

  <modal v-if="adding" title="Add references" @close="adding=false" wide>
    <div class="seg">
      <button :class="{on: addMode==='doi'}" @click="addMode='doi'">DOI / arXiv</button>
      <button :class="{on: addMode==='bibtex'}" @click="addMode='bibtex'">Paste BibTeX</button>
      <button :class="{on: addMode==='manual'}" @click="addMode='manual'">Manual</button>
    </div>
    <div v-if="addMode==='doi'" class="pad-y">
      <label class="field"><span>DOI, DOI URL or arXiv identifier</span>
        <input v-model="addDoi" placeholder="10.1007/s00222-014-0513-2  or  2301.01234" @keydown.enter="addEntries"></label>
      <p class="muted small">Metadata is fetched from doi.org (Crossref / DataCite).</p>
    </div>
    <div v-if="addMode==='bibtex'" class="pad-y">
      <label class="field"><span>One or several BibTeX entries</span>
        <textarea v-model="addBibtex" rows="12" class="mono" placeholder="@article{key, title={...}, author={...}, year={2024}}"></textarea></label>
    </div>
    <div v-if="addMode==='manual'" class="pad-y grid2">
      <label class="field"><span>Type</span><select v-model="addManual.entry_type"><option v-for="t in types" :key="t">{{ t }}</option></select></label>
      <label class="field"><span>Year</span><input v-model="addManual.year"></label>
      <label class="field span2"><span>Title</span><input v-model="addManual.title"></label>
      <label class="field span2"><span>Authors <small class="muted">(separated by “and”)</small></span><input v-model="addManual.author" placeholder="Erdős, Paul and Rényi, Alfréd"></label>
      <label class="field span2"><span>Journal / venue</span><input v-model="addManual.journal"></label>
      <label class="field"><span>DOI</span><input v-model="addManual.doi"></label>
      <label class="field"><span>URL</span><input v-model="addManual.url"></label>
    </div>
    <template #footer><button class="btn ghost" @click="adding=false">Cancel</button>
      <button class="btn primary" :disabled="busy" @click="addEntries">{{ busy ? 'Adding…' : 'Add' }}</button></template>
  </modal>
</div>`,
  created() { this.types = TYPES; this.extractionLabel = EXTRACTION_LABEL; },
  methods: {
    timeAgo, fullDate, fileSize, link, markItemUnread,
    unreadOf(id) { return unreadCount('bib', id); },
    onActivity() { if (this.tab !== 'bibtex' || this.editBib === this.entry?.bibtex) this.loadEntry(); },
    shortUrl(u) { try { const x = new URL(u); return x.host + x.pathname.slice(0, 30); } catch { return u; } },
    threadFilter(t) { return !t.anchor?.blob_id || t.anchor.blob_id === this.entry?.pdf?.blob_id; },
    describe(t) { return t.anchor?.page ? `Page ${t.anchor.page}` : ''; },
    async loadList() {
      try { const r = await api.get(`api/projects/${this.pid}/bib`); this.entries = r.entries; this.progressData = r.progress; this.loaded = true; } catch (e) { /* ignore */ }
    },
    onRoute() {
      this.pending = null; this.backlinks = [];
      this.activeThread = this.query?.comment ? +this.query.comment : null;
      if (this.id) this.loadEntry(); else this.entry = null;
    },
    async loadEntry() {
      const id = this.id;
      try {
        const e = await api.get(`api/bib/${id}`);
        if (id !== this.id) return;
        this.entry = e; this.entryError = null; this.editBib = e.bibtex;
        markRead('bib', e.id, e.last_activity_id);
        if (this.tab === 'links') this.loadBacklinks();
      } catch (e) { this.entry = null; this.entryError = e.message; }
    },
    async extractFacts() {
      this.extracting = true;
      await attempt(() => api.post(`api/projects/${this.pid}/ai/tasks`, { kind: 'extract', source_type: 'bib', source_id: this.entry.id }), 'Added to the AI queue. A running AI client will extract the facts.');
      this.extracting = false;
      this.loadList();
    },
    async extractAll() {
      const n = this.progress.toQueue;
      if (!confirm(`Queue ${n} PDF${n > 1 ? 's' : ''} for fact extraction? Each one uses the AI subscription of the member whose client processes it.`)) return;
      this.extractingAll = true;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/bib/extract-all`, {}));
      this.extractingAll = false;
      if (r) { this.progressData = r.progress; toast(`${r.queued} added to the AI queue`, 'success'); this.loadList(); }
    },
    async loadBacklinks() {
      if (!this.entry) return;
      this.backlinks = (await attempt(() => api.get(`api/projects/${this.pid}/backlinks?type=bib&target=${this.entry.id}`)))?.backlinks || [];
    },
    async addEntries() {
      let body;
      if (this.addMode === 'doi') { if (!this.addDoi.trim()) return; body = { doi: this.addDoi.trim() }; }
      else if (this.addMode === 'bibtex') { if (!this.addBibtex.trim()) return; body = { bibtex: this.addBibtex }; }
      else {
        const { entry_type, ...fields } = this.addManual;
        if (!fields.title.trim()) return toast('A title is required', 'error');
        body = { entry_type, fields };
      }
      this.busy = true;
      const r = await attempt(() => api.post(`api/projects/${this.pid}/bib`, body));
      this.busy = false;
      if (!r) return;
      const n = r.created.length;
      toast(`${n} reference${n !== 1 ? 's' : ''} added` + (r.skipped.length ? ` — ${r.skipped.length} already present (same DOI)` : ''), n ? 'success' : 'info');
      this.adding = false; this.addDoi = ''; this.addBibtex = '';
      this.addManual = { entry_type: 'article', title: '', author: '', year: '', journal: '', url: '', doi: '' };
      await this.loadList();
      refreshMentionables();
      if (n) go(`/p/${this.pid}/bib/${r.created[0]}`);
    },
    async saveBibtex() {
      const e = await attempt(() => api.patch(`api/bib/${this.entry.id}`, { bibtex: this.editBib }), 'Saved');
      if (e) { this.entry = e; this.editBib = e.bibtex; this.loadList(); refreshMentionables(); }
    },
    dropPdf(ev) { const f = ev.dataTransfer.files[0]; if (f) this.doUpload(f); },
    uploadPdf(ev) { const f = ev.target.files[0]; ev.target.value = ''; if (f) this.doUpload(f); },
    async doUpload(file) {
      const fd = new FormData();
      fd.append('pdf', file);
      this.uploadProgress = 0;
      try {
        this.entry = await api.upload(`api/bib/${this.entry.id}/pdf`, fd, (p) => { this.uploadProgress = p; });
        toast('PDF attached', 'success');
        this.tab = 'pdf';
        this.loadList();
      } catch (e) { toast(e.message, 'error'); }
      this.uploadProgress = null;
    },
    async removePdf() {
      if (!confirm('Detach the PDF from this reference? (Comments on the PDF are kept but hidden.)')) return;
      const e = await attempt(() => api.del(`api/bib/${this.entry.id}/pdf`));
      if (e) { this.entry = e; this.loadList(); }
    },
    async remove() {
      if (!confirm(`Delete the reference ${this.entry.cite_key} and its comments?`)) return;
      if (await attempt(() => api.del(`api/bib/${this.entry.id}`), 'Reference deleted')) {
        await this.loadList(); refreshMentionables(); go(`/p/${this.pid}/bib`);
      }
    },
    copyCite() {
      navigator.clipboard?.writeText(`\\cite{${this.entry.cite_key}}`);
      toast(`Copied \\cite{${this.entry.cite_key}}`);
    },
    onSelection(s) {
      this.pending = { anchor: { blob_id: this.entry.pdf.blob_id, page: s.page, quote: s.quote, rects: s.rects }, label: `Page ${s.page}` };
    },
    onThreadClick(t) {
      if (!t.anchor?.rects) return;
      this.tab = 'pdf';
      this.$nextTick(() => this.$refs.pdf?.scrollToHighlight(t.id));
    },
  },
};
