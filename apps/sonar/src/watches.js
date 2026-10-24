// Watches: a query of yours pinned with a threshold (/watch), run every few minutes while Sonar runs
// against the Application Insights in scope when it was made, telling you when its number goes over.
// Pure: App runs them, actions.js makes and lists them.

/** How often watches run unless the Watch every setting says otherwise, in minutes. */
export const WATCH_EVERY = 5;

/** The Watch every setting's steps, in minutes. */
export const WATCH_STEPS = [1, 5, 15, 30, 60];

/** Minutes between runs, from the config. */
export const watchEvery = (config) => (Number(config?.watchEvery) > 0 ? Number(config.watchEvery) : WATCH_EVERY);

/** `/watch <name> <threshold> <kql>` read: { name, threshold, kql }, or { error } saying what's missing. */
export function parseWatch(text) {
  const m = /^(\S+)\s+(-?\d+(?:\.\d+)?)\s+([\s\S]+)$/.exec(String(text ?? '').trim());
  if (!m) return { error: 'A watch is /watch <name> <threshold> <kql>, e.g. /watch failures 20 requests | where success == false | count' };
  return { name: m[1], threshold: Number(m[2]), kql: m[3].trim() };
}

/** The number a watch's query answered: the first column of the first row, or null when that isn't a number. */
export function watchValue(table) {
  const v = table?.rows?.[0]?.[0];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * What a new value means for a watch that was `wasAbove` (true, false, or undefined before its first run):
 * { above, crossed }, crossed only on going over the threshold, not on staying over it.
 */
export function crossing(wasAbove, value, threshold) {
  const above = value != null && value > threshold;
  return { above, crossed: above && wasAbove !== true };
}
