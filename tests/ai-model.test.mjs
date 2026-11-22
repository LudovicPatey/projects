// Rules of the AI work page, and integrity of the installation guides.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { filterTasks, offersAskAi, requestBody, requestError, resultLinks, suggestionLink, taskActions, taskTitle } from '../public/assets/js/ai-model.js';
import { ARTICLES } from '../public/assets/js/help/content.js';

test('a request is validated before it is sent', () => {
  assert.ok(requestError({ kind: 'x' }));
  assert.ok(requestError({ kind: 'extract' }));
  assert.ok(requestError({ kind: 'ask', prompt: '  ' }));
  assert.equal(requestError({ kind: 'bib' }), null);
  assert.deepEqual(requestBody({ kind: 'extract', document: '4', prompt: '' }), { kind: 'extract', source_type: 'document', source_id: 4 });
  assert.deepEqual(requestBody({ kind: 'derive', question: '2', prompt: ' go ' }), { kind: 'derive', prompt_text: 'go', source_type: 'question', source_id: 2 });
  assert.deepEqual(requestBody({ kind: 'bib', document: '4', question: '2' }), { kind: 'bib' });
});

test('tasks are filtered, titled and managed by the right people', () => {
  const t = [{ id: 1, status: 'pending' }, { id: 2, status: 'running' }, { id: 3, status: 'done' }, { id: 4, status: 'failed' }, { id: 5, status: 'cancelled' }];
  assert.deepEqual(filterTasks(t, 'open').map((x) => x.id), [1, 2]);
  assert.deepEqual(filterTasks(t, 'failed').map((x) => x.id), [4, 5]);
  assert.equal(taskTitle({ kind: 'extract', subject: 'Paper' }), 'Extract facts: Paper');
  assert.equal(taskTitle({ kind: 'ask', source_type: 'message' }), 'Question in a conversation');
  assert.deepEqual(taskActions({ status: 'pending', requested_by: 2 }, { me: 1, owner: false }), { cancel: false, retry: false });
  assert.deepEqual(taskActions({ status: 'failed', requested_by: 1 }, { me: 1, owner: false }), { cancel: false, retry: true });
  assert.deepEqual(taskActions({ status: 'running', requested_by: 2 }, { me: 1, owner: true }), { cancel: true, retry: false });
});

test('results and sources link to the right place', () => {
  assert.deepEqual(resultLinks({ result: { fact_ids: [7] } })[0], { label: 'Fact #7', view: 'facts', id: 7 });
  assert.equal(resultLinks({ result: { reply: { type: 'message', conversation_id: 3 } } })[0].id, 3);
  assert.equal(suggestionLink({ doi: '10.1/x' }).href, 'https://doi.org/10.1/x');
  assert.equal(suggestionLink({ arxiv: '2101.00001' }).href, 'https://arxiv.org/abs/2101.00001');
  assert.equal(suggestionLink({ url: 'javascript:alert(1)' }), null);
});

test('the @ menu offers the AI only while the text can become @AI', () => {
  for (const q of ['', 'a', 'AI']) assert.ok(offersAskAi(q));
  for (const q of ['alice', 'fact:x']) assert.ok(!offersAskAi(q));
});

test('each install guide is complete, with real images and commands to copy', () => {
  for (const [slug, tool, install] of [['ai-setup-claude', 'claude', 'claude.ai/install'], ['ai-setup-chatgpt', 'codex', 'chatgpt.com/codex/install']]) {
    const a = ARTICLES.find((x) => x.slug === slug);
    const shots = a.blocks.filter((b) => b.type === 'shot');
    const cmds = a.blocks.filter((b) => b.type === 'cmd').map((b) => b.text).join('\n');
    assert.ok(shots.length >= 5, slug);
    for (const s of shots) { assert.ok(s.alt, s.src); assert.ok(fs.existsSync(`public/assets/img/guide/${s.src}`), s.src); }
    for (const c of [install, 'oq.py setup', 'oq.py doctor', `run --provider ${tool}`, '{site}/api/client/oq.py']) assert.ok(cmds.includes(c), `${slug}: ${c}`);
    for (const os of ['macOS and Linux', 'Windows']) assert.ok(a.blocks.some((b) => b.type === 'cmd' && b.os?.startsWith(os)), `${slug}: ${os}`);
  }
});

test('the desktop shell keeps web content away from the computer', () => {
  const main = fs.readFileSync('client/desktop/main.js', 'utf8');
  for (const rule of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webviewTag: false', "'will-navigate'", 'setWindowOpenHandler', 'requestSingleInstanceLock']) assert.ok(main.includes(rule), rule);
  assert.match(main, /https:\\\/\\\//, 'only https links leave the app');
  const pkg = JSON.parse(fs.readFileSync('client/desktop/package.json', 'utf8'));
  assert.ok(pkg.build.extraResources.some((r) => r.to === 'engine'), 'the engine is bundled');
  assert.ok(!pkg.build.files.some((f) => /config|\.env/.test(f)));
});
