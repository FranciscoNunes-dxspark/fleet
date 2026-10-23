// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { configFile } from './config.js';
import { run } from './run.js';
import { nextTheme, settingRows, settingSegments } from './settings.js';
import { applyTheme, defaultAccent, isColour, setAccent, theme } from './theme.js';
import { clip } from './claude-cli.js';
import { FILE, specFor, words, writeSpec } from './crew.js';
import { choices, resolveFolder, samePath } from './projects.js';
import { basename, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { listSessions } from './recorder.js';
import { markCrew } from './ports.js';
import { clock, parseSession } from './replay.js';

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

/** r, R and /restart: one process, or `all`. */
export async function restart(ctx, name) {
  if (String(name).trim() === 'all' || !String(name).trim()) {
    if (!ctx.crew) return;
    ctx.note('Restarting every process');
    await ctx.crew.stopAll();
    return ctx.crew.startAll();
  }
  const p = proc(ctx, name);
  if (!p) return false;
  await ctx.crew.restart(p.name);
}

/** /stop: one process, or `all`. */
export async function stop(ctx, name) {
  if (String(name).trim() === 'all') return ctx.crew?.stopAll();
  const p = proc(ctx, name);
  if (!p) return false;
  await ctx.crew.stop(p.name);
}

/** /start: one process, or `all` (each after the one it waits for). */
export function start(ctx, name) {
  if (String(name).trim() === 'all' || !String(name).trim()) return ctx.crew?.startAll();
  const p = proc(ctx, name);
  if (!p) return false;
  ctx.crew.start(p.name);
}

/** s: stops it when it's running, starts it when it isn't; while it waits to restart, it won't. */
export function toggle(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  if (p.restartAt) return void ctx.crew.cancelRestart(p.name);
  return p.child ? ctx.crew.stop(p.name) : ctx.crew.start(p.name);
}

/** ↵: everything a process has said, in the viewer. */
export function showLog(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  ctx.showText(`${p.name} · ${p.spec.run}`, p.lines.map((l) => l.text).join('\n') || '(nothing yet)', { bottom: true, log: true });
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

/** f and /free: stops whatever holds `port` on this machine, after asking. */
export async function free(ctx, port) {
  const n = Number(String(port ?? '').trim().replace(/^:/, ''));
  if (!Number.isInteger(n) || n < 1 || n > 65535) return ctx.note('Name a port: /free 3000', 'error');
  const pids = ctx.pidsOnPort(n);
  if (!pids.length) return ctx.note(`Nothing is listening on port ${n} (or this machine won't say what is).`);
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
        o: (it) => ctx.openUrl(`http://localhost:${it.port}`),
      },
      onPick: (it) => ctx.openUrl(`http://localhost:${it.port}`),
    },
    { replace },
  );
}

/** o and /open: the process's port in the browser. */
export function openProc(ctx, name) {
  const p = proc(ctx, name);
  if (!p) return false;
  if (!p.port) return ctx.note(`${p.name} has no port: give it one in bosun.json ("port": 3000).`, 'error');
  ctx.openUrl(`http://localhost:${p.port}`);
}

/** The question for w and /why: what the process is and what it said last. */
export function whyPrompt(p) {
  return [
    `"${p.name}" is one of the processes of the project in the current folder, started with: ${p.spec.run}`,
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
