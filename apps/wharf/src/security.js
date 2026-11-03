// How containers run, judged for what would let one hurt its host or leak: privileged mode, added
// capabilities, seccomp or AppArmor turned off, the host's process, network or IPC namespace, the
// Docker socket or the host's own folders mounted in, root, a writable root filesystem, databases
// published on every interface, passwords in environment variables, no limits, unpinned images.
// Read from `docker inspect` (running containers) and from compose files (services before they run).
// What an image holds (its packages, its Dockerfile) is Bilge's, not this.
//
// Pure: findings in the kit's shape (findings.js), `where` the container's name or the compose file
// (with `line`). A secret is never kept whole: an excerpt has its value `redact`ed (codescan.js).
//
// bilge-ignore-file: the rules below name what they look for.
import { redact } from '@fleet/kit/codescan.js';
import { rank, sortFindings } from '@fleet/kit/findings.js';
import { composeServices, lineOf } from './compose.js';

// Each rule's severity, title, why and fix; the fix names docker run's flag and compose's key.
export const RULES = {
  privileged: { severity: 'critical', title: 'Privileged container', why: 'A privileged container has every capability and the host\'s devices: root in it is root on the host.', fix: 'Drop --privileged (compose: privileged: true) and add only the capabilities it needs with --cap-add (cap_add:).' },
  'docker-socket': { severity: 'critical', title: 'Container engine socket mounted', why: 'Whoever reaches the Docker (or Podman) socket can start a privileged container: it is root on the host.', fix: 'Remove the socket from -v / --mount (compose: volumes:); if it must stay, put a socket proxy in between that allows only what it needs, read only.' },
  'cap-add': { severity: 'high', title: 'Powerful capability added', why: 'SYS_ADMIN, NET_ADMIN and ALL give a container much of what privileged does (mounts, the host\'s network settings).', fix: 'Remove it from --cap-add (compose: cap_add:); add the narrow capability the program needs instead, and --cap-drop ALL first.' },
  'seccomp-unconfined': { severity: 'high', title: 'Seccomp turned off', why: 'Without seccomp\'s profile every system call reaches the host\'s kernel, the dangerous ones too.', fix: 'Remove --security-opt seccomp=unconfined (compose: security_opt:), or give it a profile of its own.' },
  'apparmor-unconfined': { severity: 'high', title: 'AppArmor turned off', why: 'Without AppArmor\'s profile nothing limits what the container\'s processes may touch.', fix: 'Remove --security-opt apparmor=unconfined (compose: security_opt:).' },
  'host-pid': { severity: 'high', title: 'Host\'s processes shared', why: 'It sees every process on the host, and can signal or trace them.', fix: 'Remove --pid=host (compose: pid: host).' },
  'host-network': { severity: 'high', title: 'Host\'s network shared', why: 'It listens on the host\'s own interfaces and reaches what only localhost should.', fix: 'Remove --network host (compose: network_mode: host) and publish the ports it serves with -p (ports:).' },
  'host-ipc': { severity: 'high', title: 'Host\'s IPC shared', why: 'It reads and writes the host\'s shared memory.', fix: 'Remove --ipc=host (compose: ipc: host).' },
  'host-path-rw': { severity: 'high', title: 'Host folder mounted writable', why: 'A writable mount of the host\'s own folders lets the container change the host (its configuration, its keys, its kernel settings).', fix: 'Mount only the folder it needs, read only: -v src:dst:ro (compose: volumes: with :ro, or read_only: true).' },
  'public-database-port': { severity: 'high', title: 'Published on every interface', why: 'A database, cache or admin port open on 0.0.0.0 is reachable from the network, where these are scanned for all day.', fix: 'Publish it on 127.0.0.1 only: -p 127.0.0.1:port:port (compose: ports: "127.0.0.1:port:port"), or not at all and reach it over a network of containers.' },
  'public-port': { severity: 'low', title: 'Ports published on every interface', why: 'Reachable from the network, not only from this machine.', fix: 'If only this machine needs it, -p 127.0.0.1:port:port (compose: ports: "127.0.0.1:port:port").' },
  'env-secret': { severity: 'medium', title: 'Secret in an environment variable', why: 'Environment variables are shown to anyone who can run docker inspect, and end up in logs and crash reports.', fix: 'Pass it as a secret file (compose: secrets:, or a *_FILE variable) or read it from a secret store; rotate it if it was shared.' },
  root: { severity: 'medium', title: 'Runs as root', why: 'A process that breaks out of a root container is root on the host (without user namespaces).', fix: 'Run it as a user: --user 1000:1000 (compose: user: "1000:1000"), or USER in the image.' },
  'writable-rootfs': { severity: 'low', title: 'Root filesystem writable', why: 'Whoever gets in can change the container\'s programs and leave things behind.', fix: '--read-only (compose: read_only: true), with --tmpfs (tmpfs:) for the folders it writes.' },
  'no-limits': { severity: 'low', title: 'No memory or process limit', why: 'One container can take the host\'s memory or fork until nothing else runs.', fix: 'Set --memory and --pids-limit (compose: mem_limit: and pids_limit:, or deploy.resources.limits).' },
  'image-latest': { severity: 'low', title: 'Image tagged latest', why: 'latest is whatever was pushed last: what runs changes without anyone choosing it.', fix: 'Name a version, best with its digest: image:1.2.3@sha256:… (compose: image:).' },
  'image-unpinned': { severity: 'low', title: 'Image not pinned to a digest', why: 'A tag can be moved to other contents; only a digest names exactly what runs.', fix: 'Add the digest: image:tag@sha256:… (compose: image:).' },
};

// Ports a database, cache, queue or admin API listens on, by the container's side: what should never face the network.
export const SENSITIVE_PORTS = new Map([
  [3306, 'MySQL'], [33060, 'MySQL X'], [5432, 'PostgreSQL'], [1433, 'SQL Server'], [1521, 'Oracle'], [6379, 'Redis'], [11211, 'Memcached'],
  [27017, 'MongoDB'], [9200, 'Elasticsearch'], [9300, 'Elasticsearch'], [5601, 'Kibana'], [5984, 'CouchDB'], [9042, 'Cassandra'], [8086, 'InfluxDB'],
  [7474, 'Neo4j'], [8529, 'ArangoDB'], [2375, 'Docker API'], [2376, 'Docker API'], [5672, 'RabbitMQ'], [15672, 'RabbitMQ management'],
  [9092, 'Kafka'], [2181, 'ZooKeeper'], [2379, 'etcd'], [8500, 'Consul'], [6443, 'Kubernetes API'], [10250, 'kubelet'], [4222, 'NATS'], [8200, 'Vault'],
]);

// Sockets of container engines: reaching one is starting containers on the host.
const ENGINE_SOCKET = /(^|\/)(docker|podman|containerd|crio|cri-dockerd)\.sock$/;
// The host's folders whose writable mount gives the host away.
const SENSITIVE_PATHS = ['/', '/etc', '/root', '/var/run', '/run', '/proc', '/sys', '/boot', '/dev', '/var/lib/docker', '/home', '/usr', '/lib', '/bin', '/sbin'];
const POWERFUL_CAPS = new Set(['SYS_ADMIN', 'NET_ADMIN', 'ALL', 'SYS_PTRACE', 'SYS_MODULE', 'DAC_READ_SEARCH']);

const finding = (rule, where, extra = {}) => {
  const r = RULES[rule];
  return { rule, severity: r.severity, title: r.title, where, why: r.why, fix: r.fix, ...extra };
};

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Whether a host path is the engine's socket, or one of the host's folders a writable mount gives away. */
export function mountRisk(source) {
  const p = trimSlash(String(source ?? '').replace(/\\/g, '/'));
  if (!p) return null;
  if (ENGINE_SOCKET.test(p)) return 'socket';
  if (SENSITIVE_PATHS.includes(p) || /^\/(proc|sys)\//.test(p)) return 'host-path';
  return null;
}

/** Words of an environment variable's name that say it holds a secret. */
const SECRET_WORD = /^(PASSWORD|PASSWD|PASS|PWD|SECRET|SECRETS|TOKEN|KEY|APIKEY|PRIVATEKEY|CREDENTIALS?|AUTH)$/;
// Words at the end that say it holds where a secret is, or something about one, not the secret.
const NOT_SECRET_END = /^(FILE|PATH|DIR|URL|URI|ID|NAME|HEADER|LENGTH|SIZE|TTL|EXPIRY|EXPIRES|ALGORITHM|TYPE|REF|VERSION|ENABLED|MODE)$/;

/** Whether an environment variable is named like a secret (DB_PASSWORD, API_KEY, GITHUB_TOKEN), and isn't PWD or a *_FILE. */
export function secretName(name) {
  const words = String(name ?? '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (words.length < 2 && words[0] === 'PWD') return false;
  if (!words.length || NOT_SECRET_END.test(words.at(-1))) return false;
  return words.some((w) => SECRET_WORD.test(w)) || /PASSWORD|SECRET|TOKEN|APIKEY/.test(words.join(''));
}

/** Whether a value is written out, not a reference: not empty, not ${VAR}, not a path, a boolean or a short number. */
export function literalSecret(value) {
  const v = String(value ?? '').trim();
  if (v.length < 4) return false;
  if (/\$\{?[A-Za-z_]/.test(v)) return false;
  if (/^(\/|\.\/|~\/|[A-Za-z]:\\)/.test(v)) return false;
  if (/^(true|false|yes|no|on|off|null|none|changeme|change-me|xxx+|\*+)$/i.test(v)) return false;
  return !/^\d{1,6}$/.test(v);
}

/** NAME=value made safe to show: the value cut down to its first characters. */
export const redactedEnv = (name, value) => `${name}=${redact(String(value))}`;

/** An image reference's tag and digest: { tag, digest } (tag null when there is none). */
export function imageRef(image) {
  const s = String(image ?? '');
  const [name, digest = null] = s.split('@');
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  const tag = colon > slash ? name.slice(colon + 1) : null;
  return { tag, digest };
}

const imageFindings = (image, where, extra = {}) => {
  if (!image) return [];
  const { tag, digest } = imageRef(image);
  if (digest) return [];
  // An id (sha256:… or a bare hex) runs exactly one image.
  if (/^(sha256:)?[0-9a-f]{12,64}$/.test(image)) return [];
  if (!tag || tag === 'latest') return [finding('image-latest', where, { excerpt: `image: ${image}`, ...extra })];
  return [finding('image-unpinned', where, { excerpt: `image: ${image}`, ...extra })];
};

const rootUser = (user) => {
  const u = String(user ?? '').trim();
  return !u || /^(0|root)(:.*)?$/.test(u);
};

const capName = (c) => String(c).toUpperCase().replace(/^CAP_/, '');

/** A security option that turns seccomp or AppArmor off: the rule, or null. */
function unconfined(opt) {
  const m = /^(seccomp|apparmor)\s*[=:]\s*unconfined$/i.exec(String(opt ?? '').trim());
  return m ? `${m[1].toLowerCase()}-unconfined` : null;
}

/** A published port's host address faces every interface: empty, 0.0.0.0 or ::. */
const everyInterface = (ip) => !ip || ip === '0.0.0.0' || ip === '::' || ip === '[::]';

/** The ports findings for a list of { inner, host, ip }: one per sensitive port, one for the others together. */
function portFindings(published, where, lineFor = () => ({})) {
  const out = [];
  const others = [];
  const seen = new Set();
  for (const p of published) {
    if (!everyInterface(p.ip)) continue;
    const key = `${p.inner}/${p.host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const service = SENSITIVE_PORTS.get(p.inner) ?? SENSITIVE_PORTS.get(p.host);
    const shown = `${p.ip || '0.0.0.0'}:${p.host || '(any)'}->${p.inner}`;
    if (service) out.push(finding('public-database-port', where, { title: `${service} published on every interface`, port: p.inner, excerpt: shown, ...lineFor(p) }));
    else others.push({ p, shown });
  }
  if (others.length) out.push(finding('public-port', where, { excerpt: others.map((o) => o.shown).join(', '), ...lineFor(others[0].p) }));
  return out;
}

/** "6379/tcp" → 6379. */
const portNumber = (spec) => Number(String(spec).split('/')[0]) || null;

/**
 * What one container's `docker inspect` says, judged: its findings, `where` its name. Works with
 * Podman's inspect too, which has the same fields.
 */
export function judgeContainer(c) {
  const name = String(c?.Name ?? c?.Id ?? '?').replace(/^\//, '');
  const host = c?.HostConfig ?? {};
  const config = c?.Config ?? {};
  const out = [];
  if (host.Privileged) out.push(finding('privileged', name, { excerpt: '"Privileged": true' }));
  for (const cap of host.CapAdd ?? []) if (POWERFUL_CAPS.has(capName(cap))) out.push(finding('cap-add', name, { title: `${capName(cap)} capability added`, excerpt: `CapAdd: ${cap}` }));
  for (const opt of host.SecurityOpt ?? []) {
    const rule = unconfined(opt);
    if (rule) out.push(finding(rule, name, { excerpt: `SecurityOpt: ${opt}` }));
  }
  if (host.PidMode === 'host') out.push(finding('host-pid', name, { excerpt: 'PidMode: host' }));
  if (host.NetworkMode === 'host') out.push(finding('host-network', name, { excerpt: 'NetworkMode: host' }));
  if (host.IpcMode === 'host') out.push(finding('host-ipc', name, { excerpt: 'IpcMode: host' }));

  // Mounts has what Binds and --mount made alike; Binds is read too for an inspect without Mounts.
  const mounts = (c?.Mounts ?? []).filter((m) => !m.Type || m.Type === 'bind').map((m) => ({ source: m.Source, target: m.Destination, rw: m.RW !== false }));
  if (!c?.Mounts) for (const b of host.Binds ?? []) {
    const [source, target, mode = ''] = String(b).split(':');
    mounts.push({ source, target, rw: !/(^|,)ro(,|$)/.test(mode) });
  }
  for (const m of mounts) {
    const risk = mountRisk(m.source);
    const shown = `${m.source}:${m.target} (${m.rw ? 'read-write' : 'read only'})`;
    if (risk === 'socket') out.push(finding('docker-socket', name, { title: m.rw ? 'Container engine socket mounted read-write' : 'Container engine socket mounted', excerpt: shown }));
    else if (risk === 'host-path' && m.rw) out.push(finding('host-path-rw', name, { title: `Host's ${m.source} mounted writable`, excerpt: shown }));
  }

  if (rootUser(config.User)) out.push(finding('root', name, { excerpt: `User: ${config.User ? config.User : '(none: root)'}` }));
  if (!host.ReadonlyRootfs) out.push(finding('writable-rootfs', name, { excerpt: 'ReadonlyRootfs: false' }));

  // NetworkSettings.Ports is what's published now; PortBindings what was asked for (a stopped container has only that).
  const ports = c?.NetworkSettings?.Ports && Object.values(c.NetworkSettings.Ports).some(Boolean) ? c.NetworkSettings.Ports : host.PortBindings ?? {};
  const published = [];
  for (const [spec, bindings] of Object.entries(ports)) for (const b of bindings ?? []) published.push({ inner: portNumber(spec), host: Number(b.HostPort) || null, ip: b.HostIp ?? '' });
  if (host.NetworkMode !== 'host') out.push(...portFindings(published, name));

  for (const entry of config.Env ?? []) {
    const i = String(entry).indexOf('=');
    if (i <= 0) continue;
    const [key, value] = [entry.slice(0, i), entry.slice(i + 1)];
    if (secretName(key) && literalSecret(value)) out.push(finding('env-secret', name, { title: `${key} in the environment`, excerpt: redactedEnv(key, value) }));
  }

  const missing = [!host.Memory && 'memory', !(host.PidsLimit > 0) && 'processes'].filter(Boolean);
  if (missing.length) out.push(finding('no-limits', name, { excerpt: `No limit on ${missing.join(' or ')}` }));
  out.push(...imageFindings(config.Image, name));
  return out;
}

/** Every container of a `docker inspect` (the array it prints, as text or parsed), judged; worst first. */
export function judgeInspect(inspected) {
  const list = typeof inspected === 'string' ? JSON.parse(inspected || '[]') : inspected;
  return sortFindings((Array.isArray(list) ? list : [list]).flatMap((c) => judgeContainer(c)));
}

/** compose's short port syntax ("127.0.0.1:8080:80/tcp", "6379:6379", "6379", "8000-8010:8000-8010") or long ({ target, published, host_ip }), as { inner, host, ip }. */
export function composePorts(entry) {
  if (entry && typeof entry === 'object') {
    if (entry.mode === 'host' && !entry.published) return [];
    return [{ inner: Number(entry.target) || null, host: Number(String(entry.published ?? '').split('-')[0]) || null, ip: entry.host_ip ?? '' }];
  }
  const s = String(entry ?? '').replace(/\/\w+$/, '');
  // An IPv6 address is in brackets; the rest splits at its colons.
  const v6 = /^\[([^\]]*)\]:(.*)$/.exec(s);
  const parts = v6 ? [v6[1], ...v6[2].split(':')] : s.split(':');
  const first = (p) => Number(String(p).split('-')[0]) || null;
  if (parts.length === 1) return [{ inner: first(parts[0]), host: null, ip: '' }];
  if (parts.length === 2) return [{ inner: first(parts[1]), host: first(parts[0]), ip: '' }];
  return [{ inner: first(parts.at(-1)), host: first(parts.at(-2)), ip: parts.slice(0, -2).join(':') }];
}

/** compose's short volume syntax ("./data:/data:ro", "/var/run/docker.sock:/var/run/docker.sock") or long ({ type, source, target, read_only }), as { source, target, rw } for a bind; null for a named volume. */
export function composeVolume(entry) {
  if (entry && typeof entry === 'object') {
    if (entry.type && entry.type !== 'bind') return null;
    return { source: String(entry.source ?? ''), target: String(entry.target ?? ''), rw: entry.read_only !== true };
  }
  const s = String(entry ?? '');
  // A Windows drive (C:\…) keeps its colon.
  const m = /^((?:[A-Za-z]:)?[^:]*)(?::([^:]*))?(?::([^:]*))?$/.exec(s);
  if (!m) return null;
  const [, source, target = '', mode = ''] = m;
  if (!target) return null;
  // A name without a slash is a named volume, not a folder of the host.
  if (!/[/\\~.]/.test(source[0] ?? '') && !/^[A-Za-z]:/.test(source)) return null;
  return { source, target, rw: !/(^|,)ro(,|$)/.test(mode) };
}

/** A service's environment as [{ key, value, line }], from either of compose's forms. */
function composeEnv(service) {
  const env = service.environment;
  if (Array.isArray(env)) {
    return env.map((e, i) => {
      const s = String(e ?? '');
      const at = s.indexOf('=');
      return { key: at < 0 ? s : s.slice(0, at), value: at < 0 ? null : s.slice(at + 1), line: lineOf(env, i) };
    });
  }
  if (env && typeof env === 'object') return Object.entries(env).map(([key, value]) => ({ key, value, line: lineOf(env, key) }));
  return [];
}

const listOf = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * A compose file's services, judged before they run: `path` is what the findings' `where` says (the
 * file, as the person named it), each with the line of the key that's wrong. A service that only builds
 * (`build:` without `image:`) has no image to pin. Root is said only for an explicit `user: root`:
 * without `user:` it's the image's USER, which Bilge reads in the Dockerfile.
 */
export function judgeCompose(path, text) {
  const out = [];
  for (const { name, service: s, line: serviceLine } of composeServices(text)) {
    const at = (key, extra = {}) => ({ line: lineOf(s, key) ?? serviceLine, service: name, ...extra });
    const titled = (rule, extra = {}) => ({ title: `${extra.title ?? RULES[rule].title} (${name})` });
    const add = (rule, extra) => out.push(finding(rule, path, { ...extra, ...titled(rule, extra) }));
    if (s.privileged === true) add('privileged', { ...at('privileged'), excerpt: 'privileged: true' });
    for (const [i, cap] of listOf(s.cap_add).entries()) if (POWERFUL_CAPS.has(capName(cap))) add('cap-add', { ...at('cap_add'), line: lineOf(s.cap_add, i) ?? lineOf(s, 'cap_add'), title: `${capName(cap)} capability added`, excerpt: `cap_add: ${cap}` });
    for (const [i, opt] of listOf(s.security_opt).entries()) {
      const rule = unconfined(opt);
      if (rule) add(rule, { ...at('security_opt'), line: lineOf(s.security_opt, i) ?? lineOf(s, 'security_opt'), excerpt: `security_opt: ${opt}` });
    }
    if (s.pid === 'host') add('host-pid', { ...at('pid'), excerpt: 'pid: host' });
    if (s.network_mode === 'host') add('host-network', { ...at('network_mode'), excerpt: 'network_mode: host' });
    if (s.ipc === 'host') add('host-ipc', { ...at('ipc'), excerpt: 'ipc: host' });

    for (const [i, v] of listOf(s.volumes).entries()) {
      const m = composeVolume(v);
      if (!m) continue;
      const risk = mountRisk(m.source);
      const line = lineOf(s.volumes, i) ?? lineOf(s, 'volumes');
      const rw = m.rw && s.read_only !== true;
      const shown = `${m.source}:${m.target} (${rw ? 'read-write' : 'read only'})`;
      if (risk === 'socket') add('docker-socket', { ...at('volumes'), line, title: rw ? 'Container engine socket mounted read-write' : 'Container engine socket mounted', excerpt: shown });
      else if (risk === 'host-path' && m.rw) add('host-path-rw', { ...at('volumes'), line, title: `Host's ${m.source} mounted writable`, excerpt: shown });
    }

    if (s.user != null && rootUser(s.user)) add('root', { ...at('user'), excerpt: `user: ${s.user}` });
    if (s.read_only !== true) add('writable-rootfs', { ...at('read_only'), excerpt: s.read_only === false ? 'read_only: false' : 'no read_only: true' });

    if (s.network_mode !== 'host') {
      const ports = [];
      for (const [i, p] of listOf(s.ports).entries()) for (const one of composePorts(p)) ports.push({ ...one, line: lineOf(s.ports, i) ?? lineOf(s, 'ports') });
      for (const f of portFindings(ports, path, (p) => ({ line: p.line, service: name }))) out.push({ ...f, title: `${f.title} (${name})` });
    }

    for (const e of composeEnv(s)) {
      if (secretName(e.key) && e.value != null && literalSecret(e.value)) add('env-secret', { ...at('environment'), line: e.line ?? lineOf(s, 'environment'), title: `${e.key} in the compose file`, excerpt: redactedEnv(e.key, e.value) });
    }

    const limits = s.deploy?.resources?.limits ?? {};
    const missing = [!(s.mem_limit || limits.memory) && 'memory', !(Number(s.pids_limit) > 0 || Number(limits.pids) > 0) && 'processes'].filter(Boolean);
    if (missing.length) add('no-limits', { ...at('image'), line: serviceLine, excerpt: `No limit on ${missing.join(' or ')}` });
    if (s.image) out.push(...imageFindings(String(s.image), path, at('image')).map((f) => ({ ...f, title: `${f.title} (${name})` })));
  }
  return sortFindings(out);
}

/** Each container's worst finding: a Map from its name to the severity, for the Containers list's marker. */
export function worstByContainer(findings) {
  const out = new Map();
  for (const f of findings) {
    const was = out.get(f.where);
    if (!was || rank(f.severity) < rank(was)) out.set(f.where, f.severity);
  }
  return out;
}

/** The name of the colour (a key of theme) a severity is drawn in. */
export const severityTone = (s) => (s === 'critical' || s === 'high' ? 'del' : s === 'medium' ? 'warn' : 'dim');

/** A finding as the detail shows it (and y copies): what, where, why, what was seen, the fix. */
export function findingDetail(f) {
  const lines = [
    `${f.title}`,
    `${f.severity}  ·  ${f.line ? `${f.where}:${f.line}` : f.where}${f.service ? `  ·  service ${f.service}` : ''}  ·  ${f.rule}`,
    '',
  ];
  if (f.why) lines.push(f.why, '');
  if (f.excerpt) lines.push('Seen:', `  ${f.excerpt}`, '');
  if (f.fix) lines.push('Fix:', `  ${f.fix}`);
  return `${lines.join('\n').trimEnd()}\n`;
}
