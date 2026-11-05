// `pilot ui`: the web UI, served by Pilot itself on 127.0.0.1. The page (page.js) is one HTML file
// with its styles and script inline, so it needs no build and no network, and is part of the
// executable; it reads everything through the JSON API below, over the same queries the CLI runs.
// The index is kept and refreshed before a request when it's older than two seconds, so edits show
// up on the next click.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, watch, writeFileSync } from 'node:fs';
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
import { findChrome } from '../shots.js';
import { describeFolder, forgetProject, listFolders, pickFolder, pickerKind, pinProject, projectFolder, recentProjects, rememberProject, stateDir } from './projects.js';

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

/**
 * The request handler. `session` is the project open now (createSession: one can be opened, closed
 * and switched from the UI); without one, `index`/`refresh`/`root` are a project fixed for good.
 * `port` is for the Host check.
 */
export function handler({ index, refresh, root, port, shoot = null, events = null, session = null }) {
  session ??= fixedSession({ index, refresh, root, events });
  const api = routes();
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
      const name = url.pathname.slice('/api/action/'.length);
      const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
      const own = Object.hasOwn(SESSION_ACTIONS, name) ? SESSION_ACTIONS[name] : null;
      if (!action && !own) return send(404, JSON.stringify({ error: 'no such action' }));
      let body = '';
      req.on('data', (d) => {
        body += d;
      });
      req.on('end', async () => {
        try {
          const b = JSON.parse(body || '{}');
          if (own) return send(200, JSON.stringify(await own(session, b)));
          const r = await action(session.index(), b, { refresh: () => session.refresh() });
          send(200, JSON.stringify({ ...r.data, text: r.text }));
        } catch (e) {
          send(e.code === 'NO_PROJECT' ? 409 : 200, JSON.stringify({ error: e.message, text: e.message, noProject: e.code === 'NO_PROJECT' || undefined }));
        }
      });
      return;
    }
    if (url.pathname === '/api/events') {
      // Server-sent events: each time the project's files change, the UI hears which.
      if (!session.events) return send(404, JSON.stringify({ error: 'no live updates here' }));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const listener = (what) => res.write(`data: ${JSON.stringify({ ...(Array.isArray(what) ? { files: what } : what), at: Date.now() })}\n\n`);
      session.events.add(listener);
      session.watching?.(1);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        session.events.delete(listener);
        clearInterval(ping);
        session.watching?.(-1);
      });
      return;
    }
    // The screenshot report and its images, from .pilot/shots: names checked, nothing else served.
    const shotFile = /^\/shots\/(?:report\.html|([a-z0-9-]+)\/((?:before|after|diff|responsive)-(?:\d+|mobile)\.png))$/.exec(url.pathname);
    if (shotFile) {
      try {
        const body = readFileSync(join(session.index().root, SHOTS_DIR, shotFile[1] ? join(shotFile[1], shotFile[2]) : 'report.html'));
        res.writeHead(200, { 'content-type': shotFile[1] ? 'image/png' : 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" });
        return res.end(body);
      } catch {
        return send(404, JSON.stringify({ error: 'not found: take screenshots first' }));
      }
    }
    if (url.pathname === '/report.html') {
      try {
        const r = report(session.index());
        return send(200, readFileSync(r.data.file, 'utf8'), 'text/html; charset=utf-8');
      } catch (e) {
        return send(e.code === 'NO_PROJECT' ? 409 : 500, JSON.stringify({ error: e.message }));
      }
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
          const r = await (shoot ?? shot)(session.index(), String(target ?? ''), { url: site || null, widths: Array.isArray(widths) && widths.length ? widths : [1280] });
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
        return res.end(readFileSync(join(session.index().root, SHOTS_DIR, slug, name)));
      } catch {
        return send(404, JSON.stringify({ error: 'not found' }));
      }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: 'self'");
      const r = session.root();
      return send(200, pageHtml({ root: r, name: r ? describeFolder(r).name : null, version: VERSION, app: !!session.app, picker: !!session.picker }), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/api/project') return send(200, JSON.stringify(projectInfo(session)));
    if (url.pathname === '/api/dirs') return send(200, JSON.stringify(listFolders(url.searchParams.get('path') || session.root() || null)));
    const failed = (e) => send(e.code === 'NO_PROJECT' ? 409 : 500, JSON.stringify({ error: e.message, noProject: e.code === 'NO_PROJECT' || undefined }));
    if (url.pathname === '/api/refresh') {
      try {
        const idx = session.refresh();
        return send(200, JSON.stringify({ ok: true, stats: idx.stats }));
      } catch (e) {
        return failed(e);
      }
    }
    const route = api[url.pathname];
    if (!route) return send(404, JSON.stringify({ error: 'not found' }));
    try {
      const data = route(session.index(), url.searchParams);
      send(200, JSON.stringify(data ?? null));
    } catch (e) {
      failed(e);
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

/**
 * A downloaded Pilot keeps itself current: once a day `pilot ui` asks GitHub for the newest release and
 * installs it beside itself (the kit's updater: checksums checked, the old one moved aside on Windows),
 * to run from the next start. PILOT_NO_UPDATE=1 turns it off; a checkout updates with git pull.
 */
export async function autoUpdate(log, env = process.env) {
  if (!COMPILED || env.PILOT_NO_UPDATE === '1') return;
  const u = await import('@fleet/kit/update.js');
  await u.removeOldExecutables();
  const store = u.lastCheckStore(join(stateDir(env), 'update.json'));
  const { checked, newer } = await u.checkForUpdate(await store.load());
  await store.save(checked);
  if (!newer) return;
  const done = await u.installUpdate(checked.latest);
  if (done === 'installed') log(`Pilot ${checked.latest} is installed: it runs from the next start (stop this one with ctrl+c and start pilot ui again).`);
}

function noProject() {
  return Object.assign(new Error('No project is open: open one first.'), { code: 'NO_PROJECT' });
}

/** A project given once and never changed (the tests', and handler's callers that pass an index). */
function fixedSession({ index, refresh, root, events }) {
  return { root: () => root ?? index().root, index, refresh, events, open: () => { throw new Error('This UI shows one project.'); }, close: () => {}, fixed: true };
}

/**
 * The project open in the UI, which the start window can open, close and switch: its index (read
 * again before a request when it's older than `fresh` ms), its files watched (a burst of changes read
 * at once and announced on `events`), and the recent list kept as it's opened.
 */
export function createSession({ root = null, vendor = false, ignore = [], fresh = 2000, log = () => {}, env = process.env, watchFiles = true, app = false, picker = pickerKind() } = {}) {
  let idx = null;
  let watcher = null;
  const events = new Set();
  const announce = (what) => {
    for (const l of events) l(what);
  };
  const watchProject = (dir) => {
    let pending = new Set();
    let timer = null;
    try {
      watcher = watch(dir, { recursive: true }, (_, name) => {
        const rel = String(name ?? '').replace(/\\/g, '/');
        if (!rel || /(^|\/)(\.pilot|\.git|\.vs|node_modules|bin|obj)(\/|$)/.test(rel) || !kindOf(rel.split('/').pop())) return;
        pending.add(rel);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const files = [...pending];
          pending = new Set();
          if (!idx || idx.root !== dir) return;
          try {
            idx.build({ ignore });
          } catch {
            // A file mid-write: the next change reads it again.
          }
          announce(files);
        }, 400);
      });
      watcher.on('error', () => {});
    } catch {
      // No recursive watching here: the UI still reads changes on its next request.
    }
  };
  const session = {
    events,
    app,
    picker,
    env,
    root: () => idx?.root ?? null,
    index() {
      if (!idx) throw noProject();
      if (Date.now() - idx.builtAt > fresh) idx.build({ ignore });
      return idx;
    },
    refresh() {
      if (!idx) throw noProject();
      idx = buildIndex(idx.root, { vendor, ignore, cache: false });
      return idx;
    },
    /** Opens a folder (or the folder of a file in it, like a .sln) in place of the project open now. */
    open(path) {
      const dir = projectFolder(path);
      if (!dir) throw new Error(`There's no folder ${path}.`);
      log(`Indexing ${dir}…`);
      const next = buildIndex(dir, { vendor, ignore, progress: () => {} });
      log(`Indexed ${next.stats.files} files in ${next.stats.ms} ms.`);
      session.close();
      idx = next;
      if (watchFiles) watchProject(dir);
      try {
        rememberProject(dir, env);
      } catch {
        // A recent list that can't be written: the project is open all the same.
      }
      announce({ project: dir });
      return idx;
    },
    close() {
      watcher?.close();
      watcher = null;
      idx = null;
    },
  };
  if (root) session.open(root);
  return session;
}

/** What the start window and the title bar show: the project open (if any), the recent ones, and Pilot itself. */
export function projectInfo(session) {
  const root = session.root();
  return {
    root,
    name: root ? describeFolder(root).name : null,
    recent: session.fixed ? [] : recentProjects(session.env),
    version: VERSION,
    compiled: COMPILED,
    app: !!session.app,
    picker: !!session.picker,
    fixed: !!session.fixed,
    stats: root ? session.index().stats : null,
  };
}

/** The actions on the session itself (opening, closing, the recent list), which need no project open. */
export const SESSION_ACTIONS = {
  open: async (session, b) => {
    const idx = session.open(String(b.path ?? ''));
    return { ...projectInfo(session), stats: idx.stats };
  },
  close: async (session) => {
    if (session.fixed) throw new Error('This UI shows one project.');
    session.close();
    return projectInfo(session);
  },
  pick: async (session, b) => {
    if (!session.picker) return { unsupported: true };
    const path = await pickFolder({ start: b.start || session.root() || null, kind: session.picker === true ? undefined : session.picker });
    return path?.unsupported ? { unsupported: true } : { path };
  },
  forget: async (session, b) => {
    forgetProject(String(b.path ?? ''), session.env);
    return projectInfo(session);
  },
  pin: async (session, b) => {
    pinProject(String(b.path ?? ''), b.pinned === true, session.env);
    return projectInfo(session);
  },
  update: async () => {
    const u = await import('@fleet/kit/update.js');
    const latest = await u.fetchLatest({ current: VERSION });
    if (!COMPILED || !latest || !u.isNewer(latest.version, VERSION)) return { text: u.updateAdvice({ latest, current: VERSION, compiled: COMPILED }).join('\n') };
    const done = await u.installUpdate(latest.version);
    return { installed: latest.version, text: done === 'already' ? `Pilot ${latest.version} is already installed: it runs from the next start.` : `Pilot ${latest.version} is installed: it runs the next time you open Pilot.` };
  },
  quit: async (session) => {
    if (!session.app) throw new Error('Only Pilot\'s own window quits from here: stop pilot ui with ctrl+c.');
    setTimeout(() => session.quit?.(), 100);
    return { ok: true };
  },
};

/** Starts the UI: opens the project (or none: the start window), listens on 127.0.0.1 (from `port`, or 4170 and up), opens the browser. */
export async function startUi({ root, port = null, open = true, vendor = false, ignore = [], log = console.error, fresh = 2000, update = true, app = false, env = process.env } = {}) {
  const session = createSession({ root: root ? resolve(root) : null, vendor, ignore, fresh, log, env, app });
  let bound = null;
  const server = createServer(handler({ session, port: () => bound }));
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
      if (e.code !== 'EADDRINUSE' || port != null || p > first + 50) throw e;
    }
  }
  const url = `http://127.0.0.1:${bound}/`;
  log(app ? `Pilot's window shows ${url}` : `Pilot is at ${url}  (ctrl+c to stop)`);
  if (update) autoUpdate(log, env).catch(() => {});
  if (open) openBrowser(url);
  return { server, url, port: bound, session };
}

/**
 * Pilot's own window: Edge (Chrome where there's no Edge) as an app window, with no tabs or address
 * bar, its own profile, over `pilot ui`'s server. The server stops when its last window has gone.
 */
export function findAppBrowser(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.PILOT_BROWSER) return env.PILOT_BROWSER;
  if (platform === 'win32') {
    for (const base of [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean)) {
      const edge = join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
      if (exists(edge)) return edge;
    }
  }
  if (platform === 'darwin' && exists('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')) return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  return findChrome(env, platform, exists);
}

/** The browser's arguments for an app window on `url`, in a profile of Pilot's own. */
export function appWindowArgs(url, profile) {
  return [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1440,920', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,msEdgeSidebarV2,msHubApps'];
}

/**
 * Keeps the server while a window is connected: once the last one has gone (and not come back in
 * `grace` ms, as a reload does) it calls `quit`; it also quits when none connected within `wait` ms.
 */
export function lifecycle(quit, { grace = 4000, wait = 120000 } = {}) {
  let clients = 0;
  let timer = setTimeout(quit, wait);
  return (delta) => {
    clients += delta;
    clearTimeout(timer);
    timer = clients > 0 ? null : setTimeout(quit, grace);
    return clients;
  };
}

/**
 * `pilot app`: from a terminal or a shortcut, starts a copy of itself apart (so no console stays
 * open) that serves the UI and opens the window; that copy logs to pilot-app.log beside the cache.
 */
export async function launchApp({ argv, root = null, port = null, vendor = false, ignore = [], log = console.error, env = process.env } = {}) {
  const browser = findAppBrowser(env);
  if (!browser) {
    log('Pilot needs Edge or Chrome for its window: opening it in your browser instead.');
    await startUi({ root, port, vendor, ignore, log, env });
    return null;
  }
  if (env.PILOT_APP_CHILD !== '1') {
    mkdirSync(stateDir(env), { recursive: true });
    const out = openSync(join(stateDir(env), 'pilot-app.log'), 'a');
    const args = COMPILED ? argv : [process.argv[1], ...argv];
    spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...env, PILOT_APP_CHILD: '1' } }).unref();
    log('Pilot is opening in its own window.');
    return 0;
  }
  const stamp = (s) => log(`${new Date().toISOString()} ${s}`);
  let ui;
  try {
    ui = await startUi({ root, port, open: false, vendor, ignore, log: stamp, app: true, env });
  } catch (e) {
    // A project that can't be read still opens the window, on the start page.
    stamp(`Couldn't open ${root}: ${e.message}`);
    ui = await startUi({ root: null, port, open: false, vendor, ignore, log: stamp, app: true, env });
  }
  const quit = () => {
    stamp('The window has closed: stopping.');
    ui.server.close();
    process.exit(0);
  };
  ui.session.quit = quit;
  ui.session.watching = lifecycle(quit);
  const win = spawn(browser, appWindowArgs(ui.url, join(stateDir(env), 'app-profile')), { detached: true, stdio: 'ignore' });
  win.on('error', (e) => {
    stamp(`Couldn't start ${browser}: ${e.message}`);
    openBrowser(ui.url);
  });
  win.unref();
  return null;
}
