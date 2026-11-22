// Keeps the help center complete: a new controller or menu view without an article fails here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ARTICLES, CATEGORIES, CONTROLLER_HELP, VIEW_HELP, articleBySlug, articleText, inlineTokens, nextSteps, pointerHref, resolveTarget, searchHelp } from '../public/assets/js/help/content.js';

const VIEWS = ['overview', 'questions', 'conversations', 'facts', 'files', 'bib', 'ai', 'members', 'help'];

function allInline(a) {
  const out = [a.summary];
  for (const b of a.blocks) {
    if (b.text) out.push(b.text);
    if (b.items) out.push(...b.items);
    if (b.rows) out.push(...b.rows.flat());
  }
  return out;
}

const empty = { project: { id: 7, title: 'Empty', status: 'open', role: 'member' }, me: { id: 1, name: 'A', keys: 0 }, unread: {},
  facts: { total: 0, by_status: {}, labels: {}, to_review: [], to_review_count: 0, disputed: [], retracted: [], broken: [], broken_count: 0, human_proofs: [], ai_proofs: [], endorsed: [], lean: [], danus: [], counterexamples: [], most_used: null, unread: [] },
  files: { total: 0, human: null, ai: null, versioned: null, latest: null, unread: null }, bib: { total: 0, without_pdf_count: 0, without_pdf: [], sample: null },
  questions: { total: 0, big: 0, open: 0, strategies: 0, top: [], without_strategy: [], without_strategy_count: 0, pending: [], pending_count: 0, at_risk: [], blocked: [], unread: [] },
  conversations: { total: 0, latest: null, unread: [] }, thread: null, people: { researchers: 1, owners: [], agents: [] } };
const f = { id: 3, label: 'lem:x', title: 'X' }; const d = { id: 4, title: 'D' };
const full = { ...empty, project: { ...empty.project, role: 'owner' }, me: { id: 1, name: 'A', keys: 2 }, unread: { conversation: 2, fact: 1, document: 1, bib: 1, member: 1 },
  facts: { total: 5, by_status: { disputed: 1 }, labels: { dead_end: 2 }, to_review: [f], to_review_count: 1, disputed: [f], retracted: [f], broken: [f], broken_count: 1, human_proofs: [f], ai_proofs: [f], endorsed: [f], lean: [f], danus: [f], counterexamples: [f], most_used: { ...f, used_by: 2 }, unread: [f] },
  files: { total: 2, human: d, ai: d, versioned: d, latest: d, unread: d }, bib: { total: 1, without_pdf_count: 1, without_pdf: [{ id: 5, label: 'k', title: 'T' }], sample: { id: 5, label: 'k', title: 'T' } },
  questions: { total: 3, big: 1, open: 2, strategies: 2, top: [d], without_strategy: [d], without_strategy_count: 1, pending: [d], pending_count: 1, at_risk: [d], blocked: [{ id: 4, strategy: 8, title: 'S' }], unread: [d] },
  conversations: { total: 1, latest: d, unread: [d] }, thread: { view: 'files', id: 4, comment: 9 }, people: { researchers: 3, owners: [{ id: 1, title: 'O' }], agents: [{ id: 2, title: 'P', model: 'm' }] } };

test('every server feature has a help article', () => {
  const index = fs.readFileSync('public/index.php', 'utf8');
  const used = [...new Set([...index.matchAll(/\[(\w+Controller)::class/g)].map((m) => m[1]))];
  assert.ok(used.length >= 13);
  for (const c of used) assert.ok(articleBySlug(CONTROLLER_HELP[c]), `${c} has no help article: add one in public/assets/js/help/content.js`);
});

test('every menu view has a help article', () => {
  const main = fs.readFileSync('public/assets/js/main.js', 'utf8');
  const nav = [...main.matchAll(/\{ view: '(\w+)', icon:/g)].map((m) => m[1]);
  assert.ok(nav.length >= 6);
  for (const v of [...nav, ...VIEWS]) assert.ok(articleBySlug(VIEW_HELP[v]), `the view ${v} has no help article`);
});

test('articles are well formed', () => {
  const slugs = ARTICLES.map((a) => a.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  const cats = new Set(CATEGORIES.map((c) => c.id));
  for (const a of ARTICLES) {
    assert.ok(cats.has(a.category), a.slug);
    assert.ok(a.title && a.summary && a.blocks.length, a.slug);
    for (const r of a.related || []) assert.ok(articleBySlug(r), `${a.slug} → ${r}`);
  }
  for (const c of CATEGORIES) assert.ok(ARTICLES.some((a) => a.category === c.id), c.id);
});

test('every link of the help points somewhere real', () => {
  const routes = new Set([...VIEWS, 'profile', 'projects', 'feedback']);
  for (const a of ARTICLES) {
    for (const s of allInline(a)) {
      for (const t of inlineTokens(s).filter((x) => x.t === 'link')) {
        if (t.target.startsWith('help:')) assert.ok(articleBySlug(t.target.slice(5)), `${a.slug}: ${t.target}`);
        else if (t.target.startsWith('app:')) assert.ok(routes.has(t.target.slice(4)), `${a.slug}: ${t.target}`);
        else assert.match(t.target, /^https:\/\//, `${a.slug}: ${t.target}`);
      }
    }
  }
  assert.equal(resolveTarget('app:facts', 3), '#/p/3/facts');
  assert.equal(resolveTarget('app:facts', null), null);
  assert.equal(resolveTarget('app:profile', null), '#/profile');
  assert.equal(pointerHref({ view: 'files', id: 4, query: { comment: 9 } }, 3), '#/p/3/files/4?comment=9');
});

test('project-aware blocks work on empty and full projects', () => {
  for (const c of [empty, full]) {
    for (const a of ARTICLES) {
      for (const b of a.blocks.filter((x) => x.type === 'live')) {
        const lines = b.render(c).filter(Boolean);
        assert.ok(lines.length, a.slug);
        for (const l of lines) {
          assert.ok(l.code || typeof l.text === 'string', a.slug);
          for (const x of l.links || []) assert.match(pointerHref(x.to, c.project.id), /^#\//, a.slug);
          if (l.text) assert.ok(!/undefined|null|NaN/.test(l.text), `${a.slug}: ${l.text}`);
        }
      }
    }
    for (const s of nextSteps(c)) { assert.ok(articleBySlug(s.help)); assert.match(pointerHref(s.to, 7), /^#\//); }
  }
});

test('help search', () => {
  assert.equal(searchHelp('endorse')[0].slug, 'reviews');
  assert.equal(searchHelp('orcid sign')[0].slug, 'account');
  assert.equal(searchHelp('sorry')[0].slug, 'lean');
  assert.ok(searchHelp('ÉNDORSE').length, 'accents and case are ignored');
  assert.equal(searchHelp('zzzzqq').length, 0);
  assert.equal(searchHelp('a').length, 0);
  for (const a of ARTICLES) assert.ok(articleText(a).length || a.blocks.some((b) => b.type === 'live'), a.slug);
});
