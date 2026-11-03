import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * The lines of the runners' virtual terminal (@fleet/kit/vt.js): what scrolled off its top, then its
 * screen, the `height` that end `back` lines above the last one written, as ANSI text. The blank rows
 * under the last one written are left out, so the end of the output sits at the bottom.
 */
export function outputLines(vt, { height, back = 0 }) {
  const kept = vt.history.length;
  let used = vt.rows;
  while (used > 0 && !vt.rowText(used - 1) && used - 1 > vt.y) used--;
  const total = kept + used;
  const end = Math.max(0, total - back);
  const start = Math.max(0, end - height);
  const lines = [];
  for (let i = start; i < end; i++) lines.push(i < kept ? vt.historyAnsi(i) : vt.rowAnsi(i - kept));
  return { lines, total };
}

/** The runners' output, as they drew it: colours, progress lines redrawn in place, all kept to look back through. */
export function OutputView({ vt, title, ctx, width, height, active }) {
  const innerH = height - 2;
  const [back, setBack] = useState(0);
  const { lines, total } = outputLines(vt, { height: innerH, back });
  const most = Math.max(0, total - innerH);
  const scroll = (n) => setBack((b) => Math.max(0, Math.min(most, b + n)));

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (key.upArrow || input === 'k') return scroll(1);
    if (key.downArrow || input === 'j') return scroll(-1);
    if (key.pageUp || (key.ctrl && input === 'u') || input === 'b') return scroll(innerH - 1);
    if (key.pageDown || input === ' ' || (key.ctrl && input === 'd')) return scroll(-(innerH - 1));
    if (input === 'g') return setBack(most);
    if (input === 'G') return setBack(0);
    if (input === 'y') {
      const text = Array.from({ length: vt.rows }, (_, y) => vt.rowText(y)).join('\n').replace(/\s+$/, '');
      return ctx.copy(text, 'the output on screen');
    }
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) scroll(-e.wheel * 3);
  });

  const hint = title ? `${title} · ${back ? `${back} lines up · G the end · ` : ''}↑↓ look back · y copy` : '';
  return (
    <Panel title="Output" hint={hint} width={width} height={height} focused={active}>
      {!title ? <Row pointer={false} width={width - 2} segments={[{ text: '  Nothing has run yet: what the runners write as they go shows here.', color: theme.dim }]} /> : null}
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line}
        </Text>
      ))}
    </Panel>
  );
}
