import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { AppContext, useApi, useApp } from './context.js';
import { Drawer, ErrorBox, Loading, Logo } from './ui.jsx';
import { loadPrefs, showDesktop } from './notify.js';
import Inbox from './pages/Inbox.jsx';
import PullRequests from './pages/PullRequests.jsx';
import PrDetail from './pages/PrDetail.jsx';
import WorkItems from './pages/WorkItems.jsx';
import WorkItemDetail from './pages/WorkItemDetail.jsx';
import PipelineDetail from './pages/PipelineDetail.jsx';
import NewPr from './pages/NewPr.jsx';
import Board from './pages/Board.jsx';
import Epics from './pages/Epics.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Pipelines from './pages/Pipelines.jsx';
import Production from './pages/Production.jsx';
import Totals from './pages/Totals.jsx';
import Team from './pages/Team.jsx';
import Insights from './pages/Insights.jsx';
import Settings from './pages/Settings.jsx';
import { Icon } from './icons.jsx';
import { ConnectAzure, LinkAccept, SetupScreen as Setup, SignIn } from './pages/AuthScreens.jsx';
import Users from './pages/Users.jsx';
import { adoptServerPrefs, seedServerPrefs } from './prefs.js';
import { applyTheme } from './theme.js';
import { applySavedLanguage, getLanguage, t, tj, tx } from './i18n.js';

/**
 * Auth gate. In login mode (hosted), shows sign-in until there's a session,
 * and again whenever the server says the session ended or the token was
 * rejected. In local mode it's a pass-through.
 */
/**
 * Auth gate. Hosted mode (AUTH_MODE=login): first-run setup, invite and reset
 * links, sign-in, then connecting Azure DevOps, before the console itself.
 * Local mode is a pass-through.
 */
// Server notifications (server/domain/changes.js): Keel writes most titles and
// bodies, but some carry an Azure DevOps PR or work item title as is (inbox
// entries for a PR or work item, and the body of a vote). Those stay untranslated.
const noteTitle = (n) => (/^attention:(pr|wi):/.test(n.key || '') ? n.title : tx(n.title));
const noteBody = (n) => (/^vote:/.test(n.key || '') ? n.body : tx(n.body));

/** Re-renders everything when the language changes (Settings, or another device via synced prefs). */
export default function App() {
  const [lang, setLang] = useState(getLanguage);
  useEffect(() => {
    const onChange = (e) => setLang(e.detail);
    window.addEventListener('keel:language', onChange);
    return () => window.removeEventListener('keel:language', onChange);
  }, []);
  return <AuthGate key={lang} />;
}

function AuthGate() {
  const [auth, setAuth] = useState(null);
  const [reason, setReason] = useState(null);
  const [session, setSession] = useState(0);
  const [linkToken, setLinkToken] = useState(() => (window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]+)$/) || [])[1] || null);

  const check = useCallback(() => {
    fetch('/api/auth/status', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then(setAuth)
      .catch(() => setAuth({ mode: 'local', signedIn: true, unreachable: true }));
  }, []);
  useEffect(check, [check]);

  useEffect(() => {
    const onSignedOut = (e) => {
      setReason(e.detail?.reason || 'signin-required');
      setAuth((a) => (a?.mode === 'login' ? { ...a, signedIn: false } : a));
    };
    const onToken = (e) => {
      setReason(e.detail?.reason || 'token-required');
      setAuth((a) => (a?.mode === 'login' ? { ...a, needsToken: true } : a));
    };
    window.addEventListener('keel:signed-out', onSignedOut);
    window.addEventListener('keel:token-required', onToken);
    return () => {
      window.removeEventListener('keel:signed-out', onSignedOut);
      window.removeEventListener('keel:token-required', onToken);
    };
  }, []);

  const restart = () => {
    setReason(null);
    setSession((n) => n + 1); // fresh console state for the new session
    check();
  };
  const signOut = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setReason(null);
      setAuth((a) => ({ ...a, signedIn: false, user: null }));
    }
  };

  if (!auth) return <div className="boot"><Loading label={t('Starting…')} /></div>;
  if (auth.mode === 'login') {
    if (linkToken) {
      return (
        <LinkAccept
          orgUrl={auth.orgUrl}
          token={linkToken}
          onDone={() => {
            window.history.replaceState({}, '', '/');
            setLinkToken(null);
            restart();
          }}
        />
      );
    }
    if (auth.setupRequired) return <Setup orgUrl={auth.orgUrl} onDone={restart} />;
    if (!auth.signedIn) return <SignIn orgUrl={auth.orgUrl} reason={reason} onDone={restart} />;
    if (auth.needsToken) return <ConnectAzure orgUrl={auth.orgUrl} user={auth.user} reason={reason} onDone={restart} onSignOut={signOut} />;
  }
  return <Console key={session} authMode={auth.mode} onSignedOut={() => { setReason(null); setAuth((a) => ({ ...a, signedIn: false })); }} />;
}

function Console({ authMode, onSignedOut }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [drawer, setDrawer] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);

  const [live, setLive] = useState({ connected: false });
  const navigate = useNavigate();

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const dismiss = useCallback((id) => setToasts((list) => list.filter((x) => x.id !== id)), []);
  const toast = useCallback((text, tone = 'ok', { action, body, ttl = 4000 } = {}) => {
    const id = Math.random();
    setToasts((list) => [...list.slice(-4), { id, text, tone, action, body }]);
    setTimeout(() => dismiss(id), ttl);
  }, [dismiss]);

  // Where a notification or inbox entry leads.
  const openTarget = useCallback((target) => {
    if (!target) return;
    if (target.type === 'pr' || target.type === 'workitem' || (target.type === 'pipeline' && target.key)) setDrawer(target);
    else if (target.type === 'release') navigate('/pipelines?tab=releases');
    else if (target.type === 'pipeline' || target.type === 'approval') navigate('/pipelines');
    else if (target.type === 'person') navigate('/team');
    else if (target.type === 'production') navigate('/production');
  }, [navigate]);

  // Live updates: the server polls Azure DevOps and tells us when to refetch,
  // and what happened that's worth a notification.
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('status', (e) => setLive({ ...JSON.parse(e.data), connected: true }));
    es.addEventListener('changed', () => bump());
    es.addEventListener('notify', (e) => {
      const prefs = loadPrefs();
      const items = JSON.parse(e.data).items.filter((n) => prefs.categories[n.category] !== false);
      if (!items.length) return;
      if (items.length > 3) {
        const summary = t('{n} updates in Azure DevOps', { n: items.length });
        if (prefs.inApp) toast(summary, 'note', { body: items.slice(0, 3).map(noteTitle).join(' · '), action: { label: t('Open inbox'), onClick: () => navigate('/inbox') }, ttl: 10000 });
        showDesktop({ title: summary, body: items.slice(0, 4).map(noteTitle).join('\n'), tag: 'keel-batch', onClick: () => navigate('/inbox') });
        return;
      }
      for (const n of items) {
        const open = () => openTarget(n.target);
        if (prefs.inApp) toast(noteTitle(n), n.severity === 'high' ? 'alert' : 'note', { body: noteBody(n), action: n.target ? { label: t('Open'), onClick: open } : null, ttl: 10000 });
        showDesktop({ title: noteTitle(n), body: noteBody(n), tag: n.key, onClick: open });
      }
    });
    es.onerror = () => setLive((l) => ({ ...l, connected: false }));
    return () => es.close();
  }, [bump, toast, navigate, openTarget]);

  const loadMeta = useCallback(() => {
    api('/meta').then((m) => {
      // Preferences saved on your account win over this browser's copy.
      if (m.prefs && Object.keys(m.prefs).length) {
        if (adoptServerPrefs(m.prefs)) {
          applyTheme();
          applySavedLanguage();
        }
      } else {
        seedServerPrefs(m.prefs);
      }
      setMeta(m);
      setMetaError(null);
    }).catch(setMetaError);
  }, []);
  useEffect(loadMeta, [loadMeta, refreshKey]);

  // Fallback while the live connection is down: plain periodic refetching.
  useEffect(() => {
    if (live.connected || !meta?.refreshSeconds) return undefined;
    const timer = setInterval(() => document.visibilityState === 'visible' && bump(), meta.refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [live.connected, meta?.refreshSeconds, bump]);

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      onSignedOut();
    }
  }, [onSignedOut]);

  // What this person's role allows (the server enforces the same rules).
  const can = useCallback((perm) => !meta || (meta.permissions || []).includes(perm), [meta]);

  const ctx = useMemo(() => ({ meta, refreshKey, refresh: bump, openDrawer: setDrawer, openTarget, toast, live, authMode, signOut, can }), [meta, refreshKey, bump, toast, live, openTarget, authMode, signOut, can]);

  if (metaError && !meta) {
    return (
      <div className="boot">
        <ErrorBox error={metaError} onRetry={loadMeta} />
        <p className="muted">{tj("Check the terminal running the server. Common causes: an expired PAT, a wrong {orgUrl}, or the API server isn't running.", { orgUrl: <code>AZDO_ORG_URL</code> })}</p>
      </div>
    );
  }
  if (!meta) return <div className="boot"><Loading label={t('Connecting to Azure DevOps…')} /></div>;

  return (
    <AppContext.Provider value={ctx}>
      <Shell />
      <Drawer open={!!drawer} onClose={() => setDrawer(null)} label={t('Details')}>
        {drawer?.type === 'pr' && <PrDetail target={drawer} />}
        {drawer?.type === 'workitem' && <WorkItemDetail id={drawer.id} />}
        {drawer?.type === 'pipeline' && <PipelineDetail key={`${drawer.key}:${drawer.buildId || ''}`} target={drawer} />}
        {drawer?.type === 'newpr' && <NewPr key={JSON.stringify(drawer)} preset={drawer} />}
      </Drawer>
      <div className="toasts" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <div className="toast-text">
              <strong>{item.text}</strong>
              {item.body && <span className="toast-body">{item.body}</span>}
            </div>
            {item.action && <button type="button" className="toast-action" onClick={() => { item.action.onClick(); dismiss(item.id); }}>{item.action.label}</button>}
            {(item.action || item.body) && <button type="button" className="toast-close" aria-label={t('Dismiss')} onClick={() => dismiss(item.id)}>✕</button>}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

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

function Shell() {
  const { meta, refresh, toast, refreshKey, authMode, signOut, can } = useApp();
  const mainRef = useRef(null);
  useStableHeight(mainRef, refreshKey);
  const { data: attention } = useApi('/attention');
  const [spinning, setSpinning] = useState(false);
  const s = attention?.summary;

  // Browser tab title carries the "act now" count, so it shows on a background tab.
  useEffect(() => {
    document.title = s?.high ? `(${s.high}) Keel` : 'Keel';
  }, [s?.high]);

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

  // Grouped by what you're doing: today's triage, planning work, shipping code, the people.
  const nav = [
    { items: [
      { to: '/', label: t('Dashboard'), icon: 'dashboard', end: true },
      { to: '/inbox', label: t('Inbox'), icon: 'inbox', count: s?.high, tone: 'bad' },
    ] },
    { label: t('Work'), items: [
      { to: '/work', label: t('Work items'), icon: 'workItems' },
      { to: '/board', label: t('Board'), icon: 'board' },
      { to: '/epics', label: t('Epics'), icon: 'epics' },
    ] },
    { label: t('Code and delivery'), items: [
      { to: '/prs', label: t('Pull requests'), icon: 'pullRequests', count: s?.myReviews, tone: 'accent' },
      { to: '/pipelines', label: t('Pipelines'), icon: 'pipelines', count: (s?.approvals || 0) + (s?.failingPipelines || 0), tone: s?.failingPipelines ? 'bad' : 'accent' },
      { to: '/production', label: t('Production'), icon: 'production', count: s?.productionIssues, tone: 'bad' },
      { to: '/totals', label: t('Platform totals'), icon: 'totals' },
    ] },
    { label: t('People'), items: [
      { to: '/team', label: t('Team'), icon: 'team' },
      { to: '/insights', label: t('Insights'), icon: 'insights' },
      ...(authMode === 'login' && can('users.manage') ? [{ to: '/users', label: t('Users'), icon: 'users' }] : []),
    ] },
  ];

  return (
    <div className="shell">
      <nav className="sidebar" aria-label={t('Main')}>
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">Keel</div>
            <div className="brand-org truncate" title={meta.orgUrl}>{meta.orgUrl.replace(/^https?:\/\//, '')}</div>
          </div>
        </div>
        <div className="nav-groups">
          {nav.map((group, i) => (
            <div key={group.label || i} className="nav-group">
              {group.label && <div className="nav-group-label" id={`nav-group-${i}`}>{group.label}</div>}
              <ul className="nav" aria-labelledby={group.label ? `nav-group-${i}` : undefined}>
                {group.items.map((n) => (
                  <li key={n.to}>
                    <NavLink to={n.to} end={n.end} className="nav-link">
                      <span className="nav-label"><Icon name={n.icon} />{n.label}</span>
                      {n.count > 0 && <span className={`nav-count nav-count-${n.tone}`} title={t(n.count === 1 ? '{n} needs attention' : '{n} need attention', { n: n.count })}>{n.count}</span>}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <NavLink to="/settings" className="nav-link"><span className="nav-label"><Icon name="settings" />{t('Settings')}</span></NavLink>
          <button type="button" className="btn btn-ghost btn-small refresh-btn" onClick={hardRefresh} disabled={spinning}>
            <span className={spinning ? 'spin' : ''}><Icon name="refresh" size={14} /></span> {t('Refresh from Azure DevOps')}
          </button>
          <LiveStatus />
          {authMode === 'login' && <button type="button" className="btn btn-ghost btn-small signout-btn" onClick={signOut}><Icon name="signOut" size={14} /> {t('Sign out')}</button>}
          <div className="me truncate" title={meta.account ? `${meta.account.email} · Azure DevOps: ${meta.me.displayName}` : meta.me.uniqueName}>
            {t('Signed in as {name}', { name: meta.account?.name || meta.me.displayName })}
            {authMode === 'login' && <span className="role-badge">{{ admin: 'Admin', developer: 'Developer', pm: 'PM' }[meta.role]}</span>}
          </div>
        </div>
      </nav>

      <main className="main" ref={mainRef}>
        {meta.mock && (
          <div className="demo-banner">
            {tj("You're looking at demo data ({reason}). Add {orgUrl} and {pat} to {env} and restart to connect your organization.", {
              reason: tx(meta.mockReason), orgUrl: <code>AZDO_ORG_URL</code>, pat: <code>AZDO_PAT</code>, env: <code>.env</code>,
            })}
          </div>
        )}
        {!meta.trackedProjects.length && (
          <div className="demo-banner">
            {tj('No projects tracked yet. {link} to fill the console.', { link: <NavLink to="/settings">{t('Choose your projects and repos')}</NavLink> })}
          </div>
        )}
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/prs" element={<PullRequests />} />
          <Route path="/work" element={<WorkItems />} />
          <Route path="/board" element={<Board />} />
          <Route path="/sprint" element={<Navigate to="/board?mode=sprint" replace />} />
          <Route path="/epics" element={<Epics />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/production" element={<Production />} />
          <Route path="/totals" element={<Totals />} />
          <Route path="/totals/:id" element={<Totals />} />
          <Route path="/team" element={<Team />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/users" element={<Users />} />
          {/* Release notes is hidden for now (pages/ReleaseNotes.jsx is kept); old links and unknown paths go home. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** "Live · checked 12s ago", or why live updates are paused. */
function LiveStatus() {
  const { live } = useApp();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  const ago = live.lastPollAt ? Math.max(0, Math.round((Date.now() - Date.parse(live.lastPollAt)) / 1000)) : null;
  let tone = 'ok';
  let text = ago === null ? t('Live · checking…')
    : ago < 60 ? t('Live · checked {n}s ago', { n: ago })
      : t('Live · checked {n}m ago', { n: Math.round(ago / 60) });
  let title = t('Checks Azure DevOps every {n}s while the console is open', { n: live.intervalSeconds || '…' });
  if (!live.connected) {
    tone = 'warn';
    text = t('Reconnecting…');
    title = t('Lost the live connection to the server. Retrying every few seconds.');
  } else if (!live.ok && live.error) {
    tone = 'bad';
    text = t("Can't reach Azure DevOps");
    title = tx(live.error);
  }
  return <div className={`live live-${tone}`} title={title}><span className="live-dot" aria-hidden="true" />{text}</div>;
}
