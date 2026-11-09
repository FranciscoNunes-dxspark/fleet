import React, { useEffect, useState } from 'react';
import { petRows } from '../pet.js';
import { VERSION } from '../app.js';
import { Row } from '@fleet/kit/ui/parts.jsx';

export const PET_WIDTH = 16;

/** The pet in pixels. While an audit runs ("look") it glances from side to side. */
export function Pet({ mood }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mood !== 'look') return;
    const t = setInterval(() => setTick((n) => n + 1), 450);
    return () => clearInterval(t);
  }, [mood]);
  const shown = mood === 'look' && tick % 2 ? 'idle' : mood;
  return petRows(shown).map((segs, i) => <Row key={i} pointer={false} width={PET_WIDTH} segments={segs} />);
}

// The status line's word about a newer release, by how far installing it has got.
const UPDATE_LINES = {
  out: (v) => `Lantern ${v} is out (you have ${VERSION}).`,
  installing: (v) => `Lantern ${v} is out; downloading it in the background.`,
  installed: (v) => `Lantern ${v} is installed and starts the next time you open Lantern.`,
};

/** What the status line says about `update` ({ latest, state }). */
export const updateLine = (update) => UPDATE_LINES[update.state ?? 'out'](update.latest);
