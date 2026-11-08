import React, { useEffect, useState } from 'react';
import { glimRows } from '../glim.js';
import { Row } from '@fleet/kit/ui/parts.jsx';

export const GLIM_WIDTH = 16;

/** Glim in pixels. While a query runs ("look") Glim glances from side to side. */
export function Glim({ mood }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mood !== 'look') return;
    const t = setInterval(() => setTick((n) => n + 1), 450);
    return () => clearInterval(t);
  }, [mood]);
  const shown = mood === 'look' && tick % 2 ? 'idle' : mood;
  return glimRows(shown).map((segs, i) => <Row key={i} pointer={false} width={GLIM_WIDTH} segments={segs} />);
}
