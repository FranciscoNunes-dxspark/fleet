import * as a from './actions.js';
import { withCommandHint } from '@fleet/kit/commandhint.js';
import { folderCompletions } from '@fleet/kit/folders.js';
import { readProject } from '@fleet/kit/environments.js';
import { hosts } from './exchange.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'start', args: '[port]', desc: 'Listen on 127.0.0.1 (this machine only), on the setting\'s port (8888) or this one', run: (ctx, s) => a.start(ctx, s) },
  { name: 'stop', desc: 'Stop listening (what was captured stays)', run: (ctx) => a.stop(ctx) },
  { name: 'pause', desc: 'Pass traffic on without recording it, or record again (space)', run: (ctx) => a.pause(ctx) },
  { name: 'intercept', args: '[on|off]', desc: 'Read HTTPS through a certificate authority of Lookout\'s own (made once, asked first), or pass it through as tunnels', complete: 'onoff', run: (ctx, s) => a.intercept(ctx, s) },
  { name: 'ca', desc: 'The certificate authority: where it is, its fingerprint and how to trust it on each system', run: (ctx) => a.ca(ctx) },
  { name: 'pass', args: '[host]', desc: 'Pass a host (or *.example.com) through untouched, for clients that pin certificates; alone, the list', complete: 'hosts', run: (ctx, s) => a.pass(ctx, s) },
  { name: 'unpass', args: '<host|all>', desc: 'Intercept a passed-through host again', complete: 'passed', run: (ctx, s) => a.unpass(ctx, s) },
  { name: 'filter', args: '[words…]', desc: 'Show only matching requests: host:api status:4xx method:post and words in the URL, headers or bodies; alone, all', complete: 'filters', run: (ctx, s) => a.filter(ctx, s) },
  { name: 'hail', args: '[file.http]', desc: 'Write the request under the cursor to a .http file (lookout.http) with credentials as {{variables}}, and open it in Hail (h)', run: (ctx, s) => a.hail(ctx, ctx.selected(), s) },
  { name: 'export', args: '[file.har] [secrets]', desc: 'The requests shown as a HAR file; credentials masked unless you add secrets (asked first)', run: (ctx, s) => a.exportHar(ctx, s) },
  { name: 'import', args: '<file.har>', desc: 'Add the requests of a HAR file (a browser\'s DevTools export, or Lookout\'s)', run: (ctx, s) => a.importHar(ctx, s) },
  { name: 'clear', desc: 'Forget what was captured (asks first)', run: (ctx) => a.clear(ctx) },
  { name: 'security', desc: 'What the traffic says: tokens over plain HTTP, cookies without Secure, credentials in URLs', run: (ctx) => ctx.setView('security') },
  { name: 'port', args: '[n]', desc: 'The port to listen on (kept); listening again on it when listening', run: (ctx, s) => a.port(ctx, s) },
  { name: 'maxbody', args: '[MB]', desc: 'The most of each body kept (1 MB unless set); the rest still passes', run: (ctx, s) => a.maxBody(ctx, s) },
  { name: 'move', args: '[folder]', desc: 'Write .http files and HAR exports in another folder: one beside this one or in it, or a path', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'env', args: '[name]', desc: "The project's environment (.fleet/project.json): alone, which one; a name switches every app to it", complete: 'envs', run: (ctx, s) => a.env(ctx, s) },
  { name: 'take', args: '<family:v1:…>', desc: 'Lookout takes nothing from its siblings: says whose a pasted context is', run: (ctx, s) => a.takeContext(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command in the folder (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Port, HTTPS, the pass-through list, the body limit, theme, accent, mouse', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Lookout now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Lookout', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, { exchanges = [], config = {}, cwd, typed = '' }) {
  if (kind === 'hosts') return hosts(exchanges).map((h) => h.host);
  if (kind === 'passed') return ['all', ...(config.passThrough ?? [])];
  if (kind === 'filters') return ['status:4xx', 'status:5xx', 'status:error', 'status:refused', 'method:post', ...hosts(exchanges).map((h) => `host:${h.host}`)];
  if (kind === 'envs') return (cwd && readProject(cwd)?.names) || [];
  if (kind === 'folders') return cwd ? folderCompletions(cwd, typed) : [];
  if (kind === 'themes') return ['dark', 'light', 'auto'];
  if (kind === 'onoff') return ['on', 'off'];
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
function commandCompletions(value, state = {}) {
  if (!value.startsWith('/')) return [];
  const space = value.indexOf(' ');
  if (space < 0) {
    const names = ranked(COMMANDS.map((c) => c.name), value.slice(1));
    return names.slice(0, 7).map((name) => {
      const c = COMMANDS.find((x) => x.name === name);
      const optional = !c.args || c.args.startsWith('[');
      return { label: `/${c.name}`, hint: c.args ?? '', desc: c.desc, insert: `/${c.name}${optional ? '' : ' '}`, run: optional };
    });
  }
  const cmd = findCommand(value.slice(1, space));
  const rest = value.slice(space + 1);
  if (!cmd?.complete) return [];
  const names = ranked([...new Set(completions(cmd.complete, { ...state, typed: rest }))], rest);
  if (names.length === 1 && names[0] === rest) return [];
  // A folder ending in a separator goes a level deeper rather than running.
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: !(cmd.complete === 'folders' && /[\\/]$/.test(n)) }));
}

/** What to offer under the prompt: names to complete, or else the command's parameters (the kit's `withCommandHint`). */
export const suggestionsFor = (value, opts) => withCommandHint(commandCompletions(value, opts), value, (n) => findCommand(n));
