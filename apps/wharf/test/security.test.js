// bilge-ignore-file: the fixtures below hold made-up secrets, built from pieces.
// The security check: the compose reader, the judges over docker inspect and compose files, the
// provider's one inspect, `wharf security`, and the list in the app over the demo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composePorts, composeVolume, findingDetail, imageRef, judgeCompose, judgeContainer, judgeInspect, literalSecret, mountRisk, secretName, worstByContainer } from '../src/security.js';
import { composeServices, lineOf, parseYaml } from '../src/compose.js';
import { createDocker } from '../src/docker.js';
import { demoDocker, DEMO_COMPOSE } from '../src/demo.js';
import { parseArgs, runHeadless } from '../src/headless.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

// Made-up secrets, in pieces so no scanner takes the source for one.
const PASSWORD = ['correct', '-horse', '-battery'].join('');
const TOKEN = ['ghp', '_', 'x'.repeat(4), 'Fake0Token1Made2Of3Pieces'].join('');

/** A container as `docker inspect` prints it, with `over` laid over the defaults (a well-run one). */
function inspected({ name = 'app', config = {}, host = {}, mounts = [], ports = {} } = {}) {
  return {
    Id: 'f'.repeat(64),
    Name: `/${name}`,
    State: { Status: 'running', Running: true },
    Config: { User: '1000:1000', Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=production'], Image: `ghcr.io/acme/app:2.1@sha256:${'a'.repeat(64)}`, ...config },
    HostConfig: { Binds: null, NetworkMode: 'bridge', PortBindings: {}, CapAdd: null, CapDrop: ['ALL'], IpcMode: 'private', PidMode: '', Privileged: false, ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges'], Memory: 536870912, PidsLimit: 256, ...host },
    Mounts: mounts,
    NetworkSettings: { Ports: ports },
  };
}

const rules = (list) => list.map((f) => f.rule).sort();

test('the compose reader: mappings, lists, flow lists, quotes, comments, block scalars, anchors and merges, with lines', () => {
  const doc = parseYaml(`# a comment
x-common: &common
  restart: unless-stopped
  logging: { driver: json-file }
services:
  web:
    <<: *common
    image: "nginx:1.27" # pinned later
    command: |
      nginx -g 'daemon off;'
      # not a comment
    ports: ["8080:80", '443:443']
    environment:
      - A=1
      - B="two words"
    healthcheck:
      test: [CMD, curl, -f, http://localhost]
  db:
    image: postgres:16
    privileged: true
`);
  const web = doc.services.web;
  assert.equal(web.restart, 'unless-stopped');
  assert.deepEqual(web.logging, { driver: 'json-file' });
  assert.equal(web.image, 'nginx:1.27');
  assert.match(web.command, /daemon off;'\n# not a comment/);
  assert.deepEqual(web.ports, ['8080:80', '443:443']);
  assert.deepEqual(web.environment, ['A=1', 'B="two words"']);
  assert.deepEqual(web.healthcheck.test, ['CMD', 'curl', '-f', 'http://localhost']);
  assert.equal(doc.services.db.privileged, true);
  assert.equal(lineOf(web, 'image'), 8);
  assert.equal(lineOf(web, 'restart'), 3);
  assert.equal(lineOf(web.environment, 1), 15);
  assert.equal(lineOf(doc.services.db, 'privileged'), 20);
  assert.deepEqual(composeServices(DEMO_COMPOSE).map((s) => [s.name, s.line]), [['web', 3], ['api', 11], ['db', 18], ['worker', 25]]);
  assert.deepEqual(composeServices('just: a value\n'), []);
  assert.equal(parseYaml(''), null);
});

test('a well-run container has nothing to say', () => {
  assert.deepEqual(judgeContainer(inspected({ ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } })), []);
});

test('a badly run container: privileged, capabilities, profiles off, host namespaces, the socket, host folders, root, ports, a password', () => {
  const found = judgeContainer(
    inspected({
      name: 'risky',
      config: { User: '', Image: 'acme/tool:latest', Env: ['PATH=/bin', `DB_PASSWORD=${PASSWORD}`, `GITHUB_TOKEN=${TOKEN}`, 'DB_PASSWORD_FILE=/run/secrets/db', 'PWD=/app', 'API_KEY=${API_KEY}'] },
      host: { Privileged: true, CapAdd: ['CAP_SYS_ADMIN', 'NET_ADMIN', 'CHOWN'], SecurityOpt: ['seccomp=unconfined', 'apparmor:unconfined'], PidMode: 'host', IpcMode: 'host', ReadonlyRootfs: false, Memory: 0, PidsLimit: null },
      mounts: [
        { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true },
        { Type: 'bind', Source: '/etc', Destination: '/host/etc', RW: true },
        { Type: 'bind', Source: '/proc', Destination: '/host/proc', RW: false },
        { Type: 'bind', Source: '/srv/app/data', Destination: '/data', RW: true },
        { Type: 'volume', Name: 'cache', Source: '/var/lib/docker/volumes/cache/_data', Destination: '/cache', RW: true },
      ],
      ports: {
        '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }, { HostIp: '::', HostPort: '5432' }],
        '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
        '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '6379' }],
        '9000/tcp': null,
      },
    }),
  );
  assert.deepEqual(rules(found), ['apparmor-unconfined', 'cap-add', 'cap-add', 'docker-socket', 'env-secret', 'env-secret', 'host-ipc', 'host-path-rw', 'host-pid', 'image-latest', 'no-limits', 'privileged', 'public-database-port', 'public-port', 'root', 'seccomp-unconfined', 'writable-rootfs']);
  const by = (rule) => found.filter((f) => f.rule === rule);
  assert.ok(found.every((f) => f.where === 'risky' && f.fix && f.why));
  assert.equal(by('privileged')[0].severity, 'critical');
  assert.match(by('docker-socket')[0].title, /read-write/);
  assert.deepEqual(by('cap-add').map((f) => f.title), ['SYS_ADMIN capability added', 'NET_ADMIN capability added']);
  assert.equal(by('host-path-rw')[0].title, "Host's /etc mounted writable");
  assert.equal(by('public-database-port')[0].title, 'PostgreSQL published on every interface');
  assert.equal(by('public-database-port').length, 1, 'the IPv4 and IPv6 bindings are one finding');
  assert.equal(by('public-port')[0].severity, 'low');
  assert.match(by('privileged')[0].fix, /--privileged.*privileged: true/);
  // The secrets are cut short, never whole.
  const text = JSON.stringify(found);
  assert.ok(!text.includes(PASSWORD) && !text.includes(TOKEN));
  assert.deepEqual(by('env-secret').map((f) => f.excerpt.split('=')[0]), ['DB_PASSWORD', 'GITHUB_TOKEN']);
  assert.ok(by('env-secret').every((f) => f.severity === 'medium' && f.excerpt.includes('•')));
});

test('the host network publishes nothing to judge, a read-only socket is still critical, and Podman\'s socket counts', () => {
  const host = judgeContainer(inspected({ host: { NetworkMode: 'host' }, ports: { '6379/tcp': [{ HostIp: '0.0.0.0', HostPort: '6379' }] } }));
  assert.deepEqual(rules(host), ['host-network']);
  const ro = judgeContainer(inspected({ mounts: [{ Type: 'bind', Source: '/run/user/1000/podman/podman.sock', Destination: '/var/run/docker.sock', RW: false }] }));
  assert.deepEqual(ro.map((f) => [f.rule, f.severity, f.title]), [['docker-socket', 'critical', 'Container engine socket mounted']]);
  // A stopped container has only what it asked for: PortBindings, with an empty HostIp for every interface.
  const stopped = judgeContainer(inspected({ host: { PortBindings: { '27017/tcp': [{ HostIp: '', HostPort: '27017' }] } }, ports: {} }));
  assert.deepEqual(stopped.map((f) => f.title), ['MongoDB published on every interface']);
  // Binds alone, from an inspect without Mounts.
  const binds = judgeContainer({ ...inspected(), Mounts: undefined, HostConfig: { ...inspected().HostConfig, Binds: ['/:/host:ro', '/root:/root'] } });
  assert.deepEqual(binds.map((f) => f.title), ["Host's /root mounted writable"]);
});

test('the pieces: secret names, literal values, mounts, image references, compose ports and volumes', () => {
  for (const name of ['DB_PASSWORD', 'POSTGRES_PASSWORD', 'JWT_SECRET', 'API_KEY', 'STRIPE_SECRET_KEY', 'GITHUB_TOKEN', 'MYSQL_ROOT_PASSWORD', 'apiKey']) assert.ok(secretName(name), name);
  for (const name of ['PWD', 'PATH', 'POSTGRES_PASSWORD_FILE', 'KEYCLOAK_URL', 'SSL_KEY_PATH', 'NODE_ENV', 'TOKEN_TTL']) assert.ok(!secretName(name), name);
  assert.ok(literalSecret(PASSWORD));
  for (const v of ['', 'abc', '${DB_PASSWORD}', '$DB_PASSWORD', '/run/secrets/db', 'true', '5432', 'changeme']) assert.ok(!literalSecret(v), v);
  assert.equal(mountRisk('/var/run/docker.sock'), 'socket');
  assert.equal(mountRisk('/run/containerd/containerd.sock'), 'socket');
  assert.equal(mountRisk('/etc/'), 'host-path');
  assert.equal(mountRisk('/sys/fs/cgroup'), 'host-path');
  assert.equal(mountRisk('/srv/app'), null);
  assert.deepEqual(imageRef('localhost:5000/team/app:1.2@sha256:abc'), { tag: '1.2', digest: 'sha256:abc' });
  assert.deepEqual(imageRef('localhost:5000/team/app'), { tag: null, digest: null });
  assert.deepEqual(composePorts('127.0.0.1:6379:6379/tcp'), [{ inner: 6379, host: 6379, ip: '127.0.0.1' }]);
  assert.deepEqual(composePorts('5432:5432'), [{ inner: 5432, host: 5432, ip: '' }]);
  assert.deepEqual(composePorts(9200), [{ inner: 9200, host: null, ip: '' }]);
  assert.deepEqual(composePorts('[::1]:3306:3306'), [{ inner: 3306, host: 3306, ip: '::1' }]);
  assert.deepEqual(composePorts({ target: 27017, published: '27017', host_ip: '0.0.0.0' }), [{ inner: 27017, host: 27017, ip: '0.0.0.0' }]);
  assert.deepEqual(composeVolume('/var/run/docker.sock:/var/run/docker.sock:ro'), { source: '/var/run/docker.sock', target: '/var/run/docker.sock', rw: false });
  assert.deepEqual(composeVolume('./data:/data'), { source: './data', target: '/data', rw: true });
  assert.equal(composeVolume('pgdata:/var/lib/postgresql/data'), null);
  assert.equal(composeVolume({ type: 'volume', source: 'x', target: '/x' }), null);
  assert.deepEqual(composeVolume({ type: 'bind', source: '/etc', target: '/host/etc', read_only: true }), { source: '/etc', target: '/host/etc', rw: false });
});

const BAD_COMPOSE = `services:
  agent:
    image: acme/agent
    privileged: true
    pid: host
    network_mode: host
    cap_add:
      - SYS_ADMIN
    security_opt:
      - seccomp:unconfined
    user: root
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /:/host:ro
      - /etc:/host/etc
  cache:
    image: redis:latest
    ports:
      - "6379:6379"
      - "127.0.0.1:8001:8001"
      - 8080:80
    environment:
      REDIS_PASSWORD: ${PASSWORD}
      FROM_ENV: \${REDIS_PASSWORD}
      OTHER_SECRET: \${OTHER_SECRET:-}
  app:
    build: .
    read_only: true
    deploy:
      resources:
        limits: { memory: 512M, pids: 100 }
`;

test('a compose file\'s services are judged with the line of each key', () => {
  const found = judgeCompose('deploy/compose.yaml', BAD_COMPOSE);
  const at = Object.fromEntries(found.map((f) => [`${f.rule} ${f.service}`, f.line]));
  assert.deepEqual(at, {
    'privileged agent': 4,
    'docker-socket agent': 13,
    'cap-add agent': 8,
    'seccomp-unconfined agent': 10,
    'host-pid agent': 5,
    'host-network agent': 6,
    'host-path-rw agent': 15,
    'public-database-port cache': 19,
    'env-secret cache': 23,
    'root agent': 11,
    'writable-rootfs agent': 2,
    'writable-rootfs cache': 16,
    'public-port cache': 21,
    'no-limits agent': 2,
    'no-limits cache': 16,
    'image-latest agent': 3,
    'image-latest cache': 17,
  });
  assert.ok(found.every((f) => f.where === 'deploy/compose.yaml'));
  assert.equal(found[0].severity, 'critical', 'worst first');
  assert.match(found.find((f) => f.rule === 'privileged').title, /\(agent\)$/);
  assert.equal(found.find((f) => f.rule === 'public-database-port').title, 'Redis published on every interface (cache)');
  assert.ok(!JSON.stringify(found).includes(PASSWORD));
  // The detail shows what was seen, cut short, and the fix with its compose key.
  const detail = findingDetail(found.find((f) => f.rule === 'env-secret'));
  assert.match(detail, /deploy\/compose\.yaml:23/);
  assert.match(detail, /REDIS_PASSWORD=corr•+/);
  assert.match(detail, /secrets:/);
});

test('a well-written compose file has nothing to say', () => {
  const good = `services:
  api:
    image: ghcr.io/acme/api:3.2@sha256:${'b'.repeat(64)}
    user: "1000:1000"
    read_only: true
    mem_limit: 256m
    pids_limit: 100
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      DB_PASSWORD_FILE: /run/secrets/db
      DB_PASSWORD: \${DB_PASSWORD}
    secrets: [db]
    volumes:
      - ./config:/config:ro
      - data:/data
secrets:
  db:
    file: ./db.txt
`;
  assert.deepEqual(judgeCompose('compose.yaml', good), []);
});

test('the worst finding per container, for the list\'s marker', () => {
  const m = worstByContainer([{ where: 'a', severity: 'low' }, { where: 'a', severity: 'high' }, { where: 'b', severity: 'medium' }]);
  assert.deepEqual([...m], [['a', 'high'], ['b', 'medium']]);
  assert.deepEqual(judgeInspect(JSON.stringify([inspected()])), []);
});

test('the provider inspects every container in one call, and only names Docker would have made', async () => {
  const calls = [];
  const docker = createDocker({
    run: async (command) => {
      calls.push(command);
      return { stdout: JSON.stringify([inspected({ name: 'a' }), inspected({ name: 'b' })]) };
    },
  });
  const list = await docker.inspectAll(['a1b2c3', 'shop-web-1']);
  assert.deepEqual(calls, ['docker inspect a1b2c3 shop-web-1']);
  assert.equal(list.length, 2);
  assert.deepEqual(await docker.inspectAll([]), []);
  await assert.rejects(docker.inspectAll(['ok', 'x; rm -rf /']), /isn't a container/);
  assert.equal(calls.length, 1);
});

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const headless = async (args, opts = {}) => {
  let out = '';
  const code = await runHeadless(args, { provider: demoDocker(), write: (s) => (out += s), now: new Date('2026-11-03T10:00:00Z'), ...opts });
  return { code, out };
};

test('wharf security: every container, exiting 1 on a finding as bad as --fail-on', async () => {
  const { code, out } = await headless(['security']);
  assert.equal(code, 1);
  assert.match(out, /^How 8 containers run/);
  assert.match(out, /CRIT Privileged container {2}ci-runner/);
  assert.match(out, /HIGH Redis published on every interface {2}redis-cache/);
  assert.match(out, /2 critical · 1 high · 5 medium · \d+ low · failing on high and above/);
  assert.equal((await headless(['security', '--fail-on', 'none'])).code, 0);
  assert.equal((await headless(['security'], { config: { securityIgnore: ['privileged', 'docker-socket', 'public-database-port:redis-cache'] } })).code, 0);
});

test('wharf security --json: the kit\'s shape, worst first, no excerpts and no secret', async () => {
  const { code, out } = await headless(['security', '--json', '--fail-on', 'critical']);
  assert.equal(code, 1);
  const json = JSON.parse(out);
  assert.deepEqual([json.app, json.check, json.target, json.at, json.checked], ['wharf', 'containers', 'containers (demo)', '2026-11-03T10:00:00.000Z', 8]);
  assert.deepEqual([json.counts.critical, json.counts.high, json.counts.medium], [2, 1, 5]);
  assert.deepEqual(json.findings.slice(0, 3).map((f) => [f.rule, f.where]), [['privileged', 'ci-runner'], ['docker-socket', 'ci-runner'], ['public-database-port', 'redis-cache']]);
  assert.ok(json.findings.every((f) => !('excerpt' in f)));
  assert.ok(json.findings.some((f) => f.rule === 'env-secret' && f.where === 'shop-db-1'));
  assert.ok(!out.includes('hunter2'));
});

test('wharf security --compose: the files named, with lines, Docker not asked', async () => {
  const provider = demoDocker();
  provider.containers = async () => assert.fail('Docker is not asked for a compose file');
  const { code, out } = await headless(['security', '--compose', '/srv/shop/compose.yaml', '--fail-on', 'medium', '--json'], { provider });
  assert.equal(code, 1);
  const json = JSON.parse(out);
  assert.equal(json.check, 'compose');
  assert.deepEqual(json.findings[0], { rule: 'env-secret', severity: 'medium', title: 'POSTGRES_PASSWORD in the compose file (db)', where: '/srv/shop/compose.yaml', why: json.findings[0].why, fix: json.findings[0].fix, line: 22, service: 'db' });
  // A file on the disk, named relative to where it runs.
  const dir = mkdtempSync(join(tmpdir(), 'wharf-compose-'));
  try {
    writeFileSync(join(dir, 'compose.yml'), BAD_COMPOSE);
    const r = await headless(['security', '-f', 'compose.yml'], { cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.out, /CRIT Privileged container \(agent\) {2}compose\.yml:4/);
    const missing = await headless(['security', '--compose', 'nope.yml'], { cwd: dir });
    assert.deepEqual([missing.code, missing.out], [2, "wharf security: Couldn't read nope.yml: no such file\n"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wharf security\'s arguments', async () => {
  assert.deepEqual(parseArgs(['security', '--compose', 'a.yml', '-f', 'b.yml', '--json', '--fail-on', 'LOW']), { command: 'security', compose: ['a.yml', 'b.yml'], failOn: 'low', json: true });
  assert.deepEqual(await headless(['security', '--fail-on', 'bad']), { code: 2, out: 'wharf security: --fail-on is one of critical, high, medium, low, none\n' });
  assert.equal((await headless(['security', '--what'])).code, 2);
  const down = demoDocker();
  down.containers = async () => {
    throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
  };
  assert.deepEqual(await headless(['security'], { provider: down }), { code: 2, out: "wharf security: Docker isn't running: start Docker Desktop or the daemon.\n" });
});

const shows = (app, text) => () => app.lastFrame().includes(text);

test('the list marks the containers the check found something on, and /security lists the findings worst first', async () => {
  const app = start();
  await until(shows(app, '2 at risk'), 'the markers');
  assert.match(app.lastFrame(), /ci-runner\s*!/);
  await type(app.stdin, '/security');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Security · every container'), 'the findings');
  const frame = app.lastFrame();
  assert.match(frame, /2 critical · 1 high · 5 medium/);
  assert.ok(frame.indexOf('Privileged container') < frame.indexOf('Redis published on every interface'));
  assert.ok(!frame.includes('hunter2'));
  // ↵: the first finding, with what was seen and the fix.
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Seen:'), 'the detail');
  assert.match(app.lastFrame(), /"Privileged": true/);
  assert.match(app.lastFrame(), /--privileged/);
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Security · every container'), 'back to the list');
  app.stdin.write('y');
  await until(() => app.copied.length === 1, 'the copy');
  assert.match(app.copied[0], /^Privileged container\ncritical {2}· {2}ci-runner/);
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Standalone'), 'the containers again');
  app.unmount();
});

test('alt+s checks the container under the cursor, and /security <project> its compose file', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  // The first container is the project's first: api.
  app.stdin.write('\x1bs');
  await until(shows(app, 'Security · shop-api-1'), 'its findings');
  assert.match(app.lastFrame(), /Ports published on every interface/);
  assert.ok(!app.lastFrame().includes('ci-runner'));
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Standalone'), 'the list again');
  await type(app.stdin, '/security shop');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "Security · shop's compose file"), 'the compose findings');
  assert.match(app.lastFrame(), /MED  POSTGRES_PASSWORD in the compose/);
  assert.match(app.lastFrame(), /compose\.yaml:22/);
  app.unmount();
});
