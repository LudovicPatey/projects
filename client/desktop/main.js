// Desktop shell: a window and a menu-bar icon around the same engine as the command line (client/oq.py).
const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let win = null; let tray = null; let engine = null; let pageUrl = null; let quitting = false;

function engineCommand() {
  const packaged = path.join(process.resourcesPath || '', 'engine', process.platform === 'win32' ? 'oq.exe' : 'oq');
  if (app.isPackaged && fs.existsSync(packaged)) return [packaged, ['app', '--no-open']];
  const script = path.join(__dirname, '..', 'oq.py');
  const python = ['python3', 'py', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
  if (!python) throw new Error('The engine of the app is missing.');
  return [python, [script, 'app', '--no-open']];
}

function startEngine() {
  return new Promise((resolve, reject) => {
    const [cmd, args] = engineCommand();
    engine = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => reject(new Error('The engine did not start.')), 20000);
    engine.stdout.on('data', (d) => {
      const m = String(d).match(/OQ_APP_URL=(http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    engine.on('error', reject);
    engine.on('exit', () => { engine = null; if (!quitting) app.quit(); });
  });
}

function showWindow() {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1040, height: 760, minWidth: 420, minHeight: 520, title: 'Open Questions AI', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  const origin = new URL(pageUrl).origin;
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) e.preventDefault(); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } }); // keeps working from the menu-bar icon
  win.on('closed', () => { win = null; });
  win.loadURL(pageUrl);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Open Questions AI');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: showWindow },
    { type: 'separator' },
    { label: 'Quit (stops AI work)', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    try {
      pageUrl = await startEngine();
      createTray();
      showWindow();
    } catch (e) {
      const { dialog } = require('electron');
      dialog.showErrorBox('Open Questions AI', e.message);
      quitting = true; app.quit();
    }
  });
  app.on('activate', () => { if (pageUrl) showWindow(); });
  app.on('window-all-closed', () => { /* it stays in the menu bar */ });
  app.on('before-quit', () => { quitting = true; engine?.kill(); });
}
