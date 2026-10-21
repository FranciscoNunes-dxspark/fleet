import React, { useMemo, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { stringWidth, wrap } from '../text.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

/** `line` wrapped to `width`, its continuation lines under its text (past its indent), as a log reads best. */
export function wrapIndented(line, width) {
  if (stringWidth(line) <= width) return [line];
  const indent = line.match(/^ */)[0];
  const room = width - indent.length - 2;
  if (room < 20) return wrap(line, width);
  const out = [];
  let cur = '';
  let max = width - indent.length;
  for (const word of line.slice(indent.length).split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (stringWidth(next) <= max || !cur) cur = next;
    else {
      out.push(cur);
      cur = word;
      max = room;
    }
  }
  out.push(cur);
  return out.map((part, i) => (i ? `${indent}  ${part}` : indent + part));
}

/**
 * Full-height scrollable text: a pull request in full, the last output, the log, help. `pageOnly`: a question
 * below has the other keys, so only page up/down scroll this.
 */
export function TextViewer({ title, text, loading, ctx, width, height, active, pageOnly = false, onClose }) {
  // Long lines wrap, so nothing is cut off at the edge (a log line, an error, a description).
  const lines = useMemo(() => (text ?? '').replace(/\n$/, '').split('\n').flatMap((l) => wrapIndented(l, width - 2)), [text, width]);
  const [offset, setOffset] = useState(0);
  const innerH = height - 2;
  const max = Math.max(0, lines.length - innerH);
  const to = (n) => setOffset(Math.max(0, Math.min(max, n)));

  useInput(
    (input, key) => {
      if (pageOnly && !key.pageDown && !key.pageUp) return;
      if (key.escape || input === 'q') return onClose();
      if (key.downArrow || input === 'j') to(offset + 1);
      else if (key.upArrow || input === 'k') to(offset - 1);
      else if (key.pageDown || input === ' ' || (key.ctrl && input === 'd')) to(offset + innerH - 1);
      else if (key.pageUp || (key.ctrl && input === 'u')) to(offset - innerH + 1);
      else if (input === 'g') to(0);
      else if (input === 'G') to(max);
    },
    { isActive: active },
  );
  useMouse(ctx, (e) => e.wheel && setOffset((o) => Math.max(0, Math.min(max, o + e.wheel * 3))));

  const pos = lines.length > innerH ? `${Math.min(lines.length, offset + innerH)}/${lines.length}` : '';
  return (
    <Panel title={title} hint={`${pos}${pos ? ' · ' : ''}esc close`} width={width} height={height} focused={active}>
      {loading ? (
        <Row pointer={false} width={width - 2} segments={[{ text: 'Loading…', color: theme.dim }]} />
      ) : (
        lines.slice(offset, offset + innerH).map((l, i) => <Row key={offset + i} pointer={false} width={width - 2} segments={[{ text: l }]} />)
      )}
    </Panel>
  );
}
