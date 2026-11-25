// Builds the Linux AppImage in Docker, from any computer: npm run dist:linux.
// PyInstaller cannot build the engine for another system, so it runs in a Debian 11 container (x86_64), and the AppImage
// lands in dist/ next to the other installers, where `npm run deploy -- --installers` finds it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.chdir(import.meta.dirname);
const root = path.resolve('../..');
const run = (args) => execFileSync('docker', args, { stdio: 'inherit' });
try { execFileSync('docker', ['info'], { stdio: 'ignore' }); } catch {
  console.error('Docker is not running. Start Docker Desktop (or another Docker engine), then run this again.');
  process.exit(1);
}
const tag = 'open-questions-ai-linux-build';
// Only what the build needs goes to Docker: never the configuration, databases or other builds of the repository.
const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-linux-'));
const take = (rel) => fs.cpSync(path.join(root, rel), path.join(ctx, rel), { recursive: true });
for (const rel of ['LICENSE', 'client/oq.py', 'client/desktop/package.json', 'client/desktop/package-lock.json', 'client/desktop/main.js', 'client/desktop/build-engine.mjs', 'client/desktop/assets', 'client/desktop/linux/Dockerfile']) take(rel);
try { run(['build', '--platform', 'linux/amd64', '-f', path.join(ctx, 'client/desktop/linux/Dockerfile'), '-t', tag, ctx]); }
finally { fs.rmSync(ctx, { recursive: true, force: true }); }
fs.mkdirSync('dist', { recursive: true });
fs.rmSync('dist/open-questions-ai-linux.AppImage', { force: true });
// Copied out of a stopped container: no folder of this computer is shared with Docker, which may otherwise wait for a permission.
const box = execFileSync('docker', ['create', '--platform', 'linux/amd64', tag], { encoding: 'utf8' }).trim();
try { run(['cp', `${box}:/work/client/desktop/dist/open-questions-ai-linux.AppImage`, path.resolve('dist/open-questions-ai-linux.AppImage')]); }
finally { execFileSync('docker', ['rm', box], { stdio: 'ignore' }); }
const out = path.resolve('dist/open-questions-ai-linux.AppImage');
if (!fs.existsSync(out)) { console.error('The build did not produce the AppImage.'); process.exit(1); }
fs.utimesSync(out, new Date(), new Date()); // built now, whatever time the container gave it: deploy checks it is newer than the client
console.log(`\n${out} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
