// The screen a long external run (a .bacpac export or import, a dump, a restore) takes over the main
// area with: what it's doing, how long it's been, the size of the file it's writing, and the program's
// own latest lines. A one-line spinner at the bottom said nothing for the minutes these take.
import React, { useEffect, useState } from 'react';
import { Box } from 'ink';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { BULLET, theme } from '../theme.js';
import { statSync } from 'node:fs';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

export const sizeText = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);

/** The size of `file` now, or null when it isn't there (yet). */
const sizeOf = (file) => {
  try {
    return file ? statSync(file).size : null;
  } catch {
    return null;
  }
};

export function ProgressView({ busy, progress, width, height }) {
  const [tick, setTick] = useState(0);
  const [size, setSize] = useState(null);
  useEffect(() => {
    const t = setInterval(() => {
      setTick((n) => n + 1);
      if (progress.file) setSize(sizeOf(progress.file));
    }, 500);
    return () => clearInterval(t);
  }, [progress.file]);
  const secs = Math.floor((Date.now() - busy.started) / 1000);
  const room = Math.max(1, height - 2 - 5);
  const shown = progress.lines.slice(-room);
  const rows = [
    [{ text: `${FRAMES[tick % FRAMES.length]} ${busy.label}…`, color: theme.accent, bold: true }],
    [{ text: `  Elapsed ${clock(secs)}`, color: theme.dim }, ...(size != null ? [{ text: `  ·  ${sizeText(size)} written so far`, color: theme.dim }] : [])],
    [{ text: progress.file ? `  ${progress.file}` : '', color: theme.dim }],
    [{ text: '' }],
    ...shown.map((l) => [{ text: `  ${BULLET} `, color: theme.dim }, { text: l }]),
  ];
  if (!shown.length) rows.push([{ text: '  Waiting for the program to say something…', color: theme.dim }]);
  return (
    <Panel title={progress.title} hint="esc cancels" width={width} height={height} focused>
      <Box flexDirection="column">
        {rows.map((segments, i) => (
          <Row key={i} pointer={false} width={width - 4} segments={segments} />
        ))}
      </Box>
    </Panel>
  );
}
