// The Line's own pages: home (every stage, its most stuck cards under its station) and one
// stage's cards (/line/review), most stuck first. The stages come from the shell (LineShell.jsx).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { approvalPath } from '../orgs.js';
import { age } from '../format.js';
import { Avatar, Confirm, sameTarget, useMedia, useTypeColor } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { t } from '../i18n.js';
import { STAGES } from './stages.js';
import { stageHint, stageName, stagePages } from './names.js';
import { reasonText as sharedReason } from './reasons.js';
import { lookAt, sinceLastLook } from './digest.js';
import { useLine } from './LineShell.jsx';
import NotFound from '../pages/NotFound.jsx';

const DAY = 864e5;
// How long a card may sit at a stage before its age bar fills: the stage's own idea of "a while".
const PATIENCE = { planned: 21 * DAY, building: 7 * DAY, review: 5 * DAY, merged: 7 * DAY, deploying: 2 * DAY, live: 7 * DAY };
const ICONS = { workitem: 'workItems', pr: 'pullRequests', ship: 'totals', approval: 'pipelines', deploy: 'production', pipeline: 'pipelines', monitor: 'production' };
const SHOWN = 7;

const ago = (ms) => {
  if (ms < 36e5) return `${Math.max(1, Math.round(ms / 6e4))}m`;
  if (ms < 2 * DAY) return `${Math.round(ms / 36e5)}h`;
  return `${Math.floor(ms / DAY)}d`;
};

const reasonText = (r) => sharedReason(r, t);

/** Opens a card: in the details panel where Keel has one for it, else on the page that holds it. */
export function useOpenCard() {
  const { openDrawer } = useApp();
  const navigate = useNavigate();
  return (card) => {
    if (card.open) openDrawer(card.open);
    else if (card.link) navigate(card.link);
  };
}

/** Home: every stage side by side, each with its most stuck cards, then how the line moves. */
export function LineHome() {
  const { stages, loading, history } = useLine();
  const { drawer } = useApp();
  const open = useOpenCard();
  const typeColor = useTypeColor();
  const delivery = useApi('/delivery');
  // A phone lists the stages one under another, so each shows its three most stuck.
  const shownPer = useMedia('(max-width: 900px)') ? 3 : SHOWN;
  return (
    <div className="line-home">
      <SinceLastLook stages={stages} loading={loading} />
      <div className="line-stages">
        {stages.map((stage) => {
          const shown = stage.cards.slice(0, shownPer);
          const more = stage.cards.length - shown.length;
          return (
            <section key={stage.id} className={`stage stage-${stage.tone || 'ok'}`} aria-label={stageName(stage.id)}>
              {/* Phones: the stages are a list, each under its own heading (the slim line above is only a guide). */}
              <Link to={`/line/${stage.id}`} className="stage-title">
                <span className="stage-title-name">{stageName(stage.id)}</span>
                <span className="stage-title-n">{stage.count}</span>
                {stage.stuck.bad + stage.stuck.warn > 0 && <span className="stage-title-stuck">{t(stage.stuck.bad + stage.stuck.warn === 1 ? '1 stuck' : '{n} stuck', { n: stage.stuck.bad + stage.stuck.warn })}</span>}
                <span className="stage-title-go" aria-hidden="true">→</span>
              </Link>
              {!stage.cards.length && <p className="stage-empty">{loading ? t('Loading') : t('Nothing here')}</p>}
              <ol className="cards">
                {shown.map((card) => <Card key={card.key} card={card} onOpen={open} drawer={drawer} typeColor={typeColor} />)}
              </ol>
              {more > 0 && <Link to={`/line/${stage.id}`} className="stage-more">{t('+{n} more', { n: more })}</Link>}
            </section>
          );
        })}
      </div>
      <Moving delivery={delivery.data} />
      <OverTime history={history} />
    </div>
  );
}

// The last look at the line, in this browser: what "since you last looked" compares with.
const SEEN_KEY = 'keel.line.seen.v1';
const readSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); } catch { return null; } };
const writeSeen = (look) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(look)); } catch { /* storage blocked: every visit is a first one */ } };

/**
 * What changed on the line since you last looked at it (line/digest.js): what moved on, what left
 * it (finished, merged, deployed), what's new and what's newly stuck. Leaving home, or Got it,
 * counts as looking; the first visit only remembers.
 */
function SinceLastLook({ stages, loading }) {
  const [before, setBefore] = useState(readSeen);
  const [open, setOpen] = useState(null);
  const latest = useRef(null);
  latest.current = loading ? null : stages;
  useEffect(() => () => { if (latest.current) writeSeen(lookAt(latest.current)); }, []);
  const diff = useMemo(() => (loading ? null : sinceLastLook(before, stages)), [before, stages, loading]);
  if (!diff) return null;
  const groups = [
    ['movedOn', t('Moved on'), diff.movedOn.map(({ card, from }) => ({ key: card.key, title: card.title, note: `${stageName(from)} → ${stageName(card.stage)}` }))],
    ['left', t('Left the line'), diff.left.map((c) => ({ key: c.key, title: c.title, note: stageName(c.stage) }))],
    ['arrived', t('New on the line'), diff.arrived.map((c) => ({ key: c.key, title: c.title, note: stageName(c.stage) }))],
    ['newlyStuck', t('Newly stuck'), diff.newlyStuck.map((c) => ({ key: c.key, title: c.title, note: reasonText(c.reason) }))],
  ];
  if (groups.every(([, , list]) => !list.length)) return null;
  const gotIt = () => { const look = lookAt(stages); writeSeen(look); setBefore(look); setOpen(null); };
  return (
    <section className="since" aria-label={t('Since you last looked')}>
      <div className="since-head">
        <h2>{t('Since you last looked')} <span className="muted small">{age(before.at)}</span></h2>
        <div className="since-chips">
          {groups.map(([id, label, list]) => (
            <button key={id} type="button" className={`since-chip since-${id}${open === id ? ' on' : ''}`} disabled={!list.length} onClick={() => setOpen(open === id ? null : id)}>
              <strong>{list.length}</strong> {label}
            </button>
          ))}
        </div>
        <span className="since-actions">
          <Link to="/summary" className="small">{t('Weekly summary')} →</Link>
          <button type="button" className="btn btn-small" onClick={gotIt}>{t('Got it')}</button>
        </span>
      </div>
      {open && (
        <ul className="since-list">
          {groups.find(([id]) => id === open)[2].slice(0, 30).map((x) => (
            <li key={x.key}><span className="truncate">{x.title}</span><span className="muted small">{x.note}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The line over the days Keel has seen it (server/line.js keeps a day per person): a row per
 * stage, a bar per day as tall as what the stage held, in the tone it had. Where a stage stays
 * red day after day is where the team's process is jammed, not just its week.
 */
function OverTime({ history }) {
  const days = history?.days?.slice(-60) || [];
  if (days.length < 2) return null;
  return (
    <section className="line-over-time" aria-label={t('The line over time')}>
      <h2>{t('The line over the last {n} days', { n: days.length })}</h2>
      <div className="over-rows">
        {STAGES.map((id) => {
          const max = Math.max(1, ...days.map((d) => d.stages[id]?.count || 0));
          return (
            <div key={id} className="over-row">
              <span className="over-name">{stageName(id)}</span>
              <span className="over-bars">
                {days.map((d) => {
                  const s = d.stages[id];
                  return (
                    <span
                      key={d.day}
                      className={`over-bar tone-${s?.tone || 'ok'}`}
                      style={{ height: `${Math.max(6, ((s?.count || 0) / max) * 100)}%` }}
                      title={s ? `${d.day}: ${s.count} · ${t(s.bad + s.warn === 1 ? '1 stuck' : '{n} stuck', { n: s.bad + s.warn })}` : d.day}
                    />
                  );
                })}
              </span>
              <span className="over-now">{days.at(-1).stages[id]?.count ?? '—'}</span>
            </div>
          );
        })}
      </div>
      <p className="over-axis"><span>{days[0].day}</span><span>{days.at(-1).day}</span></p>
    </section>
  );
}

/** One stage's cards, most stuck first: the first tab of every stage. */
export function StageCards() {
  const { stage: id } = useParams();
  const { stages, loading, onlyMine, setOnlyMine } = useLine();
  const { drawer } = useApp();
  const open = useOpenCard();
  const typeColor = useTypeColor();
  if (!STAGES.includes(id)) return <NotFound />;
  const stage = stages.find((s) => s.id === id);
  const deeper = stagePages(id).slice(1);
  const mine = stage.cards.filter((c) => c.mine).length;
  return (
    <div className="page page-wide stage-page">
      <header className="stage-head">
        <div>
          <h1>{stageName(id)}</h1>
          <p className="page-sub">
            {stageHint(id)} · {t(stage.count === 1 ? '1 on the line' : '{n} on the line', { n: stage.count })}
            {stage.stuck.bad + stage.stuck.warn > 0 && <> · <span className={`text-${stage.tone === 'bad' ? 'bad' : 'warn'}`}>{t(stage.stuck.bad + stage.stuck.warn === 1 ? '1 stuck' : '{n} stuck', { n: stage.stuck.bad + stage.stuck.warn })}</span></>}
          </p>
        </div>
        <div className="page-actions">
          {mine > 0 && (
            <label className="check line-mine">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              {t('Only what needs me')} <span className="muted">{mine}</span>
            </label>
          )}
          {deeper.map(([label, to]) => <Link key={to} to={to} className="btn btn-small">{label} →</Link>)}
        </div>
      </header>
      {!stage.cards.length && <p className="stage-empty">{loading ? t('Loading') : t('Nothing here')}</p>}
      <ol className="cards cards-grid">
        {stage.cards.map((card) => <Card key={card.key} card={card} onOpen={open} drawer={drawer} typeColor={typeColor} />)}
      </ol>
    </div>
  );
}

/** One card on the line: what it is, why it's stuck, how long it has sat there, and what you can do from it. */
export function Card({ card, onOpen, drawer, typeColor }) {
  const fill = Math.min(1, card.age / PATIENCE[card.stage]);
  const open = !!card.open && sameTarget(card.open, drawer);
  return (
    <li className={`lc lc-${card.kind}${card.stuck ? ` lc-${card.stuck}` : ''}${card.mine ? ' lc-mine' : ''}${card.draft ? ' lc-draft' : ''}${open ? ' lc-open' : ''}`}>
      <button type="button" className="lc-hit" onClick={() => onOpen(card)} aria-current={open || undefined}>
        <span className="lc-top">
          {card.kind === 'monitor'
            ? <span className={`lc-dot lc-dot-${card.state}`} aria-hidden="true" />
            : <span className="lc-icon" style={card.type ? typeColor(card.type, card.typeColor) : undefined}><Icon name={ICONS[card.kind]} size={14} /></span>}
          <span className="lc-sub truncate">{card.sub}</span>
          {card.mine && <span className="lc-you">{t('You')}</span>}
        </span>
        <span className="lc-title">{card.title}</span>
        <span className="lc-reason">{reasonText(card.reason)}</span>
        {card.kind === 'pipeline' && card.runs?.length > 0 && (
          <span className="lc-runs" aria-hidden="true">
            {card.runs.map((r, i) => <span key={i} className={`lc-run lc-run-${r === 'succeeded' ? 'ok' : r === 'failed' ? 'bad' : r === 'partiallySucceeded' ? 'warn' : 'idle'}`} />)}
          </span>
        )}
        {card.kind === 'monitor' && (
          <span className="lc-facts">
            {card.latency != null && <span>{card.latency}ms</span>}
            {card.uptime != null && <span>{t('{pct} up', { pct: `${Math.round(card.uptime * 1000) / 10}%` })}</span>}
          </span>
        )}
        <span className="lc-foot">
          {card.person && <Avatar person={card.person} size={20} />}
          {card.kind !== 'monitor' && (
            <span className="lc-age" title={t('Time at this stage')}>
              <span className="lc-age-bar"><span style={{ width: `${Math.max(4, fill * 100)}%` }} /></span>
              <span className="lc-age-n">{ago(card.age)}</span>
            </span>
          )}
        </span>
      </button>
      <CardActions card={card} />
    </li>
  );
}

/**
 * What can be done right from a card, without opening it: decide an approval waiting on you,
 * approve a pull request waiting on your review, turn on auto-complete for an approved one, run a
 * red pipeline again. Each only where your role allows it; the rest open the card as before.
 */
function CardActions({ card }) {
  const { can, refresh, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async (path, body, done) => {
    setBusy(true);
    try {
      await api(path, { method: 'POST', body });
      toast(done);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const actions = [];
  const pr = card.kind === 'pr' ? card.open : null;
  const prPath = pr && `/prs/${encodeURIComponent(pr.projectId)}/${encodeURIComponent(pr.repoId)}/${pr.id}/actions`;

  if (card.kind === 'approval' && card.approval?.canDecide && can('approvals.decide')) {
    actions.push(
      <Confirm key="approve" text={t('Approve {name}?', { name: card.title })} className="btn btn-small btn-primary" onConfirm={() => run(approvalPath(card.approval), { status: 'approved', comment: '' }, t('Approved: {name}', { name: card.title }))}>{t('Approve')}</Confirm>,
      <Confirm key="reject" text={t('Reject {name}?', { name: card.title })} className="btn btn-small btn-ghost" onConfirm={() => run(approvalPath(card.approval), { status: 'rejected', comment: '' }, t('Rejected: {name}', { name: card.title }))}>{t('Reject')}</Confirm>,
    );
  }
  if (pr && card.mine && can('prs.write')) {
    actions.push(<button key="vote" type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => run(prPath, { type: 'vote', vote: 10 }, t('Voted: {vote}', { vote: t('Approve') }))}>{t('Approve')}</button>);
  }
  if (pr && card.reviewState === 'approved' && !card.autoComplete && !card.draft && can('prs.write')) {
    actions.push(<button key="auto" type="button" className="btn btn-small" disabled={busy} onClick={() => run(prPath, { type: 'autoComplete', enabled: true }, t('Auto-complete set'))}>{t('Set auto-complete')}</button>);
  }
  if (card.rerun && can('pipelines.run')) {
    const { branch } = card.rerun;
    actions.push(<Confirm key="rerun" text={t('Run on {branch}?', { branch })} className="btn btn-small" onConfirm={() => run('/pipelines/queue', card.rerun, t('Queued {name} on {branch}', { name: card.title, branch }))}>{t('Run again')}</Confirm>);
  }
  if (!actions.length) return null;
  return <div className="lc-actions">{actions}</div>;
}

/** How the line moves: the delivery measures for the last 30 days, under it. */
function Moving({ delivery }) {
  const d = delivery?.totals;
  if (!d) return null;
  const facts = [
    [t('Deploys a week'), Math.round(d.deploysPerWeek * 10) / 10],
    [t('Lead time'), d.medianLeadTimeHours != null ? `${Math.round(d.medianLeadTimeHours)}h` : '—'],
    [t('Failed deploys'), `${Math.round(d.failureRate * 100)}%`],
    [t('Time to recover'), d.medianRecoveryHours != null ? `${Math.round(d.medianRecoveryHours)}h` : '—'],
  ];
  return (
    <section className="line-moving" aria-label={t('How the line moves')}>
      <h2>{t('How the line moves, last {n} days', { n: delivery.days })}</h2>
      <dl>
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <Link to="/insights" className="small">{t('Insights')} →</Link>
    </section>
  );
}
