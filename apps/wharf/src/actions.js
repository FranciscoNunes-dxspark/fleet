// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
// Questions before anything destructive live here (`ctx.confirm({ ..., danger: true })`).
import { run } from '@fleet/kit/run.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { findContainer, imageName, targetsOf } from './rows.js';
import { dockerProblem } from './docker.js';
import { copiedNote, describeContext, contextIn, notMine, takeLine } from '@fleet/kit/family.js';
import { latestTrouble, loglineData, matchIn, needleOf } from './share.js';
import * as k from './kubeactions.js';
import { dockerShell } from './shell.js';

const containers = (ctx) => ctx.data?.containers ?? [];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a failed Docker call says: the explanation of a missing or stopped Docker first. */
export function explain(error) {
  const problem = dockerProblem(error.message);
  return problem ? new Error(`${problem}\n${error.message.split('\n')[0]}`) : error;
}

function pick(ctx, name) {
  const c = findContainer(containers(ctx), name);
  if (c) return c;
  ctx.note(name ? `No single container matches "${name}".` : 'Name a container.', 'error');
  return null;
}

/** start, stop, restart, kill, pause or unpause: one container, a compose project's, or `all`. */
export async function change(ctx, verb, target) {
  const list = targetsOf(containers(ctx), target);
  if (!list.length) {
    ctx.note(target ? `No container or project matches "${target}".` : `/${verb} needs a container, a compose project or all.`, 'error');
    return false;
  }
  const affected = list.filter((c) => (verb === 'start' || verb === 'unpause' ? c.state !== 'running' : c.state === 'running' || verb === 'restart'));
  if (!affected.length) {
    ctx.note(verb === 'start' ? 'Already running.' : `Nothing to ${verb}: none of them is running.`);
    return true;
  }
  const names = affected.map((c) => c.name);
  if (affected.length > 1 && ['stop', 'kill', 'restart'].includes(verb)) {
    const yes = await ctx.confirm({ title: `${verb[0].toUpperCase()}${verb.slice(1)} ${plural(affected.length, 'container')}?`, detail: names.slice(0, 4).join(', ') + (names.length > 4 ? ', …' : ''), danger: verb !== 'restart' });
    if (!yes) return false;
  }
  const done = { start: 'Started', stop: 'Stopped', restart: 'Restarted', kill: 'Killed', pause: 'Paused', unpause: 'Unpaused' }[verb];
  const r = await ctx.task(
    `${verb} ${names.length === 1 ? names[0] : plural(names.length, 'container')}`,
    async (signal) => {
      await ctx.provider.act(verb, affected.map((c) => c.id), { signal }).catch((e) => {
        throw explain(e);
      });
      return { stdout: `${done} ${names.join(', ')}` };
    },
    { label: `${verb[0].toUpperCase()}${verb.slice(1)}ing`, refresh: true, activity: `${done} ${names.join(', ')}`, project: affected.find((c) => c.workingDir)?.workingDir },
  );
  return r.ok;
}

/** s: stops what runs, starts what doesn't. */
export const toggle = (ctx, c) => change(ctx, c.state === 'running' ? 'stop' : 'start', c.name);

/** Removes a container, a compose project's or all of them, asking first (and again to force a running one). */
export async function remove(ctx, target) {
  const list = targetsOf(containers(ctx), target);
  if (!list.length) return ctx.note(target ? `No container or project matches "${target}".` : '/rm needs a container, a compose project or all.', 'error') ?? false;
  const running = list.filter((c) => c.state === 'running');
  const names = list.map((c) => c.name);
  const yes = await ctx.confirm({
    title: `Remove ${list.length === 1 ? names[0] : plural(list.length, 'container')}?`,
    detail: running.length ? `${plural(running.length, 'container')} still running: ${running.slice(0, 3).map((c) => c.name).join(', ')}: they will be stopped and removed.` : 'Its writable layer is deleted with it; volumes are kept.',
    danger: true,
  });
  if (!yes) return false;
  const r = await ctx.task(
    `rm ${names.length === 1 ? names[0] : plural(names.length, 'container')}`,
    async (signal) => {
      await ctx.provider.remove(list.map((c) => c.id), { force: running.length > 0, signal }).catch((e) => {
        throw explain(e);
      });
      return { stdout: `Removed ${names.join(', ')}` };
    },
    { label: 'Removing', refresh: true, activity: `Removed ${names.join(', ')}`, project: list.find((c) => c.workingDir)?.workingDir },
  );
  return r.ok;
}

/** /up and /down: a compose project, run where its files are (down asks first and removes its containers and network). */
export async function compose(ctx, verb, name) {
  const projects = [...new Set(containers(ctx).map((c) => c.project).filter(Boolean))];
  const project = projects.find((p) => p === name) ?? projects.filter((p) => p.startsWith(name ?? '\0'))[0];
  if (!project) return ctx.note(name ? `No compose project matches "${name}".` : `/${verb} needs a compose project.`, 'error') ?? false;
  const mine = containers(ctx).filter((c) => c.project === project);
  const found = mine.find((c) => c.workingDir) ?? mine[0];
  if (verb === 'down') {
    const yes = await ctx.confirm({ title: `Take ${project} down?`, detail: `${plural(mine.length, 'container')} stopped and removed, and the project's network; volumes are kept.`, danger: true });
    if (!yes) return false;
  }
  const r = await ctx.task(
    `compose ${verb} ${project}`,
    async (signal) => ({ stdout: await ctx.provider.compose(verb, { project, workingDir: found.workingDir, configFiles: found.configFiles }, { signal }).catch((e) => Promise.reject(explain(e))) }),
    { label: verb === 'up' ? 'Starting' : 'Taking down', refresh: true, activity: `Compose ${verb} ${project}`, project: found.workingDir },
  );
  return r.ok;
}

/** /exec: one command inside a running container (no terminal, so nothing interactive), its output in the viewer. */
export async function exec(ctx, rest) {
  const [name, ...words] = String(rest ?? '').trim().split(/\s+/);
  const command = words.join(' ');
  if (!name || !command) return ctx.note('/exec <container> <command>, e.g. /exec shop-db-1 psql -U app -c "select 1"', 'error') ?? false;
  const c = pick(ctx, name);
  if (!c) return false;
  const r = await ctx.task(`exec ${c.name} ${command}`, async (signal) => ({ stdout: await ctx.provider.exec(c.id, command, { signal }).catch((e) => Promise.reject(explain(e))) }), { label: 'Running' });
  if (r.ok && r.out.split('\n').length > 3) ctx.showText(`exec ${c.name} ${command}`, r.out);
  return r.ok;
}

/**
 * e or /shell: a shell inside a running container (bash where it has it, else sh), or in a pod when
 * the name is one of the Pods view's (`container` then picks one of a pod's containers).
 */
export function shell(ctx, rest) {
  const [name, container] = String(rest ?? '').trim().split(/\s+/);
  if (!name) return ctx.note('/shell <container|pod> [container of the pod]', 'error') ?? false;
  if (!findContainer(containers(ctx), name) && ctx.kubeData?.pods?.some((p) => p.name.startsWith(name) || `${p.namespace}/${p.name}`.startsWith(name))) return k.shell(ctx, name, container);
  const c = pick(ctx, name);
  if (!c) return false;
  if (c.state !== 'running') return ctx.note(`${c.name} isn't running: s starts it.`, 'error') ?? false;
  ctx.openShell({ title: c.name, make: (tty) => dockerShell(c.id, { tty }) });
  return true;
}

/** ↵ or /logs: a container's log, following it. */
export function showLogs(ctx, name) {
  // Not a container: a pod of the cluster, if the Pods view has read one by that name.
  if (!findContainer(containers(ctx), name) && ctx.kubeData?.pods?.length && !(ctx.kubeData.pods.every((p) => !p.name.startsWith(name ?? '')))) return k.showLogs(ctx, name);
  const c = pick(ctx, name);
  if (!c) return false;
  ctx.showLogs(c);
  return true;
}

/** i or /inspect: everything `docker inspect` says. */
export async function inspect(ctx, name) {
  const c = pick(ctx, name);
  if (!c) return false;
  const r = await ctx.task(`inspect ${c.name}`, async () => ({ stdout: await ctx.provider.inspect(c.id).catch((e) => Promise.reject(explain(e))) }), { label: 'Inspecting' });
  if (r.ok) ctx.showText(`inspect ${c.name}`, r.out);
  return r.ok;
}

/** o or /open: the first port a container publishes, in the browser. */
export function open(ctx, name) {
  const c = pick(ctx, name);
  if (!c) return false;
  if (!c.hostPorts.length) return ctx.note(`${c.name} publishes no port.`, 'error') ?? false;
  ctx.openUrl(`http://localhost:${c.hostPorts[0]}`);
  ctx.note(`Opening http://localhost:${c.hostPorts[0]}`);
  return true;
}

/** y: a container's id, or with `what` its name. */
export function copyId(ctx, c) {
  ctx.copy(c.id, `${c.name}'s id`);
}

export async function pull(ctx, image) {
  if (!image) return ctx.note('/pull needs an image, e.g. /pull redis:7', 'error') ?? false;
  const r = await ctx.task(`pull ${image}`, async (signal) => ({ stdout: await ctx.provider.pull(image, { signal }).catch((e) => Promise.reject(explain(e))) }), { label: 'Pulling', refresh: true, activity: `Pulled ${image}` });
  return r.ok;
}

/** /prune: stopped containers (the default) or images nothing uses, asking first. */
export async function prune(ctx, kind = 'containers') {
  const what = kind.startsWith('image') ? 'images' : 'containers';
  const count = what === 'images' ? (ctx.data?.images ?? []).filter((i) => i.dangling).length : containers(ctx).filter((c) => c.state === 'exited').length;
  const yes = await ctx.confirm({
    title: what === 'images' ? 'Remove the images nothing uses?' : 'Remove every stopped container?',
    detail: `${plural(count, what === 'images' ? 'untagged image' : 'stopped container')} now; volumes are kept.`,
    danger: true,
  });
  if (!yes) return false;
  const r = await ctx.task(`prune ${what}`, async (signal) => ({ stdout: await ctx.provider.prune(what, { signal }).catch((e) => Promise.reject(explain(e))) }), { label: 'Pruning', refresh: true, activity: `Pruned ${what}` });
  return r.ok;
}

/** d in Images or /rmi: removes an image, asking first (and again to force one a container uses). */
export async function removeImage(ctx, name) {
  const images = ctx.data?.images ?? [];
  const image = images.find((i) => i.id === name || imageName(i) === name) ?? images.filter((i) => imageName(i).startsWith(name ?? '\0') || i.id.startsWith(name ?? '\0'))[0];
  if (!image) return ctx.note(name ? `No image matches "${name}".` : '/rmi needs an image.', 'error') ?? false;
  const yes = await ctx.confirm({ title: `Remove ${imageName(image)}?`, detail: `${image.size}, ${image.created}`, danger: true });
  if (!yes) return false;
  const r = await ctx.task(`rmi ${imageName(image)}`, async (signal) => ({ stdout: await ctx.provider.removeImage(image.id, { signal }).catch((e) => Promise.reject(explain(e))) }), { label: 'Removing', refresh: true, activity: `Removed image ${imageName(image)}` });
  if (r.ok) return true;
  // An image a container uses is only removed by force: asked once more, since that breaks nothing running but those containers can't be recreated.
  if (/must be forced|being used/i.test(r.error?.message ?? '')) {
    const force = await ctx.confirm({ title: `Force-remove ${imageName(image)}?`, detail: 'A container still refers to it.', danger: true });
    if (!force) return false;
    return (await ctx.task(`rmi -f ${imageName(image)}`, async (signal) => ({ stdout: await ctx.provider.removeImage(image.id, { force: true, signal }).catch((e) => Promise.reject(explain(e))) }), { label: 'Removing', refresh: true, activity: `Force-removed image ${imageName(image)}` })).ok;
  }
  return false;
}

/** ! and /run: a shell command, its output in the activity line (/last has it all). */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !docker compose ps', 'error') ?? false;
  const r = await ctx.task(command, (signal) => run(command, { signal }), { label: 'Running' });
  return r.ok;
}

/** /theme: dark, light or auto; with no argument says which. */
export function setTheme(ctx, value) {
  if (!value) return ctx.note(`Theme: ${ctx.config.theme ?? 'auto'} (${theme.mode} here). /theme ${THEMES.join('|')} changes it.`);
  if (!THEMES.includes(value)) return ctx.note(`Theme is one of ${THEMES.join(', ')}.`, 'error') ?? false;
  const next = { ...ctx.config, theme: value };
  ctx.setConfig(next);
  applyTheme(next);
  ctx.note(`Theme: ${value}`);
  return true;
}

/** /accent: a #rrggbb colour, or `default`. */
export function accent(ctx, value) {
  if (!value) return ctx.note(`Accent: ${ctx.config.accent ?? 'default'} (${theme.accent}). /accent #rrggbb changes it.`);
  if (value !== 'default' && !isColour(value)) return ctx.note('An accent is #rrggbb, or "default".', 'error') ?? false;
  const next = { ...ctx.config };
  if (value === 'default') delete next.accent;
  else next.accent = value;
  ctx.setConfig(next);
  setAccent(next.accent);
  ctx.note(`Accent: ${value}`);
  return true;
}

/** /mouse: on or off. */
export function mouse(ctx, value) {
  if (!['on', 'off'].includes(value)) return ctx.note(`Mouse is ${ctx.config.mouse === false ? 'off' : 'on'}. /mouse on|off changes it.`);
  ctx.setConfig({ ...ctx.config, mouse: value === 'on' });
  ctx.note(`Mouse: ${value}${value === 'off' ? ' (the terminal selects text again)' : ''}`);
  return true;
}

/** /settings: what's set, and where it's kept. */
export function settings(ctx) {
  const c = ctx.config;
  const on = (v) => (v === false ? 'off' : 'on');
  ctx.showText(
    'Settings',
    [
      `Theme            ${c.theme ?? 'auto'} (${theme.mode} here)       /theme dark|light|auto`,
      `Accent colour    ${c.accent ?? 'default'}       /accent #rrggbb`,
      `Mouse            ${on(c.mouse)}       /mouse on|off`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()}`,
    ].join('\n'),
  );
  return true;
}

/** t in a log: the newest line that reads as trouble, as a line for Sonar, Hail or Bosun to paste into their prompts (/take there). */
export function shareTrouble(ctx, { process, project, text }) {
  const line = latestTrouble(text);
  if (!line) return ctx.note('No line in this log reads as trouble.') ?? false;
  const share = takeLine('logline', loglineData({ process, line, project, log: text }));
  ctx.copy(share, 'a line for Sonar, Hail or Bosun');
  ctx.note(copiedNote(['sonar', 'hail', 'bosun'], share));
  return true;
}

/**
 * /take: what a sibling copied. A log line is looked for in the logs of the running containers (and the
 * cluster's pods, when the Pods view has read them); the first log that has it opens with the line searched.
 */
export async function take(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  if (context.kind !== 'logline') return ctx.note(notMine('wharf', context), 'error') ?? false;
  if (!needleOf(context.data) && !context.data.requestId) return ctx.note('That line has no text to look for.', 'error') ?? false;
  const running = containers(ctx).filter((c) => c.state === 'running').slice(0, 16);
  const cluster = (ctx.kubeData?.pods ?? []).filter((p) => p.status === 'Running').slice(0, 16);
  if (!running.length && !cluster.length) return ctx.note('Nothing is running to look in.', 'error') ?? false;
  // The container named in the context first: the line most likely came from it.
  running.sort((x, y) => Number(y.name === context.data.process) - Number(x.name === context.data.process));
  const r = await ctx.task(
    `take ${describeContext(context)}`,
    async (signal) => {
      for (const c of running) {
        const log = await ctx.provider.logs(c.id, { tail: 1000, signal }).catch(() => '');
        const query = matchIn(log, context.data);
        if (query) return { stdout: `Found in ${c.name}`, found: { container: c, query } };
      }
      for (const p of cluster) {
        const log = await ctx.kube.logs(p, { tail: 1000, signal }).catch(() => '');
        const query = matchIn(log, context.data);
        if (query) return { stdout: `Found in ${p.name}`, found: { pod: p, query } };
      }
      return { stdout: 'Not in the last 1000 lines of any running container or pod.', found: null };
    },
    { label: 'Looking' },
  );
  if (!r.ok) return false;
  const found = r.result?.found;
  if (!found) return false;
  if (found.container) ctx.showLogs(found.container, { search: found.query });
  else ctx.showPodLogs(found.pod, { search: found.query });
  return true;
}
