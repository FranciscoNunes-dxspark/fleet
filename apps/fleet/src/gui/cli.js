// `fleet gui [app…] [--port <n>] [--no-open] [--print-url]`: the fleet in a window rather than the
// terminal. It starts the server on the loopback address, prints the address (with the run's key in
// it), and opens it: in a Chromium-family browser's app mode when one is installed (a window of its
// own, without tabs or an address bar, where the apps get ctrl+w and ctrl+t too), else in the default
// browser. Fleet Desktop (desktop/) runs it with --print-url and opens the address itself. ctrl+c, or
// closing the terminal, stops every app.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { COMPILED } from '../app.js';
import { appSpawner } from '../launch.js';
import { SPACES, spaceNamed } from '../spaces.js';
import { GuiSession } from './session.js';
import { DEFAULT_PREFIX, prefixByte, prefixName } from '../keys.js';
import { loadState, saveState } from '../state.js';
import { guiServer, loadClient } from './server.js';

export const GUI_USAGE = `fleet gui [--port <n>] [--no-open] [--print-url] [app [its arguments…]]

  The fleet in a window: every app as in the terminal, drawn in a browser window (an app window of
  Chrome, Edge or Chromium when one is installed) with Fleet's tools around them. It listens on
  127.0.0.1 only, and the address it prints carries the key to it.

  app          the app to show first (Splice by default); what follows it is that app's own
               arguments (fleet gui sonar --demo)
  --port <n>   the port (a free one by default)
  --no-open    print the address, don't open it
  --print-url  print only the address, as one line (for Fleet Desktop)`;

export function parseGuiArgs(argv) {
  const out = { port: 0, open: true, printUrl: false, first: null, args: {}, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]) || 0;
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7)) || 0;
    else if (a === '--no-open') out.open = false;
    else if (a === '--print-url') {
      out.printUrl = true;
      out.open = false;
    } else if (a === '-h' || a === '--help') out.help = true;
    else if (spaceNamed(a)) {
      out.first = spaceNamed(a).id;
      out.args = { [out.first]: argv.slice(i + 1) };
      break;
    }
    else throw new Error(`fleet gui: what's ${a}? (fleet gui --help)`);
  }
  return out;
}

// Chromium-family browsers whose --app opens a window of its own, by platform.
const APP_BROWSERS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  win32: [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/snap/bin/chromium'],
};

/** Opens `url`: an app window of a Chromium-family browser when there is one, else the default browser. */
export function openWindow(url, { platform = process.platform, exists = existsSync, run = spawn } = {}) {
  const browser = (APP_BROWSERS[platform] ?? []).find((p) => p && exists(p));
  const detach = (file, args) => {
    try {
      run(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    } catch {
      return false;
    }
  };
  if (browser && detach(browser, [`--app=${url}`, '--window-size=1400,900'])) return 'app';
  if (platform === 'darwin') return detach('open', [url]) && 'browser';
  if (platform === 'win32') return detach('cmd', ['/c', 'start', '""', url]) && 'browser';
  return detach('xdg-open', [url]) && 'browser';
}

/** Runs `fleet gui` with `argv` (what follows "gui"). */
export async function runGui(argv, { env = process.env, out = process.stdout } = {}) {
  let opts;
  try {
    opts = parseGuiArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    out.write(`${GUI_USAGE}\n`);
    return;
  }
  // Nothing in a window is a terminal's, so the apps get full colour whatever this terminal has.
  // host.json: the prefix (FLEET_PREFIX first) and the folders moved to lately, as the terminal's host has them.
  const state = loadState(env);
  const prefixWanted = env.FLEET_PREFIX || state.prefix;
  const prefix = prefixName(prefixByte(prefixWanted ?? DEFAULT_PREFIX) ?? prefixByte(DEFAULT_PREFIX));
  const folders = Array.isArray(state.folders) ? state.folders.filter((f) => typeof f === 'string') : [];
  const session = new GuiSession({ spawn: appSpawner({ compiled: COMPILED, depth: 24, env: { ...env, FLEET_GUI: '1' } }), spaces: SPACES, args: opts.args, prefix, folders, onFolders: (list) => saveState({ folders: list }, env) });
  session.start();
  const server = guiServer(session, { files: await loadClient(), env });
  const url = await server.listen(opts.port);
  if (opts.first) session.show([opts.first]);
  if (opts.printUrl) out.write(`${url}\n`);
  else {
    out.write(`Fleet is at ${url}\n(ctrl+c here stops every app)\n`);
    if (opts.open) {
      const how = openWindow(url);
      if (!how) out.write("Couldn't open a browser: open the address above yourself.\n");
    }
  }
  let ending = false;
  const end = async () => {
    if (ending) return;
    ending = true;
    session.stop();
    await server.close();
    // Apps that ignore their control pipe ending are killed after a grace period; wait for that.
    setTimeout(() => process.exit(0), 3200).unref();
  };
  process.on('SIGINT', end);
  process.on('SIGTERM', end);
  process.on('SIGHUP', end);
  // Fleet Desktop ends us by closing our stdin.
  if (opts.printUrl) process.stdin.on('end', end).resume();
}
