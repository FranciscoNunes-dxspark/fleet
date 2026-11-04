// `pilot ui`: the web UI, served by Pilot itself on 127.0.0.1. The page (page.js) is one HTML file
// with its styles and script inline, so it needs no build and no network, and is part of the
// executable; it reads everything through the JSON API below, over the same queries the CLI runs.
// The index is kept and refreshed before a request when it's older than two seconds, so edits show
// up on the next click.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { VERSION } from '../app.js';
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
  return { root, skill: existsSync(join(root, '.claude', 'skills', 'pilot', 'SKILL.md')), mcp };
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
    '/api/audit': (idx, q) => ({ dead: deadCode, design, repeats, a11y, weight }[q.get('kind')]?.(idx)?.data ?? { error: 'unknown audit' }),
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
export function handler({ index, refresh, root, port, shoot = null }) {
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
      if (!/^[a-z0-9-]+$/.test(slug) || !/^(before|after|diff)-(\d+|mobile)\.png$/.test(name)) return send(404, JSON.stringify({ error: 'not found' }));
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
export async function startUi({ root, port = null, open = true, vendor = false, ignore = [], log = console.error, fresh = 2000 } = {}) {
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
  const server = createServer(handler({ index, refresh, root, port: () => bound }));
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
  if (open) openBrowser(url);
  return { server, url, port: bound };
}
