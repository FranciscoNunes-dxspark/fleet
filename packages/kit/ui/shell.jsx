// The shell look's two lines (look.js): the top line, which is the app, its views and its context in one
// row (the classic look's header and tab strip), and the status line at the bottom, which is the pet's
// face, what it has to say and the keys (the classic look's welcome box, the pet's reaction and the hint
// row). The layout is worked out by pure functions (topLine, statusLine) so an app can find which view
// a click landed on and the tests can read the segments; TopLine and StatusLine draw them.
import React from 'react';
import { theme } from '../theme.js';
import { fit, fitSegments, stringWidth } from '../text.js';
import { Row } from './parts.jsx';

// The status line's background when the app's palette names none (`theme.bar`).
const BAR = { dark: '#1a1e24', light: '#eceef1' };

/** The status line's background: the palette's `bar`, else a grey a step off the terminal's own. */
export const barColor = () => theme.bar ?? (theme.mode === 'light' ? BAR.light : BAR.dark);

const width = (segs) => segs.reduce((n, s) => n + stringWidth(s.text), 0);

/**
 * The top line's segments, and where each view's label landed ({ id, x, width }, columns from the
 * left) for clicks. `views` is [{ id, label, key?, count?, countColor? }]: `key` (the digit that
 * picks it) is drawn dim before the label, `count` after it. `context` is segments drawn at the
 * right (a branch, an environment, "6/8 running"); it gives way first when the line is too narrow.
 */
export function topLine({ face, title, views = [], view, context = [], width: W }) {
  const left = [];
  if (face) left.push({ text: `${face} `, color: theme.accent, bold: true });
  left.push({ text: title, bold: true }, { text: '   ' });
  const tabs = [];
  for (const v of views) {
    const on = v.id === view;
    const x = width(left);
    if (v.key != null) left.push({ text: `${v.key} `, color: theme.dim });
    left.push({ text: v.label, color: on ? theme.accent : theme.dim, bold: on, underline: on });
    if (v.count) left.push({ text: ` ${v.count}`, color: v.countColor ?? theme.warn });
    tabs.push({ id: v.id, x, width: width(left) - x });
    left.push({ text: '   ' });
  }
  left.pop();
  const used = width(left);
  const room = W - used - 2;
  // The context shows whole parts or none: "6/8 ru…" says less than nothing.
  let right = context.filter((s) => s?.text);
  while (right.length && width(right) > room) right = right.slice(0, -1);
  while (right.length && !right[right.length - 1].text.trim()) right = right.slice(0, -1);
  const gap = right.length ? W - used - width(right) : 0;
  const segments = used >= W ? fitSegments(left, W) : [...left, ...(gap > 0 ? [{ text: ' '.repeat(gap) }] : []), ...right];
  return { segments, tabs: tabs.filter((t) => t.x < W) };
}

/** The top line: the pet's face, the app's name, its views (the one shown underlined), its context. */
export function TopLine(props) {
  return <Row pointer={false} width={props.width} segments={topLine(props).segments} />;
}

/**
 * A hint as keys and what they do: "↵ log · e shell · alt+r restart" → [{ key: '↵', label: 'log' }, …].
 * A part without a space is all label ("…").
 */
export function parseKeys(text) {
  if (!text) return [];
  return String(text)
    .split(' · ')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const at = p.indexOf(' ');
      return at < 0 ? { key: '', label: p } : { key: p.slice(0, at), label: p.slice(at + 1) };
    });
}

/** Keys as segments: the key bright, what it does dim, two spaces between. */
function keySegments(keys) {
  const segs = [];
  keys.forEach((k, i) => {
    if (i) segs.push({ text: '  ' });
    if (k.key) segs.push({ text: k.key, bold: true }, { text: ' ' });
    segs.push({ text: k.label, color: theme.dim });
  });
  return segs;
}

/** As many whole keys as fit in `room` columns, then "…". */
function fitKeys(keys, room) {
  for (let n = keys.length; n > 0; n--) {
    const shown = n < keys.length ? [...keys.slice(0, n), { key: '', label: '…' }] : keys;
    const segs = keySegments(shown);
    if (width(segs) <= room) return segs;
  }
  return [];
}

const TONES = { danger: () => theme.del, warn: () => theme.warn };

/**
 * The status line's segments, as wide as `width`: the face on the accent (or `tone`'s colour:
 * "warn", "danger"), `message` (a string or segments, first to get room), then `keys` (a hint
 * string, "↵ log · e shell", cut to whole keys) and `right` (the same, at the right, whole, or left
 * out when the message needs its room). Everything but the face sits on the bar's background.
 */
export function statusLine({ face, message, tone, keys, right, width: W }) {
  const bg = barColor();
  const lead = [];
  if (face) lead.push({ text: ` ${face} `, color: theme.ink, bg: TONES[tone]?.() ?? theme.accent, bold: true });
  lead.push({ text: ' ' });
  const msgSegs = typeof message === 'string' ? (message ? [{ text: message, color: TONES[tone]?.() ?? theme.dim }] : []) : message ?? [];
  const rightSegs = keySegments(parseKeys(right));
  const rightW = width(rightSegs) + 1;
  // The right side stays only when what the pet says still fits whole beside it.
  const keepRight = rightSegs.length && rightW + 2 <= W - width(lead) - Math.max(6, width(msgSegs));
  let room = W - width(lead) - (keepRight ? rightW + 2 : 0);
  const body = [];
  if (msgSegs.length) {
    // What the pet says is news; the keys are in ? too, so they get what's left.
    const shown = fitSegments(msgSegs, Math.max(0, Math.min(width(msgSegs), room)), false);
    body.push(...shown);
    room -= width(shown);
    if (keys && room > 6) {
      body.push({ text: ' │ ', color: theme.border });
      room -= 3;
    }
  }
  if (keys && room > 0) body.push(...fitKeys(parseKeys(keys), room));
  const left = [...lead, ...body];
  const fill = Math.max(0, W - width(left) - (keepRight ? rightW : 0));
  const segs = [...left, { text: ' '.repeat(fill) }, ...(keepRight ? [...rightSegs, { text: ' ' }] : [])];
  return fitSegments(segs, W).map((s) => (s.bg ? s : { ...s, bg }));
}

/** The status line (statusLine's segments, drawn). */
export function StatusLine(props) {
  return <Row pointer={false} width={props.width} segments={statusLine(props)} />;
}

/** A one-line welcome for the status line: "Welcome to Wharf v1.2 · Bark the seal here. 2 are not well." */
export const welcomeLine = (title, version, said) => [
  { text: `Welcome to ${title}`, bold: true },
  { text: ` v${version}`, color: theme.dim },
  ...(said ? [{ text: ` · ${fit(said, 200).trimEnd()}`, color: theme.dim }] : []),
];
