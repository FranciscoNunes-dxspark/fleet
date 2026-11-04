// Finding a Chrome on the machine (Chrome, Edge, Chromium; or the path in the settings) and starting it
// headless with its DevTools socket on a free port. Lantern bundles no browser: without one it says so
// and runs the checks that need none.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Where each platform keeps the browsers Lantern can drive, most likely first. */
export function chromeCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((r) => [join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(r, 'Chromium', 'Application', 'chrome.exe')]);
  }
  if (platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Chromium.app/Contents/MacOS/Chromium', 'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'];
    return [...apps.map((a) => join('/Applications', a)), ...apps.map((a) => join(homedir(), 'Applications', a))];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean);
  return [...dirs.flatMap((d) => names.map((n) => join(d, n))), '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge'];
}

/**
 * The browser to drive: `override` (the settings' chrome, or LANTERN_CHROME) when given and there, else
 * the first candidate there; null when there's none.
 */
export function findChrome({ override, env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const wanted = override || env.LANTERN_CHROME;
  if (wanted) return exists(wanted) ? wanted : null;
  return chromeCandidates({ platform, env }).find((p) => exists(p)) ?? null;
}

/** The flags Chrome starts with: headless, its DevTools on a port the system picks, a profile of its own, nothing extra. */
export function chromeArgs(profile, { root = typeof process.getuid === 'function' && process.getuid() === 0 } = {}) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-update',
    '--mute-audio',
    '--hide-scrollbars',
    // Chrome refuses to run as root without it (a container, CI).
    ...(root ? ['--no-sandbox'] : []),
    'about:blank',
  ];
}

/**
 * Starts `path` headless and resolves { wsUrl, close } once it says where its DevTools socket is.
 * `close` stops it and removes its profile.
 */
export function launchChrome(path, { spawnImpl = spawn, timeout = 20_000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'lantern-chrome-'));
  const child = spawnImpl(path, chromeArgs(profile), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const cleanup = () => {
    try {
      child.kill();
    } catch {
      // Gone already.
    }
    // Chrome lets go of its profile a moment after it exits (on Windows especially).
    setTimeout(() => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), 300).unref?.();
  };
  return new Promise((resolve, reject) => {
    let said = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${path} didn't open its DevTools socket within ${timeout / 1000} s`));
    }, timeout);
    child.stderr.on('data', (chunk) => {
      said += chunk.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(said);
      if (m) {
        clearTimeout(timer);
        resolve({ wsUrl: m[1], close: cleanup });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`Couldn't start ${path}: ${e.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${path} stopped (${code}) before opening its DevTools socket: ${said.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}
