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

const scope = (namespace) => (!namespace || namespace === 'all' ? '-A' : `-n ${name(namespace)}`);

/** The provider for a real cluster: `run(command, { signal })` is injectable for tests. */
export function createKube({ run = kitRun } = {}) {
  return {
    name: 'kubectl',
    async current() {
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
      const { stdout } = await run(`kubectl get pods ${scope(namespace)} -o json`, { signal });
      return parsePods(stdout);
    },
    // Needs the metrics server; a cluster without one just has no numbers.
    async top({ namespace, signal } = {}) {
      const { stdout } = await run(`kubectl top pods ${scope(namespace)} --no-headers`, { signal });
      return parseTop(stdout, namespace === 'all' ? null : namespace);
    },
    async logs(pod, { tail = 500, container, signal } = {}) {
      const { stdout, stderr } = await run(`kubectl logs --timestamps --tail ${Number(tail) || 500} -n ${name(pod.namespace)} ${name(pod.name)}${container ? ` -c ${name(container)}` : ' --all-containers=true'}`, { signal });
      return [stdout, stderr].filter(Boolean).join('');
    },
    async describe(pod, { signal } = {}) {
      const { stdout } = await run(`kubectl describe pod -n ${name(pod.namespace)} ${name(pod.name)}`, { signal });
      return stdout;
    },
    // The controller makes a new one, so this is a restart for a pod that has one.
    async deletePod(pod, { signal } = {}) {
      const { stdout } = await run(`kubectl delete pod -n ${name(pod.namespace)} ${name(pod.name)}`, { signal });
      return stdout;
    },
    async rolloutRestart(deployment, namespace, { signal } = {}) {
      const { stdout } = await run(`kubectl rollout restart deployment/${name(deployment)} -n ${name(namespace)}`, { signal });
      return stdout;
    },
  };
}
