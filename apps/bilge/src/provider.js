// Everything Bilge reads and does goes through one object with one interface: `scan(dir)` (the lock
// files, from the disk), `audit(packages, { fresh })` (OSV's advisories, kept between runs), `latest(packages)` (the registries),
// `needs(pkg, version)` and `fitting(pkg, fits)` (what a version needs to run, and the newest that
// fits), `run(command, { cwd })` (a fix, git and the tests for /upgrade, through the kit's run.js),
// `tests(manifests, root)` (what tests a project has), `usages(root, pkg)` and `claude(prompt)`
// (/breaking) and `writeFile` (an SBOM). demo.js's
// demoBilge() has the same interface for --demo and the tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run as runCommand } from '@fleet/kit/run.js';
import { configDir } from './config.js';
import { createOsvCache } from './cache.js';
import { scanFolder } from './lockfiles.js';
import { createOsv } from './osv.js';
import { createRegistry } from './registry.js';
import { testPlan } from './upgrade.js';
import { findUsages } from './breaking.js';
import { FAST, clip, runClaude } from '@fleet/kit/claude-cli.js';

// What Claude may use for /breaking: read and search the project, and fetch a page (WebFetch, allowed
// without asking, as nothing else can be: there's no terminal to ask in).
const CLAUDE_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch'];

// `home` is Bilge's folder (config.js's, read when asked, so BILGE_HOME moves it), where OSV's answers
// are kept between runs.
export function createBilge({ fetchImpl = globalThis.fetch, run = runCommand, home = configDir, now = Date.now, execImpl } = {}) {
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
    /** The lines under `root` that import `pkg` (breaking.js's findUsages): [{ path, line, text }]. */
    usages: async (root, pkg, { signal } = {}) => findUsages(root, pkg, { signal }),
    /**
     * Claude's answer to `prompt` about `input`, through the Claude Code CLI signed in as the person
     * (the kit's claude-cli.js): it may read the project and fetch a page (release notes), never
     * change or run anything. Rejects saying so when claude isn't installed.
     */
    async claude(prompt, { input = '', cwd, signal } = {}) {
      const r = await runClaude(['-p', prompt, '--tools', CLAUDE_TOOLS.join(','), '--allowedTools', 'WebFetch', ...FAST], { input: clip(input), cwd, signal, execImpl });
      if (r.failed) throw new Error(r.message);
      return r.stdout.trim();
    },
    /** The tests to run after /upgrade changed `manifests` (upgrade.js's testPlan, from the disk): [{ command, cwd }]. */
    tests: async (manifests, root) => testPlan(manifests, root),
    writeFile(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
  };
}
