// Nibs's mood for the family (family.js's writeMood and readMoods): what Bilge says about itself, and
// what Nibs says when a sibling's mascot is worried, sad or happy. Pure.
import { APP_NAMES } from '@fleet/kit/family.js';
import { countLine } from './audit.js';
import { PET } from './pet.js';

/**
 * The family's word for how Nibs feels (happy | worried | sad | busy | neutral) and why: a critical or
 * high advisory, worried; a command running, busy; a clean audit or a result just now, happy; else
 * neutral.
 */
export function familyMood({ mood, data, lastEntry, busy }) {
  const c = data?.audit?.counts;
  if (c && (c.critical || c.high)) return { mood: 'worried', reason: countLine({ critical: c.critical, high: c.high }) };
  if (mood === 'worried') return { mood: 'worried', reason: lastEntry?.title ?? 'something went wrong' };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'working' };
  if (mood === 'happy') return { mood: 'happy', reason: lastEntry?.title ?? 'that went well' };
  if (c) return { mood: 'happy', reason: countLine(c) ? `only ${countLine(c)}` : `nothing known against ${data.packages.length} packages` };
  return { mood: 'neutral', reason: data?.packages?.length ? 'not audited yet' : 'no packages' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} drops its bucket: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} bails a little slower: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} twitches its whiskers: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Nibs (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
