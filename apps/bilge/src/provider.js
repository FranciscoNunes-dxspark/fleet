// Everything Bilge reads and does goes through one object with one interface: `scan(dir)` (the lock
// files, from the disk), `audit(packages)` (OSV's advisories), `latest(packages)` (the registries),
// `run(command, { cwd })` (a fix, through the kit's run.js) and `writeFile` (an SBOM). demo.js's
// demoBilge() has the same interface for --demo and the tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { run as runCommand } from '@fleet/kit/run.js';
import { scanFolder } from './lockfiles.js';
import { createOsv } from './osv.js';
import { createRegistry } from './registry.js';

export function createBilge({ fetchImpl = globalThis.fetch, run = runCommand } = {}) {
  const osv = createOsv({ fetchImpl });
  const registry = createRegistry({ fetchImpl });
  return {
    name: 'osv',
    async scan(dir) {
      return scanFolder(dir);
    },
    /** { ids: Map key → [id], details: Map id → record } for `packages`. */
    async audit(packages, { signal } = {}) {
      const ids = await osv.query(packages, { signal });
      const details = await osv.vulns([...ids.values()].flat(), { signal });
      return { ids, details };
    },
    latest: (packages, opts) => registry.latest(packages, opts),
    run: (command, { cwd, signal } = {}) => run(command, { cwd, signal }),
    writeFile(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
  };
}
