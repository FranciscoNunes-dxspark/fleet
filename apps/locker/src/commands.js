import * as a from './actions.js';
import { label } from './azure/arm.js';
import { folderCompletions } from '@fleet/kit/folders.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'app', args: '[app|app/slot|none]', desc: 'The App Service app or slot whose settings the drift view compares (a list to pick from if none is named)', complete: 'sites', run: (ctx, s) => a.chooseApp(ctx, s) },
  { name: 'vault', args: '[name|none]', desc: 'The key vault the drift view compares and the Vault view lists', complete: 'vaults', run: (ctx, s) => a.chooseVault(ctx, s) },
  { name: 'sub', args: '[name]', desc: 'Another subscription (a list to pick from if none is named)', complete: 'subscriptions', run: (ctx, s) => a.chooseSubscription(ctx, s) },
  { name: 'columns', desc: 'Which sources are columns in the drift view', run: (ctx) => a.chooseColumns(ctx) },
  { name: 'only', args: '[all|diff|missing]', desc: 'The drift view\'s rows: all, only those that differ or are broken, only those a source lacks', complete: 'filters', run: (ctx, s) => ctx.setFilter(s || 'all') },
  { name: 'set', args: '[secret]', desc: 'Set a secret in the vault, typed hidden (a new version of one there, or a new one); asks first', complete: 'secrets', run: (ctx, s) => a.setSecret(ctx, s) },
  { name: 'disable', args: '<secret>', desc: 'Disable a secret in the vault, or enable a disabled one (asks first)', complete: 'secrets', run: (ctx, s) => a.toggleSecret(ctx, ctx.findSecret(s)) },
  { name: 'expiry', args: '[days]', desc: 'How many days ahead a secret or certificate counts as expiring (30)', run: (ctx, s) => a.setExpiryDays(ctx, s) },
  { name: 'clear-after', args: '[seconds]', desc: 'How long a copied value stays on the clipboard (30; 0 leaves it)', run: (ctx, s) => a.setClearAfter(ctx, s) },
  { name: 'sonar', desc: 'Copy the app for Sonar: /appsettings there', run: (ctx) => a.toSonar(ctx) },
  { name: 'take', args: '<family:v1:…>', desc: 'Take what a sibling copied: an app from Sonar opens in the drift view', run: (ctx, s) => a.take(ctx, s) },
  { name: 'family', desc: 'What this folder is to the other apps (its checkout, processes, .http files, databases, the app): ↵ copies a line for one\'s prompt', run: (ctx) => a.family(ctx) },
  { name: 'wiring', desc: 'What this folder points at: addresses, hosts, ports and connection strings, by file (secrets masked)', run: (ctx) => a.wiring(ctx) },
  { name: 'timeline', desc: "What the family's apps did that changed something, newest first: p this project only or all", run: (ctx) => a.timeline(ctx) },
  { name: 'run', args: '<command>', desc: 'Run a shell command (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'move', args: '[folder]', desc: 'Read another folder\'s settings instead: a path, or a folder beside this one (completed as you type); alone, the folders read lately and the ones beside this one', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'refresh', desc: 'Read the folder, the app and the vault again', run: (ctx) => ctx.refresh() },
  { name: 'settings', desc: 'App, vault, expiry, clipboard, theme, accent colour, mouse, updates', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Locker now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Locker', run: (ctx) => ctx.quit() },
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

function completions(kind, data, typed = '') {
  if (kind === 'sites') return [...(data?.azure?.sites ?? []).map(label), 'none'];
  if (kind === 'vaults') return [...(data?.azure?.vaults ?? []).map((v) => v.name), 'none'];
  if (kind === 'subscriptions') return (data?.azure?.subscriptions ?? []).map((s) => s.name);
  if (kind === 'secrets') return (data?.vaultData?.secrets ?? []).map((s) => s.name);
  if (kind === 'filters') return ['all', 'diff', 'missing'];
  if (kind === 'themes') return ['dark', 'light', 'auto'];
  if (kind === 'onoff') return ['on', 'off'];
  // The folders beside this one, by name, as /move takes them.
  if (kind === 'folders') return data?.dir ? folderCompletions(data.dir, typed) : [];
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
  const names = ranked([...new Set(completions(cmd.complete, data, rest))], rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: !(cmd.complete === 'folders' && /[\\/]$/.test(n)) }));
}
