// A region an app draws natively when it runs in Fleet's window (`fleet gui`), and as text everywhere
// else. In a terminal, and in the terminal Fleet, `children` draw as always. In the window the box is
// left blank and the window is told what to draw in it ({ kind, data }: a chart, say) and where, in
// cells: the box's place on the screen, from Ink's own layout. The window draws its view under the
// app's text, so anything the app draws over the region still shows.
import React, { useEffect, useId, useRef } from 'react';
import { Box } from 'ink';
import { inWindow, showInWindow } from '../hosted.js';

/** Where an Ink node is on the screen, in cells: { x, y, width, height }, from Yoga's layout up to the root. */
export function rectOf(node) {
  if (!node?.yogaNode) return null;
  let x = 0;
  let y = 0;
  for (let n = node; n; n = n.parentNode) {
    if (!n.yogaNode) continue;
    x += n.yogaNode.getComputedLeft();
    y += n.yogaNode.getComputedTop();
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(node.yogaNode.getComputedWidth()), height: Math.round(node.yogaNode.getComputedHeight()) };
}

// A box moves when something around it changes without it drawing again: looked at this often.
const RECHECK_MS = 400;

/**
 * `kind` and `data` are what the window draws (its gui/views.js: 'chart'); `width` and `height` the
 * box's size, as a Box takes them. `window` turns it off (the text it is, always).
 */
export function GuiView({ kind, data, width, height, flexGrow, window: allowed = true, children }) {
  const native = allowed && inWindow();
  const ref = useRef(null);
  const key = useId();
  const sent = useRef('');

  useEffect(() => {
    if (!native) return undefined;
    const tell = () => {
      const rect = rectOf(ref.current);
      if (!rect || !rect.width || !rect.height) return;
      const message = JSON.stringify({ kind, data, rect });
      if (message === sent.current) return;
      sent.current = message;
      showInWindow({ key, kind, data, rect });
    };
    tell();
    const timer = setInterval(tell, RECHECK_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  });

  useEffect(
    () => () => {
      if (sent.current) showInWindow({ key, gone: true });
      sent.current = '';
    },
    [key],
  );

  return (
    <Box ref={ref} width={width} height={height} flexGrow={flexGrow} flexDirection="column">
      {native ? null : children}
    </Box>
  );
}
