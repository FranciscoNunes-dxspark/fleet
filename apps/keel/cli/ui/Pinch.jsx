import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { moodLine, pinchRows } from '../pinch.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { VERSION } from '../open.js';
import { Row } from './parts.jsx';

export const PINCH_WIDTH = 16;
export const WELCOME_HEIGHT = 7;

/** Pinch in pixels. While Azure DevOps answers ("look") Pinch glances from side to side. */
export function Pinch({ mood }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mood !== 'look') return;
    const t = setInterval(() => setTick((n) => n + 1), 450);
    return () => clearInterval(t);
  }, [mood]);
  const shown = mood === 'look' && tick % 2 ? 'idle' : mood;
  return pinchRows(shown).map((segs, i) => <Row key={i} pointer={false} width={PINCH_WIDTH} segments={segs} />);
}

/** The box shown when Keel starts, like Claude Code's welcome. Esc or the first action clears it. */
export function Welcome({ mood, attention, pollError, width }) {
  const textW = Math.max(10, width - PINCH_WIDTH - 7);
  return (
    <Box borderStyle="round" borderColor={theme.accent} width={width} height={WELCOME_HEIGHT} paddingX={1}>
      <Box flexDirection="column" width={PINCH_WIDTH}>
        <Pinch mood={mood} />
      </Box>
      <Box flexDirection="column" marginLeft={2} width={textW}>
        <Text wrap="truncate">
          <Text bold>Welcome to Keel</Text>
          <Text color={theme.dim}>{`  v${VERSION}`}</Text>
        </Text>
        <Text color={pollError ? theme.del : theme.dim} wrap="truncate">
          {fit(`Pinch the crab here. ${moodLine(mood, { attention, pollError })}`, textW).trimEnd()}
        </Text>
        <Text> </Text>
        <Text color={theme.dim} wrap="truncate">
          {fit('/ commands · o open in Azure DevOps · ? shortcuts · esc to put this away', textW).trimEnd()}
        </Text>
      </Box>
    </Box>
  );
}
