// Matching for the command palette (palette.jsx): no React or i18n here, so
// node tests can import it.
//
// An entry is { key, kind, title, sub?, keywords?, ids? }: every word typed
// must appear somewhere in it. Words matching the title count most, the start
// of a title word more than its middle, and an exact id ("4107", "#4107",
// "!815") wins outright.

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** What was typed: the words, and a work item (#123 or 123) or pull request (!123) number. */
export function parseQuery(q) {
  const text = norm(q).trim();
  const wi = text.match(/^(?:#|ab#)?(\d{1,7})$/);
  const pr = text.match(/^!(\d{1,7})$/);
  return {
    text,
    words: text.split(/\s+/).filter(Boolean).map((w) => w.replace(/^[#!]/, '')).filter(Boolean),
    workItemId: wi ? Number(wi[1]) : null,
    prId: pr ? Number(pr[1]) : null,
  };
}

/** How well an entry matches (higher is better), or null when a word is missing. */
export function score(entry, query) {
  const { words, text, workItemId, prId } = query;
  if (!words.length) return 0;
  if (entry.ids?.length) {
    if (workItemId != null && entry.kind === 'workitem' && entry.ids.includes(workItemId)) return 1000;
    if ((prId ?? workItemId) != null && entry.kind === 'pr' && entry.ids.includes(prId ?? workItemId)) return prId != null ? 1000 : 500;
  }
  const title = norm(entry.title);
  const rest = norm([entry.sub, ...(entry.keywords || []), ...(entry.ids || [])].join(' '));
  let total = 0;
  for (const w of words) {
    const at = title.indexOf(w);
    if (at === 0 || (at > 0 && /[\s\-_/.:([]/.test(title[at - 1]))) total += 3;
    else if (at > 0) total += 2;
    else if (rest.includes(w)) total += 1;
    else return null;
  }
  if (title.startsWith(text)) total += 4;
  if (title === text) total += 4;
  return total + (entry.boost || 0);
}

/** The best `limit` matches, best first; ties keep the list's order (pages and actions come first). */
export function rank(entries, q, limit = 40) {
  const query = typeof q === 'string' ? parseQuery(q) : q;
  return entries
    .map((e, i) => ({ e, i, s: score(e, query) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.e);
}
