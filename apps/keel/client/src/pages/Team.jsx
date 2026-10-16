import { Link } from 'react-router-dom';
import { useApi, useApp } from '../context.js';
import { hours } from '../format.js';
import { Avatar, Empty, ErrorBox, Loading, PageHeader, Th, useSort } from '../ui.jsx';
import { t, tx } from '../i18n.js';

export default function Team() {
  const { data, error, reload } = useApi('/team');
  const { meta } = useApp();
  const th = meta.thresholds;
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
    return <div className="page page-wide"><PageHeader title={t('Team')} /><Empty title={t('No team members found.')}>{t('Pick a team for your projects in Settings.')}</Empty></div>;
  }

  const id = (r) => encodeURIComponent(r.person.id);

  return (
    <div className="page page-wide">
      <PageHeader title={t('Team')} sub={t('Load across tracked projects. Flags trigger above {inProgress} items in progress or {reviews} pending reviews.', { inProgress: th.maxInProgressPerPerson, reviews: th.maxPendingReviewsPerPerson })} />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <Th id="name" sort={sort} setSort={setSort}>{t('Person')}</Th>
              <Th id="inProgress" sort={sort} setSort={setSort} className="num">{t('In progress')}</Th>
              <Th id="open" sort={sort} setSort={setSort} className="num">{t('Open items')}</Th>
              <Th id="points" sort={sort} setSort={setSort} className="num">{t('Sprint pts')}</Th>
              <Th id="hours" sort={sort} setSort={setSort} className="num">{t('Hours left')}</Th>
              <Th id="prs" sort={sort} setSort={setSort} className="num">{t('Open PRs')}</Th>
              <Th id="reviews" sort={sort} setSort={setSort} className="num">{t('Reviews owed')}</Th>
              <Th id="oldest" sort={sort} setSort={setSort} className="num">{t('Oldest PR')}</Th>
              <th>{t('Notes')}</th>
            </tr>
          </thead>
          <tbody>
            {apply(data.rows).map((r) => (
              <tr key={r.person.id} className={r.overloaded ? 'row-flag' : ''}>
                <td><span className="person"><Avatar person={r.person} size={24} /> <span className="strong">{r.person.displayName}</span></span></td>
                <td className={`num ${r.inProgress > th.maxInProgressPerPerson ? 'text-warn strong' : ''}`}>
                  <Link to={`/work?assignee=${id(r)}`}>{r.inProgress}</Link>
                </td>
                <td className="num"><Link to={`/work?assignee=${id(r)}`}>{r.openItems}</Link></td>
                <td className="num">{r.sprintPoints}</td>
                <td className="num">{r.remainingWork}</td>
                <td className="num"><Link to={`/prs?author=${id(r)}`}>{r.prsAuthored}</Link>{r.draftPrs > 0 && <span className="muted small"> {t('({n} draft)', { n: r.draftPrs })}</span>}</td>
                <td className={`num ${r.reviewsPending > th.maxPendingReviewsPerPerson ? 'text-warn strong' : ''}`}>
                  <Link to={`/prs?reviewer=${id(r)}`}>{r.reviewsPending}</Link>
                </td>
                <td className={`num ${r.oldestPrHours >= th.stalePrDays * 24 ? 'text-warn' : 'muted'}`}>{r.prsAuthored ? hours(r.oldestPrHours) : '—'}</td>
                <td className="small">
                  {[
                    r.blocked && t('{n} blocked', { n: r.blocked }),
                    r.bugs && t(r.bugs === 1 ? '{n} bug' : '{n} bugs', { n: r.bugs }),
                    ...r.flags.map(tx),
                  ].filter(Boolean).join(', ') || <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
