import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { hours, pct } from '../format.js';
import { Chip, ErrorBox, Loading } from '../ui.jsx';
import { t } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';

// DORA performance bands (server/domain/delivery.js bands), as the Delivery tab shows them.
const BAND = {
  elite: { tone: 'ok', label: 'Elite' },
  high: { tone: 'info', label: 'High' },
  medium: { tone: 'warn', label: 'Medium' },
  low: { tone: 'bad', label: 'Low' },
};
const TREND = {
  better: { tone: 'text-ok', mark: '▲' },
  worse: { tone: 'text-bad', mark: '▼' },
  same: { tone: 'muted', mark: '=' },
};
const WINDOWS = [12, 24, 48, 72, 168];
const perWeek = (n) => (n == null ? '—' : n >= 10 ? Math.round(n).toString() : n.toFixed(1));

// The four measures: how each reads, and how its value from the period before reads.
const MEASURES = [
  { id: 'frequency', label: 'Deployment frequency', value: (m) => t('{n} a week', { n: perWeek(m.perWeek) }), before: (tr) => t('{n} deploys', { n: tr.previous }) },
  { id: 'leadTime', label: 'Lead time for changes', value: (m) => hours(m.hours), before: (tr) => hours(tr.previous) },
  { id: 'failureRate', label: 'Change failure rate', value: (m) => pct(m.rate), before: (tr) => pct(tr.previous) },
  { id: 'restore', label: 'Time to restore', value: (m) => hours(m.hours), before: (tr) => hours(tr.previous) },
];

const bandChip = (b) => (b ? <Chip tone={BAND[b].tone} title={t('DORA performance band')}>{t(BAND[b].label)}</Chip> : null);

function Trend({ trend, measure, days }) {
  if (!trend?.direction) return null;
  const look = TREND[trend.direction];
  return <span className={`small ${look.tone}`} title={t('Against the {days} days before', { days })}>{look.mark} {t('was {value}', { value: measure.before(trend) })}</span>;
}

/** Which environments count as production, and the failure window: the lead's own settings. */
function ProductionForm({ settings, onSaved }) {
  const { toast } = useApp();
  const [names, setNames] = useState(settings?.dora?.production ?? '');
  const [windowHours, setWindowHours] = useState(settings?.dora?.windowHours ?? 24);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setNames(settings?.dora?.production ?? '');
    setWindowHours(settings?.dora?.windowHours ?? 24);
  }, [settings]);
  const dirty = names !== (settings?.dora?.production ?? '') || Number(windowHours) !== (settings?.dora?.windowHours ?? 24);
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api('/settings', { method: 'PUT', body: { dora: { production: names, windowHours: Number(windowHours) } } });
      toast(t('Settings saved'));
      onSaved();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="filters dora-form" onSubmit={save}>
      <label className="small">
        {t('Production is')}{' '}
        <input className="input" value={names} onChange={(e) => setNames(e.target.value)} placeholder={t('stages named like prod (default)')} aria-label={t('Production environments, comma-separated')} />
      </label>
      <label className="small">
        {t('A failure counts against a deploy within')}{' '}
        <select className="input" value={windowHours} onChange={(e) => setWindowHours(e.target.value)} aria-label={t('Failure window')}>
          {WINDOWS.map((h) => <option key={h} value={h}>{h < 48 ? t('{n} hours', { n: h }) : t('{n} days', { n: h / 24 })}</option>)}
        </select>
      </label>
      <button type="submit" className="btn" disabled={!dirty || saving}>{saving ? t('Saving…') : t('Save')}</button>
    </form>
  );
}

/**
 * DORA metrics for the Insights page: the four measures per project and team, over 30 or 90 days
 * against the period before, each with its band and how it was counted (server/domain/dora.js).
 */
export default function Dora({ days }) {
  const span = days >= 90 ? 90 : 30;
  const projectLabel = useProjectLabel();
  const settings = useApi('/settings');
  const { data, error, reload } = useApi(`/dora?days=${span}`);
  const [scopeKey, setScopeKey] = useState('all');

  const head = (
    <>
      <p className="muted small delivery-intro">
        {t('The four DORA measures per project and team, over the last {days} days against the {days} before. Each says how it was counted, so the numbers can be checked.', { days: span })}
        {days < 30 ? ` ${t('Shorter periods than 30 days say little here, so this tab shows 30.')}` : ''}
      </p>
      <ProductionForm settings={settings.data?.settings} onSaved={() => { settings.reload(); reload(); }} />
    </>
  );
  if (!data) return <section>{head}{error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />}</section>;

  const scopes = data.scopes;
  const scope = scopes.find((s) => `${s.org || ''}:${s.key}` === scopeKey) || scopes[0];
  const scopeName = (s) => (s.kind === 'all' ? t('Everything') : s.kind === 'project' ? projectLabel(s.name, s.org) : `${s.name} · ${projectLabel(s.projectName, s.org)}`);
  const envs = data.production.environments;

  return (
    <section className="delivery dora">
      {head}
      <p className="small">
        {envs.length
          ? t('Production here: {list}.', { list: envs.map((e) => e.name).join(', ') })
          : data.production.names.length
            ? t('No environment is named {names}. Check the names above (a release stage, or what a production monitor is linked to).', { names: data.production.names.join(', ') })
            : t('No production environment found. Link a production monitor to the release stage or pipeline that deploys it, or name the classic release stage "Production".')}
      </p>
      {scopes.length > 1 && (
        <div className="filters">
          <select className="input" value={`${scope.org || ''}:${scope.key}`} onChange={(e) => setScopeKey(e.target.value)} aria-label={t('Project or team')}>
            {scopes.map((s) => <option key={`${s.org || ''}:${s.key}`} value={`${s.org || ''}:${s.key}`}>{s.kind === 'team' ? t('Team: {name}', { name: scopeName(s) }) : scopeName(s)}</option>)}
          </select>
        </div>
      )}
      <dl className="fact-row">
        {MEASURES.map((m) => {
          const v = scope.current[m.id];
          return (
            <div key={m.id} className="fact">
              <dt>{t(m.label)}</dt>
              <dd>{m.value(v)} {bandChip(v.band)}</dd>
              <dd><Trend trend={scope.trend[m.id]} measure={m} days={span} /></dd>
              <dd className="muted small">{t(v.how.text, v.how.params)}</dd>
            </div>
          );
        })}
      </dl>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('Project or team')}</th>
              {MEASURES.map((m) => <th key={m.id} className="num">{t(m.label)}</th>)}
            </tr>
          </thead>
          <tbody>
            {scopes.map((s) => (
              <tr key={`${s.org || ''}:${s.key}`} className={`clickable${s === scope ? ' row-open' : ''}`} onClick={() => setScopeKey(`${s.org || ''}:${s.key}`)}>
                <td><span className="strong">{s.kind === 'team' ? s.name : scopeName(s)}</span>{s.kind === 'team' && <span className="muted small"> {projectLabel(s.projectName, s.org)}</span>}</td>
                {MEASURES.map((m) => {
                  const tr = s.trend[m.id];
                  return (
                    <td key={m.id} className="num">
                      {m.value(s.current[m.id])} {bandChip(s.current[m.id].band)}
                      {tr?.direction && tr.direction !== 'same' && <span className={`small ${TREND[tr.direction].tone}`}> {TREND[tr.direction].mark}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
