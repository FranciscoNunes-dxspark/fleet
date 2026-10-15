import { useMemo, useState } from 'react';
import { useApi, useApp } from '../context.js';
import { isBlocked } from '../format.js';
import { Avatar, Chip, Empty, ErrorBox, Loading, PageHeader, Toggle } from '../ui.jsx';
import { CATEGORY_TONE } from './WorkItems.jsx';

const isContainer = (w) => /^(epic|feature)$/i.test(w.type);

/** Done / in progress / not started as one bar, with the numbers spelled out beside it. */
function Progress({ r }) {
  if (!r.total) return <span className="muted small progress-empty">No backlog items yet</span>;
  const pct = (n) => `${(n / r.total) * 100}%`;
  const notStarted = r.total - r.done - r.inProgress;
  const label = `${r.done} of ${r.total} done, ${r.inProgress} in progress, ${notStarted} not started`;
  return (
    <span className="progress" title={label}>
      <span className="progress-bar" role="img" aria-label={label}>
        {r.done > 0 && <span className="progress-done" style={{ width: pct(r.done) }} />}
        {r.inProgress > 0 && <span className="progress-doing" style={{ width: pct(r.inProgress) }} />}
      </span>
      <span className="progress-text small">
        <strong>{Math.round((r.done / r.total) * 100)}%</strong>
        <span className="muted"> {r.done}/{r.total} items{r.points ? ` · ${r.donePoints}/${r.points} pts` : ''}</span>
      </span>
    </span>
  );
}

function matches(node, needle) {
  return node.item.title.toLowerCase().includes(needle) || String(node.item.id) === needle || node.children.some((c) => matches(c, needle));
}

function TreeNode({ node, depth, expanded, toggle, needle, blockedTag }) {
  const { openDrawer } = useApp();
  const w = node.item;
  const container = isContainer(w);
  const open = expanded.has(w.id) || (needle && depth < 2 && node.children.some((c) => matches(c, needle)));
  // Under an epic or feature every child is a row, tasks included. Under a
  // story, its tasks collapse into the "2/5 tasks" count instead.
  const visibleKids = node.children.filter((c) => (container || !/task/i.test(c.item.type)) && (!needle || matches(c, needle) || matches(node, needle)));
  const tasks = container ? [] : node.children.filter((c) => /task/i.test(c.item.type));
  const tasksDone = tasks.filter((t) => t.item.stateCategory === 'Completed').length;
  const r = node.rollup;

  return (
    <li className={`tree-node depth-${depth}`}>
      <div className={`tree-row ${container ? 'tree-container' : 'tree-leaf'} ${w.stateCategory === 'Completed' ? 'tree-done' : ''}`}>
        {container && visibleKids.length > 0 ? (
          <button type="button" className="tree-caret" aria-expanded={!!open} aria-label={`${open ? 'Collapse' : 'Expand'} ${w.title}`} onClick={() => toggle(w.id)}>
            {open ? '▾' : '▸'}
          </button>
        ) : <span className="tree-caret" aria-hidden="true" />}
        <span className={`type type-${w.type.replace(/\s+/g, '-').toLowerCase()}`}>{w.type}</span>
        <button type="button" className="row-link tree-title" onClick={() => openDrawer({ type: 'workitem', id: w.id })}>
          {w.title} <span className="mono muted small">{w.id}</span>
        </button>
        <span className="tree-meta">
          <Chip tone={CATEGORY_TONE[w.stateCategory]}>{w.state}</Chip>
          {container ? (
            <>
              <Progress r={r} />
              {r.features > 0 && /epic/i.test(w.type) && <span className="muted small">{r.features} feature{r.features === 1 ? '' : 's'}</span>}
              {r.openBugs > 0 && <span className="small text-warn">{r.openBugs} open bug{r.openBugs === 1 ? '' : 's'}</span>}
              {r.blocked > 0 && <Chip tone="bad">{r.blocked} blocked</Chip>}
            </>
          ) : (
            <>
              {w.storyPoints != null && <Chip>{w.storyPoints} pts</Chip>}
              {tasks.length > 0 && <span className="muted small">{tasksDone}/{tasks.length} tasks</span>}
              {isBlocked(w, blockedTag) && w.stateCategory !== 'Completed' && <Chip tone="bad">Blocked</Chip>}
            </>
          )}
          <Avatar person={w.assignedTo} size={20} />
        </span>
      </div>
      {open && visibleKids.length > 0 && (
        <ul className="tree">
          {visibleKids.map((c) => <TreeNode key={c.item.id} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} needle={needle} blockedTag={blockedTag} />)}
        </ul>
      )}
    </li>
  );
}

export default function Epics() {
  const [includeClosed, setIncludeClosed] = useState(false);
  const { data, error, reload, loading } = useApi(`/epics${includeClosed ? '?closed=1' : ''}`);
  const { meta } = useApp();
  const [expanded, setExpanded] = useState(() => new Set());
  const [q, setQ] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const needle = q.trim().toLowerCase();

  const toggle = (id) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const projects = useMemo(() => (data?.projects || []).map((p) => ({
    ...p,
    epics: p.epics.filter((e) => (!needle || matches(e, needle)) && (!hideEmpty || e.rollup.total || e.children.length)),
  })), [data, needle, hideEmpty]);

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Loading epics and their backlogs…" />;

  const total = data.projects.reduce((s, p) => s + p.epics.length, 0);
  // Expand every epic and feature (backlog items have no children worth opening).
  const containerIds = (n) => (isContainer(n.item) ? [n.item.id, ...n.children.flatMap(containerIds)] : []);
  const allIds = projects.flatMap((p) => p.epics.flatMap(containerIds));

  return (
    <div className="page">
      <PageHeader title="Epics" sub={`${total} ${includeClosed ? '' : 'open '}epic${total === 1 ? '' : 's'} across your tracked projects. Progress counts backlog items (stories, PBIs, bugs) under each epic and feature.`}>
        {loading && <span className="spinner" aria-label="Refreshing" />}
      </PageHeader>
      <div className="filters">
        <input type="search" className="input" placeholder="Search epics, features, items or ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search epics" />
        <Toggle checked={includeClosed} onChange={setIncludeClosed}>Include closed epics</Toggle>
        <Toggle checked={hideEmpty} onChange={setHideEmpty}>Hide empty epics</Toggle>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => setExpanded(new Set(allIds))}>Expand all</button>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => setExpanded(new Set())}>Collapse all</button>
      </div>

      {!projects.some((p) => p.epics.length) && (
        <Empty title={total ? 'No epics match.' : 'No epics in your tracked projects.'}>
          {total ? 'Clear the search or filters.' : 'Epics appear here once they exist in Azure DevOps (in your teams\' area paths, if you limited it in Settings).'}
        </Empty>
      )}

      {projects.filter((p) => p.epics.length).map((p) => (
        <section key={p.projectId} className="epic-project">
          {data.projects.length > 1 && <h2 className="section-title">{p.projectName} <span className="muted small">{p.epics.length}</span></h2>}
          <ul className="tree tree-root">
            {p.epics.map((e) => <TreeNode key={e.item.id} node={e} depth={0} expanded={expanded} toggle={toggle} needle={needle} blockedTag={meta.blockedTag} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
