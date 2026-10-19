import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { Chip, Loading } from '../ui.jsx';
import { age } from '../format.js';
import { LANGUAGES, getLanguage, locale, t, tx } from '../i18n.js';
import { KeyField } from './ProductionSettings.jsx';
import { useProjectLabel } from '../orgs.js';

const KINDS = [
  { id: 'teams', label: 'Microsoft Teams' },
  { id: 'slack', label: 'Slack' },
  { id: 'webhook', label: 'Other (JSON webhook)' },
];
// What a channel can be told about (server/domain/messages.js CHANNEL_EVENTS).
const EVENTS = [
  { id: 'production', label: 'Production outages and regressions after a deploy' },
  { id: 'pipeline', label: 'Default-branch pipelines and release stages that start failing' },
  { id: 'approval', label: 'Deployment approvals waiting' },
  { id: 'work', label: 'Blocked work items and P1 bugs with no owner' },
  { id: 'pr', label: 'Pull requests with no reviewers or stale for twice the limit' },
];
const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
const blank = () => ({ key: Math.random(), id: null, name: '', kind: 'teams', url: '', hasUrl: false, events: ['production', 'pipeline', 'approval'], projects: [], weekly: { enabled: true, weekday: 1, hour: 9 }, timeZone: zone(), language: getLanguage() });
const snapshot = (rows) => JSON.stringify((rows || []).map(({ key, lastPostAt, lastError, lastErrorAt, lastWeekly, ...rest }) => rest));
// Monday first, in the current language.
const weekdays = () => [1, 2, 3, 4, 5, 6, 7].map((d) => ({ d, label: new Date(Date.UTC(2024, 0, d)).toLocaleDateString(locale(), { weekday: 'long', timeZone: 'UTC' }) }));

/**
 * Settings → Teams and Slack (Admins). Each channel gets the inbox entries it
 * asks for when they turn urgent, and the weekly summary on a set day. Keel
 * posts from the server, so it works with no one looking; webhook addresses
 * are stored encrypted and never shown again.
 */
export default function ChannelSettings() {
  const { toast, authMode, can } = useApp();
  const [rows, setRows] = useState(null);
  const [info, setInfo] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState({});
  const { data: settings } = useApi('/settings');
  const projectLabel = useProjectLabel();

  const adopt = (res) => {
    const loaded = res.channels.map((c) => ({ ...c, projects: c.projects || [], key: c.id, url: undefined }));
    setRows(loaded);
    setInfo(res);
    setBaseline(snapshot(loaded));
  };
  useEffect(() => {
    if (!can('channels.manage')) return;
    api('/channels').then(adopt).catch(() => setRows([]));
  }, [can]);

  useEffect(() => {
    if (rows && window.location.hash === '#channels') document.getElementById('channels')?.scrollIntoView({ block: 'start' });
  }, [rows === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!can('channels.manage')) return null;
  if (!rows) return <section className="panel" id="channels"><Loading /></section>;

  const set = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const dirty = snapshot(rows) !== baseline;
  const projects = [...(settings?.projects || [])].sort((a, b) => a.name.localeCompare(b.name));
  const toggle = (key) => setOpen((o) => {
    const next = new Set(o);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const save = async () => {
    setBusy(true);
    try {
      adopt(await api('/channels', {
        method: 'PUT',
        body: { channels: rows.map(({ id, name, kind, url, events, projects: picked, weekly, timeZone, language }) => ({ id, name, kind, url: url || undefined, events, projects: picked, weekly, timeZone, language })) },
      }));
      setOpen(new Set());
      toast(t('Channels saved'));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const run = async (r, what) => {
    setTests((ts) => ({ ...ts, [r.key]: { running: what } }));
    try {
      if (what === 'weekly') await api(`/channels/${encodeURIComponent(r.id)}/weekly`, { method: 'POST' });
      else await api('/channels/test', { method: 'POST', body: { id: r.id, kind: r.kind, url: r.url || undefined, language: r.language } });
      setTests((ts) => ({ ...ts, [r.key]: { ok: what === 'weekly' ? t("Last week's summary was posted.") : t('Test message posted. Check the channel.') } }));
    } catch (e) {
      setTests((ts) => ({ ...ts, [r.key]: { error: e.message } }));
    }
  };

  return (
    <section className="panel" id="channels">
      <h2 className="section-title">{t('Teams and Slack')}</h2>
      <p className="muted small">
        {t('Post to a channel when something needs the team: an outage, a red default branch, a deployment waiting on approval. Keel checks every 2 minutes from the server, so it works when nobody has Keel open, and it can post the weekly summary each week too.')}
        {' '}{authMode === 'login' ? t("Keel reads Azure DevOps for a channel as the Admin who added it, with their snoozes, for the projects ticked on the channel (that Admin's own projects when none are ticked).") : t('Keel reads Azure DevOps for the projects ticked on the channel (the projects chosen above when none are ticked).')}
      </p>
      <p className="muted small">
        {t('Teams: in the channel, choose Workflows → "Post to a channel when a webhook request is received" and copy its address. Slack: add an Incoming Webhook to the channel. Addresses are stored encrypted and never shown again.')}
        {!info?.keelUrl && ` ${t('Set PUBLIC_URL on the server (for example https://keel.example.com) and posts will link back to Keel.')}`}
      </p>

      <ul className="monitor-rows">
        {rows.map((r) => {
          const editing = open.has(r.key);
          const result = tests[r.key];
          return (
            <li key={r.key} className={`monitor-row${editing ? ' open' : ''}`}>
              <div className="monitor-line">
                <div className="monitor-line-main">
                  <span className="strong">{r.name || t('New channel')}</span>
                  <span className="small muted">
                    {KINDS.find((k) => k.id === r.kind)?.label}{r.urlHost ? ` · ${r.urlHost}` : ''}
                    {r.lastError ? <span className="text-bad"> · {tx(r.lastError)}</span> : r.lastPostAt ? ` · ${t('last post {age} ago', { age: age(r.lastPostAt) })}` : ''}
                  </span>
                </div>
                <div className="chips">
                  {r.events.length > 0 && <Chip>{t(r.events.length === 1 ? '{n} kind of update' : '{n} kinds of update', { n: r.events.length })}</Chip>}
                  {r.projects.length > 0 && <Chip>{r.projects.length === 1 ? projectLabel(projects.find((p) => p.id === r.projects[0])?.name || '…', projects.find((p) => p.id === r.projects[0])?.org) : t('{n} projects', { n: r.projects.length })}</Chip>}
                  {r.weekly.enabled && <Chip tone="info">{t('Weekly summary')}</Chip>}
                  {r.ownerName && authMode === 'login' && <Chip>{t('as {name}', { name: r.ownerName })}</Chip>}
                </div>
                <div className="monitor-line-actions">
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => run(r, 'test')} disabled={!!result?.running || (!r.url && !r.hasUrl)}>{result?.running === 'test' ? t('Sending…') : t('Send a test')}</button>
                  <button type="button" className="btn btn-small" aria-expanded={editing} onClick={() => toggle(r.key)}>{editing ? t('Close') : t('Edit')}</button>
                </div>
              </div>
              {result && !result.running && <p className={`small monitor-test ${result.error ? 'text-bad' : 'text-ok'}`}>{result.error || result.ok}</p>}
              {editing && (
                <div className="monitor-editor">
                  <fieldset className="monitor-group">
                    <legend>{t('Channel')}</legend>
                    <label>{t('Name')}<input className="input" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder={t('Team channel')} /></label>
                    <label>{t('Service')}
                      <select className="input" value={r.kind} onChange={(e) => set(r.key, { kind: e.target.value })}>
                        {KINDS.map((k) => <option key={k.id} value={k.id}>{t(k.label)}</option>)}
                      </select>
                    </label>
                    <KeyField label={t('Webhook address')} has={r.hasUrl} value={r.url} onChange={(v) => set(r.key, { url: v || undefined })} placeholder="https://…" texts={{ saved: t('Saved. Paste a new address to replace it') }} removable={false} />
                    <label>{t('Language')}
                      <select className="input" value={r.language} onChange={(e) => set(r.key, { language: e.target.value })}>
                        {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                      </select>
                    </label>
                  </fieldset>
                  <fieldset className="monitor-group channel-events">
                    <legend>{t('Projects')}</legend>
                    <span className="muted small">
                      {r.projects.length ? t('Posts and the weekly summary cover these projects only.')
                        : authMode !== 'login' ? t('None ticked: the projects chosen above.')
                          : r.ownerName ? t('None ticked: the projects {name} tracks.', { name: r.ownerName }) : t('None ticked: the projects you track.')}
                    </span>
                    <div className="channel-projects">
                      {projects.map((p) => (
                        <label key={p.id} className="check">
                          <input type="checkbox" checked={r.projects.includes(p.id)} onChange={(e) => set(r.key, { projects: e.target.checked ? [...r.projects, p.id] : r.projects.filter((x) => x !== p.id) })} />
                          {projectLabel(p.name, p.org)}
                        </label>
                      ))}
                      {/* Ticked projects this token can no longer see stay ticked, and can be unticked. */}
                      {r.projects.filter((id) => !projects.some((p) => p.id === id)).map((id) => (
                        <label key={id} className="check muted">
                          <input type="checkbox" checked onChange={() => set(r.key, { projects: r.projects.filter((x) => x !== id) })} />
                          {settings ? t('A project you have no access to') : '…'}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className="monitor-group channel-events">
                    <legend>{t('Post when')}</legend>
                    {EVENTS.map((ev) => (
                      <label key={ev.id} className="check">
                        <input type="checkbox" checked={r.events.includes(ev.id)} onChange={(e) => set(r.key, { events: e.target.checked ? [...r.events, ev.id] : r.events.filter((x) => x !== ev.id) })} />
                        {t(ev.label)}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset className="monitor-group">
                    <legend>{t('Weekly summary')}</legend>
                    <label className="check"><input type="checkbox" checked={r.weekly.enabled} onChange={(e) => set(r.key, { weekly: { ...r.weekly, enabled: e.target.checked } })} /> {t("Post last week's summary")}</label>
                    <label>{t('Day')}
                      <select className="input" value={r.weekly.weekday} disabled={!r.weekly.enabled} onChange={(e) => set(r.key, { weekly: { ...r.weekly, weekday: Number(e.target.value) } })}>
                        {weekdays().map(({ d, label }) => <option key={d} value={d}>{label}</option>)}
                      </select>
                    </label>
                    <label>{t('Time')}
                      <select className="input" value={r.weekly.hour} disabled={!r.weekly.enabled} onChange={(e) => set(r.key, { weekly: { ...r.weekly, hour: Number(e.target.value) } })}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
                      </select>
                    </label>
                    <label>{t('Time zone')}<input className="input" value={r.timeZone} onChange={(e) => set(r.key, { timeZone: e.target.value })} placeholder="Europe/Lisbon" /></label>
                  </fieldset>
                  <div className="monitor-editor-foot">
                    {r.id && <button type="button" className="btn btn-small btn-ghost" onClick={() => run(r, 'weekly')} disabled={!!result?.running || dirty}>{result?.running === 'weekly' ? t('Sending…') : t('Post the summary now')}</button>}
                    <button type="button" className="btn btn-small btn-ghost text-bad" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>{t('Remove channel')}</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!rows.length && <p className="muted small">{t('No channels yet.')}</p>}
      <div className="section-foot">
        <button type="button" className="btn btn-small" onClick={() => {
          const row = blank();
          setRows((rs) => [...rs, row]);
          setOpen((o) => new Set(o).add(row.key));
        }}
        >
          {t('Add channel')}
        </button>
        {dirty && <span className="small text-warn">{t('Unsaved changes')}</span>}
        <button type="button" className="btn btn-primary btn-small" onClick={save} disabled={busy || !dirty}>{busy ? t('Saving…') : t('Save channels')}</button>
      </div>
    </section>
  );
}
