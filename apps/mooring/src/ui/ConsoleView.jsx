import React, { memo, useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { screenLines, screenText } from '@fleet/kit/vt.js';

// The shell's rows are drawn by a component of their own, which the shell's output renders again alone (App hears
// nothing of it): the top line, the status line and the rest stay as they were, however fast the server prints. A row
// is memoised by its text, so a key's echo draws one row again rather than every row of the Console.
const ConsoleLine = memo(function ConsoleLine({ line }) {
  return <Text wrap="truncate">{line}</Text>;
});
const ConsoleLines = memo(function ConsoleLines({ terminal, changes, height, back, cursor }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!changes) return;
    const changed = () => setTick((n) => n + 1);
    changes.add(changed);
    return () => changes.delete(changed);
  }, [changes]);
  return screenLines(terminal.vt, { height, back, cursor }).map((line, i) => <ConsoleLine key={i} line={line} />);
});

/**
 * A shell on the server with a terminal (`terminal` is terminal.js's, or null before there is one). While `typing`
 * every key goes to it (App takes them before any view: ctrl+\ leaves); otherwise ↵ starts typing, and the
 * arrows and the wheel look back through what scrolled away. `changes` is the Set of listeners App calls when the
 * shell's screen changes.
 */
export function ConsoleView({ terminal, changes, ended, conn, ctx, width, height, active, typing }) {
  const innerH = height - 2;
  const [back, setBack] = useState(0);
  // How far back there is, read when scrolling: the output since this rendered has added to it.
  const scroll = (n) => {
    const most = terminal ? terminal.vt.history.length + Math.max(0, terminal.vt.rows - innerH) : 0;
    setBack((b) => Math.max(0, Math.min(most, b + n)));
  };

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
  return (
    <Panel title="Console" hint={hint} width={width} height={height} focused={active || typing}>
      {!terminal ? (
        <Row
          pointer={false}
          width={width - 2}
          segments={[{ text: conn.session ? '  ↵ opens a shell on the server, in the folder the Files view shows.' : '  Not connected: /connect <host>', color: theme.dim }]}
        />
      ) : null}
      {terminal ? <ConsoleLines terminal={terminal} changes={changes} height={innerH} back={back} cursor={typing} /> : null}
    </Panel>
  );
}
