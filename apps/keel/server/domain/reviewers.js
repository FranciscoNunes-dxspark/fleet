// Who should review a change: people who recently worked in the same folders,
// weighed down by the reviews they already owe, so the usual expert isn't
// always the one asked.
import { DAY } from './prs.js';

/** The folders a change touches, busiest first (at most `limit`); files at the root count as "/". */
export function changedFolders(paths, limit = 8) {
  const count = new Map();
  for (const p of paths) {
    const path = String(p || '');
    if (!path.startsWith('/')) continue;
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    count.set(dir, (count.get(dir) || 0) + 1);
  }
  const dirs = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // The whole repo's history says little; only ask for it when nothing else changed.
  const specific = dirs.filter(([d]) => d !== '/');
  return (specific.length ? specific : dirs).slice(0, limit).map(([dir, files]) => ({ dir, files }));
}

const recency = (ms, now) => {
  const age = now - ms;
  return age <= 30 * DAY ? 1 : age <= 90 * DAY ? 0.5 : 0.25;
};

/**
 * histories: [{ dir, files, commits }] (the commits that touched each folder);
 * people: who can be asked; load: workload rows ({ person, reviewsPending, overloaded });
 * exclude: ids not to suggest (the author, reviewers already on it).
 */
export function suggestReviewers({ histories = [], people = [], load = [], exclude = [], limit = 5, now = Date.now() }) {
  const skip = new Set(exclude.filter(Boolean));
  const byEmail = new Map(people.filter((p) => !p.isContainer && p.uniqueName).map((p) => [p.uniqueName.toLowerCase(), p]));
  const byName = new Map(people.filter((p) => !p.isContainer).map((p) => [p.displayName.toLowerCase(), p]));
  const totalFiles = histories.reduce((n, h) => n + h.files, 0) || 1;
  const found = new Map(); // person id -> { person, relevance, dirs, commits, lastAt }

  for (const h of histories) {
    const share = h.files / totalFiles;
    const perPerson = new Map();
    for (const c of h.commits || []) {
      if (/^(Merged PR \d+:|Merge pull request #\d+ from )/.test(c.message || '')) continue; // the merge, not the work
      const who = byEmail.get(String(c.author?.email || '').toLowerCase()) || byName.get(String(c.author?.name || '').toLowerCase());
      if (!who || skip.has(who.id)) continue;
      const at = Date.parse(c.author?.date);
      const list = perPerson.get(who.id) || [];
      list.push(Number.isFinite(at) ? at : 0);
      perPerson.set(who.id, list);
      if (!found.has(who.id)) found.set(who.id, { person: who, relevance: 0, dirs: new Set(), files: 0, commits: 0, lastAt: 0 });
    }
    for (const [id, times] of perPerson) {
      const f = found.get(id);
      // Up to three commits per folder count: someone who lives in a folder doesn't drown out the rest.
      const best = times.sort((a, b) => b - a).slice(0, 3);
      f.relevance += share * best.reduce((n, t) => n + recency(t, now), 0) / 3;
      f.dirs.add(h.dir);
      f.files += h.files;
      f.commits += times.length;
      f.lastAt = Math.max(f.lastAt, times[0]);
    }
  }

  const loadOf = new Map(load.map((r) => [r.person?.id, r]));
  return [...found.values()]
    .map((f) => {
      const row = loadOf.get(f.person.id);
      const owed = row?.reviewsPending || 0;
      return {
        person: f.person,
        score: f.relevance / (1 + 0.25 * owed),
        folders: [...f.dirs],
        files: f.files,
        commits: f.commits,
        lastAt: f.lastAt ? new Date(f.lastAt).toISOString() : null,
        reviewsOwed: owed,
        overloaded: !!row?.overloaded,
      };
    })
    .sort((a, b) => b.score - a.score || a.person.displayName.localeCompare(b.person.displayName))
    .slice(0, limit);
}
