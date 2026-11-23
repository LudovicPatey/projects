// Rules of the AI work page, and integrity of the installation guides.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { filterTasks, offersAskAi, requestBody, requestError, resultLinks, suggestionLink, taskActions, taskTitle } from '../public/assets/js/ai-model.js';
import { clientCommand, detectSystem, downloadPlan, formatSize, mergeRelease } from '../public/assets/js/client-download.js';
import { ARTICLES } from '../public/assets/js/help/content.js';

test('a request is validated before it is sent', () => {
  assert.ok(requestError({ kind: 'x' }));
  assert.ok(requestError({ kind: 'extract' }));
  assert.ok(requestError({ kind: 'ask', prompt: '  ' }));
  assert.equal(requestError({ kind: 'bib' }), null);
  assert.deepEqual(requestBody({ kind: 'extract', document: '4', prompt: '' }), { kind: 'extract', source_type: 'document', source_id: 4 });
  assert.deepEqual(requestBody({ kind: 'derive', question: '2', prompt: ' go ' }), { kind: 'derive', prompt_text: 'go', source_type: 'question', source_id: 2 });
  assert.deepEqual(requestBody({ kind: 'extract', document: 'bib:7', prompt: '' }), { kind: 'extract', source_type: 'bib', source_id: 7 });
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

test('the download page detects the system and never offers a missing installer', () => {
  const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel' };
  assert.equal(detectSystem(mac), 'mac-arm64');
  assert.equal(detectSystem({ ...mac, architecture: 'x86' }), 'mac-x64');
  assert.equal(detectSystem({ ...mac, touchPoints: 5 }), 'phone', 'an iPad presents itself as a Mac');
  assert.equal(detectSystem({ userAgent: 'Windows NT 10.0', platform: 'Win32' }), 'windows');
  assert.equal(detectSystem({ userAgent: 'X11; Linux x86_64', platform: 'Linux x86_64' }), 'linux');
  assert.equal(detectSystem({ userAgent: 'Linux; Android 14', platform: 'Linux armv8' }), 'phone');
  assert.equal(detectSystem({}), 'unknown');
  const none = downloadPlan('mac-arm64', { installers: [] });
  assert.equal(none.installer, null); assert.equal(none.useScript, true);
  const one = { system: 'mac-arm64', size: 2097152 };
  const ready = downloadPlan('mac-arm64', { installers: [one] });
  assert.equal(ready.installer, one); assert.equal(ready.useScript, false);
  assert.deepEqual(downloadPlan('windows', { installers: [one] }).others, [one]);
  assert.equal(downloadPlan('phone', { installers: [] }).useScript, false);
  assert.match(clientCommand('windows', 'https://x.test'), /curl\.exe .*py oq\.py app/);
  assert.match(clientCommand('linux', 'https://x.test'), /python3 oq\.py app$/);
  assert.equal(formatSize(2097152), '2 MB');
});

test('the front page and dashboards present the client and the architecture', () => {
  const landing = fs.readFileSync('public/assets/js/views/landing.js', 'utf8');
  for (const t of ['Decentralized AI computing', 'never runs a model', '<architecture-diagram/>', 'Claude or ChatGPT']) assert.ok(landing.includes(t), t);
  const shell = fs.readFileSync('public/assets/js/main.js', 'utf8'); const misc = fs.readFileSync('public/assets/js/views/misc.js', 'utf8');
  assert.ok(shell.includes('href="#/client"')); assert.ok(misc.includes('<client-card/>'));
});

test('the interface says Prove new facts, and explains Danus only where it helps', () => {
  const client = fs.readFileSync('client/oq.py', 'utf8'); const ui = client.split("UI_HTML = r'''")[1];
  assert.ok(ui.includes('<button data-v="danus">Prove new facts</button>'));
  assert.ok(ui.includes('▶ Start proving'));
  assert.equal((ui.match(/Danus/g) || []).length, 1, 'the client names Danus once, in its explanation');
  assert.ok(ui.includes('using the open-source system Danus'));
  const article = ARTICLES.find((a) => a.slug === 'danus');
  assert.equal(article.title, 'Prove new facts');
  assert.ok(JSON.stringify(article.blocks).includes('powered by [Danus]'));
  assert.ok(!fs.readFileSync('public/assets/js/ai-model.js', 'utf8').includes('Danus'));
});

test('the download page offers a GitHub release only when it is safe and compatible', () => {
  const url = 'https://github.com/LudovicPatey/projects/releases/download/v2.0.0/open-questions-ai-mac-arm64.dmg';
  const release = { tag_name: 'v2.0.0', body: '', assets: [{ name: 'open-questions-ai-mac-arm64.dmg', size: 9, digest: 'sha256:abc', browser_download_url: url }] };
  const merged = mergeRelease({ api_level: 1, installers: [] }, release);
  assert.equal(merged.installers[0].url, url); assert.equal(merged.installers[0].version, '2.0.0'); assert.equal(merged.installers[0].sha256, 'abc');
  assert.equal(mergeRelease({ api_level: 1, installers: [] }, { ...release, body: 'requires-api: 2' }).installers.length, 0);
  assert.equal(mergeRelease({ installers: [] }, { ...release, draft: true }).installers.length, 0);
  assert.equal(mergeRelease({ installers: [] }, { ...release, prerelease: true }).installers.length, 0);
  assert.equal(mergeRelease({ installers: [] }, { ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://evil.example/x.dmg' }] }).installers.length, 0);
  const local = { system: 'mac-arm64', version: '3.0.0' };
  assert.equal(mergeRelease({ installers: [local] }, release).installers[0], local, 'a newer local installer stays');
  assert.equal(mergeRelease({ installers: [{ system: 'mac-arm64', version: '1.0.0' }] }, release).installers[0].url, url);
});
