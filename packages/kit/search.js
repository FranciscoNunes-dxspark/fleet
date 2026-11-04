// Searching a log, a response or any text in a viewer (/ then n/N), and picking out the matches in a
// line's segments. Shared by Bosun, Hail and Wharf. Pure, so it's tested without the UI.

/**
 * A function finding `query` in a text, as [from, to) offsets. Smart case: a query with a capital
 * letter matches case for case, one without matches any case. Null for an empty query.
 */
export function matcher(query) {
  if (!query) return null;
  const sensitive = /[A-Z]/.test(query);
  const q = sensitive ? query : query.toLowerCase();
  return (text) => {
    const t = sensitive ? text : text.toLowerCase();
    const out = [];
    for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) out.push([i, i + q.length]);
    return out;
  };
}

/** A line's text: the line itself, or its segments' text joined. */
export const lineText = (line) => (typeof line === 'string' ? line : line.map((s) => s.text).join(''));

/** The indexes of the lines `query` is found in. */
export function matchingLines(lines, query) {
  const find = matcher(query);
  if (!find) return [];
  const out = [];
  lines.forEach((l, i) => find(lineText(l)).length && out.push(i));
  return out;
}

/** `segments` with the parts inside `ranges` ([from, to) offsets into their joined text) restyled with `style`. */
export function markRanges(segments, ranges, style) {
  if (!ranges?.length) return segments;
  // Every range's ends in order, and the ranges merged, each walked once as the segments go by: a long
  // line with thousands of matches (a minified file) took each match through every other one.
  const ends = [...new Set(ranges.flat())].sort((x, y) => x - y);
  const union = [];
  for (const [a, b] of ranges.filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0])) {
    const last = union.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else union.push([a, b]);
  }
  let e = 0;
  let u = 0;
  const inside = (at) => {
    while (u < union.length && union[u][1] <= at) u++;
    return u < union.length && union[u][0] <= at;
  };
  const out = [];
  let pos = 0;
  for (const s of segments) {
    const end = pos + s.text.length;
    const points = [pos];
    while (e < ends.length && ends[e] <= pos) e++;
    for (; e < ends.length && ends[e] < end; e++) points.push(ends[e]);
    points.push(end);
    for (let k = 0; k < points.length - 1; k++) {
      const text = s.text.slice(points[k] - pos, points[k + 1] - pos);
      if (text) out.push(inside(points[k]) ? { ...s, ...style, text } : { ...s, text });
    }
    pos = end;
  }
  return out;
}
