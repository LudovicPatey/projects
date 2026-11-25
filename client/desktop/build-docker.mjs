// Builds the Linux installer in Docker, from any computer: npm run dist:linux → dist/open-questions-ai-linux.AppImage
// (Debian 11, x86-64: most distributions since 2020). PyInstaller only builds the engine for the system it runs on, hence the
// container. GitHub Actions runs the same recipe (.github/workflows/installers.yml), and builds the Windows installer on Windows.
// The installer lands in dist/, next to the Mac one, where `npm run deploy -- --installers` finds it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGETS = {
  linux: { file: 'open-questions-ai-linux.AppImage', sources: ['client/oq.py', 'client/desktop/main.js', 'client/desktop/build-engine.mjs', 'client/desktop/assets', 'client/desktop/linux/Dockerfile'] },
};
const target = process.argv[2];
const t = TARGETS[target];
if (!t) { console.error(`Usage: node build-docker.mjs ${Object.keys(TARGETS).join('|')}`); process.exit(1); }

process.chdir(import.meta.dirname);
const root = path.resolve('../..');
const run = (args) => execFileSync('docker', args, { stdio: 'inherit' });
try { execFileSync('docker', ['info'], { stdio: 'ignore' }); } catch {
  console.error('Docker is not running. Start Docker Desktop (or another Docker engine), then run this again.');
  process.exit(1);
}
const tag = `open-questions-ai-${target}-build`;
// Only what the build needs goes to Docker: never the configuration, databases or other builds of the repository.
const ctx = fs.mkdtempSync(path.join(os.tmpdir(), `oq-${target}-`));
for (const rel of ['LICENSE', 'client/desktop/package.json', 'client/desktop/package-lock.json', ...t.sources]) {
  fs.cpSync(path.join(root, rel), path.join(ctx, rel), { recursive: true });
}
try { run(['build', '--platform', 'linux/amd64', '-f', path.join(ctx, `client/desktop/${target}/Dockerfile`), '-t', tag, ctx]); }
finally { fs.rmSync(ctx, { recursive: true, force: true }); }
fs.mkdirSync('dist', { recursive: true });
const out = path.resolve('dist', t.file);
fs.rmSync(out, { force: true });
// Copied out of a container that is created, never started: no folder of this computer is shared with Docker.
const box = execFileSync('docker', ['create', '--platform', 'linux/amd64', tag], { encoding: 'utf8' }).trim();
try { run(['cp', `${box}:/work/client/desktop/dist/${t.file}`, out]); }
finally { execFileSync('docker', ['rm', box], { stdio: 'ignore' }); }
if (!fs.existsSync(out)) { console.error('The build did not produce the installer.'); process.exit(1); }
fs.utimesSync(out, new Date(), new Date()); // built now, whatever time the container gave it: deploy checks it is newer than the client
console.log(`\n${out} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
