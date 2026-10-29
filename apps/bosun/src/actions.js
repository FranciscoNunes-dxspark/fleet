// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { configFile } from './config.js';
import { run } from '@fleet/kit/run.js';
import { nextTheme, settingRows, settingSegments } from './settings.js';
import { applyTheme, defaultAccent, isColour, setAccent, theme } from './theme.js';
import { clip } from '@fleet/kit/claude-cli.js';
import { FILE, specFor, words, writeSpec } from './crew.js';
import { choices, resolveFolder, samePath } from './projects.js';
import { basename, relative, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { listSessions } from './recorder.js';
import { markCrew } from './ports.js';
import { troubleContext } from './share.js';
import { APP_NAMES, TAKEN_BY, contextIn, copiedNote, describeContext, notMine, projectAt, projectWiring, readActivity, shareLine, takeLine, trawlLine } from '@fleet/kit/family.js';
import { checkLine, runChecks, summary } from './preflight.js';
import { clock, parseSession } from './replay.js';
import { planLines, restorePlan } from './restore.js';
import { branchTip, gitHead } from './githead.js';
import { installHint } from './tunnel.js';
import { afterTree, namedProcs, treeLine } from './groups.js';
import { levelTone, shownText, structuredOf, troubled } from './structured.js';
import { nextMemoryAlert, shortBytes, shortCpu, sparkline } from './usage.js';
import { SYSTEM_PIDS } from './supervisor.js';
import { bindingUrl } from './iis.js';

const YES_NO = (yes) => [
  { label: yes, value: true },
  { label: 'No', value: false },
];

/** ! and /run: a shell command, with the spinner, esc to cancel and its output in the activity lines. */
export function raw(ctx, command) {
  const text = command.trim();
  if (!text) return ctx.note('Type a command after !, e.g. !node --version', 'error');
  return ctx.task(text, (signal) => run(text, { signal }), { label: 'Running' });
}

/** A process by name (or an unambiguous start of one), saying so when there's none. */
function proc(ctx, name) {
  const crew = ctx.crew;
  const n = String(name ?? '').trim().toLowerCase();
  if (!crew) return null;
  const all = crew.list();
  const p = all.find((x) => x.name.toLowerCase() === n) ?? (n ? all.filter((x) => x.name.toLowerCase().startsWith(n)) : []).find((_, i, list) => list.length === 1);
  if (!p) ctx.note(n ? `There's no process called ${name}.` : 'Name a process.', 'error');
  return p ?? null;
}

/** The processes of a group named `name`, when it names one and no process: { group, names }; else null. */
function group(ctx, name) {
  const found = namedProcs(ctx.crew?.list() ?? [], name);
  return found?.group ? { group: found.group, names: found.procs.map((p) => p.name) } : null;
}

/** r, R and /restart: one process, a group, or `all`. */
export async function restart(ctx, name) {
  if (String(name).trim() === 'all' || !String(name).trim()) {
    if (!ctx.crew) return;
    ctx.note('Restarting every process');
    ctx.activity('Restarted the crew');
    await ctx.crew.stopAll();
    return ctx.crew.startAll();
  }
  const g = group(ctx, name);
  if (g) {
    ctx.note(`Restarting ${g.group}: ${g.names.join(', ')}`);
    ctx.activity(`Restarted ${g.group} (${g.names.join(', ')})`);
    await Promise.all(g.names.map((n) => ctx.crew.stop(n, { keepWatching: true })));
    return ctx.crew.startAll({ only: g.names });
  }
  const p = proc(ctx, name);
  if (!p) return false;
  ctx.activity(`Restarted ${p.name}`);
  await ctx.crew.restart(p.name);
}

/** /stop: one process, a group, or `all`. */
export async function stop(ctx, name) {
  if (String(name).trim() === 'all') {
    if (!ctx.crew) return;
    ctx.activity('Stopped the crew');
    return ctx.crew.stopAll();
  }
  const g = group(ctx, name);
  if (g) {
    ctx.activity(`Stopped ${g.group} (${g.names.join(', ')})`);
    return Promise.all(g.names.map((n) => ctx.crew.stop(n)));
  }
  const p = proc(ctx, name);
  if (!p) return false;
  if (p.child) ctx.activity(`Stopped ${p.name}`);
  await ctx.crew.stop(p.name);
}

/** /start: one process, a group, or `all` (each after the one it waits for). */
export function start(ctx, name) {
  if (String(name).trim() === 'all' || !String(name).trim()) return ctx.crew?.startAll();
  const g = group(ctx, name);
  if (g) return ctx.crew.startAll({ only: g.names });
  const p = proc(ctx, name);
  if (!p) return false;
  ctx.crew.start(p.name);
}

/** /graph: who starts after whom ("after" in bosun.json), as a tree, each with its state and group. */
export function graph(ctx) {
  const procs = ctx.crew?.list() ?? [];
  if (!procs.length) return ctx.note('Nothing to run, so nothing waits for anything.');
  const tree = afterTree(procs);
  const by = new Map(procs.map((p) => [p.name, p]));
  const colour = { running: theme.add, starting: theme.warn, stopping: theme.warn, crashed: theme.del };
  const lines = tree.map((n) => {
    const p = by.get(n.name);
    return [
      { text: `${treeLine(n).slice(0, -n.name.length)}`, color: theme.dim },
      { text: '● ', color: colour[p.status] ?? theme.dim },
      { text: n.name, bold: true },
      { text: p.port ? ` :${p.port}` : '', color: theme.dim },
      { text: n.group ? `  (${n.group})` : '', color: theme.accent },
      { text: n.circle ? '  waits in a circle: it never starts after them' : '', color: theme.del },
    ];
  });
  const waits = procs.some((p) => p.spec.after);
  ctx.showText('Who starts after whom', [...tree.map((n) => `${treeLine(n)}${n.group ? `  (${n.group})` : ''}`), ...(waits ? [] : ['', 'Nothing waits for anything: "after" in bosun.json makes one start once another\'s port answers.'])].join('\n'), {
    lines: waits ? lines : [...lines, [], [{ text: 'Nothing waits for anything: "after" in bosun.json makes one start once another\'s port answers.', color: theme.dim }]],
  });
}

/** s: stops it when it's running, starts it when it isn't; while it waits to restart, it won't. */
export function toggle(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  if (p.restartAt) return void ctx.crew.cancelRestart(p.name);
  if (p.child) ctx.activity(`Stopped ${p.name}`);
  return p.child ? ctx.crew.stop(p.name) : ctx.crew.start(p.name);
}

/**
 * ↵: everything a process has said, in the viewer: structured lines formatted and coloured by level,
 * and ↵ there shows one's whole object, pretty.
 */
export function showLog(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  const lines = [...p.lines];
  const read = lines.map(structuredOf);
  const rich = {
    color: (i) => (read[i] ? theme[levelTone(read[i].level)] : lines[i]?.text.startsWith('── ') ? theme.dim : undefined),
    trouble: (i) => Boolean(lines[i] && troubled(lines[i])),
    opens: (i) => Boolean(read[i]),
    open: (i) => ctx.showText(`${p.name} · ${new Date(lines[i].at).toLocaleTimeString()}`, JSON.stringify(read[i].obj, null, 2), { back: ctx.overlay() }),
  };
  ctx.showText(`${p.name} · ${p.spec.run}`, lines.map(shownText).join('\n') || '(nothing yet)', { bottom: true, log: true, rich });
}

/** c: forgets what a process has said so far. */
export function clearLog(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  ctx.crew.clearLog(p.name);
  ctx.note(`Cleared ${p.name}'s log.`);
}

/** l: /save-log for the process under the cursor, in the prompt to change the file's name. */
export const saveLogPrompt = (ctx, name) => ctx.prefill(`/save-log ${name} ${/\s/.test(name) ? `"${name}.log"` : `${name}.log`}`);

/** /save-log: a process's log written to a file, from the project's folder (asks before writing over one). */
export async function saveLog(ctx, rest) {
  const [name, file = name ? `${name}.log` : undefined] = words(rest ?? '');
  const p = proc(ctx, name);
  if (!p) return false;
  const path = resolve(ctx.dir, file);
  if (existsSync(path)) {
    const ok = await ctx.confirm({ title: `${file} is there already. Write over it?`, danger: true, options: YES_NO('Yes, write over it') });
    if (!ok) return false;
  }
  try {
    writeFileSync(path, p.lines.map((l) => `${l.text}\n`).join(''));
  } catch (e) {
    return ctx.note(`Couldn't write ${file}: ${e.message}`, 'error');
  }
  ctx.note(`Wrote ${p.lines.length} line${p.lines.length === 1 ? '' : 's'} of ${p.name}'s log to ${file}.`, 'ok');
}

/** t: the latest trouble line of a process, as a /take line for Sonar, Hail or Wharf (with the request it names). */
export function shareTrouble(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  const data = troubleContext(basename(ctx.dir), p);
  if (!data) return ctx.note(`${p.name}'s log has nothing that reads as trouble to share.`);
  const line = takeLine('logline', data);
  ctx.copy(line, 'the trouble line');
  ctx.note(`${copiedNote(TAKEN_BY.logline.filter((a) => a !== 'bosun'), line)}${data.requestId ? `\nrequest ${data.requestId}` : ''}`, 'ok');
}

/**
 * /take: a context from a sibling (`family:v1:…`, with /take or alone). A log line or an exception is
 * looked for in the crew's logs (by its request id, else its text) and the lines that say it are shown;
 * other kinds are another app's, which is said.
 */
export function take(ctx, rest) {
  const c = contextIn(rest);
  if (!c) return ctx.note('That isn\'t a line from a sibling app: /take family:v1:…, as Splice, Trawl, Sonar, Hail or Wharf copy it.', 'error');
  if (!TAKEN_BY[c.kind]?.includes('bosun')) return ctx.note(notMine('bosun', c), 'error');
  const what = describeContext(c);
  const needles = [c.data.requestId, c.data.operationId, c.kind === 'logline' ? c.data.text : c.data.message].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  const procs = ctx.crew?.list() ?? [];
  for (const needle of needles) {
    const found = procs.flatMap((p) => p.lines.filter((l) => l.text.includes(needle)).map((l) => ({ p, l })));
    if (!found.length) continue;
    found.sort((x, y) => x.l.at - y.l.at);
    const width = Math.max(...found.map((f) => f.p.name.length));
    ctx.note(`${found.length} line${found.length === 1 ? '' : 's'} of the crew's logs say ${needle.length > 40 ? `${needle.slice(0, 40)}…` : needle}`, 'ok');
    return ctx.showText(`From ${what}`, found.map(({ p, l }) => `${new Date(l.at).toLocaleTimeString()}  ${p.name.padEnd(width)}  ${l.text}`).join('\n'), { bottom: true, log: true });
  }
  ctx.note(`Nothing in the crew's logs says that (${what}).`);
}

/** The name Trawl keeps a database the project names under: the project's and the database's (else its key's), as one word. */
export const trawlName = (project, db) => `${project}-${db.database ?? db.name}`.toLowerCase().replace(/[^\w.-]+/g, '-');

/** What this project offers the siblings: [{ app, line, what }]. */
export function familyOffers(found) {
  const project = basename(found.dir);
  return [
    ...(found.repo ? [{ app: 'splice', line: shareLine('open', [found.repo]), what: 'this checkout' }] : []),
    ...found.httpFiles.map((f) => ({ app: 'hail', line: shareLine('open', [f]), what: relative(found.dir, f) })),
    ...found.databases.map((d) => ({ app: 'trawl', line: trawlLine(d, trawlName(project, d)), what: `${d.name} (${d.source})` })),
  ];
}

/** /family: a picker of what this project offers the siblings; ↵ copies the line to paste into that app. */
export function family(ctx) {
  const offers = familyOffers(projectAt(ctx.dir));
  if (!offers.length) return ctx.note('Nothing here for the siblings: no git checkout, .http files or databases in the settings.');
  ctx.showPicker({
    title: 'For the family',
    hint: '↵ copies the line to paste into that app',
    items: offers.map((o) => ({ ...o, segments: [{ text: APP_NAMES[o.app].padEnd(8), color: theme.accent, bold: true }, { text: o.what.padEnd(28) }, { text: `  ${o.line}`, color: theme.dim }] })),
    onPick: (o) => {
      ctx.copy(o.line, `the line for ${APP_NAMES[o.app]}`);
      ctx.note(copiedNote(o.app, o.line), 'ok');
    },
  });
}

const KIND_MARK = { error: '✗', info: '·' };

/** When an activity happened, as /timeline says it: the time today, else the date and time. */
export function when(at, now = Date.now()) {
  const d = new Date(at);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date(now).toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}

/**
 * /timeline: what the family's apps did (family.js's readActivity), newest first: this project's
 * (with the entries that name none) or, after p, every project's. ↵ shows one whole.
 */
export function timeline(ctx, { all = false, replace = false } = {}) {
  const entries = readActivity({ project: all ? undefined : ctx.dir, limit: 500 });
  const appW = Math.max(...Object.values(APP_NAMES).map((n) => n.length));
  ctx.showPicker(
    {
      title: all ? "The family's activity, every project" : `The family's activity in ${basename(ctx.dir)}`,
      hint: `p ${all ? 'this project only' : 'every project'} · ↵ the whole of it`,
      empty: all ? 'Nothing yet: the apps add what they do here as they do it.' : `Nothing yet in ${basename(ctx.dir)}: p shows every project's.`,
      items: entries.map((e) => ({
        e,
        segments: [
          { text: `${when(e.at)}  `.padStart(14), color: theme.dim },
          { text: `${(APP_NAMES[e.app] ?? e.app).padEnd(appW)} `, color: theme.accent, bold: true },
          { text: `${KIND_MARK[e.kind] ?? '·'} `, color: e.kind === 'error' ? theme.del : theme.dim },
          { text: e.text, color: e.kind === 'error' ? theme.del : undefined },
          { text: all && e.project ? `  ${basename(e.project)}` : '', color: theme.dim },
        ],
      })),
      actions: { p: () => timeline(ctx, { all: !all, replace: true }) },
      onPick: ({ e }) =>
        ctx.showText(
          `${APP_NAMES[e.app] ?? e.app} · ${new Date(e.at).toLocaleString()}`,
          [e.text, '', `app      ${APP_NAMES[e.app] ?? e.app}`, `when     ${new Date(e.at).toLocaleString()}`, `kind     ${e.kind ?? 'info'}`, ...(e.project ? [`project  ${e.project}`] : [])].join('\n'),
        ),
    },
    { replace },
  );
}

/** /wiring: what the project points at (family.js's projectWiring: addresses, hosts, ports, connection strings, masked), by the file it's in. */
export function wiring(ctx) {
  const found = projectWiring(ctx.dir);
  if (!found.length) return ctx.note(`Nothing in ${basename(ctx.dir)} points anywhere: no addresses or connection strings in appsettings*.json, .env files or http-client.env.json.`);
  const sources = [...new Set(found.map((w) => w.source))];
  const keyW = Math.min(40, Math.max(...found.map((w) => w.key.length)));
  const lines = [];
  const text = [];
  for (const source of sources) {
    if (lines.length) {
      lines.push([]);
      text.push('');
    }
    lines.push([{ text: source, color: theme.accent, bold: true }]);
    text.push(source);
    for (const w of found.filter((x) => x.source === source)) {
      lines.push([{ text: `  ${w.key.padEnd(keyW)}  `, color: theme.dim }, { text: w.value }]);
      text.push(`  ${w.key.padEnd(keyW)}  ${w.value}`);
    }
  }
  ctx.showText(`What ${basename(ctx.dir)} points at`, text.join('\n'), { lines });
}

/** f and /free: stops whatever holds `port` on this machine, after asking. */
export async function free(ctx, port) {
  const n = Number(String(port ?? '').trim().replace(/^:/, ''));
  if (!Number.isInteger(n) || n < 1 || n > 65535) return ctx.note('Name a port: /free 3000', 'error');
  const all = ctx.pidsOnPort(n);
  if (!all.length) return ctx.note(`Nothing is listening on port ${n} (or this machine won't say what is).`);
  // Windows' System process holds the ports of http.sys, which IIS (and other servers) listen through:
  // never Bosun's to stop.
  const pids = all.filter((pid) => !SYSTEM_PIDS.has(pid));
  if (!pids.length) {
    const site = (ctx.crew?.list() ?? []).find((p) => p.spec.iis && p.port === n);
    return ctx.note(
      site
        ? `Port ${n} is ${site.name}'s, IIS site ${site.spec.iis.site}, through http.sys: s stops it.`
        : `Port ${n} is held by http.sys (the System process): an IIS site, IIS Express or another HTTP.sys server binds it. Stop that site in IIS (appcmd list site shows their bindings); Bosun won't stop System.`,
      'error',
    );
  }
  const ok = await ctx.confirm({ title: `Stop ${pids.length === 1 ? `process ${pids[0]}` : `processes ${pids.join(', ')}`}, which ${pids.length === 1 ? 'holds' : 'hold'} port ${n}?`, danger: true, options: YES_NO('Yes, stop it') });
  if (!ok) return false;
  ctx.killPids(pids);
  ctx.note(`Stopped what held port ${n}.`, 'ok');
}

/** /ports: the TCP ports listening on this machine, the crew's marked; f frees one, o opens it. */
export function ports(ctx, { replace = false } = {}) {
  ctx.showPicker(
    {
      title: 'Ports listening on this machine',
      hint: 'f free it · o open it',
      empty: "Nothing is listening (or this machine won't say: lsof, ss or netstat answers).",
      load: async () => {
        const procs = ctx.crew?.list() ?? [];
        const list = markCrew(await ctx.listPorts(), procs);
        const pidW = Math.max(3, ...list.map((e) => String(e.pid ?? '?').length));
        return list.map((e) => ({
          ...e,
          segments: [
            { text: `:${String(e.port).padEnd(6)}`, strong: true, color: e.proc ? theme.accent : undefined },
            { text: `pid ${String(e.pid ?? '?').padStart(pidW)}  `, color: theme.dim },
            { text: (e.name ?? '?').padEnd(16) },
            { text: e.proc ? ` ${e.proc} (this crew)` : '', color: theme.accent },
            { text: `  ${e.hosts.join(' ')}`, color: theme.dim },
          ],
        }));
      },
      keys: {
        f: async (it) => {
          if ((await free(ctx, it.port)) === false) return;
          // Its holder takes a moment to go; then the list again, without it.
          await new Promise((r) => setTimeout(r, 300));
          ports(ctx, { replace: true });
        },
        o: (it) => openPort(ctx, it),
      },
      onPick: (it) => openPort(ctx, it),
    },
    { replace },
  );
}

// A port of /ports in the browser: the crew's process's own address when it's one of them (an IIS site's host name).
const openPort = (ctx, it) => {
  const p = it.proc && ctx.crew?.get(it.proc);
  ctx.openUrl(p?.port === it.port ? procUrl(p) : `http://localhost:${it.port}`);
};

/** /preflight: the checks run before the crew starts, again now, as a checklist in the viewer. */
export async function preflight(ctx) {
  if (!ctx.data) return ctx.note('Nothing read yet.');
  let checks = null;
  const r = await ctx.task(
    'Pre-flight',
    async () => {
      checks = runChecks(await ctx.gatherFacts());
      return { stdout: summary(checks) };
    },
    { label: 'Checking' },
  );
  if (!r.ok) return r;
  const lines = checks.length
    ? checks.flatMap((c) => [
        [{ text: c.ok ? '✓ ' : '✗ ', color: c.ok ? theme.add : theme.del, bold: true }, { text: c.title }],
        ...(c.ok ? [] : [[{ text: `  ${c.hint}`, color: theme.dim }]]),
      ])
    : [[{ text: 'Nothing to check: no ports, .env.example, databases, Node version or node_modules here.', color: theme.dim }]];
  ctx.showText('Pre-flight', checks.map(checkLine).join('\n'), { lines });
}

/** The processes by what they use: the busiest first (CPU, then memory), the ones not running last. */
export const byUsage = (procs) =>
  [...procs].sort((x, y) => (y.usage ? 1 : 0) - (x.usage ? 1 : 0) || (y.usage?.cpu ?? 0) - (x.usage?.cpu ?? 0) || (y.usage?.mem ?? 0) - (x.usage?.mem ?? 0) || x.name.localeCompare(y.name));

/**
 * /top: every process with its CPU and memory (with what it started), the busiest first, and the last
 * minute of each as a sparkline; redrawn with each sample. ↵ shows its log.
 */
export function top(ctx, { replace = false } = {}) {
  const procs = ctx.crew?.list() ?? [];
  if (!procs.length) return ctx.note('Nothing to run, so nothing to measure.');
  const nameW = Math.max(4, ...procs.map((p) => p.name.length));
  const o = ctx.overlay();
  ctx.showPicker(
    {
      title: 'Top',
      hint: 'CPU (% of one core) and memory, with what each started · ↵ its log',
      top: true,
      index: replace && o?.top ? o.index : undefined,
      empty: 'Nothing is running.',
      items: byUsage(procs).map((p) => ({
        name: p.name,
        segments: [
          { text: p.name.padEnd(nameW + 2), strong: true },
          ...(p.usage
            ? [
                { text: shortCpu(p.usage.cpu).padStart(5), color: p.usage.cpu >= 80 ? theme.del : p.usage.cpu >= 30 ? theme.warn : undefined },
                { text: `  ${sparkline((p.samples ?? []).map((s) => s.cpu), 15).padEnd(15)}`, color: theme.accent },
                { text: shortBytes(p.usage.mem).padStart(7) },
                { text: `  ${sparkline((p.samples ?? []).map((s) => s.mem), 15)}`, color: theme.accent },
              ]
            : [{ text: p.child ? '    … measuring' : `    ${p.status}`, color: theme.dim }]),
        ],
      })),
      onPick: (it) => showLog(ctx, it.name),
    },
    { replace },
  );
}

/**
 * T and /tunnel: opens `name`'s port to the internet through cloudflared or ngrok (asking first), or
 * closes the tunnel it has. The address is copied once the tool says it (App's crewEvent).
 */
export async function tunnel(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  if (p.tunnel) return void ctx.crew.closeTunnel(p.name);
  if (!p.port) return ctx.note(`${p.name} has no port to open: give it one in bosun.json ("port": 3000).`, 'error');
  if (!p.child) return ctx.note(`${p.name} isn't running: start it first (s), then open its tunnel.`, 'error');
  const found = ctx.tunnelTool(p.spec.tunnel ?? ctx.data?.tunnel ?? null);
  if (found.missing) return ctx.note(installHint(found.missing), 'error');
  const ok = await ctx.confirm({
    title: `Open ${p.name}'s port ${p.port} to the internet through ${found.tool}?`,
    detail: 'Anyone with the address reaches it, until you close it (T) or the process stops.',
    danger: true,
    options: YES_NO('Yes, open it'),
  });
  if (!ok) return false;
  if (ctx.crew.openTunnel(p.name, found)) ctx.note(`Opening a tunnel to ${p.name}'s port ${p.port} through ${found.tool}…`);
}

/** The address o opens: its https port's, else its host name's (an IIS site's binding, "host"), else localhost's. */
export function procUrl(p) {
  if (p.https) return `https://localhost:${p.https.port}`;
  const site = p.site?.port === p.port ? p.site : null;
  const host = p.spec.host ?? site?.host;
  const scheme = site?.scheme ?? 'http';
  if (host || site) return bindingUrl({ scheme, host, ip: site?.ip ?? null, port: p.port });
  return `http://localhost:${p.port}`;
}

/** o and /open: the process's port in the browser. */
export function openProc(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  if (!p.port) return ctx.note(`${p.name} has no port: give it one in bosun.json ("port": 3000).`, 'error');
  ctx.openUrl(procUrl(p));
}

/** The question for w and /why: what the process is and what it said last. */
export function whyPrompt(p) {
  return [
    p.spec.iis
      ? `"${p.name}" is one of the processes of the project in the current folder: IIS site "${p.spec.iis.site}", which IIS runs (Bosun starts, recycles and stops it through appcmd). Its log holds what Bosun did, the site's ASP.NET Core stdout log, its W3C request log and the Windows event log's entries for it, as JSON lines`
      : `"${p.name}" is one of the processes of the project in the current folder, started with: ${p.spec.run}${p.spec.build ? `, after building with: ${p.spec.build}` : ''}`,
    p.status === 'crashed' ? `It stopped with exit code ${p.code}.` : `It is ${p.status}.`,
    'Its output is on stdin, the newest last. Say in a few sentences why it failed or what is wrong, and what to do about it. Read the project\'s files if that helps. Plain text, no headings.',
  ].join(' ');
}

/** w and /why: asks Claude why a process failed, from its log and the project's files. */
export async function why(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  if (!p.lines.length) return ctx.note(`${p.name} hasn't said anything yet.`);
  const log = clip(p.lines.slice(-400).map((l) => l.text).join('\n'), 60_000);
  const r = await ctx.task(`Asking Claude about ${p.name}`, async (signal) => ({ stdout: await ctx.askClaude(whyPrompt(p), { input: log, cwd: ctx.dir, signal, tools: ['Read', 'Grep', 'Glob'] }) }), { label: 'Claude is reading the log' });
  if (r.ok) ctx.showText(`Why ${p.name}`, r.out);
  return r;
}

/** p and /profile: the profiles in bosun.json (or package.json's dev:* scripts), or none. */
export function profiles(ctx, name) {
  const names = Object.keys(ctx.data?.profiles ?? {});
  if (name?.trim()) {
    const n = name.trim();
    if (n !== 'none' && !names.includes(n)) return ctx.note(`There's no profile called ${n}${names.length ? ` (there's ${names.join(', ')})` : ''}.`, 'error');
    return ctx.setProfile(n === 'none' ? null : n);
  }
  if (!names.length) return ctx.note('There are no profiles: add "profiles" to bosun.json.');
  ctx.showPicker({
    title: 'Profiles',
    hint: 'the processes that change restart',
    items: [{ name: null, label: 'none' }, ...names.map((n) => ({ name: n, label: n }))].map((it) => ({ ...it, segments: [{ text: it.label, strong: it.name === (ctx.data?.profile ?? null) }, { text: it.name === (ctx.data?.profile ?? null) ? '  (on)' : '', color: theme.dim }] })),
    onPick: (it) => {
      ctx.closeOverlay();
      ctx.setProfile(it.name);
    },
  });
}

/**
 * /move: Bosun on another project, `folder` being a path or a project beside this one; without one,
 * a list of the projects run lately and the folders beside this one. This one's processes stop
 * first, after asking when any are running.
 */
export async function move(ctx, folder) {
  if (!folder?.trim()) {
    const items = choices(ctx.dir, ctx.config.projects);
    if (!items.length) return ctx.note('There are no other folders beside this one: /move <path>.');
    return ctx.showPicker({
      title: 'Move to',
      hint: 'the projects you ran lately first',
      items: items.map((it) => ({ ...it, segments: [{ text: it.name, strong: it.crew }, { text: it.crew ? '' : '  (nothing to run)', color: theme.dim }] })),
      onPick: (it) => {
        ctx.closeOverlay();
        move(ctx, it.path);
      },
    });
  }
  const target = resolveFolder(ctx.dir, folder);
  if (!target) return ctx.note(`There's no folder ${folder.trim()} here or beside ${basename(ctx.dir)}.`, 'error');
  if (samePath(target, ctx.dir)) return ctx.note(`Bosun is in ${basename(target)} already.`);
  const running = (ctx.crew?.list() ?? []).filter((p) => p.child).length;
  if (running) {
    const ok = await ctx.confirm({ title: `Stop ${running === 1 ? 'the running process' : `the ${running} running processes`} and move to ${basename(target)}?`, danger: true, options: YES_NO('Yes, move') });
    if (!ok) return false;
  }
  return ctx.moveTo(target);
}

/** /replay: the sessions recorded for this project, newest first; ↵ plays one back. */
export function replay(ctx) {
  ctx.crew?.recorder?.flush();
  const sessions = listSessions(ctx.dir);
  if (!sessions.length) return ctx.note(ctx.config.record === false ? 'Recording is off in the settings, and nothing was recorded before.' : 'Nothing recorded for this project yet: a session is recorded once a process says something.');
  const live = ctx.crew?.recorder?.file;
  ctx.showPicker({
    title: `Sessions of ${basename(ctx.dir)}`,
    hint: '↵ replays it',
    items: sessions.map((s) => ({
      ...s,
      segments: [
        { text: new Date(s.start).toLocaleString(), strong: true },
        { text: `  ${s.ended ? clock(s.ended - s.start) : ''}`, color: theme.dim },
        { text: `  ${size(s.bytes)}`, color: theme.dim },
        { text: s.file === live ? '  (this one, so far)' : '', color: theme.accent },
      ],
    })),
    onPick: (it) => {
      let text;
      try {
        text = readFileSync(it.file, 'utf8');
      } catch (e) {
        return ctx.note(`Couldn't read that session: ${e.message}`, 'error');
      }
      const session = parseSession(text);
      if (!session.events.length) return ctx.note('That session has nothing in it.');
      ctx.showReplay(session, new Date(it.start).toLocaleString());
    },
  });
}

/**
 * r in /replay: the crew as it was at `then` ({ t, procs, profile, git }, from the Replayer), as far as
 * it can be: the profile, then the processes that weren't running stopped and the ones that were
 * started. The checkout is Splice's to change: its /checkout line is copied for it. Asks first.
 */
export async function restore(ctx, then) {
  const sup = ctx.crew;
  if (!sup) return ctx.note('There is no crew here to restore.', 'error');
  const plan = restorePlan(then, {
    procs: sup.list(),
    profile: ctx.data?.profile ?? null,
    profiles: Object.keys(ctx.data?.profiles ?? {}),
    git: gitHead(ctx.dir),
    tipOf: (branch) => branchTip(ctx.dir, branch),
  });
  const when = new Date(then.t).toLocaleTimeString();
  const handGit = plan.git && !plan.git.same;
  if (plan.nothing && !handGit) return ctx.note([`The crew is as it was at ${when}.`, ...plan.warnings].join('\n'));
  // The confirm's detail is one line: what it does goes there, what it can't put back above it.
  if (plan.warnings.length) ctx.note(plan.warnings.join('\n'), plan.envChanged.length || plan.missing.length ? 'error' : undefined);
  const ok = await ctx.confirm({
    title: `Restore the crew as it was at ${when}?`,
    detail: planLines({ ...plan, warnings: [] }).join(' · '),
    danger: plan.stop.length > 0,
    options: YES_NO('Yes, restore it'),
  });
  if (!ok) return false;
  ctx.closeOverlays();
  ctx.setView('crew');
  if (!plan.nothing) ctx.activity(`Restored the crew as it was at ${when}${plan.start.length ? `: started ${plan.start.join(', ')}` : ''}${plan.stop.length ? `${plan.start.length ? ';' : ':'} stopped ${plan.stop.join(', ')}` : ''}`);
  if (plan.profile !== undefined) await ctx.setProfile(plan.profile);
  await Promise.all(plan.stop.map((n) => sup.stop(n)));
  if (handGit) {
    ctx.copy(plan.git.line, 'the line for Splice');
    ctx.note(copiedNote('splice', plan.git.line), 'ok');
  }
  if (plan.start.length) await sup.startAll({ only: plan.start });
}

const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** /init: bosun.json from what Bosun worked out, to change from there. */
export function init(ctx) {
  const crew = ctx.data;
  if (crew?.file) return ctx.note(`There's a ${FILE} here already.`);
  const spec = crew?.procs.length ? specFor(crew) : { procs: { web: { run: 'npm run dev', port: 3000 } } };
  writeSpec(ctx.dir, spec);
  ctx.note(`Wrote ${FILE}: give each process its "port" (and "health", a page that says it's well), then /reload.`, 'ok');
  return ctx.reload();
}

/** /accent: a new accent colour, or `default` for the one Bosun comes with. */
export function accent(ctx, value) {
  const v = value.trim();
  if (v !== 'default' && !isColour(v)) return ctx.note('An accent is a colour like #5fafff (or default).', 'error');
  ctx.setConfig((c) => {
    const { accent: _, ...rest } = c;
    return v === 'default' ? rest : { ...c, accent: v };
  });
  setAccent(v === 'default' ? null : v);
  redrawSettings(ctx);
}

/** , and /settings: every setting in a list; ↵ changes the one under the cursor. */
export function settings(ctx, { replace = false, index } = {}) {
  ctx.showPicker(
    {
      title: 'Settings',
      index,
      items: () => settingRows(ctx.config, { file: configFile(), mouse: ctx.mouseAvailable }).map((row) => ({ row, segments: settingSegments(row) })),
      redraw: (at) => settings(ctx, { replace: true, index: at }),
      onPick: (it) => changeSetting(ctx, it.row),
    },
    { replace },
  );
}

/** Shows the settings again after a change, if they're what's on screen. */
export function redrawSettings(ctx) {
  const o = ctx.overlay();
  if (o?.redraw) o.redraw(o.index);
}

async function changeSetting(ctx, row) {
  if (row.action === 'toggle') {
    ctx.setConfig((c) => ({ ...c, [row.id]: c[row.id] === false }));
    return redrawSettings(ctx);
  }
  if (row.action === 'memory') {
    ctx.setConfig((c) => {
      const { memoryAlert: _, ...rest } = c;
      const next = nextMemoryAlert(c.memoryAlert);
      return next ? { ...rest, memoryAlert: next } : rest;
    });
    return redrawSettings(ctx);
  }
  if (row.action === 'accent') return ctx.prefill(`/accent ${ctx.config.accent ?? defaultAccent()}`);
  if (row.action === 'theme') {
    ctx.setConfig((c) => ({ ...c, theme: nextTheme(c) }));
    applyTheme(ctx.config);
    return redrawSettings(ctx);
  }
  if (row.action === 'clear') {
    const ok = await ctx.confirm({ title: `Clear the prompt history (${row.value})?`, options: YES_NO('Yes, clear it') });
    if (!ok) return;
    ctx.setConfig((c) => ({ ...c, [row.id]: [] }));
    redrawSettings(ctx);
  }
}
