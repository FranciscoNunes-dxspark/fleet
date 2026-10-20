import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { hours } from '../format.js';
import { useProjectLabel } from '../orgs.js';
import { Avatar, Confirm, Empty, ErrorBox, Loading, PageHeader, Th, useSort } from '../ui.jsx';
import { t, tx } from '../i18n.js';

/**
 * One group per team you lead, each with its members' rows (membership: their place in that team,
 * to take them out of it). Someone in two teams is in both. People in no team (no team picked in
 * any organization, so they come from pull requests and work items) come last.
 */
function byTeam(rows) {
  const teams = new Map();
  const loose = [];
  for (const r of rows) {
    if (!r.person.teams?.length) loose.push(r);
    for (const tm of r.person.teams || []) {
      const key = `${tm.org || ''}:${tm.projectId}:${tm.teamId}`;
      if (!teams.has(key)) teams.set(key, { key, team: tm, rows: [] });
      teams.get(key).rows.push({ ...r, membership: tm });
    }
  }
  const groups = [...teams.values()].sort((a, b) => a.team.projectName.localeCompare(b.team.projectName) || a.team.teamName.localeCompare(b.team.teamName));
  return loose.length ? [...groups, { key: 'none', team: null, rows: loose }] : groups;
}

export default function Team() {
  const { data, error, reload } = useApi('/team');
  const { meta, can, toast, refresh } = useApp();
  const th = meta.thresholds;
  const projectLabel = useProjectLabel();
  const [busy, setBusy] = useState(null); // the membership being removed
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
    setBusy(team);
    try {
      await api('/team/remove', { method: 'POST', body: { projectId: team.projectId, teamId: team.teamId, memberId: team.memberId } });
      toast(t('{name} was removed from {team}', { name: person.displayName, team: team.teamName }));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
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
      {byTeam(data.rows).map((g) => (
        <section key={g.key}>
          <h2 className="section-title">
            {g.team ? `${projectLabel(g.team.projectName, g.team.org)} · ${g.team.teamName}` : t('Not in a team')}{' '}
            <span className="muted small">{g.rows.length}</span>
          </h2>
          {!g.team && <p className="small muted team-hidden">{t('From who authors pull requests and owns work items. Pick teams in Settings to choose who is here.')}</p>}
          <div className="table-wrap">
            <table className="table team-table">
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
                {apply(g.rows).map((r) => (
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
                    <td className="team-actions">
                      <button type="button" className="link-btn small" onClick={() => setHidden(r.person, true)} title={t('Leave them off your Team page and its overload alerts. Azure DevOps is not changed.')}>{t('Hide')}</button>
                      {canRemove && r.membership && (
                        <Confirm
                          text={t('Remove {name} from {team} in Azure DevOps? This changes its board, sprint capacity and @mentions of the team. To only stop seeing them here, use Hide.', { name: r.person.displayName, team: r.membership.teamName })}
                          onConfirm={() => remove(r.person, r.membership)}
                          className="link-btn small"
                        >
                          {busy === r.membership ? t('Removing…') : t('Remove from team')}
                        </Confirm>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
