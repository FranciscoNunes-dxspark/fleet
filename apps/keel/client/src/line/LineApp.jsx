// The Line (prototype): Keel organised around the path a change takes, from planned to live,
// instead of a menu of Azure DevOps object types. One screen: the stations along the top, each
// with what it holds and how much is stuck there; the stage's cards under it, most stuck first;
// a card opens in the details panel, docked beside the line on a wide screen. stages.js has the rules.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApi, useApp } from '../context.js';
import { Avatar, Logo, pinchLine, sameTarget, useMedia, useTypeColor } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { pinchMood } from '../pinch.js';
import { t } from '../i18n.js';
import { STAGES, buildLine, trackTones } from './stages.js';
import './line.css';

const DAY = 864e5;
// How long a card may sit at a stage before its age bar fills: the stage's own idea of "a while".
const PATIENCE = { planned: 21 * DAY, building: 7 * DAY, review: 5 * DAY, merged: 7 * DAY, deploying: 2 * DAY, live: 7 * DAY };
const ICONS = { workitem: 'workItems', pr: 'pullRequests', ship: 'totals', approval: 'pipelines', deploy: 'production', pipeline: 'pipelines', monitor: 'production' };
const SHOWN = 7;

// Getters, so the names follow the language.
const NAMES = {
  get planned() { return t('Planned'); },
  get building() { return t('Building'); },
  get review() { return t('In review'); },
  get merged() { return t('Merged'); },
  get deploying() { return t('Deploying'); },
  get live() { return t('Live'); },
};
const HINTS = {
  get planned() { return t('Not started yet'); },
  get building() { return t('Being worked on'); },
  get review() { return t('Pull requests open'); },
  get merged() { return t('Waiting to ship'); },
  get deploying() { return t('On its way out'); },
  get live() { return t('In production'); },
};

const ago = (ms) => {
  if (ms < 36e5) return `${Math.max(1, Math.round(ms / 6e4))}m`;
  if (ms < 2 * DAY) return `${Math.round(ms / 36e5)}h`;
  return `${Math.floor(ms / DAY)}d`;
};

function reasonText(r) {
  if (!r) return '';
  switch (r.code) {
    case 'p1-waiting': return t('P1, not started for {n} days', { n: r.days });
    case 'blocked': return t('Blocked');
    case 'quiet': return t('No update for {n} days', { n: r.days });
    case 'conflicts': return t('Merge conflicts');
    case 'stale': return t('Open {n} days', { n: r.days });
    case 'pr-in-review': return t('In review');
    case 'pr-approved': return t('Approved');
    case 'pr-waiting-author': return t('Waiting on author');
    case 'pr-rejected': return t('Rejected');
    case 'pr-draft': return t('Draft');
    case 'pr-no-reviewers': return t('No reviewers');
    case 'waiting-changes': return t(r.n === 1 ? '1 change waiting' : '{n} changes waiting', { n: r.n });
    case 'approval-yours': return t('Waiting for your approval');
    case 'approval': return t('Waiting for approval');
    case 'deploying': return t('Deploying');
    case 'red': return t(r.n === 1 ? 'Red on its last run' : 'Red, {n} runs in a row', { n: r.n });
    case 'running': return t('Running');
    case 'monitor-up': return t('Up');
    case 'monitor-down': return t('Down');
    case 'monitor-degraded': return t('Degraded');
    case 'monitor-deploying': return t('Deploying');
    case 'monitor-settling': return t('Just deployed');
    default: return '';
  }
}

export default function LineApp() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { meta, openDrawer, drawer, live } = useApp();
  const narrow = useMedia('(max-width: 900px)');

  const workitems = useApi('/workitems');
  const prs = useApi('/prs');
  const pending = useApi('/deploys/pending');
  const pipelines = useApi('/pipelines');
  const approvals = useApi('/approvals');
  const production = useApi('/production');
  const attention = useApi('/attention');
  const delivery = useApi('/delivery');

  const stages = useMemo(() => buildLine({
    workitems: workitems.data, prs: prs.data, pending: pending.data,
    pipelines: pipelines.data, approvals: approvals.data, production: production.data,
  }), [workitems.data, prs.data, pending.data, pipelines.data, approvals.data, production.data]);
  const tracks = trackTones(stages);
  const loading = [workitems, prs, pending, pipelines, approvals, production].some((r) => !r.data && !r.error);

  // The stage in focus comes from the address (/line/review), so it can be linked and survives a reload.
  // A phone shows one stage at a time: the focused one, else In review.
  const asked = pathname.split('/')[2];
  const focus = STAGES.includes(asked) ? asked : narrow ? 'review' : null;
  const go = (stage) => navigate(stage && stage !== focus ? `/line/${stage}` : '/line');
  const [onlyMine, setOnlyMine] = useState(false);

  const s = attention.data?.summary;
  const needs = [
    s?.approvals && { n: s.approvals, label: t(s.approvals === 1 ? '1 approval' : '{n} approvals', { n: s.approvals }), stage: 'deploying', tone: 'warn' },
    s?.myReviews && { n: s.myReviews, label: t(s.myReviews === 1 ? '1 review' : '{n} reviews', { n: s.myReviews }), stage: 'review', tone: 'accent' },
    s?.productionIssues && { n: s.productionIssues, label: t(s.productionIssues === 1 ? '1 production issue' : '{n} production issues', { n: s.productionIssues }), stage: 'live', tone: 'bad' },
    s?.failingPipelines && { n: s.failingPipelines, label: t(s.failingPipelines === 1 ? '1 red pipeline' : '{n} red pipelines', { n: s.failingPipelines }), stage: 'deploying', tone: 'bad' },
  ].filter(Boolean);
  const mood = pinchMood({ attention: attention.data, live });

  const openCard = (card) => {
    if (card.open) openDrawer(card.open);
    else if (card.link) navigate(card.link);
  };

  return (
    <div className={`line${focus ? ' line-focused' : ''}${onlyMine ? ' line-only-mine' : ''}`}>
      <header className="line-top">
        <Link to="/line" className="line-brand" title={pinchLine(mood, { attention: attention.data, live })}>
          <Logo mood={mood} size={30} />
          <span className="line-brand-text">
            <strong>Keel</strong>
            <span className="truncate">{t('The Line')}</span>
          </span>
        </Link>

        <div className="line-needs" role="group" aria-label={t('Needs you')}>
          <span className="line-needs-label">{t('Needs you')}</span>
          {needs.length ? needs.map((n) => (
            <button key={n.label} type="button" className={`line-need line-need-${n.tone}`} onClick={() => { setOnlyMine(n.stage === 'review' || n.tone === 'warn'); navigate(`/line/${n.stage}`); }}>
              {n.label}
            </button>
          )) : <span className="line-need line-need-ok">{t('All clear')}</span>}
        </div>

        <div className="line-tools">
          <label className="line-mine">
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
            <span>{t('Only what needs me')}</span>
          </label>
          <button type="button" className="line-tool" onClick={() => window.dispatchEvent(new Event('keel:palette'))} aria-label={t('Search (Ctrl+K)')} title={t('Search (Ctrl+K)')}>
            <Icon name="search" />
          </button>
          <span className={`line-live line-live-${!live.connected ? 'warn' : live.ok === false ? 'bad' : 'ok'}`} role="img" title={t('Checks Azure DevOps every {n}s while the console is open', { n: live.intervalSeconds || '…' })} aria-label={t('Checks Azure DevOps every {n}s while the console is open', { n: live.intervalSeconds || '…' })} />
          <Menu />
        </div>
      </header>

      <nav className="line-rail" aria-label={t('The Line')} style={{ '--focus': focus ? STAGES.indexOf(focus) + 1 : 0 }}>
        {stages.map((stage, i) => (
          <button
            key={stage.id}
            type="button"
            className={`station station-${stage.tone || 'ok'}${focus === stage.id ? ' on' : ''}`}
            data-in={i ? tracks[i - 1] : undefined}
            data-out={i < stages.length - 1 ? tracks[i] : undefined}
            aria-current={focus === stage.id ? 'true' : undefined}
            onClick={() => go(stage.id)}
          >
            <span className="station-node" aria-hidden="true" />
            <span className="station-name">{NAMES[stage.id]}</span>
            <span className="station-count">{loading && !stage.count ? '·' : stage.count}</span>
            <span className="station-stuck">
              {stage.stuck.bad + stage.stuck.warn
                ? t(stage.stuck.bad + stage.stuck.warn === 1 ? '1 stuck' : '{n} stuck', { n: stage.stuck.bad + stage.stuck.warn })
                : HINTS[stage.id]}
            </span>
          </button>
        ))}
      </nav>

      <main className="line-stages">
        {stages.map((stage) => (
          <Stage
            key={stage.id}
            stage={stage}
            focused={focus === stage.id}
            folded={!!focus && focus !== stage.id}
            onFocus={() => go(stage.id)}
            onOpen={openCard}
            drawer={drawer}
            loading={loading}
          />
        ))}
      </main>

      <Moving delivery={delivery.data} />
      <p className="line-note">{t("A first look at a new Keel. The pages you know are still under Menu.")} {meta.mock && t('Demo data.')}</p>
    </div>
  );
}

function Stage({ stage, focused, folded, onFocus, onOpen, drawer, loading }) {
  const typeColor = useTypeColor();
  const shown = focused ? stage.cards : stage.cards.slice(0, SHOWN);
  const more = stage.cards.length - shown.length;
  if (folded) {
    return (
      <section className={`stage stage-folded stage-${stage.tone || 'ok'}`} aria-label={NAMES[stage.id]}>
        <button type="button" className="stage-fold" onClick={onFocus}>
          <span className="stage-fold-count">{stage.count}</span>
          <span className="stage-fold-name">{NAMES[stage.id]}</span>
        </button>
      </section>
    );
  }
  return (
    <section className={`stage${focused ? ' stage-focused' : ''}`} aria-label={NAMES[stage.id]}>
      {focused && (
        <div className="stage-head">
          <h1>{NAMES[stage.id]}</h1>
          <span className="muted">{HINTS[stage.id]}</span>
        </div>
      )}
      {!stage.cards.length && <p className="stage-empty">{loading ? t('Loading') : t('Nothing here')}</p>}
      <ol className="cards">
        {shown.map((card) => <Card key={card.key} card={card} onOpen={onOpen} open={!!card.open && sameTarget(card.open, drawer)} typeStyle={card.type ? typeColor(card.type, card.typeColor) : undefined} />)}
      </ol>
      {more > 0 && <button type="button" className="stage-more" onClick={onFocus}>{t('+{n} more', { n: more })}</button>}
    </section>
  );
}

function Card({ card, onOpen, open, typeStyle }) {
  const fill = Math.min(1, card.age / PATIENCE[card.stage]);
  return (
    <li className={`lc lc-${card.kind}${card.stuck ? ` lc-${card.stuck}` : ''}${card.mine ? ' lc-mine' : ''}${card.draft ? ' lc-draft' : ''}${open ? ' lc-open' : ''}`}>
      <button type="button" className="lc-hit" onClick={() => onOpen(card)} aria-current={open || undefined}>
        <span className="lc-top">
          {card.kind === 'monitor'
            ? <span className={`lc-dot lc-dot-${card.state}`} aria-hidden="true" />
            : <span className="lc-icon" style={typeStyle}><Icon name={ICONS[card.kind]} size={14} /></span>}
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
    </li>
  );
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

/** Everything that isn't a stage of the line: the pages you know, while this is a prototype. */
function Menu() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const links = [
    ['/', t('Dashboard'), 'dashboard'], ['/inbox', t('Inbox'), 'inbox'], ['/board', t('Board'), 'board'],
    ['/team', t('Team'), 'team'], ['/insights', t('Insights'), 'insights'], ['/settings', t('Settings'), 'settings'],
  ];
  return (
    <div className="line-menu" ref={ref}>
      <button type="button" className="line-tool" aria-expanded={open} aria-label={t('Menu')} onClick={() => setOpen((o) => !o)}><Icon name="more" /></button>
      {open && (
        <div className="line-menu-pop" role="menu">
          {links.map(([to, label, icon]) => (
            <Link key={to} to={to} role="menuitem" onClick={() => setOpen(false)}><Icon name={icon} size={15} /> {label}</Link>
          ))}
        </div>
      )}
    </div>
  );
}
