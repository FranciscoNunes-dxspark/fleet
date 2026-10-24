// Keel's detail panes wrap long lines rather than cut them (the kit's Lines cuts each line to the
// width): wrapLines turns a pane's lines into the lines to draw, before Lines shows them.
import { stringWidth, wrap } from '@fleet/kit/text.js';

/**
 * Wraps a line of segments to `width`: the last segment (the text) wraps, and its continuation
 * lines are indented under it, past whatever came before (a bullet, an icon).
 */
export function wrapSegments(segments, width) {
  const text = segments.at(-1)?.text ?? '';
  const head = segments.slice(0, -1);
  const indent = head.reduce((n, s) => n + stringWidth(s.text ?? ''), 0);
  if (!segments.length || indent + stringWidth(text) <= width || width - indent < 10) return [segments];
  // Spaces that separate the text from what's before it stay on the first line.
  const lead = text.match(/^ */)[0];
  return wrap(text.slice(lead.length), width - indent - lead.length).map((part, i) => [
    ...(i ? [{ text: ' '.repeat(indent + lead.length) }] : [...head, { text: lead }]),
    { ...segments.at(-1), text: part },
  ]);
}

/** A pane's lines (segments, or plain strings) wrapped to `width`, for the kit's Lines. */
export const wrapLines = (lines, width) => lines.flatMap((line) => wrapSegments(typeof line === 'string' ? [{ text: line }] : line, width));
