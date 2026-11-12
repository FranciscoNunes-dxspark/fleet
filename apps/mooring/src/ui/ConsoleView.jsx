import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { screenLines, screenText } from '@fleet/kit/vt.js';

/**
 * A shell on the server with a terminal (`terminal` is terminal.js's, or null before there is one). While `typing`
 * every key goes to it (App takes them before any view: ctrl+\ leaves); otherwise ↵ starts typing, and the
 * arrows and the wheel look back through what scrolled away.
 */
export function ConsoleView({ terminal, ended, conn, ctx, width, height, active, typing }) {
  const innerH = height - 2;
  const [back, setBack] = useState(0);
  const most = terminal ? terminal.vt.history.length + Math.max(0, terminal.vt.rows - innerH) : 0;
  const scroll = (n) => setBack((b) => Math.max(0, Math.min(most, b + n)));

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (key.return || input === 'i' || input === '$') return ctx.enterTerminal();
    if (key.upArrow || input === 'k') return scroll(1);
    if (key.downArrow || input === 'j') return scroll(-1);
    if (key.pageUp) return scroll(innerH - 1);
    if (key.pageDown || input === ' ') return scroll(-(innerH - 1));
    if (input === 'y' && terminal) ctx.copy(screenText(terminal.vt), 'the screen');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) scroll(-e.wheel * 3);
  });

  const where = conn.session ? conn.host.name : null;
  const hint = !where
    ? 'not connected'
    : typing
      ? `${where} · keys go to the server · ctrl+\\ leaves`
      : ended
        ? `${where} · shell ended${ended.code ? ` (exit ${ended.code})` : ''} · ↵ starts a new one`
        : `${where} · ↵ type in it · ↑↓ look back · y copy the screen`;
  const lines = terminal ? screenLines(terminal.vt, { height: innerH, back, cursor: typing }) : [];
  return (
    <Panel title="Console" hint={hint} width={width} height={height} focused={active || typing}>
      {!terminal ? (
        <Row
          pointer={false}
          width={width - 2}
          segments={[{ text: conn.session ? '  ↵ opens a shell on the server, in the folder the Files view shows.' : '  Not connected: /connect <host>', color: theme.dim }]}
        />
      ) : null}
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line}
        </Text>
      ))}
    </Panel>
  );
}
