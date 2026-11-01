// Demo data only: 30 days of the Line's history behind today's, so the demo shows the
// stations' last days and the line over time from its first start. Repeatable (no Math.random),
// drifting toward today's numbers, with Merged and Review jamming up over the last week.
import { stageTone } from '../../client/src/line/stages.js';
import { summarize } from '../domain/linehistory.js';

const wave = (i, k) => Math.sin(i * 0.9 + k * 1.7) * 0.5 + Math.sin(i * 0.37 + k) * 0.5;

export function seedHistory(stages, now = Date.now(), days = 30) {
  const out = [];
  for (let d = days; d >= 1; d--) {
    const at = now - d * 864e5;
    const late = d <= 7; // the last week: where the demo's jam builds up
    const past = stages.map((s, k) => {
      const count = Math.max(0, Math.round(s.count * (0.75 + 0.25 * (1 - d / days)) + wave(d, k) * 3));
      const jams = late && (s.id === 'merged' || s.id === 'review' || s.id === 'deploying');
      const bad = Math.min(count, Math.max(0, Math.round((jams ? s.stuck.bad : s.stuck.bad * 0.3) + wave(d, k + 2))));
      const warn = Math.min(count - bad, Math.max(0, Math.round(s.stuck.warn * (jams ? 1 : 0.5) + wave(d, k + 4))));
      return { id: s.id, count, stuck: { warn, bad }, tone: stageTone(s.id, count, bad, warn) };
    });
    out.push(summarize(past, at));
  }
  return out;
}
