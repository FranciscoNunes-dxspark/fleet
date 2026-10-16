import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime } from '../format.js';
import { locale, t, tj, tx } from '../i18n.js';
import { AREAS, KEY_FIGURES, areaLabel, figureLabel } from '../platformLabels.js';
import { useSticky } from '../sticky.js';
import { Chip, Empty, ErrorBox, Loading, PageHeader } from '../ui.jsx';

// Platform totals (platform/v1 /totals): what each club site holds, fetched on a schedule.

const num = (n) => (n == null ? '—' : n.toLocaleString(locale()));
const signed = (d) => `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toLocaleString(locale())}`;
const monthName = (m) => new Date(Date.UTC(2026, m - 1, 1)).toLocaleString(locale(), { month: 'short', timeZone: 'UTC' });

/** Status of a site's totals: fetching, error, degraded, ok, or not fetched yet. */
function SiteState({ s }) {
  if (s.fetching) return <Chip tone="info">{t('Fetching…')}</Chip>;
  if (s.lastError) return <Chip tone="bad" title={tx(s.lastError)}>{t('Failed')}</Chip>;
  if (s.latest?.status === 'degraded') return <Chip tone="warn" title={(s.latest.failing || []).map((c) => tx(c.message || c.name)).join(' · ')}>{t('Incomplete')}</Chip>;
  if (!s.latest) return <Chip>{t('Not fetched yet')}</Chip>;
  return null;
}

const everyLabel = (h) => t(h === 1 ? 'every hour' : 'every {n} hours', { n: h });

export default function Totals() {
  const { id } = useParams();
  return id ? <SiteTotals id={id} /> : <TotalsOverview />;
}

function TotalsOverview() {
  const { data, error, reload } = useApi('/production/totals');
  const { can } = useApp();
  const navigate = useNavigate();
  // "key" = the key figures; otherwise an area's figures.
  const [view, setView] = useSticky('totals.view', 'key');

  const types = useMemo(() => {
    const seen = new Map();
    for (const s of data || []) for (const x of s.latest?.totals || []) if (!seen.has(x.type)) seen.set(x.type, x);
    return [...seen.values()].sort((a, b) => (a.typeId ?? 999) - (b.typeId ?? 999));
  }, [data]);

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const areas = AREAS.filter((a) => types.some((x) => x.areas.includes(a)));
  const columns = view === 'key'
    ? KEY_FIGURES.filter((k) => types.some((x) => x.type === k))
    : types.filter((x) => x.areas.includes(view)).map((x) => x.type);
  const seasons = [...new Set(data.map((s) => s.latest?.season?.name).filter(Boolean))];

  return (
    <div className="page">
      <PageHeader
        title={t('Platform totals')}
        sub={data.length
          ? [t(data.length === 1 ? '{n} site' : '{n} sites', { n: data.length }), seasons.length === 1 ? t('season {name}', { name: seasons[0] }) : null, t('the figures from each site\'s Platform Totals screen')].filter(Boolean).join(' · ')
          : t('What each club site holds, from the Platform Totals screen.')}
      >
        {can('monitors.manage') && <Link className="btn btn-small" to="/settings#production">{t('Manage sites')}</Link>}
      </PageHeader>

      {!data.length && (
        <Empty title={t('No sites with platform totals yet.')}>
          {tj('In {link}, add the site\'s URL and its totals key (the X-Totals-Key the site was given). Keel fetches the figures on a schedule, at most every hour, because each fetch keeps the club database busy.', {
            link: <Link to="/settings#production">{t('Settings → Production monitors')}</Link>,
          })}
        </Empty>
      )}

      {data.length > 0 && (
        <>
          <div className="toolbar">
            <label className="totals-view">{t('Figures')}
              <select className="input" value={view} onChange={(e) => setView(e.target.value)}>
                <option value="key">{t('Key figures')}</option>
                <optgroup label={t('By area')}>
                  {areas.map((a) => <option key={a} value={a}>{areaLabel(a)}</option>)}
                </optgroup>
              </select>
            </label>
            <span className="muted small">{t('Change since the previous fetch.')}</span>
          </div>

          <div className="table-wrap">
            <table className="table totals-table">
              <thead>
                <tr>
                  <th>{t('Site')}</th>
                  {columns.map((c) => <th key={c} className="num">{figureLabel(c)}</th>)}
                  <th>{t('Fetched')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => {
                  const values = Object.fromEntries((s.latest?.totals || []).map((x) => [x.type, x.total]));
                  return (
                    <tr key={s.id} className="clickable" onClick={() => navigate(`/totals/${s.id}`)}>
                      <td>
                        <Link to={`/totals/${s.id}`} className="totals-site" onClick={(e) => e.stopPropagation()}>{s.name}</Link>
                        <div className="muted small">{[s.latest?.product, s.latest?.site, s.latest?.season?.name].filter(Boolean).join(' · ') || s.url}</div>
                        <SiteState s={s} />
                      </td>
                      {columns.map((c) => {
                        const v = values[c];
                        const prev = s.previous?.values?.[c];
                        const d = v != null && prev != null ? v - prev : null;
                        return (
                          <td key={c} className="num">
                            <div className="totals-value">{num(v)}</div>
                            {d != null && d !== 0 && <div className={`small ${d > 0 ? 'text-ok' : 'text-warn'}`} title={t('since {date}', { date: dateTime(s.previous.at) })}>{signed(d)}</div>}
                          </td>
                        );
                      })}
                      <td className="nowrap small">
                        {s.latest ? t('{age} ago', { age: age(s.latest.at) }) : '—'}
                        <div className="muted">{everyLabel(s.every)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SiteTotals({ id }) {
  const { data, error, reload } = useApi(`/production/totals/${encodeURIComponent(id)}`);
  const { can, toast, refresh } = useApp();
  const [starting, setStarting] = useState(false);

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  const latest = data.latest;
  const previous = data.history.length > 1 ? data.history.at(-2) : null;

  const fetchNow = async () => {
    setStarting(true);
    try {
      await api(`/production/totals/${encodeURIComponent(id)}/fetch`, { method: 'POST' });
      toast(t('Fetching the totals. This can take a few minutes.'));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setStarting(false);
    }
  };

  // Figures grouped by the screen's sections; a figure listed in no area goes under "Other".
  const groups = [];
  if (latest) {
    for (const a of AREAS) {
      const list = latest.totals.filter((x) => x.areas.includes(a));
      if (list.length) groups.push({ key: a, label: areaLabel(a), list });
    }
    const known = new Set(AREAS);
    const other = latest.totals.filter((x) => !x.areas.some((a) => known.has(a)));
    if (other.length) groups.push({ key: 'other', label: t('Other'), list: other });
  }

  return (
    <div className="page">
      <PageHeader
        title={data.name}
        sub={[latest?.product, latest?.site, latest?.version && t('version {v}', { v: latest.version }), latest?.season?.name ? t('season {name}', { name: latest.season.name }) : latest?.season?.scope === 'all' ? t('all seasons') : null].filter(Boolean).join(' · ') || data.url}
      >
        <Link className="btn btn-small btn-ghost" to="/totals">{t('All sites')}</Link>
        {can('monitors.manage') && data.enabled && (
          <button type="button" className="btn btn-small" onClick={fetchNow} disabled={starting || data.fetching}>{data.fetching ? t('Fetching…') : t('Fetch now')}</button>
        )}
      </PageHeader>

      <p className="muted small totals-when">
        {latest ? t('Fetched {when} ({age} ago), in {s}s.', { when: dateTime(latest.at), age: age(latest.at), s: Math.round(latest.durationMs / 1000) }) : t('Not fetched yet.')}
        {' '}{data.enabled ? t('Fetched {every}.', { every: everyLabel(data.every) }) : t('No totals key: not fetched any more.')}
        {data.nextAt && !data.fetching && <> {t('Next: {when}.', { when: dateTime(data.nextAt) })}</>}
      </p>

      {data.lastError && <div className="callout callout-bad">{t('The last fetch failed: {error}', { error: tx(data.lastError) })}</div>}
      {latest?.status === 'degraded' && (
        <div className="callout callout-warn">
          {t('Some figures are missing from this fetch:')}{' '}
          {(latest.failing || []).map((c) => `${figureLabel(c.name)}${c.message ? ` (${tx(c.message)})` : ''}`).join('; ')}
        </div>
      )}

      {!latest && !data.lastError && <Empty title={t('No figures yet.')}>{data.fetching ? t('The first fetch is running. It can take a few minutes.') : t('The figures appear after the first fetch.')}</Empty>}

      {groups.map((g) => (
        <section key={g.key} className="panel totals-area">
          <h2 className="section-title">{g.label}</h2>
          <div className="table-wrap totals-area-table">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Figure')}</th>
                  <th className="num">{t('Total')}</th>
                  <th className="num">{t('Change')}</th>
                  <th>{t('Trend this season')}</th>
                  <th>{t('By month')}</th>
                </tr>
              </thead>
              <tbody>
                {g.list.map((x) => {
                  const prev = previous?.values?.[x.type];
                  const d = prev != null ? x.total - prev : null;
                  return (
                    <tr key={x.type}>
                      <td>{figureLabel(x.type)}</td>
                      <td className="num totals-value">{num(x.total)}</td>
                      <td className={`num small ${d > 0 ? 'text-ok' : d < 0 ? 'text-warn' : 'muted'}`} title={previous ? t('since {date}', { date: dateTime(previous.at) }) : undefined}>{d == null ? '—' : signed(d)}</td>
                      <td><Spark points={data.history.map((p) => ({ at: p.at, value: p.values[x.type] }))} label={figureLabel(x.type)} /></td>
                      <td>{x.months ? <MonthBars months={x.months} label={figureLabel(x.type)} /> : <span className="muted small">{t('Season total only')}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

/** The figure's total at each fetch this season. Hover a point for its date and value. */
function Spark({ points, label }) {
  const pts = points.filter((p) => p.value != null);
  if (pts.length < 2) return <span className="muted small">{t('After two fetches')}</span>;
  const W = 140;
  const H = 32;
  const t0 = Date.parse(pts[0].at);
  const t1 = Date.parse(pts.at(-1).at) || t0 + 1;
  const lo = Math.min(...pts.map((p) => p.value));
  const hi = Math.max(...pts.map((p) => p.value));
  const x = (p) => 2 + ((Date.parse(p.at) - t0) / Math.max(1, t1 - t0)) * (W - 4);
  const y = (p) => (hi === lo ? H / 2 : H - 3 - ((p.value - lo) / (hi - lo)) * (H - 6));
  const last = pts.at(-1);
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('{label}: from {from} to {to}', { label, from: num(pts[0].value), to: num(last.value) })}>
      <polyline points={pts.map((p) => `${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p) => (
        <circle key={p.at} cx={x(p)} cy={y(p)} r="5" className="spark-hit"><title>{`${dateTime(p.at)}: ${num(p.value)}`}</title></circle>
      ))}
      <circle cx={x(last)} cy={y(last)} r="3" className="spark-end" />
    </svg>
  );
}

/** Counts per calendar month, in the order the site reports them (a season can run Aug–Jun). */
function MonthBars({ months, label }) {
  if (!months.length) return <span className="muted small">—</span>;
  const max = Math.max(1, ...months.map((m) => m.count));
  const W = 12;
  const H = 32;
  return (
    <svg className="month-bars" width={months.length * (W + 2)} height={H + 12} viewBox={`0 0 ${months.length * (W + 2)} ${H + 12}`} role="img" aria-label={t('{label} by month', { label })}>
      {months.map((m, i) => {
        const h = Math.max(1, (m.count / max) * H);
        return (
          <g key={m.month}>
            <rect x={i * (W + 2)} y={H - h} width={W} height={h} rx="2"><title>{`${monthName(m.month)}: ${num(m.count)}`}</title></rect>
            <text x={i * (W + 2) + W / 2} y={H + 10} textAnchor="middle">{monthName(m.month).slice(0, 1).toUpperCase()}</text>
          </g>
        );
      })}
    </svg>
  );
}
