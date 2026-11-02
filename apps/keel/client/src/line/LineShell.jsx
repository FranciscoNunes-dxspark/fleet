// Keel's frame: the Line. On a wide screen, the sidebar (the three views and every page, by
// what you're doing, with refresh and who you are at its foot) beside a top bar (what needs you,
// search, live status), on the home page the line of stations under it (each station a stage of
// the path change takes), on a stage's pages that stage's tabs, then the page. A phone has no
// sidebar: its menu, a button in the bottom right corner, holds the views and all the pages.
// The rules that place change on the line are in stages.js; the stage names and pages in names.js.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { Avatar, Logo, pinchLine, useMedia } from '../ui.jsx';
import { useSticky } from '../sticky.js';
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
  const [collapsed, setCollapsed] = useSticky('sidebar.collapsed', false);
  // A phone gets its own frame: one row along the top, no sidebar, the menu in the bottom right corner.
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
      <div className={`ls ls-${view}${home ? ' ls-home' : ''}${onlyMine ? ' line-only-mine' : ''}${collapsed ? ' ls-collapsed' : ''}`}>
        {!phone && (
          <Sidebar
            view={view} summary={s} mood={mood} attention={attention.data}
            collapsed={collapsed} setCollapsed={setCollapsed} spinning={spinning} setSpinning={setSpinning}
          />
        )}
        <div className="ls-body">
          <header className="line-top">
            {/* Wide screens have Keel at the top of the sidebar instead. */}
            {phone && <Link to="/" className="line-brand" title={pinchLine(mood, { attention: attention.data, live })}>
              <Logo mood={mood} size={30} />
              <span className="line-brand-text">
                <strong>Keel</strong>
                <span className="truncate" title={(meta.orgs || []).map((o) => o.url).join('\n') || meta.orgUrl}>
                  {meta.orgs?.length > 1 ? t('{n} organizations', { n: meta.orgs.length }) : meta.orgUrl.replace(/^https?:\/\/(dev\.azure\.com\/)?/, '')}
                </span>
              </span>
            </Link>}

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

          {/* The stations are the home page's: elsewhere the sidebar (or the phone's menu) is the way around. */}
          {home && <Rail stages={stages} tracks={line.tracks} history={line.history} here={here} compact={phone} loading={loading} />}
          {view === 'line' && here && (
            <nav className="stage-tabs" aria-label={stageName(here)}>
              {stagePages(here).map(([label, to]) => (
                <NavLink key={to} to={to} end className={({ isActive }) => (isActive || (to === '/totals' && pathname.startsWith('/totals/')) ? 'on' : '')}>{label}</NavLink>
              ))}
            </nav>
          )}

          <main className="ls-main" ref={mainRef}>{children}</main>
        </div>

        {/* Phones: the menu, in the bottom right corner within reach of a thumb. */}
        {phone && <Menu view={view} inbox={s?.high} spinning={spinning} setSpinning={setSpinning} />}
      </div>
    </LineData.Provider>
  );
}

/** The stations, on the home page: the whole line, or a slim one pinned under the top bar on a phone. */
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

// The three ways to look at the same work, shared by the sidebar and the phone's menu.
const VIEWS = [
  ['line', '/', 'line', 'Line', 'Where change is stuck'],
  ['desk', '/desk', 'workItems', 'Desk', 'What to do next'],
  ['control', '/control', 'production', 'Control room', "What's happening now"],
];

/** Refresh from Azure DevOps, with the spin while it runs. */
function useHardRefresh(setSpinning) {
  const { refresh, toast } = useApp();
  return async () => {
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
}

/** Who you are, and the way out in sign-in mode. */
function Me({ className }) {
  const { meta, authMode, signOut } = useApp();
  const name = meta.account?.name || meta.me.displayName;
  return (
    <div className={className}>
      <Avatar person={{ displayName: name, uniqueName: meta.me.uniqueName }} size={28} title={name} />
      <span className="truncate" title={meta.account ? `${meta.account.email} · Azure DevOps: ${meta.me.displayName}` : meta.me.uniqueName}>
        {t('Signed in as {name}', { name })}
        {authMode === 'login' && <span className="role-badge">{{ admin: 'Admin', developer: 'Developer', pm: 'PM' }[meta.role]}</span>}
      </span>
      {authMode === 'login' && <button type="button" className="line-tool" onClick={signOut} title={t('Sign out')} aria-label={t('Sign out')}><Icon name="signOut" size={15} /></button>}
    </div>
  );
}

/**
 * Wide screens: the views and every page down the left, grouped by what you're doing, each
 * with the count of what needs you there. Collapsed, icons only (remembered in this browser).
 */
function Sidebar({ view, summary: s, mood, attention, collapsed, setCollapsed, spinning, setSpinning }) {
  const { meta, live } = useApp();
  const { pathname } = useLocation();
  const hardRefresh = useHardRefresh(setSpinning);
  const groups = [
    { items: [
      { to: '/inbox', label: t('Inbox'), icon: 'inbox', count: s?.high, tone: 'bad' },
      { to: '/summary', label: t('Weekly summary'), icon: 'summary' },
    ] },
    { label: t('Work'), items: [
      { to: '/work', label: t('Work items'), icon: 'workItems', also: ['/epics'] },
      { to: '/board', label: t('Board'), icon: 'board' },
    ] },
    { label: t('Code and delivery'), items: [
      { to: '/prs', label: t('Pull requests'), icon: 'pullRequests', count: s?.myReviews, tone: 'accent', also: ['/commits', '/release-notes'] },
      { to: '/ship', label: t('Waiting to ship'), icon: 'totals' },
      { to: '/pipelines', label: t('Pipelines'), icon: 'pipelines', count: (s?.approvals || 0) + (s?.failingPipelines || 0), tone: s?.failingPipelines ? 'bad' : 'accent' },
      { to: '/production', label: t('Production'), icon: 'production', count: s?.productionIssues, tone: 'bad', also: ['/totals'] },
    ] },
    { label: t('People'), items: [
      { to: '/people', label: t('Team'), icon: 'team', also: ['/team', '/users'] },
      { to: '/insights', label: t('Insights'), icon: 'insights' },
    ] },
  ];
  const lit = (n) => pathname === n.to || pathname.startsWith(`${n.to}/`) || !!n.also?.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const tip = (label) => (collapsed ? label : undefined);
  const link = (to, label, icon, on, extra) => (
    <NavLink to={to} className={() => `side-link${on ? ' on' : ''}`} title={tip(label)} aria-label={collapsed ? label : undefined}>
      <Icon name={icon} /><span className="side-text">{label}</span>{extra}
    </NavLink>
  );
  return (
    <nav className="side" aria-label={t('Main')}>
      <div className="side-brand">
        <Link to="/" className="line-brand" title={pinchLine(mood, { attention, live })}>
          <Logo mood={mood} size={30} />
          <span className="line-brand-text side-text">
            <strong>Keel</strong>
            <span className="truncate" title={(meta.orgs || []).map((o) => o.url).join('\n') || meta.orgUrl}>
              {meta.orgs?.length > 1 ? t('{n} organizations', { n: meta.orgs.length }) : meta.orgUrl.replace(/^https?:\/\/(dev\.azure\.com\/)?/, '')}
            </span>
          </span>
        </Link>
        <button
          type="button" className="side-toggle" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}
          aria-label={collapsed ? t('Expand menu') : t('Collapse menu')} title={collapsed ? t('Expand menu') : t('Collapse menu')}
        >
          <Icon name={collapsed ? 'expand' : 'collapse'} />
        </button>
      </div>
      <div className="side-scroll">
        <ul className="side-group side-views" aria-label={t('Views')}>
          {VIEWS.map(([id, to, icon, label]) => <li key={id}>{link(to, t(label), icon, view === id && !groups.some((g) => g.items.some(lit)) && pathname !== '/settings')}</li>)}
        </ul>
        {groups.map((g, i) => (
          <div key={g.label || i} className="side-group-wrap">
            {g.label && <div className="side-label side-text" id={`side-group-${i}`}>{g.label}</div>}
            <ul className="side-group" aria-labelledby={g.label ? `side-group-${i}` : undefined}>
              {g.items.map((n) => (
                <li key={n.to}>
                  {link(n.to, n.label, n.icon, lit(n), n.count > 0 && (
                    <span className={`side-count side-count-${n.tone}`} title={t(n.count === 1 ? '{n} needs attention' : '{n} need attention', { n: n.count })}>{n.count}</span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="side-foot">
        {link('/settings', t('Settings'), 'settings', pathname.startsWith('/settings'))}
        <button type="button" className="side-link" onClick={hardRefresh} disabled={spinning} title={tip(t('Refresh from Azure DevOps'))} aria-label={collapsed ? t('Refresh from Azure DevOps') : undefined}>
          <span className={spinning ? 'spin' : ''}><Icon name="refresh" /></span><span className="side-text">{t('Refresh from Azure DevOps')}</span>
        </button>
        <div className={`side-live live-${!live.connected ? 'warn' : !live.ok && live.error ? 'bad' : 'ok'}`} title={liveText(live)}>
          <span className="live-dot" aria-hidden="true" /><span className="side-text">{liveText(live)}</span>
        </div>
        <Me className="side-me" />
      </div>
    </nav>
  );
}

/** Phones: everything in one menu behind a button in the bottom right corner. */
function Menu({ view, inbox, spinning, setSpinning }) {
  const { live } = useApp();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const hardRefresh = useHardRefresh(setSpinning);
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
  return (
    <div className="line-menu line-menu-fab" ref={ref}>
      {open && (
        <div className="line-menu-pop">
          <nav className="line-menu-views" aria-label={t('Views')}>
            {VIEWS.map(([id, to, icon, label]) => (
              <NavLink key={id} to={to} className={() => ((id === 'line' ? pathname === '/' || pathname.startsWith('/line/') : view === id) ? 'on' : '')}><Icon name={icon} /><span>{t(label)}</span></NavLink>
            ))}
          </nav>
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
              <NavLink key={to} to={to} className={({ isActive }) => (isActive || (to === '/people' && /^\/(team|users)(\/|$)/.test(pathname)) ? 'on' : '')}>
                <Icon name={icon} size={15} /> {label}{to === '/inbox' && inbox ? <span className="line-menu-n">{inbox}</span> : null}
              </NavLink>
            ))}
          </nav>
          <div className="line-menu-foot">
            <button type="button" className="line-menu-row" onClick={hardRefresh} disabled={spinning}>
              <span className={spinning ? 'spin' : ''}><Icon name="refresh" size={15} /></span> {t('Refresh from Azure DevOps')}
            </button>
            <div className={`line-menu-live live-${!live.connected ? 'warn' : !live.ok && live.error ? 'bad' : 'ok'}`}>
              <span className="live-dot" aria-hidden="true" /> {liveText(live)}
            </div>
            <Me className="line-menu-me" />
          </div>
        </div>
      )}
      <button type="button" className="line-fab" aria-expanded={open} aria-label={t('Menu')} title={t('Menu')} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'close' : 'more'} />
        {!open && inbox ? <span className="line-fab-n">{inbox}</span> : null}
      </button>
    </div>
  );
}
