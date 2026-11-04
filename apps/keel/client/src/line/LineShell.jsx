// Keel's frame: the Line. On a wide screen, the sidebar (the three views and every page, by
// what you're doing, with refresh and who you are at its foot) beside a top bar (what needs you,
// search, live status), on the home page the line of stations under it (each station a stage of
// the path change takes), on a stage's pages that stage's tabs, then the page. A phone has no
// sidebar: its menu, a button in the bottom right corner, holds the views and all the pages.
// The rules that place change on the line are in stages.js; the stage names and pages in names.js.
import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { Avatar, Logo, Tip, pinchLine, useMedia } from '../ui.jsx';
import { useSticky } from '../sticky.js';
import { isHomeable, saveHome } from '../home.js';
import { Icon } from '../icons.jsx';
import { pinchMood } from '../pinch.js';
import { t, tj, tx } from '../i18n.js';
import { updateNow, useNewVersion } from '../version.js';
import { STAGES, trackTones } from './stages.js';
import { stageHint, stageName, stageOfPath, stagePages } from './names.js';
import './line.css';
import './shell.css';
import { Badge, Button, DropdownMenu, IconButton, ScrollArea, Separator, Text } from '@radix-ui/themes';

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
  const [more, setMore] = useState(false);
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

  const home = pathname === '/line';
  const here = stageOfPath(pathname);
  const section = sectionOf(pathname);
  // A section opens on the page you were last on in it (the board, say, not the work list), kept
  // in this browser. Where a page has options in its address (?mode=sprint) they come back too.
  const { search } = useLocation();
  const [last, setLast] = useSticky('nav.last', {});
  useEffect(() => {
    if (section && last[section.id] !== pathname + search) setLast((l) => ({ ...l, [section.id]: pathname + search }));
  }, [section?.id, pathname, search]); // eslint-disable-line react-hooks/exhaustive-deps
  const sectionTo = (sec) => last[sec.id] || sec.to;
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
      <div className={`ls ls-${view}${home ? ' ls-home' : ''}${onlyMine ? ' line-only-mine' : ''}${phone ? ' ls-phone' : ` ls-dock${collapsed ? ' ls-collapsed' : ''}`}`}>
        {!phone && (
          <Dock
            section={section} sectionTo={sectionTo} summary={s} mood={mood} attention={attention.data}
            spinning={spinning} setSpinning={setSpinning} collapsed={collapsed} setCollapsed={setCollapsed}
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
              {needs.length ? needs.map((n, i) => (
                <Fragment key={n.label}>
                  {i > 0 && needs[i - 1].mine && !n.mine && <span className="line-needs-sep" aria-hidden="true" />}
                  <button type="button" className={`line-need line-need-${n.tone}`} onClick={() => { setOnlyMine(!!n.mine); navigate(`/line/${n.stage}`); }}>
                  {n.label}
                </button>
                </Fragment>
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
              <Button size="1" variant="solid" type="button" onClick={updateNow}>{t('Update')}</Button>
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

          {/* The section's pages as tabs, and the line, slim, as the context every page sits in. */}
          {section && section.pages.length > 1 && (
            <nav className="sec-tabs" aria-label={section.label()}>
              {section.pages.map(([label, to]) => (
                <NavLink key={to} to={to} end className={() => (tabOn(pathname, to, section) ? 'on' : '')}>{label()}</NavLink>
              ))}
            </nav>
          )}
          {view !== 'desk' && view !== 'control' && <Rail stages={stages} tracks={line.tracks} history={line.history} here={here} compact={!home || phone} loading={loading} />}

          <main className="ls-main" ref={mainRef}>{children}</main>
        </div>

        {/* Phones: the menu, in the bottom right corner within reach of a thumb. */}
        {phone && <Tabs section={section} sectionTo={sectionTo} summary={s} more={more} setMore={setMore} view={view} spinning={spinning} setSpinning={setSpinning} />}
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
 * Keel's five sections, the same on a wide screen's dock and a phone's tab bar. A section is
 * what you're doing, not where a page lives: Now (what needs me), Code, Work, Delivery (the
 * Line, what waits to ship, pipelines) and Watch (production and how the team is doing).
 */
export const SECTIONS = [
  { id: 'now', icon: 'inbox', label: () => t('Now'), to: '/desk', pages: [[() => t('Desk'), '/desk'], [() => t('Inbox'), '/inbox'], [() => t('Weekly summary'), '/summary']] },
  { id: 'code', icon: 'pullRequests', label: () => t('Code'), to: '/prs', pages: [[() => t('Pull requests'), '/prs'], [() => t('Commits'), '/commits'], [() => t('Release notes'), '/release-notes']] },
  { id: 'work', icon: 'workItems', label: () => t('Work'), to: '/work', pages: [[() => t('Work items'), '/work'], [() => t('Board'), '/board'], [() => t('Epics'), '/epics']] },
  { id: 'delivery', icon: 'line', label: () => t('Delivery'), to: '/line', pages: [[() => t('The Line'), '/line'], [() => t('Waiting to ship'), '/ship'], [() => t('Pipelines'), '/pipelines']] },
  { id: 'watch', icon: 'production', label: () => t('Watch'), to: '/control', pages: [[() => t('Control room'), '/control'], [() => t('Monitors'), '/production'], [() => t('Platform totals'), '/totals'], [() => t('Insights'), '/insights']] },
];
// Pages that sit beside the sections, in the dock's foot: they have no tabs of their own.
const FOOT = [
  { id: 'team', icon: 'team', label: () => t('Team'), to: '/people', paths: ['/people', '/team', '/users'] },
  { id: 'settings', icon: 'settings', label: () => t('Settings'), to: '/settings', paths: ['/settings'] },
];
const under = (pathname, p) => (p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(`${p}/`));
const EXTRA = { now: [], code: [], work: ['/sprint'], delivery: [], watch: [] };
/** The section a page belongs to, or null (Settings, Team). */
export function sectionOf(pathname) {
  return SECTIONS.find((sec) => sec.pages.some(([, p]) => under(pathname, p)) || EXTRA[sec.id].some((p) => under(pathname, p))) || null;
}
const tabOn = (pathname, to) => under(pathname, to);

/** What needs you in each section, for the badge on its icon. */
function sectionCounts(s) {
  return {
    now: { n: s?.high || 0, tone: 'bad' },
    code: { n: s?.myReviews || 0, tone: 'accent' },
    delivery: { n: (s?.approvals || 0) + (s?.failingPipelines || 0), tone: s?.failingPipelines ? 'bad' : 'accent' },
    watch: { n: s?.productionIssues || 0, tone: 'bad' },
  };
}

/**
 * Wide screens: the sidebar, in the theme's own grays. The five sections, the active one opened to
 * its pages, what needs you as a badge on each; below, search, Team and Settings, and you, whose
 * menu holds refresh, the live status and sign out. Collapsed, icons only (kept in this browser).
 */
function Dock({ section, sectionTo, summary: s, mood, attention, spinning, setSpinning, collapsed, setCollapsed }) {
  const { meta, live, authMode, signOut, toast } = useApp();
  const { pathname } = useLocation();
  const hardRefresh = useHardRefresh(setSpinning);
  const counts = sectionCounts(s);
  const name = meta.account?.name || meta.me.displayName;
  const org = (meta.orgs?.length || 0) > 1 ? t('{n} organizations', { n: meta.orgs.length }) : meta.orgUrl.replace(/^https?:\/\/(dev\.azure\.com\/)?/, '');
  const tone = !live.connected ? 'amber' : !live.ok && live.error ? 'red' : 'green';
  // Collapsed, a name is on hover instead.
  const tip = (label, node) => (collapsed ? <Tip label={label}>{node}</Tip> : node);
  const badge = (c) => (c?.n > 0 ? <Badge className="sb-n" size="1" radius="full" variant="solid" color={c.tone === 'bad' ? 'red' : undefined}>{c.n}</Badge> : null);
  return (
    <nav className="sb" aria-label={t('Main')}>
      <div className="sb-brand">
        <Link to="/" className="sb-logo" title={pinchLine(mood, { attention, live })}><Logo mood={mood} size={30} /></Link>
        <div className="sb-name">
          <Text as="div" size="3" weight="bold" className="sb-title">Keel</Text>
          <Text as="div" size="1" color="gray" truncate title={(meta.orgs || []).map((o) => o.url).join('\n') || meta.orgUrl}>{org}</Text>
        </div>
        <IconButton variant="ghost" color="gray" size="1" className="sb-toggle" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} aria-label={collapsed ? t('Expand menu') : t('Collapse menu')}>
          <Icon name={collapsed ? 'expand' : 'collapse'} size={16} />
        </IconButton>
      </div>

      <ScrollArea type="hover" scrollbars="vertical" className="sb-scroll">
        <ul className="sb-list">
          {SECTIONS.map((sec) => {
            const on = section?.id === sec.id;
            const c = counts[sec.id];
            return (
              <li key={sec.id}>
                {tip(sec.label(), (
                  <NavLink to={sectionTo(sec)} className={`sb-link${on ? ' on' : ''}`} aria-label={collapsed ? sec.label() : undefined}>
                    <span className="sb-icon"><Icon name={sec.icon} size={18} />{collapsed && c?.n > 0 && <span className={`sb-dot sb-dot-${c.tone}`} />}</span>
                    <span className="sb-text">{sec.label()}</span>
                    {!collapsed && badge(c)}
                  </NavLink>
                ))}
                {on && !collapsed && sec.pages.length > 1 && (
                  <ul className="sb-sub">
                    {sec.pages.map(([label, to]) => (
                      <li key={to}><NavLink to={to} end className={() => `sb-sublink${tabOn(pathname, to, sec) ? ' on' : ''}`}>{label()}</NavLink></li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </ScrollArea>

      <div className="sb-foot">
        <Separator size="4" className="sb-sep" />
        {tip(t('Search'), (
          <button type="button" className="sb-link" onClick={() => window.dispatchEvent(new Event('keel:palette'))}>
            <span className="sb-icon"><Icon name="search" size={18} /></span><span className="sb-text">{t('Search')}</span>
            {!collapsed && <kbd className="sb-kbd">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>}
          </button>
        ))}
        {FOOT.map((f) => <Fragment key={f.id}>{tip(f.label(), (
          <NavLink to={f.to} className={`sb-link${f.paths.some((p) => under(pathname, p)) ? ' on' : ''}`} aria-label={collapsed ? f.label() : undefined}>
            <span className="sb-icon"><Icon name={f.icon} size={18} /></span><span className="sb-text">{f.label()}</span>
          </NavLink>
        ))}</Fragment>)}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <button type="button" className="sb-me" aria-label={name}>
              <span className="sb-avatar"><Avatar person={{ displayName: name, uniqueName: meta.me.uniqueName }} size={28} title={name} /><span className={`sb-live sb-live-${tone}`} /></span>
              <span className="sb-text sb-me-text">
                <Text as="div" size="2" weight="medium" truncate>{name}</Text>
                <Text as="div" size="1" color="gray" truncate>{liveText(live)}</Text>
              </span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="start" size="1" className="sb-menu">
            <DropdownMenu.Label>{authMode === 'login' ? `${name} · ${{ admin: 'Admin', developer: 'Developer', pm: 'PM' }[meta.role]}` : name}</DropdownMenu.Label>
            <DropdownMenu.Item disabled={!isHomeable(pathname)} onSelect={() => { saveHome(pathname); toast(t('This page is now your home page')); }}>{t('Make this page my home page')}</DropdownMenu.Item>
            <DropdownMenu.Item disabled={spinning} onSelect={hardRefresh}>{t('Refresh from Azure DevOps')}</DropdownMenu.Item>
            {authMode === 'login' && <><DropdownMenu.Separator /><DropdownMenu.Item color="red" onSelect={signOut}>{t('Sign out')}</DropdownMenu.Item></>}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </nav>
  );
}

/** Phones: the five sections as a bar along the bottom, and More for everything else. */
function Tabs({ section, sectionTo, summary: s, more, setMore, spinning, setSpinning }) {
  const { live } = useApp();
  const { pathname } = useLocation();
  const ref = useRef(null);
  const hardRefresh = useHardRefresh(setSpinning);
  const counts = sectionCounts(s);
  useEffect(() => setMore(false), [pathname, setMore]);
  useEffect(() => {
    if (!more) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setMore(false); };
    const onKey = (e) => e.key === 'Escape' && setMore(false);
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey); };
  }, [more, setMore]);
  return (
    <div className="tabbar-wrap" ref={ref}>
      {more && (
        <div className="line-menu-pop tabbar-more">
          <nav className="line-menu-pages" aria-label={t('Menu')}>
            {FOOT.map((f) => <NavLink key={f.id} to={f.to} className={() => (f.paths.some((p) => under(pathname, p)) ? 'on' : '')}><Icon name={f.icon} size={15} /> <span className="truncate">{f.label()}</span></NavLink>)}
            <NavLink to="/inbox" className={() => (pathname === '/inbox' ? 'on' : '')}><Icon name="inbox" size={15} /> <span className="truncate">{t('Inbox')}</span></NavLink>
            <NavLink to="/summary" className={() => (pathname === '/summary' ? 'on' : '')}><Icon name="summary" size={15} /> <span className="truncate">{t('Weekly summary')}</span></NavLink>
          </nav>
          <div className="line-menu-foot">
            <button type="button" className="line-menu-row" onClick={hardRefresh} disabled={spinning}>
              <span className={spinning ? 'spin' : ''}><Icon name="refresh" size={15} /></span> {t('Refresh from Azure DevOps')}
            </button>
            <div className={`line-menu-live live-${!live.connected ? 'warn' : !live.ok && live.error ? 'bad' : 'ok'}`}><span className="live-dot" aria-hidden="true" /> {liveText(live)}</div>
            <Me className="line-menu-me" />
          </div>
        </div>
      )}
      <nav className="tabbar" aria-label={t('Main')}>
        {SECTIONS.map((sec) => {
          const c = counts[sec.id];
          return (
            <NavLink key={sec.id} to={sectionTo(sec)} className={() => `tab${section?.id === sec.id ? ' on' : ''}`}>
              <span className="dock-icon"><Icon name={sec.icon} size={21} />{c?.n > 0 && <span className={`dock-n dock-n-${c.tone}`}>{c.n}</span>}</span>
              <span className="tab-text">{sec.label()}</span>
            </NavLink>
          );
        })}
        <button type="button" className={`tab${more ? ' on' : ''}`} aria-expanded={more} onClick={() => setMore((m) => !m)}>
          <span className="dock-icon"><Icon name={more ? 'close' : 'more'} size={21} /></span><span className="tab-text">{t('More')}</span>
        </button>
      </nav>
    </div>
  );
}
