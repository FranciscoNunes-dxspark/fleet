// Picking lines from either side of each conflict in a file both branches edited (the merge
// editor in MergeStatus.jsx). The server sends the file as blocks (server/domain/conflicts.js
// mergeChunks): lines both agree on, and conflicts with each branch's lines. A pick says which
// of each side's lines stay and which side's go first. Pure, so it's tested without a browser.

/** A pick per block: null for lines both agree on, else nothing chosen yet. */
export const initialPicks = (chunks) => chunks.map((c) => (c.same ? null : {
  source: c.source.map(() => false),
  target: c.target.map(() => false),
  first: 'source',
  decided: false,
}));

/** Ticks or unticks one line of one side, which settles the block. */
export function toggleLine(picks, at, side, line) {
  return picks.map((p, i) => (i !== at ? p : { ...p, decided: true, [side]: p[side].map((on, j) => (j === line ? !on : on)) }));
}

/** Takes a whole side, both (in the order shown), or neither, for one block. */
export function takeAll(picks, at, which) {
  return picks.map((p, i) => (i !== at ? p : {
    ...p,
    decided: true,
    source: p.source.map(() => which === 'source' || which === 'both'),
    target: p.target.map(() => which === 'target' || which === 'both'),
  }));
}

/** Puts the other side's lines first in one block. */
export const swapOrder = (picks, at) => picks.map((p, i) => (i !== at ? p : { ...p, first: p.first === 'source' ? 'target' : 'source' }));

/** How many conflicts are still to settle. */
export const undecided = (picks) => picks.filter((p) => p && !p.decided).length;

/** One settled block's lines: the ticked lines of the side that goes first, then the other's. */
export function blockLines(chunk, pick) {
  const side = (name) => chunk[name].filter((_, j) => pick[name][j]);
  return pick.first === 'source' ? [...side('source'), ...side('target')] : [...side('target'), ...side('source')];
}

/** The file as picked; a block not settled yet stays between markers, as a text editor shows it. */
export function pickedText(chunks, picks, { source = 'source', target = 'target' } = {}) {
  const out = chunks.flatMap((c, i) => {
    if (c.same) return c.same;
    if (picks[i]?.decided) return blockLines(c, picks[i]);
    return [`<<<<<<< ${source}`, ...c.source, '=======', ...c.target, `>>>>>>> ${target}`];
  });
  return out.length ? `${out.join('\n')}\n` : '';
}
