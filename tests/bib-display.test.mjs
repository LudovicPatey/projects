// AI labels keep their compact style, and suggested author lists become valid BibTeX.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { startApp } from './harness.mjs';

const ANN = '0000-0002-1825-0097'; const BOB = '0000-0001-5109-3700';
let app; let ann; let bob; let annKey; let pid; let n = 0;

const accept = async (authors) => {
  n += 1;
  const url = `/api/projects/${pid}/ai/suggestions`;
  const r = (await app.call(annKey, 'POST', url, { suggestions: [{ title: `Paper number ${n}`, authors, year: '1987', venue: 'Annals', doi: `10.1234/display.${n}`, reason_text: 'Close.' }], ai_model: 'm' })).data;
  const id = (await app.call(bob, 'POST', `/api/bib-suggestions/${r.created[0]}/accept`, {})).data.bib_id;
  return (await app.call(ann, 'GET', `/api/projects/${pid}/bib`)).data.entries.find((e) => e.id === id);
};

before(async () => {
  app = await startApp();
  ann = await app.signIn(ANN); bob = await app.signIn(BOB);
  pid = (await app.call(ann, 'POST', '/api/projects', { title: 'Display', question_html: '<p>Q</p>' })).data.id;
  assert.ok((await app.call(ann, 'POST', `/api/projects/${pid}/members`, { orcid: BOB })).status < 300);
  annKey = { token: (await app.call(ann, 'POST', '/api/me/keys', { name: 'k' })).data.token };
});
after(() => app?.stop());

test('no other style turns the AI label into a block', () => {
  const css = fs.readFileSync('public/assets/css/app.css', 'utf8');
  const rules = [...css.matchAll(/(?:^|\n)\s*\.ai-meta\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(rules.length, 1);
  assert.match(rules[0], /display:\s*inline-flex/);
  assert.doesNotMatch(css, /\.ai-meta\s+d[td]\b/);
  assert.match(fs.readFileSync('public/assets/js/views/ai.js', 'utf8'), /<dl class="ai-task-meta">/);
});

test('suggested authors are separated, and the citation key uses the first author', async () => {
  const e = await accept('Stephen G. Simpson, Andreas R. Blass, Jeffry L. Hirst');
  assert.equal(e.authors, 'Stephen G. Simpson, Andreas R. Blass, Jeffry L. Hirst');
  assert.match(e.cite_key, /^simpson1987/);
});

test('the usual ways of writing authors are understood', async () => {
  assert.equal((await accept('Doe, Jane')).authors, 'Jane Doe');
  assert.equal((await accept('Doe, J. and Roe, R.')).authors, 'J. Doe, R. Roe');
  assert.equal((await accept('Jane Doe, Rob Roe, and Ann Poe')).authors, 'Jane Doe, Rob Roe, Ann Poe');
  assert.equal((await accept('Jane Doe; Rob Roe')).authors, 'Jane Doe, Rob Roe');
  assert.equal((await accept('Jane Doe')).authors, 'Jane Doe');
});

test('a reference is shown by its title, and can still be found by its key', async () => {
  const e = await accept('Jane Doe');
  const resolved = (await app.call(ann, 'GET', `/api/projects/${pid}/refs/resolve?keys=bib:${e.id}`)).data.refs[`bib:${e.id}`];
  assert.equal(resolved.label, e.title);
  assert.ok(resolved.subtitle.startsWith(e.cite_key));
  const found = (await app.call(ann, 'GET', `/api/projects/${pid}/refs?q=${encodeURIComponent(e.cite_key)}&type=bib`)).data.results;
  assert.ok(found.some((x) => x.id === e.id && x.label === e.title));
  const feed = (await app.call(ann, 'GET', `/api/projects/${pid}/activity?section=bib`)).data.activity;
  assert.ok(feed.some((x) => x.ref.id === e.id && x.ref.label === e.title));
  const c = (await app.call(ann, 'POST', `/api/projects/${pid}/conversations`, { subject: 'Citing', participant_ids: [], body_text: `See @{bib:${e.cite_key}}.` })).data;
  const text = JSON.stringify((await app.call(ann, 'GET', `/api/conversations/${c.id}`)).data);
  assert.ok(text.includes(`data-label=\\"${e.title}\\"`), 'a typed reference stores the title');
});
