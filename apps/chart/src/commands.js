import * as a from './actions.js';
import { folderCompletions } from '@fleet/kit/folders.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'plan', args: '[folder]', desc: 'terraform (or tofu) plan: what it would change, and what drifted (nothing is applied)', complete: 'tfdirs', run: (ctx, s) => a.plan(ctx, s) },
  { name: 'drift', args: '[folder]', desc: 'A refresh-only plan: what changed outside Terraform since the last apply', complete: 'tfdirs', run: (ctx, s) => a.drift(ctx, s) },
  { name: 'state', args: '[folder]', desc: 'Every resource Terraform keeps track of, by module', complete: 'tfdirs', run: (ctx, s) => a.state(ctx, s) },
  { name: 'init', args: '[folder]', desc: 'terraform init, which a folder needs before its first plan', complete: 'tfdirs', run: (ctx, s) => a.init(ctx, s) },
  { name: 'whatif', args: '[file] [--rg group | --location region] [--params file]', desc: 'What deploying a Bicep or ARM file would change, as az deployment what-if says (the last one again, alone)', complete: 'bicep', run: (ctx, s) => a.whatIf(ctx, s) },
  { name: 'open', args: '[file]', desc: 'A saved plan or state (terraform show -json) or a what-if result', complete: 'saved', run: (ctx, s) => a.open(ctx, s) },
  { name: 'show', args: '<address>', desc: 'A change, attribute by attribute', complete: 'changes', run: (ctx, s) => a.show(ctx, s) },
  { name: 'report', desc: 'The plan as Markdown, to copy into a pull request', run: (ctx) => a.report(ctx) },
  { name: 'tool', args: '[terraform|tofu]', desc: 'Which one Chart runs', complete: 'tools', run: (ctx, s) => a.tool(ctx, s) },
  { name: 'move', args: '[folder]', desc: 'Look at another folder: one beside this one or in it, or a path (completed as you type)', complete: 'folders', run: (ctx, s) => a.move(ctx, s) },
  { name: 'take', args: '<family:v1:…>', desc: 'Take what a sibling copied (Chart takes nothing yet, and says whose it is)', run: (ctx, s) => a.take(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command in the folder (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, terraform or tofu, the last what-if', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Chart now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Chart', run: (ctx) => ctx.quit() },
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
  if (kind === 'tfdirs') return data?.found?.tfDirs ?? [];
  if (kind === 'bicep') return data?.found?.bicep ?? [];
  if (kind === 'saved') return data?.found?.saved ?? [];
  if (kind === 'changes') return [...(data?.plan?.changes ?? []), ...(data?.drift ?? [])].map((c) => c.address);
  if (kind === 'tools') return ['terraform', 'tofu'];
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
  // Only the first argument is completed: a what-if's options are typed.
  if (!cmd?.complete || /\s/.test(rest)) return [];
  const names = ranked([...new Set(completions(cmd.complete, { ...state, typed: rest }))], rest);
  if (names.length === 1 && names[0] === rest) return [];
  // A folder ending in a separator goes a level deeper, and a what-if's file still needs its group.
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}${cmd.complete === 'bicep' ? ' ' : ''}`, run: cmd.complete !== 'bicep' && !(cmd.complete === 'folders' && /[\\/]$/.test(n)) }));
}
