// An in-memory Docker with the interface of docker.js's provider, for --demo and the tests: a compose
// project, a few standalone containers (one that crashed, one unhealthy) and some images. A new
// operation in the provider needs one here too. Its containers' inspect has something for the security
// check to find: a privileged CI runner with the Docker socket, a Redis on every interface, a database
// password in the environment, and its compose file one too.
//
// bilge-ignore-file: the demo's passwords are made up, and made from pieces.
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';

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
    box('1b2c3d4e5f6a', 'ci-runner', 'gitlab/gitlab-runner:latest', 'running'),
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

// A made-up password, in pieces so nothing reads it as one.
const DEMO_PASSWORD = ['hunter', '2', '-shop', '-db'].join('');

// What `docker inspect` says beyond the list, per demo container: how each one runs.
const HOW = {
  'shop-web-1': { User: '101', ReadonlyRootfs: true, Memory: 256 * 1024 * 1024, PidsLimit: 200 },
  'shop-api-1': { User: 'node', Env: ['NODE_ENV=production', 'PORT=3000'] },
  'shop-db-1': { Env: ['POSTGRES_USER=shop', `POSTGRES_PASSWORD=${DEMO_PASSWORD}`, 'PGDATA=/var/lib/postgresql/data'], Mounts: [{ Type: 'volume', Name: 'shop_db', Source: '/var/lib/docker/volumes/shop_db/_data', Destination: '/var/lib/postgresql/data', RW: true }] },
  'shop-worker-1': { User: 'node' },
  'redis-cache': { Memory: 512 * 1024 * 1024 },
  mailpit: { User: '1000' },
  'ci-runner': {
    Privileged: true,
    Mounts: [
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', Mode: '', RW: true },
      { Type: 'bind', Source: '/srv/gitlab-runner/config', Destination: '/etc/gitlab-runner', Mode: '', RW: true },
    ],
  },
};

/** A demo container as `docker inspect` prints it (the fields Wharf reads, as Docker names them). */
export function demoInspect(c) {
  const how = HOW[c.name] ?? {};
  const ports = {};
  for (const part of c.ports.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(.*):(\d+)->(\d+\/\w+)$/.exec(part);
    if (m) (ports[m[3]] ??= []).push({ HostIp: m[1], HostPort: m[2] });
    else ports[part] ??= null;
  }
  const mounts = how.Mounts ?? [];
  return {
    Id: `${c.id}${'0'.repeat(52)}`,
    Name: `/${c.name}`,
    State: { Status: c.state, Running: c.state === 'running', ExitCode: c.exitCode ?? 0 },
    Image: `sha256:${'ab'.repeat(32)}`,
    Config: {
      Hostname: c.id,
      User: how.User ?? '',
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...(how.Env ?? [])],
      Image: c.image,
      Labels: c.project ? { 'com.docker.compose.project': c.project, 'com.docker.compose.service': c.service, 'com.docker.compose.project.working_dir': c.workingDir, 'com.docker.compose.project.config_files': c.configFiles } : {},
    },
    HostConfig: {
      Binds: mounts.filter((m) => m.Type === 'bind').map((m) => `${m.Source}:${m.Destination}${m.RW ? '' : ':ro'}`),
      NetworkMode: c.project ? `${c.project}_default` : 'bridge',
      PortBindings: Object.fromEntries(Object.entries(ports).filter(([, b]) => b).map(([k, b]) => [k, b.filter((x) => x.HostIp === '0.0.0.0').map((x) => ({ HostIp: '', HostPort: x.HostPort }))])),
      RestartPolicy: { Name: c.project ? 'unless-stopped' : 'no', MaximumRetryCount: 0 },
      CapAdd: null,
      CapDrop: null,
      IpcMode: 'private',
      PidMode: '',
      Privileged: Boolean(how.Privileged),
      ReadonlyRootfs: Boolean(how.ReadonlyRootfs),
      SecurityOpt: null,
      Memory: how.Memory ?? 0,
      PidsLimit: how.PidsLimit ?? null,
    },
    Mounts: mounts,
    NetworkSettings: { Ports: c.state === 'running' ? ports : {} },
  };
}

/** The demo compose project's file, with what a compose file gets wrong. */
export const DEMO_COMPOSE = `name: shop
services:
  web:
    image: shop/web:1.4
    user: "101"
    read_only: true
    mem_limit: 256m
    pids_limit: 200
    ports:
      - "8080:80"
  api:
    image: shop/api:1.4
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: \${DATABASE_URL}
  db:
    image: postgres:16
    environment:
      - POSTGRES_USER=shop
      - POSTGRES_PASSWORD=${DEMO_PASSWORD}
    volumes:
      - shop_db:/var/lib/postgresql/data
  worker:
    image: shop/api:1.4
    command: node worker.js
volumes:
  shop_db:
`;

const DEMO_FILES = { '/srv/shop/compose.yaml': DEMO_COMPOSE };

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
      return JSON.stringify([demoInspect(here(id))], null, 2);
    },
    async inspectAll(ids) {
      return ids.map((id) => demoInspect(here(id)));
    },
    // The demo's files (its compose project's), then the disk's: a test may write a compose file of its own.
    async readFile(path) {
      const p = String(path).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
      if (DEMO_FILES[p] != null) return DEMO_FILES[p];
      return readFile(path, 'utf8');
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

/**
 * A pretend shell for --demo and the tests, shaped as child_process.spawn's child (stdin, stdout,
 * stderr, kill, 'close'): it answers pwd, ls, echo and exit, and says it's the demo for anything else.
 * `spawned` records each start's command and arguments.
 */
export function demoShell(spawned = []) {
  return (command, args) => {
    spawned.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    };
    const answer = (line) => {
      const [word, ...rest] = line.trim().split(/\s+/);
      if (!word) return;
      if (word === 'exit') return end(Number(rest[0]) || 0);
      if (word === 'pwd') return child.stdout.write('/app\n');
      if (word === 'ls') return child.stdout.write('package.json\nserver.js\nnode_modules\n');
      if (word === 'echo') return child.stdout.write(`${rest.join(' ')}\n`);
      child.stderr.write(`sh: ${word}: not found (this is the demo: nothing runs)\n`);
    };
    let held = '';
    child.stdin = new Writable({
      write(chunk, _enc, done) {
        const parts = (held + chunk.toString()).split('\n');
        held = parts.pop();
        for (const line of parts) if (!ended) answer(line);
        done();
      },
      final(done) {
        end(0);
        done();
      },
    });
    child.kill = () => end(null);
    return child;
  };
}
