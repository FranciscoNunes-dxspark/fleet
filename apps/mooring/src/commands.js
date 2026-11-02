import * as a from './actions.js';
import { withCommandHint } from '@fleet/kit/commandhint.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'connect', args: '[host]', desc: 'Open a saved host: its files on the right (a list to pick from if none is named)', complete: 'hosts', run: (ctx, s) => a.connect(ctx, s) },
  { name: 'ssh', args: '<command>', desc: 'Type a command into the Console shell on the server (as $ does) and go there', run: (ctx, s) => ctx.runRemote(s) },
  { name: 'disconnect', desc: 'Close the connection (transfers still running are cancelled)', run: (ctx) => a.disconnect(ctx) },
  { name: 'add', args: '<name> <user@host[:port]> [key=<file>] [folder=<remote folder>] [password]', desc: 'Save a host, or change the one of that name. It signs in with the key or your ssh agent; with `password` it asks for one every time it connects (never saved)', run: (ctx, s) => a.addHost(ctx, s) },
  { name: 'keygen', args: '[name] [host]', desc: 'Make an ssh key (ed25519, in ~/.ssh) and copy its public half; with a saved host, that host signs in with it', complete: 'hosts', run: (ctx, s) => a.keygen(ctx, s) },
  { name: 'forget', args: '<host>', desc: 'Take a saved host out of the list (asks first)', complete: 'hosts', run: (ctx, s) => a.forgetHost(ctx, s) },
  { name: 'cd', args: '<folder>', desc: "Go to a folder on the server: a path, .. or ~", run: (ctx, s) => a.cd(ctx, 'remote', s) },
  { name: 'lcd', args: '<folder>', desc: 'Go to a folder on this machine: a path, .. or ~', run: (ctx, s) => a.cd(ctx, 'local', s) },
  { name: 'get', args: '<name>', desc: "Download a file or folder of the server's folder to this machine's", complete: 'remote', run: (ctx, s) => a.transferNamed(ctx, 'remote', s) },
  { name: 'put', args: '<name>', desc: "Upload a file or folder of this machine's folder to the server's", complete: 'local', run: (ctx, s) => a.transferNamed(ctx, 'local', s) },
  { name: 'sync', args: '[down|up|both] [--checksum] [--delete]', desc: "Make the left pane's folder and the right's match (both ways by default): the plan shown, asked, then the queue; --checksum compares sha256 of files differing only in time; deletes only with --delete", complete: 'sync', run: (ctx, s) => a.sync(ctx, s) },
  { name: 'watch', args: '[off]', desc: "Upload what changes in the left pane's folder to the right pane's as it changes, until /watch off", complete: 'off', run: (ctx, s) => a.watch(ctx, s) },
  { name: 'health', desc: "The server's disk use, memory, load, uptime, busiest processes and failed systemd units (alt+h; r reads it again)", run: (ctx) => a.health(ctx) },
  { name: 'mkdir', args: '[name]', desc: "A new folder in the focused pane's folder", run: (ctx, s) => a.mkdir(ctx, ctx.side(), s) },
  { name: 'hidden', args: '[on|off]', desc: 'List files starting with a dot, or not', complete: 'onoff', run: (ctx, s) => a.setHidden(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command on this machine (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'refresh', desc: 'Read both folders again', run: (ctx) => ctx.refresh() },
  { name: 'settings', desc: 'Hosts, hidden files, theme, accent colour, mouse, updates', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Mooring now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Mooring', run: (ctx) => ctx.quit() },
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
  if (kind === 'hosts') return (data?.hosts ?? []).map((h) => h.name);
  if (kind === 'remote') return (data?.panes?.remote.entries ?? []).map((e) => e.name);
  if (kind === 'local') return (data?.panes?.local.entries ?? []).map((e) => e.name);
  if (kind === 'themes') return ['dark', 'light', 'auto'];
  if (kind === 'onoff') return ['on', 'off'];
  if (kind === 'off') return ['off'];
  if (kind === 'sync') return ['both', 'up', 'down', '--checksum', '--delete'];
  return [];
}

function ranked(names, query) {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q)).sort((x, y) => (x.toLowerCase() === q ? -1 : y.toLowerCase() === q ? 1 : 0));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains];
}

// A name with a space in it is typed in quotes, as the prompt splits its arguments.
const quoted = (n) => (/\s/.test(n) ? `"${n}"` : n);

/**
 * What to offer under the prompt for `value`: commands while the name is being typed, then the
 * list a command completes its argument from. `insert` replaces the prompt text; `run` means picking
 * it can run straight away. `data` has `hosts` and `panes`.
 */
function commandCompletions(value, { data, user = [] } = {}) {
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
  const names = ranked([...new Set(completions(cmd.complete, data))], rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${quoted(n)}`, run: true }));
}

/** What to offer under the prompt: names to complete, or else the command's parameters (the kit's `withCommandHint`). */
export const suggestionsFor = (value, opts) => withCommandHint(commandCompletions(value, opts), value, (n) => findCommand(n, opts?.user ?? []));
