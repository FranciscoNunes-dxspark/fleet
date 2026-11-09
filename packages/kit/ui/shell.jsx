// The shell look's two lines (look.js): the top line, which is the app, its views and its context in one
// row (the classic look's header and tab strip), and the status line at the bottom, which is the pet's
// face, what it has to say and the keys (the classic look's welcome box, the pet's reaction and the hint
// row). The layout is worked out by pure functions (topLine, statusLine) so an app can find which view
// a click landed on and the tests can read the segments; TopLine and StatusLine draw them.
import React from 'react';
import { theme } from '../theme.js';
import { fit, fitSegments, stringWidth } from '../text.js';
import { Row, barColor } from './parts.jsx';

export { barColor };

const width = (segs) => segs.reduce((n, s) => n + stringWidth(s.text), 0);

/** The left side: face, title and views (with their digits when `keys`), and where each view landed. */
function leftSide({ face, faceColor, title, views, view, keys = true }) {
  const left = [];
  if (face) left.push({ text: `${face} `, color: faceColor ?? theme.accent, bold: true });
  left.push({ text: title, bold: true }, { text: '   ' });
  const tabs = [];
  for (const v of views) {
    const on = v.id === view;
    if (on) {
      // The view shown sits on the accent, as the classic look's tab strip had it, a space either
      // side taken from the gaps beside it, so every other view stays where it was.
      left[left.length - 1] = { text: '  ' };
      const x = width(left);
      const key = keys && v.key != null ? `${v.key} ` : '';
      left.push({ text: ` ${key}${v.label}${v.count ? ` ${v.count}` : ''} `, color: theme.ink, bg: theme.accent, bold: true });
      tabs.push({ id: v.id, x, width: width(left) - x });
      left.push({ text: '  ' });
      continue;
    }
    const x = width(left);
    if (keys && v.key != null) left.push({ text: `${v.key} `, color: theme.dim });
    left.push({ text: v.label, color: theme.dim });
    if (v.count) left.push({ text: ` ${v.count}`, color: v.countColor ?? theme.warn });
    tabs.push({ id: v.id, x, width: width(left) - x });
    left.push({ text: '   ' });
  }
  left.pop();
  return { left, tabs };
}

// How much of the context a compact top line keeps room for: its parts marked `need`, with a gap each.
const neededWidth = (context) => context.filter((s) => s?.need && s.text.trim()).reduce((n, s) => n + stringWidth(s.text) + 2, 0);

// Whitespace-only parts (the gaps between facts) that no longer sit between two facts go.
function tidyGaps(segs) {
  const out = [];
  for (const s of segs) {
    const blank = !s.text.trim();
    if (blank && (!out.length || !out[out.length - 1].text.trim())) continue;
    out.push(s);
  }
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  return out;
}

/** The context cut to `room`: optional parts go from the end first, the ones marked `need` last. */
function fitContext(context, room) {
  let right = tidyGaps(context);
  while (right.length && width(right) > room) {
    const at = right.findLastIndex((s) => s.text.trim() && !s.need);
    right = tidyGaps(at < 0 ? right.slice(0, -1) : [...right.slice(0, at), ...right.slice(at + 1)]);
  }
  return right;
}

/**
 * The top line's segments, and where each view's label landed ({ id, x, width }, columns from the
 * left) for clicks. `views` is [{ id, label, key?, count?, countColor? }]: `key` (the digit that
 * picks it) is drawn dim before the label, `count` after it. `context` is segments drawn at the
 * right (a branch, an environment, "6/8 running"); it gives way first when the line is too narrow,
 * whole parts from its end. `faceColor` colours the face (the accent by default).
 *
 * With `compact`, the views give way before the facts that must stay: when they and the context's parts
 * marked `need: true` don't fit, the views' digits go first, then every view but the one shown. The
 * other parts drop from the end first, the needed ones last. A context with nothing marked never makes
 * the views give way. `compact` in the result says which: 'none', 'keys' or 'views'.
 */
export function topLine({ face, faceColor, title, views = [], view, context = [], width: W, compact = false }) {
  let shape = 'none';
  let built = leftSide({ face, faceColor, title, views, view });
  if (compact) {
    const need = neededWidth(context.filter((s) => s?.text));
    const fits = (b) => width(b.left) + 2 + need <= W;
    if (!fits(built)) {
      const bare = leftSide({ face, faceColor, title, views, view, keys: false });
      if (fits(bare)) [built, shape] = [bare, 'keys'];
      else [built, shape] = [leftSide({ face, faceColor, title, views: views.filter((v) => v.id === view), view, keys: false }), 'views'];
    }
  }
  const { left, tabs } = built;
  const used = width(left);
  const room = W - used - 2;
  // The context shows whole parts or none: "6/8 ru…" says less than nothing.
  let right = context.filter((s) => s?.text);
  if (compact) right = fitContext(right, room);
  else {
    while (right.length && width(right) > room) right = right.slice(0, -1);
    while (right.length && !right[right.length - 1].text.trim()) right = right.slice(0, -1);
  }
  const gap = right.length ? W - used - width(right) : 0;
  const segments = used >= W ? fitSegments(left, W) : [...left, ...(gap > 0 ? [{ text: ' '.repeat(gap) }] : []), ...right];
  return { segments, tabs: tabs.filter((t) => t.x < W), compact: shape };
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
 * The status line's segments, as wide as `width`: the face on the accent (or `faceColor`, or `tone`'s
 * colour: "warn", "danger"), `message` (a string or segments, first to get room), then `keys` (a hint
 * string, "↵ log · e shell", cut to whole keys) and `right` (the same, at the right, whole, or left
 * out when the message needs its room). Everything but the face sits on the bar's background.
 *
 * `news` says the message is news (a flash, a sibling's remark) rather than a resting one (the welcome,
 * the pet's mood). With `typing` (the prompt or an editor has the keys) only news is said, so the
 * typing keys stay. At rest, `minKeys` keeps room for that many keys whatever the message's length.
 */
export function statusLine({ face, faceColor, message, tone, keys, right, width: W, news = false, typing = false, minKeys = 0 }) {
  const bg = barColor();
  const lead = [];
  if (face) lead.push({ text: ` ${face} `, color: theme.ink, bg: faceColor ?? TONES[tone]?.() ?? theme.accent, bold: true });
  lead.push({ text: ' ' });
  let msgSegs = typeof message === 'string' ? (message ? [{ text: message, color: TONES[tone]?.() ?? theme.dim }] : []) : message ?? [];
  if (typing && !news) msgSegs = [];
  const rightSegs = keySegments(parseKeys(right));
  const rightW = width(rightSegs) + 1;
  // The right side stays only when what the pet says still fits whole beside it.
  const keepRight = rightSegs.length && rightW + 2 <= W - width(lead) - Math.max(6, width(msgSegs));
  let room = W - width(lead) - (keepRight ? rightW + 2 : 0);
  const body = [];
  if (msgSegs.length) {
    // What the pet says is news; the keys are in ? too, so they get what's left. A resting message
    // leaves room for `minKeys` of them.
    const parsed = parseKeys(keys);
    const reserve = !news && minKeys > 0 && parsed.length ? width(keySegments(parsed.slice(0, minKeys))) + 3 + (parsed.length > minKeys ? 3 : 0) : 0;
    const shown = fitSegments(msgSegs, Math.max(0, Math.min(width(msgSegs), room - reserve)), false);
    body.push(...shown);
    room -= width(shown);
    // The divider only when at least one key fits after it.
    const fitted = keys ? fitKeys(parsed, room - 3) : [];
    if (fitted.length) body.push({ text: ' │ ', color: theme.border }, ...fitted);
  } else if (keys && room > 0) body.push(...fitKeys(parseKeys(keys), room));
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
