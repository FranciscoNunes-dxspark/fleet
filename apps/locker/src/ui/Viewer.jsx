import React, { useRef, useState } from 'react';
import { useInput } from 'ink';
import { fitSegments, wrap } from '@fleet/kit/text.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * Text over the view (ctx.showText): a key's sources, a secret's details or value, a command's output.
 * `lines` are rows of coloured segments to draw instead of `text` (which y still copies). Scrolls; esc or
 * q closes it, and with it whatever value it showed. With `secret`, y copies through ctx.copySecret,
 * which clears the clipboard again.
 */
export function Viewer({ title, text = '', lines: given, secret = false, ctx, width, height, active, onClose }) {
  const innerW = width - 4;
  const innerH = height - 2;
  const lines = given
    ? given.map((segs) => fitSegments(segs.length ? segs : [{ text: '' }], innerW))
    : String(text)
        .replace(/\n$/, '')
        .split('\n')
        .flatMap((l) => (l ? wrap(l, innerW) : ['']))
        .map((l) => [{ text: l }]);
  const max = Math.max(0, lines.length - innerH);
  const [top, setTopState] = useState(0);
  const topRef = useRef(0);
  const setTop = (n) => {
    topRef.current = Math.max(0, Math.min(max, n));
    setTopState(topRef.current);
  };
  const shown = Math.min(top, max);
  const plain = (rows) => rows.map((segs) => segs.map((s) => s.text).join('').trimEnd()).join('\n');

  const keys = (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    const here = Math.min(topRef.current, max);
    if (key.escape || input === 'q') return onClose();
    if (input === 'j' || key.downArrow) return setTop(here + 1);
    if (input === 'k' || key.upArrow) return setTop(here - 1);
    if (input === ' ' || key.pageDown || (key.ctrl && input === 'd')) return setTop(here + innerH - 1);
    if (input === 'b' || key.pageUp || (key.ctrl && input === 'u')) return setTop(here - innerH + 1);
    if (input === 'g') return setTop(0);
    if (input === 'G') return setTop(max);
    const copy = secret ? ctx.copySecret : ctx.copy;
    if (input === 'y') return copy(plain(lines.slice(here, here + innerH)), 'what is on screen');
    if (input === 'Y') return copy(String(text), `${String(text).split('\n').length} lines`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) setTop(Math.min(topRef.current, max) + e.wheel * 3);
  });

  const pos = lines.length > innerH ? `${shown + 1}-${Math.min(lines.length, shown + innerH)}/${lines.length} · ` : '';
  return (
    <Panel title={title} hint={`${secret ? 'values shown · ' : ''}${pos}esc close`} width={width} height={height} focused={active}>
      {lines.slice(shown, shown + innerH).map((segs, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={[{ text: ' ' }, ...segs]} />
      ))}
    </Panel>
  );
}
