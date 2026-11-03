import * as a from './actions.js';
import { withCommandHint } from '@fleet/kit/commandhint.js';
import { folderCompletions } from '@fleet/kit/folders.js';
import { readProject } from '@fleet/kit/environments.js';
import { packageTotals } from './build.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'read', args: '[stats file]', desc: 'Read the build again: its stats file (esbuild, Vite/Rollup visualizer, webpack), or a stats file named, else its output folder', run: (ctx, s) => a.read(ctx, { stats: s.trim() || null }) },
  { name: 'build', desc: 'Build the project once with stats turned on (Vite with source maps into a folder of its own, webpack --json, esbuild --metafile; asks first)', run: (ctx) => a.buildOnce(ctx) },
  { name: 'chunks', desc: 'The Chunks view: every file the build ships, raw, gzip and brotli', run: (ctx) => ctx.setView('chunks') },
  { name: 'modules', args: '[file]', desc: 'The Modules view: what is inside a chunk (or all of them), biggest first, packages grouped', complete: 'chunks', run: (ctx, s) => ctx.showModules(s.trim() || null) },
  { name: 'duplicates', desc: 'The Duplicates view: packages bundled at two versions, or twice through two paths', run: (ctx) => ctx.setView('duplicates') },
  { name: 'compare', args: '[last|main|<ref>]', desc: 'This build against the last one read, or a branch\'s or commit\'s (built in a git worktree when it isn\'t kept; asks first)', complete: 'bases', run: (ctx, s) => a.compare(ctx, s.trim() || 'last') },
  { name: 'markdown', desc: 'The comparison as Markdown, for a pull request (alt+y copies it all)', run: (ctx) => a.markdown(ctx) },
  { name: 'check', desc: 'The budgets and the growth, as ballast check sees them', run: (ctx) => a.check(ctx) },
  { name: 'budgets', desc: 'The budgets, and where they come from (ballast.json, or package.json\'s fleet.ballast)', run: (ctx) => a.budgets(ctx) },
  { name: 'why', args: '<package>', desc: 'A bundled package: its size, copies, what brings each in, its licence and its advisories (OSV)', complete: 'packages', run: (ctx, s) => a.packageDetail(ctx, s) },
  { name: 'security', desc: 'The output folders read for source maps shipped and secrets in the bundles', run: (ctx) => a.security(ctx) },
  { name: 'measure', args: '[gzip|brotli|raw]', desc: 'What sizes are shown and compared in', complete: 'measures', run: (ctx, s) => a.measure(ctx, s) },
  { name: 'move', args: '[folder]', desc: 'Read another folder: one beside this one or in it, or a path (completed as you type)', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'env', args: '[name]', desc: "The project's environment (.fleet/project.json): alone, which one; a name switches every app to it", complete: 'envs', run: (ctx, s) => a.env(ctx, s) },
  { name: 'take', args: '<family:v1:…>', desc: 'Ballast takes no context: says whose a pasted one is', run: (ctx, s) => a.take(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command in the folder (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, measure, what is ignored', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Ballast now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Ballast', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, { data, cwd, typed = '' }) {
  if (kind === 'packages') return packageTotals(data?.build?.chunks ?? []).map((p) => p.name);
  if (kind === 'chunks') return (data?.build?.chunks ?? []).filter((c) => c.modules.length).map((c) => c.file);
  if (kind === 'bases') return ['last', 'main'];
  if (kind === 'measures') return ['gzip', 'brotli', 'raw'];
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
