import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { Loading } from '../ui.jsx';

const blank = () => ({ key: Math.random(), id: null, name: '', url: '', appInsightsAppId: '', apiKey: undefined, hasApiKey: false, link: null, latencyWarnMs: 2000 });

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
      .then((list) => setRows(list.map((m) => ({ ...m, key: m.id, apiKey: undefined }))))
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    if (window.location.hash === '#production') document.getElementById('production')?.scrollIntoView({ block: 'start' });
  }, [rows === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows) return <section className="panel" id="production"><Loading label="Loading monitors…" /></section>;
  if (!can('monitors.manage')) {
    return (
      <section className="panel" id="production">
        <h2 className="section-title">Production monitors</h2>
        <p className="muted small">{rows.length ? `${rows.length} monitor${rows.length === 1 ? ' is' : 's are'} set up.` : 'No monitors yet.'} Only admins can add or change production monitors.</p>
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
        body: { monitors: rows.map(({ id, name, url, appInsightsAppId, apiKey, link, latencyWarnMs }) => ({ id, name, url, appInsightsAppId, apiKey, link, latencyWarnMs })) },
      });
      setRows(saved.map((m) => ({ ...m, key: m.id, apiKey: undefined })));
      toast('Production monitors saved');
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const test = async (r) => {
    setTests((t) => ({ ...t, [r.key]: { running: true } }));
    try {
      const res = await api('/production/test', { method: 'POST', body: { id: r.id, url: r.url, appInsightsAppId: r.appInsightsAppId, apiKey: r.apiKey } });
      setTests((t) => ({ ...t, [r.key]: res }));
    } catch (e) {
      setTests((t) => ({ ...t, [r.key]: { error: e.message } }));
    }
  };

  return (
    <section className="panel" id="production">
      <h2 className="section-title">Production monitors</h2>
      <p className="muted small">
        Keel checks each URL every minute. With an Application Insights App ID and API key (Application Insights → API Access → Create API key, "Read telemetry"),
        it also tracks failure rates, exceptions and slow requests. Keys are stored encrypted on the server and never shown again.
        {authMode === 'login' && ' Monitors are shared by everyone who uses this Keel server.'}
      </p>

      <div className="monitor-edit-list">
        {rows.map((r) => {
          const t = tests[r.key];
          return (
            <fieldset key={r.key} className="monitor-edit">
              <legend>{r.name || 'New monitor'}</legend>
              <div className="monitor-grid">
                <label>Name<input className="input" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder="Sports (production)" /></label>
                <label>URL to check<input className="input" value={r.url} onChange={(e) => set(r.key, { url: e.target.value })} placeholder="https://sports.example.com/health" inputMode="url" /></label>
                <label>Application Insights App ID <span className="muted small">(optional)</span>
                  <input className="input mono" value={r.appInsightsAppId} onChange={(e) => set(r.key, { appInsightsAppId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
                </label>
                <label>API key
                  <input
                    className="input mono"
                    type="password"
                    autoComplete="off"
                    value={r.apiKey || ''}
                    onChange={(e) => set(r.key, { apiKey: e.target.value })}
                    placeholder={r.hasApiKey ? 'Saved. Type a new key to replace it' : 'Paste the API key'}
                    disabled={r.apiKey === null}
                  />
                  {r.hasApiKey && r.apiKey !== null && <button type="button" className="link-btn small" onClick={() => set(r.key, { apiKey: null })}>Remove saved key</button>}
                  {r.apiKey === null && <span className="small text-warn">The saved key will be removed when you save. <button type="button" className="link-btn" onClick={() => set(r.key, { apiKey: undefined })}>Undo</button></span>}
                </label>
                <label>Deploys come from
                  <select className="input" value={linkValue(r.link)} onChange={(e) => set(r.key, { link: linkOptions.find((o) => o.value === e.target.value)?.link || null })}>
                    <option value="">Not linked</option>
                    {['Release stages', 'Pipelines'].map((g) => (
                      <optgroup key={g} label={g}>
                        {linkOptions.filter((o) => o.group === g).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label>Slow above (ms)<input className="input" type="number" min={100} max={30000} value={r.latencyWarnMs} onChange={(e) => set(r.key, { latencyWarnMs: Number(e.target.value) })} /></label>
              </div>
              <div className="monitor-edit-actions">
                <button type="button" className="btn btn-small" onClick={() => test(r)} disabled={t?.running || (!r.url && !r.appInsightsAppId)}>{t?.running ? 'Testing…' : 'Test'}</button>
                <button type="button" className="btn btn-small btn-ghost text-bad" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>Remove monitor</button>
                {t && !t.running && (
                  <span className="small">
                    {t.error && <span className="text-bad">{t.error}</span>}
                    {t.http && <span className={t.http.ok ? 'text-ok' : 'text-bad'}>URL: {t.http.ok ? `OK, HTTP ${t.http.status} in ${t.http.ms}ms` : t.http.error}</span>}
                    {t.http && t.ai && ' · '}
                    {t.ai && <span className={t.ai.ok ? 'text-ok' : 'text-bad'}>Application Insights: {t.ai.ok ? `OK (${t.ai.total} requests in the last hour)` : t.ai.error}</span>}
                  </span>
                )}
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="monitor-edit-actions">
        <button type="button" className="btn btn-small" onClick={() => setRows((rs) => [...rs, blank()])}>Add monitor</button>
        <button type="button" className="btn btn-primary btn-small" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save monitors'}</button>
      </div>
    </section>
  );
}
