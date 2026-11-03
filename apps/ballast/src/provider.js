// Everything Ballast reads and runs goes through one object with one interface: `read(dir, { stats,
// outDirs })` (a stats file or the output folders, disk.js), `budgets(dir)` (ballast.json or
// package.json's fleet.ballast), `plan(dir)` and `build(dir, plan)` (the project's build once with stats
// on, through the kit's run.js), `git(dir)` and `resolveRef(dir, ref)`, `buildRef(dir, ref)` (a build
// of another commit in a git worktree of its own), `runs(root)` and `saveRun(root, summary)` (the
// summaries kept in ~/.ballast), `advisories(packages)` (OSV, through the kit's osv.js), `security(dir)`
// and `writeFile`. demo.js's demoBallast() has the same interface for --demo and the tests.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run as runCommand } from '@fleet/kit/run.js';
import { createOsv } from '@fleet/kit/osv.js';
import { keyOf } from '@fleet/kit/lockfiles.js';
import { configDir } from './config.js';
import { projectFiles, readBudgetsFile, readBuild, readSecurity } from './disk.js';
import { buildPlan, installCommand, safePath, safeRef } from './buildplan.js';
import { loadRuns, saveRun } from './history.js';
import { advisoriesFor } from './advisories.js';

const firstLine = (s) => String(s ?? '').trim().split('\n')[0];

export function createBallast({ run = runCommand, home = configDir, fetchImpl = globalThis.fetch, now = Date.now, temp = () => join(tmpdir(), `ballast-${randomUUID().slice(0, 8)}`) } = {}) {
  const homeDir = () => (typeof home === 'function' ? home() : home);
  const osv = createOsv({ fetchImpl });
  const git = (dir, args, opts = {}) => run(`git ${args}`, { cwd: dir, ...opts }).then((r) => r.stdout.trim());

  /** Runs `plan` in `dir`, reads what it wrote, and removes Ballast's own folder for it whatever happened. */
  async function build(dir, plan, { signal, onLine } = {}) {
    if (plan.temp) mkdirSync(plan.temp, { recursive: true });
    try {
      await run(plan.command, { cwd: dir, signal, onLine });
      if (plan.statsPath) return await readBuild(dir, { statsPath: plan.statsPath, now });
      if (plan.outDir) return await readBuild(dir, { outDirs: [{ dir: plan.outDir, label: plan.outLabel ?? 'dist' }], now });
      return await readBuild(dir, { now });
    } finally {
      if (plan.temp) rmSync(plan.temp, { recursive: true, force: true });
    }
  }

  const planFor = (dir) => {
    const t = temp();
    const { pkg, files } = projectFiles(dir);
    const plan = buildPlan({ pkg, files, temp: t });
    return plan && { ...plan, temp: t };
  };

  return {
    name: 'disk',
    read: async (dir, { stats = null, outDirs = null } = {}) => readBuild(dir, { statsPath: stats, outDirs, now }),
    budgets: (dir) => readBudgetsFile(dir),
    /** How the project builds with stats on ({ tool, command, text, … }), or null when nothing says. */
    plan: (dir) => planFor(dir),
    build,
    /** { commit, branch, dirty } of the working tree, or null outside a git repository. */
    async git(dir, { signal } = {}) {
      try {
        const commit = await git(dir, 'rev-parse HEAD', { signal });
        const branch = await git(dir, 'rev-parse --abbrev-ref HEAD', { signal }).catch(() => null);
        const status = await git(dir, 'status --porcelain --untracked-files=no', { signal }).catch(() => '');
        return { commit, branch: branch === 'HEAD' ? null : branch, dirty: Boolean(status) };
      } catch (e) {
        if (e.cancelled) throw e;
        return null;
      }
    },
    /** The commit `ref` names (main, else origin/main for main), or null. */
    async resolveRef(dir, ref, { signal } = {}) {
      if (!safeRef(ref)) return null;
      for (const r of ref === 'main' ? ['main', 'origin/main', 'master', 'origin/master'] : [ref]) {
        try {
          // Quoted: cmd.exe reads a bare ^ as its escape.
          return await git(dir, `rev-parse --verify --quiet "${r}^{commit}"`, { signal });
        } catch (e) {
          if (e.cancelled) throw e;
        }
      }
      return null;
    },
    /**
     * A build of `commit` in a git worktree of its own (removed afterwards, whatever happened): its
     * packages installed as its lock file says, then built with stats as plan() would. The project's
     * place in the repository is kept, so its files are named as this one's are.
     */
    async buildRef(dir, commit, { signal, progress = () => {} } = {}) {
      if (!safeRef(commit)) throw new Error(`${commit} isn't a commit Ballast will put in a command.`);
      const prefix = await git(dir, 'rev-parse --show-prefix', { signal }).catch(() => '');
      const top = await git(dir, 'rev-parse --show-toplevel', { signal });
      const tree = temp();
      if (!safePath(tree)) throw new Error(`The temporary folder ${tree} can't go in a command line.`);
      progress('making the worktree');
      await git(top, `worktree add --detach "${tree}" ${commit}`, { signal });
      try {
        const project = join(tree, prefix);
        const { files } = projectFiles(project);
        progress('installing its packages');
        await run(installCommand(files), { cwd: project, signal });
        const plan = planFor(project);
        if (!plan) throw new Error(`Nothing says how ${commit.slice(0, 7)} builds: no build script in its package.json.`);
        progress(`building (${plan.tool})`);
        return await build(project, plan, { signal });
      } finally {
        await run(`git worktree remove --force "${tree}"`, { cwd: top }).catch(() => rmSync(tree, { recursive: true, force: true }));
      }
    },
    runs: (root) => loadRuns(homeDir(), root),
    saveRun: (root, summary) => saveRun(homeDir(), root, summary),
    /** Map name@version → advisories (advisories.js's), from OSV, for [{ name, version }]. */
    async advisories(list, { signal } = {}) {
      const pkgs = list.filter((p) => p.version).map((p) => ({ ecosystem: 'npm', name: p.name, version: p.version, key: keyOf({ ecosystem: 'npm', name: p.name, version: p.version }) }));
      const ids = await osv.query(pkgs, { signal });
      const details = await osv.vulns([...ids.values()].flat(), { signal });
      return new Map(pkgs.map((p) => [`${p.name}@${p.version}`, advisoriesFor(p.name, p.version, ids.get(p.key) ?? [], details)]));
    },
    security: async (dir, { outDirs = null } = {}) => readSecurity(dir, { outDirs }),
    writeFile(path, text) {
      mkdirSync(dirname(resolve(path)), { recursive: true });
      writeFileSync(path, text);
    },
    explain: (e) => firstLine(e?.message),
  };
}
