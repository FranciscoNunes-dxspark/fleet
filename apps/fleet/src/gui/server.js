// `fleet gui`'s web server: the window's page and its files, a stream of what the apps draw (server-sent
// events), and the window's keys and actions coming back (POSTs). It listens on the loopback address
// only, and nothing is served without the run's token: the address it prints carries it once, and the
// page keeps it as a cookie (HttpOnly, SameSite=Strict). Every POST also needs the `x-fleet: 1` header,
// which no other site's form can send, and the Host header must be the loopback address itself, so a
// page elsewhere can't reach the apps through DNS rebinding either. What the apps hold (Trawl's
// connections, Locker's secrets) is only ever on screen, as it is in a terminal.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActivity, TAKEN_BY } from '@fleet/kit/family.js';
import { completeFolder, isFolder, resolveFolder } from '../folder.js';
import { draftRunbook, listRunbooks, runbookDirs, writeDraft } from '../runbooks.js';
import { bosunHome, traceLine, traceTimeline } from '../trace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '../../gui');
const APPS = join(HERE, '../../..');

// Each space's picture in the window's rail: the app's own logo, as its README shows it.
export const LOGOS = {
  fleet: 'fleet/assets/logo.svg',
  splice: 'splice/assets/logo.svg',
  trawl: 'trawl/assets/glim.svg',
  sonar: 'sonar/assets/logo.svg',
  bosun: 'bosun/assets/logo.svg',
  hail: 'hail/assets/logo.svg',
  keel: 'keel/assets/pinch.svg',
  wharf: 'wharf/assets/logo.svg',
  locker: 'locker/assets/logo.svg',
};

export const CLIENT_FILES = ['index.html', 'style.css', 'app.js', 'keymap.js', 'sgr.js', 'boxes.js', 'views.js'];

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const typeOf = (name) => TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream';

/**
 * The window's files: { 'index.html': text, …, 'logo/splice.svg': text }. From a checkout they're read
 * from `apps/fleet/gui` and the apps' assets, so a change shows on the next reload; the compiled
 * build has no checkout, and takes them from `assets.js`, which `scripts/gui-assets.js` writes.
 */
export async function loadClient({ fromDisk = existsSync(join(CLIENT, 'index.html')) } = {}) {
  if (!fromDisk) return (await import('./assets.js')).FILES;
  const files = {};
  for (const name of CLIENT_FILES) files[name] = readFileSync(join(CLIENT, name), 'utf8');
  for (const [id, path] of Object.entries(LOGOS)) {
    try {
      files[`logo/${id}.svg`] = readFileSync(join(APPS, path), 'utf8');
    } catch {
      // A logo missing leaves the rail its letter.
    }
  }
  return files;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const cookieToken = (req) => /(?:^|;\s*)fleet=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];

/**
 * The server for `session` (a GuiSession). `files` are the window's (loadClient). Returns
 * { server, token, listen(port, host) → url, close() }.
 */
export function guiServer(session, { files, token = randomBytes(24).toString('hex'), env = process.env, maxBody = 1 << 20 } = {}) {
  let port = 0;
  // Each runbook's progress, by file, for as long as the fleet runs (every window sees the same).
  const progress = new Map();
  const clients = new Set();

  const send = (res, status, body, type = 'application/json; charset=utf-8', headers = {}) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers,
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const hostAllowed = (req) => {
    const host = String(req.headers.host ?? '');
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBody) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  const runbooks = () => listRunbooks(runbookDirs({ cwd: session.cwd, env }), { cwd: session.cwd });

  /** The window's actions, by name: each takes the POST's body and answers JSON. */
  const actions = {
    show: ({ ids }) => (session.show(ids), { ok: true }),
    resize: ({ id, columns, rows }) => (session.resize(id, Number(columns), Number(rows)), { ok: true }),
    input: ({ id, data }) => (session.input(id, data), { ok: true }),
    restart: ({ id }) => (session.restart(id), { ok: true }),
    folders: ({ text }) => {
      const typed = String(text ?? '');
      const done = completeFolder(typed, { cwd: session.cwd });
      return { text: done.text, choices: done.matches.slice(0, 50) };
    },
    move: ({ folder }) => {
      const dir = resolveFolder(String(folder ?? ''), { cwd: session.cwd });
      if (!isFolder(dir)) return { ok: false, error: `No such folder: ${dir}` };
      session.moveTo(dir);
      return { ok: true, cwd: dir };
    },
    runbooks: () => ({
      runbooks: runbooks().map((r) => ({ ...r, done: [...(progress.get(r.file) ?? [])] })),
    }),
    'runbook-step': ({ file, index }) => {
      const book = runbooks().find((r) => r.file === file);
      const step = book?.steps[Number(index)];
      if (!step) return { ok: false, error: 'That step is gone: the runbook changed on disk.' };
      session.sendLine(step.app, step.line, { from: book.title });
      const done = progress.get(file) ?? new Set();
      done.add(Number(index));
      progress.set(file, done);
      return { ok: true, done: [...done] };
    },
    'runbook-draft': () => {
      const entries = readActivity({ dir: session.family.dir, since: Date.now() - 60 * 60_000 });
      const dir = join(session.cwd, '.fleet', 'runbooks');
      const file = writeDraft(dir, draftRunbook(entries));
      return { ok: true, file };
    },
    'trace-last': () => ({ id: session.lastRequestId ?? '' }),
    trace: ({ id }) => {
      const want = String(id ?? '').trim();
      if (!want) return { ok: false, error: 'Which request?' };
      const asked = [];
      for (const app of TAKEN_BY.logline) if (session.typeInto(app, traceLine(want))) asked.push(app);
      const timeline = traceTimeline(want, { familyDir: session.family.dir, bosun: bosunHome(env), since: Date.now() - 24 * 60 * 60_000 });
      return { ok: true, asked, timeline };
    },
  };

  const server = createServer(async (req, res) => {
    if (!hostAllowed(req)) return send(res, 421, { error: 'wrong host' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const given = url.searchParams.get('t');
    const known = cookieToken(req);
    const authorised = (given && safeEqual(given, token)) || (known && safeEqual(known, token));
    if (!authorised) return send(res, 403, 'Open the address fleet gui printed: it carries the key to this window.', 'text/plain; charset=utf-8');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const cookie = `fleet=${token}; HttpOnly; SameSite=Strict; Path=/`;
      // The token leaves the address bar as soon as it's a cookie.
      if (given) return send(res, 303, '', 'text/plain', { location: '/', 'set-cookie': cookie });
      return send(res, 200, files['index.html'], typeOf('.html'), {
        'set-cookie': cookie,
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      });
    }

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      write(session.snapshot());
      const stop = session.listen(write);
      // A comment now and then keeps proxies and sleeping laptops from dropping the stream.
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      const client = { res, stop, ping };
      clients.add(client);
      req.on('close', () => {
        clearInterval(ping);
        stop();
        clients.delete(client);
      });
      return;
    }

    if (req.method === 'GET') {
      const name = path.slice(1);
      if (Object.hasOwn(files, name)) return send(res, 200, files[name], typeOf(name), { 'cache-control': 'no-cache' });
      return send(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST' && path.startsWith('/api/')) {
      if (req.headers['x-fleet'] !== '1') return send(res, 403, { error: 'missing x-fleet header' });
      const action = actions[path.slice(5)];
      if (!action) return send(res, 404, { error: 'no such action' });
      try {
        const body = await readBody(req);
        return send(res, 200, (await action(body)) ?? { ok: true });
      } catch (e) {
        return send(res, 400, { ok: false, error: e.message });
      }
    }
    send(res, 405, { error: 'not allowed' });
  });

  return {
    server,
    token,
    /** Listens on `host` (loopback) and `wanted` (0: any free port); resolves to the address with the token. */
    listen(wanted = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wanted, host, () => {
          port = server.address().port;
          resolve(`http://127.0.0.1:${port}/?t=${token}`);
        });
      });
    },
    get port() {
      return port;
    },
    close() {
      for (const c of clients) {
        clearInterval(c.ping);
        c.stop();
        c.res.end();
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
