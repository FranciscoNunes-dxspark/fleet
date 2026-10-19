import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export const DEFAULT_SETTINGS = {
  // projectId -> { name, tracked, repos: 'all' | [repoId], teams: [{ id, name }], scopeToTeamArea }
  projects: {},
  thresholds: {
    prNoReviewHours: 24, // no approval yet after this long
    myReviewHours: 8, // a PR waiting on *my* vote becomes high priority
    stalePrDays: 5, // open PRs older than this are stale
    itemStuckDays: 5, // in-progress work item untouched this long
    buildLookbackDays: 14,
    maxInProgressPerPerson: 3,
    maxPendingReviewsPerPerson: 5,
  },
  blockedTag: 'Blocked',
  autoComplete: { mergeStrategy: 'noFastForward', deleteSourceBranch: false, transitionWorkItems: true },
  refreshSeconds: 30,
  // attention key -> ISO date until which it is hidden
  snoozed: {},
};

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

/** The single-user settings file (local mode and demo mode). */
export const defaultSettingsFile = () => path.join(config.dataDir, config.mock ? 'settings.mock.json' : 'settings.json');

/** Per-user settings file for signed-in users; the id is their Azure DevOps identity id. */
export const userSettingsFile = (userId) => path.join(config.dataDir, 'users', `${String(userId).replace(/[^a-zA-Z0-9-]/g, '')}.json`);

/** One person's settings, cached in memory and saved as JSON. */
export function createSettingsStore(file) {
  let current = null;
  let stamp = null;
  // Another server process may have saved since: reread when the file changed.
  const stampOf = () => fs.stat(file).then((s) => `${s.mtimeMs}:${s.size}`, () => 'missing');

  async function load() {
    const now = await stampOf();
    if (current && now === stamp) return current;
    stamp = now;
    try {
      current = merge(DEFAULT_SETTINGS, JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[settings] could not read ${file}: ${err.message}`);
      current = structuredClone(DEFAULT_SETTINGS);
      current.firstRun = true;
    }
    return current;
  }

  async function save(patch) {
    const base = await load();
    // projects and snoozed are replaced wholesale so deselections stick.
    const next = merge(base, patch);
    if (patch.projects) next.projects = patch.projects;
    if (patch.snoozed) next.snoozed = patch.snoozed;
    if (patch.prefs) next.prefs = patch.prefs;
    delete next.firstRun;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(next, null, 2));
    current = next;
    stamp = await stampOf();
    return current;
  }

  return { load, save, file };
}

export function pruneSnoozed(snoozed, now = Date.now()) {
  return Object.fromEntries(Object.entries(snoozed || {}).filter(([, until]) => Date.parse(until) > now));
}
