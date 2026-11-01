// "Since you last looked": what changed on the line between two looks at it. Pure; the home
// page keeps the last look in this browser (Line.jsx) and shows the difference when you come back.
import { STAGES } from './stages.js';

/** What a look at the line remembers: each card's stage, whether it was stuck, and its title. */
export function lookAt(stages, now = Date.now()) {
  const cards = {};
  for (const s of stages) for (const c of s.cards) cards[c.key] = { stage: s.id, stuck: c.stuck || null, title: c.title };
  return { at: new Date(now).toISOString(), cards };
}

/**
 * The difference since `before` (a lookAt), or null when there was no look before:
 * { movedOn: [{ card, from }], left: [{ key, title, stage }], arrived: [card], newlyStuck: [card] }.
 * "Moved on" is a card further along the line than it was (an item started); "left" one no longer
 * on it (finished, merged, deployed, closed).
 */
export function sinceLastLook(before, stages) {
  if (!before?.cards) return null;
  const order = (id) => STAGES.indexOf(id);
  const now = new Map(stages.flatMap((s) => s.cards.map((c) => [c.key, { card: c, stage: s.id }])));
  const movedOn = [];
  const arrived = [];
  const newlyStuck = [];
  for (const [key, { card, stage }] of now) {
    const was = before.cards[key];
    if (!was) arrived.push(card);
    else if (order(stage) > order(was.stage)) movedOn.push({ card, from: was.stage });
    if (card.stuck && (!was || !was.stuck)) newlyStuck.push(card);
  }
  const left = Object.entries(before.cards).filter(([key]) => !now.has(key)).map(([key, c]) => ({ key, title: c.title, stage: c.stage }));
  return { movedOn, left, arrived, newlyStuck };
}
