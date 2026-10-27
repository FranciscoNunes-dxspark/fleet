// Docker, through its command line (the kit's run.js: nothing here waits on a prompt). `createDocker`
// is the one provider the app talks to; demo.js has the same interface for --demo and the tests, so
// a new operation needs both. The parsers are pure: they read `docker ... --format "{{json .}}"`,
// which prints a JSON object per line.
import { run as kitRun } from '@fleet/kit/run.js';

/** The JSON objects of a `--format "{{json .}}"` listing, one per line; lines that aren't JSON are dropped. */
export function jsonLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A warning mixed into the output.
    }
  }
  return out;
}

/** A Labels string, "a=b,c=d", as an object. */
export function labelsOf(text) {
  const out = {};
  for (const part of String(text ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** "Up 2 hours (healthy)" → 'healthy'; 'unhealthy', 'starting', or null when there is no health check. */
export function healthOf(status) {
  return /\((healthy|unhealthy|health: starting)\)/.exec(String(status ?? ''))?.[1]?.replace('health: ', '') ?? null;
}

/** "Exited (137) 3 minutes ago" → 137; null for a container that hasn't exited. */
export function exitCodeOf(status) {
  const m = /^Exited \((-?\d+)\)/.exec(String(status ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * The host ports a Ports string publishes, once each and in order: "0.0.0.0:8080->80/tcp, :::8080->80/tcp,
 * 5432/tcp" → [8080]. Ports that are only exposed (no host side) aren't in it.
 */
export function hostPorts(text) {
  const seen = [];
  for (const m of String(text ?? '').matchAll(/:(\d+)(?:-\d+)?->/g)) {
    const n = Number(m[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

/** A Ports string made short: "8080→80, 5432" (an unpublished port is its container side alone). */
export function shortPorts(text) {
  const out = [];
  for (const part of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /(?:.*:)?(\d+)(?:-\d+)?->(\d+)(?:-\d+)?\/\w+/.exec(part);
    const label = m ? `${m[1]}→${m[2]}` : part.replace(/\/\w+$/, '');
    if (!out.includes(label)) out.push(label);
  }
  return out.join(', ');
}

/** `docker ps -a` as { id, name, image, state, status, ports, hostPorts, created, project, service, health, exitCode }. */
export function parseContainers(text) {
  return jsonLines(text).map((o) => {
    const labels = labelsOf(o.Labels);
    return {
      id: o.ID,
      name: String(o.Names ?? '').split(',')[0],
      image: o.Image,
      state: String(o.State ?? '').toLowerCase(),
      status: o.Status ?? '',
      ports: o.Ports ?? '',
      hostPorts: hostPorts(o.Ports),
      created: o.RunningFor ?? '',
      project: labels['com.docker.compose.project'] ?? null,
      service: labels['com.docker.compose.service'] ?? null,
      // Where the project's compose files are, so /up and /down can find them from anywhere.
      workingDir: labels['com.docker.compose.project.working_dir'] ?? null,
      configFiles: labels['com.docker.compose.project.config_files'] ?? null,
      health: healthOf(o.Status),
      exitCode: exitCodeOf(o.Status),
    };
  });
}

/** "12.5MiB / 1.9GiB" → the first number, in bytes; null when it isn't one. */
export function bytesOf(text) {
  const m = /^\s*([\d.]+)\s*([kmgt]?i?b)/i.exec(String(text ?? ''));
  if (!m) return null;
  const unit = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * unit);
}

/** `docker stats --no-stream` as a Map from a container's short id to { cpu (percent), mem (bytes), memPercent }. */
export function parseStats(text) {
  const out = new Map();
  for (const o of jsonLines(text)) {
    const id = String(o.ID ?? o.Container ?? '');
    if (!id) continue;
    out.set(id.slice(0, 12), { cpu: parseFloat(o.CPUPerc) || 0, mem: bytesOf(String(o.MemUsage ?? '').split('/')[0]) ?? 0, memPercent: parseFloat(o.MemPerc) || 0 });
  }
  return out;
}

/** `docker images` as { id, repo, tag, size, created, dangling }. */
export function parseImages(text) {
  return jsonLines(text).map((o) => ({
    id: o.ID,
    repo: o.Repository === '<none>' ? null : o.Repository,
    tag: o.Tag === '<none>' ? null : o.Tag,
    size: o.Size ?? '',
    created: o.CreatedSince ?? '',
    dangling: o.Repository === '<none>' && o.Tag === '<none>',
  }));
}

// What's passed to the shell has to be what Docker made (an id, or a name or image it accepts), never more.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;
export const safe = (s) => SAFE.test(String(s ?? ''));
const need = (s) => {
  if (!safe(s)) throw new Error(`"${s}" isn't a container or image Docker would have named.`);
  return s;
};

/** What a missing or stopped Docker's error means, as a line to show; null for any other error. */
export function dockerProblem(message) {
  const m = String(message ?? '');
  if (/not recognized|ENOENT|command not found|not found/i.test(m) && /docker/i.test(m)) return "Docker isn't installed (or isn't on the PATH).";
  if (/daemon|pipe|Cannot connect|connection refused|no such file|permission denied/i.test(m)) return "Docker isn't running: start Docker Desktop or the daemon.";
  return null;
}

// A path goes to the shell in quotes, so it may hold spaces but nothing that ends the quoting.
const quoted = (p) => {
  if (/["\r\n%$`]/.test(p)) throw new Error(`"${p}" isn't a path Wharf will pass to the shell.`);
  return `"${p}"`;
};

/** The `docker compose` command for `verb` ('up' or 'down') on a project found by its labels (a container's `project`, `workingDir`, `configFiles`). */
export function composeCommand(verb, { project, workingDir, configFiles }) {
  if (!['up', 'down'].includes(verb)) throw new Error(`Unknown action: ${verb}`);
  const parts = ['docker compose', '-p', need(project)];
  if (workingDir) parts.push('--project-directory', quoted(workingDir));
  for (const f of String(configFiles ?? '').split(',').filter(Boolean)) parts.push('-f', quoted(f));
  parts.push(verb === 'up' ? 'up -d' : 'down');
  return parts.join(' ');
}

const VERBS = new Set(['start', 'stop', 'restart', 'kill', 'pause', 'unpause']);

/** The provider for a real Docker: `run(command, { signal })` is injectable for tests. */
export function createDocker({ run = kitRun } = {}) {
  return {
    name: 'docker',
    async containers({ signal } = {}) {
      const { stdout } = await run('docker ps -a --format "{{json .}}"', { signal });
      return parseContainers(stdout);
    },
    async stats({ signal } = {}) {
      const { stdout } = await run('docker stats --no-stream --format "{{json .}}"', { signal });
      return parseStats(stdout);
    },
    async images({ signal } = {}) {
      const { stdout } = await run('docker images --format "{{json .}}"', { signal });
      return parseImages(stdout);
    },
    async logs(id, { tail = 500, signal } = {}) {
      const { stdout, stderr } = await run(`docker logs --timestamps --tail ${Number(tail) || 500} ${need(id)}`, { signal });
      // A container's own stderr comes back on docker's stderr; both are its log.
      return [stdout, stderr].filter(Boolean).join('');
    },
    async inspect(id) {
      const { stdout } = await run(`docker inspect ${need(id)}`);
      return stdout;
    },
    async act(verb, ids, { signal } = {}) {
      if (!VERBS.has(verb)) throw new Error(`Unknown action: ${verb}`);
      const { stdout } = await run(`docker ${verb} ${ids.map(need).join(' ')}`, { signal });
      return stdout;
    },
    async remove(ids, { force = false, signal } = {}) {
      const { stdout } = await run(`docker rm${force ? ' -f' : ''} ${ids.map(need).join(' ')}`, { signal });
      return stdout;
    },
    async removeImage(id, { force = false, signal } = {}) {
      const { stdout } = await run(`docker rmi${force ? ' -f' : ''} ${need(id)}`, { signal });
      return stdout;
    },
    async pull(image, { signal } = {}) {
      const { stdout } = await run(`docker pull ${need(image)}`, { signal });
      return stdout;
    },
    // A compose project's `up -d` or `down`, run where its files are.
    async compose(verb, project, { signal } = {}) {
      const { stdout, stderr } = await run(composeCommand(verb, project), { signal, cwd: project.workingDir || undefined });
      // Compose reports its progress on stderr.
      return [stdout, stderr].filter(Boolean).join('');
    },
    // One command inside a running container, without a terminal: its output, or its failure.
    async exec(id, command, { signal } = {}) {
      const { stdout, stderr } = await run(`docker exec ${need(id)} ${command}`, { signal });
      return [stdout, stderr].filter(Boolean).join('');
    },
    // Stopped containers, or the images nothing uses.
    async prune(kind, { signal } = {}) {
      const { stdout } = await run(kind === 'images' ? 'docker image prune -f' : 'docker container prune -f', { signal });
      return stdout;
    },
  };
}
