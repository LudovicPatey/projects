// Builds the standalone engine (no Python needed on the user's computer).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const venv = path.join('build', 'venv');
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(python)) {
  execFileSync(process.platform === 'win32' ? 'py' : 'python3', ['-m', 'venv', venv], { stdio: 'inherit' });
  execFileSync(python, ['-m', 'pip', 'install', '--quiet', 'pyinstaller==6.22.3', 'certifi'], { stdio: 'inherit' });
}
execFileSync(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--name', 'oq', '--collect-data', 'certifi', '--hidden-import', 'certifi',
  '--distpath', 'build/engine', '--workpath', 'build/work', '--specpath', 'build', path.resolve('../oq.py')], { stdio: 'inherit' });
