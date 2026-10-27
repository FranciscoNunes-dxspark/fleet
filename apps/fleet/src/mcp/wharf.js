// Wharf's side: containers and pods through Wharf's own providers (docker.js and kube.js, the docker
// and kubectl command lines, every name checked before it reaches the shell). Only their reading
// calls are used here: the lists and the logs.
import { ToolError } from '@fleet/kit/mcp.js';
import { count, line, tail } from './bound.js';

/** Wharf's providers, made once per server: the demo's with `demo`. `override` is for the tests. */
export function wharfSide({ demo = false, override } = {}) {
  let made = null;
  const providers = async () => {
    if (override) return override;
    if (made) return made;
    if (demo) {
      const [{ demoDocker }, { demoKube }] = await Promise.all([import('../../../wharf/src/demo.js'), import('../../../wharf/src/demokube.js')]);
      return (made = { docker: demoDocker(), kube: demoKube() });
    }
    const [{ createDocker }, { createKube }] = await Promise.all([import('../../../wharf/src/docker.js'), import('../../../wharf/src/kube.js')]);
    return (made = { docker: createDocker(), kube: createKube() });
  };
  const problem = async (kind, e) => {
    const { dockerProblem } = await import('../../../wharf/src/docker.js');
    const { kubeProblem } = await import('../../../wharf/src/kube.js');
    const said = (kind === 'kube' ? kubeProblem : dockerProblem)(String(e.message ?? e)) ?? String(e.message ?? e).split('\n')[0];
    return new ToolError(said);
  };
  const docker = async (fn) => {
    const { docker: d } = await providers();
    try {
      return await fn(d);
    } catch (e) {
      throw e instanceof ToolError ? e : await problem('docker', e);
    }
  };
  const kube = async (fn) => {
    const { kube: k } = await providers();
    try {
      return await fn(k);
    } catch (e) {
      throw e instanceof ToolError ? e : await problem('kube', e);
    }
  };

  return [
    {
      name: 'wharf_containers',
      description: "Docker's containers, as Wharf lists them: name, image, state and status (health, exit code), ports, and the compose project and service each belongs to.",
      inputSchema: { type: 'object', properties: { running: { type: 'boolean', description: 'Only the running ones (default false: every container)' } } },
      async run({ running }) {
        const list = await docker((d) => d.containers());
        const shown = running ? list.filter((c) => c.state === 'running') : list;
        if (!shown.length) return running ? 'No container is running.' : 'There are no containers.';
        return shown
          .map((c) => `${c.name}  ${c.state}${c.status ? ` (${c.status})` : ''}  image ${c.image}${c.ports ? `  ports ${line(c.ports, 200)}` : ''}${c.project ? `  compose ${c.project}/${c.service}` : ''}  id ${String(c.id).slice(0, 12)}`)
          .join('\n');
      },
    },
    {
      name: 'wharf_container_logs',
      description: "The last lines of one container's log (stdout and stderr, with timestamps), by its name, id (or the start of one) or compose project/service.",
      inputSchema: {
        type: 'object',
        properties: { container: { type: 'string', description: 'Name, id or project/service, from wharf_containers' }, lines: { type: 'integer', description: 'How many of the last lines (default 200, at most 2000)' } },
        required: ['container'],
      },
      async run({ container, lines }) {
        const { findContainer } = await import('../../../wharf/src/rows.js');
        const list = await docker((d) => d.containers());
        const c = findContainer(list, container);
        if (!c) throw new ToolError(`No one container called ${container}. There: ${list.map((x) => x.name).join(', ') || 'none'}.`);
        const text = await docker((d) => d.logs(c.id, { tail: count(lines, 200, 2000) }));
        return text.trim() ? tail(text) : `${c.name} has logged nothing.`;
      },
    },
    {
      name: 'wharf_pods',
      description: "Kubernetes pods in kubectl's current context, as Wharf lists them: namespace, name, status, ready containers, restarts, age and the deployment each belongs to.",
      inputSchema: { type: 'object', properties: { namespace: { type: 'string', description: 'A namespace, or "all" (default: every namespace)' } } },
      async run({ namespace }) {
        const ns = namespace || 'all';
        const { ageOf } = await import('../../../wharf/src/kube.js');
        const [context, pods] = await Promise.all([kube((k) => k.current()).catch(() => '?'), kube((k) => k.pods({ namespace: ns }))]);
        if (!pods.length) return `No pods in ${ns === 'all' ? 'any namespace' : ns} (context ${context}).`;
        return [
          `Context ${context}:`,
          ...pods.map((p) => `${p.namespace}/${p.name}  ${p.status}  ready ${p.ready ?? '?'}  restarts ${p.restarts ?? 0}${p.created ? `  age ${ageOf(p.created)}` : ''}${p.deployment ? `  deployment ${p.deployment}` : ''}`),
        ].join('\n');
      },
    },
    {
      name: 'wharf_pod_logs',
      description: "The last lines of a pod's log (every container's, or one), with timestamps.",
      inputSchema: {
        type: 'object',
        properties: {
          pod: { type: 'string', description: 'The pod, as namespace/name or a name' },
          namespace: { type: 'string', description: 'Its namespace, when `pod` is a bare name (default: found among every namespace)' },
          container: { type: 'string', description: 'Only this container' },
          lines: { type: 'integer', description: 'How many of the last lines (default 200, at most 2000)' },
        },
        required: ['pod'],
      },
      async run({ pod, namespace, container, lines }) {
        let [ns, name] = String(pod ?? '').includes('/') ? String(pod).split('/') : [namespace, String(pod ?? '')];
        if (!ns) {
          const all = await kube((k) => k.pods({ namespace: 'all' }));
          const found = all.filter((p) => p.name === name);
          if (found.length !== 1) throw new ToolError(found.length ? `${name} is in several namespaces (${found.map((p) => p.namespace).join(', ')}): name one.` : `No pod called ${name}.`);
          ns = found[0].namespace;
        }
        const text = await kube((k) => k.logs({ namespace: ns, name }, { tail: count(lines, 200, 2000), container }));
        return text.trim() ? tail(text) : `${ns}/${name} has logged nothing.`;
      },
    },
  ];
}
