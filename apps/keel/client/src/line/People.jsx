// The Line, person by person (Team → On the line): a row each, a cell per stage with what they
// hold there and how much of it is stuck, and the reviews waiting on them. A cell opens its
// cards under the table. Where one person holds most of a jammed stage is where to help.
import { useMemo, useState } from 'react';
import { useApi, useApp } from '../context.js';
import { Avatar, Loading, PageHeader, TeamTabs, useMedia, useTypeColor } from '../ui.jsx';
import { t } from '../i18n.js';
import { STAGES } from './stages.js';
import { stageName } from './names.js';
import { peopleLine, samePerson } from './people.js';
import { useLine } from './LineShell.jsx';
import { Card, useOpenCard } from './Line.jsx';
import { Select } from '../ui.jsx';

export default function People() {
  const { stages, loading } = useLine();
  const { drawer } = useApp();
  const team = useApi('/team');
  const open = useOpenCard();
  const typeColor = useTypeColor();
  const [teamKey, setTeamKey] = useState('');
  const [picked, setPicked] = useState(null); // { key, stage } or { key, stage: 'reviews' }
  // A phone has no room for the table: a card per person, with the same cells as buttons.
  const phone = useMedia('(max-width: 900px)');

  // Teams from the Team page's people, to look at one team's slice.
  const members = team.data?.rows?.map((r) => r.person) || [];
  const teams = useMemo(() => {
    const all = new Map();
    for (const p of members) for (const m of p.teams || []) all.set(`${m.projectId}:${m.teamId}`, `${m.teamName} · ${m.projectName}`);
    return [...all.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [members]);
  const inTeam = (person) => !teamKey || members.some((m) => samePerson(m, person) && (m.teams || []).some((x) => `${x.projectId}:${x.teamId}` === teamKey));

  const rows = useMemo(() => peopleLine(stages), [stages]).filter((r) => (r.person ? inTeam(r.person) : !teamKey));
  const max = Math.max(1, ...rows.flatMap((r) => STAGES.map((id) => r.stages[id].cards.length)));
  const pickedRow = picked && rows.find((r) => r.key === picked.key);
  const pickedCards = pickedRow ? (picked.stage === 'reviews' ? pickedRow.reviews : pickedRow.stages[picked.stage].cards) : [];

  if (loading && !stages.some((s) => s.count)) return <Loading />;

  return (
    <div className="page page-wide people-page">
      <PageHeader title={t('Team')} sub={t('What each person holds on the Line, and how much of it is stuck.')}>
        {teams.length > 1 && (
          <Select className="input" value={teamKey} onChange={(e) => setTeamKey(e.target.value)} aria-label={t('Team')}>
            <option value="">{t('All teams')}</option>
            {teams.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
          </Select>
        )}
      </PageHeader>
      <TeamTabs />

      {phone && (
        <ol className="people-cards-list">
          {rows.map((r) => (
            <li key={r.key || 'nobody'} className={`person-card${r.stuck ? ' has-stuck' : ''}`}>
              <div className="person-card-head">
                <Avatar person={r.person} size={28} />
                <strong className="truncate">{r.person?.displayName || t('Nobody')}</strong>
                {r.stuck > 0 && <span className="person-card-stuck">{t(r.stuck === 1 ? '1 stuck' : '{n} stuck', { n: r.stuck })}</span>}
              </div>
              <div className="person-card-cells">
                {[...['planned', 'building', 'review'].map((id) => [id, stageName(id), r.stages[id].cards.length, r.stages[id].stuck]), ['reviews', t('Reviews owed'), r.reviews.length, 0]].map(([id, label, n, stuck]) => (
                  <button
                    key={id}
                    type="button"
                    className={`person-cell${stuck ? (stuck * 2 >= n ? ' bad' : ' warn') : ''}${picked?.key === r.key && picked.stage === id ? ' on' : ''}`}
                    disabled={!n}
                    onClick={() => setPicked(picked?.key === r.key && picked.stage === id ? null : { key: r.key, stage: id })}
                  >
                    <span className="person-cell-n">{n}</span>
                    <span className="person-cell-label">{label}</span>
                  </button>
                ))}
              </div>
              {picked?.key === r.key && (
                <ol className="cards">
                  {pickedCards.map((card) => <Card key={card.key} card={card} onOpen={open} drawer={drawer} typeColor={typeColor} />)}
                </ol>
              )}
            </li>
          ))}
        </ol>
      )}

      {!phone && <div className="table-wrap">
        <table className="table people-line">
          <thead>
            <tr>
              <th>{t('Person')}</th>
              {STAGES.filter((id) => id === 'planned' || id === 'building' || id === 'review').map((id) => <th key={id} className="num">{stageName(id)}</th>)}
              <th className="num">{t('Reviews owed')}</th>
              <th className="num">{t('Stuck')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key || 'nobody'} className={picked?.key === r.key ? 'row-open' : ''}>
                <td>
                  <span className="person">
                    {r.person ? <Avatar person={r.person} size={24} /> : <Avatar person={null} size={24} />}
                    <span className="truncate">{r.person?.displayName || t('Nobody')}</span>
                  </span>
                </td>
                {['planned', 'building', 'review'].map((id) => {
                  const cell = r.stages[id];
                  const n = cell.cards.length;
                  return (
                    <td key={id} className="num">
                      {n > 0 ? (
                        <button
                          type="button"
                          className={`people-cell${cell.stuck ? (cell.stuck * 2 >= n ? ' bad' : ' warn') : ''}${picked?.key === r.key && picked.stage === id ? ' on' : ''}`}
                          style={{ '--fill': `${Math.round((n / max) * 100)}%` }}
                          onClick={() => setPicked(picked?.key === r.key && picked.stage === id ? null : { key: r.key, stage: id })}
                          aria-label={t('{name}: {n} in {stage}', { name: r.person?.displayName || t('Nobody'), n, stage: stageName(id) })}
                        >
                          <span className="people-n">{n}</span>
                          {cell.stuck > 0 && <span className="people-stuck">{t(cell.stuck === 1 ? '1 stuck' : '{n} stuck', { n: cell.stuck })}</span>}
                        </button>
                      ) : <span className="muted">·</span>}
                    </td>
                  );
                })}
                <td className="num">
                  {r.reviews.length > 0
                    ? <button type="button" className={`people-cell${picked?.key === r.key && picked.stage === 'reviews' ? ' on' : ''}`} style={{ '--fill': '0%' }} onClick={() => setPicked({ key: r.key, stage: 'reviews' })}><span className="people-n">{r.reviews.length}</span></button>
                    : <span className="muted">·</span>}
                </td>
                <td className={`num${r.stuck ? ' text-bad' : ' muted'}`}>{r.stuck || '·'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}

      {pickedRow && !phone && (
        <section className="people-cards" aria-label={pickedRow.person?.displayName || t('Nobody')}>
          <h2 className="section-title">
            {pickedRow.person?.displayName || t('Nobody')} · {picked.stage === 'reviews' ? t('Reviews owed') : stageName(picked.stage)}
          </h2>
          <ol className="cards cards-grid">
            {pickedCards.map((card) => <Card key={card.key} card={card} onOpen={open} drawer={drawer} typeColor={typeColor} />)}
          </ol>
        </section>
      )}
    </div>
  );
}
