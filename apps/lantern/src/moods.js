// Flit's mood for the family (family.js's writeMood and readMoods): what Lantern says about itself, and
// what Flit says when a sibling's mascot is worried, sad or happy. Pure.
import { APP_NAMES } from '@fleet/kit/family.js';
import { findingsLine } from '@fleet/kit/findings.js';
import { PET } from './pet.js';

/**
 * The family's word for how Flit feels (happy | worried | sad | busy | neutral) and why: a critical or
 * high finding on the page shown, worried; an audit running, busy; a clean page or a result just now,
 * happy; else neutral.
 */
export function familyMood({ mood, result, lastEntry, busy }) {
  const c = result?.counts;
  if (c && (c.critical || c.high)) return { mood: 'worried', reason: `${findingsLine({ critical: c.critical, high: c.high })} on ${result.url}` };
  if (mood === 'worried') return { mood: 'worried', reason: lastEntry?.title ?? 'something went wrong' };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'auditing' };
  if (mood === 'happy') return { mood: 'happy', reason: lastEntry?.title ?? 'that went well' };
  if (c) return { mood: 'happy', reason: findingsLine(c) ? `only ${findingsLine(c)} on ${result.url}` : `nothing wrong on ${result.url}` };
  return { mood: 'neutral', reason: 'nothing audited yet' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} circles the lamp faster: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} folds its wings: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} flutters: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Flit (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
