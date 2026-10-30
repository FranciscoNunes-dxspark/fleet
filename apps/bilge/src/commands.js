import * as a from './actions.js';
import { folderCompletions } from '@fleet/kit/folders.js';
import { FILTERS } from './rows.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'scan', desc: 'Read the folder\'s lock files and projects again, then ask OSV about them', run: (ctx) => a.scan(ctx) },
  { name: 'audit', desc: 'Ask OSV (osv.dev) for the advisories against every package found', run: (ctx) => a.audit(ctx) },
  { name: 'outdated', args: '[all]', desc: 'Ask npm and NuGet for the newest versions and the licences of the direct packages (all: every package)', complete: 'outdated', run: (ctx, s) => a.outdated(ctx, s) },
  { name: 'fix', args: '<package|advisory>', desc: 'Move a vulnerable package to the version that fixes it (npm install, npm update or dotnet add; asks first)', complete: 'findings', run: (ctx, s) => a.fix(ctx, s) },
  { name: 'why', args: '<package>', desc: 'Where a package is, its licence, newest version and advisories', complete: 'packages', run: (ctx, s) => a.why(ctx, s) },
  { name: 'ignore', args: '<advisory|package>', desc: 'Leave an advisory out of the list and the counts (asks; kept in the settings)', complete: 'advisories', run: (ctx, s) => a.ignore(ctx, s) },
  { name: 'unignore', args: '[advisory|all]', desc: 'Put an ignored advisory back; alone, says which are ignored', complete: 'ignored', run: (ctx, s) => a.unignore(ctx, s) },
  { name: 'deny', args: '[licence…|none]', desc: 'The licences to flag (SPDX ids, or their start: GPL- for every GPL); alone, says which', run: (ctx, s) => a.deny(ctx, s) },
  { name: 'packages', args: '[all|direct|outdated|flagged]', desc: 'The Packages view, showing those', complete: 'filters', run: (ctx, s) => ctx.showPackages({ filter: FILTERS.includes(s) ? s : 'all' }) },
  { name: 'sbom', args: '[file]', desc: 'Write a CycloneDX bill of materials (sbom.cdx.json in the folder unless named)', run: (ctx, s) => a.sbom(ctx, s) },
  { name: 'report', desc: 'The audit as Markdown, to copy into a pull request or a ticket', run: (ctx) => a.report(ctx) },
  { name: 'move', args: '[folder]', desc: 'Read another folder: one beside this one or in it, or a path (completed as you type)', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'take', args: '<family:v1:…>', desc: 'Take what a sibling copied (Bilge takes nothing yet, and says whose it is)', run: (ctx, s) => a.take(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command in the folder (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, audit on start, what is ignored and flagged', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Bilge now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Bilge', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, { data, found = [], config = {}, cwd, typed = '' }) {
  if (kind === 'packages') return [...new Set((data?.packages ?? []).map((p) => p.name))];
  if (kind === 'findings') return found.map((f) => f.pkg.name);
  if (kind === 'advisories') return [...new Set(found.flatMap((f) => f.advisories.map((x) => x.id)))];
  if (kind === 'ignored') return ['all', ...(config.ignore ?? [])];
  if (kind === 'filters') return FILTERS;
  if (kind === 'outdated') return ['all'];
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
export function suggestionsFor(value, state = {}) {
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
