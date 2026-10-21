import * as a from './actions.js';
import { WI_VIEW_IDS } from './format.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// They act on what's selected in the current tab (a pull request or work item picked in the Inbox counts too).
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'approve', desc: 'Approve the pull request', run: (ctx) => a.vote(ctx, undefined, 10) },
  { name: 'suggest', desc: 'Approve with suggestions', run: (ctx) => a.vote(ctx, undefined, 5) },
  { name: 'wait', desc: 'Wait for the author', run: (ctx) => a.vote(ctx, undefined, -5) },
  { name: 'reject', desc: 'Reject the pull request (asks first)', run: (ctx) => a.vote(ctx, undefined, -10) },
  { name: 'reset', desc: 'Clear your vote', run: (ctx) => a.vote(ctx, undefined, 0) },
  { name: 'publish', desc: 'Publish the draft pull request for review', run: (ctx) => a.publish(ctx) },
  { name: 'complete', desc: 'Complete (merge) the pull request (asks first)', run: (ctx) => a.complete(ctx) },
  { name: 'autocomplete', desc: 'Turn auto-complete on or off', run: (ctx) => a.autoComplete(ctx) },
  { name: 'comment', args: '<text>', desc: 'Comment on the pull request or work item', run: (ctx, s) => a.comment(ctx, undefined, s) },
  { name: 'pr', args: '<id>', desc: 'Go to a pull request by number', complete: 'prs', run: (ctx, s) => (s ? a.showPr(ctx, s) : ctx.prefill('/pr ')) },
  { name: 'state', args: '[state]', desc: 'Move the work item to another state (a list to pick from)', run: (ctx, s) => a.setState(ctx, undefined, s) },
  { name: 'take', desc: 'Assign the work item to you', run: (ctx) => a.assign(ctx, undefined, 'me') },
  { name: 'assign', args: '<person>', desc: 'Assign the work item to someone (me, or nobody, too)', complete: 'people', run: (ctx, s) => a.assign(ctx, undefined, s) },
  { name: 'unassign', desc: 'Leave the work item unassigned', run: (ctx) => a.assign(ctx, undefined, 'nobody') },
  { name: 'blocked', desc: 'Tag the work item blocked, or take the tag off', run: (ctx) => a.toggleBlocked(ctx) },
  { name: 'priority', args: '<1-4>', desc: "Set the work item's priority", run: (ctx, s) => a.setPriority(ctx, undefined, s) },
  { name: 'new', args: '<type> <title>', desc: "Create a work item in the selected one's project", complete: 'types', run: (ctx, s) => a.newWorkItem(ctx, s) },
  { name: 'wi', args: '<id>', desc: 'Go to a work item by number', complete: 'workitems', run: (ctx, s) => (s ? a.showWorkItem(ctx, s) : ctx.prefill('/wi ')) },
  { name: 'snooze', args: '[2d|1w]', desc: 'Hide the Inbox item for a while (a day by default)', run: (ctx, s) => a.snooze(ctx, undefined, s) },
  { name: 'unsnooze', desc: 'Bring back everything you snoozed', run: (ctx) => a.unsnoozeAll(ctx) },
  { name: 'deploy', args: '[comment]', desc: 'Approve the deployment the Inbox item waits on', run: (ctx, s) => a.decide(ctx, undefined, 'approved', s) },
  { name: 'stop', args: '[comment]', desc: 'Reject the deployment the Inbox item waits on', run: (ctx, s) => a.decide(ctx, undefined, 'rejected', s) },
  { name: 'run', args: '[branch]', desc: 'Run the pipeline (its own branch by default)', run: (ctx, s) => a.runPipeline(ctx, undefined, s) },
  { name: 'cancel', desc: 'Cancel the pipeline run that is queued or running', run: (ctx) => a.cancelRun(ctx) },
  { name: 'open', desc: 'Open the selection in the browser', run: (ctx) => a.open(ctx) },
  { name: 'find', args: '[text]', desc: 'Filter the list by title, repo, branch or person (empty clears it)', run: (ctx, s) => ctx.find(s) },
  { name: 'show', args: '[view]', desc: 'Pull requests: all, review or mine. Work items: all, sprint, bugs, blocked, stuck, unassigned or mine', complete: 'show', run: (ctx, s) => ctx.showGroup(s || 'all') },
  { name: 'summary', args: '[last|-N|date]', desc: "One week's summary: finished, merged, deployed, blocked (this week by default)", run: (ctx, s) => a.showSummary(ctx, s) },
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

function completions(kind, { prs, workItems, view }) {
  if (kind === 'show') return view === 'workitems' ? WI_VIEW_IDS : ['all', 'review', 'mine'];
  if (kind === 'people') return ['me', 'nobody', ...(workItems?.people ?? []).filter((p) => !p.isContainer).map((p) => p.displayName)];
  if (kind === 'types') return [...new Set((workItems?.items ?? []).map((w) => w.type))].sort();
  if (kind === 'workitems') return (workItems?.items ?? []).map((w) => String(w.id));
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
  const titles = new Map(cmd.complete === 'workitems' ? (lists.workItems?.items ?? []).map((w) => [String(w.id), w.title]) : (lists.prs ?? []).map((p) => [String(p.id), p.title]));
  // A work item type is followed by its title, so picking one waits for it.
  const more = cmd.complete === 'types';
  return names.slice(0, 7).map((n) => ({ label: n, desc: ['prs', 'workitems'].includes(cmd.complete) ? titles.get(n) : undefined, insert: `/${cmd.name} ${n}${more ? ' ' : ''}`, run: !more }));
}
