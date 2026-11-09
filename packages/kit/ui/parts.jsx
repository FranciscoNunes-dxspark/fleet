import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { clean, fit, fitSegments, stringWidth } from '../text.js';
import { shellLook } from '../look.js';
import { app, appConfigured } from '../app.js';

// The status line's (and the command box's) background when the app's palette names none (`theme.bar`).
const BAR = { dark: '#1a1e24', light: '#eceef1' };

/** The status line's background: the palette's `bar`, else a grey a step off the terminal's own. */
export const barColor = () => theme.bar ?? (theme.mode === 'light' ? BAR.light : BAR.dark);

/**
 * One line of styled segments, cut to `width`. Draws the ❯ cursor and the selection background;
 * `marked` gives a row the background without the cursor (one of several rows selected).
 */
export function Row({ segments, width, selected = false, marked = false, focused = true, pointer = true }) {
  const head = pointer ? [{ text: selected ? '❯ ' : '  ', color: theme.accent, bold: true }] : [];
  const segs = fitSegments([...head, ...segments], width);
  const bg = (selected || marked) && focused ? theme.selBg : undefined;
  return (
    <Text wrap="truncate">
      {segs.map((s, i) => (
        <Text
          key={i}
          color={s.color}
          backgroundColor={s.bg ?? bg}
          bold={s.bold || (selected && focused && s.strong)}
          dimColor={s.dim}
          italic={s.italic}
          underline={s.underline}
          strikethrough={s.strike}
          inverse={s.inverse}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** A rounded box with its title set into the top border, like Claude Code's panels. */
/**
 * A hint cut to `room` columns (with its spaces around it): whole " · " parts from the start, the rest
 * as "…", so what comes first (a count, the main keys) stays; nothing when not even a few columns are left.
 */
function fitHint(hint, room) {
  if (!hint) return '';
  if (stringWidth(hint) + 2 <= room) return ` ${hint} `;
  const parts = hint.split(' · ');
  for (let k = parts.length - 1; k > 0; k--) {
    const cut = `${parts.slice(0, k).join(' · ')} · …`;
    if (stringWidth(cut) + 2 <= room) return ` ${cut} `;
  }
  return room >= 6 ? ` ${fit(parts[0], room - 2).trimEnd()} ` : '';
}

// The hint a focused panel last had to cut, whole, with its title: the ? window shows it (HelpView's
// "On screen"). One app draws in each process, so one is enough.
let cutShort = null;

/** The hint the focused panel last cut short ({ title, hint }), or null when it showed whole. */
export const cutHint = () => cutShort;

export function Panel({ title, hint, width, height, focused = false, children }) {
  // A production environment (environments.js's markProduction) draws every frame red.
  const color = theme.envProd ? theme.del : focused ? theme.accent : theme.border;
  if (shellLook()) return <Pane {...{ title, hint, width, height, focused, color }}>{children}</Pane>;
  const label = title ? ` ${title} ` : '';
  const room = width - 4;
  // One column is kept for the space after the label, so a long title never pushes the corner off.
  const shownLabel = label ? fit(label, Math.min(stringWidth(label), room - 1)).trimEnd() + ' ' : '';
  // The title comes first; the hint gets what's left.
  const shownHint = fitHint(hint, room - stringWidth(shownLabel));
  if (focused) cutShort = hint && shownHint !== ` ${hint} ` ? { title, hint } : null;
  const fill = Math.max(0, room - stringWidth(shownLabel) - stringWidth(shownHint));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate">
        <Text color={color}>╭─</Text>
        <Text color={focused ? theme.accent : undefined} bold>
          {shownLabel}
        </Text>
        <Text color={color}>{'─'.repeat(fill)}</Text>
        <Text color={theme.dim}>{shownHint}</Text>
        <Text color={color}>─╮</Text>
      </Text>
      <Box
        flexDirection="column"
        width={width}
        height={height - 1}
        borderStyle="round"
        borderTop={false}
        borderColor={color}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}

/**
 * The shell look's pane: a title row and a rule down the left side, in the accent when focused, and no
 * box. Its children get the same width as inside Panel's box (the rule and one column on the right)
 * and one row more, since there is no bottom border.
 */
function Pane({ title, hint, width, height, focused, color, children }) {
  const label = title ? ` ${title} ` : '';
  const room = width - 2;
  const shownLabel = label ? fit(label, Math.min(stringWidth(label), room - 1)).trimEnd() + ' ' : '';
  const shownHint = fitHint(hint, room - stringWidth(shownLabel));
  if (focused) cutShort = hint && shownHint !== ` ${hint} ` ? { title, hint } : null;
  const fill = Math.max(0, room - stringWidth(shownLabel) - stringWidth(shownHint));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate">
        <Text color={color}>│</Text>
        <Text color={focused ? theme.accent : theme.dim} bold={focused}>
          {shownLabel}
        </Text>
        {' '.repeat(fill)}
        <Text color={theme.dim}>{shownHint}</Text>
        {' '}
      </Text>
      <Box
        flexDirection="column"
        width={width}
        height={height - 1}
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={color}
        paddingRight={1}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}

/**
 * Lines of segments (or plain strings) without a cursor, for detail panes: rows `offset` to
 * `offset + height` of `lines`. Only those are drawn, so slice first rather than restyling every
 * line of a long text on each render: pass the visible rows (and no offset), or `lines` as a
 * function `(i) => line` with `count`, which is asked for the visible rows only.
 */
export function Lines({ lines, count, width, height, offset = 0 }) {
  const shown = [];
  if (typeof lines === 'function') {
    for (let i = offset; i < Math.min(offset + height, count ?? 0); i++) shown.push(lines(i));
  } else shown.push(...lines.slice(offset, offset + height));
  return shown.map((line, i) => (
    <Row key={i} pointer={false} width={width} segments={typeof line === 'string' ? [{ text: line }] : line} />
  ));
}

// ✱ rather than ✳: terminals draw ✳ as a green emoji square.
const FRAMES = ['·', '✢', '✱', '✶', '✻', '✽', '✻', '✶', '✱', '✢'];

/** "✻ Running… (3s · esc to cancel)", animated while a command runs; `hint` says what esc does. */
export function Spinner({ label, started, width, hint = 'esc to cancel' }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - started) / 1000);
  return (
    <Row
      pointer={false}
      width={width}
      segments={[
        { text: `${FRAMES[tick % FRAMES.length]} ${label}…`, color: theme.accent },
        { text: ` (${secs}s · ${hint})`, color: theme.dim },
      ]}
    />
  );
}

export function confirmHeight(req) {
  if (req.secret) return 4 + (req.detail ? 1 : 0) + (req.remember !== undefined ? 1 : 0);
  return 3 + (req.detail ? 1 : 0) + req.options.length;
}

/**
 * A password field in the confirm box: what's typed shows as * (or as it is, with `req.plain`, for
 * a value that isn't secret; `req.value` is what it starts with). ↵ gives { value, remember },
 * esc null. With `req.remember` set, tab flips the "keep it" choice under the field.
 */
export function SecretPrompt({ req, width, onDone }) {
  const [value, setValueState] = useState(req.value ?? '');
  const [remember, setRemember] = useState(req.remember);
  // ↵ can come before the render after the last key, so the text lives in a ref too.
  const valueRef = useRef(req.value ?? '');
  const setValue = (v) => {
    valueRef.current = v;
    setValueState(v);
  };
  useInput((input, key) => {
    if (key.escape) return onDone(null);
    if (key.return) return onDone({ value: valueRef.current, remember: Boolean(remember) });
    if (key.tab) return remember !== undefined && setRemember((r) => !r);
    if (key.backspace || key.delete) return setValue(valueRef.current.slice(0, -1));
    if (key.ctrl && input === 'u') return setValue('');
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\x00-\x1f\x7f]/g, '');
    if (text) setValue(valueRef.current + text);
  });
  const inner = width - 4;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={req.danger ? theme.del : theme.accent} width={width} paddingX={1}>
      <Text bold wrap="truncate">
        {fit(req.title, inner).trimEnd()}
      </Text>
      {req.detail ? (
        <Text color={theme.dim} wrap="truncate">
          {fit(req.detail, inner).trimEnd()}
        </Text>
      ) : null}
      <Text wrap="truncate">
        <Text color={theme.accent} bold>
          {'> '}
        </Text>
        {req.plain ? value.slice(-Math.max(1, inner - 3)) : '*'.repeat(Math.min(value.length, Math.max(0, inner - 3)))}
        <Text inverse> </Text>
      </Text>
      {remember !== undefined ? (
        <Row
          pointer={false}
          width={inner}
          segments={[
            { text: remember ? '[x] ' : '[ ] ', color: theme.accent, bold: true },
            { text: req.rememberLabel ?? 'Remember it' },
            { text: '  (tab changes it · ↵ connect · esc cancel)', color: theme.dim },
          ]}
        />
      ) : null}
    </Box>
  );
}

/** A numbered choice in a box, like Claude Code's permission prompts. Esc picks null. */
export function Confirm({ req, width, onDone }) {
  const [sel, setSel] = useState(0);
  const n = req.options.length;
  useInput((input, key) => {
    if (key.escape) return onDone(null);
    if (key.upArrow || input === 'k') return setSel((s) => (s - 1 + n) % n);
    if (key.downArrow || input === 'j' || key.tab) return setSel((s) => (s + 1) % n);
    const num = Number(input);
    if (num >= 1 && num <= n) return onDone(req.options[num - 1].value);
    if (key.return) onDone(req.options[sel].value);
  });
  const inner = width - 4;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={req.danger ? theme.del : theme.accent} width={width} paddingX={1}>
      <Text bold wrap="truncate">
        {fit(req.title, inner).trimEnd()}
      </Text>
      {req.detail ? (
        <Text color={theme.dim} wrap="truncate">
          {fit(req.detail, inner).trimEnd()}
        </Text>
      ) : null}
      {req.options.map((o, i) => (
        <Row
          key={i}
          width={inner}
          selected={i === sel}
          focused={false}
          segments={[{ text: `${i + 1}. ${o.label}`, color: i === sel ? theme.accent : undefined, bold: i === sel }]}
        />
      ))}
    </Box>
  );
}

/**
 * The input box. Rendering only: App owns the text and handles the keys (see usePromptKeys).
 * `bang` is false in an app where "!" means nothing at the prompt.
 *
 * With `modal`, the shell look draws the prompt as a command box over the view while it has the keys
 * (CommandBox, with the suggestions `items` and `selected` inside it, placed in an app `height` rows
 * tall), and nothing at all while it hasn't. It must then be a child of the app's outermost Box.
 */
export function PromptBox({ value, cursor, focused, width, placeholder, bang = true, modal = false, items = [], selected = 0, height = 0 }) {
  if (modal && shellLook()) return focused ? <CommandBox value={value} cursor={cursor} width={width} height={height} items={items} selected={selected} bang={bang} /> : null;
  // "!" runs what follows as it is (SQL, or a git command), and the box takes another colour.
  const bangMode = bang && value.startsWith('!');
  const color = !focused ? theme.border : bangMode ? theme.bangMode : theme.accent;
  const shell = shellLook();
  // The shell look's prompt is one row, without the box: the sign, a space, the text.
  const inner = shell ? width - 3 : width - 6;
  let body;
  if (!focused && !value) {
    body = <Text color={theme.dim}>{fit(placeholder, inner).trimEnd()}</Text>;
  } else {
    // Scroll the text so the cursor stays visible.
    const start = Math.max(0, cursor - inner + 1);
    const visible = value.slice(start, start + inner);
    const at = cursor - start;
    const before = clean(visible.slice(0, at));
    const under = visible[at] ?? ' ';
    const after = clean(visible.slice(at + 1));
    body = focused ? (
      <Text>
        {before}
        <Text inverse>{under}</Text>
        {after}
      </Text>
    ) : (
      <Text color={theme.dim}>{clean(visible)}</Text>
    );
  }
  // The shell look's prompt reads as a shell's: » for the app's own commands, $ while "!" runs one as
  // it is (git, SQL, a shell command). The same two columns as "> ", so a click lands where it did; »
  // rather than ❯, which marks the selected row in the lists.
  const sign = (
    <Text color={focused ? color : theme.dim} bold>
      {shell ? (bangMode ? '$ ' : '» ') : bangMode ? '! ' : '> '}
    </Text>
  );
  if (shell) {
    return (
      <Box width={width} paddingLeft={1} height={1} overflow="hidden">
        {sign}
        {body}
      </Box>
    );
  }
  return (
    <Box borderStyle="round" borderColor={color} width={width} paddingX={1}>
      {sign}
      {body}
    </Box>
  );
}

/** The rows a Panel `height` tall gives its children: its title and bottom border taken off, or only the title row in the shell look. */
export const paneRows = (height) => Math.max(0, height - (shellLook() ? 1 : 2));

/** The rows PromptBox takes: three in a box, one in the shell look. */
export const promptHeight = () => (shellLook() ? 1 : 3);

/** The rows a modal PromptBox and its `count` suggestions take from the layout: none in the shell look, where they sit over the view. */
export const commandRows = (count) => (shellLook() ? 0 : promptHeight() + count);

/**
 * Where the command box sits in an app `width` × `height` with `count` suggestions: { top, left, width,
 * rows, input, textX, inner }, rows and columns from the app's top left. `input` is the row typed in,
 * the suggestions the rows under it; the text starts at column `textX` and shows `inner` columns. The
 * box keeps its top whatever the suggestions, a quarter of the way down, so it doesn't jump as they change.
 */
export function commandBox({ width, height, count = 0 }) {
  const w = Math.max(24, Math.min(width - 4, 120));
  const rows = 3 + count;
  const top = Math.max(1, Math.min(Math.floor(height / 4), height - rows - 1));
  const left = Math.max(0, Math.floor((width - w) / 2));
  return { top, left, width: w, rows, input: top + 1, textX: left + 4, inner: w - 6 };
}

/**
 * The command box an app's clicks are matched against: undefined in the classic look (the prompt is in
 * the layout), null while it's closed, else commandBox's.
 */
export function commandBoxFor({ open, width, height, count = 0 }) {
  if (!shellLook()) return undefined;
  return open ? commandBox({ width, height, count }) : null;
}

/** The prompt's row for clicks: the box's input row, none (-1) while the box is closed, else `row`, where the classic look draws it. */
export const promptRowFor = (box, row) => (box === undefined ? row : box ? box.input : -1);

/** Whether a click landed in the command box: undefined when there's none open, else true or false. */
export function commandBoxHit(box, e) {
  if (!box) return undefined;
  return e.y >= box.top && e.y < box.top + box.rows && e.x >= box.left && e.x < box.left + box.width;
}

const BOX_KEYS = [
  ['↵', 'run'],
  ['tab', 'complete'],
  ['↑↓', 'pick'],
  ['esc', 'close'],
];

/**
 * The shell look's command box, over the view: a square box on the bar's background with the app's name
 * in its top border, the prompt (» for the app's own commands, $ while "!" runs one as it is), the
 * suggestions under it, and the keys in its bottom border. Drawn where commandBox places it.
 */
export function CommandBox({ value, cursor, width, height, items = [], selected = 0, bang = true }) {
  const b = commandBox({ width, height, count: items.length });
  const bg = barColor();
  const bangMode = bang && value.startsWith('!');
  const edge = bangMode ? theme.bangMode : theme.accent;
  const W = b.width;
  const line = (segs) => [{ text: '│', color: edge }, ...fitSegments(segs, W - 2, true), { text: '│', color: edge }].map((s) => ({ ...s, bg }));
  const title = appConfigured() ? app().title : 'Commands';
  const mode = bangMode ? 'run as it is' : 'commands';
  const topFill = Math.max(0, W - 2 - stringWidth(` ${title} `) - stringWidth(` ${mode} `) - 2);
  const top = [
    { text: '┌─', color: edge },
    { text: ` ${title} `, color: edge, bold: true },
    { text: '─'.repeat(topFill), color: edge },
    { text: ` ${mode} `, color: theme.dim },
    { text: '─┐', color: edge },
  ].map((s) => ({ ...s, bg }));
  // The text scrolled so the cursor stays in sight, the cursor a block.
  const start = Math.max(0, cursor - b.inner + 1);
  const visible = value.slice(start, start + b.inner);
  const at = cursor - start;
  const input = line([
    { text: ' ' },
    { text: bangMode ? '$ ' : '» ', color: edge, bold: true },
    { text: clean(visible.slice(0, at)) },
    { text: visible[at] ?? ' ', inverse: true },
    { text: clean(visible.slice(at + 1)) },
  ]);
  // The names' column, as wide as the longest up to two fifths of the box; a suggestion with nothing to
  // say about it (a value, a problem's line) takes the whole row.
  const nameW = items.length ? Math.min(Math.max(28, Math.floor(b.inner * 0.4)), Math.max(...items.map((s) => stringWidth(s.label + (s.hint ? ` ${s.hint}` : '')))) + 2) : 0;
  const rows = items.map((s, i) => {
    const on = i === selected;
    const name = s.label + (s.hint ? ` ${s.hint}` : '');
    const segs = line([
      { text: on ? ' › ' : '   ', color: edge, bold: true },
      { text: s.desc ? fit(name, nameW - 2) : name, color: on ? edge : undefined, bold: on },
      { text: '  ' },
      { text: s.desc ?? '', color: on ? undefined : theme.dim },
    ]);
    return on ? segs.map((x, j) => (j === 0 || j === segs.length - 1 ? x : { ...x, bg: theme.selBg ?? bg })) : segs;
  });
  const keys = [];
  BOX_KEYS.forEach(([k, label], i) => {
    keys.push({ text: i ? '  ' : ' ' }, { text: k, bold: true }, { text: ` ${label}`, color: theme.dim });
  });
  keys.push({ text: ' ' });
  const shownKeys = stringWidth(keys.map((k) => k.text).join('')) <= W - 4 ? keys : [];
  const bottom = [
    { text: '└─', color: edge },
    ...shownKeys,
    { text: '─'.repeat(Math.max(0, W - 4 - stringWidth(shownKeys.map((k) => k.text).join('')))), color: edge },
    { text: '─┘', color: edge },
  ].map((s) => ({ ...s, bg }));
  return (
    <Box position="absolute" marginTop={b.top} marginLeft={b.left} width={W} flexDirection="column">
      {[top, input, ...rows, bottom].map((segs, i) => (
        <Row key={i} pointer={false} width={W} segments={segs} />
      ))}
    </Box>
  );
}

/** The slash-command menu under the prompt. */
export function Suggestions({ items, selected, width }) {
  const nameW = Math.min(28, Math.max(...items.map((s) => stringWidth(s.label + (s.hint ? ` ${s.hint}` : '')))) + 2);
  return items.map((s, i) => {
    const on = i === selected;
    const name = s.label + (s.hint ? ` ${s.hint}` : '');
    return (
      <Row
        key={s.label}
        width={width}
        pointer={false}
        segments={[
          { text: '  ' },
          { text: fit(name, nameW), color: on ? theme.accent : undefined, bold: on },
          { text: s.desc ?? '', color: on ? theme.accent : theme.dim },
        ]}
      />
    );
  });
}
