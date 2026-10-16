import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { Loading } from '../ui.jsx';
import { t, tx } from '../i18n.js';

const blank = () => ({ key: Math.random(), id: null, name: '', url: '', appInsightsAppId: '', apiKey: undefined, hasApiKey: false, link: null, latencyWarnMs: 2000, totalsKey: undefined, hasTotalsKey: false, totalsEvery: 24, totalsSeason: 'current' });
const EVERY = [1, 6, 12, 24];

/**
 * Settings → Production monitors. API keys are typed here and sent once; the
 * server stores them encrypted and never sends them back (only "hasApiKey").
 */
export default function ProductionSettings() {
  const { toast, refresh, authMode, can } = useApp();
  const { data: rel } = useApi('/releases');
  const { data: pipes } = useApi('/pipelines');
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState({});

  useEffect(() => {
    api('/production/monitors')
      .then((list) => setRows(list.map((m) => ({ ...m, key: m.id, apiKey: undefined, totalsKey: undefined }))))
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    if (window.location.hash === '#production') document.getElementById('production')?.scrollIntoView({ block: 'start' });
  }, [rows === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <section className="panel" id="production"><Loading label={t('Loading monitors…')} /></section>;
  if (!can('monitors.manage')) {
    return (
      <section className="panel" id="production">
        <h2 className="section-title">{t('Production monitors')}</h2>
        <p className="muted small">{rows.length ? t(rows.length === 1 ? '{n} monitor is set up.' : '{n} monitors are set up.', { n: rows.length }) : t('No monitors yet.')} {t('Only admins can add or change production monitors.')}</p>
      </section>
    );
  }

  const set = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

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
  const linkValue = (l) => (!l ? '' : l.type === 'release' ? `release|${l.projectId}|${l.definitionId}|${l.stage}` : `pipeline|${l.projectId}|${l.definitionId}`);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await api('/production/monitors', {
        method: 'PUT',
        body: { monitors: rows.map(({ id, name, url, appInsightsAppId, apiKey, link, latencyWarnMs, totalsKey, totalsEvery, totalsSeason }) => ({ id, name, url, appInsightsAppId, apiKey, link, latencyWarnMs, totalsKey, totalsEvery, totalsSeason })) },
      });
      setRows(saved.map((m) => ({ ...m, key: m.id, apiKey: undefined, totalsKey: undefined })));
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
    <section className="panel" id="production">
      <h2 className="section-title">{t('Production monitors')}</h2>
      <p className="muted small">
        {t('Keel checks each URL every minute. With an Application Insights App ID and API key (Application Insights → API Access → Create API key, "Read telemetry"), it also tracks failure rates, exceptions and slow requests. Keys are stored encrypted on the server and never shown again.')}
        {authMode === 'login' && ` ${t('Monitors are shared by everyone who uses this Keel server.')}`}
      </p>
      <p className="muted small">{t("ISM sites (WebShopSite, ShopSites, MarketSite, CartSites): use the site's /health address, for example https://shopeusite.azurewebsites.net/health. Keel reads its health report, and with the site's totals key it also fetches the Platform totals. ShopSites sites have no totals yet.")}</p>

      <div className="monitor-edit-list">
        {rows.map((r) => {
          const result = tests[r.key];
          return (
            <fieldset key={r.key} className="monitor-edit">
              <legend>{r.name || t('New monitor')}</legend>
              <div className="monitor-grid">
                <label>{t('Name')}<input className="input" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder={t('Sports (production)')} /></label>
                <label>{t('URL to check')}<input className="input" value={r.url} onChange={(e) => set(r.key, { url: e.target.value })} placeholder="https://sports.example.com/health" inputMode="url" /></label>
                <label>Application Insights App ID <span className="muted small">{t('(optional)')}</span>
                  <input className="input mono" value={r.appInsightsAppId} onChange={(e) => set(r.key, { appInsightsAppId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
                </label>
                <label>{t('API key')}
                  <input
                    className="input mono"
                    type="password"
                    autoComplete="off"
                    value={r.apiKey || ''}
                    onChange={(e) => set(r.key, { apiKey: e.target.value })}
                    placeholder={r.hasApiKey ? t('Saved. Type a new key to replace it') : t('Paste the API key')}
                    disabled={r.apiKey === null}
                  />
                  {r.hasApiKey && r.apiKey !== null && <button type="button" className="link-btn small" onClick={() => set(r.key, { apiKey: null })}>{t('Remove saved key')}</button>}
                  {r.apiKey === null && <span className="small text-warn">{t('The saved key will be removed when you save.')} <button type="button" className="link-btn" onClick={() => set(r.key, { apiKey: undefined })}>{t('Undo')}</button></span>}
                </label>
                <label>{t('Deploys come from')}
                  <select className="input" value={linkValue(r.link)} onChange={(e) => set(r.key, { link: linkOptions.find((o) => o.value === e.target.value)?.link || null })}>
                    <option value="">{t('Not linked')}</option>
                    {['Release stages', 'Pipelines'].map((g) => (
                      <optgroup key={g} label={t(g)}>
                        {linkOptions.filter((o) => o.group === g).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label>{t('Slow above (ms)')}<input className="input" type="number" min={100} max={30000} value={r.latencyWarnMs} onChange={(e) => set(r.key, { latencyWarnMs: Number(e.target.value) })} /></label>
                <label>{t('Platform totals key')} <span className="muted small">{t('(optional)')}</span>
                  <input
                    className="input mono"
                    type="password"
                    autoComplete="off"
                    value={r.totalsKey || ''}
                    onChange={(e) => set(r.key, { totalsKey: e.target.value })}
                    placeholder={r.hasTotalsKey ? t('Saved. Type a new key to replace it') : t("The site's X-Totals-Key")}
                    disabled={r.totalsKey === null}
                  />
                  {r.hasTotalsKey && r.totalsKey !== null && <button type="button" className="link-btn small" onClick={() => set(r.key, { totalsKey: null })}>{t('Remove saved key')}</button>}
                  {r.totalsKey === null && <span className="small text-warn">{t('The saved key will be removed when you save.')} <button type="button" className="link-btn" onClick={() => set(r.key, { totalsKey: undefined })}>{t('Undo')}</button></span>}
                </label>
                <label>{t('Fetch totals')}
                  <select className="input" value={r.totalsEvery} onChange={(e) => set(r.key, { totalsEvery: Number(e.target.value) })} disabled={!r.hasTotalsKey && !r.totalsKey}>
                    {EVERY.map((h) => <option key={h} value={h}>{t(h === 1 ? 'Every hour' : 'Every {n} hours', { n: h })}</option>)}
                  </select>
                </label>
                <label>{t('Totals for')}
                  <select className="input" value={r.totalsSeason} onChange={(e) => set(r.key, { totalsSeason: e.target.value })} disabled={!r.hasTotalsKey && !r.totalsKey}>
                    <option value="current">{t('The current season')}</option>
                    <option value="all">{t('All seasons together')}</option>
                  </select>
                </label>
              </div>
              <div className="monitor-edit-actions">
                <button type="button" className="btn btn-small" onClick={() => test(r)} disabled={result?.running || (!r.url && !r.appInsightsAppId)}>{result?.running ? t('Testing…') : t('Test')}</button>
                <button type="button" className="btn btn-small btn-ghost text-bad" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>{t('Remove monitor')}</button>
                {result && !result.running && (
                  <span className="small">
                    {result.error && <span className="text-bad">{result.error}</span>}
                    {result.http && <span className={result.http.ok ? 'text-ok' : 'text-bad'}>{result.http.ok ? t('URL: OK, HTTP {status} in {ms}ms', { status: result.http.status, ms: result.http.ms }) : t('URL: {error}', { error: tx(result.http.error) })}</span>}
                    {result.http && result.ai && ' · '}
                    {result.ai && <span className={result.ai.ok ? 'text-ok' : 'text-bad'}>{result.ai.ok ? t('Application Insights: OK ({n} requests in the last hour)', { n: result.ai.total }) : `Application Insights: ${tx(result.ai.error)}`}</span>}
                  </span>
                )}
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="monitor-edit-actions">
        <button type="button" className="btn btn-small" onClick={() => setRows((rs) => [...rs, blank()])}>{t('Add monitor')}</button>
        <button type="button" className="btn btn-primary btn-small" onClick={save} disabled={busy}>{busy ? t('Saving…') : t('Save monitors')}</button>
      </div>
    </section>
  );
}
