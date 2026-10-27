// Hush's mood for the family (family.js's writeMood and readMoods): what Locker says about itself, and
// what Hush says when a sibling's mascot is worried, sad or happy. Pure. A reason names secrets and
// settings, never a value.
import { APP_NAMES } from '@fleet/kit/family.js';
import { PET } from './pet.js';
import { expiryWords } from './expiry.js';

const names = (list, name) => (list.length <= 2 ? list.map(name).join(', ') : `${list.slice(0, 2).map(name).join(', ')} and ${list.length - 2} more`);

/**
 * The family's word for how Hush feels (happy | worried | busy | neutral) and why: a secret or
 * certificate about to run out, or a Key Vault reference that doesn't resolve, worried; settings that
 * differ between the sources, worried too (it's drift); a command running, busy; a result just now, happy.
 */
export function familyMood({ mood, trouble, lastEntry, busy, now = Date.now() }) {
  if (trouble?.expiring.length) {
    const first = trouble.expiring[0];
    return { mood: 'worried', reason: trouble.expiring.length === 1 ? `${first.name} ${expiryWords(first.expires, now)}` : `${names(trouble.expiring, (x) => x.name)} expire soon` };
  }
  if (trouble?.broken.length) return { mood: 'worried', reason: `${names(trouble.broken, (r) => r.key)}: Key Vault reference broken` };
  if (mood === 'worried' && lastEntry?.status === 'error') return { mood: 'worried', reason: String(lastEntry.title ?? 'something went wrong').slice(0, 100) };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'working' };
  if (trouble?.drift.length) return { mood: 'worried', reason: `${trouble.drift.length} setting${trouble.drift.length === 1 ? ' differs' : 's differ'} between the sources` };
  if (mood === 'worried') return { mood: 'worried', reason: String(lastEntry?.title ?? 'something went wrong').slice(0, 100) };
  if (mood === 'happy') return { mood: 'happy', reason: String(lastEntry?.title ?? 'that went well').slice(0, 100) };
  if (mood === 'wave') return { mood: 'happy', reason: 'every setting agrees, and nothing expires soon' };
  return { mood: 'neutral', reason: 'reading the settings' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} pulls its arms in: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} turns a shade paler: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} waves all eight arms: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Hush (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
