// Runs the application on a throwaway copy with its own SQLite database, so tests never touch development data.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export async function startApp({ feedbackAdmins = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-test-'));
  for (const d of ['src', 'public', 'sql', 'bin']) fs.cpSync(d, path.join(dir, d), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'storage'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(dir, 'config/config.php'), `<?php return ['app_url' => '${base}', 'env' => 'dev', 'db' => ['dsn' => 'sqlite:' . __DIR__ . '/../storage/t.sqlite', 'user' => null, 'password' => null],
    'orcid' => ['client_id' => '', 'client_secret' => '', 'sandbox' => true], 'storage_path' => __DIR__ . '/../storage', 'max_upload_mb' => 8, 'project_creators' => [], 'feedback_admins' => ${JSON.stringify(feedbackAdmins)}];`);
  execFileSync('php', ['bin/install.php'], { cwd: dir });
  const server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', 'public', 'bin/dev-router.php'], { cwd: dir, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/me`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  const signIn = async (orcid) => {
    const r = await fetch(`${base}/auth/dev-login?orcid=${orcid}&name=U${orcid.slice(-4)}`, { redirect: 'manual' });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json();
    return { cookie, csrf: me.csrf, id: me.user.id };
  };
  const call = async (who, method, url, body) => {
    const headers = { Accept: 'application/json' };
    if (who.token) headers.Authorization = `Bearer ${who.token}`;
    else { headers.Cookie = who.cookie; if (method !== 'GET') headers['X-CSRF-Token'] = who.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, data };
  };
  const stop = () => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { signIn, call, stop };
}
