import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { Chip, Loading, Section } from '../ui.jsx';
import { t, tx } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';

const blank = () => ({ key: Math.random(), id: null, name: '', url: '', appInsightsAppId: '', apiKey: undefined, hasApiKey: false, link: null, projectId: null, latencyWarnMs: 2000, totalsKey: undefined, hasTotalsKey: false, totalsEvery: 24, totalsSeason: 'current' });
const EVERY = [1, 6, 12, 24];
// What counts as a change: everything but the row's local key.
const snapshot = (rows) => JSON.stringify((rows || []).map(({ key, ...rest }) => rest));

/**
 * Settings → Production monitors. API keys are typed here and sent once; the
 * server stores them encrypted and never sends them back (only "hasApiKey").
 */
export default function ProductionSettings() {
  const { toast, refresh, authMode, can } = useApp();
  const { data: rel } = useApi('/releases');
  const { data: pipes } = useApi('/pipelines');
  const { data: settings } = useApi('/settings');
  const projectLabel = useProjectLabel();
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState({});
  const [open, setOpen] = useState(() => new Set());
  const [baseline, setBaseline] = useState('');

  useEffect(() => {
    api('/production/monitors')
      .then((list) => {
        const loaded = list.map((m) => ({ ...m, key: m.id, apiKey: undefined, totalsKey: undefined }));
        setRows(loaded);
        setBaseline(snapshot(loaded));
      })
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    if (window.location.hash === '#production') document.getElementById('production')?.scrollIntoView({ block: 'start' });
  }, [rows === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <section className="panel" id="production"><Loading label={t('Loading monitors…')} /></section>;
  if (!can('monitors.manage')) {
    return (
      <Section id="production" title={t('Production monitors')}>
        <p className="muted small">{rows.length ? t(rows.length === 1 ? '{n} monitor is set up.' : '{n} monitors are set up.', { n: rows.length }) : t('No monitors yet.')} {t('Only admins can add or change production monitors.')}</p>
      </Section>
    );
  }

  const set = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const dirty = snapshot(rows) !== baseline;
  // Who sees a monitor: the people who track its project (everyone when it has none).
  const projects = [...(settings?.projects || [])].sort((a, b) => a.name.localeCompare(b.name));
  const projectName = (id) => {
    const p = projects.find((x) => x.id === id);
    return p ? projectLabel(p.name, p.org) : id;
  };

  // "Deploys come from" options: classic release stages and build/YAML pipelines.
  const linkOptions = [
    ...(rel?.definitions || []).flatMap((d) => d.stages.map((s) => ({
      value: `release|${d.projectId}|${d.id}|${s.name}`, label: `${d.projectName} · ${d.name} → ${s.name}`, group: 'Release stages',
      link: { type: 'release', projectId: d.projectId, definitionId: d.id, stage: s.name },
    }))),
    ...(pipes || []).map((p) => ({
      value: `pipeline|${p.projectId}|${p.definition.id}`, label: `${p.projectName} · ${p.definition.name}${p.branch ? ` (${p.branch})` : ''}`, group: 'Pipelines',
      link: { type: 'pipeline', projectId: p.projectId, definitionId: p.definition.id },
    })),
  ];
  // What Keel works out for a pipeline (the branch its automatic runs use); a release's comes from what it deployed.
  const learnedBranch = (l) => (l?.type === 'pipeline' ? (pipes || []).find((p) => p.projectId === l.projectId && p.definition.id === l.definitionId)?.branch || null : null);
  const linkValue = (l) => (!l ? '' : l.type === 'release' ? `release|${l.projectId}|${l.definitionId}|${l.stage}` : `pipeline|${l.projectId}|${l.definitionId}`);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api('/production/monitors', {
        method: 'PUT',
        body: { monitors: rows.map(({ id, name, url, appInsightsAppId, apiKey, link, projectId, latencyWarnMs, totalsKey, totalsEvery, totalsSeason }) => ({ id, name, url, appInsightsAppId, apiKey, link, projectId, latencyWarnMs, totalsKey, totalsEvery, totalsSeason })) },
      });
      const fresh = saved.map((m) => ({ ...m, key: m.id, apiKey: undefined, totalsKey: undefined }));
      setRows(fresh);
      setBaseline(snapshot(fresh));
      setOpen(new Set());
      toast(t('Production monitors saved'));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const test = async (r) => {
    setTests((ts) => ({ ...ts, [r.key]: { running: true } }));
    try {
      const res = await api('/production/test', { method: 'POST', body: { id: r.id, url: r.url, appInsightsAppId: r.appInsightsAppId, apiKey: r.apiKey } });
      setTests((ts) => ({ ...ts, [r.key]: res }));
    } catch (e) {
      setTests((ts) => ({ ...ts, [r.key]: { error: e.message } }));
    }
  };

  return (
    <Section id="production" title={t('Production monitors')}>
      <p className="muted small">
        {t('Keel checks each URL every minute. With an Application Insights App ID and API key (Application Insights → API Access → Create API key, "Read telemetry"), it also tracks failure rates, exceptions and slow requests. Keys are stored encrypted on the server and never shown again.')}
        {authMode === 'login' && ` ${t("Each monitor shows, in Production, the Inbox and notifications, for the people who track its project: the one that deploys it, or the one picked here. A monitor with no project shows for everyone.")}`}
      </p>
      <p className="muted small">{t("Sites with platform endpoints: use the site's /health address, for example https://shop.example.com/health. Keel reads its health report, and with the site's totals key it also fetches the Platform totals.")}</p>

      <ul className="monitor-rows">
        {rows.map((r) => {
          const result = tests[r.key];
          const editing = open.has(r.key);
          const toggle = () => setOpen((o) => {
            const next = new Set(o);
            if (next.has(r.key)) next.delete(r.key);
            else next.add(r.key);
            return next;
          });
          const hasAi = !!r.appInsightsAppId && (r.hasApiKey || !!r.apiKey) && r.apiKey !== null;
          const hasTotals = (r.hasTotalsKey || !!r.totalsKey) && r.totalsKey !== null;
          return (
            <li key={r.key} className={`monitor-row${editing ? ' open' : ''}`}>
              <div className="monitor-line">
                <div className="monitor-line-main">
                  <span className="strong">{r.name || t('New monitor')}</span>
                  <span className="small muted mono monitor-url">{r.url || '—'}</span>
                </div>
                <div className="chips">
                  {hasAi && <Chip>Application Insights</Chip>}
                  {hasTotals && <Chip>{t('Totals {every}', { every: t(r.totalsEvery === 1 ? 'every hour' : 'every {n} hours', { n: r.totalsEvery }) })}</Chip>}
                  {r.link && <Chip>{t('Deploys linked')}</Chip>}
                  {authMode === 'login' && <Chip tone={r.projectId ? undefined : 'info'}>{r.projectId ? projectName(r.projectId) : t('Everyone')}</Chip>}
                </div>
                <div className="monitor-line-actions">
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => test(r)} disabled={result?.running || (!r.url && !r.appInsightsAppId)}>{result?.running ? t('Testing…') : t('Test')}</button>
                  <button type="button" className="btn btn-small" aria-expanded={editing} onClick={toggle}>{editing ? t('Close') : t('Edit')}</button>
                </div>
              </div>
              {result && !result.running && (
                <p className="small monitor-test">
                  {result.error && <span className="text-bad">{result.error}</span>}
                  {result.http && <span className={result.http.ok ? 'text-ok' : 'text-bad'}>{result.http.ok ? t('URL: OK, HTTP {status} in {ms}ms', { status: result.http.status, ms: result.http.ms }) : t('URL: {error}', { error: tx(result.http.error) })}</span>}
                  {result.http && result.ai && ' · '}
                  {result.ai && <span className={result.ai.ok ? 'text-ok' : 'text-bad'}>{result.ai.ok ? t('Application Insights: OK ({n} requests in the last hour)', { n: result.ai.total }) : `Application Insights: ${tx(result.ai.error)}`}</span>}
                </p>
              )}
              {editing && (
                <div className="monitor-editor">
                  <fieldset className="monitor-group">
                    <legend>{t('Check')}</legend>
                    <label>{t('Name')}<input className="input" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder={t('Sports (production)')} /></label>
                    <label className="wide">{t('URL to check')}<input className="input" value={r.url} onChange={(e) => set(r.key, { url: e.target.value })} placeholder="https://sports.example.com/health" inputMode="url" /></label>
                    <label>{t('Slow above (ms)')}<input className="input" type="number" min={100} max={30000} value={r.latencyWarnMs} onChange={(e) => set(r.key, { latencyWarnMs: Number(e.target.value) })} /></label>
                    <label className="wide">{t('Deploys come from')}
                      <select className="input" value={linkValue(r.link)} onChange={(e) => { const l = linkOptions.find((o) => o.value === e.target.value)?.link; set(r.key, { link: l ? { ...l, ...(r.link?.branch ? { branch: r.link.branch } : {}) } : null, projectId: l ? l.projectId : r.projectId }); }}>
                        <option value="">{t('Not linked')}</option>
                        {['Release stages', 'Pipelines'].map((g) => (
                          <optgroup key={g} label={t(g)}>
                            {linkOptions.filter((o) => o.group === g).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                    <label className="wide">{t('Project')}
                      {r.link
                        ? <span className="input-note">{t('{project}, which deploys it', { project: projectName(r.link.projectId) })}</span>
                        : (
                          <select className="input" value={r.projectId || ''} onChange={(e) => set(r.key, { projectId: e.target.value || null })}>
                            <option value="">{t('None: everyone sees it')}</option>
                            {projects.map((p) => <option key={p.id} value={p.id}>{projectLabel(p.name, p.org)}</option>)}
                          </select>
                        )}
                      <span className="muted small">{t('People who track this project see the monitor, its alerts and its deploys.')}</span>
                    </label>
                    {r.link && (
                      <label className="wide">{t('Production branch')}
                        <input
                          className="input mono"
                          value={r.link.branch || ''}
                          onChange={(e) => set(r.key, { link: { ...r.link, branch: e.target.value } })}
                          placeholder={learnedBranch(r.link) ? t('Automatic: {branch}', { branch: learnedBranch(r.link) }) : t('Automatic: the branch the last deploy came from')}
                          spellCheck={false}
                        />
                        <span className="muted small">{t("The branch production deploys from, when Keel's guess is wrong. For a pipeline, its runs on this branch are the production deploys (once one has succeeded there), and Waiting to ship compares with it. Leave empty for Keel to work it out.")}</span>
                      </label>
                    )}
                  </fieldset>
                  <fieldset className="monitor-group">
                    <legend>Application Insights <span className="muted small">{t('(optional)')}</span></legend>
                    <label>App ID<input className="input mono" value={r.appInsightsAppId} onChange={(e) => set(r.key, { appInsightsAppId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" /></label>
                    <KeyField label={t('API key')} has={r.hasApiKey} value={r.apiKey} onChange={(v) => set(r.key, { apiKey: v })} placeholder={t('Paste the API key')} />
                  </fieldset>
                  <fieldset className="monitor-group">
                    <legend>{t('Platform totals')} <span className="muted small">{t('(optional)')}</span></legend>
                    <KeyField label={t('Platform totals key')} has={r.hasTotalsKey} value={r.totalsKey} onChange={(v) => set(r.key, { totalsKey: v })} placeholder={t("The site's X-Totals-Key")} />
                    <label>{t('Fetch totals')}
                      <select className="input" value={r.totalsEvery} onChange={(e) => set(r.key, { totalsEvery: Number(e.target.value) })} disabled={!hasTotals}>
                        {EVERY.map((h) => <option key={h} value={h}>{t(h === 1 ? 'Every hour' : 'Every {n} hours', { n: h })}</option>)}
                      </select>
                    </label>
                    <label>{t('Totals for')}
                      <select className="input" value={r.totalsSeason} onChange={(e) => set(r.key, { totalsSeason: e.target.value })} disabled={!hasTotals}>
                        <option value="current">{t('The current season')}</option>
                        <option value="all">{t('All seasons together')}</option>
                      </select>
                    </label>
                  </fieldset>
                  <div className="monitor-editor-foot">
                    <button type="button" className="btn btn-small btn-ghost text-bad" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>{t('Remove monitor')}</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!rows.length && <p className="muted small">{t('No monitors yet.')}</p>}
      <div className="section-foot">
        <button type="button" className="btn btn-small" onClick={() => {
          const row = blank();
          setRows((rs) => [...rs, row]);
          setOpen((o) => new Set(o).add(row.key));
        }}
        >
          {t('Add monitor')}
        </button>
        {dirty && <span className="small text-warn">{t('Unsaved changes')}</span>}
        <button type="button" className="btn btn-primary btn-small" onClick={save} disabled={busy || !dirty}>{busy ? t('Saving…') : t('Save monitors')}</button>
      </div>
    </Section>
  );
}

/**
 * A secret typed once: shows that one is saved (never the value), replaces it
 * when you type, or is removed on save (value null) with an undo.
 */
export function KeyField({ label, has, value, onChange, placeholder, texts = {}, removable = true }) {
  const { saved = t('Saved. Type a new key to replace it'), remove = t('Remove saved key'), removing = t('The saved key will be removed when you save.') } = texts;
  return (
    <label>{label}
      <input
        className="input mono"
        type="password"
        autoComplete="off"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={has ? saved : placeholder}
        disabled={value === null}
      />
      {removable && has && value !== null && <button type="button" className="link-btn small" onClick={() => onChange(null)}>{remove}</button>}
      {value === null && <span className="small text-warn">{removing} <button type="button" className="link-btn" onClick={() => onChange(undefined)}>{t('Undo')}</button></span>}
    </label>
  );
}
