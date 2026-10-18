import { AgingChart, BarList, ColumnChart } from '../charts.jsx';
import { useApi, useApp } from '../context.js';
import { date, hours } from '../format.js';
import { Chip, ErrorBox, Loading, TypeLabel } from '../ui.jsx';
import { t, tx } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';

const perWeek = (n) => (n == null ? '—' : n >= 10 ? Math.round(n).toString() : n.toFixed(1));
const points = (n) => (Number.isInteger(n) ? n : n.toFixed(1));

/**
 * Work item flow for the Insights page: how long backlog items and bugs take
 * from started to finished (cycle time), how many finish a week, which work in
 * progress is getting old, and how each team's sprint changed since it began.
 */
export default function Flow({ days }) {
  const { openDrawer } = useApp();
  const { data, error, reload, loading } = useApi(`/flow?days=${days}`);
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const tot = data.totals;
  const open = (w) => openDrawer({ type: 'workitem', id: w.id, org: w.org });
  const facts = [
    [t('Finished'), tot.finished, t('{n} a week', { n: perWeek(tot.perWeek) })],
    [t('Cycle time'), hours(tot.medianCycleHours), t('median, from started to finished')],
    [t('85th percentile'), hours(tot.p85CycleHours), t('85% of items finish within this')],
    [t('In progress now'), tot.wip, tot.wipOverP85 ? t('{n} older than the 85th percentile', { n: tot.wipOverP85 }) : t('none older than the 85th percentile')],
  ];
  const old = data.aging.filter((a) => a.overMedian).slice(0, 12);

  return (
    <section aria-busy={loading}>
      <p className="muted small delivery-intro">{t('Backlog items and bugs (not tasks): how long they take once someone starts them, and which ones in progress are taking longer than usual.')}</p>
      <dl className="fact-row">
        {facts.map(([k, v, note]) => (
          <div key={k} className="fact">
            <dt>{k}</dt>
            <dd>{v}</dd>
            <dd className="muted small">{note}</dd>
          </div>
        ))}
      </dl>
      {tot.estimated > 0 && (
        <p className="callout">{t(tot.estimated === 1 ? "{n} finished item has no Activated Date, so its time counts from when it was created." : "{n} finished items have no Activated Date, so their time counts from when they were created.", { n: tot.estimated })}</p>
      )}

      <div className="chart-grid">
        <AgingChart
          label={t('Aging work in progress (days since started)')}
          items={data.aging}
          states={data.states}
          p50={tot.medianCycleHours}
          p85={tot.p85CycleHours}
          onOpen={open}
        />
        <ColumnChart
          label={t('Items finished per week')}
          valueLabel={t('finished')}
          data={data.weekly.map((w) => ({ key: w.week, value: w.finished, note: w.medianCycleHours != null ? t('median {time}', { time: hours(w.medianCycleHours) }) : null }))}
          formatX={(k) => t('Wk of {date}', { date: date(k) })}
        />
        <BarList
          label={t('Cycle time')}
          valueLabel={t('items')}
          data={data.distribution.map((b) => ({ key: b.label, label: t(b.label), value: b.count }))}
        />
        <BarList
          label={t('By type')}
          valueLabel={t('finished')}
          data={data.byType.map((r) => ({ key: r.type, label: r.type, value: r.count, note: t('median {time}', { time: hours(r.medianCycleHours) }) }))}
        />
      </div>

      <h2 className="section-title">{t('Taking longer than usual')}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('Work item')}</th><th>{t('State')}</th><th>{t('Assigned to')}</th><th className="num">{t('In progress for')}</th></tr></thead>
          <tbody>
            {old.map((w) => (
              <tr key={`${w.org || ''}:${w.id}`}>
                <td>
                  <button type="button" className="link-btn strong" onClick={() => open(w)}>{w.title}</button>
                  <div className="sub small muted"><TypeLabel type={w.type} color={w.typeColor} /> #{w.id} · {w.projectName}</div>
                </td>
                <td>{w.state}</td>
                <td>{w.assignedTo || <span className="muted">{t('Unassigned')}</span>}</td>
                <td className={`num ${w.overP85 ? 'text-bad strong' : 'text-warn'}`}>{hours(w.ageHours)}</td>
              </tr>
            ))}
            {!old.length && <tr><td colSpan={4} className="muted">{t('Nothing in progress is older than the median cycle time.')}</td></tr>}
          </tbody>
        </table>
      </div>

      <Sprints />
    </section>
  );
}

/** Each team's live sprint: committed scope against what it holds now. */
function Sprints() {
  const { data, error, reload } = useApi('/sprints');
  return (
    <>
      <h2 className="section-title">{t('Sprint scope')}</h2>
      <p className="muted small delivery-intro">{t('What each team planned (its sprint at the end of the first day), what was added or taken out since, and what came over unfinished from the sprint before.')}</p>
      {!data ? (error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />)
        : !data.sprints.length ? <p className="muted small">{t('No team has a sprint running today. Pick your teams in Settings, and give their sprints dates in Azure DevOps.')}</p>
          : <div className="sprint-grid">{data.sprints.map((s) => <SprintCard key={`${s.org || ''}:${s.project.id}:${s.team.id}`} s={s} />)}</div>}
    </>
  );
}

function SprintCard({ s }) {
  const { openDrawer } = useApp();
  const projectLabel = useProjectLabel();
  const head = (
    <header className="monitor-head">
      <div>
        <h3>{s.team.name} · {s.iteration.name}</h3>
        <div className="small muted">{projectLabel(s.project.name, s.org)}{s.iteration.day ? ` · ${t('day {day} of {days}', { day: s.iteration.day, days: s.iteration.days })}` : ''}</div>
      </div>
    </header>
  );
  if (s.error) return <section className="panel sprint-card">{head}<p className="callout callout-bad">{tx(s.error)}</p></section>;

  const change = s.added.length - s.removed.length;
  const pointsChange = s.current.points - s.committed.points;
  const donePct = s.current.points ? s.completed.points / s.current.points : s.current.count ? s.completed.count / s.current.count : 0;
  const timePct = s.iteration.days ? s.iteration.day / s.iteration.days : null;
  const list = (title, items, tone) => items.length > 0 && (
    <div className="sprint-list">
      <h4 className="small">{title} <Chip tone={tone}>{items.length}</Chip></h4>
      <ul className="mini-list">
        {items.map((w) => (
          <li key={w.id}>
            <button type="button" className="link-btn mini-title" onClick={() => openDrawer({ type: 'workitem', id: w.id, org: w.org })}>{w.title}</button>
            <span className="muted small truncate">{w.type} #{w.id} · {w.state}{w.storyPoints != null ? ` · ${t('{n} pts', { n: w.storyPoints })}` : ''}{w.assignedTo ? ` · ${w.assignedTo}` : ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <section className="panel sprint-card" aria-label={`${s.team.name} ${s.iteration.name}`}>
      {head}
      <dl className="fact-row monitor-facts">
        <div className="fact"><dt>{t('Planned')}</dt><dd>{s.committed.count}</dd><dd className="muted small">{t('{n} pts', { n: points(s.committed.points) })}</dd></div>
        <div className="fact"><dt>{t('Now')}</dt><dd>{s.current.count}</dd><dd className="muted small">{t('{n} pts', { n: points(s.current.points) })}</dd></div>
        <div className="fact">
          <dt>{t('Scope change')}</dt>
          <dd className={change > 0 || pointsChange > 0 ? 'text-warn' : ''}>{change > 0 ? `+${change}` : change}</dd>
          <dd className="muted small">{t('{n} pts', { n: `${pointsChange > 0 ? '+' : ''}${points(pointsChange)}` })}</dd>
        </div>
        <div className="fact"><dt>{t('Done')}</dt><dd>{s.completed.count}</dd><dd className="muted small">{t('{n} pts', { n: points(s.completed.points) })}</dd></div>
      </dl>
      <div className="scope-progress" title={t('{done} of the work done, {time} of the time gone', { done: `${Math.round(donePct * 100)}%`, time: timePct == null ? '—' : `${Math.round(timePct * 100)}%` })}>
        <span className="progress-bar scope-bar" aria-hidden="true"><span className="progress-done" style={{ width: `${donePct * 100}%` }} /></span>
        {timePct != null && <span className="scope-time" style={{ left: `${timePct * 100}%` }} aria-hidden="true" />}
        <span className="small muted">{t('{done} done · {time} of the sprint gone', { done: `${Math.round(donePct * 100)}%`, time: timePct == null ? '—' : `${Math.round(timePct * 100)}%` })}</span>
      </div>
      <div className="sprint-lists">
        {list(t('Added after planning'), s.added, 'warn')}
        {list(t('Taken out'), s.removed, 'muted')}
        {list(s.previous ? t('Carried over from {sprint}', { sprint: s.previous.name }) : t('Carried over'), s.carriedOver, 'info')}
      </div>
      {!s.added.length && !s.removed.length && !s.carriedOver.length && <p className="muted small">{t('No changes since planning.')}</p>}
    </section>
  );
}
