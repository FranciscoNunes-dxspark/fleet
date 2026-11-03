import * as a from './actions.js';
import { withCommandHint } from '@fleet/kit/commandhint.js';
import { folderCompletions } from '@fleet/kit/folders.js';
import { readProject } from '@fleet/kit/environments.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'run', args: '[all|failed|changed|<file>|<test>]', desc: "Run every test, the ones that failed, the ones touching what git says changed, a file's, or the ones whose name has the words", complete: 'run', run: (ctx, s) => a.runCommand(ctx, s) },
  { name: 'failed', desc: 'Run the tests that failed again (as R does)', run: (ctx) => a.runFailed(ctx) },
  { name: 'changed', desc: 'Run the tests touching the files git says changed (as c does)', run: (ctx) => a.runChanged(ctx) },
  { name: 'watch', args: '[on|off]', desc: 'Run the tests touching a file each time one is saved (as w does)', complete: 'onoff', run: (ctx, s) => a.toggleWatch(ctx, s === 'on' ? true : s === 'off' ? false : null) },
  { name: 'flaky', desc: 'The tests that both passed and failed in the last runs', run: (ctx) => ctx.setView('flaky') },
  { name: 'output', desc: "The runners' own output, as they drew it", run: (ctx) => ctx.setView('output') },
  { name: 'runners', desc: 'The suites found, their versions, how each is run and which parser reads it', run: (ctx) => a.runners(ctx) },
  { name: 'find', desc: 'Look for the tests again (package.json, config files, .NET test projects, drill.json)', run: (ctx) => a.load(ctx, { run: false }) },
  { name: 'editor', args: '[command]', desc: 'The editor ↵ on a frame opens the file in (code, subl, idea, vim…); default goes back to EDITOR', complete: 'editors', run: (ctx, s) => a.editor(ctx, s) },
  { name: 'move', args: '[folder]', desc: 'Test another folder: one beside this one or in it, or a path (completed as you type)', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'env', args: '[name]', desc: "The project's environment (.fleet/project.json): alone, which one; a name switches every app to it", complete: 'envs', run: (ctx, s) => a.env(ctx, s) },
  { name: 'take', args: '<family:v1:…>', desc: 'Take what a sibling copied: a test runs again; anything else says whose it is', run: (ctx, s) => a.take(ctx, s) },
  { name: 'shell', args: '<command>', desc: 'Run a shell command in the folder (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, editor, running on start', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Drill now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Drill', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, { run, cwd, typed = '' }) {
  if (kind === 'run') return ['all', 'failed', 'changed', ...new Set((run?.tests ?? []).map((t) => t.file))];
  if (kind === 'editors') return ['code', 'cursor', 'subl', 'zed', 'idea', 'rider', 'webstorm', 'vim', 'nvim', 'default'];
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
