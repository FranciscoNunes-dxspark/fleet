// An in-memory Docker with the interface of docker.js's provider, for --demo and the tests: a compose
// project, a few standalone containers (one that crashed, one unhealthy) and some images. A new
// operation in the provider needs one here too.

const box = (id, name, image, state, extra = {}) => ({
  id,
  name,
  image,
  state,
  status: state === 'running' ? 'Up 2 hours' : state === 'exited' ? 'Exited (0) 3 hours ago' : 'Created',
  ports: '',
  hostPorts: [],
  created: '2 days ago',
  project: null,
  service: null,
  workingDir: null,
  configFiles: null,
  health: null,
  exitCode: state === 'exited' ? 0 : null,
  ...extra,
});

const publish = (host, inner) => ({ ports: `0.0.0.0:${host}->${inner}/tcp, :::${host}->${inner}/tcp`, hostPorts: [host] });

export function demoContainers() {
  const all = [
    box('a1b2c3d4e5f6', 'shop-web-1', 'shop/web:1.4', 'running', { project: 'shop', service: 'web', workingDir: '/srv/shop', configFiles: '/srv/shop/compose.yaml', ...publish(8080, 80) }),
    box('b2c3d4e5f6a1', 'shop-api-1', 'shop/api:1.4', 'running', { project: 'shop', service: 'api', ...publish(3000, 3000), health: 'healthy', status: 'Up 2 hours (healthy)' }),
    box('c3d4e5f6a1b2', 'shop-db-1', 'postgres:16', 'running', { project: 'shop', service: 'db', ports: '5432/tcp' }),
    box('d4e5f6a1b2c3', 'shop-worker-1', 'shop/api:1.4', 'exited', { project: 'shop', service: 'worker', status: 'Exited (1) 12 minutes ago', exitCode: 1 }),
    box('e5f6a1b2c3d4', 'redis-cache', 'redis:7', 'running', { ...publish(6379, 6379) }),
    box('f6a1b2c3d4e5', 'mailpit', 'axllent/mailpit', 'running', { ...publish(8025, 8025), health: 'unhealthy', status: 'Up 5 minutes (unhealthy)' }),
    box('0a1b2c3d4e5f', 'old-experiment', 'alpine:3.20', 'exited'),
  ];
  // A compose project's containers all know where its files are.
  for (const c of all) if (c.project === 'shop') Object.assign(c, { workingDir: '/srv/shop', configFiles: '/srv/shop/compose.yaml' });
  return all;
}

export function demoImages() {
  return [
    { id: '111111111111', repo: 'shop/web', tag: '1.4', size: '48.2MB', created: '2 days ago', dangling: false },
    { id: '222222222222', repo: 'shop/api', tag: '1.4', size: '212MB', created: '2 days ago', dangling: false },
    { id: '333333333333', repo: 'postgres', tag: '16', size: '431MB', created: '3 weeks ago', dangling: false },
    { id: '444444444444', repo: 'redis', tag: '7', size: '117MB', created: '4 weeks ago', dangling: false },
    { id: '555555555555', repo: null, tag: null, size: '212MB', created: '3 days ago', dangling: true },
  ];
}

const LOG = (name, n) => {
  const at = (i) => new Date(Date.UTC(2026, 9, 27, 9, 0, i * 7)).toISOString();
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(`${at(i)} ${i % 9 === 8 ? `ERROR ${name}: upstream timed out after 30s` : `INFO ${name}: request ${1000 + i} handled in ${(i * 7) % 90} ms`}`);
  }
  return `${lines.join('\n')}\n`;
};

/** `state` is exposed for the tests: { containers, images, calls }. */
export function demoDocker() {
  const state = { containers: demoContainers(), images: demoImages(), calls: [] };
  const find = (id) => state.containers.find((c) => c.id === id || c.id.startsWith(id) || c.name === id);
  const here = (id) => {
    const c = find(id);
    if (!c) throw new Error(`Error response from daemon: No such container: ${id}`);
    return c;
  };
  return {
    name: 'demo',
    state,
    async containers() {
      return state.containers.map((c) => ({ ...c }));
    },
    async stats() {
      const out = new Map();
      for (const [i, c] of state.containers.entries()) if (c.state === 'running') out.set(c.id.slice(0, 12), { cpu: (i * 1.7) % 9, mem: (40 + i * 23) * 1024 * 1024, memPercent: 1 + i / 2 });
      return out;
    },
    async images() {
      return state.images.map((i) => ({ ...i }));
    },
    async logs(id, { tail = 500 } = {}) {
      const c = here(id);
      return c.state === 'created' ? '' : LOG(c.name, Math.min(tail, 60));
    },
    async inspect(id) {
      return JSON.stringify([{ Id: here(id).id, Name: `/${here(id).name}`, Config: { Image: here(id).image }, State: { Status: here(id).state } }], null, 2);
    },
    async act(verb, ids) {
      state.calls.push([verb, ...ids]);
      for (const id of ids) {
        const c = here(id);
        if (verb === 'start' || verb === 'restart' || verb === 'unpause') Object.assign(c, { state: 'running', status: 'Up Less than a second', exitCode: null, health: c.health === 'unhealthy' && verb === 'restart' ? null : c.health });
        else if (verb === 'stop' || verb === 'kill') Object.assign(c, { state: 'exited', status: verb === 'kill' ? 'Exited (137) Less than a second ago' : 'Exited (0) Less than a second ago', exitCode: verb === 'kill' ? 137 : 0 });
        else if (verb === 'pause') Object.assign(c, { state: 'paused', status: 'Up 2 hours (Paused)' });
      }
      return ids.join('\n');
    },
    async remove(ids, { force = false } = {}) {
      state.calls.push([force ? 'rm -f' : 'rm', ...ids]);
      for (const id of ids) {
        const c = here(id);
        if (c.state === 'running' && !force) throw new Error(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
        state.containers = state.containers.filter((x) => x !== c);
      }
      return ids.join('\n');
    },
    async removeImage(id, { force = false } = {}) {
      state.calls.push([force ? 'rmi -f' : 'rmi', id]);
      const image = state.images.find((i) => i.id === id || i.id.startsWith(id) || `${i.repo}:${i.tag}` === id);
      if (!image) throw new Error(`Error response from daemon: No such image: ${id}`);
      if (state.containers.some((c) => c.image === `${image.repo}:${image.tag}`) && !force) throw new Error('Error response from daemon: conflict: unable to delete image (must be forced) - image is being used by a container');
      state.images = state.images.filter((i) => i !== image);
      return `Deleted: ${image.id}`;
    },
    async compose(verb, project) {
      state.calls.push([`compose ${verb}`, project.project]);
      const mine = state.containers.filter((c) => c.project === project.project);
      if (!mine.length) throw new Error(`no configuration file provided: not found`);
      if (verb === 'up') for (const c of mine) Object.assign(c, { state: 'running', status: 'Up Less than a second', exitCode: null });
      else state.containers = state.containers.filter((c) => c.project !== project.project);
      return `Project ${project.project} ${verb === 'up' ? 'started' : 'removed'}`;
    },
    async exec(id, command) {
      const c = here(id);
      state.calls.push(['exec', c.id, command]);
      if (c.state !== 'running') throw new Error(`Error response from daemon: container ${c.id} is not running`);
      return `${c.name}$ ${command}\n`;
    },
    async pull(image) {
      state.calls.push(['pull', image]);
      const [repo, tag = 'latest'] = image.split(':');
      if (!state.images.some((i) => i.repo === repo && i.tag === tag)) state.images.push({ id: '9'.repeat(12), repo, tag, size: '10MB', created: 'now', dangling: false });
      return `Status: Downloaded newer image for ${image}`;
    },
    async prune(kind) {
      state.calls.push(['prune', kind]);
      if (kind === 'images') {
        const gone = state.images.filter((i) => i.dangling);
        state.images = state.images.filter((i) => !i.dangling);
        return `Total reclaimed space: ${gone.length ? '212MB' : '0B'}`;
      }
      const gone = state.containers.filter((c) => c.state === 'exited');
      state.containers = state.containers.filter((c) => c.state !== 'exited');
      return `Deleted Containers:\n${gone.map((c) => c.id).join('\n')}\n\nTotal reclaimed space: ${gone.length}B`;
    },
  };
}
