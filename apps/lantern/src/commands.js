import * as a from './actions.js';
import { withCommandHint } from '@fleet/kit/commandhint.js';
import { folderCompletions } from '@fleet/kit/folders.js';
import { readProject } from '@fleet/kit/environments.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'audit', args: '[page|url|all]', desc: 'Measure a page in a headless Chrome (three runs, the median), run axe-core, check its links, headers and certificate; all: every page', complete: 'pages', run: (ctx, s) => (/^all$/i.test(s.trim()) ? a.auditAll(ctx) : a.audit(ctx, s)) },
  { name: 'open', args: '<url>', desc: 'Audit a URL the folder doesn\'t name (kept in the list for this session)', run: (ctx, s) => a.open(ctx, s) },
  { name: 'security', args: '[page|url]', desc: 'Only the checks that need no browser: security headers, cookies, server versions, mixed content, source maps served, the certificate', complete: 'pages', run: (ctx, s) => a.security(ctx, s) },
  { name: 'domains', args: '[host]', desc: 'DNS (A, AAAA, CNAME, CAA, MX), the redirects from http:// and the bare domain, https enforced or not, the certificate\'s days left: every host the pages are on, or one', complete: 'hosts', run: (ctx, s) => a.domains(ctx, s) },
  { name: 'compare', args: '[a] [b|last]', desc: 'The Compare view: the selected page in two environments (names), two URLs, or last: its previous run against its latest', complete: 'envs', run: (ctx, s) => a.compare(ctx, s) },
  { name: 'pages', desc: 'Read the pages from lantern.json and .fleet/project.json again', run: (ctx) => (a.loadPages(ctx), ctx.setView('pages'), true) },
  { name: 'unignore', args: '[rule|all]', desc: 'Put an ignored finding back; alone, says which are ignored', complete: 'ignored', run: (ctx, s) => a.unignore(ctx, s) },
  { name: 'chrome', args: '[path|auto]', desc: 'The browser to drive (Chrome, Edge, Chromium); alone, says which was found', run: (ctx, s) => a.chrome(ctx, s) },
  { name: 'runs', args: '[n]', desc: 'How many times each page is measured (the median is shown; 3 unless set)', run: (ctx, s) => a.runs(ctx, s) },
  { name: 'sarif', args: '[file]', desc: "Every audited page's findings as SARIF for code scanning (lantern.sarif unless named)", run: (ctx, s) => a.sarif(ctx, s) },
  { name: 'report', args: '[file]', desc: 'The audited pages as Markdown, to copy into a pull request or a ticket, or to write to a file', run: (ctx, s) => a.report(ctx, s) },
  { name: 'move', args: '[folder]', desc: 'Read another folder\'s pages: one beside this one or in it, or a path', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'env', args: '[name]', desc: "The project's environment (.fleet/project.json): alone, which one; a name switches every app to it", complete: 'envs', run: (ctx, s) => a.env(ctx, s) },
  { name: 'take', args: '<family:v1:…>', desc: 'Take what a sibling copied: a page (audited); anything else says whose it is', run: (ctx, s) => a.take(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command in the folder (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, the browser, runs per page, what is ignored', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Lantern now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Lantern', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, { pages = [], hosts = [], config = {}, cwd, typed = '' }) {
  if (kind === 'pages') return ['all', ...new Set(pages.map((p) => p.url))];
  if (kind === 'hosts') return hosts;
  if (kind === 'ignored') return ['all', ...(config.ignore ?? [])];
  if (kind === 'envs') return [...new Set([...pages.map((p) => p.env).filter(Boolean), ...((cwd && readProject(cwd)?.names) || [])])];
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

/** What to offer under the prompt for `value`: commands while the name is being typed, then the list a command completes its argument from. */
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
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: !(cmd.complete === 'folders' && /[\\/]$/.test(n)) }));
}

/** What to offer under the prompt: names to complete, or else the command's parameters (the kit's `withCommandHint`). */
export const suggestionsFor = (value, opts) => withCommandHint(commandCompletions(value, opts), value, (n) => findCommand(n));
