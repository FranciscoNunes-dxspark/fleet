// Spoke's mood for the family (family.js's writeMood and readMoods): what Helm says about itself, and what
// Spoke says when a sibling's mascot is worried, sad or happy. Nothing a script says or does goes into one:
// whether a run went well or not, never its code, its output or an error's words. Pure.
import { APP_NAMES } from '@fleet/kit/family.js';
import { PET } from './pet.js';

/** The family's word for how Spoke feels (happy | worried | busy | neutral) and why. */
export function familyMood({ mood }) {
  if (mood === 'worried') return { mood: 'worried', reason: 'the last run failed' };
  if (mood === 'look') return { mood: 'busy', reason: 'a script is running' };
  if (mood === 'happy') return { mood: 'happy', reason: 'the last run went well' };
  return { mood: 'neutral', reason: mood === 'sleep' ? 'no PowerShell found' : 'idle' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} paces the deck: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} curls up beside you: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} purrs: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Spoke (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
