import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { clean, fit, fitSegments, stringWidth, wrap } from '../text.js';

/** One line of styled segments, cut to `width`. Draws the ❯ cursor and the selection background. */
export function Row({ segments, width, selected = false, focused = true, pointer = true }) {
  const head = pointer ? [{ text: selected ? '❯ ' : '  ', color: theme.accent, bold: true }] : [];
  const segs = fitSegments([...head, ...segments], width);
  const bg = selected && focused ? theme.selBg : undefined;
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
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** A rounded box with its title set into the top border, like Claude Code's panels. */
export function Panel({ title, hint, width, height, focused = false, children }) {
  const color = focused ? theme.accent : theme.border;
  const label = title ? ` ${title} ` : '';
  const right = hint ? ` ${hint} ` : '';
  const room = width - 4;
  // One column is kept for the space after the label, so a long title never pushes the corner off.
  const shownLabel = label ? fit(label, Math.min(stringWidth(label), room - 1)).trimEnd() + ' ' : '';
  const shownHint = stringWidth(shownLabel) + stringWidth(right) <= room ? right : '';
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

/** Lines of segments (or plain strings) without a cursor, for detail panes; long ones wrap. */
export function Lines({ lines, width, height, offset = 0 }) {
  const all = lines.flatMap((line) => wrapSegments(typeof line === 'string' ? [{ text: line }] : line, width));
  const shown = all.slice(offset, offset + height);
  return shown.map((line, i) => <Row key={i} pointer={false} width={width} segments={line} />);
}

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

/** "✻ Approving… (3s · esc to stop waiting)", animated while Azure DevOps answers. */
export function Spinner({ label, started, width }) {
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
        { text: ` (${secs}s · esc to stop waiting)`, color: theme.dim },
      ]}
    />
  );
}

export function confirmHeight(req) {
  return 3 + (req.detail ? 1 : 0) + req.options.length;
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

/** The input box. Rendering only: App owns the text and handles the keys (see usePromptKeys). */
export function PromptBox({ value, cursor, focused, width, placeholder }) {
  const color = focused ? theme.accent : theme.border;
  const inner = width - 6;
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
  return (
    <Box borderStyle="round" borderColor={color} width={width} paddingX={1}>
      <Text color={focused ? color : theme.dim} bold>
        {'> '}
      </Text>
      {body}
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
