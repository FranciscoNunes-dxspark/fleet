// The Line's history: one entry a day per person, each stage's count, how much was stuck
// and its tone, kept for KEEP_DAYS. Pure, so the rules are easy to test; server/line.js keeps
// the file and records on every watcher poll and every /api/line.

export const KEEP_DAYS = 120;

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

/** A stage list (client/src/line/stages.js buildLine) as one day's entry. */
export function summarize(stages, now = Date.now()) {
  return {
    day: dayOf(now),
    at: new Date(now).toISOString(),
    stages: Object.fromEntries(stages.map((s) => [s.id, { count: s.count, warn: s.stuck.warn, bad: s.stuck.bad, tone: s.tone || null }])),
  };
}

/**
 * Today's entry replaces the one before it of the same day (so a day keeps its latest
 * look), and days older than KEEP_DAYS fall off. Oldest first.
 */
export function record(entries = [], entry) {
  const cutoff = dayOf(Date.parse(entry.at) - KEEP_DAYS * 864e5);
  return [...entries.filter((e) => e.day !== entry.day && e.day > cutoff), entry].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** How many days in a row, up to today, a stage has been red (0 when it isn't now). */
export function redFor(entries, stageId) {
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const prev = entries[i + 1];
    // A gap of more than a day (nobody looked) ends the run: we don't know it stayed red.
    if (prev && (Date.parse(prev.day) - Date.parse(entries[i].day)) > 864e5) break;
    if (entries[i].stages?.[stageId]?.tone !== 'bad') break;
    n++;
  }
  return n;
}

/** The stages that are red now and weren't at the last look. */
export function turnedRed(before, after) {
  if (!before) return [];
  return Object.entries(after.stages)
    .filter(([id, s]) => s.tone === 'bad' && before.stages?.[id]?.tone !== 'bad')
    .map(([id]) => id);
}
