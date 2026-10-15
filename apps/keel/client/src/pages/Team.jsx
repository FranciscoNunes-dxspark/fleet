import { Link } from 'react-router-dom';
import { useApi, useApp } from '../context.js';
import { hours } from '../format.js';
import { Avatar, Empty, ErrorBox, Loading, PageHeader, Th, useSort } from '../ui.jsx';

export default function Team() {
  const { data, error, reload } = useApi('/team');
  const { meta } = useApp();
  const t = meta.thresholds;
  const { sort, setSort, apply } = useSort({ key: 'load', dir: -1 }, {
    name: (r) => r.person.displayName.toLowerCase(),
    load: (r) => r.inProgress + r.reviewsPending,
    inProgress: (r) => r.inProgress,
    open: (r) => r.openItems,
    points: (r) => r.sprintPoints,
    hours: (r) => r.remainingWork,
    prs: (r) => r.prsAuthored,
    reviews: (r) => r.reviewsPending,
    oldest: (r) => r.oldestPrHours,
  });

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  if (!data.rows.length) {
    return <div className="page"><PageHeader title="Team" /><Empty title="No team members found.">Pick a team for your projects in Settings.</Empty></div>;
  }

  const id = (r) => encodeURIComponent(r.person.id);

  return (
    <div className="page">
      <PageHeader title="Team" sub={`Load across tracked projects. Flags trigger above ${t.maxInProgressPerPerson} items in progress or ${t.maxPendingReviewsPerPerson} pending reviews.`} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <Th id="name" sort={sort} setSort={setSort}>Person</Th>
              <Th id="inProgress" sort={sort} setSort={setSort} className="num">In progress</Th>
              <Th id="open" sort={sort} setSort={setSort} className="num">Open items</Th>
              <Th id="points" sort={sort} setSort={setSort} className="num">Sprint pts</Th>
              <Th id="hours" sort={sort} setSort={setSort} className="num">Hours left</Th>
              <Th id="prs" sort={sort} setSort={setSort} className="num">Open PRs</Th>
              <Th id="reviews" sort={sort} setSort={setSort} className="num">Reviews owed</Th>
              <Th id="oldest" sort={sort} setSort={setSort} className="num">Oldest PR</Th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {apply(data.rows).map((r) => (
              <tr key={r.person.id} className={r.overloaded ? 'row-flag' : ''}>
                <td><span className="person"><Avatar person={r.person} size={24} /> <span className="strong">{r.person.displayName}</span></span></td>
                <td className={`num ${r.inProgress > t.maxInProgressPerPerson ? 'text-warn strong' : ''}`}>
                  <Link to={`/work?assignee=${id(r)}`}>{r.inProgress}</Link>
                </td>
                <td className="num"><Link to={`/work?assignee=${id(r)}`}>{r.openItems}</Link></td>
                <td className="num">{r.sprintPoints}</td>
                <td className="num">{r.remainingWork}</td>
                <td className="num"><Link to={`/prs?author=${id(r)}`}>{r.prsAuthored}</Link>{r.draftPrs > 0 && <span className="muted small"> ({r.draftPrs} draft)</span>}</td>
                <td className={`num ${r.reviewsPending > t.maxPendingReviewsPerPerson ? 'text-warn strong' : ''}`}>
                  <Link to={`/prs?reviewer=${id(r)}`}>{r.reviewsPending}</Link>
                </td>
                <td className={`num ${r.oldestPrHours >= t.stalePrDays * 24 ? 'text-warn' : 'muted'}`}>{r.prsAuthored ? hours(r.oldestPrHours) : '—'}</td>
                <td className="small">
                  {[r.blocked && `${r.blocked} blocked`, r.bugs && `${r.bugs} bug${r.bugs === 1 ? '' : 's'}`, ...r.flags].filter(Boolean).join(', ') || <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
