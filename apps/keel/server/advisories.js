// The daily advisory watch: for the repositories of the projects people track, the lock files on
// each one's default branch (read through Azure DevOps or GitHub as one of the people who track
// it), their packages asked about at OSV (osv.dev: only names and versions leave the server), and
// what was found kept per repository in the data folder (advisories.json). New advisories become
// inbox entries (domain/advisories.js advisoryAttention), so the live updates, push and the Teams
// and Slack channels tell people about them the way they tell them about anything else.
// It runs whether or not anyone has Keel open; one server process does the reading.
import path from 'node:path';
import { createOsv, eachLimited } from '@fleet/kit/osv.js';
import { config } from './config.js';
import { runnerLock, sharedJson } from './jsonfile.js';
import { findingsOf, mergeAdvisories, parseLockFile, pickLockFiles, uniquePackages } from './domain/advisories.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// "Check now" asks again at most this often per repository.
export const CHECK_EVERY_MS = 10 * MIN;
// A repository nobody has looked at for this long is forgotten.
const FORGET_AFTER = 30 * DAY;

/** A repository's key in the store: project ids are unique across organizations (multiorg.js). */
export const repoKey = (repo) => `${repo.projectId}/${repo.id ?? repo.repoId}`;

const tooSoon = () => Object.assign(new Error('This repository was checked less than 10 minutes ago. Check it again in a few minutes.'), { status: 429 });

export function createAdvisoryWatch({
  dataDir = config.dataDir,
  mock = config.mock,
  // Whose services to look through: account ids ('local' for the one person of local mode).
  people = () => ['local'],
  // (id) -> that person's service, or null.
  resolveService,
  fetchImpl = globalThis.fetch,
  every = HOUR,
  staleMs = DAY,
  now = () => Date.now(),
  autostart = true,
} = {}) {
  const suffix = mock ? '.mock' : '';
  const store = sharedJson(path.join(dataDir, `advisories${suffix}.json`), () => ({ repos: {} }));
  const runner = runnerLock(path.join(dataDir, `advisory-runner${suffix}.json`), 2 * every);
  const osv = createOsv({ fetchImpl });
  const running = new Set(); // repository keys being read in this process
  const entryOf = (repo) => store.get().repos?.[repoKey(repo)] || null;
  const save = (key, entry) => store.update((s) => {
    s.repos ||= {};
    s.repos[key] = entry;
  });

  /**
   * Read one repository's lock files and ask OSV about them; `read()` gives
   * { branch, files: [{ path, text }], more } (service.readLockFiles). Returns the stored entry
   * and the advisories new since the last look.
   */
  async function check(repo, read) {
    const key = repoKey(repo);
    if (running.has(key)) throw Object.assign(new Error('This repository is being checked right now.'), { status: 409 });
    running.add(key);
    const at = new Date(now()).toISOString();
    const previous = entryOf(repo);
    const about = { projectId: repo.projectId, projectName: repo.projectName, repoId: repo.id, repoName: repo.name, ...(repo.org ? { org: repo.org } : {}) };
    try {
      save(key, { ...previous, ...about, triedAt: at });
      const { branch, files, more } = await read();
      const unreadable = [];
      const lockFiles = [];
      for (const f of files) {
        try {
          lockFiles.push({ path: f.path, packages: parseLockFile(f.path, f.text) });
        } catch {
          unreadable.push(f.path);
        }
      }
      const packages = uniquePackages(lockFiles);
      const signal = AbortSignal.timeout(60_000);
      const ids = packages.length ? await osv.query(packages, { signal }) : new Map();
      const records = ids.size ? await osv.vulns([...ids.values()].flat(), { signal }) : new Map();
      const { advisories, added, baseline } = mergeAdvisories(previous, findingsOf(packages, ids, records), at);
      const entry = {
        ...about, branch, triedAt: at, checkedAt: at, baselineAt: baseline ? at : previous?.baselineAt || at,
        lockFiles: lockFiles.map((f) => f.path), moreLockFiles: !!more, unreadable, packages: packages.length, advisories, error: null,
      };
      save(key, entry);
      return { entry, added };
    } catch (err) {
      save(key, { ...previous, ...about, triedAt: at, error: err.message });
      throw err;
    } finally {
      running.delete(key);
    }
  }

  /** "Check now" from the page: as check, at most once per CHECK_EVERY_MS for each repository. */
  function checkNow(repo, read) {
    const tried = Date.parse(entryOf(repo)?.triedAt || '');
    if (now() - tried < CHECK_EVERY_MS) throw tooSoon();
    return check(repo, read);
  }

  let busy = false;
  /** One look: every tracked repository not read in the last day, once each, as someone who tracks it. */
  async function tick() {
    if (busy || !runner.isRunner()) return;
    busy = true;
    try {
      const seen = new Set();
      for (const id of await people()) {
        let service = null;
        try {
          service = await resolveService(id === 'local' ? null : id);
        } catch (err) {
          console.warn(`[advisories] ${err.message}`);
        }
        if (!service) continue;
        let repos;
        try {
          if ((await service.settingsStore.load()).advisories?.enabled === false) continue;
          repos = await service.repos();
        } catch (err) {
          console.warn(`[advisories] couldn't list repositories: ${err.message}`);
          continue;
        }
        const due = repos.filter((r) => {
          const key = repoKey(r);
          if (seen.has(key) || !r.defaultBranch) return false;
          seen.add(key);
          return !(now() - Date.parse(entryOf(r)?.triedAt || '') < staleMs);
        });
        // A couple at a time: each is a tree listing and a few file reads.
        await eachLimited(due, 2, (r) => check(r, () => service.readLockFiles(r.projectId, r.id)).catch((err) => console.warn(`[advisories] ${r.name}: ${err.message}`)));
      }
      store.update((s) => {
        for (const [key, e] of Object.entries(s.repos || {})) if (now() - Date.parse(e.triedAt || '') > FORGET_AFTER) delete s.repos[key];
      });
    } finally {
      busy = false;
    }
  }

  let timer = null;
  if (autostart) {
    timer = setInterval(() => tick().catch((err) => console.warn(`[advisories] ${err.message}`)), every);
    timer.unref?.();
    setTimeout(() => tick().catch(() => {}), 30_000).unref?.();
  }

  return { entryOf, check, checkNow, tick, close: () => clearInterval(timer) };
}
