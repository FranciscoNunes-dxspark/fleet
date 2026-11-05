// `pilot ui`: the web UI, served by Pilot itself on 127.0.0.1. The page (page.js) is one HTML file
// with its styles and script inline, so it needs no build and no network, and is part of the
// executable; it reads everything through the JSON API below, over the same queries the CLI runs.
// The index is kept and refreshed before a request when it's older than two seconds, so edits show
// up on the next click.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { COMPILED, VERSION } from '../app.js';
import { homedir } from 'node:os';
import { buildIndex } from '../index.js';
import { file, find, overview, problems, resolveTarget, selector, urlOf, actionLabel, where } from '../queries.js';
import { complexity, graph, nodeInfo, pageModel, path, split, stylesheets, widgets } from '../analysis.js';
import { pageHtml } from './page.js';
import { changes } from '../changes.js';
import { context } from '../context.js';
import { cascade } from '../cascade.js';
import { a11y, deadCode, design, repeats, weight } from '../audit.js';
import { diagram } from '../diagram.js';
import { SHOTS_DIR, baseUrl, listShots, pagePath, shot, slugOf } from '../shots.js';
import { doctor, images, models, styleguide, texts } from '../insight.js';
import { coverage, inspect, responsive, shots as shotSet } from '../live.js';
import { extractPartial, splitApply } from '../refactor.js';
import { rename } from '../rename.js';
import { report } from '../report.js';
import { installHook } from '../hook.js';
import { mcpServer, writeMcpJson } from '../cli.js';
import { SKILL } from '../skill.js';
import { kindOf } from '../walk.js';

/** The page model, made fit to send: the tree as it is, without the index's Maps. */
function pageData(idx, target) {
  const r = resolveTarget(idx, target);
  let actions = r.actions;
  let views;
  if (r.files.length && idx.files.get(r.files[0])?.kind === 'view') {
    views = [r.files[0]];
    actions = idx.in(views[0]).filter((e) => e.kind === 'renders' || e.kind === 'renders-partial').map((e) => e.from);
  } else if (actions.length) views = [...new Set(actions.flatMap((id) => idx.out(id).filter((e) => e.kind.startsWith('renders')).map((e) => e.to)))];
  else return { error: r.candidates.length ? 'ambiguous' : 'not found', candidates: r.candidates };
  return {
    actions: actions.map((id) => ({ id, label: actionLabel(idx, id), url: urlOf(idx, id), at: where(idx, id), redirects: idx.nodes.get(id)?.action.redirects ?? [], json: !!idx.nodes.get(id)?.action.json })),
    views: views.map((v) => {
      const m = pageModel(idx, v);
      const d = idx.files.get(v)?.data;
      return {
        view: v,
        model: d?.model?.type ?? null,
        title: d?.title ?? null,
        layouts: m.tree.chain,
        root: m.tree.root,
        warnings: m.tree.warnings,
        assets: m.tree.assets,
        scripts: m.scripts,
        calls: m.calls,
        widgets: m.widgets,
        metrics: m.metrics,
        classes: [...new Set(m.views.filter((x) => x.own).flatMap((x) => (idx.files.get(x.file)?.data?.classes ?? []).map(([c]) => `.${c}`)))].sort(),
        ids: [...new Set(m.views.filter((x) => x.own).flatMap((x) => (idx.files.get(x.file)?.data?.ids ?? []).map(([i]) => `#${i}`)))].sort(),
        dynamic: [...m.tree.files.keys()].flatMap((f) => (idx.files.get(f)?.data?.dynamic ?? []).map((x) => ({ file: f, ...x }))),
      };
    }),
  };
}

/** One node with its edges both ways, for the UI's side panel. */
function nodeData(idx, id) {
  if (!idx.nodes.has(id) && !idx.files.has(id)) {
    const r = resolveTarget(idx, id);
    id = r.actions[0] ?? r.files[0];
    if (!id) return { error: 'not found' };
  }
  const edge = (e, other) => ({ ...nodeInfo(idx, other), kind: e.kind, line: e.line, from: e.from, method: e.method ?? null, url: e.url ?? null, target: e.target ?? null, how: e.how ?? null });
  return {
    ...nodeInfo(idx, id),
    out: idx.out(id).filter((e) => e.to).map((e) => edge(e, e.to)),
    in: idx.in(id).map((e) => edge(e, e.from)),
    text: idx.files.has(id) ? file(idx, id).text : null,
  };
}

/** Lines of a file the index knows, around `line`. Nothing outside the project is ever read. */
function source(idx, rel, line, context = 14) {
  const f = idx.files.get(rel) ?? idx.file(rel);
  if (!f) return { error: 'not a file of the project' };
  const all = readFileSync(join(idx.root, f.rel), 'utf8').split('\n');
  const center = Math.max(1, Math.min(line || 1, all.length));
  const whole = context === 'all' || all.length <= 400;
  const start = whole ? 1 : Math.max(1, center - context);
  const end = whole ? all.length : Math.min(all.length, center + context);
  return { file: f.rel, line: line || null, start, lines: all.slice(start - 1, end), total: all.length };
}

/** Whether the project is set up for Claude Code: the skill, and Pilot in its .mcp.json. */
export function claudeSetup(root) {
  let mcp = false;
  try {
    mcp = !!JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))?.mcpServers?.pilot;
  } catch {
    // No .mcp.json, or not JSON: not set up there.
  }
  let hook = false;
  try {
    hook = JSON.stringify(JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).hooks?.PostToolUse ?? []).includes(' hook');
  } catch {
    // No settings: no hook.
  }
  return { root, skill: existsSync(join(root, '.claude', 'skills', 'pilot', 'SKILL.md')), mcp, hook };
}

/** The API's routes: path → (index, query params) → JSON. */
export function routes() {
  return {
    '/api/overview': (idx) => overview(idx).data,
    '/api/claude': (idx) => claudeSetup(idx.root),
    '/api/changes': (idx, q) => {
      try {
        return changes(idx, { base: q.get('base') || null }).data;
      } catch (e) {
        return { error: e.message };
      }
    },
    '/api/audit': (idx, q) => ({ dead: deadCode, design, repeats, a11y, weight, images, texts, models }[q.get('kind')]?.(idx)?.data ?? { error: 'unknown audit' }),
    '/api/site': (idx) => ({ url: baseUrl(idx.root) }),
    '/api/doctor': (idx) => ({ ...doctor(idx).data, ...problems(idx, { limit: 100000 }).data }),
    '/api/styleguide': (idx) => styleguide(idx).data,
    '/api/cascade': (idx, q) => cascade(idx, q.get('page') ?? '', q.get('selector') ?? '').data,
    '/api/context': (idx, q) => {
      const r = context(idx, q.get('target') ?? '', { budget: Number(q.get('budget')) || 60000 });
      return { ...r.data, text: r.text };
    },
    '/api/diagram': (idx, q) => diagram(idx, q.get('target') ?? '', { to: q.get('to') || null, depth: Number(q.get('depth')) || 1, format: q.get('format') === 'dot' ? 'dot' : 'mermaid' }).data,
    '/api/shots': (idx, q) => {
      const p = pagePath(idx, q.get('page') ?? '');
      const base = baseUrl(idx.root);
      if (p.error) return { error: p.error, url: base };
      const slug = slugOf(p.url ?? `${base ?? ''}${p.path}`);
      return { slug, url: base, path: p.path ?? p.url, shots: listShots(idx.root, slug) };
    },
    '/api/pages': (idx, q) => complexity(idx, { filter: q.get('filter') ?? '', limit: 100000 }).data,
    '/api/page': (idx, q) => pageData(idx, q.get('target') ?? ''),
    '/api/graph': (idx, q) => graph(idx, q.get('focus') ?? '', { depth: Number(q.get('depth')) || 2, kinds: q.get('kinds') ? q.get('kinds').split(',') : null, max: Number(q.get('max')) || 250, vendor: q.get('vendor') === '1' }).data,
    '/api/node': (idx, q) => nodeData(idx, q.get('id') ?? ''),
    '/api/selector': (idx, q) => selector(idx, q.get('q') ?? '', { vendor: q.get('vendor') === '1', snippets: false }).data,
    '/api/widgets': (idx, q) => widgets(idx, { kind: q.get('kind') ?? '' }).data,
    '/api/stylesheets': (idx) => stylesheets(idx).data,
    '/api/split': (idx, q) => split(idx, q.get('file') ?? '').data,
    '/api/find': (idx, q) => find(idx, q.get('q') ?? '', { limit: 30 }).data,
    '/api/path': (idx, q) => path(idx, q.get('from') ?? '', q.get('to') ?? '').data,
    '/api/problems': (idx) => problems(idx, { limit: 100000 }).data,
    '/api/source': (idx, q) => source(idx, q.get('file') ?? '', Number(q.get('line')) || 0, q.get('all') === '1' ? 'all' : 14),
  };
}

/** The request handler over an index getter; `port` for the Host check. */
/** The actions the UI can take: name → (index, body) → { data, text }. Those that write refresh the index after. */
export const ACTIONS = {
  rename: async (idx, b, { refresh }) => {
    const r = rename(idx, String(b.from ?? ''), String(b.to ?? ''), { apply: b.apply === true });
    if (b.apply === true) refresh();
    return r;
  },
  split: async (idx, b, { refresh }) => {
    const r = splitApply(idx, String(b.file ?? ''), { apply: b.apply === true, force: b.force === true });
    if (r.data.applied) refresh();
    return r;
  },
  extract: async (idx, b, { refresh }) => {
    const r = extractPartial(idx, Number(b.n) || 1, { name: b.name || null, apply: b.apply === true, force: b.force === true });
    if (r.data.applied) refresh();
    return r;
  },
  shots: async (idx, b) => shotSet(idx, Array.isArray(b.pages) ? b.pages : b.which === 'all' ? 'all' : 'changed', { url: b.url || null, widths: Array.isArray(b.widths) && b.widths.length ? b.widths : [1280], threshold: b.threshold ?? null, base: b.base || null }),
  inspect: async (idx, b) => inspect(idx, String(b.page ?? ''), String(b.selector ?? ''), { url: b.url || null, mobile: b.mobile === true }),
  coverage: async (idx, b) => coverage(idx, (Array.isArray(b.pages) ? b.pages : String(b.pages ?? '').split(/[\s,]+/)).filter(Boolean), { url: b.url || null }),
  responsive: async (idx, b) => responsive(idx, String(b.page ?? ''), { url: b.url || null }),
  init: async (idx, b) => {
    const done = [];
    if (b.skill !== false) {
      const dir = join(idx.root, '.claude', 'skills', 'pilot');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), SKILL);
      done.push('the skill (.claude/skills/pilot/SKILL.md)');
    }
    const server = mcpServer(b.command || null);
    if (b.mcp) done.push(`the MCP server in ${writeMcpJson(idx.root, server).file}`);
    if (b.hook) done.push(`the hook in ${installHook(idx.root, [server.command, ...server.args.slice(0, -1)].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' '), { shots: b.shots === true })}${b.shots ? ', with screenshots' : ''}`);
    return { data: { done }, text: `Added ${done.join(', ')}.` };
  },
};

export function handler({ index, refresh, root, port, shoot = null, events = null }) {
  const api = routes();
  const page = pageHtml({ root, version: VERSION });
  return (req, res) => {
    // Only this machine, by name too: a page elsewhere can't reach the API through DNS rebinding.
    const host = String(req.headers.host ?? '').toLowerCase();
    if (port && !['127.0.0.1', 'localhost', '[::1]'].some((h) => host === `${h}:${port()}`)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    if (url.pathname.startsWith('/api/action/')) {
      // Actions change files or start a browser: a POST with a header a page elsewhere can't send.
      if (req.method !== 'POST' || req.headers['x-pilot'] !== '1') return send(403, JSON.stringify({ error: 'POST with X-Pilot: 1 only' }));
      const action = ACTIONS[url.pathname.slice('/api/action/'.length)];
      if (!action) return send(404, JSON.stringify({ error: 'no such action' }));
      let body = '';
      req.on('data', (d) => {
        body += d;
      });
      req.on('end', async () => {
        try {
          const r = await action(index(), JSON.parse(body || '{}'), { refresh });
          send(200, JSON.stringify({ ...r.data, text: r.text }));
        } catch (e) {
          send(200, JSON.stringify({ error: e.message, text: e.message }));
        }
      });
      return;
    }
    if (url.pathname === '/api/events') {
      // Server-sent events: each time the project's files change, the UI hears which.
      if (!events) return send(404, JSON.stringify({ error: 'no live updates here' }));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const listener = (files) => res.write(`data: ${JSON.stringify({ files, at: Date.now() })}\n\n`);
      events.add(listener);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        events.delete(listener);
        clearInterval(ping);
      });
      return;
    }
    // The screenshot report and its images, from .pilot/shots: names checked, nothing else served.
    const shotFile = /^\/shots\/(?:report\.html|([a-z0-9-]+)\/((?:before|after|diff|responsive)-(?:\d+|mobile)\.png))$/.exec(url.pathname);
    if (shotFile) {
      try {
        const body = readFileSync(join(index().root, SHOTS_DIR, shotFile[1] ? join(shotFile[1], shotFile[2]) : 'report.html'));
        res.writeHead(200, { 'content-type': shotFile[1] ? 'image/png' : 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" });
        return res.end(body);
      } catch {
        return send(404, JSON.stringify({ error: 'not found: take screenshots first' }));
      }
    }
    if (url.pathname === '/report.html') {
      const r = report(index());
      return send(200, readFileSync(r.data.file, 'utf8'), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/shoot') {
      // It starts a browser and writes files: a POST with a header a page elsewhere can't send.
      if (req.method !== 'POST' || req.headers['x-pilot'] !== '1') return send(403, JSON.stringify({ error: 'POST with X-Pilot: 1 only' }));
      let body = '';
      req.on('data', (d) => {
        body += d;
      });
      req.on('end', async () => {
        try {
          const { page: target, url: site, widths } = JSON.parse(body || '{}');
          const r = await (shoot ?? shot)(index(), String(target ?? ''), { url: site || null, widths: Array.isArray(widths) && widths.length ? widths : [1280] });
          send(200, JSON.stringify(r.data));
        } catch (e) {
          send(200, JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (req.method !== 'GET') return send(405, JSON.stringify({ error: 'GET only' }));
    if (url.pathname === '/api/shot-image') {
      const slug = url.searchParams.get('slug') ?? '';
      const name = url.searchParams.get('name') ?? '';
      if (!/^[a-z0-9-]+$/.test(slug) || !/^(before|after|diff|responsive)-(\d+|mobile)\.png$/.test(name)) return send(404, JSON.stringify({ error: 'not found' }));
      try {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return res.end(readFileSync(join(index().root, SHOTS_DIR, slug, name)));
      } catch {
        return send(404, JSON.stringify({ error: 'not found' }));
      }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: 'self'");
      return send(200, page, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/refresh') {
      try {
        const idx = refresh();
        return send(200, JSON.stringify({ ok: true, stats: idx.stats }));
      } catch (e) {
        return send(500, JSON.stringify({ error: e.message }));
      }
    }
    const route = api[url.pathname];
    if (!route) return send(404, JSON.stringify({ error: 'not found' }));
    try {
      const data = route(index(), url.searchParams);
      send(200, JSON.stringify(data ?? null));
    } catch (e) {
      send(500, JSON.stringify({ error: e.message }));
    }
  };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  } catch {
    // No browser to open: the URL is printed.
  }
}

/** Starts the UI: builds the index, listens on 127.0.0.1 (from `port`, or 4170 and up), opens the browser. */
/**
 * A downloaded Pilot keeps itself current: once a day `pilot ui` asks GitHub for the newest release and
 * installs it beside itself (the kit's updater: checksums checked, the old one moved aside on Windows),
 * to run from the next start. PILOT_NO_UPDATE=1 turns it off; a checkout updates with git pull.
 */
export async function autoUpdate(log, env = process.env) {
  if (!COMPILED || env.PILOT_NO_UPDATE === '1') return;
  const u = await import('@fleet/kit/update.js');
  await u.removeOldExecutables();
  const store = u.lastCheckStore(join(env.PILOT_CACHE ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? homedir(), 'pilot') : join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'pilot')), 'update.json'));
  const { checked, newer } = await u.checkForUpdate(await store.load());
  await store.save(checked);
  if (!newer) return;
  const done = await u.installUpdate(checked.latest);
  if (done === 'installed') log(`Pilot ${checked.latest} is installed: it runs from the next start (stop this one with ctrl+c and start pilot ui again).`);
}

export async function startUi({ root, port = null, open = true, vendor = false, ignore = [], log = console.error, fresh = 2000, update = true } = {}) {
  root = resolve(root);
  log(`Indexing ${root}…`);
  let idx = buildIndex(root, { vendor, ignore, progress: () => {} });
  log(`Indexed ${idx.stats.files} files in ${idx.stats.ms} ms.`);
  const index = () => {
    if (Date.now() - idx.builtAt > fresh) idx.build({ ignore });
    return idx;
  };
  const refresh = () => {
    idx = buildIndex(root, { vendor, ignore, cache: false });
    return idx;
  };
  let bound = null;
  // Live updates: the project's files watched; a burst of changes read again at once and announced.
  const events = new Set();
  let pending = new Set();
  let timer = null;
  try {
    watch(root, { recursive: true }, (_, name) => {
      const rel = String(name ?? '').replace(/\\/g, '/');
      if (!rel || /(^|\/)(\.pilot|\.git|\.vs|node_modules|bin|obj)(\/|$)/.test(rel) || !kindOf(rel.split('/').pop())) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending];
        pending = new Set();
        try {
          idx.build({ ignore });
        } catch {
          // A file mid-write: the next change reads it again.
        }
        for (const l of events) l(files);
      }, 400);
    });
  } catch {
    // No recursive watching here: the UI still reads changes on its next request.
  }
  const server = createServer(handler({ index, refresh, root, port: () => bound, events }));
  const listen = (p) =>
    new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', fail);
        ok(server.address().port);
      });
    });
  const first = port ?? 4170;
  for (let p = first; ; p++) {
    try {
      bound = await listen(p);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || port != null || p > first + 20) throw e;
    }
  }
  const url = `http://127.0.0.1:${bound}/`;
  log(`Pilot is at ${url}  (ctrl+c to stop)`);
  if (update) autoUpdate(log).catch(() => {});
  if (open) openBrowser(url);
  return { server, url, port: bound };
}
