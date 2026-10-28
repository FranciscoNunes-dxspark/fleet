// A file's change as hunks of lines, from its two versions (Azure DevOps and the demo org send
// whole files) or from a unified patch (GitHub sends only that). Pure, so both clients show the
// same thing and the tests need no provider.

const CONTEXT = 3;
const MAX_LINES = 6000;
const MAX_EDITS = 400;

const splitLines = (text) => {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** Edit script between two line arrays: [{ t: ' ' | '-' | '+', text }], or null when it needs too many edits. */
function editScript(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map((text) => ({ t: ' ', text }));
  const tail = a.slice(endA).map((text) => ({ t: ' ', text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const middle = myers(x, y);
  if (!middle) return null;
  return [...head, ...middle, ...tail];
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text) => ({ t: '+', text }));
  if (!m) return a.map((text) => ({ t: '-', text }));
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    // What step d reads: v after step d - 1, for k - 1 and k + 1 (so -d - 1 to d + 1).
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && a[i] === b[j]) { i++; j++; }
      v[off + k] = i;
      if (i >= n && j >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let i = n;
  let j = m;
  for (let d = found; d >= 0; d--) {
    const vv = trace[d];
    const base = d + 1;
    const k = i - j;
    const prevK = k === -d || (k !== d && vv[base + k - 1] < vv[base + k + 1]) ? k + 1 : k - 1;
    const prevI = vv[base + prevK];
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) { ops.push({ t: ' ', text: a[i - 1] }); i--; j--; }
    if (d > 0) ops.push(i === prevI ? { t: '+', text: b[j - 1] } : { t: '-', text: a[i - 1] });
    i = prevI;
    j = prevJ;
  }
  return ops.reverse();
}

/** Numbers the lines of an edit script and groups the changes, with some unchanged lines around each, into hunks. */
function hunksOf(ops) {
  let a = 1;
  let b = 1;
  const lines = ops.map((op) => {
    const line = { t: op.t, text: op.text, a: op.t === '+' ? null : a, b: op.t === '-' ? null : b };
    if (op.t !== '+') a++;
    if (op.t !== '-') b++;
    return line;
  });
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === ' ') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const hunks = [];
  let cur = null;
  lines.forEach((l, i) => {
    if (!keep[i]) { cur = null; return; }
    if (!cur) hunks.push(cur = { lines: [] });
    cur.lines.push(l);
  });
  return hunks.map(withHeader);
}

function withHeader(h) {
  const olds = h.lines.filter((l) => l.t !== '+');
  const news = h.lines.filter((l) => l.t !== '-');
  const oldStart = olds[0]?.a ?? (h.oldStart ?? 0);
  const newStart = news[0]?.b ?? (h.newStart ?? 0);
  return { oldStart, newStart, header: `@@ -${oldStart},${olds.length} +${newStart},${news.length} @@${h.section ? ` ${h.section}` : ''}`, lines: h.lines };
}

const count = (hunks, t) => hunks.reduce((s, h) => s + h.lines.filter((l) => l.t === t).length, 0);

/** The diff from the file's two versions (an empty string for a side that doesn't exist). */
export function buildDiff(before = '', after = '') {
  if (/\0/.test(before.slice(0, 8000)) || /\0/.test(after.slice(0, 8000))) return { skipped: 'binary', hunks: [], added: 0, removed: 0 };
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return { skipped: 'large', hunks: [], added: 0, removed: 0 };
  // Too many edits for the search: the whole file as removed and added still says what happened.
  const ops = editScript(a, b) ?? [...a.map((text) => ({ t: '-', text })), ...b.map((text) => ({ t: '+', text }))];
  const hunks = hunksOf(ops);
  return { hunks, added: count(hunks, '+'), removed: count(hunks, '-') };
}

/** The diff from a unified patch (GitHub's `patch`). No patch means a binary or a very large file. */
export function parsePatch(patch, { empty = false } = {}) {
  if (patch == null || patch === '') return empty ? { hunks: [], added: 0, removed: 0 } : { skipped: 'large', hunks: [], added: 0, removed: 0 };
  const hunks = [];
  let cur = null;
  let a = 0;
  let b = 0;
  for (const raw of patch.replace(/\r\n/g, '\n').split('\n')) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (at) {
      a = Number(at[1]);
      b = Number(at[2]);
      hunks.push(cur = { oldStart: a, newStart: b, section: at[3], lines: [] });
      continue;
    }
    if (!cur || raw === '' || raw[0] === '\\') continue;
    const t = raw[0];
    if (t === '+') cur.lines.push({ t, text: raw.slice(1), a: null, b: b++ });
    else if (t === '-') cur.lines.push({ t, text: raw.slice(1), a: a++, b: null });
    else cur.lines.push({ t: ' ', text: raw.slice(1), a: a++, b: b++ });
  }
  const done = hunks.map(withHeader);
  return { hunks: done, added: count(done, '+'), removed: count(done, '-') };
}
