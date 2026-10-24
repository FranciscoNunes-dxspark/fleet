// Pinch in the terminal: the crab from client/src/pinch.js drawn with half blocks, a face for the
// header, and how Pinch feels about what Keel sees. Pure, so the tests can check it.
import { PALETTE, pinchPixels } from '../client/src/pinch.js';

/**
 * The drawing as terminal rows of segments, two pixels per cell: "▀" with the top pixel as
 * the text colour and the bottom one as the background.
 */
export function pinchRows(mood = 'idle') {
  const px = pinchPixels(mood);
  const rows = [];
  for (let y = 0; y < px.length; y += 2) {
    const segs = [];
    for (let x = 0; x < px[y].length; x++) {
      const top = PALETTE[px[y][x]];
      const bottom = PALETTE[px[y + 1]?.[x]];
      if (top && bottom) segs.push({ text: '▀', color: top, bg: bottom });
      else if (top) segs.push({ text: '▀', color: top });
      else if (bottom) segs.push({ text: '▄', color: bottom });
      else segs.push({ text: ' ' });
    }
    rows.push(segs);
  }
  return rows;
}

/** A one-line crab for the header. */
export const FACES = {
  idle: 'V(•ᴗ•)V',
  look: 'V(•ᴗ•)V',
  sleep: 'V(–ᴗ–)V',
  happy: 'V(^ᴗ^)V',
  worried: 'V(°o°)V',
};

/**
 * How Pinch feels right now: worried just after something failed (or while Azure DevOps can't
 * be reached), glancing about while it answers, pleased just after something worked, asleep
 * when nothing needs you, and otherwise watching.
 */
export function moodFor({ attention, busy, lastEntry, pollError, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (pollError) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (attention && !attention.items.length) return 'sleep';
  return 'idle';
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What needs you now, in a few words: "4 reviews waiting on you, 6 failing pipelines". */
export function needsYou(summary = {}) {
  const parts = [];
  if (summary.myReviews) parts.push(`${plural(summary.myReviews, 'review')} waiting on you`);
  if (summary.approvals) parts.push(plural(summary.approvals, 'approval'));
  if (summary.failingPipelines) parts.push(plural(summary.failingPipelines, 'failing pipeline'));
  if (summary.productionIssues) parts.push(plural(summary.productionIssues, 'production issue'));
  if (summary.p1Bugs) parts.push(plural(summary.p1Bugs, 'P1 bug'));
  if (summary.blockedItems) parts.push(plural(summary.blockedItems, 'blocked item'));
  return parts.join(', ');
}

/** A sentence for the welcome box. */
export function moodLine(mood, { attention, pollError } = {}) {
  if (pollError) return `Azure DevOps can't be reached: ${pollError}`;
  if (mood === 'worried') return "That didn't work; the details are below.";
  if (!attention) return 'Reading Azure DevOps…';
  const n = attention.summary?.high || 0;
  if (n) return `${plural(n, 'thing needs', 'things need')} you now: ${needsYou(attention.summary) || 'see the Inbox'}.`;
  if (attention.items.length) return `Nothing urgent. ${plural(attention.items.length, 'thing')} to look at when you can.`;
  return 'Nothing needs you, so Pinch is having a nap.';
}
