import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { AppContext, forgetApiCache } from './context.js';
import { Drawer, ErrorBox, Loading } from './ui.jsx';
import { loadPrefs, showDesktop } from './notify.js';
import { CommandPalette } from './palette.jsx';
import LineShell from './line/LineShell.jsx';
import { LineHome, StageCards } from './line/Line.jsx';
import { ConnectAzure, LinkAccept, SetupScreen as Setup, SignIn } from './pages/AuthScreens.jsx';
import { adoptServerPrefs, seedServerPrefs } from './prefs.js';
import { loadHome } from './home.js';
import { applyTheme } from './theme.js';
import { applySavedLanguage, getLanguage, t, tj, tx } from './i18n.js';

// Each page and each details view is its own chunk, fetched the first time it's opened: the first
// load carries the frame and the Line (the usual home), not the whole app.
const Inbox = lazy(() => import('./pages/Inbox.jsx'));
const PullRequests = lazy(() => import('./pages/PullRequests.jsx'));
const PrDetail = lazy(() => import('./pages/PrDetail.jsx'));
const WorkItems = lazy(() => import('./pages/WorkItems.jsx'));
const WorkItemDetail = lazy(() => import('./pages/WorkItemDetail.jsx'));
const PipelineDetail = lazy(() => import('./pages/PipelineDetail.jsx'));
const Commits = lazy(() => import('./pages/Commits.jsx'));
const CommitDetail = lazy(() => import('./pages/CommitDetail.jsx'));
const DeployDetail = lazy(() => import('./pages/DeployDetail.jsx'));
const Summary = lazy(() => import('./pages/Summary.jsx'));
const NewWorkItem = lazy(() => import('./pages/NewWorkItem.jsx'));
const NewPr = lazy(() => import('./pages/NewPr.jsx'));
const Board = lazy(() => import('./pages/Board.jsx'));
const Epics = lazy(() => import('./pages/Epics.jsx'));
const NotFound = lazy(() => import('./pages/NotFound.jsx'));
const Pipelines = lazy(() => import('./pages/Pipelines.jsx'));
const Production = lazy(() => import('./pages/Production.jsx'));
const Totals = lazy(() => import('./pages/Totals.jsx'));
const Shipping = lazy(() => import('./pages/Shipping.jsx'));
const ReleaseNotes = lazy(() => import('./pages/ReleaseNotes.jsx'));
const Team = lazy(() => import('./pages/Team.jsx'));
const Insights = lazy(() => import('./pages/Insights.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Users = lazy(() => import('./pages/Users.jsx'));
const TerminalSignIn = lazy(() => import('./pages/TerminalSignIn.jsx'));
const Desk = lazy(() => import('./line/Desk.jsx'));
const Control = lazy(() => import('./line/Control.jsx'));
const People = lazy(() => import('./line/People.jsx'));
const Standup = lazy(() => import('./line/Standup.jsx'));

// Once the app is idle, fetch the details views people open most, so the first click opens at once.
const warmDetails = () => { import('./pages/PrDetail.jsx'); import('./pages/WorkItemDetail.jsx'); import('./pages/PipelineDetail.jsx'); };

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
      forgetApiCache(); // the next person to sign in on this browser starts from their own data
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
  return <Console key={session} authMode={auth.mode} onSignedOut={() => { forgetApiCache(); setReason(null); setAuth((a) => ({ ...a, signedIn: false })); }} />;
}

function Console({ authMode, onSignedOut }) {
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(warmDetails);
  }, []);
  const [drawer, setDrawer] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);

  const [live, setLive] = useState({ connected: false });
  const navigate = useNavigate();

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);
  const dismiss = useCallback((id) => setToasts((list) => list.filter((x) => x.id !== id)), []);
  // An error stays longer than a confirmation: it's the one you have to read.
  const toast = useCallback((text, tone = 'ok', { action, body, ttl = tone === 'bad' ? 9000 : 4000 } = {}) => {
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
    else if (target.type === 'line') navigate(`/line/${target.stage}`);
    else if (target.type === 'advisory') navigate('/insights?tab=advisories');
  }, [navigate]);

  // A tapped push notification (public/sw.js) leads to a page, with ?open= naming the PR or work item to show.
  const { pathname: here, search: query } = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(query);
    const raw = params.get('open');
    if (!raw) return;
    params.delete('open');
    navigate({ pathname: here, search: params.toString() ? `?${params}` : '' }, { replace: true });
    try {
      const target = JSON.parse(raw);
      // Only plain values: it came from a link.
      if (target && typeof target === 'object') openTarget(Object.fromEntries(Object.entries(target).filter(([, v]) => ['string', 'number'].includes(typeof v))));
    } catch {
      // Not a target: just the page.
    }
  }, [here, query, navigate, openTarget]);
  // With Keel already open, the service worker asks it to go there instead of opening another window.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (e) => {
      if (e.data?.type === 'keel:open' && typeof e.data.path === 'string' && e.data.path.startsWith('/') && !e.data.path.startsWith('//')) navigate(e.data.path);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
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

  // Back online after starting without a connection: try again.
  useEffect(() => {
    const retry = () => {
      if (!meta) loadMeta();
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [meta, loadMeta]);

  // What this person's role allows (the server enforces the same rules).
  const can = useCallback((perm) => !meta || (meta.permissions || []).includes(perm), [meta]);

  // The details panel always opens over the page, which stays put behind it: docked beside the
  // page it pushed the page aside and left two scrollbars side by side. Lists still mark the row
  // it shows (`drawer`); `docked` stays in the context for the pages that read it.
  const docked = false;
  const ctx = useMemo(() => ({ meta, refreshKey, refresh: bump, openDrawer: setDrawer, drawer, docked, openTarget, toast, live, authMode, signOut, can }), [meta, refreshKey, bump, drawer, docked, toast, live, openTarget, authMode, signOut, can]);

  if (metaError && !meta) {
    // The installed app opened with no connection: say so, and connect when it's back (below).
    if (navigator.onLine === false) {
      return (
        <div className="boot">
          <p>{t("You're offline")}</p>
          <p className="muted">{t('Keel will connect again when you are back online.')}</p>
        </div>
      );
    }
    return (
      <div className="boot">
        <ErrorBox error={metaError} onRetry={loadMeta} />
        <p className="muted">{tj("Check the terminal running the server. Common causes: an expired PAT, a wrong {orgUrl}, or the API server isn't running.", { orgUrl: <code>AZDO_ORG_URL</code> })}</p>
      </div>
    );
  }
  if (!meta) return <div className="boot"><Loading label={t('Connecting to Azure DevOps…')} /></div>;

  // Where `keel login` sends you: just the question, like the sign-in screen, with nothing to wander off to.
  if (here === '/terminal') {
    return (
      <AppContext.Provider value={ctx}>
        <Suspense fallback={<div className="boot"><Loading /></div>}><TerminalSignIn /></Suspense>
      </AppContext.Provider>
    );
  }
  return (
    <AppContext.Provider value={ctx}>
      <LineShell>
        <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Navigate to={loadHome()} replace />} />
          <Route path="/line" element={<LineHome />} />
          <Route path="/line/:stage" element={<StageCards />} />
          <Route path="/desk" element={<Desk />} />
          <Route path="/control" element={<Control />} />
          {/* The Dashboard's widgets became the Line; old links to it go home. */}
          <Route path="/dashboard" element={<Navigate to="/" replace />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/summary" element={<Summary />} />
          <Route path="/prs" element={<PullRequests />} />
          <Route path="/commits" element={<Commits />} />
          <Route path="/release-notes" element={<ReleaseNotes />} />
          <Route path="/work" element={<WorkItems />} />
          <Route path="/board" element={<Board />} />
          <Route path="/sprint" element={<Navigate to="/board?mode=sprint" replace />} />
          <Route path="/epics" element={<Epics />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/production" element={<Production />} />
          <Route path="/ship" element={<Shipping />} />
          <Route path="/totals" element={<Totals />} />
          <Route path="/totals/:id" element={<Totals />} />
          <Route path="/team" element={<Team />} />
          <Route path="/people" element={<People />} />
          <Route path="/standup" element={<Standup />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/users" element={<Users />} />
          {/* Unknown paths get a page saying so. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </LineShell>
      <CommandPalette />
      <Drawer open={!!drawer} onClose={() => setDrawer(null)} label={t('Details')} docked={docked}>
        <Suspense fallback={<Loading />}>
        {drawer?.type === 'pr' && <PrDetail target={drawer} />}
        {drawer?.type === 'workitem' && <WorkItemDetail key={`${drawer.org || ''}:${drawer.id}`} id={drawer.id} org={drawer.org} />}
        {drawer?.type === 'pipeline' && <PipelineDetail key={`${drawer.key}:${drawer.buildId || ''}`} target={drawer} />}
        {drawer?.type === 'commit' && <CommitDetail key={`${drawer.repoId}:${drawer.id}`} target={drawer} />}
        {drawer?.type === 'deploy' && <DeployDetail key={`${drawer.target}:${drawer.id}`} target={drawer} />}
        {drawer?.type === 'newpr' && <NewPr key={JSON.stringify(drawer)} preset={drawer} />}
        {drawer?.type === 'newworkitem' && <NewWorkItem key={JSON.stringify(drawer)} preset={drawer} />}
        </Suspense>
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

