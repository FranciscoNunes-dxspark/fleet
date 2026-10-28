// Fleet Desktop: Fleet in a window of its own. Each window runs `fleet gui --print-url` in a folder
// (the one last used, or one picked) and shows the page it serves; everything the apps do happens
// there, as in a browser window. What the desktop adds: a real application with an icon and a menu,
// the badges' count on the dock or taskbar, every key for the apps (no browser keeps ctrl+w or ctrl+t),
// and opening a folder from the menu.
//
// Which fleet: FLEET_BIN when set; in a packaged app the executable shipped beside it (resources/);
// from a checkout, apps/fleet/bin/fleet.js run by this same Electron as Node (ELECTRON_RUN_AS_NODE), so
// a checkout needs nothing installed but Electron.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { menuTemplate } from './menu.js';
import { badgeCount, stateStore } from './state.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKOUT_FLEET = join(HERE, '..', 'apps', 'fleet', 'bin', 'fleet.js');

/** How to start fleet: [file, args before "gui", extra environment]. */
function fleetCommand() {
  if (process.env.FLEET_BIN) return [process.env.FLEET_BIN, [], {}];
  const packaged = join(process.resourcesPath ?? '', process.platform === 'win32' ? 'fleet.exe' : 'fleet');
  if (app.isPackaged && existsSync(packaged)) return [packaged, [], {}];
  return [process.execPath, [CHECKOUT_FLEET], { ELECTRON_RUN_AS_NODE: '1' }];
}

/** The folder named on the command line, if any: the last argument that is one, not this app's own. */
const folderIn = (args) =>
  args
    .filter((a) => !a.startsWith('-'))
    .map((a) => resolve(a))
    .filter((a) => a !== HERE && existsSync(a))
    .at(-1);

let store;
const windows = new Set();

/** Starts a fleet in `folder` and resolves to { url, child }. */
function startFleet(folder) {
  const [file, pre, extra] = fleetCommand();
  const child = spawn(file, [...pre, 'gui', '--print-url'], {
    cwd: folder,
    env: { ...process.env, ...extra },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr = (stderr + b).slice(-4000)));
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => {
      out += b;
      const line = out.split('\n')[0];
      if (out.includes('\n') && /^http:\/\/127\.0\.0\.1:\d+\//.test(line)) resolve({ url: line.trim(), child });
    });
    child.on('exit', (code) => reject(new Error(`fleet gui ended (${code}) before it was ready.\n${stderr}`)));
    child.on('error', reject);
  });
}

/** Stops a window's fleet: its stdin ending tells it to stop every app; killed if it's still there after a while. */
function stopFleet(child) {
  if (!child || child.exitCode != null) return;
  child.stdin.end();
  setTimeout(() => {
    if (child.exitCode == null) child.kill();
  }, 5000).unref();
}

async function openWindow(folder) {
  const saved = store.read();
  const bounds = saved.bounds ?? { width: 1400, height: 900 };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 420,
    title: 'Fleet',
    backgroundColor: '#0f1116',
    icon: join(HERE, '..', 'apps', 'fleet', 'assets', 'logo.png'),
    autoHideMenuBar: process.platform !== 'darwin',
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(HERE, 'preload.cjs') },
  });
  windows.add(win);
  let fleet = null;
  try {
    fleet = await startFleet(folder);
  } catch (e) {
    windows.delete(win);
    win.destroy();
    dialog.showErrorBox("Fleet couldn't start", e.message);
    return null;
  }
  win.fleet = fleet;
  win.folder = folder;
  store.write({ folder });
  const origin = new URL(fleet.url).origin;
  // The page stays on its own address; links elsewhere open in the browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Notifications are the page's to show: allow them, and nothing else it might ask for.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'notifications' || permission === 'clipboard-sanitized-write'));
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(title.replace(/^\(\d+\) /, ''));
    const count = [...windows].reduce((n, w) => n + badgeCount(w === win ? title : w.webContents.getTitle()), 0);
    app.setBadgeCount?.(count);
    if (badgeCount(title) && !win.isFocused()) win.flashFrame(true);
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('close', () => {
    if (!win.isMaximized() && !win.isFullScreen()) store.write({ bounds: win.getBounds() });
  });
  win.on('closed', () => {
    windows.delete(win);
    stopFleet(fleet.child);
  });
  win.once('ready-to-show', () => win.show());
  await win.loadURL(fleet.url);
  return win;
}

const focused = () => BrowserWindow.getFocusedWindow() ?? [...windows][0];
const command = (name, arg) => focused()?.webContents.send('fleet:command', { name, arg });

async function pickFolder({ newWindow = false } = {}) {
  const win = focused();
  const r = await dialog.showOpenDialog(win, { title: newWindow ? 'Open the fleet in…' : 'Move the fleet to…', properties: ['openDirectory'], defaultPath: win?.folder ?? store.read().folder ?? homedir() });
  if (r.canceled || !r.filePaths[0]) return;
  if (newWindow || !win) openWindow(r.filePaths[0]);
  else command('move', r.filePaths[0]);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const folder = folderIn(argv.slice(1));
    if (folder) openWindow(folder);
    else focused()?.focus();
  });
  app.whenReady().then(async () => {
    store = stateStore(app.getPath('userData'));
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ command, openFolder: () => pickFolder(), newWindow: () => pickFolder({ newWindow: true }) })));
    const given = folderIn(process.argv.slice(1));
    const saved = store.read().folder;
    const win = await openWindow(given ?? (saved && existsSync(saved) ? saved : homedir()));
    // FLEET_DESKTOP_SMOKE=<file.png>: a picture of the first window once it has drawn, then quit (the tests).
    if (process.env.FLEET_DESKTOP_SMOKE && win) {
      setTimeout(async () => {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(process.env.FLEET_DESKTOP_SMOKE, (await win.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.FLEET_DESKTOP_SMOKE_MS ?? 5000));
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => {
    if (!windows.size) openWindow(store.read().folder ?? homedir());
  });
  app.on('before-quit', () => {
    for (const w of windows) stopFleet(w.fleet?.child);
  });
}
