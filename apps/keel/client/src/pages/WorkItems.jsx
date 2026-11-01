import { useMemo, useState } from 'react';
import { useSticky, useStickyParams } from '../sticky.js';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, isBlocked, shortIteration } from '../format.js';
import { Chip, Empty, ErrorBox, FilterFold, Loading, PageHeader, sameTarget, SortPick, Th, useMedia, useSort, TypeLabel, WorkTabs } from '../ui.jsx';
import { t } from '../i18n.js';
import { wiActionsPath } from '../orgs.js';
import { useProjectLabel } from '../orgs.js';
import { SavedViews } from '../views.jsx';

const DAY = 86_400_000;

export const CATEGORY_TONE = { Proposed: 'muted', InProgress: 'info', Resolved: 'warn', Completed: 'ok', Removed: 'muted' };

export default function WorkItems() {
  const { data, error, reload } = useApi('/workitems');
  const { meta, openDrawer, drawer, refresh, toast, can } = useApp();
  const editable = can('workitems.write');
  const projectLabel = useProjectLabel();
  const [params, setParams] = useStickyParams('work', ['view', 'assignee']);
  const view = params.get('view') || 'open';
  const assignee = params.get('assignee') || '';
  const [q, setQ] = useState('');
  const [project, setProject] = useSticky('work.project', '');
  const [type, setType] = useSticky('work.type', '');
  const [saving, setSaving] = useState(null);

  const blockedTag = meta.blockedTag.toLowerCase();
  const blocked = (w) => isBlocked(w, meta.blockedTag);
  const inSprint = (w) => data.currentIterationPaths.some((p) => w.iterationPath === p || w.iterationPath.startsWith(`${p}\\`));
  const stuck = (w) => w.stateCategory === 'InProgress' && Date.now() - Date.parse(w.changedAt) >= meta.thresholds.itemStuckDays * DAY;

  const VIEWS = data ? [
    { id: 'open', label: t('All open'), test: () => true },
    { id: 'sprint', label: t('Current sprint'), test: inSprint },
    { id: 'bugs', label: t('Bugs'), test: (w) => w.type === 'Bug' },
    { id: 'blocked', label: t('Blocked'), test: blocked },
    { id: 'stuck', label: t('No update in {n}d', { n: meta.thresholds.itemStuckDays }), test: stuck },
    { id: 'unassigned', label: t('Unassigned'), test: (w) => !w.assignedTo },
    { id: 'mine', label: t('Mine'), test: (w) => w.assignedTo?.id === data.me.id },
  ] : [];

  // Phones: the filters fold behind a button, and the list is cards that keep the state and assignee menus.
  const phone = useMedia('(max-width: 900px)');
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
    next.delete('f'); // a shared link's filters were applied when it opened (views.jsx)
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  // Saved views and shared links (views.jsx).
  const filters = { view: view === 'open' ? '' : view, assignee, project, type, q };
  const applyFilters = (f) => {
    const next = new URLSearchParams(params);
    next.delete('f');
    for (const k of ['view', 'assignee']) {
      if (f[k]) next.set(k, f[k]);
      else next.delete(k);
    }
    setParams(next, { replace: true });
    setProject(f.project || '');
    setType(f.type || '');
    setQ(f.q || '');
  };

  const update = async (w, changes, msg) => {
    setSaving(w.id);
    try {
      await api(wiActionsPath(w.id, w.org), { method: 'POST', body: { type: 'update', changes } });
      toast(msg);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setSaving(null);
    }
  };

  const projects = [...new Map(data.items.map((w) => [w.projectId, projectLabel(w.projectName, w.org)])).entries()];
  const types = [...new Set(data.items.map((w) => w.type))].sort();

  return (
    <div className="page page-wide">
      <PageHeader title={t('Work items')} sub={t(data.items.length === 1 ? '{n} open item across tracked projects' : '{n} open items across tracked projects', { n: data.items.length })}>
        {editable && <button type="button" className="btn btn-small btn-primary" onClick={() => openDrawer({ type: 'newworkitem' })}>{t('New work item')}</button>}
      </PageHeader>
      <WorkTabs />

      <div className="segmented" role="tablist" aria-label={t('Work item views')}>
        {VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={view === v.id ? 'on' : ''} onClick={() => setParam('view', v.id === 'open' ? '' : v.id)}>
            {v.label}<span className="seg-count">{data.items.filter(v.test).length}</span>
          </button>
        ))}
      </div>

      <FilterFold active={[q, project, type, assignee].filter(Boolean).length}>
      <div className="filters">
        {phone && (
          <SortPick
            sort={sort}
            setSort={setSort}
            options={[['priority', t('Priority')], ['changed', t('Updated')], ['state', t('State')], ['title', t('Title')], ['assignee', t('Assigned to')], ['id', 'ID']]}
          />
        )}
        <input type="search" className="input" placeholder={t('Search title, ID, tag, person')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search work items')} />
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('Project')}>
          <option value="">{t('All projects')}</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('Type')}>
          <option value="">{t('All types')}</option>
          {types.map((ty) => <option key={ty}>{ty}</option>)}
        </select>
        <select className="input" value={assignee} onChange={(e) => setParam('assignee', e.target.value)} aria-label={t('Assigned to')}>
          <option value="">{t('Anyone')}</option>
          {data.people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
      </div>
      <SavedViews page="work" filters={filters} apply={applyFilters} />
      </FilterFold>

      {rows.length > 0 && phone ? (
        <ol className="list-cards">
          {apply(rows).map((w) => (
            <WorkCard
              key={w.id} w={w} states={data.states[w.projectId]?.[w.type] || []} people={data.people}
              editable={editable} saving={saving === w.id} blocked={blocked(w)} stuck={stuck(w)} blockedTag={blockedTag}
              open={sameTarget(drawer, { type: 'workitem', id: w.id, org: w.org })}
              onOpen={() => openDrawer({ type: 'workitem', id: w.id, org: w.org })}
              onUpdate={update}
            />
          ))}
        </ol>
      ) : !rows.length ? (
        <Empty title={t('No work items match.')}>{t('Try another view or clear the filters.')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <Th id="id" sort={sort} setSort={setSort} className="num">ID</Th>
                <Th id="title" sort={sort} setSort={setSort}>{t('Title')}</Th>
                <Th id="state" sort={sort} setSort={setSort}>{t('State')}</Th>
                <Th id="assignee" sort={sort} setSort={setSort}>{t('Assigned to')}</Th>
                <Th id="priority" sort={sort} setSort={setSort} className="num">{t('Pri')}</Th>
                <Th id="changed" sort={sort} setSort={setSort} className="num">{t('Updated')}</Th>
              </tr>
            </thead>
            <tbody>
              {apply(rows).map((w) => {
                const states = data.states[w.projectId]?.[w.type] || [];
                return (
                  <tr key={w.id} className={`${saving === w.id ? 'saving' : ''}${sameTarget(drawer, { type: 'workitem', id: w.id, org: w.org }) ? ' row-open' : ''}`}>
                    <td className="num mono muted">{w.id}</td>
                    <td className="cell-title">
                      <button type="button" className="row-link" onClick={() => openDrawer({ type: 'workitem', id: w.id, org: w.org })}>{w.title}</button>
                      <div className="sub">
                        <TypeLabel type={w.type} color={w.typeColor} />
                        <span>{w.projectName}</span>
                        {w.iterationPath !== w.projectName && <span>{shortIteration(w.iterationPath)}</span>}
                        {blocked(w) && <Chip tone="bad">{t('Blocked')}</Chip>}
                        {w.tags.filter((tag) => tag.toLowerCase() !== blockedTag).map((tag) => <Chip key={tag}>{tag}</Chip>)}
                      </div>
                    </td>
                    <td>
                      <select
                        className={`input input-inline state-${w.stateCategory}`}
                        value={w.state}
                        disabled={!editable || saving === w.id}
                        onChange={(e) => update(w, { state: e.target.value }, t('{id} moved to {place}', { id: w.id, place: e.target.value }))}
                        aria-label={t('State of {id}', { id: w.id })}
                      >
                        {(states.length ? states : [{ name: w.state }]).map((s) => <option key={s.name}>{s.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        className="input input-inline"
                        value={w.assignedTo?.uniqueName || ''}
                        disabled={!editable || saving === w.id}
                        onChange={(e) => update(w, { assignedTo: e.target.value }, t(e.target.value ? '{id} assigned' : '{id} unassigned', { id: w.id }))}
                        aria-label={t('Assignee of {id}', { id: w.id })}
                      >
                        <option value="">{t('Unassigned')}</option>
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

/**
 * A work item as a card (phones): its type and number, title, where it sits, and the same state and
 * assignee menus as the table's row, so it can be moved on without opening it.
 */
function WorkCard({ w, states, people, editable, saving, blocked, stuck, blockedTag, open, onOpen, onUpdate }) {
  return (
    <li className={`list-card${blocked ? ' list-card-bad' : ''}${open ? ' list-card-open' : ''}${saving ? ' saving' : ''}`}>
      <button type="button" className="list-card-hit" onClick={onOpen} aria-current={open || undefined}>
        <span className="list-card-top">
          <span className="truncate"><TypeLabel type={w.type} color={w.typeColor} /> <span className="mono">{w.id}</span> · {w.projectName}</span>
          <span className={stuck ? 'text-warn' : ''}>{age(w.changedAt)}</span>
        </span>
        <span className="list-card-title">{w.title}</span>
        {(blocked || w.priority === 1 || w.tags.length > 0) && (
          <span className="chips">
            {w.priority === 1 && <Chip tone="bad">P1</Chip>}
            {blocked && <Chip tone="bad">{t('Blocked')}</Chip>}
            {w.tags.filter((tag) => tag.toLowerCase() !== blockedTag).slice(0, 3).map((tag) => <Chip key={tag}>{tag}</Chip>)}
          </span>
        )}
      </button>
      <div className="list-card-edit">
        <select
          className={`input input-inline state-${w.stateCategory}`}
          value={w.state}
          disabled={!editable || saving}
          onChange={(e) => onUpdate(w, { state: e.target.value }, t('{id} moved to {place}', { id: w.id, place: e.target.value }))}
          aria-label={t('State of {id}', { id: w.id })}
        >
          {(states.length ? states : [{ name: w.state }]).map((s) => <option key={s.name}>{s.name}</option>)}
        </select>
        <select
          className="input input-inline"
          value={w.assignedTo?.uniqueName || ''}
          disabled={!editable || saving}
          onChange={(e) => onUpdate(w, { assignedTo: e.target.value }, t(e.target.value ? '{id} assigned' : '{id} unassigned', { id: w.id }))}
          aria-label={t('Assignee of {id}', { id: w.id })}
        >
          <option value="">{t('Unassigned')}</option>
          {w.assignedTo && !people.some((p) => p.uniqueName === w.assignedTo.uniqueName) && <option value={w.assignedTo.uniqueName}>{w.assignedTo.displayName}</option>}
          {people.map((p) => <option key={p.id} value={p.uniqueName}>{p.displayName}</option>)}
        </select>
      </div>
    </li>
  );
}
