// A team's board in the terminal (ui/BoardView.jsx): the columns of its real Azure DevOps board, or
// of the state categories when it has none configured, as the web app's Board page draws them.
// Pure, so the tests can check it. The data is service.board().
import { isBlocked } from './format.js';
import { theme } from './theme.js';

// Without a configured board, a column per state category (process-agnostic, as on the web).
const CATEGORY_COLUMNS = [
  { id: 'Proposed', label: 'Not started' },
  { id: 'InProgress', label: 'In progress' },
  { id: 'Resolved', label: 'Resolved' },
  { id: 'Completed', label: 'Done' },
];

/**
 * The columns: `{ key, label, limit, split, holds(w), accepts(w), changesFor(w) }`. `changesFor` is
 * what moving a card there saves: the board column (and Doing again in a split one), and the state
 * the column maps to for its type, as the web board's drag and drop does.
 */
export function boardColumns(data) {
  if (!data) return [];
  const isTask = (w) => (data.taskTypes ?? []).includes(w.type);
  if (data.board) {
    const f = data.board.fields ?? {};
    return data.board.columns.map((c) => ({
      key: c.name,
      label: c.name,
      limit: c.itemLimit || 0,
      split: !!c.isSplit,
      holds: (w) => !isTask(w) && w.board?.column === c.name,
      accepts: (w) => !!c.stateMappings?.[w.type] && w.board?.column !== c.name,
      changesFor: (w) => {
        const fields = { [f.column]: c.name };
        if (f.done) fields[f.done] = false;
        const state = c.stateMappings[w.type];
        return { ...(state && state !== w.state ? { state } : {}), fields };
      },
    }));
  }
  return CATEGORY_COLUMNS.map((c) => {
    const target = (w) => (data.states?.[w.type] ?? []).find((s) => s.category === c.id);
    return {
      key: c.id,
      label: c.label,
      limit: 0,
      split: false,
      holds: (w) => !isTask(w) && w.stateCategory === c.id,
      accepts: (w) => w.stateCategory !== c.id && !!target(w),
      changesFor: (w) => ({ state: target(w).name }),
    };
  });
}

/** What marking a card Done (or Doing again) in a split column saves. */
export function doneChanges(data, w) {
  return { fields: { [data.board.fields.done]: !w.board?.done } };
}

const order = (a, b) => (a.backlogOrder ?? Infinity) - (b.backlogOrder ?? Infinity) || a.id - b.id;

const matches = (w, text) => {
  const q = text.trim().toLowerCase();
  return !q || `${w.id} ${w.title} ${(w.tags ?? []).join(' ')} ${w.assignedTo?.displayName ?? ''} ${w.type}`.toLowerCase().includes(q);
};

/**
 * Each column's cards in backlog order, with the tasks under each card counted (done/total).
 * `filter` searches their text; `keep` narrows them further (filters.js fields: who, type, tag).
 */
export function boardCards(data, columns, filter = '', keep = () => true) {
  const items = data?.items ?? [];
  const tasks = new Map();
  for (const t of items.filter((w) => (data.taskTypes ?? []).includes(w.type) && w.parentId)) {
    const n = tasks.get(t.parentId) ?? { done: 0, total: 0 };
    n.total += 1;
    if (t.stateCategory === 'Completed') n.done += 1;
    tasks.set(t.parentId, n);
  }
  return columns.map((c) => items.filter((w) => c.holds(w) && matches(w, filter) && keep(w)).sort(order).map((w) => ({ ...w, tasks: tasks.get(w.id) ?? null })));
}

/** "Active 3/4": a column's title, with its WIP limit (counting only Doing in a split column) and whether it's over. */
export function columnTitle(col, cards) {
  const doing = col.split ? cards.filter((w) => !w.board?.done).length : cards.length;
  return { text: `${col.label} ${col.limit ? `${doing}/${col.limit}` : cards.length}`, over: col.limit > 0 && doing > col.limit };
}

/** A card's two lines: its number and title, then who has it, points, tasks and what's special about it. */
export function cardLines(w, { split = false, blockedTag } = {}) {
  const blocked = w.blocked || isBlocked(w, blockedTag);
  const top = [
    { text: blocked ? '⊘ ' : '■ ', color: blocked ? theme.del : w.typeColor || theme.dim },
    { text: `${w.id} `, color: theme.dim },
    { text: w.title, strong: true },
  ];
  const bits = [
    w.assignedTo ? w.assignedTo.displayName.split(' ')[0] : 'unassigned',
    w.storyPoints ? `${w.storyPoints} pt${w.storyPoints === 1 ? '' : 's'}` : '',
    w.tasks ? `${w.tasks.done}/${w.tasks.total} tasks` : '',
    w.board?.lane ? w.board.lane : '',
  ].filter(Boolean);
  const bottom = [{ text: '  ' }, { text: bits.join(' · '), color: theme.dim }];
  if (split && w.board?.done) bottom.push({ text: '  ✓ done', color: theme.ok });
  if (blocked) bottom.push({ text: '  blocked', color: theme.del });
  return [top, bottom];
}
