// The Kubernetes operations, written once like actions.js's: keys and slash commands call these with `ctx`.
import { findPod } from './rows.js';
import { kubeProblem, safeName } from './kube.js';
import { kubeShell } from './shell.js';
import { askFirst } from '@fleet/kit/environments.js';

const pods = (ctx) => ctx.kubeData?.pods ?? [];

/** What a failed kubectl call says: the explanation of a missing kubectl or an unreachable cluster first. */
export function explainKube(error) {
  const problem = kubeProblem(error.message);
  return problem ? new Error(`${problem}\n${error.message.split('\n')[0]}`) : error;
}

function pick(ctx, text) {
  const p = findPod(pods(ctx), text);
  if (p) return p;
  ctx.note(text ? `No single pod matches "${text}".` : 'Name a pod.', 'error');
  return null;
}

/** ↵ or /logs on a pod: its log (every container's), following it. */
export function showLogs(ctx, text) {
  const p = pick(ctx, text);
  if (!p) return false;
  ctx.showPodLogs(p);
  return true;
}

/**
 * Which of a pod's containers: `name` when it is one, the only one, or the one picked when it has
 * several. Resolves null when there's none to act on (said) or the question was put away.
 */
async function containerOf(ctx, p, name, what) {
  const all = p.containers ?? [];
  if (name) {
    if (all.includes(name)) return name;
    ctx.note(`${p.name} has no container called ${name}${all.length ? ` (it has ${all.join(', ')})` : ''}.`, 'error');
    return null;
  }
  if (all.length <= 1) return all[0] ?? null;
  return ctx.confirm({ title: `${what}: which of ${p.name}'s containers?`, options: all.map((c) => ({ label: c, value: c })) });
}

/** c on a pod: one container's log (the one picked, when it has several), following it. */
export async function containerLogs(ctx, text, container) {
  const p = pick(ctx, text);
  if (!p) return false;
  const c = await containerOf(ctx, p, container, 'Its log');
  if (!c) return false;
  ctx.showPodLogs(p, { container: c });
  return true;
}

/** e or /shell on a pod: a shell in one of its containers (the one picked, when it has several). */
export async function shell(ctx, text, container) {
  const p = pick(ctx, text);
  if (!p) return false;
  if (p.status !== 'Running') return ctx.note(`${p.name} isn't running (${p.status}).`, 'error') ?? false;
  const c = await containerOf(ctx, p, container, 'A shell');
  if ((p.containers ?? []).length > 1 && !c) return false;
  ctx.openShell({ title: c && p.containers.length > 1 ? `${p.name}/${c}` : p.name, make: (tty) => kubeShell(p, c, { tty, context: ctx.kube.pinned }) });
  return true;
}

/** i: what `kubectl describe` says, events included. */
export async function describe(ctx, text) {
  const p = pick(ctx, text);
  if (!p) return false;
  const r = await ctx.task(`describe ${p.name}`, async (signal) => ({ stdout: await ctx.kube.describe(p, { signal }).catch((e) => Promise.reject(explainKube(e))) }), { label: 'Describing' });
  if (r.ok) ctx.showText(`describe ${p.name}`, r.out);
  return r.ok;
}

/** x: deletes a pod, asking first; whatever owns it makes another. */
export async function deletePod(ctx, text) {
  const p = pick(ctx, text);
  if (!p) return false;
  const yes = await askFirst(ctx, {
    title: `Delete pod ${p.name}?`,
    detail: p.deployment ? `Its deployment ${p.deployment} starts another.` : 'Nothing owns it that you can see here: it may not come back.',
    danger: true,
  });
  if (!yes) return false;
  const r = await ctx.task(`delete pod ${p.name}`, async (signal) => ({ stdout: await ctx.kube.deletePod(p, { signal }).catch((e) => Promise.reject(explainKube(e))) }), { label: 'Deleting', refreshKube: true, activity: `Deleted pod ${p.namespace}/${p.name}` });
  return r.ok;
}

/** r: restarts the deployment a pod belongs to, pod by pod, asking first. */
export async function rollout(ctx, text) {
  const p = pick(ctx, text);
  if (!p) return false;
  if (!p.deployment) return ctx.note(`${p.name} doesn't belong to a deployment: x deletes it instead.`, 'error') ?? false;
  const yes = await askFirst(ctx, { title: `Restart deployment ${p.deployment}?`, detail: `Every pod of it in ${p.namespace} is replaced, one after another.`, danger: true });
  if (!yes) return false;
  const r = await ctx.task(`rollout restart ${p.deployment}`, async (signal) => ({ stdout: await ctx.kube.rolloutRestart(p.deployment, p.namespace, { signal }).catch((e) => Promise.reject(explainKube(e))) }), { label: 'Restarting', refreshKube: true, activity: `Restarted deployment ${p.deployment} in ${p.namespace}` });
  if (r.ok) ctx.note(`w on one of its pods (or /rollout ${p.namespace}/${p.deployment}) follows the rollout.`);
  return r.ok;
}

/**
 * The deployment `text` means, as { deployment, namespace }: `namespace/name`, a pod of the Pods view
 * (its deployment), a deployment its pods belong to, or else a name in the namespace being listed
 * (`default` when that's all of them). Says why and resolves null when there's none.
 */
export function deploymentTarget(ctx, text) {
  const t = String(text ?? '').trim();
  if (!t) return ctx.note('Name a deployment (or one of its pods).', 'error') ?? null;
  const slash = t.indexOf('/');
  if (slash > 0) return checked(ctx, { namespace: t.slice(0, slash), deployment: t.slice(slash + 1) });
  const p = findPod(pods(ctx), t);
  if (p?.deployment) return { deployment: p.deployment, namespace: p.namespace };
  const owned = [...new Map(pods(ctx).filter((x) => x.deployment).map((x) => [`${x.namespace}/${x.deployment}`, { deployment: x.deployment, namespace: x.namespace }])).values()];
  const exact = owned.filter((o) => o.deployment === t);
  const found = exact.length ? exact : owned.filter((o) => o.deployment.startsWith(t));
  if (found.length === 1) return found[0];
  const ns = ctx.kubeData?.namespace ?? ctx.kubeNamespace;
  return checked(ctx, { deployment: t, namespace: ns && ns !== 'all' ? ns : 'default' });
}

function checked(ctx, target) {
  if (safeName(target.deployment) && safeName(target.namespace)) return target;
  return ctx.note(`"${target.namespace}/${target.deployment}" isn't a deployment Kubernetes would have named.`, 'error') ?? null;
}

/** w on a pod, or /rollout: follows its deployment's rollout over the view until it's done or stalls. */
export function watchRollout(ctx, text) {
  const target = deploymentTarget(ctx, text);
  if (!target) return false;
  ctx.showRollout(target);
  return true;
}

/** u in a rollout, or /rollout undo: back to the deployment's previous revision, asking first. */
export async function undoRollout(ctx, { deployment, namespace }) {
  const yes = await askFirst(ctx, { title: `Undo the rollout of ${deployment}?`, detail: `kubectl rollout undo puts ${namespace}/${deployment} back on its previous revision, pod by pod.`, danger: true });
  if (!yes) return false;
  const r = await ctx.task(`rollout undo ${deployment}`, async (signal) => ({ stdout: await ctx.kube.rolloutUndo(deployment, namespace, { signal }).catch((e) => Promise.reject(explainKube(e))) }), { label: 'Undoing', refreshKube: true, activity: `Undid the rollout of ${deployment} in ${namespace}` });
  return r.ok;
}

/** /rollout: `<deployment|pod>` follows a rollout, `restart <pod>` restarts one, `undo <deployment>` takes it back. */
export function rolloutCommand(ctx, text) {
  const [first, ...rest] = String(text ?? '').trim().split(/\s+/);
  if (first === 'restart') return rollout(ctx, rest.join(' '));
  if (first === 'undo') {
    const target = deploymentTarget(ctx, rest.join(' '));
    return target ? undoRollout(ctx, target) : false;
  }
  return watchRollout(ctx, text);
}

/** /namespace: which pods the Pods view lists: one namespace, or `all`. */
export async function namespace(ctx, text) {
  if (!text) return ctx.note(`Namespace: ${ctx.kubeData?.namespace ?? 'all'}. /namespace <name> or /namespace all changes it.`);
  const known = await ctx.kube.namespaces().catch(() => null);
  if (text !== 'all' && known && !known.includes(text)) return ctx.note(`No namespace called "${text}".${known.length ? ` There is ${known.slice(0, 6).join(', ')}.` : ''}`, 'error') ?? false;
  ctx.setKubeNamespace(text);
  ctx.note(`Namespace: ${text}`);
  return true;
}

/** /context: the cluster kubectl talks to, from kubeconfig; switching it changes kubectl everywhere, so it asks. */
export async function useContext(ctx, text) {
  // An environment that names a context has Wharf use it without touching kubectl's own.
  if (text && ctx.env?.context) return ctx.note(`The ${ctx.env.name} environment sends Wharf's kubectl to ${ctx.env.context} (kubectl's own context is left alone): /env switches it.`, 'error') ?? false;
  const known = await ctx.kube.contexts().catch((e) => Promise.reject(explainKube(e)));
  const current = ctx.kubeData?.context ?? (await ctx.kube.current().catch(() => null));
  if (!text) return ctx.note(`Context: ${current ?? 'none'}.${known.length ? ` There is ${known.join(', ')}.` : ''} /context <name> switches.`);
  const target = known.find((c) => c === text) ?? known.filter((c) => c.startsWith(text))[0];
  if (!target) return ctx.note(`No context called "${text}".`, 'error') ?? false;
  if (target === current) return ctx.note(`Already on ${target}.`);
  const yes = await ctx.confirm({ title: `Switch kubectl to ${target}?`, detail: 'This is kubectl\'s own current context, so every terminal sees it.', danger: /prod/i.test(target) });
  if (!yes) return false;
  const r = await ctx.task(`use-context ${target}`, async (signal) => ({ stdout: await ctx.kube.useContext(target, { signal }).catch((e) => Promise.reject(explainKube(e))) }), { label: 'Switching', refreshKube: true, activity: `kubectl context ${target}` });
  return r.ok;
}
