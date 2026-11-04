// `pilot shot <page>`: a screenshot of a page of the running site, taken with a Chrome or Edge
// already on the machine (driven over the DevTools protocol: nothing bundled, nothing downloaded),
// kept as the page's `before` the first time and `after` from then on, and compared: the share of
// the page that changed, the changed regions and a diff image. Shots live in <project>/.pilot/shots.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { decodePng, diffImages, encodePng } from './png.js';
import { resolveTarget, urlOf } from './queries.js';

export const SHOTS_DIR = '.pilot/shots';

/** Where Chrome, Chromium or Edge is: PILOT_CHROME, else the usual places for this system. */
export function findChrome(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.PILOT_CHROME) return env.PILOT_CHROME;
  const candidates = [];
  if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(base, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) candidates.push(join(dir, name));
    candidates.push('/opt/google/chrome/chrome');
    try {
      // Playwright's own browsers, where they're installed.
      for (const d of readdirSync('/opt/pw-browsers')) if (/^chromium/.test(d)) candidates.push(join('/opt/pw-browsers', d, 'chrome-linux', 'chrome'));
    } catch {
      // Not there.
    }
  }
  return candidates.find((c) => exists(c)) ?? null;
}

/** A page's URL path: a path as given, else the action's URL (which mustn't need a parameter). */
export function pagePath(idx, target) {
  const t = String(target ?? '').trim();
  if (/^https?:\/\//i.test(t)) return { url: t };
  if (t.startsWith('/')) return { path: t };
  const r = resolveTarget(idx, t);
  const action = r.actions[0] ?? (r.files[0] && idx.in(r.files[0]).find((e) => e.kind === 'renders')?.from);
  const url = action && urlOf(idx, action);
  if (!url) return { error: `"${t}" isn't a page Pilot knows: give its path, like /Orders/Edit/5.` };
  if (/[{[]/.test(url)) return { error: `${url} needs a value: give the page's path, like ${url.replace(/\{[^}]*\}/g, '1')}.` };
  return { path: url };
}

/** The folder a page's shots go in, from its path: /Orders/Edit/5 → orders-edit-5. */
export const slugOf = (path) => (String(path).replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home');

/** A browser started headless, and a way to talk to one page in it over the DevTools protocol. */
async function openBrowser(chrome, { timeout = 20000 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'pilot-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--disable-extensions'];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  const proc = spawn(chrome, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((ok, fail) => {
    let err = '';
    const timer = setTimeout(() => fail(new Error(`${chrome} didn't start in time.`)), timeout);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        ok(m[1]);
      }
    });
    proc.on('error', (e) => fail(e));
    proc.on('exit', (code) => fail(new Error(`${chrome} stopped (${code}): ${err.slice(-300)}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => fail(new Error('Couldn\'t connect to the browser.')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    } else for (const l of listeners) l(msg);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const n = ++id;
      pending.set(n, { ok, fail });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const close = () => {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    proc.kill();
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500).unref();
  };
  return { send, on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn), close };
}

/**
 * A full-page PNG of `url` at `width` (and a phone's viewport with `mobile`). `cookies` are
 * "name=value" pairs set for the site first (a signed-in session), `headers` extra request headers.
 */
export async function capture(url, { chrome = findChrome(), width = 1280, height = 900, mobile = false, cookies = [], headers = {}, settle = 600, timeout = 30000 } = {}) {
  if (!chrome) throw Object.assign(new Error('No Chrome, Chromium or Edge found: install one, or set PILOT_CHROME to its path.'), { usage: true });
  const b = await openBrowser(chrome);
  try {
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => b.send(m, p, sessionId);
    await s('Page.enable');
    await s('Network.enable');
    const w = mobile ? 390 : width;
    await s('Emulation.setDeviceMetricsOverride', { width: w, height: mobile ? 844 : height, deviceScaleFactor: 1, mobile });
    if (Object.keys(headers).length) await s('Network.setExtraHTTPHeaders', { headers });
    for (const c of cookies) {
      const [name, ...rest] = c.split('=');
      await s('Network.setCookie', { name: name.trim(), value: rest.join('=').trim(), url });
    }
    const loaded = new Promise((ok) => {
      const fn = (msg) => {
        if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
          b.off(fn);
          ok();
        }
      };
      b.on(fn);
    });
    const nav = await s('Page.navigate', { url });
    if (nav.errorText) throw new Error(`Couldn't open ${url}: ${nav.errorText}. Is the site running?`);
    await Promise.race([loaded, new Promise((_, fail) => setTimeout(() => fail(new Error(`${url} didn't finish loading in ${timeout / 1000} s.`)), timeout))]);
    // Let scripts draw (grids, charts) and fonts arrive before the picture.
    await new Promise((ok) => setTimeout(ok, settle));
    const metrics = await s('Page.getLayoutMetrics');
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const full = Math.min(12000, Math.ceil(size.height));
    const shot = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: full, scale: 1 } });
    const { result } = await s('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    return { png: Buffer.from(shot.data, 'base64'), width: w, height: full, title: result?.value ?? '' };
  } finally {
    b.close();
  }
}

/** The base URL of the running site: given, else PILOT_URL, else the one remembered in .pilot/config.json. */
export function baseUrl(root, given = null, env = process.env) {
  const file = join(root, '.pilot', 'config.json');
  let config = {};
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // None yet.
  }
  const url = given ?? env.PILOT_URL ?? config.url ?? null;
  if (given && given !== config.url) {
    mkdirSync(join(root, '.pilot'), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...config, url: given }, null, 2)}\n`);
    // The shots and config are this machine's: keep them out of git.
    const ignore = join(root, '.pilot', '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  }
  return url?.replace(/\/+$/, '') ?? null;
}

/** The shots kept for a page: [{ name, label, width, file, bytes, at }]. */
export function listShots(root, slug) {
  const dir = join(root, SHOTS_DIR, slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^(before|after|diff)-(\d+|mobile)\.png$/.test(f))
    .map((f) => {
      const [, label, width] = /^(\w+)-(\w+)\.png$/.exec(f);
      const st = statSync(join(dir, f));
      return { name: f, label, width, file: join(SHOTS_DIR, slug, f).replace(/\\/g, '/'), bytes: st.size, at: st.mtime.toISOString() };
    });
}

/** Compares a page's before and after at one width, writes the diff image; null without both. */
export function compareShots(root, slug, width) {
  const dir = join(root, SHOTS_DIR, slug);
  const before = join(dir, `before-${width}.png`);
  const after = join(dir, `after-${width}.png`);
  if (!existsSync(before) || !existsSync(after)) return null;
  const d = diffImages(decodePng(readFileSync(before)), decodePng(readFileSync(after)));
  writeFileSync(join(dir, `diff-${width}.png`), encodePng(d.image));
  return { width, changed: d.changed, share: d.share, boxes: d.boxes.slice(0, 12), size: [d.width, d.height], diff: join(SHOTS_DIR, slug, `diff-${width}.png`).replace(/\\/g, '/') };
}

/**
 * `pilot shot`: takes the page at each width, as `as` ('before' or 'after'; by default before the
 * first time and after from then on), and compares when both are there.
 */
export async function shot(idx, target, { url = null, widths = [1280], as = null, cookies = [], headers = {}, capture: take = capture } = {}) {
  const p = pagePath(idx, target);
  if (p.error) return { data: { error: p.error }, text: p.error };
  let full = p.url;
  if (!full) {
    const base = baseUrl(idx.root, url);
    if (!base) return { data: { error: 'no url' }, text: 'Where does the site run? Give it once: pilot shot /Orders --url http://localhost:5000 (it\'s remembered), or set PILOT_URL.' };
    full = `${base}${p.path}`;
  }
  const slug = slugOf(full);
  const dir = join(idx.root, SHOTS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  const ignore = join(idx.root, '.pilot', '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const results = [];
  for (const w of widths) {
    const key = w === 'mobile' ? 'mobile' : String(w);
    const label = as ?? (existsSync(join(dir, `before-${key}.png`)) ? 'after' : 'before');
    const s = await take(full, { width: w === 'mobile' ? 390 : Number(w), mobile: w === 'mobile', cookies, headers });
    const file = join(dir, `${label}-${key}.png`);
    writeFileSync(file, s.png);
    results.push({ width: key, label, file: join(SHOTS_DIR, slug, `${label}-${key}.png`).replace(/\\/g, '/'), size: [s.width, s.height], title: s.title, compare: label === 'after' ? compareShots(idx.root, slug, key) : null });
  }
  const lines = [`${full}${results[0]?.title ? `  "${results[0].title}"` : ''}`];
  for (const r of results) {
    lines.push(`  ${r.label} at ${r.width}: ${r.file} (${r.size.join('×')})`);
    if (r.compare) {
      const c = r.compare;
      lines.push(c.changed ? `    ${(c.share * 100).toFixed(2)}% of the page changed; diff: ${c.diff}` : '    nothing changed');
      for (const bx of c.boxes.slice(0, 6)) lines.push(`    changed around x ${bx.x}–${bx.x + bx.width}, y ${bx.y}–${bx.y + bx.height}`);
    }
  }
  if (results.every((r) => r.label === 'before')) lines.push('', 'That\'s the page before the change. Take it again after changing it to compare (or --as before to replace the baseline).');
  lines.push('Read the PNG files to see them.');
  return { data: { url: full, slug, shots: results }, text: lines.join('\n') };
}
