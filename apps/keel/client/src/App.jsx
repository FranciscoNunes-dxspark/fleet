import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { AppContext, useApi, useApp } from './context.js';
import { Drawer, ErrorBox, Loading } from './ui.jsx';
import { loadPrefs, showDesktop } from './notify.js';
import Inbox from './pages/Inbox.jsx';
import PullRequests from './pages/PullRequests.jsx';
import PrDetail from './pages/PrDetail.jsx';
import WorkItems from './pages/WorkItems.jsx';
import WorkItemDetail from './pages/WorkItemDetail.jsx';
import NewPr from './pages/NewPr.jsx';
import Board from './pages/Board.jsx';
import Epics from './pages/Epics.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Pipelines from './pages/Pipelines.jsx';
import Team from './pages/Team.jsx';
import Insights from './pages/Insights.jsx';
import ReleaseNotes from './pages/ReleaseNotes.jsx';
import Settings from './pages/Settings.jsx';
import SignIn from './pages/SignIn.jsx';

/**
 * Auth gate. In login mode (hosted), shows sign-in until there's a session,
 * and again whenever the server says the session ended or the token was
 * rejected. In local mode it's a pass-through.
 */
export default function App() {
  const [auth, setAuth] = useState(null);
  const [reason, setReason] = useState(null);
  const [session, setSession] = useState(0);

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
    window.addEventListener('lc:signed-out', onSignedOut);
    return () => window.removeEventListener('lc:signed-out', onSignedOut);
  }, []);

  if (!auth) return <div className="boot"><Loading label="Starting…" /></div>;
  if (auth.mode === 'login' && !auth.signedIn) {
    return (
      <SignIn
        orgUrl={auth.orgUrl}
        reason={reason}
        onSignedIn={() => {
          setReason(null);
          setSession((n) => n + 1); // fresh console state for the new session
          check();
        }}
      />
    );
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
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((text, tone = 'ok', { action, body, ttl = 4000 } = {}) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-4), { id, text, tone, action, body }]);
    setTimeout(() => dismiss(id), ttl);
  }, [dismiss]);

  // Where a notification or inbox entry leads.
  const openTarget = useCallback((target) => {
    if (!target) return;
    if (target.type === 'pr' || target.type === 'workitem') setDrawer(target);
    else if (target.type === 'release') navigate('/pipelines?tab=releases');
    else if (target.type === 'pipeline' || target.type === 'approval') navigate('/pipelines');
    else if (target.type === 'person') navigate('/team');
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
        const summary = `${items.length} updates in Azure DevOps`;
        if (prefs.inApp) toast(summary, 'note', { body: items.slice(0, 3).map((n) => n.title).join(' · '), action: { label: 'Open inbox', onClick: () => navigate('/inbox') }, ttl: 10000 });
        showDesktop({ title: summary, body: items.slice(0, 4).map((n) => n.title).join('\n'), tag: 'lead-console-batch', onClick: () => navigate('/inbox') });
        return;
      }
      for (const n of items) {
        const open = () => openTarget(n.target);
        if (prefs.inApp) toast(n.title, n.severity === 'high' ? 'alert' : 'note', { body: n.body, action: n.target ? { label: 'Open', onClick: open } : null, ttl: 10000 });
        showDesktop({ title: n.title, body: n.body, tag: n.key, onClick: open });
      }
    });
    es.onerror = () => setLive((l) => ({ ...l, connected: false }));
    return () => es.close();
  }, [bump, toast, navigate, openTarget]);

  const loadMeta = useCallback(() => {
    api('/meta').then((m) => { setMeta(m); setMetaError(null); }).catch(setMetaError);
  }, []);
  useEffect(loadMeta, [loadMeta, refreshKey]);

  // Fallback while the live connection is down: plain periodic refetching.
  useEffect(() => {
    if (live.connected || !meta?.refreshSeconds) return undefined;
    const t = setInterval(() => document.visibilityState === 'visible' && bump(), meta.refreshSeconds * 1000);
    return () => clearInterval(t);
  }, [live.connected, meta?.refreshSeconds, bump]);

  const signOut = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      onSignedOut();
    }
  }, [onSignedOut]);

  const ctx = useMemo(() => ({ meta, refreshKey, refresh: bump, openDrawer: setDrawer, openTarget, toast, live, authMode, signOut }), [meta, refreshKey, bump, toast, live, openTarget, authMode, signOut]);

  if (metaError && !meta) {
    return (
      <div className="boot">
        <ErrorBox error={metaError} onRetry={loadMeta} />
        <p className="muted">Check the terminal running the server. Common causes: an expired PAT, a wrong <code>AZDO_ORG_URL</code>, or the API server isn't running.</p>
      </div>
    );
  }
  if (!meta) return <div className="boot"><Loading label="Connecting to Azure DevOps…" /></div>;

  return (
    <AppContext.Provider value={ctx}>
      <Shell />
      <Drawer open={!!drawer} onClose={() => setDrawer(null)} label="Details">
        {drawer?.type === 'pr' && <PrDetail target={drawer} />}
        {drawer?.type === 'workitem' && <WorkItemDetail id={drawer.id} />}
        {drawer?.type === 'newpr' && <NewPr key={JSON.stringify(drawer)} preset={drawer} />}
      </Drawer>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <div className="toast-text">
              <strong>{t.text}</strong>
              {t.body && <span className="toast-body">{t.body}</span>}
            </div>
            {t.action && <button type="button" className="toast-action" onClick={() => { t.action.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
            {(t.action || t.body) && <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>✕</button>}
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
  const { meta, refresh, toast, refreshKey, authMode, signOut } = useApp();
  const mainRef = useRef(null);
  useStableHeight(mainRef, refreshKey);
  const { data: attention } = useApi('/attention');
  const [spinning, setSpinning] = useState(false);
  const s = attention?.summary;

  // Browser tab title carries the "act now" count, so it shows on a background tab.
  useEffect(() => {
    document.title = s?.high ? `(${s.high}) Lead Console` : 'Lead Console';
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

  const nav = [
    { to: '/', label: 'Dashboard', end: true },
    { to: '/inbox', label: 'Inbox', count: s?.high, tone: 'bad' },
    { to: '/prs', label: 'Pull requests', count: s?.myReviews, tone: 'accent' },
    { to: '/work', label: 'Work items' },
    { to: '/board', label: 'Board' },
    { to: '/epics', label: 'Epics' },
    { to: '/pipelines', label: 'Pipelines', count: (s?.approvals || 0) + (s?.failingPipelines || 0), tone: s?.failingPipelines ? 'bad' : 'accent' },
    { to: '/team', label: 'Team' },
    { to: '/insights', label: 'Insights' },
    { to: '/release-notes', label: 'Release notes' },
  ];

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <div className="brand-name">Lead Console</div>
            <div className="brand-org truncate" title={meta.orgUrl}>{meta.orgUrl.replace(/^https?:\/\//, '')}</div>
          </div>
        </div>
        <ul className="nav">
          {nav.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.end} className="nav-link">
                <span>{n.label}</span>
                {n.count > 0 && <span className={`nav-count nav-count-${n.tone}`} title={`${n.count} need attention`}>{n.count}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          <NavLink to="/settings" className="nav-link"><span>Settings</span></NavLink>
          <button type="button" className="btn btn-ghost btn-small refresh-btn" onClick={hardRefresh} disabled={spinning}>
            <span className={spinning ? 'spin' : ''} aria-hidden="true">↻</span> Refresh from Azure DevOps
          </button>
          <LiveStatus />
          {authMode === 'login' && <button type="button" className="btn btn-ghost btn-small signout-btn" onClick={signOut}>Sign out</button>}
          <div className="me truncate" title={meta.me.uniqueName}>Signed in as {meta.me.displayName}</div>
        </div>
      </nav>

      <main className="main" ref={mainRef}>
        {meta.mock && (
          <div className="demo-banner">
            You're looking at demo data ({meta.mockReason}). Add <code>AZDO_ORG_URL</code> and <code>AZDO_PAT</code> to <code>.env</code> and restart to connect your organization.
          </div>
        )}
        {!meta.trackedProjects.length && (
          <div className="demo-banner">
            No projects tracked yet. <NavLink to="/settings">Choose your projects and repos</NavLink> to fill the console.
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
          <Route path="/team" element={<Team />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/release-notes" element={<ReleaseNotes />} />
          <Route path="/settings" element={<Settings />} />
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
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const ago = live.lastPollAt ? Math.max(0, Math.round((Date.now() - Date.parse(live.lastPollAt)) / 1000)) : null;
  const agoText = ago === null ? 'checking…' : ago < 60 ? `checked ${ago}s ago` : `checked ${Math.round(ago / 60)}m ago`;
  let tone = 'ok';
  let text = `Live · ${agoText}`;
  let title = `Checks Azure DevOps every ${live.intervalSeconds || '…'}s while the console is open`;
  if (!live.connected) {
    tone = 'warn';
    text = 'Reconnecting…';
    title = 'Lost the live connection to the server. Retrying every few seconds.';
  } else if (!live.ok && live.error) {
    tone = 'bad';
    text = "Can't reach Azure DevOps";
    title = live.error;
  }
  return <div className={`live live-${tone}`} title={title}><span className="live-dot" aria-hidden="true" />{text}</div>;
}
