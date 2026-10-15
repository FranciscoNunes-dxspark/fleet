import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, isBlocked } from '../format.js';
import { Avatar, Chip, Empty, ErrorBox, Loading, PageHeader, Toggle } from '../ui.jsx';

// Used only when a team has no board configuration we can read.
const CATEGORY_COLUMNS = [
  { id: 'Proposed', label: 'Not started' },
  { id: 'InProgress', label: 'In progress' },
  { id: 'Resolved', label: 'Resolved' },
  { id: 'Completed', label: 'Done' },
];
const DAY = 86_400_000;
const DONE_CAP = 20;
const fullDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

/**
 * Column model shared by both layouts:
 *  key, label, limit, split, outgoing,
 *  holds(w)      → does this card sit here?
 *  accepts(w)    → may this card be dropped here?
 *  changesFor(w) → the work item update a drop makes
 */
function columnsFor(data, taskTypes) {
  const isTask = (w) => taskTypes.includes(w.type);
  if (data.board) {
    const { board } = data;
    const f = board.fields;
    return board.columns.map((c) => ({
      key: c.name,
      label: c.name,
      limit: c.itemLimit,
      split: c.isSplit,
      outgoing: c.columnType === 'outgoing',
      holds: (w) => !isTask(w) && w.board?.column === c.name,
      accepts: (w) => !!c.stateMappings[w.type] && w.board?.column !== c.name,
      changesFor: (w, lane) => {
        const fields = { [f.column]: c.name };
        if (f.done) fields[f.done] = false;
        if (f.lane && lane !== undefined) fields[f.lane] = lane || '';
        const state = c.stateMappings[w.type];
        return { ...(state && state !== w.state ? { state } : {}), fields };
      },
      optimistic: (w, lane) => ({ state: c.stateMappings[w.type] || w.state, board: { column: c.name, done: false, lane: lane === undefined ? w.board?.lane : lane } }),
    }));
  }
  return CATEGORY_COLUMNS.map((c) => {
    const target = (w) => (data.states[w.type] || []).find((s) => s.category === c.id);
    return {
      key: c.id,
      label: c.label,
      limit: 0,
      split: false,
      outgoing: c.id === 'Completed',
      holds: (w) => w.stateCategory === c.id,
      accepts: (w) => w.stateCategory !== c.id && !!target(w),
      changesFor: (w) => ({ state: target(w).name }),
      optimistic: (w) => ({ state: target(w).name, stateCategory: c.id }),
    };
  });
}

export default function Board() {
  const [params, setParams] = useSearchParams();
  const project = params.get('project') || '';
  const team = params.get('team') || '';
  const boardParam = params.get('board') || '';
  const mode = params.get('mode') === 'sprint' ? 'sprint' : 'open';
  const doneDays = Number(params.get('done')) || 14;
  const query = new URLSearchParams({ ...(project && { project }), ...(team && { team }), ...(boardParam && { board: boardParam }), mode, doneDays }).toString();
  const { data, error, reload } = useApi(`/board?${query}`);
  const { openDrawer, meta, toast, refresh, can } = useApp();
  const movable = can('workitems.write');

  const [showAllDone, setShowAllDone] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [q, setQ] = useState('');
  const [assignee, setAssignee] = useState('');
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null); // "lane|column"
  // Optimistic state while an update is in flight.
  const [moved, setMoved] = useState({});

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const items = useMemo(() => (data?.items || []).map((w) => (moved[w.id] ? { ...w, ...moved[w.id], board: { ...w.board, ...moved[w.id].board } } : w)), [data, moved]);

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  if (!data.project) {
    return (
      <div className="page">
        <PageHeader title="Board" />
        <Empty title="No team selected for any tracked project.">Pick one or more teams for a project in Settings to see their board.</Empty>
      </div>
    );
  }

  const taskTypes = data.taskTypes || ['Task'];
  const isTask = (w) => taskTypes.includes(w.type);
  const configured = !!data.board;
  const columns = columnsFor(data, taskTypes);
  const lanes = configured && data.board.lanes.length > 1 ? data.board.lanes : [{ id: 'all', name: null, all: true }];
  const laneOf = (w) => (lanes.some((l) => l.name && l.name === w.board?.lane) ? w.board.lane : null);

  const { iteration } = data;
  const live = iteration?.status === 'live';
  const blocked = (w) => isBlocked(w, meta.blockedTag);
  const tasks = items.filter(isTask);
  const needle = q.trim().toLowerCase();
  const cardsSource = items.filter((w) => ((!configured && showTasks) || !isTask(w))
    && (!assignee || (assignee === 'none' ? !w.assignedTo : w.assignedTo?.id === assignee))
    && (!needle || `${w.id} ${w.title} ${w.tags.join(' ')} ${w.assignedTo?.displayName || ''}`.toLowerCase().includes(needle)));
  const points = (list) => list.reduce((s, w) => s + (!isTask(w) ? Number(w.storyPoints) || 0 : 0), 0);
  const people = [...new Map(items.filter((w) => w.assignedTo).map((w) => [w.assignedTo.id, w.assignedTo])).values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const update = async (w, changes, optimistic, message) => {
    setMoved((m) => ({ ...m, [w.id]: optimistic }));
    try {
      await api(`/workitems/${w.id}/actions`, { method: 'POST', body: { type: 'update', changes } });
      toast(message);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setTimeout(() => setMoved((m) => {
        const { [w.id]: _, ...rest } = m;
        return rest;
      }), 4000);
    }
  };

  const drop = (col, lane) => {
    const w = dragging;
    setDragging(null);
    setOver(null);
    if (!w) return;
    const laneChanged = lanes.length > 1 && laneOf(w) !== lane.name;
    if (!col.accepts(w) && !laneChanged) return;
    if (!col.accepts(w) && w.board?.column !== col.key) {
      toast(`${w.type} items can't go in "${col.label}" on this board`, 'bad');
      return;
    }
    const laneArg = lanes.length > 1 ? lane.name : undefined;
    if (!col.accepts(w) && laneChanged) {
      // Same column, different lane: only the lane changes (Doing/Done is kept).
      update(w, { fields: { [data.board.fields.lane]: lane.name || '' } }, { board: { ...w.board, lane: lane.name } }, `${w.id} moved to ${lane.name || 'the default lane'}`);
      return;
    }
    update(w, col.changesFor(w, laneArg), col.optimistic(w, laneArg), `${w.id} moved to ${col.label}${laneChanged && lane.name ? ` · ${lane.name}` : ''}`);
  };

  const toggleDone = (w) => {
    const f = data.board.fields;
    const done = !w.board?.done;
    update(w, { fields: { [f.done]: done } }, { board: { ...w.board, done } }, `${w.id} marked ${done ? 'done' : 'doing'} in ${w.board.column}`);
  };

  // Sprint timing (only meaningful for a live sprint).
  let timePct = null;
  let daysLeft = null;
  if (live) {
    const start = Date.parse(iteration.startDate);
    const end = Date.parse(iteration.finishDate) + DAY;
    timePct = Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
    daysLeft = Math.max(0, Math.ceil((end - Date.now()) / DAY));
  }
  const backlog = items.filter((w) => !isTask(w));
  const donePts = points(backlog.filter((w) => w.stateCategory === 'Completed'));
  const totalPts = points(backlog);
  const workPct = totalPts ? donePts / totalPts : 0;

  let scopeText = `All open work, plus anything finished in the last ${doneDays} days`;
  if (mode === 'sprint') {
    scopeText = !iteration ? 'no current sprint'
      : live ? `${iteration.name} · ${fullDate(iteration.startDate)} – ${fullDate(iteration.finishDate)} · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
        : iteration.name;
  }
  const shownColumns = columns.filter((c) => configured || c.key !== 'Resolved' || cardsSource.some((w) => w.stateCategory === 'Resolved'));

  return (
    <div className="page page-wide">
      <PageHeader title="Board" sub={`${data.project.name} · ${data.project.teamName} · ${scopeText}`}>
        {data.options.length > 1 && (
          <select
            className="input"
            value={`${data.project.id}|${data.project.teamId}`}
            onChange={(e) => {
              const [p, t] = e.target.value.split('|');
              const next = new URLSearchParams(params);
              next.set('project', p);
              next.set('team', t);
              next.delete('board');
              setParams(next, { replace: true });
            }}
            aria-label="Project and team"
          >
            {[...new Set(data.options.map((o) => o.projectName))].map((name) => (
              <optgroup key={name} label={name}>
                {data.options.filter((o) => o.projectName === name).map((o) => (
                  <option key={o.teamId} value={`${o.projectId}|${o.teamId}`}>{o.teamName}</option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </PageHeader>

      {data.boards?.length > 1 && (
        <div className="segmented" role="tablist" aria-label="Board">
          {data.boards.map((b) => (
            <button key={b.id} type="button" role="tab" aria-selected={data.board?.id === b.id} className={data.board?.id === b.id ? 'on' : ''} onClick={() => setParam('board', b.id)} title={b.types.join(', ')}>
              {b.name}
            </button>
          ))}
        </div>
      )}

      <div className="filters">
        <div className="segmented segmented-compact" role="tablist" aria-label="Board scope">
          <button type="button" role="tab" aria-selected={mode === 'open'} className={mode === 'open' ? 'on' : ''} onClick={() => setParam('mode', '')}>Open work</button>
          <button type="button" role="tab" aria-selected={mode === 'sprint'} className={mode === 'sprint' ? 'on' : ''} onClick={() => setParam('mode', 'sprint')}>Current sprint</button>
        </div>
        {mode === 'open' && (
          <select className="input" value={doneDays} onChange={(e) => setParam('done', e.target.value === '14' ? '' : e.target.value)} aria-label="Show done from the last">
            {[7, 14, 30].map((d) => <option key={d} value={d}>Done in last {d} days</option>)}
          </select>
        )}
        <input type="search" className="input" placeholder="Search cards" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search cards" />
        <select className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assigned to">
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
        {!configured && <Toggle checked={showTasks} onChange={setShowTasks} count={tasks.length}>Show tasks as cards</Toggle>}
      </div>

      {mode === 'sprint' && iteration && !live && (
        <p className="callout">
          {iteration.status === 'undated'
            ? `${iteration.name} has no start or finish date, so it can't be tracked as a sprint.`
            : iteration.status === 'future'
              ? `${iteration.name} hasn't started yet.`
              : `This sprint ended on ${fullDate(iteration.finishDate)}. Azure DevOps still reports it as current because ${data.project.teamName} has no iteration covering today.`}
          {' '}Use <button type="button" className="link-btn" onClick={() => setParam('mode', '')}>Open work</button> to see the team&apos;s board regardless of sprint.
        </p>
      )}

      {mode === 'sprint' && live && (
        <div className="sprint-progress">
          <div className="meter-block">
            <div className="meter-label"><span>Points done</span><strong>{donePts} of {totalPts}</strong></div>
            <div className="meter" role="meter" aria-valuenow={Math.round(workPct * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Points done">
              <div className={`meter-fill ${workPct + 0.15 < timePct ? 'meter-warn' : ''}`} style={{ width: `${workPct * 100}%` }} />
              <div className="meter-time" style={{ left: `${timePct * 100}%` }} title={`${Math.round(timePct * 100)}% of the sprint has elapsed`} />
            </div>
            <div className="meter-legend muted small">The tick marks how much of the sprint has elapsed.</div>
          </div>
          <div className="sprint-facts">
            <div><span className="muted">Remaining task hours</span><strong>{tasks.reduce((s, w) => s + (w.stateCategory === 'Completed' ? 0 : Number(w.remainingWork) || 0), 0)}</strong></div>
            <div><span className="muted">Blocked</span><strong className={items.some(blocked) ? 'text-bad' : ''}>{items.filter(blocked).length}</strong></div>
          </div>
        </div>
      )}

      {/* Column headers once, then one row of columns per swimlane. */}
      <div className="kanban" style={{ '--cols': shownColumns.length }}>
        <div className="kanban-head">
          {shownColumns.map((col) => {
            const inCol = cardsSource.filter(col.holds);
            const doing = col.split ? inCol.filter((w) => !w.board?.done).length : inCol.length;
            const over = col.limit && !col.outgoing && doing > col.limit;
            return (
              <div key={col.key} className={`column-title kanban-title ${over ? 'wip-over' : ''}`} title={col.limit ? `WIP limit ${col.limit}${col.split ? ' (counts "Doing")' : ''}` : undefined}>
                <span>{col.label}</span>
                <span className="muted">
                  {col.limit && !col.outgoing ? `${doing}/${col.limit}` : inCol.length}
                  {points(inCol) ? ` · ${points(inCol)} pts` : ''}
                </span>
              </div>
            );
          })}
        </div>
        {lanes.map((lane) => {
          const inLane = lane.all ? cardsSource : cardsSource.filter((w) => laneOf(w) === lane.name);
          return (
            <section key={lane.id} className="kanban-lane" aria-label={lane.all ? 'Board' : lane.name || 'Default lane'}>
              {!lane.all && <h3 className="lane-title">{lane.name || 'Default lane'} <span className="muted small">{inLane.length}</span></h3>}
              <div className="kanban-row">
                {shownColumns.map((col) => {
                  const cards = inLane.filter(col.holds);
                  const capped = col.outgoing && !showAllDone && cards.length > DONE_CAP;
                  const cellKey = `${lane.id}|${col.key}`;
                  const laneChange = dragging && lanes.length > 1 && laneOf(dragging) !== lane.name;
                  const canDrop = dragging && (col.accepts(dragging) || (laneChange && dragging.board?.column === col.key));
                  return (
                    <div
                      key={col.key}
                      className={`column ${over === cellKey && canDrop ? 'column-over' : ''} ${dragging && !canDrop && !col.holds(dragging) ? 'column-nodrop' : ''}`}
                      onDragOver={(e) => { if (canDrop) { e.preventDefault(); setOver(cellKey); } }}
                      onDragLeave={() => setOver((c) => (c === cellKey ? null : c))}
                      onDrop={(e) => { e.preventDefault(); drop(col, lane); }}
                    >
                      {(capped ? cards.slice(0, DONE_CAP) : cards).map((w) => (
                        <Card
                          key={w.id}
                          w={w}
                          kids={tasks.filter((t) => t.parentId === w.id)}
                          isTask={isTask}
                          blocked={blocked(w)}
                          moving={!!moved[w.id]}
                          split={col.split}
                          onToggleDone={col.split && movable ? () => toggleDone(w) : null}
                          onOpen={() => openDrawer({ type: 'workitem', id: w.id })}
                          draggable={movable}
                          onDragStart={() => setDragging(w)}
                          onDragEnd={() => { setDragging(null); setOver(null); }}
                        />
                      ))}
                      {!cards.length && <p className="muted small column-empty">{dragging && canDrop ? 'Drop here' : ''}</p>}
                      {capped && (
                        <button type="button" className="btn btn-ghost btn-small" onClick={() => setShowAllDone(true)}>
                          Show {cards.length - DONE_CAP} more
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <p className="muted small">
        {configured
          ? `Columns, WIP limits and lanes come from the ${data.board.name} board in Azure DevOps. Dragging a card sets its board column and the state that column maps to.`
          : 'This team\'s board configuration couldn\'t be read, so cards are grouped by state. Dragging a card changes its state.'}
      </p>

      <h2 className="section-title">Who has what</h2>
      <PeopleTable items={items} meta={meta} isTask={isTask} />
    </div>
  );
}

function Card({ w, kids, isTask, blocked, moving, split, onToggleDone, onOpen, onDragStart, onDragEnd, draggable = true }) {
  const kidsDone = kids.filter((t) => t.stateCategory === 'Completed').length;
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      className={`card ${blocked ? 'card-blocked' : ''} ${moving ? 'card-moving' : ''} ${split && w.board?.done ? 'card-split-done' : ''}`}
    >
      <div className="card-top">
        <span className={`type type-${w.type.replace(/\s+/g, '-').toLowerCase()}`}>{w.type}</span>
        <span className="mono muted small">{w.id}</span>
      </div>
      <div className="card-title">{w.title}</div>
      <div className="card-foot">
        <Avatar person={w.assignedTo} size={20} />
        <span className="muted small">{w.state}</span>
        {w.storyPoints != null && !isTask(w) && <Chip>{w.storyPoints} pts</Chip>}
        {isTask(w) && w.remainingWork ? <Chip>{w.remainingWork}h</Chip> : null}
        {kids.length > 0 && <span className="muted small">{kidsDone}/{kids.length} tasks</span>}
        {blocked && <Chip tone="bad">Blocked</Chip>}
        {w.stateCategory === 'InProgress' && <span className="muted small" title="Time in this state">{age(w.stateChangedAt)}</span>}
        {split && onToggleDone && (
          <button
            type="button"
            className={`split-toggle ${w.board?.done ? 'on' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleDone(); }}
            title={w.board?.done ? 'Move back to Doing' : 'Mark as Done in this column'}
          >
            {w.board?.done ? 'Done ✓' : 'Doing'}
          </button>
        )}
      </div>
    </div>
  );
}

function PeopleTable({ items, meta, isTask }) {
  const byPerson = new Map();
  for (const w of items) {
    const key = w.assignedTo?.id || 'none';
    if (!byPerson.has(key)) byPerson.set(key, { person: w.assignedTo, open: 0, inProgress: 0, points: 0, remaining: 0, done: 0 });
    const row = byPerson.get(key);
    if (w.stateCategory === 'Completed') row.done++;
    else {
      row.open++;
      if (w.stateCategory === 'InProgress') row.inProgress++;
      if (!isTask(w)) row.points += Number(w.storyPoints) || 0;
      row.remaining += Number(w.remainingWork) || 0;
    }
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Person</th><th className="num">Open</th><th className="num">In progress</th><th className="num">Open pts</th><th className="num">Hours left</th><th className="num">Done</th></tr></thead>
        <tbody>
          {[...byPerson.values()].sort((a, b) => b.open - a.open).map((r) => (
            <tr key={r.person?.id || 'none'}>
              <td><span className="person"><Avatar person={r.person} size={20} /> {r.person?.displayName || <span className="text-warn">Unassigned</span>}</span></td>
              <td className="num">{r.open}</td>
              <td className={`num ${r.inProgress > meta.thresholds.maxInProgressPerPerson ? 'text-warn strong' : ''}`}>{r.inProgress}</td>
              <td className="num">{r.points}</td>
              <td className="num">{r.remaining}</td>
              <td className="num muted">{r.done}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
