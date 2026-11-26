// Resolving a pull request's merge conflicts one by one: which kinds Keel can resolve and how,
// the body Azure DevOps' conflicts API takes for each, and a three-way merge of a file's base,
// source and target text with the places both branches changed marked, to edit by hand. Pure,
// so the providers, the web app's editor and the tests share one set of rules.

import { editScript } from './filediff.js';

// The content kinds have both branches' text to merge; the pick kinds lose a file on one side,
// so all there is to do is keep one side. Renames and folder clashes are left to Azure DevOps.
const CONTENT = new Set(['editEdit', 'addAdd']);
const PICK = new Set(['deleteEdit', 'editDelete']);

/** What Keel offers for a conflict kind: `keep` (take one branch's side) and `edit` (write the merged file). */
export function conflictChoices(type) {
  return { keep: CONTENT.has(type) || PICK.has(type), edit: CONTENT.has(type) };
}

/** Checks a resolution ({ keep: 'source' | 'target' } or { content }) against the conflict's kind; returns an error message or null. */
export function resolutionProblem(type, resolution) {
  const choices = conflictChoices(type);
  if (!choices.keep) return 'Keel can\'t resolve a rename or folder conflict. Fix it on your computer or in Azure DevOps.';
  if (resolution?.keep === 'source' || resolution?.keep === 'target') return null;
  if (typeof resolution?.content === 'string') {
    if (!choices.edit) return 'This conflict has no merged text to write: keep one branch\'s side.';
    if (hasMarkers(resolution.content)) return 'The merged text still has conflict markers (<<<<<<<, =======, >>>>>>>). Settle each one first.';
    return null;
  }
  return 'Say which side to keep, or give the merged text.';
}

/**
 * The PATCH body for Azure DevOps' pullRequests/{id}/conflicts/{conflictId}: a content kind takes
 * a GitResolutionMergeContent (the merged text as bytes, as its own client sends them), a pick
 * kind a GitResolutionPickOneAction.
 */
export function resolutionBody(id, type, resolution) {
  let body;
  if (CONTENT.has(type)) {
    body = typeof resolution.content === 'string'
      ? { mergeType: 'userMerged', userMergedContent: Array.from(Buffer.from(resolution.content, 'utf8')) }
      : { mergeType: resolution.keep === 'source' ? 'takeSourceContent' : 'takeTargetContent' };
  } else {
    body = { action: resolution.keep === 'source' ? 'pickSourceAction' : 'pickTargetAction' };
  }
  return { conflictId: id, conflictType: type, resolution: body, resolutionStatus: 'resolved' };
}

const MARKER = /^(<{7}|={7}|>{7})( |$)/m;

/** Whether text still has a conflict marker at the start of a line. */
export const hasMarkers = (text) => MARKER.test(String(text || ''));

const linesOf = (text) => {
  if (!text) return [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** For each base line, the index of the side's line it was kept as, or -1; null when the diff is too big to work out. */
function matchesOf(base, side) {
  const ops = editScript(base, side);
  if (!ops) return null;
  const match = new Array(base.length).fill(-1);
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op.t === ' ') match[i++] = j++;
    else if (op.t === '-') i++;
    else j++;
  }
  return match;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A three-way merge, line by line (diff3's way): between the base lines both branches kept, a
 * stretch only one branch changed takes that change, and one both changed differently is
 * written between markers, the source branch's side first. Returns { text, conflicts }, the
 * number of marked places; a diff too big to work out marks the whole file as one.
 */
export function mergeWithMarkers(baseText, sourceText, targetText, { source = 'source', target = 'target' } = {}) {
  const base = linesOf(baseText);
  const a = linesOf(sourceText);
  const b = linesOf(targetText);
  const out = [];
  let conflicts = 0;
  const conflict = (x, y) => {
    conflicts++;
    out.push(`<<<<<<< ${source}`, ...x, '=======', ...y, `>>>>>>> ${target}`);
  };
  const ma = matchesOf(base, a);
  const mb = matchesOf(base, b);
  if (!ma || !mb) {
    if (same(a, b)) out.push(...a);
    else conflict(a, b);
    return { text: out.length ? `${out.join('\n')}\n` : '', conflicts };
  }
  let o = 0;
  let i = 0;
  let j = 0;
  while (o <= base.length) {
    // The next base line both branches kept where they are (or the end), after o.
    let k = o;
    while (k < base.length && !(ma[k] >= i && mb[k] >= j)) k++;
    const endA = k < base.length ? ma[k] : a.length;
    const endB = k < base.length ? mb[k] : b.length;
    const O = base.slice(o, k);
    const A = a.slice(i, endA);
    const B = b.slice(j, endB);
    if (same(A, O)) out.push(...B);
    else if (same(B, O) || same(A, B)) out.push(...A);
    else conflict(A, B);
    if (k >= base.length) break;
    out.push(base[k]);
    o = k + 1;
    i = endA + 1;
    j = endB + 1;
  }
  return { text: out.length ? `${out.join('\n')}\n` : '', conflicts };
}
