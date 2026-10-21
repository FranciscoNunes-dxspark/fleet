import * as a from './actions.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// They act on what's selected in the current tab (a pull request picked in the Inbox counts too).
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'approve', desc: 'Approve the pull request', run: (ctx) => a.vote(ctx, undefined, 10) },
  { name: 'suggest', desc: 'Approve with suggestions', run: (ctx) => a.vote(ctx, undefined, 5) },
  { name: 'wait', desc: 'Wait for the author', run: (ctx) => a.vote(ctx, undefined, -5) },
  { name: 'reject', desc: 'Reject the pull request (asks first)', run: (ctx) => a.vote(ctx, undefined, -10) },
  { name: 'reset', desc: 'Clear your vote', run: (ctx) => a.vote(ctx, undefined, 0) },
  { name: 'complete', desc: 'Complete (merge) the pull request (asks first)', run: (ctx) => a.complete(ctx) },
  { name: 'autocomplete', desc: 'Turn auto-complete on or off', run: (ctx) => a.autoComplete(ctx) },
  { name: 'comment', args: '<text>', desc: 'Comment on the pull request', run: (ctx, s) => a.comment(ctx, undefined, s) },
  { name: 'pr', args: '<id>', desc: 'Go to a pull request by number', complete: 'prs', run: (ctx, s) => (s ? a.showPr(ctx, s) : ctx.prefill('/pr ')) },
  { name: 'snooze', args: '[2d|1w]', desc: 'Hide the Inbox item for a while (a day by default)', run: (ctx, s) => a.snooze(ctx, undefined, s) },
  { name: 'unsnooze', desc: 'Bring back everything you snoozed', run: (ctx) => a.unsnoozeAll(ctx) },
  { name: 'deploy', args: '[comment]', desc: 'Approve the deployment the Inbox item waits on', run: (ctx, s) => a.decide(ctx, undefined, 'approved', s) },
  { name: 'stop', args: '[comment]', desc: 'Reject the deployment the Inbox item waits on', run: (ctx, s) => a.decide(ctx, undefined, 'rejected', s) },
  { name: 'run', args: '[branch]', desc: 'Run the pipeline (its own branch by default)', run: (ctx, s) => a.runPipeline(ctx, undefined, s) },
  { name: 'cancel', desc: 'Cancel the pipeline run that is queued or running', run: (ctx) => a.cancelRun(ctx) },
  { name: 'open', desc: 'Open the selection in the browser', run: (ctx) => a.open(ctx) },
  { name: 'find', args: '[text]', desc: 'Filter the list by title, repo, branch or person (empty clears it)', run: (ctx, s) => ctx.find(s) },
  { name: 'show', args: '[all|review|mine]', desc: 'Pull requests: everything, waiting on your review, or yours', complete: 'show', run: (ctx, s) => ctx.showGroup(s || 'all') },
  { name: 'settings', desc: 'Projects and repos to follow, merge defaults, organizations, updates', run: (ctx) => ctx.showSettings() },
  { name: 'addorg', args: '<address> [--github]', desc: 'Add an Azure DevOps organization or a GitHub owner', run: (ctx, s) => a.addOrg(ctx, s) },
  { name: 'logout', desc: 'Sign this terminal out of your Keel server', run: (ctx) => a.logout(ctx) },
  { name: 'refresh', desc: 'Ask Azure DevOps again now', run: (ctx) => ctx.refresh() },
  { name: 'last', desc: 'Show the full output of the last action', run: (ctx) => ctx.showLast() },
  { name: 'log', desc: 'Warnings from Azure DevOps calls', run: (ctx) => ctx.showLog() },
  { name: 'help', desc: 'Keyboard shortcuts', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Keel', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, { prs }) {
  if (kind === 'show') return ['all', 'review', 'mine'];
  return (prs ?? []).map((p) => String(p.id));
}

function ranked(names, query) {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q)).sort((x, y) => (x.toLowerCase() === q ? -1 : y.toLowerCase() === q ? 1 : 0));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/**
 * What to offer under the prompt for `value`: commands while the name is being typed, then pull
 * request numbers or groups for commands that complete their argument. `insert` replaces the
 * prompt text; `run` means picking it can run straight away.
 */
export function suggestionsFor(value, lists) {
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
  if (!cmd?.complete || rest.includes(' ')) return [];
  const names = ranked(completions(cmd.complete, lists), rest);
  if (names.length === 1 && names[0] === rest) return [];
  const titles = new Map((lists.prs ?? []).map((p) => [String(p.id), p.title]));
  return names.slice(0, 7).map((n) => ({ label: n, desc: cmd.complete === 'prs' ? titles.get(n) : undefined, insert: `/${cmd.name} ${n}`, run: true }));
}
