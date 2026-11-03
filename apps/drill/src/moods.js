// Peck's mood for the family (family.js's writeMood and readMoods): what Drill says about itself, and
// what Peck says when a sibling's mascot is worried, sad or happy. Pure.
import { APP_NAMES } from '@fleet/kit/family.js';
import { PET } from './pet.js';

/**
 * The family's word for how Peck feels (happy | worried | sad | busy | neutral) and why: failing
 * tests, worried; a run going, busy; a run all passed (or a result just now), happy; else neutral.
 */
export function familyMood({ mood, run, lastEntry, busy }) {
  const c = run?.counts;
  if (c?.failed) return { mood: 'worried', reason: `${c.failed} test${c.failed === 1 ? '' : 's'} failing` };
  if (mood === 'worried') return { mood: 'worried', reason: lastEntry?.title ?? 'something went wrong' };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'running tests' };
  if (mood === 'happy') return { mood: 'happy', reason: lastEntry?.title ?? 'that went well' };
  if (c) return { mood: 'happy', reason: `all ${c.passed} passing` };
  return { mood: 'neutral', reason: 'not run yet' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} stops tapping: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} taps softly: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} drums a little roll: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Peck (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
