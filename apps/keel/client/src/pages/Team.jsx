import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { hours } from '../format.js';
import { Avatar, Confirm, Empty, ErrorBox, Loading, PageHeader, Th, useSort } from '../ui.jsx';
import { t, tx } from '../i18n.js';

/** Which of their teams to take them out of, in Azure DevOps. */
function RemoveRow({ person, busy, onRemove, onCancel }) {
  const [pick, setPick] = useState(0);
  const teams = person.teams;
  const team = teams[pick] || teams[0];
  const label = (tm) => `${tm.projectName} · ${tm.teamName}`;
  return (
    <tr className="team-remove-row">
      <td colSpan={10}>
        <div className="team-remove">
          <span>{t('Remove {name} from', { name: person.displayName })}</span>
          {teams.length > 1
            ? <select className="input" value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label={t('Team')}>{teams.map((tm, i) => <option key={`${tm.projectId}:${tm.teamId}`} value={i}>{label(tm)}</option>)}</select>
            : <strong>{label(team)}</strong>}
          <Confirm text={t('Remove {name} from {team} in Azure DevOps?', { name: person.displayName, team: team.teamName })} onConfirm={() => onRemove(person, team)} className="btn btn-small btn-danger">{busy ? t('Removing…') : t('Remove from team')}</Confirm>
          <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>{t('Cancel')}</button>
        </div>
        <p className="small muted">{t("This changes the team in Azure DevOps: its board, sprint capacity and @mentions of the team. It needs your token's Graph (Read & manage) scope and admin rights on the team or project. To only stop seeing them here, use Hide.")}</p>
      </td>
    </tr>
  );
}

export default function Team() {
  const { data, error, reload } = useApi('/team');
  const { meta, can, toast, refresh } = useApp();
  const th = meta.thresholds;
  const [removing, setRemoving] = useState(null); // person id whose "Remove from team" is open
  const [busy, setBusy] = useState(false);
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

  // Hiding is yours only: Azure DevOps doesn't change. Removing changes the team in Azure DevOps.
  const setHidden = async (person, hidden) => {
    try {
      await api('/team/hidden', { method: 'POST', body: { person, hidden } });
      toast(hidden ? t('{name} is hidden from your Team page', { name: person.displayName }) : t('{name} is back on your Team page', { name: person.displayName }));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const remove = async (person, team) => {
    setBusy(true);
    try {
      await api('/team/remove', { method: 'POST', body: { projectId: team.projectId, teamId: team.teamId, memberId: team.memberId } });
      toast(t('{name} was removed from {team}', { name: person.displayName, team: team.teamName }));
      setRemoving(null);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const hiddenNote = data.hidden?.length > 0 && (
    <p className="small muted team-hidden">
      {t('Hidden from this page:')}{' '}
      {data.hidden.map((p, i) => (
        <span key={p.id}>{i > 0 && ', '}{p.displayName} <button type="button" className="link-btn" onClick={() => setHidden(p, false)}>{t('Show')}</button></span>
      ))}
    </p>
  );

  if (!data.rows.length) {
    return (
      <div className="page page-wide">
        <PageHeader title={t('Team')} />
        {hiddenNote}
        <Empty title={t('No team members found.')}>{t('Pick a team for your projects in Settings.')}</Empty>
      </div>
    );
  }

  const id = (r) => encodeURIComponent(r.person.id);
  const canRemove = can('team.manage');

  return (
    <div className="page page-wide">
      <PageHeader title={t('Team')} sub={t('Load across tracked projects. Flags trigger above {inProgress} items in progress or {reviews} pending reviews.', { inProgress: th.maxInProgressPerPerson, reviews: th.maxPendingReviewsPerPerson })} />
      {hiddenNote}
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
              <th><span className="sr-only">{t('Actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {apply(data.rows).map((r) => (
              <Fragment key={r.person.id}>
              <tr className={r.overloaded ? 'row-flag' : ''}>
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
                <td className="team-actions">
                  <button type="button" className="link-btn small" onClick={() => setHidden(r.person, true)} title={t('Leave them off your Team page and its overload alerts. Azure DevOps is not changed.')}>{t('Hide')}</button>
                  {canRemove && r.person.teams?.length > 0 && (
                    <button type="button" className="link-btn small" aria-expanded={removing === r.person.id} onClick={() => setRemoving(removing === r.person.id ? null : r.person.id)}>{t('Remove from team…')}</button>
                  )}
                </td>
              </tr>
              {removing === r.person.id && <RemoveRow person={r.person} busy={busy} onRemove={remove} onCancel={() => setRemoving(null)} />}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
