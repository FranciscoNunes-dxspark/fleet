// Everything Bilge reads and does goes through one object with one interface: `scan(dir)` (the lock
// files, from the disk), `audit(packages, { fresh })` (OSV's advisories, kept between runs), `latest(packages)` (the registries),
// `needs(pkg, version)` and `fitting(pkg, fits)` (what a version needs to run, and the newest that
// fits), `run(command, { cwd })` (a fix, through the kit's run.js) and `writeFile` (an SBOM). demo.js's
// demoBilge() has the same interface for --demo and the tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run as runCommand } from '@fleet/kit/run.js';
import { configDir } from './config.js';
import { createOsvCache } from './cache.js';
import { scanFolder } from './lockfiles.js';
import { createOsv } from './osv.js';
import { createRegistry } from './registry.js';

// `home` is Bilge's folder (config.js's, read when asked, so BILGE_HOME moves it), where OSV's answers
// are kept between runs.
export function createBilge({ fetchImpl = globalThis.fetch, run = runCommand, home = configDir, now = Date.now } = {}) {
  const osv = createOsv({ fetchImpl });
  const registry = createRegistry({ fetchImpl });
  return {
    name: 'osv',
    async scan(dir) {
      return scanFolder(dir);
    },
    /**
     * { ids: Map key → [id], details: Map id → record, cached } for `packages`: OSV's answers from the
     * last hours where they're kept (`cached` how many packages were answered so), unless `fresh`.
     */
    async audit(packages, { signal, fresh = false } = {}) {
      const cache = createOsvCache({ dir: join(typeof home === 'function' ? home() : home, 'cache'), now });
      const cached = fresh ? 0 : packages.filter((p) => cache.query(p.key) !== undefined).length;
      const ids = await osv.query(packages, { signal, cache, fresh });
      const details = await osv.vulns([...ids.values()].flat(), { signal, cache, fresh });
      cache.save();
      return { ids, details, cached };
    },
    latest: (packages, opts) => registry.latest(packages, opts),
    needs: (pkg, version, opts) => registry.needs(pkg, version, opts),
    fitting: (pkg, fits, opts) => registry.fitting(pkg, fits, opts),
    run: (command, { cwd, signal } = {}) => run(command, { cwd, signal }),
    writeFile(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
  };
}
