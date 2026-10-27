// An in-memory cluster with the interface of kube.js's provider, for --demo and the tests: two
// namespaces, a deployment's pods, one crash-looping, one still starting. `state` is exposed for
// the tests: { pods, contexts, current, calls }.
const pod = (namespace, name, status, extra = {}) => ({
  name,
  namespace,
  status,
  readyCount: status === 'Running' ? 1 : 0,
  total: 1,
  ready: status === 'Running' ? '1/1' : '0/1',
  restarts: 0,
  node: 'node-1',
  created: new Date(Date.now() - 3 * 3600_000).toISOString(),
  deployment: null,
  containers: ['app'],
  ...extra,
});

export function demoPods() {
  return [
    pod('shop', 'web-7d9f8b6c4d-abcde', 'Running', { deployment: 'web' }),
    pod('shop', 'web-7d9f8b6c4d-fghij', 'Running', { deployment: 'web' }),
    pod('shop', 'api-5c8d7f9b6-klmno', 'CrashLoopBackOff', { deployment: 'api', restarts: 14 }),
    pod('shop', 'db-0', 'Running', { node: 'node-2' }),
    pod('shop', 'worker-6b7c8d9f5-pqrst', 'ContainerCreating', { deployment: 'worker', created: new Date().toISOString() }),
    pod('monitoring', 'prometheus-0', 'Running', { node: 'node-2', containers: ['prometheus', 'config-reloader'], total: 2, ready: '2/2', readyCount: 2 }),
  ];
}

const LOG = (name, n) => {
  const at = (i) => new Date(Date.UTC(2026, 9, 27, 9, 0, i * 5)).toISOString();
  return `${Array.from({ length: n }, (_, i) => `${at(i)} ${i % 8 === 7 ? `ERROR ${name}: connection to db refused` : `INFO ${name}: served request ${200 + i}`}`).join('\n')}\n`;
};

export function demoKube() {
  const state = { pods: demoPods(), contexts: ['docker-desktop', 'aks-prod'], current: 'docker-desktop', calls: [] };
  const find = (p) => {
    const found = state.pods.find((x) => x.name === p.name && x.namespace === p.namespace);
    if (!found) throw new Error(`Error from server (NotFound): pods "${p.name}" not found`);
    return found;
  };
  return {
    name: 'demo',
    state,
    async current() {
      return state.current;
    },
    async contexts() {
      return [...state.contexts];
    },
    async useContext(ctxName) {
      if (!state.contexts.includes(ctxName)) throw new Error(`error: no context exists with the name: "${ctxName}"`);
      state.calls.push(['use-context', ctxName]);
      state.current = ctxName;
      return `Switched to context "${ctxName}".`;
    },
    async namespaces() {
      return [...new Set(state.pods.map((p) => p.namespace))].sort();
    },
    async pods({ namespace } = {}) {
      return state.pods.filter((p) => !namespace || namespace === 'all' || p.namespace === namespace).map((p) => ({ ...p }));
    },
    async top() {
      const out = new Map();
      for (const [i, p] of state.pods.entries()) if (p.status === 'Running') out.set(`${p.namespace}/${p.name}`, { cpu: 5 + i * 11, mem: (30 + i * 17) * 1024 * 1024 });
      return out;
    },
    async logs(p) {
      return LOG(find(p).name, 40);
    },
    async describe(p) {
      return `Name:         ${find(p).name}\nNamespace:    ${p.namespace}\nStatus:       ${find(p).status}\n`;
    },
    async deletePod(p) {
      state.calls.push(['delete', p.namespace, p.name]);
      find(p);
      state.pods = state.pods.filter((x) => x !== find(p));
      return `pod "${p.name}" deleted`;
    },
    async rolloutRestart(deployment, namespace) {
      state.calls.push(['rollout restart', namespace, deployment]);
      for (const p of state.pods) if (p.deployment === deployment && p.namespace === namespace) Object.assign(p, { status: 'Running', ready: '1/1', readyCount: 1, restarts: 0 });
      return `deployment.apps/${deployment} restarted`;
    },
  };
}
