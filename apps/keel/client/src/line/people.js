// The Line, person by person: what each one holds at each stage (the work items they're
// assigned, the pull requests they wrote) and the reviews waiting on them. Pure, from the
// stages buildLine makes (stages.js); the Team page draws it (line/People.jsx).

/** How a person is matched across lists: account name, else id, else display name. */
export const keyOf = (p) =>String(p?.uniqueName || p?.id || p?.displayName || '').toLowerCase();
const NOBODY = '';

/**
 * One row per person, most stuck first: { key, person (null for work nobody has), stages:
 * { [id]: { cards, stuck } }, total, stuck, reviews (pull requests waiting on their vote) }.
 */
export function peopleLine(stages) {
  const rows = new Map();
  const row = (person) => {
    const key = person ? keyOf(person) : NOBODY;
    if (!rows.has(key)) {
      rows.set(key, {
        key, person: person ? { id: person.id, displayName: person.displayName, uniqueName: person.uniqueName, imageUrl: person.imageUrl } : null,
        stages: Object.fromEntries(stages.map((s) => [s.id, { cards: [], stuck: 0 }])), total: 0, stuck: 0, reviews: [],
      });
    }
    return rows.get(key);
  };

  for (const stage of stages) {
    for (const card of stage.cards) {
      if (card.kind !== 'workitem' && card.kind !== 'pr') continue;
      const r = row(card.person);
      r.stages[stage.id].cards.push(card);
      r.total++;
      if (card.stuck) { r.stages[stage.id].stuck++; r.stuck++; }
      for (const who of card.waitingOn || []) row(who).reviews.push(card);
    }
  }

  return [...rows.values()]
    .filter((r) => r.total || r.reviews.length)
    // People first (most stuck, then most held), and the work nobody has at the end.
    .sort((a, b) => (a.key === NOBODY) - (b.key === NOBODY) || b.stuck - a.stuck || b.total - a.total || b.reviews.length - a.reviews.length);
}

/** Whether a row is this person (by account name, id or display name, as people are matched elsewhere). */
export const samePerson = (a, b) => !!a && !!b && keyOf(a) === keyOf(b);
