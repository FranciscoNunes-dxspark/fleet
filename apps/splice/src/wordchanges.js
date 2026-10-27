// Word-level diff highlighting: which words of a changed line pair changed. Pure, so it's tested without the UI.

// Words, runs of spaces, and single other characters: what a word diff compares.
const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
const MAX_TOKENS = 200;
const isDel = (l) => l[0] === '-' && !l.startsWith('--- ');
const isAdd = (l) => l[0] === '+' && !l.startsWith('+++ ');

/**
 * The words a diff changed within its lines, for highlighting: a Map from line index to the
 * [from, to) ranges in that line. A run of removed lines followed by a run of added ones pairs
 * them up in order (the first - with the first +, ...), and each pair is compared word by word.
 * A pair that changed more than it kept is left alone: highlighting all of it says nothing.
 */
export function wordChanges(lines) {
  const out = new Map();
  let i = 0;
  while (i < lines.length) {
    if (!isDel(lines[i])) {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && isDel(lines[d])) d++;
    let e = d;
    while (e < lines.length && isAdd(lines[e])) e++;
    for (let k = 0; k < Math.min(d - i, e - d); k++) {
      const pair = comparePair(lines[i + k], lines[d + k]);
      if (!pair) continue;
      out.set(i + k, pair.old);
      out.set(d + k, pair.new);
    }
    i = Math.max(d, e);
  }
  return out;
}

// The comparison's table, big enough for the longest lines compared.
const TABLE = new Uint16Array((MAX_TOKENS + 1) * (MAX_TOKENS + 1));

/** The changed ranges of an old and a new line (both with their - or + in front), or null. */
function comparePair(oldLine, newLine) {
  const a = oldLine.slice(1).match(TOKEN) ?? [];
  const b = newLine.slice(1).match(TOKEN) ?? [];
  if (!a.length || !b.length || a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  // Longest common subsequence of the tokens. The tokens both lines start with are kept as they come (the
  // walk below takes a match whenever there is one), so the table only covers what follows them: one
  // table, row x - p at (x - p) * w, shared by every pair.
  const n = a.length;
  const m = b.length;
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) p++;
  const w = m - p + 1;
  const len = TABLE;
  const at = (x, y) => (x - p) * w + (y - p);
  len.fill(0, at(n, p), at(n, m) + 1);
  for (let x = n - 1; x >= p; x--) {
    const row = at(x, p) - p;
    len[row + m] = 0;
    for (let y = m - 1; y >= p; y--) len[row + y] = a[x] === b[y] ? len[row + w + y + 1] + 1 : Math.max(len[row + w + y], len[row + y + 1]);
  }
  const keptA = new Array(n).fill(false);
  const keptB = new Array(m).fill(false);
  for (let x = 0, y = 0; x < n && y < m; ) {
    if (a[x] === b[y]) {
      keptA[x++] = true;
      keptB[y++] = true;
    } else if (len[at(x + 1, y)] >= len[at(x, y + 1)]) x++;
    else y++;
  }
  const old = ranges(a, keptA);
  const neu = ranges(b, keptB);
  if (!old.ranges.length && !neu.ranges.length) return null;
  // Mostly rewritten: no highlighting. Spaces don't count either way.
  if (old.changed > old.kept || neu.changed > neu.kept) return null;
  return { old: old.ranges, new: neu.ranges };
}

/** Ranges (offset by the line's first character) of the tokens not kept, joining neighbours across spaces. */
function ranges(tokens, kept) {
  const out = [];
  let pos = 1;
  let changed = 0;
  let keptChars = 0;
  tokens.forEach((t, k) => {
    const blank = !t.trim();
    if (!kept[k] && !blank) {
      changed += t.length;
      const last = out.at(-1);
      // A space between two changed words joins them into one range.
      if (last && /^\s*$/.test(tokens.slice(last.k + 1, k).join(''))) {
        last[1] = pos + t.length;
        last.k = k;
      } else out.push(Object.assign([pos, pos + t.length], { k }));
    } else if (!blank) keptChars += t.length;
    pos += t.length;
  });
  return { ranges: out.map(([a, b]) => [a, b]), changed, kept: keptChars };
}
