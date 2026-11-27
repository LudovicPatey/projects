// The engine of the desktop app (client/oq.py, packaged), made ready to run.
//
// macOS marks a downloaded app as quarantined. The app itself is checked once, when its user first opens it; but its engine, a
// separate program spawned in the background, stays marked, and macOS can hold it at load forever, with no window and no message.
// The app has been opened by its user, so it clears the mark on its own engine, and only on it. When the engine cannot be changed in
// place (an app installed by another account), a copy in the app's own data folder is used instead. Elsewhere nothing changes.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MARK = 'com.apple.quarantine';

/** Whether the file carries the quarantine mark (macOS only). */
function marked(file, run = spawnSync) {
  return run('xattr', ['-p', MARK, file], { stdio: 'ignore' }).status === 0;
}

/**
 * The engine to run: the packaged one, its mark cleared, or an unmarked copy in `dataDir`. On other systems, the file as it is.
 * @returns {{ file: string, how: 'as-is' | 'cleared' | 'copied' | 'marked' }} 'marked' when nothing worked: the caller explains the fix
 */
function prepareEngine(file, dataDir, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'darwin' || !marked(file, run)) return { file, how: 'as-is' };
  run('xattr', ['-d', MARK, file], { stdio: 'ignore' });
  if (!marked(file, run)) return { file, how: 'cleared' };
  try {
    const dir = path.join(dataDir, 'engine');
    const copy = path.join(dir, path.basename(file));
    fs.mkdirSync(dir, { recursive: true });
    const src = fs.statSync(file);
    const old = fs.existsSync(copy) ? fs.statSync(copy) : null;
    if (!old || old.size !== src.size || old.mtimeMs < src.mtimeMs) fs.copyFileSync(file, copy); // a new release replaces the copy
    fs.chmodSync(copy, 0o755);
    run('xattr', ['-d', MARK, copy], { stdio: 'ignore' });
    if (!marked(copy, run)) return { file: copy, how: 'copied' };
  } catch { /* falls through: the caller says what to do */ }
  return { file, how: 'marked' };
}

/** What to tell the user when the engine did not start, with the one command that fixes it on a Mac. */
function startFailure(appPath, platform = process.platform) {
  if (platform !== 'darwin') return 'The engine of the app did not start. Reinstall the app, or run the command-line client (oq.py) to see the error.';
  return 'The engine of the app did not start: macOS is still holding it as a downloaded program.\n\n'
    + 'Open Terminal and run:\n\n'
    + `xattr -dr ${MARK} "${appPath}"\n\n`
    + 'This removes the download mark from this app only. Then open the app again.';
}

module.exports = { prepareEngine, startFailure, marked };
