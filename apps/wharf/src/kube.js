// Kubernetes, through kubectl (the kit's run.js, as docker.js does Docker): whatever context and
// kubeconfig kubectl uses is what Wharf shows. `createKube` is the provider; demo.js's `demoKube` has
// the same interface for --demo and the tests, so a new operation needs both. The parsers are pure.
import { run as kitRun } from '@fleet/kit/run.js';

// What's passed to the shell has to be a name Kubernetes accepts (a DNS label or subdomain), or for a
// context what kubeconfig allows, never more.
const DNS = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const CONTEXT = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;
export const safeName = (s) => DNS.test(String(s ?? '')) && String(s).length <= 253;
const name = (s) => {
  if (!safeName(s)) throw new Error(`"${s}" isn't a name Kubernetes would have given.`);
  return s;
};
export const safeContext = (s) => CONTEXT.test(String(s ?? ''));
const context = (s) => {
  if (!CONTEXT.test(String(s ?? ''))) throw new Error(`"${s}" isn't a context name kubectl would have.`);
  return s;
};

/** Seconds since an ISO time, as the short age kubectl shows: 42s, 5m, 3h, 12d. */
export function ageOf(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The deployment a pod belongs to, when it comes from one: its ReplicaSet's name without the hash. */
export function deploymentOf(pod) {
  const owner = (pod.metadata?.ownerReferences ?? [])[0];
  if (owner?.kind === 'ReplicaSet') return owner.name.replace(/-[a-z0-9]{5,10}$/, '');
  return null;
}

/** What `kubectl get pods` shows in STATUS: a container's waiting or terminated reason, else the phase. */
export function statusOf(pod) {
  if (pod.metadata?.deletionTimestamp) return 'Terminating';
  for (const c of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
    if (c.state?.waiting?.reason) return c.state.waiting.reason;
    if (c.state?.terminated && c.state.terminated.exitCode !== 0) return c.state.terminated.reason ?? `Exit ${c.state.terminated.exitCode}`;
  }
  return pod.status?.reason ?? pod.status?.phase ?? 'Unknown';
}

/** `kubectl get pods -o json` as { name, namespace, status, ready, readyCount, total, restarts, node, created, deployment, containers }. */
export function parsePods(text) {
  let items;
  try {
    items = JSON.parse(text).items ?? [];
  } catch {
    throw new Error('kubectl said something that was not JSON.');
  }
  return items.map((p) => {
    const statuses = p.status?.containerStatuses ?? [];
    const containers = (p.spec?.containers ?? []).map((c) => c.name);
    return {
      name: p.metadata.name,
      namespace: p.metadata.namespace,
      status: statusOf(p),
      readyCount: statuses.filter((c) => c.ready).length,
      total: containers.length,
      ready: `${statuses.filter((c) => c.ready).length}/${containers.length}`,
      restarts: statuses.reduce((n, c) => n + (c.restartCount ?? 0), 0),
      node: p.spec?.nodeName ?? '',
      created: p.metadata.creationTimestamp ?? '',
      deployment: deploymentOf(p),
      containers,
    };
  });
}

/** `kubectl top pods --no-headers` (with -A, a namespace column first) as a Map from "namespace/name" to { cpu (millicores), mem (bytes) }. */
export function parseTop(text, namespace = null) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const w = line.trim().split(/\s+/);
    const [ns, pod, cpu, mem] = w.length >= 4 ? w : [namespace, ...w];
    if (!pod || !cpu || !mem) continue;
    const m = /^(\d+)m?$/.exec(cpu);
    const b = /^(\d+)(Ki|Mi|Gi)?$/.exec(mem);
    if (!m || !b) continue;
    out.set(`${ns}/${pod}`, { cpu: Number(m[1]), mem: Number(b[1]) * ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 }[b[2]] ?? 1) });
  }
  return out;
}

/** What a missing or unreachable kubectl's error means, as a line to show; null for any other error. */
export function kubeProblem(message) {
  const m = String(message ?? '');
  if (/not recognized|ENOENT|command not found/i.test(m) && /kubectl/i.test(m)) return "kubectl isn't installed (or isn't on the PATH).";
  if (/refused|Unable to connect|no such host|timeout|i\/o timeout|dial tcp|unreachable/i.test(m)) return "The cluster can't be reached: check the context (/context) and your network.";
  if (/Unauthorized|Forbidden|must be logged in|credentials/i.test(m)) return 'The cluster turned the credentials down: sign in again (az aks get-credentials, aws eks update-kubeconfig, …).';
  if (/no configuration|current-context is not set|invalid configuration/i.test(m)) return 'kubectl has no context set: /context picks one.';
  return null;
}

// A deployment's selector, as kubectl's -l takes it: only label keys and values Kubernetes allows reach the shell.
const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
export function selectorOf(matchLabels) {
  const pairs = Object.entries(matchLabels ?? {});
  if (!pairs.length) throw new Error('The deployment has no matchLabels selector to find its pods by.');
  for (const [k, v] of pairs) if (!LABEL_KEY.test(k) || !LABEL_VALUE.test(String(v)) || k.length > 316 || String(v).length > 63) throw new Error(`"${k}=${v}" isn't a label Kubernetes would have.`);
  return pairs.map(([k, v]) => `${k}=${v}`).join(',');
}

// What a new pod waiting for one of these won't get over by itself: worth undoing the rollout before its deadline.
const HARD = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError', 'RunContainerError']);
// Warning events about a new pod worth showing as they happen: failed probes, pulls, mounts, scheduling.
const WARNINGS = new Set(['Unhealthy', 'Failed', 'BackOff', 'FailedScheduling', 'FailedMount', 'FailedCreatePodSandBox', 'FailedAttachVolume', 'Evicted']);
const REVISION = 'deployment.kubernetes.io/revision';

/**
 * A deployment's rollout from `kubectl get … -o json`'s objects (the deployment, its ReplicaSets, its
 * pods and the namespace's pod events): { name, namespace, revision, desired, updated, ready,
 * available, total, phase, message, deadline, pods, problems }. `phase` is done, stalled (past its
 * progressDeadlineSeconds), failing (a new pod waits on something it won't get over: a crash loop, an
 * image that can't be pulled), paused or progressing, the way `kubectl rollout status` decides done.
 * `pods` are the new ReplicaSet's, `problems` [{ pod, text }] what's wrong with them, newest last.
 */
export function rolloutState({ deployment: d, replicaSets = [], pods = [], events = [] }) {
  const st = d.status ?? {};
  const desired = d.spec?.replicas ?? 1;
  const [updated, ready, available, total] = [st.updatedReplicas, st.readyReplicas, st.availableReplicas, st.replicas].map((n) => n ?? 0);
  const revision = d.metadata?.annotations?.[REVISION] ?? null;
  const owned = replicaSets.filter((rs) => (rs.metadata?.ownerReferences ?? []).some((o) => o.kind === 'Deployment' && o.name === d.metadata.name));
  const newRs = owned.find((rs) => rs.metadata?.annotations?.[REVISION] === revision) ?? null;
  const hash = newRs?.metadata?.labels?.['pod-template-hash'];
  const fresh = hash ? pods.filter((p) => p.metadata?.labels?.['pod-template-hash'] === hash) : [];
  const shown = fresh.map((p) => {
    const statuses = p.status?.containerStatuses ?? [];
    return { name: p.metadata.name, status: statusOf(p), ready: `${statuses.filter((c) => c.ready).length}/${(p.spec?.containers ?? []).length}`, restarts: statuses.reduce((n, c) => n + (c.restartCount ?? 0), 0) };
  });
  const problems = [];
  const seen = new Set();
  const add = (pod, text) => {
    const key = `${pod}\0${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ pod, text });
  };
  const names = new Set(fresh.map((p) => p.metadata.name));
  const at = (e) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata?.creationTimestamp ?? 0) || 0;
  for (const e of [...events].sort((x, y) => at(x) - at(y))) {
    if (e.type !== 'Warning' || !WARNINGS.has(e.reason) || !names.has(e.involvedObject?.name)) continue;
    // Without its count, so an event seen again is the same problem rather than a new line.
    add(e.involvedObject.name, `${e.reason}: ${String(e.message ?? '').split('\n')[0]}`);
  }
  let hard = null;
  for (const p of fresh) {
    for (const c of p.status?.containerStatuses ?? []) {
      const reason = c.state?.waiting?.reason ?? (c.state?.terminated && c.state.terminated.exitCode !== 0 ? c.state.terminated.reason ?? `Exit ${c.state.terminated.exitCode}` : null);
      if (!reason || reason === 'ContainerCreating' || reason === 'PodInitializing') continue;
      if (HARD.has(reason)) hard ??= { pod: p.metadata.name, reason };
      const why = c.state?.waiting?.message ?? c.lastState?.terminated?.reason ?? '';
      add(p.metadata.name, `${c.name}: ${reason}${why ? `: ${String(why).split('\n')[0]}` : ''}`);
    }
  }
  const progressing = (st.conditions ?? []).find((c) => c.type === 'Progressing');
  const deadline = d.spec?.progressDeadlineSeconds ?? 600;
  const caughtUp = (st.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0);
  let phase = 'progressing';
  let message;
  if (progressing?.reason === 'ProgressDeadlineExceeded') {
    phase = 'stalled';
    message = `Stalled: no progress within ${deadline}s (${updated} of ${desired} updated, ${available} available).`;
  } else if (caughtUp && updated >= desired && total <= updated && available >= updated) {
    phase = 'done';
    message = `Done: ${available} of ${desired} available on revision ${revision ?? '?'}.`;
  } else if (hard) {
    phase = 'failing';
    message = `Failing: ${hard.pod} is in ${hard.reason}, which it won't get over by itself.`;
  } else if (d.spec?.paused) {
    phase = 'paused';
    message = 'Paused: kubectl rollout resume carries on.';
  } else if (!caughtUp) message = 'Waiting for the deployment to be picked up…';
  else if (updated < desired) message = `Waiting: ${updated} of ${desired} new replicas updated.`;
  else if (total > updated) message = `Waiting: ${total - updated} old replica${total - updated === 1 ? '' : 's'} still to go.`;
  else message = `Waiting: ${available} of ${updated} updated replicas available.`;
  return { name: d.metadata.name, namespace: d.metadata.namespace, revision, desired, updated, ready, available, total, phase, message, deadline, pods: shown, problems: problems.slice(-12) };
}

const scope = (namespace) => (!namespace || namespace === 'all' ? '-A' : `-n ${name(namespace)}`);

/** The provider for a real cluster: `run(command, { signal })` is injectable for tests. */
export function createKube({ run = kitRun } = {}) {
  // The context a project's environment names (pin): every call but kubeconfig's own goes there with
  // --context, so kubectl's current context, which every terminal shares, is never changed for it.
  let pinned = null;
  const kc = () => `kubectl${pinned ? ` --context ${context(pinned)}` : ''}`;
  return {
    name: 'kubectl',
    pin(ctxName) {
      pinned = ctxName ? context(ctxName) : null;
    },
    get pinned() {
      return pinned;
    },
    async current() {
      if (pinned) return pinned;
      const { stdout } = await run('kubectl config current-context');
      return stdout.trim();
    },
    async contexts() {
      const { stdout } = await run('kubectl config get-contexts -o name');
      return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    },
    async useContext(ctxName, { signal } = {}) {
      const { stdout } = await run(`kubectl config use-context ${context(ctxName)}`, { signal });
      return stdout;
    },
    async namespaces({ signal } = {}) {
      const { stdout } = await run('kubectl get namespaces -o name', { signal });
      return stdout.split('\n').map((s) => s.trim().replace(/^namespace\//, '')).filter(Boolean);
    },
    async pods({ namespace, signal } = {}) {
      const { stdout } = await run(`${kc()} get pods ${scope(namespace)} -o json`, { signal });
      return parsePods(stdout);
    },
    // Needs the metrics server; a cluster without one just has no numbers.
    async top({ namespace, signal } = {}) {
      const { stdout } = await run(`${kc()} top pods ${scope(namespace)} --no-headers`, { signal });
      return parseTop(stdout, namespace === 'all' ? null : namespace);
    },
    async logs(pod, { tail = 500, container, signal } = {}) {
      const { stdout, stderr } = await run(`${kc()} logs --timestamps --tail ${Number(tail) || 500} -n ${name(pod.namespace)} ${name(pod.name)}${container ? ` -c ${name(container)}` : ' --all-containers=true'}`, { signal });
      return [stdout, stderr].filter(Boolean).join('');
    },
    async describe(pod, { signal } = {}) {
      const { stdout } = await run(`${kc()} describe pod -n ${name(pod.namespace)} ${name(pod.name)}`, { signal });
      return stdout;
    },
    // The controller makes a new one, so this is a restart for a pod that has one.
    async deletePod(pod, { signal } = {}) {
      const { stdout } = await run(`${kc()} delete pod -n ${name(pod.namespace)} ${name(pod.name)}`, { signal });
      return stdout;
    },
    async rolloutRestart(deployment, namespace, { signal } = {}) {
      const { stdout } = await run(`${kc()} rollout restart deployment/${name(deployment)} -n ${name(namespace)}`, { signal });
      return stdout;
    },
    // Where a deployment's rollout is: the deployment, then its ReplicaSets, pods and the namespace's pod events together.
    async rollout(deployment, namespace, { signal } = {}) {
      const json = (stdout) => {
        try {
          return JSON.parse(stdout);
        } catch {
          throw new Error('kubectl said something that was not JSON.');
        }
      };
      const ns = name(namespace);
      const d = json((await run(`${kc()} get deployment ${name(deployment)} -n ${ns} -o json`, { signal })).stdout);
      const sel = selectorOf(d.spec?.selector?.matchLabels);
      const [rs, pods, events] = await Promise.all([
        run(`${kc()} get replicasets -n ${ns} -l ${sel} -o json`, { signal }),
        run(`${kc()} get pods -n ${ns} -l ${sel} -o json`, { signal }),
        // Events are a nicety: a cluster that won't list them still shows the rollout.
        run(`${kc()} get events -n ${ns} --field-selector involvedObject.kind=Pod -o json`, { signal }).catch(() => ({ stdout: '{"items":[]}' })),
      ]);
      return rolloutState({ deployment: d, replicaSets: json(rs.stdout).items ?? [], pods: json(pods.stdout).items ?? [], events: json(events.stdout).items ?? [] });
    },
    async rolloutUndo(deployment, namespace, { signal } = {}) {
      const { stdout } = await run(`${kc()} rollout undo deployment/${name(deployment)} -n ${name(namespace)}`, { signal });
      return stdout;
    },
  };
}
