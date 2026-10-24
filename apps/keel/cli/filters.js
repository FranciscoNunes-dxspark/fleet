// Filters by field in the terminal app's lists, as the web app's dropdowns filter its pages: who has
// it or wrote it, its type, tag, state, project, repo or team. They're written into the same text as
// /find, as `who:tom type:bug refund` (plain words still search the text), so one filter per tab
// holds both; F (and /filter) builds them from the values in the list on screen. Pure, so the
// tests can check it.

// What each tab can be filtered by: a field's label, and the values an item has for it.
const person = (p) => (p?.displayName ? [p.displayName] : []);
const FIELDS = {
  board: {
    who: { label: 'Assigned to', of: (w) => person(w.assignedTo), people: true },
    type: { label: 'Type', of: (w) => [w.type] },
    tag: { label: 'Tag', of: (w) => w.tags ?? [] },
    state: { label: 'State', of: (w) => [w.state] },
  },
  workitems: {
    who: { label: 'Assigned to', of: (w) => person(w.assignedTo), people: true },
    type: { label: 'Type', of: (w) => [w.type] },
    tag: { label: 'Tag', of: (w) => w.tags ?? [] },
    state: { label: 'State', of: (w) => [w.state] },
    project: { label: 'Project', of: (w) => [w.projectName] },
  },
  prs: {
    who: { label: 'Author', of: (p) => person(p.author), people: true },
    project: { label: 'Project', of: (p) => [p.projectName] },
    repo: { label: 'Repository', of: (p) => [p.repoName] },
  },
  pipelines: {
    project: { label: 'Project', of: (r) => [r.projectName] },
    repo: { label: 'Repository', of: (r) => (r.repoName ? [r.repoName] : []) },
  },
  releases: {
    project: { label: 'Project', of: (d) => [d.projectName] },
  },
  team: {
    team: { label: 'Team', of: (r) => (r.person.teams ?? []).map((t) => t.teamName) },
  },
};

/** The fields a tab can be filtered by: `[key, { label, of, people }]`. */
export const filterFields = (tab) => Object.entries(FIELDS[tab] ?? {});

const TOKEN = /(?:^|\s)([a-z]+):(?:"([^"]*)"|(\S+))/gi;

/** `who:"Tom K" type:bug refund` → { fields: [{ key: 'who', value: 'Tom K' }, …], text: 'refund' }. Unknown keys stay text. */
export function splitFilter(text, tab) {
  const known = FIELDS[tab] ?? {};
  const fields = [];
  const rest = String(text ?? '').replace(TOKEN, (all, key, quoted, plain) => {
    const k = key.toLowerCase();
    if (!known[k]) return all;
    fields.push({ key: k, value: quoted ?? plain });
    return ' ';
  });
  return { fields, text: rest.replace(/\s+/g, ' ').trim() };
}

/**
 * Whether `item` has every field value asked for (ignoring case, any part of a value). For people,
 * `me` is whoever `isMe(item)` says, and `none` is nobody.
 */
export function fieldsMatch(tab, item, fields, isMe = () => false) {
  return fields.every(({ key, value }) => {
    const f = FIELDS[tab]?.[key];
    if (!f) return true;
    const v = value.toLowerCase();
    const values = f.of(item).filter(Boolean);
    if (f.people && v === 'me') return isMe(item);
    if (f.people && v === 'none') return !values.length;
    return values.some((x) => String(x).toLowerCase().includes(v));
  });
}

/** `items` narrowed by the fields in `text`, and the words left for the tab's own text search. */
export function applyFilter(tab, items, text, isMe) {
  const { fields, text: words } = splitFilter(text, tab);
  return { items: fields.length ? (items ?? []).filter((x) => fieldsMatch(tab, x, fields, isMe)) : items ?? [], text: words };
}

const quote = (v) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

/** The filter text with `key` set to `value`, or taken out when `value` is null; the rest stays. */
export function withField(text, tab, key, value) {
  const { fields, text: words } = splitFilter(text, tab);
  const kept = fields.filter((f) => f.key !== key);
  if (value != null && value !== '') kept.push({ key, value });
  return [...kept.map((f) => `${f.key}:${quote(f.value)}`), words].filter(Boolean).join(' ');
}

/** A filter as the hints say it: who:"Tom K" type:bug as it is, plain words in quotes. */
export const shownFilter = (text) => (/(?:^|\s)[a-z]+:/i.test(text) ? text : `"${text}"`);

/** The values a field has in `items`, most common first: `[{ value, count }]`. */
export function fieldValues(tab, key, items) {
  const f = FIELDS[tab]?.[key];
  if (!f) return [];
  const counts = new Map();
  for (const it of items ?? []) for (const v of new Set(f.of(it).filter(Boolean))) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}
