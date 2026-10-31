// Plot's mood for the family (family.js's writeMood and readMoods): what Chart says about itself, and
// what Plot says when a sibling's mascot is worried, sad or happy. Pure.
import { APP_NAMES } from '@fleet/kit/family.js';
import { summarize, summaryLine } from './plan.js';
import { PET } from './pet.js';

/**
 * The family's word for how Plot feels (happy | worried | sad | busy | neutral) and why: a plan that
 * destroys or replaces something, or drift, worried; a command running, busy; a plan with nothing to
 * change, happy; else neutral.
 */
export function familyMood({ mood, data, lastEntry, busy }) {
  const plan = data?.plan;
  if (plan) {
    const s = summarize(plan.changes);
    if (s.delete || s.replace) return { mood: 'worried', reason: `the plan destroys ${(s.delete ?? 0) + (s.replace ?? 0)} (${summaryLine(s)})` };
    if (plan.drift.length) return { mood: 'worried', reason: `${plan.drift.length} changed outside ${plan.tool === 'terraform' ? 'Terraform' : 'the template'}` };
  }
  if (mood === 'worried') return { mood: 'worried', reason: lastEntry?.title ?? 'something went wrong' };
  if (mood === 'look') return { mood: 'busy', reason: busy?.label ?? 'working' };
  if (mood === 'happy') return { mood: 'happy', reason: lastEntry?.title ?? 'that went well' };
  if (plan) {
    const line = summaryLine(summarize(plan.changes));
    return line ? { mood: 'neutral', reason: `the plan: ${line}` } : { mood: 'happy', reason: 'the infrastructure matches' };
  }
  return { mood: 'neutral', reason: 'no plan yet' };
}

const SAYS = {
  worried: (app, why) => `${PET.name} ruffles its feathers: ${app} is worried${why}.`,
  sad: (app, why) => `${PET.name} tucks its beak in: ${app} is sad${why}.`,
  happy: (app, why) => `${PET.name} bobs its head: ${app} is happy${why}.`,
};

/** The newest of the siblings' `moods` worth a word from Plot (worried, sad or happy) that isn't in `seen` (keys app:at), or null. */
export function reactionTo(moods, seen = new Set()) {
  const m = moods.find((x) => SAYS[x.mood] && !seen.has(`${x.app}:${x.at}`));
  if (!m) return null;
  return { key: `${m.app}:${m.at}`, mood: m.mood, text: SAYS[m.mood](APP_NAMES[m.app] ?? m.app, m.reason ? ` (${String(m.reason).slice(0, 80)})` : '') };
}
