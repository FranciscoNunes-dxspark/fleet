// The host's panels over an app (the runbooks, a request followed across the apps), drawn as a box,
// pure: each panel's rows as segments ({ text, sgr }), the box around them scrolled to what has the
// cursor, every width through the kit's text.js. The host writes the box over the app's screen and
// holds the app's drawing back while it's open, as it does for the help.
import { fitSegments, stringWidth, wrap } from '@fleet/kit/text.js';
import { colour } from './bar.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[38;5;114m';
const YELLOW = '\x1b[38;5;229m';

/** A row of segments as ANSI text exactly `width` columns wide. */
export function ansiRow(segments, width) {
  return fitSegments(segments, width)
    .map((s) => (s.sgr ? `${s.sgr}${s.text}${RESET}` : s.text))
    .join('');
}

/** The box on a `columns`×`rows` screen: { left, top, width, height, inner, body } (inner and body inside its border). */
export function boxSize({ columns, rows }, want = 100) {
  const width = Math.max(12, Math.min(columns - 2, want));
  const height = Math.max(5, rows - 2);
  return { left: Math.max(0, Math.floor((columns - width) / 2)), top: Math.max(0, Math.floor((rows - height) / 2)), width, height, inner: width - 2, body: height - 2 };
}

/** The first of `total` rows to show in `height` so that rows `from` to `to` are on screen, a third of the way down when they can be. */
export function scrollFor(total, height, from = 0, to = from) {
  if (total <= height) return 0;
  let off = Math.max(0, Math.min(from - Math.floor(height / 3), total - height));
  if (to - off >= height && to - from < height) off = to - height + 1;
  return Math.max(0, Math.min(off, total - height));
}

/**
 * The box's rows as ANSI text, each `width` wide: `title` in the top border, `hint` in the bottom one,
 * `lines` (rows of segments, a column of margin added) scrolled so the rows `focus` ([from, to]) show.
 */
export function boxRows({ title, hint = '', lines, focus = [0, 0], size }) {
  const { inner, body } = size;
  const off = scrollFor(lines.length, body, ...focus);
  const border = (l, r, label, sgr, more) => {
    const mark = more ? ' ⋯ ' : '';
    const room = Math.max(0, inner - 3 - stringWidth(mark));
    const text = label ? ansiRow([{ text: ` ${label} `, sgr }], Math.min(room, stringWidth(label) + 2)) : '';
    const used = label ? Math.min(room, stringWidth(label) + 2) : 0;
    return `${l}─${text}${'─'.repeat(Math.max(0, inner - 1 - used - stringWidth(mark)))}${mark}${r}`;
  };
  const out = [border('┌', '┐', title, BOLD, off > 0)];
  for (let i = 0; i < body; i++) out.push(`│${ansiRow([{ text: ' ' }, ...(lines[off + i] ?? [])], inner)}│`);
  out.push(border('└', '┘', hint, DIM, off + body < lines.length));
  return out;
}

/** The box's rows placed on screen at `size`'s corner. */
export const placeBox = (rows, size) => rows.map((r, i) => `\x1b[${size.top + i + 1};${size.left + 1}H${r}`).join('');

const titleOf = (spaces, id) => spaces.find((s) => s.id === id)?.title ?? id;
const accentOf = (spaces, id, truecolor) => {
  const accent = spaces.find((s) => s.id === id)?.accent;
  return accent ? colour(accent, { truecolor }) : '';
};
const prose = (text, width, indent = '') => wrap(text, Math.max(10, width - stringWidth(indent))).map((l) => [{ text: `${indent}${l}`, sgr: DIM }]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The picker's rows: a runbook a row, with its steps and how far it got. { lines, focus }. */
export function pickerLines(runbooks, { cursor = 0, progress = () => null, width = 80, dirs = [] } = {}) {
  if (!runbooks.length) {
    const lines = [
      [{ text: 'No runbooks yet.', sgr: BOLD }],
      [],
      ...prose('A runbook is a Markdown file whose steps are lines for the apps\' prompts, each in a fenced block named after its app (```hail, ```trawl …). Fleet reads them from:', width - 1),
      ...dirs.map((d) => [{ text: `  ${d}` }]),
      [],
      ...prose('n drafts one from what the apps did in the last hour.', width - 1),
    ];
    return { lines, focus: [0, 0] };
  }
  const lines = runbooks.map((r, i) => {
    const done = progress(r);
    const here = i === cursor;
    return [
      { text: here ? '› ' : '  ', sgr: BOLD },
      { text: r.title, sgr: here ? `${BOLD}${YELLOW}` : '' },
      { text: `  ${plural(r.steps.length, 'step')}${done ? `, ${done} done` : ''}`, sgr: DIM },
      { text: `  ${r.where}/${r.name}.md`, sgr: DIM },
    ];
  });
  return { lines, focus: [cursor, cursor] };
}

/**
 * A runbook's rows: how far it got, then each step's prose (dim) above its line, with ✓ when it was
 * handed over and › on the cursor, the app's name in its accent. { lines, focus } (the cursor's step,
 * its prose with it).
 */
export function runbookLines(runbook, { done = new Set(), cursor = 0, width = 80, spaces = [], truecolor = true } = {}) {
  const { steps } = runbook;
  const tagW = Math.max(0, ...steps.map((s) => stringWidth(titleOf(spaces, s.app))));
  const lines = [[{ text: `${done.size} of ${plural(steps.length, 'step')} handed over · ${runbook.where}/${runbook.name}.md`, sgr: DIM }], []];
  let focus = [0, 0];
  if (!steps.length) {
    lines.push(...prose('No steps yet: a step is a line inside a fenced block named after its app (```hail). Edit the file, then open it again.', width - 1));
  }
  steps.forEach((step, i) => {
    const from = lines.length;
    if (step.prose) {
      if (i > 0) lines.push([]);
      lines.push(...prose(step.prose, width - 1));
    }
    const here = i === cursor;
    const mark = done.has(i) ? { text: '✓ ', sgr: GREEN } : { text: here ? '› ' : '  ', sgr: BOLD };
    lines.push([
      mark,
      { text: `${String(i + 1).padStart(2)} `, sgr: DIM },
      { text: ` ${titleOf(spaces, step.app).padEnd(tagW)} `, sgr: `${accentOf(spaces, step.app, truecolor)}${here ? BOLD : ''}` },
      { text: ` ${step.line}`, sgr: here ? BOLD : '' },
    ]);
    if (here) focus = [from, lines.length - 1];
  });
  if (runbook.outro) lines.push([], ...prose(runbook.outro, width - 1));
  return { lines, focus };
}

/** The move's list (folder.js folderPicks): typing a path first, then each folder, the ones moved to lately marked. */
export function folderLines(items, { cursor = 0, width = 80, short = (p) => p } = {}) {
  const rows = [{ name: 'Type a folder…', path: 'a path, completed with tab', typed: true }, ...items];
  const nameW = Math.min(30, Math.max(...rows.map((r) => stringWidth(r.name))));
  const lines = rows.map((r, i) => {
    const here = i === cursor;
    return [
      { text: here ? '› ' : '  ', sgr: BOLD },
      { text: r.name.padEnd(nameW), sgr: here ? `${BOLD}${YELLOW}` : r.has ? BOLD : '' },
      { text: `  ${r.typed ? r.path : short(r.path)}`, sgr: DIM },
      { text: r.recent ? '  lately' : '', sgr: GREEN },
    ];
  });
  return { lines, focus: [cursor, cursor] };
}

const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

/** The trace panel asking for the id: the field, with the cursor at its end. */
export function traceAskLines({ input = '', width = 80 } = {}) {
  return {
    lines: [
      ...prose('Fleet asks every running app that reads log lines (Sonar, Hail, Bosun, Wharf) to find this request, and reads the activity log and Bosun\'s recordings for it.', width - 1),
      [],
      [{ text: 'Request, operation or trace id:' }],
      [{ text: '> ', sgr: BOLD }, { text: input, sgr: YELLOW }, { text: '▏' }],
    ],
    focus: [3, 3],
  };
}

/**
 * The trace panel once asked: the apps asked (a row each, the cursor on one: ↵ goes there), then the
 * timeline Fleet read itself, oldest first, each line with its app and where it came from.
 */
export function traceLines({ id, asked = [], timeline = [], cursor = 0, width = 80, spaces = [], truecolor = true, prefix = 'ctrl+b' } = {}) {
  const lines = [[{ text: 'Following ', sgr: DIM }, { text: id, sgr: `${BOLD}${YELLOW}` }], []];
  let focus = [0, 0];
  if (!asked.length) lines.push(...prose(`No app that reads log lines (Sonar, Hail, Bosun, Wharf) is running: start one, then ${prefix} f again.`, width - 1));
  else lines.push([{ text: 'Asked, the line typed into each prompt (↵ there runs it):', sgr: DIM }]);
  const tagW = Math.max(0, ...asked.map((a) => stringWidth(titleOf(spaces, a))), ...timeline.map((e) => stringWidth(titleOf(spaces, e.app))));
  asked.forEach((app, i) => {
    const here = i === cursor;
    if (here) focus = [lines.length, lines.length];
    lines.push([
      { text: here ? '› ' : '  ', sgr: BOLD },
      { text: ` ${titleOf(spaces, app).padEnd(tagW)} `, sgr: `${accentOf(spaces, app, truecolor)}${here ? BOLD : ''}` },
      { text: here ? '  ↵ goes there' : '', sgr: DIM },
    ]);
  });
  lines.push([], [{ text: timeline.length ? `What Fleet found itself, ${plural(timeline.length, 'line')}:` : 'Nothing in the activity log or Bosun\'s recordings names it.', sgr: DIM }]);
  for (const e of timeline) {
    lines.push([
      { text: `${clock(e.at)} `, sgr: DIM },
      { text: ` ${titleOf(spaces, e.app).padEnd(tagW)} `, sgr: accentOf(spaces, e.app, truecolor) },
      { text: ` ${e.source} `, sgr: DIM },
      { text: ` ${String(e.text).replace(/\s+/g, ' ')}` },
    ]);
  }
  return { lines, focus };
}
