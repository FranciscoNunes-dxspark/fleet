import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, isBlocked, shortIteration } from '../format.js';
import { Chip, Empty, ErrorBox, Loading, PageHeader, Th, useSort } from '../ui.jsx';

const DAY = 86_400_000;

export const CATEGORY_TONE = { Proposed: 'muted', InProgress: 'info', Resolved: 'warn', Completed: 'ok', Removed: 'muted' };

export default function WorkItems() {
  const { data, error, reload } = useApi('/workitems');
  const { meta, openDrawer, refresh, toast } = useApp();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'open';
  const assignee = params.get('assignee') || '';
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [type, setType] = useState('');
  const [saving, setSaving] = useState(null);

  const blockedTag = meta.blockedTag.toLowerCase();
  const blocked = (w) => isBlocked(w, meta.blockedTag);
  const inSprint = (w) => data.currentIterationPaths.some((p) => w.iterationPath === p || w.iterationPath.startsWith(`${p}\\`));
  const stuck = (w) => w.stateCategory === 'InProgress' && Date.now() - Date.parse(w.changedAt) >= meta.thresholds.itemStuckDays * DAY;

  const VIEWS = data ? [
    { id: 'open', label: 'All open', test: () => true },
    { id: 'sprint', label: 'Current sprint', test: inSprint },
    { id: 'bugs', label: 'Bugs', test: (w) => w.type === 'Bug' },
    { id: 'blocked', label: 'Blocked', test: blocked },
    { id: 'stuck', label: `No update in ${meta.thresholds.itemStuckDays}d`, test: stuck },
    { id: 'unassigned', label: 'Unassigned', test: (w) => !w.assignedTo },
    { id: 'mine', label: 'Mine', test: (w) => w.assignedTo?.id === data.me.id },
  ] : [];

  const { sort, setSort, apply } = useSort({ key: 'priority', dir: 1 }, {
    id: (w) => w.id,
    title: (w) => w.title.toLowerCase(),
    state: (w) => ['Proposed', 'InProgress', 'Resolved', 'Completed'].indexOf(w.stateCategory),
    assignee: (w) => w.assignedTo?.displayName?.toLowerCase(),
    priority: (w) => w.priority,
    changed: (w) => -Date.parse(w.changedAt),
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const v = VIEWS.find((x) => x.id === view) || VIEWS[0];
    const needle = q.trim().toLowerCase();
    return data.items.filter((w) => v.test(w)
      && (!project || w.projectId === project)
      && (!type || w.type === type)
      && (!assignee || w.assignedTo?.id === assignee)
      && (!needle || `${w.id} ${w.title} ${w.tags.join(' ')} ${w.assignedTo?.displayName || ''}`.toLowerCase().includes(needle)));
  }, [data, view, q, project, type, assignee]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const update = async (w, changes, msg) => {
    setSaving(w.id);
    try {
      await api(`/workitems/${w.id}/actions`, { method: 'POST', body: { type: 'update', changes } });
      toast(msg);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setSaving(null);
    }
  };

  const projects = [...new Map(data.items.map((w) => [w.projectId, w.projectName])).entries()];
  const types = [...new Set(data.items.map((w) => w.type))].sort();

  return (
    <div className="page">
      <PageHeader title="Work items" sub={`${data.items.length} open items across tracked projects`} />

      <div className="segmented" role="tablist" aria-label="Work item views">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={view === v.id ? 'on' : ''} onClick={() => setParam('view', v.id === 'open' ? '' : v.id)}>
            {v.label}<span className="seg-count">{data.items.filter(v.test).length}</span>
          </button>
        ))}
      </div>

      <div className="filters">
        <input type="search" className="input" placeholder="Search title, ID, tag, person" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search work items" />
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {types.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select className="input" value={assignee} onChange={(e) => setParam('assignee', e.target.value)} aria-label="Assigned to">
          <option value="">Anyone</option>
          {data.people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
      </div>

      {!rows.length ? (
        <Empty title="No work items match.">Try another view or clear the filters.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <Th id="id" sort={sort} setSort={setSort} className="num">ID</Th>
                <Th id="title" sort={sort} setSort={setSort}>Title</Th>
                <Th id="state" sort={sort} setSort={setSort}>State</Th>
                <Th id="assignee" sort={sort} setSort={setSort}>Assigned to</Th>
                <Th id="priority" sort={sort} setSort={setSort} className="num">Pri</Th>
                <Th id="changed" sort={sort} setSort={setSort} className="num">Updated</Th>
              </tr>
            </thead>
            <tbody>
              {apply(rows).map((w) => {
                const states = data.states[w.projectId]?.[w.type] || [];
                return (
                  <tr key={w.id} className={saving === w.id ? 'saving' : ''}>
                    <td className="num mono muted">{w.id}</td>
                    <td className="cell-title">
                      <button type="button" className="row-link" onClick={() => openDrawer({ type: 'workitem', id: w.id })}>{w.title}</button>
                      <div className="sub">
                        <span className={`type type-${w.type.replace(/\s+/g, '-').toLowerCase()}`}>{w.type}</span>
                        <span>{w.projectName}</span>
                        {w.iterationPath !== w.projectName && <span>{shortIteration(w.iterationPath)}</span>}
                        {blocked(w) && <Chip tone="bad">Blocked</Chip>}
                        {w.tags.filter((t) => t.toLowerCase() !== blockedTag).map((t) => <Chip key={t}>{t}</Chip>)}
                      </div>
                    </td>
                    <td>
                      <select
                        className={`input input-inline state-${w.stateCategory}`}
                        value={w.state}
                        disabled={saving === w.id}
                        onChange={(e) => update(w, { state: e.target.value }, `${w.id} moved to ${e.target.value}`)}
                        aria-label={`State of ${w.id}`}
                      >
                        {(states.length ? states : [{ name: w.state }]).map((s) => <option key={s.name}>{s.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        className="input input-inline"
                        value={w.assignedTo?.uniqueName || ''}
                        disabled={saving === w.id}
                        onChange={(e) => update(w, { assignedTo: e.target.value }, e.target.value ? `${w.id} assigned` : `${w.id} unassigned`)}
                        aria-label={`Assignee of ${w.id}`}
                      >
                        <option value="">Unassigned</option>
                        {w.assignedTo && !data.people.some((p) => p.uniqueName === w.assignedTo.uniqueName) && (
                          <option value={w.assignedTo.uniqueName}>{w.assignedTo.displayName}</option>
                        )}
                        {data.people.map((p) => <option key={p.id} value={p.uniqueName}>{p.displayName}</option>)}
                      </select>
                    </td>
                    <td className={`num ${w.priority === 1 ? 'text-bad strong' : ''}`}>{w.priority ?? '—'}</td>
                    <td className={`num ${stuck(w) ? 'text-warn' : 'muted'}`}>{age(w.changedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
