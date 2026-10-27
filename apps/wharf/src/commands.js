import * as a from './actions.js';
import * as k from './kubeactions.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'start', args: '<name|project|all>', desc: 'Start a container, a compose project\'s, or every stopped one', complete: 'containers', run: (ctx, s) => a.change(ctx, 'start', s) },
  { name: 'stop', args: '<name|project|all>', desc: 'Stop a container, a compose project\'s, or every running one', complete: 'containers', run: (ctx, s) => a.change(ctx, 'stop', s) },
  { name: 'restart', args: '<name|project|all>', desc: 'Restart a container, a compose project\'s, or all of them', complete: 'containers', run: (ctx, s) => a.change(ctx, 'restart', s) },
  { name: 'kill', args: '<name|project|all>', desc: 'Kill a container (SIGKILL) without waiting for it to stop', complete: 'containers', run: (ctx, s) => a.change(ctx, 'kill', s) },
  { name: 'pause', args: '<name>', desc: 'Freeze a container\'s processes', complete: 'containers', run: (ctx, s) => a.change(ctx, 'pause', s) },
  { name: 'unpause', args: '<name>', desc: 'Let a paused container run again', complete: 'containers', run: (ctx, s) => a.change(ctx, 'unpause', s) },
  { name: 'rm', args: '<name|project|all>', desc: 'Remove containers (asks first; a running one is stopped)', complete: 'containers', run: (ctx, s) => a.remove(ctx, s) },
  { name: 'up', args: '<project>', desc: 'docker compose up -d for a compose project, where its files are', complete: 'projects', run: (ctx, s) => a.compose(ctx, 'up', s) },
  { name: 'down', args: '<project>', desc: 'docker compose down for a compose project: its containers and network are removed (asks first)', complete: 'projects', run: (ctx, s) => a.compose(ctx, 'down', s) },
  { name: 'exec', args: '<name> <command>', desc: 'Run one command inside a running container (no terminal: nothing interactive)', complete: 'containers', run: (ctx, s) => a.exec(ctx, s) },
  { name: 'pods', desc: 'The pods of the cluster kubectl is set to: the Pods view', run: (ctx) => ctx.setView('pods') },
  { name: 'namespace', args: '[name|all]', desc: 'Which namespace the Pods view lists', complete: 'namespaces', run: (ctx, s) => k.namespace(ctx, s) },
  { name: 'context', args: '[name]', desc: 'Which cluster kubectl talks to (asks before switching: it is kubectl itself that changes)', complete: 'contexts', run: (ctx, s) => k.useContext(ctx, s) },
  { name: 'rollout', args: '<pod>', desc: 'Restart the deployment a pod belongs to, pod by pod (asks first)', complete: 'pods', run: (ctx, s) => k.rollout(ctx, s) },
  { name: 'describe', args: '<pod>', desc: 'What kubectl describe says about a pod, events included', complete: 'pods', run: (ctx, s) => k.describe(ctx, s) },
  { name: 'delete-pod', args: '<pod>', desc: 'Delete a pod; its controller starts another (asks first)', complete: 'pods', run: (ctx, s) => k.deletePod(ctx, s) },
  { name: 'logs', args: '<name>', desc: 'A container\'s log, following it', complete: 'containers', run: (ctx, s) => a.showLogs(ctx, s) },
  { name: 'inspect', args: '<name>', desc: 'Everything docker inspect says about a container', complete: 'containers', run: (ctx, s) => a.inspect(ctx, s) },
  { name: 'open', args: '<name>', desc: 'Open the first port a container publishes in the browser', complete: 'containers', run: (ctx, s) => a.open(ctx, s) },
  { name: 'pull', args: '<image>', desc: 'Pull an image, e.g. /pull redis:7', run: (ctx, s) => a.pull(ctx, s) },
  { name: 'rmi', args: '<image>', desc: 'Remove an image (asks first)', complete: 'images', run: (ctx, s) => a.removeImage(ctx, s) },
  { name: 'prune', args: '[containers|images]', desc: 'Remove every stopped container, or the images nothing uses (asks first)', complete: 'prunable', run: (ctx, s) => a.prune(ctx, s || 'containers') },
  { name: 'take', args: '<family:v1:…>', desc: 'Take what a sibling copied: a log line is looked for in the running containers and pods', run: (ctx, s) => a.take(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'refresh', desc: 'Read Docker again now', run: (ctx) => ctx.refresh() },
  { name: 'settings', desc: 'Theme, accent colour, mouse, updates', run: (ctx) => a.settings(ctx) },
  { name: 'theme', args: '[dark|light|auto]', desc: 'Change the theme', complete: 'themes', run: (ctx, s) => a.setTheme(ctx, s) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'mouse', args: '[on|off]', desc: 'Clicks and the wheel, or leave the mouse to the terminal', complete: 'onoff', run: (ctx, s) => a.mouse(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Wharf now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Wharf', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, data, kube) {
  if (kind === 'containers') return [...(data?.containers ?? []).map((c) => c.name), ...new Set((data?.containers ?? []).map((c) => c.project).filter(Boolean)), 'all'];
  if (kind === 'projects') return [...new Set((data?.containers ?? []).map((c) => c.project).filter(Boolean))];
  if (kind === 'pods') return (kube?.pods ?? []).map((p) => p.name);
  if (kind === 'namespaces') return ['all', ...new Set((kube?.pods ?? []).map((p) => p.namespace))];
  if (kind === 'contexts') return kube?.contexts ?? [];
  if (kind === 'images') return (data?.images ?? []).filter((i) => i.repo).map((i) => `${i.repo}${i.tag ? `:${i.tag}` : ''}`);
  if (kind === 'prunable') return ['containers', 'images'];
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
export function suggestionsFor(value, { data, kube } = {}) {
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
  const names = ranked([...new Set(completions(cmd.complete, data, kube))], rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: true }));
}
