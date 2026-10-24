import * as a from './actions.js';
import { sqlByLabel } from './tree.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'kql', args: '<query>', desc: 'Run a query in Logs, against the Application Insights in scope', run: (ctx, s) => a.runQuery(ctx, s) },
  { name: 'queries', args: '[name]', desc: 'Your saved queries (s in Logs saves one): pick one to run, or name it', complete: 'queries', run: (ctx, s) => a.savedQueries(ctx, s) },
  { name: 'chart', desc: 'Draw the result in Logs as a chart (a time series as sparklines, names as bars), or as the grid again', run: (ctx) => a.toggleChart(ctx) },
  { name: 'export', args: '<file>', desc: "Save the grid in Logs to a file: .csv, .json or .md (a Markdown table)", run: (ctx, s) => a.exportResult(ctx, s) },
  { name: 'sub', args: '[name]', desc: 'Another subscription (a list to pick from if none is named)', complete: 'subscriptions', run: (ctx, s) => a.chooseSubscription(ctx, s) },
  { name: 'insights', args: '[name]', desc: 'The Application Insights that Logs and Problems look in, or a Log Analytics workspace for Logs to query', complete: 'components', run: (ctx, s) => a.chooseComponent(ctx, s) },
  { name: 'find', args: '[text]', desc: 'Show only the apps whose name or resource group has the text in it (none: all of them)', run: (ctx, s) => (ctx.setFilter(s.trim()), ctx.setView('resources')) },
  { name: 'appsettings', args: '[app]', desc: "An app's or slot's settings, to see, edit or compare", complete: 'targets', run: (ctx, s) => a.showSettings(ctx, s) },
  { name: 'compare', args: '[app]', desc: "How a slot's settings differ from another slot's of the same app", complete: 'targets', run: (ctx, s) => a.compareSettings(ctx, s) },
  { name: 'restart', args: '[app]', desc: 'Restart an app or slot (asks first; production asks for its name)', complete: 'targets', run: (ctx, s) => a.restart(ctx, s) },
  { name: 'stop', args: '[app]', desc: 'Stop an app or slot (asks first)', complete: 'targets', run: (ctx, s) => a.toggleRunning(ctx, s, 'stop') },
  { name: 'start', args: '[app]', desc: 'Start a stopped app or slot', complete: 'targets', run: (ctx, s) => a.toggleRunning(ctx, s, 'start') },
  { name: 'swap', args: '[app/slot]', desc: 'Swap a slot into production (asks for the app\'s name)', complete: 'targets', run: (ctx, s) => a.swap(ctx, s) },
  { name: 'functions', args: '[app]', desc: "A function app's functions: trigger, on or off, runs and failures over the span; ↵ runs in Logs, i invokes, d turns off/on", complete: 'targets', run: (ctx, s) => a.functions(ctx, s) },
  { name: 'scale', args: '<[app] instances | tier>', desc: "Scale the App Service plan an app runs on: so many instances, or a tier such as P1v3 (asks first; says which apps share it)", run: (ctx, s) => a.scale(ctx, s) },
  { name: 'route', args: '<app> <slot> <percent>', desc: "Send a share of an app's production traffic to a slot (testing in production); 0 stops it (asks first)", run: (ctx, s) => a.route(ctx, s) },
  { name: 'deployments', args: '[app]', desc: "An app's or slot's deployments: who, when, how it went; ↵ shows one's log", complete: 'targets', run: (ctx, s) => a.deployments(ctx, s) },
  { name: 'trawl', args: '[server/db]', desc: "Copy a command that opens a SQL database (or server) in Trawl, to paste into Trawl's prompt (checks the firewall first)", complete: 'sql', run: (ctx, s) => a.openInTrawl(ctx, s) },
  { name: 'firewall', args: '[server]', desc: "Let this machine's address through a SQL server's firewall (asks first)", complete: 'sqlservers', run: (ctx, s) => a.firewall(ctx, s) },
  { name: 'portal', args: '[app]', desc: 'Open an app or slot (or whatever is under the cursor in Resources) in the Azure portal', complete: 'targets', run: (ctx, s) => a.openInPortal(ctx, s.trim() ? a.targetNamed(ctx, s) : ctx.selectedResource()) },
  { name: 'why', args: '[problem]', desc: "Ask Claude why a problem happens, from its latest occurrence (and the code, when Sonar runs in the app's folder)", complete: 'problems', run: (ctx, s) => a.why(ctx, s) },
  { name: 'incident', args: '[problem | save <file>]', desc: 'A problem as an incident: when, how often, the deployments before it, its latest occurrence, failing SQL, commits to its files; save writes the write-up', complete: 'problems', run: (ctx, s) => a.incident(ctx, s) },
  { name: 'compare-window', args: '[deploy | <time>]', desc: 'Two equal windows before and after the latest deployment (or a time, or the middle of the span): exceptions new, gone or twice as frequent, dependencies slower, operations failing more', run: (ctx, s) => a.compareWindow(ctx, s) },
  { name: 'watch', args: '<name> <threshold> <kql>', desc: 'Pin a query whose first value is a number, run every few minutes against the Application Insights in scope; going over the threshold notifies', run: (ctx, s) => a.watch(ctx, s) },
  { name: 'watches', desc: 'Your watches and what they said last: ↵ runs one in Logs, x removes it', run: (ctx) => a.watches(ctx) },
  { name: 'take', args: '<context>', desc: "What another app copied for Sonar: a commit's deployments, problems like an exception, a log line's request", run: (ctx, s) => a.take(ctx, s) },
  { name: 'family', desc: 'What this folder is to the other apps (its checkout, processes, .http files, databases): ↵ copies a line for one\'s prompt', run: (ctx) => a.family(ctx) },
  { name: 'run', args: '<command>', desc: 'Run a shell command (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, updates, notifications, watches, family moods, history', run: (ctx) => a.settings(ctx) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Sonar now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Sonar', run: (ctx) => ctx.quit() },
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

function completions(kind, data, targets, problems, queries) {
  if (kind === 'queries') return queries ?? [];
  if (kind === 'sql') return Object.keys(sqlByLabel(data?.sqlServers));
  if (kind === 'sqlservers') return (data?.sqlServers ?? []).map((s) => s.name);
  if (kind === 'problems') return (problems ?? []).map((p) => p.problemId);
  if (kind === 'subscriptions') return (data?.subscriptions ?? []).map((s) => s.name);
  if (kind === 'components') return [...(data?.components ?? []), ...(data?.workspaces ?? [])].map((c) => c.name);
  if (kind === 'targets') return Object.keys(targets ?? {});
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
export function suggestionsFor(value, { data, targets, problems, queries, user = [] } = {}) {
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
  const names = ranked(completions(cmd.complete, data, targets, problems, queries), rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: true }));
}
