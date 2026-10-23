import { basename } from 'node:path';
import * as a from './actions.js';
import { siblings } from './projects.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'restart', args: '[name|all]', desc: 'Restart a process, or all of them', complete: 'procs', run: (ctx, s) => a.restart(ctx, s || 'all') },
  { name: 'stop', args: '<name|all>', desc: 'Stop a process and what it started', complete: 'procs', run: (ctx, s) => a.stop(ctx, s) },
  { name: 'start', args: '[name|all]', desc: 'Start a process, or all that aren\'t running', complete: 'procs', run: (ctx, s) => a.start(ctx, s) },
  { name: 'log', args: '<name>', desc: 'Everything a process has said', complete: 'procs', run: (ctx, s) => a.showLog(ctx, s) },
  { name: 'save-log', args: '<name> [file]', desc: 'Write a process\'s log to a file (name.log unless given)', complete: 'procs', run: (ctx, s) => a.saveLog(ctx, s) },
  { name: 'why', args: '<name>', desc: 'Ask Claude why a process failed, from its log', complete: 'procs', run: (ctx, s) => a.why(ctx, s) },
  { name: 'open', args: '<name>', desc: 'Open a process\'s port in the browser', complete: 'procs', run: (ctx, s) => a.openProc(ctx, s) },
  { name: 'free', args: '<port>', desc: 'Stop whatever holds a port on this machine (asks first)', run: (ctx, s) => a.free(ctx, s) },
  { name: 'profile', args: '[name|none]', desc: 'Run the crew with a profile from bosun.json', complete: 'profiles', run: (ctx, s) => a.profiles(ctx, s) },
  { name: 'reload', desc: 'Read bosun.json and the env files again (what changed restarts)', run: (ctx) => ctx.reload() },
  { name: 'move', args: '[folder]', desc: 'Run another project instead (this one\'s processes stop)', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'replay', desc: 'Play back a recorded session of this project: the crew and logs as they were, crashes marked', run: (ctx) => a.replay(ctx) },
  { name: 'init', desc: 'Write a bosun.json from what Bosun worked out (Procfile, compose, package.json)', run: (ctx) => a.init(ctx) },
  { name: 'run', args: '<command>', desc: 'Run a shell command (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, notifications, recording, updates, history', run: (ctx) => a.settings(ctx) },
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
