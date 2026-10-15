import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { ErrorBox, Loading, PageHeader } from '../ui.jsx';
import { CATEGORIES, desktopPermission, desktopSupported, loadPrefs, requestDesktop, savePrefs, showDesktop } from '../notify.js';

const THRESHOLDS = [
  ['myReviewHours', 'Escalate a review waiting on me after', 'hours'],
  ['prNoReviewHours', 'Flag a PR with no approvals after', 'hours'],
  ['stalePrDays', 'Call a PR stale after', 'days'],
  ['itemStuckDays', 'Flag an in-progress item with no updates after', 'days'],
  ['buildLookbackDays', 'Judge pipeline health over the last', 'days'],
  ['maxInProgressPerPerson', 'Flag a person with more items in progress than', 'items'],
  ['maxPendingReviewsPerPerson', 'Flag a person owing more reviews than', 'reviews'],
];

const MERGE = [
  ['squash', 'Squash commit'],
  ['noFastForward', 'Merge (no fast-forward)'],
  ['rebase', 'Rebase and fast-forward'],
  ['rebaseMerge', 'Semi-linear merge'],
];

// Older settings stored a single team as teamId/teamName.
const teamsOf = (cfg = {}) => (Array.isArray(cfg.teams) ? cfg.teams : cfg.teamId ? [{ id: cfg.teamId, name: cfg.teamName }] : []);

export default function Settings() {
  const { data, error, reload } = useApi('/settings');
  const { refresh, toast } = useApp();
  const [draft, setDraft] = useState(null);
  const [options, setOptions] = useState({});
  const [saving, setSaving] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');

  useEffect(() => {
    if (data && !draft) setDraft(structuredClone(data.settings));
  }, [data, draft]);

  const tracked = draft ? Object.entries(draft.projects).filter(([, p]) => p.tracked).map(([id]) => id) : [];
  useEffect(() => {
    for (const id of tracked) {
      if (options[id]) continue;
      setOptions((o) => ({ ...o, [id]: 'loading' }));
      api(`/settings/projects/${encodeURIComponent(id)}`)
        .then((res) => setOptions((o) => ({ ...o, [id]: res })))
        .catch((e) => setOptions((o) => ({ ...o, [id]: { error: e.message } })));
    }
  }, [tracked.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !draft) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const setProject = (id, patch) => setDraft((d) => ({
    ...d,
    projects: { ...d.projects, [id]: { name: data.projects.find((p) => p.id === id)?.name, repos: 'all', scopeToTeamArea: false, ...d.projects[id], ...patch } },
  }));
  // Tracked projects first (by what was saved, so rows don't jump while you
  // edit), then matches for the search box; big orgs have hundreds of projects.
  const needle = projectQuery.trim().toLowerCase();
  const savedTracked = (p) => !!data.settings.projects[p.id]?.tracked;
  const pinned = data.projects.filter((p) => savedTracked(p) || draft.projects[p.id]?.tracked);
  const rest = data.projects.filter((p) => !pinned.includes(p) && (!needle || p.name.toLowerCase().includes(needle)));
  const shownProjects = [...pinned.filter((p) => !needle || p.name.toLowerCase().includes(needle)), ...rest.slice(0, needle ? 50 : 15)];
  const hiddenCount = data.projects.length - shownProjects.length - (needle ? pinned.filter((p) => !p.name.toLowerCase().includes(needle)).length : 0);

  const setThreshold =(k, v) => setDraft((d) => ({ ...d, thresholds: { ...d.thresholds, [k]: Number(v) } }));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api('/settings', { method: 'PUT', body: draft });
      setDraft(structuredClone(saved));
      toast('Settings saved');
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page settings">
      <PageHeader title="Settings" sub="Choose what the console watches and when it should raise a flag. Saved on this machine in data/.">
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
      </PageHeader>

      <section className="panel">
        <h2 className="section-title">Projects and repositories</h2>
        <p className="muted small">Pick the teams you lead in each project. Their members appear on the Team page and each team's sprint is on the Sprint page. If the project is shared with other teams, you can limit work items to your teams' area paths.</p>
        <input
          type="search" className="input project-search" placeholder={`Search ${data.projects.length} projects`}
          value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} aria-label="Search projects"
        />
        <ul className="project-list">
          {shownProjects.map((p) => {
            const cfg = draft.projects[p.id] || {};
            const opt = options[p.id];
            return (
              <li key={p.id} className={cfg.tracked ? 'tracked' : ''}>
                <label className="check strong"><input type="checkbox" checked={!!cfg.tracked} onChange={(e) => setProject(p.id, { tracked: e.target.checked })} /> {p.name}</label>
                {p.description && <span className="muted small"> {p.description}</span>}
                {cfg.tracked && (
                  opt === 'loading' || !opt ? <Loading label="Loading teams and repos…" /> : opt.error ? <p className="text-bad small">{opt.error}</p> : (
                    <div className="project-config">
                      <fieldset className="repo-pick">
                        <legend>Teams <span className="muted small">{teamsOf(cfg).length ? `${teamsOf(cfg).length} selected` : 'none: no sprint or team members'}</span></legend>
                        <div className="repo-group">
                          {opt.teams.map((t) => {
                            const selected = teamsOf(cfg);
                            const on = selected.some((s) => s.id === t.id);
                            return (
                              <label key={t.id} className="check">
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={(e) => setProject(p.id, {
                                    teams: e.target.checked ? [...selected, { id: t.id, name: t.name }] : selected.filter((s) => s.id !== t.id),
                                    teamId: undefined,
                                    teamName: undefined,
                                  })}
                                /> {t.name}
                              </label>
                            );
                          })}
                        </div>
                        <label className="check"><input type="checkbox" disabled={!teamsOf(cfg).length} checked={!!cfg.scopeToTeamArea} onChange={(e) => setProject(p.id, { scopeToTeamArea: e.target.checked })} /> Only work items in these teams' area paths</label>
                      </fieldset>
                      <div className="repo-pick">
                        <label className="check"><input type="radio" name={`repos-${p.id}`} checked={cfg.repos === 'all' || !Array.isArray(cfg.repos)} onChange={() => setProject(p.id, { repos: 'all' })} /> All repos ({opt.repos.length})</label>
                        <label className="check"><input type="radio" name={`repos-${p.id}`} checked={Array.isArray(cfg.repos)} onChange={() => setProject(p.id, { repos: opt.repos.map((r) => r.id) })} /> Only these:</label>
                        {Array.isArray(cfg.repos) && (
                          <div className="repo-group">
                            {opt.repos.map((r) => (
                              <label key={r.id} className="check">
                                <input type="checkbox" checked={cfg.repos.includes(r.id)} onChange={(e) => setProject(p.id, { repos: e.target.checked ? [...cfg.repos, r.id] : cfg.repos.filter((x) => x !== r.id) })} /> {r.name}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
        {hiddenCount > 0 && <p className="muted small">{hiddenCount} more project{hiddenCount === 1 ? '' : 's'}. Search to find them.</p>}
      </section>

      <section className="panel">
        <h2 className="section-title">When to flag things</h2>
        <div className="threshold-list">
          {THRESHOLDS.map(([k, label, unit]) => (
            <label key={k} className="threshold">
              <span>{label}</span>
              <span className="threshold-input"><input type="number" min={1} className="input" value={draft.thresholds[k]} onChange={(e) => setThreshold(k, e.target.value)} /> {unit}</span>
            </label>
          ))}
          <label className="threshold">
            <span>Treat work items with this tag or state as blocked</span>
            <span className="threshold-input"><input className="input" value={draft.blockedTag} onChange={(e) => setDraft((d) => ({ ...d, blockedTag: e.target.value }))} /></span>
          </label>
          <label className="threshold">
            <span>Check Azure DevOps for changes every <span className="muted small">(only while the console is open; 15–600)</span></span>
            <span className="threshold-input"><input type="number" min={15} max={600} className="input" value={draft.refreshSeconds} onChange={(e) => setDraft((d) => ({ ...d, refreshSeconds: Number(e.target.value) }))} /> seconds</span>
          </label>
        </div>
      </section>

      <NotificationSettings />

      <section className="panel">
        <h2 className="section-title">Auto-complete defaults</h2>
        <p className="muted small">Used when you set auto-complete on a pull request from the console.</p>
        <div className="form-row">
          <label>Merge type
            <select className="input" value={draft.autoComplete.mergeStrategy} onChange={(e) => setDraft((d) => ({ ...d, autoComplete: { ...d.autoComplete, mergeStrategy: e.target.value } }))}>
              {MERGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={draft.autoComplete.deleteSourceBranch} onChange={(e) => setDraft((d) => ({ ...d, autoComplete: { ...d.autoComplete, deleteSourceBranch: e.target.checked } }))} /> Delete source branch</label>
          <label className="check"><input type="checkbox" checked={draft.autoComplete.transitionWorkItems} onChange={(e) => setDraft((d) => ({ ...d, autoComplete: { ...d.autoComplete, transitionWorkItems: e.target.checked } }))} /> Complete linked work items</label>
        </div>
      </section>
    </div>
  );
}

/** Per-browser notification preferences; saved as you change them. */
function NotificationSettings() {
  const { toast } = useApp();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [permission, setPermission] = useState(desktopPermission);
  const update = (patch) => setPrefs((p) => {
    const next = { ...p, ...patch, categories: { ...p.categories, ...patch.categories } };
    savePrefs(next);
    return next;
  });

  const turnOnDesktop = async () => {
    const result = await requestDesktop();
    setPermission(result);
    if (result === 'granted') update({ desktop: true });
    else toast(result === 'denied' ? 'Desktop notifications are blocked for this site in your browser settings' : "Desktop notifications weren't enabled", 'bad');
  };

  const test = () => {
    toast('This is how notifications look', 'note', { body: 'Approvals, reviews and failures show up like this.', ttl: 6000 });
    if (prefs.desktop && permission === 'granted') {
      // Show it even while the tab is in front, so you can see it right away.
      const saved = prefs.onlyWhenHidden;
      savePrefs({ ...prefs, onlyWhenHidden: false });
      showDesktop({ title: 'Lead Console', body: 'Desktop notifications are on.', tag: 'lead-console-test' });
      savePrefs({ ...prefs, onlyWhenHidden: saved });
    }
  };

  return (
    <section className="panel">
      <h2 className="section-title">Notifications</h2>
      <p className="muted small">Saved in this browser right away. The console needs to be open (a background tab is fine) to notify you.</p>
      <div className="notify-grid">
        <label className="check"><input type="checkbox" checked={prefs.inApp} onChange={(e) => update({ inApp: e.target.checked })} /> Show a pop-up in the console</label>
        <div className="notify-desktop">
          {!desktopSupported() ? <span className="muted small">This browser doesn't support desktop notifications.</span>
            : permission === 'granted' ? (
              <label className="check"><input type="checkbox" checked={prefs.desktop} onChange={(e) => update({ desktop: e.target.checked })} /> Desktop notifications</label>
            ) : permission === 'denied' ? (
              <span className="small text-warn">Desktop notifications are blocked for this site. Allow them in your browser's site settings, then reload.</span>
            ) : (
              <button type="button" className="btn btn-small" onClick={turnOnDesktop}>Turn on desktop notifications</button>
            )}
        </div>
        {permission === 'granted' && prefs.desktop && (
          <label className="check"><input type="checkbox" checked={prefs.onlyWhenHidden} onChange={(e) => update({ onlyWhenHidden: e.target.checked })} /> Only on the desktop when the console isn't in front</label>
        )}
      </div>
      <h3 className="small notify-h">Notify me about</h3>
      <div className="notify-cats">
        {CATEGORIES.map((c) => (
          <label key={c.id} className="check"><input type="checkbox" checked={prefs.categories[c.id] !== false} onChange={(e) => update({ categories: { [c.id]: e.target.checked } })} /> {c.label}</label>
        ))}
      </div>
      <button type="button" className="btn btn-small btn-ghost" onClick={test}>Send a test notification</button>
    </section>
  );
}
