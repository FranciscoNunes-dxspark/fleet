// What /upgrade does, worked out before anything runs: the direct packages that have a newer version
// which fits the project (the newest, or else the newest that fits, from /outdated), each with the
// exact-version command for every manifest that asks for it; the branch they go on; and the project's
// tests that say whether it still works. Pure, but for `testPlan`'s default readers of the disk.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { problems } from './compat.js';
import { toolOf, updateCommand } from './fix.js';
import { compareVersions } from './versions.js';

/**
 * The updates that fit: [{ pkg, to, capped, steps: [{ command, cwd, manifest }] }], by name. `capped`
 * when the newest version doesn't fit and an older one does. `data` is App's, with `latest` asked.
 */
export function upgradeCandidates(data) {
  const out = [];
  for (const pkg of data?.packages ?? []) {
    const latest = data.latest?.get(pkg.key);
    if (!pkg.direct || !latest?.latest || compareVersions(latest.latest, pkg.version) <= 0) continue;
    const fits = !problems(pkg, latest.latest, latest.needs, data).length;
    const to = fits ? latest.latest : latest.fits?.version;
    if (!to || compareVersions(to, pkg.version) <= 0) continue;
    // In each manifest that asks for it itself, as that one asks (a development dependency stays one).
    const steps = [];
    for (const manifest of data.manifests.filter((m) => pkg.where.some((w) => w.path === m.path))) {
      const own = manifest.packages.find((q) => q.direct && q.version === pkg.version && q.name.toLowerCase() === pkg.name.toLowerCase());
      const run = own && updateCommand({ ...pkg, dev: own.dev }, manifest, to);
      if (run) steps.push({ ...run, manifest });
    }
    if (steps.length) out.push({ pkg, to, capped: !fits, steps });
  }
  return out.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name, undefined, { sensitivity: 'base' }));
}

/** The branch the updates go on: bilge/updates-<yyyy-mm-dd>, the local date. */
export function branchName(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  return `bilge/updates-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** A folder under `root` as Bilge shows it: relative, '/'-separated, '.' for the top. */
export const folderLabel = (root, dir) => relative(root, dir).split(/[\\/]/).filter(Boolean).join('/') || '.';

// npm init's test script, which only says there are no tests.
const NO_TESTS = /no test specified/i;
const PLAIN_FILE = /^[\w][\w .-]*$/;

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * The project's tests for the manifests an upgrade changed: [{ command, cwd }], once each. A
 * JavaScript manifest's package.json test script (npm test, yarn test or pnpm test); for a .NET
 * project, dotnet test on the nearest solution at or above it (up to `root`), else on the project.
 * `readJson` and `list` read the disk, and stand in for it in the demo.
 */
export function testPlan(manifests, root, { readJson: read = readJson, list = listDir } = {}) {
  const out = new Map();
  for (const m of manifests) {
    if (m.ecosystem === 'npm') {
      const script = read(join(m.dir, 'package.json'))?.scripts?.test;
      if (typeof script === 'string' && script.trim() && !NO_TESTS.test(script)) out.set(`${m.dir}\0test`, { command: `${toolOf(m)} test`, cwd: m.dir });
    } else if (m.ecosystem === 'NuGet' && m.project) {
      let found = null;
      for (let d = m.dir; ; d = dirname(d)) {
        const sln = list(d).filter((n) => /\.slnx?$/i.test(n) && PLAIN_FILE.test(n)).sort()[0];
        if (sln) {
          found = { command: `dotnet test "${sln}"`, cwd: d };
          break;
        }
        if (d === root || dirname(d) === d || relative(root, d).startsWith('..')) break;
      }
      const project = basename(m.project);
      found ??= PLAIN_FILE.test(project) ? { command: `dotnet test "${project}"`, cwd: m.dir } : null;
      if (found) out.set(`${found.cwd}\0${found.command}`, found);
    }
  }
  return [...out.values()];
}
