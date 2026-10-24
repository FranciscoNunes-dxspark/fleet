import { basename } from 'node:path';
import * as a from './actions.js';
import { siblings } from './projects.js';
import { groupsOf } from './groups.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'restart', args: '[name|group|all]', desc: 'Restart a process, a group, or all of them', complete: 'targets', run: (ctx, s) => a.restart(ctx, s || 'all') },
  { name: 'stop', args: '<name|group|all>', desc: 'Stop a process (or a group) and what it started', complete: 'targets', run: (ctx, s) => a.stop(ctx, s) },
  { name: 'start', args: '[name|group|all]', desc: 'Start a process, a group, or all that aren\'t running', complete: 'targets', run: (ctx, s) => a.start(ctx, s) },
  { name: 'log', args: '<name>', desc: 'Everything a process has said', complete: 'procs', run: (ctx, s) => a.showLog(ctx, s) },
  { name: 'save-log', args: '<name> [file]', desc: 'Write a process\'s log to a file (name.log unless given)', complete: 'procs', run: (ctx, s) => a.saveLog(ctx, s) },
  { name: 'why', args: '<name>', desc: 'Ask Claude why a process failed, from its log', complete: 'procs', run: (ctx, s) => a.why(ctx, s) },
  { name: 'open', args: '<name>', desc: 'Open a process\'s port in the browser', complete: 'procs', run: (ctx, s) => a.openProc(ctx, s) },
  { name: 'tunnel', args: '<name>', desc: 'Open a process\'s port to the internet through cloudflared or ngrok (asks first), or close its tunnel', complete: 'procs', run: (ctx, s) => a.tunnel(ctx, s) },
  { name: 'free', args: '<port>', desc: 'Stop whatever holds a port on this machine (asks first)', run: (ctx, s) => a.free(ctx, s) },
  { name: 'preflight', desc: 'Check what the crew needs: Node version, Docker, free ports, .env keys, databases, node_modules', run: (ctx) => a.preflight(ctx) },
  { name: 'ports', desc: 'The TCP ports listening on this machine, with what holds each (this crew\'s marked): f frees one, o opens it', run: (ctx) => a.ports(ctx) },
  { name: 'graph', desc: 'Who starts after whom ("after" in bosun.json), as a tree', run: (ctx) => a.graph(ctx) },
  { name: 'top', desc: 'Every process\'s CPU and memory (with what it started), the busiest first, and the last minute of each', run: (ctx) => a.top(ctx) },
  { name: 'profile', args: '[name|none]', desc: 'Run the crew with a profile from bosun.json', complete: 'profiles', run: (ctx, s) => a.profiles(ctx, s) },
  { name: 'reload', desc: 'Read bosun.json and the env files again (what changed restarts)', run: (ctx) => ctx.reload() },
  { name: 'move', args: '[folder]', desc: 'Run another project instead (this one\'s processes stop)', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'replay', desc: 'Play back a recorded session of this project: the crew and logs as they were, crashes marked', run: (ctx) => a.replay(ctx) },
  { name: 'init', desc: 'Write a bosun.json from what Bosun worked out (Procfile, compose, package.json)', run: (ctx) => a.init(ctx) },
  { name: 'take', args: '<family:v1:…>', desc: 'Take what a sibling app copied: a log line or exception is looked for in the crew\'s logs', run: (ctx, s) => a.take(ctx, s) },
  { name: 'family', desc: 'What this project offers Splice, Hail and Trawl, as lines to paste into them', run: (ctx) => a.family(ctx) },
  { name: 'timeline', desc: 'What the family\'s apps did here, newest first (p: every project\'s); ↵ shows one whole', run: (ctx) => a.timeline(ctx) },
  { name: 'wiring', desc: 'What this project points at (addresses, hosts, ports, connection strings, passwords masked), by file', run: (ctx) => a.wiring(ctx) },
  { name: 'run', args: '<command>', desc: 'Run a shell command (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, notifications, memory alert, recording, family moods, updates, history', run: (ctx) => a.settings(ctx) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Bosun now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Bosun', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one; `user` are your own commands (usercommands.js), after the built-in ones. */
export function findCommand(name, user = []) {
  const n = name.toLowerCase();
  const all = [...COMMANDS, ...user];
  const exact = all.find((c) => c.name === n);
  if (exact) return exact;
  const matches = all.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, data) {
  if (kind === 'procs') return [...(data?.procs ?? []).map((p) => p.name), 'all'];
  if (kind === 'targets') return [...(data?.procs ?? []).map((p) => p.name), ...groupsOf(data?.procs ?? []).filter((g) => !(data?.procs ?? []).some((p) => p.name === g)), 'all'];
  if (kind === 'profiles') return [...Object.keys(data?.profiles ?? {}), 'none'];
  // The projects beside this one, by name, as /move takes them.
  if (kind === 'folders') return data?.dir ? siblings(data.dir).map((d) => basename(d)).filter((n) => n !== basename(data.dir)) : [];
  return [];
}

function ranked(names, query) {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q)).sort((x, y) => (x.toLowerCase() === q ? -1 : y.toLowerCase() === q ? 1 : 0));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/**
 * What to offer under the prompt for `value`: commands while the name is being typed, then the
 * list a command completes its argument from. `insert` replaces the prompt text; `run` means picking
 * it can run straight away.
 */
export function suggestionsFor(value, { data, user = [] } = {}) {
  if (!value.startsWith('/')) return [];
  const space = value.indexOf(' ');
  const all = [...COMMANDS, ...user];
  if (space < 0) {
    const names = ranked(all.map((c) => c.name), value.slice(1));
    return names.slice(0, 7).map((name) => {
      const c = all.find((x) => x.name === name);
      const optional = !c.args || c.args.startsWith('[');
      return { label: `/${c.name}`, hint: c.args ?? '', desc: c.desc, insert: `/${c.name}${optional ? '' : ' '}`, run: optional };
    });
  }
  const cmd = findCommand(value.slice(1, space), user);
  const rest = value.slice(space + 1);
  if (!cmd?.complete) return [];
  const names = ranked(completions(cmd.complete, data), rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: true }));
}
