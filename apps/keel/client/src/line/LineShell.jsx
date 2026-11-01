// Keel's frame: the Line. A top bar (what needs you, search, live status, the menu), the line
// of stations under it (Keel's main navigation: each station is a stage of the path change takes,
// with the pages that look at that stage as its tabs), then the page. Pages beside the line
// (Inbox, Weekly summary, Team, Insights, Settings…) are in the menu. The rules that place
// change on the line are in stages.js; the stage names and their pages in names.js.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { Avatar, Logo, pinchLine, useMedia } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { pinchMood } from '../pinch.js';
import { t, tj, tx } from '../i18n.js';
import { updateNow, useNewVersion } from '../version.js';
import { STAGES, trackTones } from './stages.js';
import { stageHint, stageName, stageOfPath, stagePages } from './names.js';
import './line.css';

const LineData = createContext(null);
// The demo banner, once dismissed in this browser.
const DEMO_KEY = 'keel.demoBanner.hidden';
// Before the line loads: every stage, empty, so the stations are drawn from the start.
const EMPTY = STAGES.map((id) => ({ id, cards: [], count: 0, stuck: { warn: 0, bad: 0 }, tone: null }));
/** The line's stages and the shell's shared choices, for the pages that draw them (Line.jsx). */
export const useLine = () => useContext(LineData);

/**
 * After an action or auto-refresh, lists can lose rows (a reviewed PR leaves
 * "Needs my review", a snoozed item leaves the inbox). If you're scrolled near
 * the bottom, the shorter page would yank you upward. Hold the current height
 * until you navigate, so content changes never move the viewport.
 */
function useStableHeight(ref, refreshKey) {
  const { pathname, search } = useLocation();
  const seen = useRef(refreshKey);
  useLayoutEffect(() => {
    if (seen.current === refreshKey || !ref.current) return;
    seen.current = refreshKey;
    const el = ref.current;
    el.style.minHeight = `${Math.max(el.offsetHeight, parseFloat(el.style.minHeight) || 0)}px`;
  }, [refreshKey, ref]);
  useEffect(() => {
    if (ref.current) ref.current.style.minHeight = '';
  }, [pathname, search, ref]);
}

export default function LineShell({ children }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { meta, refreshKey, live } = useApp();
  const newVersion = useNewVersion();
  const mainRef = useRef(null);
  useStableHeight(mainRef, refreshKey);
  const [spinning, setSpinning] = useState(false);
  const [onlyMine, setOnlyMine] = useState(false);
  // A phone gets its own frame: one row along the top, the slim line pinned under it, the views at the bottom.
  const phone = useMedia('(max-width: 900px)');
  const [demoHidden, setDemoHidden] = useState(() => { try { return localStorage.getItem(DEMO_KEY) === '1'; } catch { return false; } });
  const hideDemo = () => { setDemoHidden(true); try { localStorage.setItem(DEMO_KEY, '1'); } catch { /* storage blocked: it comes back next time */ } };

  // The shell stays mounted from page to page, so these load once and follow refreshes.
  // The server builds the line (server/line.js), with each project's limits and levels and its history.
  const lineApi = useApi('/line');
  const pending = useApi('/deploys/pending');
  const pipelines = useApi('/pipelines');
  const approvals = useApi('/approvals');
  const production = useApi('/production');
  const attention = useApi('/attention');
  const stages = useMemo(() => lineApi.data?.stages || EMPTY, [lineApi.data]);
  const loading = !lineApi.data && !lineApi.error;
  // The raw answers too, for the Desk and the Control room, which read them their own way.
  const data = useMemo(() => ({
    pending: pending.data, pipelines: pipelines.data, approvals: approvals.data, production: production.data, attention: attention.data,
  }), [pending.data, pipelines.data, approvals.data, production.data, attention.data]);
  const line = useMemo(() => ({
    stages, tracks: lineApi.data?.tracks || trackTones(stages), history: lineApi.data?.history || null, loading, onlyMine, setOnlyMine, data,
  }), [stages, lineApi.data, loading, onlyMine, data]);

  const s = attention.data?.summary;
  // Browser tab title carries the "act now" count, so it shows on a background tab.
  useEffect(() => {
    document.title = s?.high ? `(${s.high}) Keel` : 'Keel';
  }, [s?.high]);
  // Pinch in the corner reacts to what Keel sees, and says why on hover.
  const mood = pinchMood({ attention: attention.data, live, busy: spinning });

  const home = pathname === '/';
  const here = stageOfPath(pathname);
  // Three ways to look at the same work: the Line (where is change stuck?), the Desk (what do I do
  // next?) and the Control room (what's happening right now?). The line of stations is the Line's
  // own navigation, so the other two leave it out and take the whole window.
  const view = pathname === '/desk' || pathname.startsWith('/desk/') ? 'desk' : pathname === '/control' ? 'control' : 'line';
  const needs = [
    s?.approvals && { label: t(s.approvals === 1 ? '1 approval' : '{n} approvals', { n: s.approvals }), stage: 'deploying', tone: 'warn', mine: true },
    s?.myReviews && { label: t(s.myReviews === 1 ? '1 review' : '{n} reviews', { n: s.myReviews }), stage: 'review', tone: 'accent', mine: true },
    s?.productionIssues && { label: t(s.productionIssues === 1 ? '1 production issue' : '{n} production issues', { n: s.productionIssues }), stage: 'live', tone: 'bad' },
    s?.failingPipelines && { label: t(s.failingPipelines === 1 ? '1 red pipeline' : '{n} red pipelines', { n: s.failingPipelines }), stage: 'deploying', tone: 'bad' },
  ].filter(Boolean);

  return (
    <LineData.Provider value={line}>
      <div className={`ls ls-${view}${home ? ' ls-home' : ''}${onlyMine ? ' line-only-mine' : ''}`}>
        <header className="line-top">
          <Link to="/" className="line-brand" title={pinchLine(mood, { attention: attention.data, live })}>
            <Logo mood={mood} size={30} />
            <span className="line-brand-text">
              <strong>Keel</strong>
              <span className="truncate" title={(meta.orgs || []).map((o) => o.url).join('\n') || meta.orgUrl}>
                {meta.orgs?.length > 1 ? t('{n} organizations', { n: meta.orgs.length }) : meta.orgUrl.replace(/^https?:\/\/(dev\.azure\.com\/)?/, '')}
              </span>
            </span>
          </Link>

          <nav className="views" aria-label={t('Views')}>
            <NavLink to="/" className={() => (view === 'line' ? 'on' : '')} title={t('Where change is stuck')}><Icon name="line" size={15} /><span>{t('Line')}</span></NavLink>
            <NavLink to="/desk" className={() => (view === 'desk' ? 'on' : '')} title={t('What to do next')}><Icon name="workItems" size={15} /><span>{t('Desk')}</span></NavLink>
            <NavLink to="/control" className={() => (view === 'control' ? 'on' : '')} title={t("What's happening now")}><Icon name="production" size={15} /><span>{t('Control room')}</span></NavLink>
          </nav>

          <div className="line-needs" role="group" aria-label={t('Needs you')}>
            <NavLink to="/inbox" className={({ isActive }) => `line-needs-label${isActive ? ' on' : ''}`}>
              <Icon name="inbox" size={15} /> {t('Needs you')}{s?.high ? <span className="line-needs-n">{s.high}</span> : null}
            </NavLink>
            {needs.length ? needs.map((n) => (
              <button key={n.label} type="button" className={`line-need line-need-${n.tone}`} onClick={() => { setOnlyMine(!!n.mine); navigate(`/line/${n.stage}`); }}>
                {n.label}
              </button>
            )) : attention.data && <span className="line-need line-need-ok">{t('All clear')}</span>}
          </div>

          <div className="line-tools">
            <button type="button" className="line-tool line-search" onClick={() => window.dispatchEvent(new Event('keel:palette'))} aria-label={t('Search (Ctrl+K)')} title={t('Search (Ctrl+K)')}>
              <Icon name="search" /><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            <span className={`line-live line-live-${!live.connected ? 'warn' : live.ok === false && live.error ? 'bad' : 'ok'}`} role="img" aria-label={liveText(live)} title={liveText(live)} />
            <Menu spinning={spinning} setSpinning={setSpinning} />
          </div>
        </header>

        {newVersion && (
          <div className="update-banner" role="status">
            <span>{t('A new version of Keel is available.')}</span>
            <button type="button" className="btn btn-small btn-primary" onClick={updateNow}>{t('Update')}</button>
          </div>
        )}
        {meta.mock && !demoHidden && (
          <div className="demo-banner demo-banner-mock">
            <span className="demo-banner-text">
              {tj("You're looking at demo data ({reason}). Add {orgUrl} and {pat} to {env} and restart to connect your organization.", {
                reason: tx(meta.mockReason), orgUrl: <code>AZDO_ORG_URL</code>, pat: <code>AZDO_PAT</code>, env: <code>.env</code>,
              })}
            </span>
            <button type="button" className="demo-banner-x" onClick={hideDemo} aria-label={t('Dismiss')} title={t('Dismiss')}>✕</button>
          </div>
        )}
        {!meta.trackedProjects.length && (
          <div className="demo-banner">
            {tj('No projects tracked yet. {link} to fill the console.', { link: <NavLink to="/settings">{t('Choose your projects and repos')}</NavLink> })}
          </div>
        )}

        {view === 'line' && <Rail stages={stages} tracks={line.tracks} history={line.history} here={here} compact={!home || phone} loading={loading} />}
        {view === 'line' && here && (
          <nav className="stage-tabs" aria-label={stageName(here)}>
            {stagePages(here).map(([label, to]) => (
              <NavLink key={to} to={to} end className={({ isActive }) => (isActive || (to === '/totals' && pathname.startsWith('/totals/')) ? 'on' : '')}>{label}</NavLink>
            ))}
          </nav>
        )}

        <main className="ls-main" ref={mainRef}>{children}</main>

        {/* Phones: the three views and the Inbox at the bottom, within reach of a thumb. */}
        <nav className="bottom-bar" aria-label={t('Views')}>
          <NavLink to="/" className={() => (view === 'line' && !pathname.startsWith('/inbox') ? 'on' : '')}><Icon name="line" /><span>{t('Line')}</span></NavLink>
          <NavLink to="/desk" className={() => (view === 'desk' ? 'on' : '')}><Icon name="workItems" /><span>{t('Desk')}</span></NavLink>
          <NavLink to="/control" className={() => (view === 'control' ? 'on' : '')}><Icon name="production" /><span>{t('Control room')}</span></NavLink>
          <NavLink to="/inbox" className={({ isActive }) => (isActive ? 'on' : '')}>
            <span className="bottom-icon"><Icon name="inbox" />{s?.high ? <span className="bottom-n">{s.high}</span> : null}</span>
            <span>{t('Inbox')}</span>
          </NavLink>
        </nav>
      </div>
    </LineData.Provider>
  );
}

/** The stations: the whole line on the home page, a slim one over every other page. */
function Rail({ stages, tracks, history, here, compact, loading }) {
  return (
    <nav className={`line-rail${compact ? ' line-rail-compact' : ''}`} aria-label={t('The Line')}>
      {stages.map((stage, i) => {
        const stuck = stage.stuck.bad + stage.stuck.warn;
        return (
          <NavLink
            key={stage.id}
            to={`/line/${stage.id}`}
            className={`station station-${stage.tone || 'ok'}${here === stage.id ? ' on' : ''}`}
            data-in={i ? tracks[i - 1] : undefined}
            data-out={i < stages.length - 1 ? tracks[i] : undefined}
            aria-current={here === stage.id ? 'page' : undefined}
            title={stageHint(stage.id)}
          >
            <span className="station-node" aria-hidden="true" />
            <span className="station-name">{stageName(stage.id)}</span>
            <span className="station-count">{loading && !stage.count ? '·' : stage.count}</span>
            {/* Slim, a station only speaks up when something's stuck there. */}
            {(stuck > 0 || !compact) && (
              <span className="station-stuck">
                {stuck ? t(stuck === 1 ? '1 stuck' : '{n} stuck', { n: stuck }) : stageHint(stage.id)}
                {/* Red for days on end is worth more than red today (server/domain/linehistory.js). */}
                {history?.redFor?.[stage.id] > 1 && <span className="station-red-for"> · {t('red for {n} days', { n: history.redFor[stage.id] })}</span>}
              </span>
            )}
            {!compact && history?.days?.length > 1 && <ToneStrip days={history.days.slice(-30)} id={stage.id} />}
          </NavLink>
        );
      })}
    </nav>
  );
}

/** A stage's last days, a square each, in the tone it had (hover for the day and its count). */
function ToneStrip({ days, id }) {
  return (
    <span className="tone-strip" aria-hidden="true">
      {days.map((d) => {
        const s = d.stages[id];
        return <span key={d.day} className={`tone-day tone-${s?.tone || (s ? 'ok' : 'none')}`} title={s ? `${d.day}: ${s.count} · ${t(s.bad + s.warn === 1 ? '1 stuck' : '{n} stuck', { n: s.bad + s.warn })}` : d.day} />;
      })}
    </span>
  );
}

function liveText(live) {
  if (!live.connected) return t('Reconnecting…');
  if (!live.ok && live.error) return t("Can't reach Azure DevOps");
  const ago = live.lastPollAt ? Math.max(0, Math.round((Date.now() - Date.parse(live.lastPollAt)) / 1000)) : null;
  if (ago === null) return t('Live · checking…');
  return ago < 60 ? t('Live · checked {n}s ago', { n: ago }) : t('Live · checked {n}m ago', { n: Math.round(ago / 60) });
}

/** Everything beside the line: the other pages, refreshing, and who you are. */
function Menu({ spinning, setSpinning }) {
  const { meta, refresh, toast, authMode, signOut, live } = useApp();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey); };
  }, [open]);
  // Re-reads "checked 12s ago" while the menu is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [open]);

  const hardRefresh = async () => {
    setSpinning(true);
    try {
      await api('/refresh', { method: 'POST' });
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setTimeout(() => setSpinning(false), 400);
    }
  };

  // Every page the stages hold, straight to it, each with the stage it sits in (names.js stagePages).
  const linePages = [
    ['/work', t('Work items'), 'workItems', 'planned'], ['/board', t('Board'), 'board', 'building'],
    ['/prs', t('Pull requests'), 'pullRequests', 'review'], ['/commits', t('Commits'), 'pullRequests', 'review'],
    ['/ship', t('Waiting to ship'), 'totals', 'merged'], ['/pipelines', t('Pipelines'), 'pipelines', 'deploying'],
    ['/production', t('Production'), 'production', 'live'],
  ];
  const pages = [
    ['/inbox', t('Inbox'), 'inbox'], ['/summary', t('Weekly summary'), 'summary'],
    ['/people', t('Team'), 'team'], ['/insights', t('Insights'), 'insights'], ['/settings', t('Settings'), 'settings'],
  ];
  const name = meta.account?.name || meta.me.displayName;
  return (
    <div className="line-menu" ref={ref}>
      <button type="button" className="line-tool" aria-expanded={open} aria-label={t('Menu')} title={t('Menu')} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'close' : 'more'} />
      </button>
      {open && (
        <div className="line-menu-pop">
          <nav className="line-menu-pages line-menu-all" aria-label={t('All pages')}>
            <span className="line-menu-h">{t('All pages')}</span>
            {linePages.map(([to, label, icon, stage]) => (
              <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'on' : '')}>
                <Icon name={icon} size={15} /> {label}<span className="line-menu-stage">{stageName(stage)}</span>
              </NavLink>
            ))}
          </nav>
          <nav className="line-menu-pages" aria-label={t('Menu')}>
            {pages.map(([to, label, icon]) => (
              <NavLink key={to} to={to} className={({ isActive }) => (isActive || (to === '/people' && /^\/(team|users)(\/|$)/.test(pathname)) ? 'on' : '')}><Icon name={icon} size={15} /> {label}</NavLink>
            ))}
          </nav>
          <div className="line-menu-foot">
            <button type="button" className="line-menu-row" onClick={hardRefresh} disabled={spinning}>
              <span className={spinning ? 'spin' : ''}><Icon name="refresh" size={15} /></span> {t('Refresh from Azure DevOps')}
            </button>
            <div className={`line-menu-live live-${!live.connected ? 'warn' : !live.ok && live.error ? 'bad' : 'ok'}`}>
              <span className="live-dot" aria-hidden="true" /> {liveText(live)}
            </div>
            <div className="line-menu-me">
              <Avatar person={{ displayName: name, uniqueName: meta.me.uniqueName }} size={28} title={name} />
              <span className="truncate" title={meta.account ? `${meta.account.email} · Azure DevOps: ${meta.me.displayName}` : meta.me.uniqueName}>
                {t('Signed in as {name}', { name })}
                {authMode === 'login' && <span className="role-badge">{{ admin: 'Admin', developer: 'Developer', pm: 'PM' }[meta.role]}</span>}
              </span>
              {authMode === 'login' && <button type="button" className="line-tool" onClick={signOut} title={t('Sign out')} aria-label={t('Sign out')}><Icon name="signOut" size={15} /></button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

