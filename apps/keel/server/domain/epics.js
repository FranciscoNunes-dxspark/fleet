// Turns a flat epic hierarchy (roots + parent/child links + items) into a tree
// with progress rolled up from the backlog level (stories/PBIs/bugs), which is
// where "done" is meaningful. Features and epics are containers; tasks are
// too fine-grained to measure progress by.

import { isBlocked } from './attention.js';

const isContainer = (w) => /^(epic|feature)$/i.test(w.type);
const isTask = (w) => /task/i.test(w.type);

export function buildEpicTree({ roots, links, items, blockedTag }) {
  const byId = new Map(items.map((w) => [w.id, w]));
  const kids = new Map();
  for (const { parent, child } of links) {
    if (!byId.has(child)) continue;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(child);
  }

  const node = (id, seen = new Set()) => {
    const item = byId.get(id);
    if (!item || seen.has(id)) return null;
    seen.add(id);
    const children = (kids.get(id) || []).map((c) => node(c, seen)).filter(Boolean);
    const rollup = { total: 0, done: 0, inProgress: 0, points: 0, donePoints: 0, features: 0, openBugs: 0, blocked: 0 };
    for (const c of children) {
      if (isContainer(c.item)) {
        if (/feature/i.test(c.item.type)) rollup.features++;
        for (const k of Object.keys(rollup)) if (k !== 'features') rollup[k] += c.rollup[k];
        rollup.features += c.rollup.features;
      } else if (!isTask(c.item) || isContainer(item)) {
        // Backlog items count toward progress; so do tasks hung directly on an
        // epic or feature (teams that skip the story level). Tasks under a
        // story are that story's breakdown and aren't counted again.
        const w = c.item;
        const pts = Number(w.storyPoints) || 0;
        rollup.total++;
        rollup.points += pts;
        if (w.stateCategory === 'Completed') {
          rollup.done++;
          rollup.donePoints += pts;
        } else if (w.stateCategory === 'InProgress' || w.stateCategory === 'Resolved') {
          rollup.inProgress++;
        }
        if (/bug/i.test(w.type) && w.stateCategory !== 'Completed') rollup.openBugs++;
        if (w.stateCategory !== 'Completed' && isBlocked(w, blockedTag)) rollup.blocked++;
      }
    }
    // Containers first, then backlog items by state (unfinished first).
    const order = { Proposed: 1, InProgress: 0, Resolved: 0, Completed: 2 };
    children.sort((a, b) => (isContainer(b.item) - isContainer(a.item))
      || (order[a.item.stateCategory] ?? 1) - (order[b.item.stateCategory] ?? 1)
      || a.item.title.localeCompare(b.item.title));
    return { item, children, rollup };
  };

  return roots.map((id) => node(id)).filter(Boolean);
}
