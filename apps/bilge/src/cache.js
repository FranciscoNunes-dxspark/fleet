// OSV's answers kept between runs, in Bilge's home folder (cache/osv.json): which advisories each
// package version has, for six hours, and each advisory's record, for a day. Opening Bilge on a
// project read a moment ago then asks OSV only about what changed; ctrl+r and /audit fresh ask about
// everything again. Only what OSV said is kept: names, versions and public advisories. A cache that
// can't be read is empty, and one that can't be written is left as it was.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const QUERY_TTL = 6 * 60 * 60_000;
export const VULN_TTL = 24 * 60 * 60_000;
export const CACHE_FILE = 'osv.json';

/**
 * The cache in `dir`, read once: `query(key)` the advisory ids OSV gave a package (an empty list for
 * none) or undefined when it's not kept or too old, `vuln(id)` a record likewise; `setQuery`,
 * `setVuln`, then `save()` writes it, dropping what has gone stale. `now` stands in for the clock in tests.
 */
export function createOsvCache({ dir, now = Date.now } = {}) {
  const file = join(dir, CACHE_FILE);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
  const queries = data.queries && typeof data.queries === 'object' ? data.queries : {};
  const vulns = data.vulns && typeof data.vulns === 'object' ? data.vulns : {};
  const fresh = (entry, ttl) => entry && typeof entry.at === 'number' && now() - entry.at < ttl;
  let changed = false;
  return {
    query: (key) => (fresh(queries[key], QUERY_TTL) && Array.isArray(queries[key].ids) ? queries[key].ids : undefined),
    vuln: (id) => (fresh(vulns[id], VULN_TTL) ? vulns[id].record : undefined),
    setQuery(key, ids) {
      queries[key] = { at: now(), ids };
      changed = true;
    },
    setVuln(id, record) {
      vulns[id] = { at: now(), record };
      changed = true;
    },
    save() {
      if (!changed) return;
      const keep = (all, ttl) => Object.fromEntries(Object.entries(all).filter(([, e]) => fresh(e, ttl)));
      try {
        mkdirSync(dir, { recursive: true });
        // Written whole and moved into place, so a second Bilge reading it never sees half a file.
        writeFileSync(`${file}.tmp`, JSON.stringify({ queries: keep(queries, QUERY_TTL), vulns: keep(vulns, VULN_TTL) }));
        renameSync(`${file}.tmp`, file);
        changed = false;
      } catch {
        // A read-only home: the next run asks OSV again.
      }
    },
  };
}
