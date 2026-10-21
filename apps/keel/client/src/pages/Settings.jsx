import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { ErrorBox, Loading, PageHeader, Confirm, Section } from '../ui.jsx';
import { ACCENTS, MODES, loadTheme, saveTheme } from '../theme.js';
import { LANGUAGES, getLanguage, setLanguage, t, tj, tx } from '../i18n.js';
import ProductionSettings from './ProductionSettings.jsx';
import TypeColorSettings from './TypeColorSettings.jsx';
import OrgSettings from './OrgSettings.jsx';
import ChannelSettings from './ChannelSettings.jsx';
import { useOrgKind, useProjectLabel } from '../orgs.js';
import { age, dateTime } from '../format.js';
import { folderProblem, loadFolders, saveFolder } from '../claude.js';
import { CATEGORIES, desktopPermission, desktopSupported, loadPrefs, requestDesktop, savePrefs, showDesktop } from '../notify.js';
import { canPromptInstall, currentSubscription, deviceId, disablePush, enablePush, isInstalled, promptInstall, pushAvailability } from '../pwa.js';

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
  const projectLabel = useProjectLabel();
  const orgKind = useOrgKind();
  const { refresh, toast } = useApp();
  const [draft, setDraft] = useState(null);
  const [options, setOptions] = useState({});
  const [saving, setSaving] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  // Projects whose teams and repos are open for editing (a project you just ticked opens).
  const [openProjects, setOpenProjects] = useState(() => new Set());
  const toggleProject = (id, force) => setOpenProjects((o) => {
    const next = new Set(o);
    if (force ?? !next.has(id)) next.add(id);
    else next.delete(id);
    return next;
  });

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

  /** "1 team · all repos (4) · team areas only", from the draft and what Azure DevOps listed. */
  const projectSummary = (cfg, opt, github = false) => {
    const teams = teamsOf(cfg).length;
    const parts = github ? [] : [teams ? t(teams === 1 ? '1 team' : '{n} teams', { n: teams }) : t('No team')];
    const total = opt && opt !== 'loading' && !opt.error ? opt.repos.length : null;
    if (Array.isArray(cfg.repos)) parts.push(total != null ? t('{n} of {total} repos', { n: cfg.repos.length, total }) : t(cfg.repos.length === 1 ? '1 repo' : '{n} repos', { n: cfg.repos.length }));
    else parts.push(total != null ? t('All repos ({n})', { n: total }) : t('All repos'));
    if (cfg.scopeToTeamArea && teams) parts.push(t('team areas only'));
    return parts.join(' · ');
  };

  const setThreshold =(k, v) => setDraft((d) => ({ ...d, thresholds: { ...d.thresholds, [k]: Number(v) } }));
  // Projects, flags and auto-complete save together, from the bar at the bottom.
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api('/settings', { method: 'PUT', body: draft });
      setDraft(structuredClone(saved));
      toast(t('Settings saved'));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page settings">
      <PageHeader title={t('Settings')} sub={t('Choose what the console watches and when it should raise a flag.')} />

      <Section id="projects" title={t('Projects and repositories')}>
        <p className="muted small">{t("Pick the teams you lead in each project. Their members appear on the Team page and each team's sprint is on the Sprint page. If the project is shared with other teams, you can limit work items to your teams' area paths.")}</p>
        <input
          type="search" className="input project-search" placeholder={t(data.projects.length === 1 ? 'Search {n} project' : 'Search {n} projects', { n: data.projects.length })}
          value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} aria-label={t('Search projects')}
        />
        <ul className="project-list">
          {shownProjects.map((p) => {
            const cfg = draft.projects[p.id] || {};
            const opt = options[p.id];
            return (
              <li key={p.id} className={`${cfg.tracked ? 'tracked' : ''}${cfg.tracked && openProjects.has(p.id) ? ' open' : ''}`}>
                <div className="project-line">
                  <label className="check strong">
                    <input type="checkbox" checked={!!cfg.tracked} onChange={(e) => { setProject(p.id, { tracked: e.target.checked }); toggleProject(p.id, e.target.checked); }} /> {projectLabel(p.name, p.org)}
                  </label>
                  {cfg.tracked
                    ? <span className="small muted project-summary">{projectSummary(cfg, opt, orgKind(p.org) === 'github')}</span>
                    : p.description && <span className="small muted project-summary">{p.description}</span>}
                  {cfg.tracked && (
                    <button type="button" className="btn btn-small" aria-expanded={openProjects.has(p.id)} onClick={() => toggleProject(p.id)}>
                      {openProjects.has(p.id) ? t('Close') : t('Edit')}
                    </button>
                  )}
                </div>
                {cfg.tracked && openProjects.has(p.id) && (
                  opt === 'loading' || !opt ? <Loading label={t('Loading teams and repos…')} /> : opt.error ? <p className="text-bad small">{opt.error}</p> : (
                    <div className="project-config">
                      {/* A GitHub owner has no teams or area paths: just its repositories. */}
                      {orgKind(p.org) !== 'github' && <fieldset className="repo-pick">
                        <legend>{t('Teams')} <span className="muted small">{teamsOf(cfg).length ? t(teamsOf(cfg).length === 1 ? '1 team selected' : '{n} teams selected', { n: teamsOf(cfg).length }) : t('none: no sprint or team members')}</span></legend>
                        <div className="repo-group">
                          {opt.teams.map((team) => {
                            const selected = teamsOf(cfg);
                            const on = selected.some((s) => s.id === team.id);
                            return (
                              <label key={team.id} className="check">
                                <input
                                  type="checkbox"
                                  checked={on}
                                  onChange={(e) => setProject(p.id, {
                                    teams: e.target.checked ? [...selected, { id: team.id, name: team.name }] : selected.filter((s) => s.id !== team.id),
                                    teamId: undefined,
                                    teamName: undefined,
                                  })}
                                /> {team.name}
                              </label>
                            );
                          })}
                        </div>
                        <label className="check"><input type="checkbox" disabled={!teamsOf(cfg).length} checked={!!cfg.scopeToTeamArea} onChange={(e) => setProject(p.id, { scopeToTeamArea: e.target.checked })} /> {t("Only work items in these teams' area paths")}</label>
                      </fieldset>}
                      <div className="repo-pick">
                        <div className="repo-group">
                          <label className="check"><input type="radio" name={`repos-${p.id}`} checked={cfg.repos === 'all' || !Array.isArray(cfg.repos)} onChange={() => setProject(p.id, { repos: 'all' })} /> {t('All repos ({n})', { n: opt.repos.length })}</label>
                          <label className="check"><input type="radio" name={`repos-${p.id}`} checked={Array.isArray(cfg.repos)} onChange={() => setProject(p.id, { repos: opt.repos.map((r) => r.id) })} /> {t('Only these:')}</label>
                        </div>
                        <div className="repo-rows">
                          <div className="repo-row repo-row-head small muted">
                            <span>{t('Repository')}</span>
                            <span>{t('Local folder, for Start in Claude')} <span className="saved-note">{t('saved in this browser')}</span></span>
                          </div>
                          {opt.repos.map((r) => {
                            const only = Array.isArray(cfg.repos);
                            const on = !only || cfg.repos.includes(r.id);
                            return (
                              <div key={r.id} className={`repo-row${on ? '' : ' off'}`}>
                                {only
                                  ? <label className="check"><input type="checkbox" checked={on} onChange={(e) => setProject(p.id, { repos: e.target.checked ? [...cfg.repos, r.id] : cfg.repos.filter((x) => x !== r.id) })} /> {r.name}</label>
                                  : <span className="repo-name">{r.name}</span>}
                                <RepoFolder repo={r} />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
        {hiddenCount > 0 && <p className="muted small">{t(hiddenCount === 1 ? '{n} more project. Search to find them.' : '{n} more projects. Search to find them.', { n: hiddenCount })}</p>}
      </Section>

      <Section id="flags" title={t('When to flag things')}>
        <div className="threshold-list">
          {THRESHOLDS.map(([k, label, unit]) => (
            <label key={k} className="threshold">
              <span>{t(label)}</span>
              <span className="threshold-input"><input type="number" min={1} className="input" value={draft.thresholds[k]} onChange={(e) => setThreshold(k, e.target.value)} /> {t(unit)}</span>
            </label>
          ))}
          <label className="threshold">
            <span>{t('Treat work items with this tag or state as blocked')}</span>
            <span className="threshold-input"><input className="input" value={draft.blockedTag} onChange={(e) => setDraft((d) => ({ ...d, blockedTag: e.target.value }))} /></span>
          </label>
          <label className="threshold">
            <span>{tj('Check Azure DevOps for changes every {note}', { note: <span className="muted small">{t('(only while the console is open; 15–600)')}</span> })}</span>
            <span className="threshold-input"><input type="number" min={15} max={600} className="input" value={draft.refreshSeconds} onChange={(e) => setDraft((d) => ({ ...d, refreshSeconds: Number(e.target.value) }))} /> {t('seconds')}</span>
          </label>
        </div>
      </Section>

      <Section id="auto-complete" title={t('Auto-complete defaults')}>
        <p className="muted small">{t('Used when you set auto-complete on a pull request from the console.')}</p>
        <div className="form-row">
          <label>{t('Merge type')}
            <select className="input" value={draft.autoComplete.mergeStrategy} onChange={(e) => setDraft((d) => ({ ...d, autoComplete: { ...d.autoComplete, mergeStrategy: e.target.value } }))}>
              {MERGE.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={draft.autoComplete.deleteSourceBranch} onChange={(e) => setDraft((d) => ({ ...d, autoComplete: { ...d.autoComplete, deleteSourceBranch: e.target.checked } }))} /> {t('Delete source branch')}</label>
          <label className="check"><input type="checkbox" checked={draft.autoComplete.transitionWorkItems} onChange={(e) => setDraft((d) => ({ ...d, autoComplete: { ...d.autoComplete, transitionWorkItems: e.target.checked } }))} /> {t('Complete linked work items')}</label>
        </div>
      </Section>


      <OrgSettings />

      <AccountSettings />

      <ProductionSettings />

      <ChannelSettings />

      <TypeColorSettings />

      <AppearanceSettings />

      <NotificationSettings />


      {/* Last on the page, so it stays pinned to the bottom wherever you are. */}
      {dirty && (
        <div className="save-bar" role="region" aria-label={t('Unsaved changes')}>
          <span>{t('Unsaved changes to projects, flags or auto-complete.')}</span>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setDraft(structuredClone(data.settings))} disabled={saving}>{t('Discard')}</button>
          <button type="button" className="btn btn-small btn-primary" onClick={save} disabled={saving}>{saving ? t('Saving…') : t('Save settings')}</button>
        </div>
      )}

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
    else toast(result === 'denied' ? t('Desktop notifications are blocked for this site in your browser settings') : t("Desktop notifications weren't enabled"), 'bad');
  };

  const test = () => {
    toast(t('This is how notifications look'), 'note', { body: t('Approvals, reviews and failures show up like this.'), ttl: 6000 });
    if (prefs.desktop && permission === 'granted') {
      // Show it even while the tab is in front, so you can see it right away.
      const saved = prefs.onlyWhenHidden;
      savePrefs({ ...prefs, onlyWhenHidden: false });
      showDesktop({ title: 'Keel', body: t('Desktop notifications are on.'), tag: 'keel-test' });
      savePrefs({ ...prefs, onlyWhenHidden: saved });
    }
  };

  return (
    <Section id="notifications" title={t('Notifications')} note={<span className="saved-note">{t('Saved automatically')}</span>}>
      <p className="muted small">{t('Saved in this browser right away. Pop-ups and desktop notifications need the console open (a background tab is fine); push notifications arrive even when it is closed.')}</p>
      <div className="notify-grid">
        <label className="check"><input type="checkbox" checked={prefs.inApp} onChange={(e) => update({ inApp: e.target.checked })} /> {t('Show a pop-up in the console')}</label>
        <div className="notify-desktop">
          {!desktopSupported() ? <span className="muted small">{t("This browser doesn't support desktop notifications.")}</span>
            : permission === 'granted' ? (
              <label className="check"><input type="checkbox" checked={prefs.desktop} onChange={(e) => update({ desktop: e.target.checked })} /> {t('Desktop notifications')}</label>
            ) : permission === 'denied' ? (
              <span className="small text-warn">{t("Desktop notifications are blocked for this site. Allow them in your browser's site settings, then reload.")}</span>
            ) : (
              <button type="button" className="btn btn-small" onClick={turnOnDesktop}>{t('Turn on desktop notifications')}</button>
            )}
        </div>
        {permission === 'granted' && prefs.desktop && (
          <label className="check"><input type="checkbox" checked={prefs.onlyWhenHidden} onChange={(e) => update({ onlyWhenHidden: e.target.checked })} /> {t("Only on the desktop when the console isn't in front")}</label>
        )}
      </div>
      <h3 className="small notify-h">{t('Notify me about')}</h3>
      <div className="notify-cats">
        {CATEGORIES.map((c) => (
          <label key={c.id} className="check"><input type="checkbox" checked={prefs.categories[c.id] !== false} onChange={(e) => update({ categories: { [c.id]: e.target.checked } })} /> {c.label}</label>
        ))}
      </div>
      <button type="button" className="btn btn-small btn-ghost" onClick={test}>{t('Send a test notification')}</button>
      <PushSettings />
    </Section>
  );
}

/**
 * Push notifications on this device, even when Keel is closed (server/push.js),
 * in the categories above; and installing Keel as an app, which iPhones need for push.
 */
function PushSettings() {
  const { toast } = useApp();
  const [info, setInfo] = useState(null);
  const [here, setHere] = useState(undefined); // this browser's device id (as the server makes it), null when off
  const [busy, setBusy] = useState(false);
  const [installable, setInstallable] = useState(canPromptInstall);
  const available = pushAvailability();

  const load = () => {
    api('/push').then(setInfo).catch(() => setInfo({ unavailable: true, devices: [] }));
    currentSubscription().then((sub) => (sub ? deviceId(sub.endpoint) : null)).then(setHere).catch(() => setHere(null));
  };
  useEffect(load, []);
  useEffect(() => {
    const onChange = () => setInstallable(canPromptInstall());
    window.addEventListener('keel:installable', onChange);
    return () => window.removeEventListener('keel:installable', onChange);
  }, []);

  const run = (fn) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      // The browser says NotAllowedError when notifications are blocked (or in a private window).
      toast(err.code === 'denied' || err.name === 'NotAllowedError' ? t('Notifications are blocked for Keel. Allow them in the browser or phone settings, then try again.')
        : err.code === 'timeout' ? t("The browser's push service didn't answer. Try again in a moment.") : err.message, 'bad');
    } finally {
      setBusy(false);
      load();
    }
  };
  // On when this browser has a subscription Keel still knows (it may have been removed from another device).
  const on = !!here && !!info?.devices?.some((d) => d.id === here);
  const turnOn = run(async () => {
    await enablePush();
    toast(t('Push notifications are on for this device'));
  });
  const turnOff = run(async () => {
    await disablePush();
    toast(t('Push notifications are off for this device'));
  });
  const test = run(async () => {
    await api('/push/test', { method: 'POST', body: { id: here, language: getLanguage() } });
    toast(t('Test sent. It should arrive in a few seconds.'));
  });
  const remove = (d) => run(() => api('/push/unsubscribe', { method: 'POST', body: { id: d.id } }));

  return (
    <div className="push-settings">
      <h3 className="small notify-h">{t('Push notifications')}</h3>
      <p className="muted small">{t('On your phone or computer, even when Keel is closed: the same updates as above, checked every two minutes.')}</p>
      {info?.unavailable ? (
        <p className="small text-warn">{t("This Keel server doesn't send push notifications.")}</p>
      ) : available === 'install' ? (
        <p className="callout small">{t('On iPhone and iPad, push notifications work in the Keel app: tap Share, then Add to Home Screen, and open Keel from there.')}</p>
      ) : available === 'insecure' ? (
        <p className="small text-warn">{t('Push notifications need Keel to be opened over https.')}</p>
      ) : available === 'no' ? (
        <p className="muted small">{t("This browser doesn't support push notifications.")}</p>
      ) : (
        <div className="push-actions">
          {on ? (
            <>
              <span className="chip chip-ok">{t('On for this device')}</span>
              <button type="button" className="btn btn-small" onClick={test} disabled={busy}>{t('Send a test')}</button>
              <button type="button" className="btn btn-small btn-ghost" onClick={turnOff} disabled={busy}>{t('Turn off on this device')}</button>
            </>
          ) : (
            <button type="button" className="btn btn-small btn-primary" onClick={turnOn} disabled={busy || here === undefined}>{t('Turn on push on this device')}</button>
          )}
        </div>
      )}
      {info?.devices?.length > 0 && (
        <ul className="push-devices">
          {info.devices.map((d) => (
            <li key={d.id}>
              <div>
                <strong>{d.label}</strong>{d.id === here && <span className="muted small"> · {t('this device')}</span>}
                <div className="muted small">
                  {t('Added {date}', { date: dateTime(d.createdAt) })}
                  {d.lastSentAt ? ` · ${t('last notified {age} ago', { age: age(d.lastSentAt) })}` : ''}
                </div>
                {d.lastError && <div className="small text-warn">{tx(d.lastError)}</div>}
              </div>
              <button type="button" className="btn btn-small btn-ghost" onClick={remove(d)} disabled={busy}>{t('Remove')}</button>
            </li>
          ))}
        </ul>
      )}
      {/* Chrome, Edge and Android can install from here; iPhones were told how above. */}
      {!isInstalled() && installable && (
        <p className="push-install"><button type="button" className="btn btn-small" onClick={() => promptInstall()}>{t('Install Keel as an app')}</button></p>
      )}
    </div>
  );
}

/** Light/dark/system and accent color; saved in this browser and applied instantly. */
function AppearanceSettings() {
  const [theme, setTheme] = useState(loadTheme);
  const update = (patch) => {
    const next = { ...theme, ...patch };
    setTheme(next);
    saveTheme(next);
  };
  return (
    <Section id="appearance" title={t('Appearance')}>
      <p className="muted small">{t('Saved automatically to your account, so it follows you to other devices.')}</p>
      <div className="appearance">
        <div className="appearance-row">
          <span className="appearance-label">{t('Language')}</span>
          <div className="segmented segmented-compact" role="radiogroup" aria-label={t('Language')}>
            {LANGUAGES.map((l) => (
              <button key={l.id} type="button" role="radio" lang={l.id} aria-checked={getLanguage() === l.id} className={getLanguage() === l.id ? 'on' : ''} onClick={() => setLanguage(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <div className="appearance-row">
          <span className="appearance-label">{t('Mode')}</span>
          <div className="segmented segmented-compact" role="radiogroup" aria-label={t('Color mode')}>
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={theme.mode === m.id} className={theme.mode === m.id ? 'on' : ''} onClick={() => update({ mode: m.id })}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="appearance-row">
          <span className="appearance-label">{t('Accent')}</span>
          <div className="swatches" role="radiogroup" aria-label={t('Accent color')}>
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={theme.accent === a.id}
                className={`swatch ${theme.accent === a.id ? 'on' : ''}`}
                onClick={() => update({ accent: a.id })}
                title={a.label}
              >
                <span className="swatch-dot" style={{ background: a.swatch }} aria-hidden="true" />
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

const ROLE_NAMES = { admin: 'Admin', developer: 'Developer', pm: 'PM' };

/** Hosted mode only: your password and your Azure DevOps connection. */
function AccountSettings() {
  const { meta, authMode, toast } = useApp();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(null);
  if (authMode !== 'login' || !meta.account) return null;

  const run = async (name, fn, ok) => {
    setBusy(name);
    try {
      await fn();
      toast(ok);
      return true;
    } catch (e) {
      toast(e.message, 'bad');
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section id="account" title={t('Your account')}>
      <dl className="facts account-facts">
        <div><dt>{t('Name')}</dt><dd>{meta.account.name}</dd></div>
        <div><dt>{t('Email')}</dt><dd>{meta.account.email}</dd></div>
        <div><dt>{t('Role')}</dt><dd>{ROLE_NAMES[meta.role] ? t(ROLE_NAMES[meta.role]) : meta.role}</dd></div>
        <div><dt>Azure DevOps</dt><dd>{t('Connected as {name}', { name: meta.me.displayName })}</dd></div>
      </dl>

      <div className="account-forms">
        <form
          className="account-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run('token', () => api('/auth/token', { method: 'POST', body: { pat } }), t('Azure DevOps token updated'))) setPat('');
          }}
        >
          <h3 className="small">{t('Replace your Azure DevOps token')}</h3>
          <p className="muted small">{t("Use this when your token is about to expire. It's checked with Azure DevOps before it replaces the old one.")}</p>
          <input className="input" type="password" autoComplete="off" spellCheck={false} placeholder={t('Paste a new token')} value={pat} onChange={(e) => setPat(e.target.value)} aria-label={t('New personal access token')} />
          <div className="account-actions">
            <button type="submit" className="btn btn-small btn-primary" disabled={!pat.trim() || busy === 'token'}>{busy === 'token' ? t('Checking…') : t('Replace token')}</button>
            <Confirm
              text={t("Disconnect Azure DevOps? You'll be asked for a token again.")}
              onConfirm={async () => {
                await api('/auth/token', { method: 'DELETE' });
                window.dispatchEvent(new CustomEvent('keel:token-required', { detail: { reason: 'token-required' } }));
              }}
              className="btn btn-small btn-ghost text-bad"
            >
              {t('Disconnect')}
            </Confirm>
          </div>
        </form>

        <form
          className="account-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run('password', () => api('/auth/password', { method: 'POST', body: pw }), t('Password changed. Other devices were signed out.'))) setPw({ current: '', next: '' });
          }}
        >
          <h3 className="small">{t('Change password')}</h3>
          <input className="input" type="password" autoComplete="current-password" placeholder={t('Current password')} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} aria-label={t('Current password')} required />
          <input className="input" type="password" autoComplete="new-password" placeholder={t('New password (10+ characters)')} minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} aria-label={t('New password')} required />
          <div className="account-actions">
            <button type="submit" className="btn btn-small" disabled={busy === 'password'}>{busy === 'password' ? t('Saving…') : t('Change password')}</button>
          </div>
        </form>
      </div>
      <TerminalSignIns />
    </Section>
  );
}

/** Terminals signed in with `keel login` (server/terminals.js), each of which can be signed out here. */
function TerminalSignIns() {
  const { toast } = useApp();
  const [list, setList] = useState(null);
  const load = () => api('/auth/terminals').then(setList, () => setList([]));
  useEffect(() => {
    load();
  }, []);
  if (!list) return null;
  return (
    <div className="terminals">
      <h3 className="small">{t('Terminals signed in')}</h3>
      <p className="muted small">{tj('Keel in the terminal signs in with {command}, through this browser. A terminal unused for 90 days, or after a new password, is signed out by itself.', { command: <code>keel login</code> })}</p>
      {list.length === 0 && <p className="muted small">{t('None.')}</p>}
      {list.map((x) => (
        <div key={x.id} className="terminal-row small">
          <div>
            <strong>{x.name}</strong>
            <div className="muted">{t('Signed in {when} · last used {used}', { when: dateTime(x.createdAt), used: dateTime(x.lastUsedAt) })}</div>
          </div>
          <Confirm
            text={t('Sign out {name}? It needs keel login again.', { name: x.name })}
            onConfirm={async () => {
              try {
                await api(`/auth/terminals/${encodeURIComponent(x.id)}`, { method: 'DELETE' });
                toast(t('{name} is signed out', { name: x.name }));
              } catch (e) {
                toast(e.message, 'bad');
              }
              load();
            }}
            className="btn btn-small btn-ghost text-bad"
          >
            {t('Sign out')}
          </Confirm>
        </div>
      ))}
    </div>
  );
}

/**
 * Where a repo is cloned on this computer, for the work item "Start in Claude"
 * buttons. Saved in this browser when you leave the field (folders differ
 * between computers), not with the rest of the settings.
 */
function RepoFolder({ repo }) {
  const { toast } = useApp();
  const [saved, setSaved] = useState(() => loadFolders()[repo.id] || '');
  const [value, setValue] = useState(saved);
  const problem = folderProblem(value);
  const save = () => {
    const v = value.trim();
    if (problem || v === saved) return;
    saveFolder(repo.id, v);
    setSaved(v);
    toast(t(v ? 'Folder saved for {name}' : 'Folder cleared for {name}', { name: repo.name }));
  };
  return (
    <div className="repo-folder">
      <input
        className="input mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), save())}
        placeholder={`C:\\src\\${repo.name}`}
        spellCheck={false}
        autoComplete="off"
        aria-label={t('Local folder for {name}', { name: repo.name })}
        aria-invalid={!!problem}
      />
      {problem && <span className="small text-bad">{t(problem)}</span>}
    </div>
  );
}
