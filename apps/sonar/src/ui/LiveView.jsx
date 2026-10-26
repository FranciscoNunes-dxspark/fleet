import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { label } from '../azure/arm.js';
import { theme } from '../theme.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** A log line's colour: errors red, warnings yellow, the rest plain. */
export const lineColour = (l) => (/\b(ERR|ERROR|FATAL|CRIT|Exception|fail(ed|ure)?)\b/i.test(l) ? theme.del : /\b(WRN|WARN(ING)?)\b/i.test(l) ? theme.warn : undefined);

/**
 * An app's log as it's written, the newest at the bottom: it follows the end until j/k scroll back,
 * and G follows again. p pauses (lines that come meanwhile are dropped), c clears, r reconnects.
 */
export function LiveView({ live, ctx, width, height, active }) {
  const innerH = height - 2;
  const lines = live.lines;
  // How far up from the end the view is; 0 follows the end.
  const [back, setBackState] = useState(0);
  const backRef = useRef(0);
  const max = Math.max(0, lines.length - innerH);
  const setBack = (n) => {
    backRef.current = Math.max(0, Math.min(max, n));
    setBackState(backRef.current);
  };
  // Held where it is while scrolled back, even as lines come in below.
  const seen = useRef(lines.length);
  useEffect(() => {
    if (backRef.current > 0) setBack(backRef.current + (lines.length - seen.current));
    seen.current = lines.length;
  }, [lines.length]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'k' || key.upArrow) return setBack(backRef.current + 1);
    if (input === 'j' || key.downArrow) return setBack(backRef.current - 1);
    if (key.pageUp || (key.ctrl && input === 'u')) return setBack(backRef.current + innerH - 1);
    if (key.pageDown || (key.ctrl && input === 'd') || input === ' ') return setBack(backRef.current - innerH + 1);
    if (input === 'g') return setBack(max);
    if (input === 'G') return setBack(0);
    if (input === 'p') return ctx.live.pause();
    if (input === 'c') return (ctx.live.clear(), setBack(0));
    if (input === 'R') return ctx.live.reconnect();
    if (input === 'y') return ctx.copy(lines.join('\n'), `${lines.length} lines`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) setBack(backRef.current - e.wheel * 3);
  });

  const shown = Math.min(back, max);
  const end = lines.length - shown;
  const status = { connecting: 'connecting…', streaming: live.paused ? 'paused (p goes on)' : 'live', ended: 'the stream ended (alt+r reconnects)', error: 'failed (alt+r tries again)' }[live.status] ?? '';
  const where = shown ? `${shown} lines back (alt+g follows) · ` : '';
  const title = live.target ? `Live: ${label(live.target)}` : 'Live';
  return (
    <Panel title={title} hint={`${where}${status} · p pause · c clear`} width={width} height={height} focused={active}>
      {!live.target ? <Row pointer={false} width={width - 2} segments={[{ text: '  Pick an app in Resources and press alt+l to stream its log.', color: theme.dim }]} /> : null}
      {live.error ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${live.error}`, color: theme.del }]} /> : null}
      {lines.slice(Math.max(0, end - innerH), end).map((l, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={[{ text: ` ${l}`, color: lineColour(l) }]} />
      ))}
    </Panel>
  );
}
