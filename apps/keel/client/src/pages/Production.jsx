import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../context.js';
import { age, dateTime, pct } from '../format.js';
import { useWidth } from '../charts.jsx';
import { Chip, Empty, ErrorBox, Loading, PageHeader } from '../ui.jsx';
import { t, tj, tx } from '../i18n.js';

const STATE = {
  up: { tone: 'ok', label: 'Up' },
  degraded: { tone: 'warn', label: 'Degraded' },
  down: { tone: 'bad', label: 'Down' },
  unknown: { tone: 'muted', label: 'No data yet' },
};
const HOUR = 3_600_000;
const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

export default function Production() {
  const { data, error, reload } = useApi('/production');
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  const monitors = data.monitors;
  const problems = monitors.filter((m) => m.state === 'down' || m.state === 'degraded').length;

  return (
    <div className="page page-wide">
      <PageHeader
        title={t('Production')}
        sub={monitors.length
          ? [
            t(monitors.length === 1 ? '{n} monitor' : '{n} monitors', { n: monitors.length }),
            problems ? t(problems === 1 ? '{n} needs attention' : '{n} need attention', { n: problems }) : t('all healthy'),
            t('URLs checked every minute, Application Insights every 5 minutes'),
          ].join(' · ')
          : t('Watch your production apps next to the deploys that change them.')}
      >
        <Link className="btn btn-small" to="/settings#production">{t('Manage monitors')}</Link>
      </PageHeader>

      {!monitors.length && (
        <Empty title={t('No production monitors yet.')}>
          {tj('Add one in {link}: a URL to check, and optionally an Application Insights App ID and API key for error rates. Link it to the release stage or pipeline that deploys it to see deploys on the charts.', {
            link: <Link to="/settings#production">{t('Settings → Production monitors')}</Link>,
          })}
        </Empty>
      )}

      <div className="monitor-list">
        {monitors.map((m) => <MonitorCard key={m.id} m={m} />)}
      </div>
    </div>
  );
}

function MonitorCard({ m }) {
  const s = STATE[m.state] || STATE.unknown;
  const ai = m.ai;
  const since = Date.now() - 24 * HOUR;
  const markers = m.markers.filter((d) => Date.parse(d.at) >= since);
  return (
    <section className={`panel monitor monitor-${m.state}`} aria-label={m.name}>
      <header className="monitor-head">
        <div>
          <h2>{m.name}</h2>
          {m.url && <a className="small muted" href={m.url} target="_blank" rel="noreferrer noopener">{m.url}</a>}
          {m.platform && (
            <div className="small muted">
              {[m.platform.product, m.platform.site, m.platform.version && t('version {v}', { v: m.platform.version })].filter(Boolean).join(' · ')}
              {m.hasTotalsKey && <> · <Link to={`/totals/${m.id}`}>{t('Platform totals')}</Link></>}
            </div>
          )}
        </div>
        <Chip tone={s.tone}>{t(s.label)}</Chip>
      </header>

      {m.issues.length > 0 && (
        <ul className="reasons monitor-issues">
          {m.issues.map((i) => <li key={i.code} className={`reason reason-${i.severity}`}>{tx(i.text)}</li>)}
        </ul>
      )}

      <dl className="fact-row monitor-facts">
        {m.url && <>
          <div className="fact"><dt>{t('Response')}</dt><dd>{m.last ? (m.last.ok ? ms(m.last.ms) : m.last.status || t('Failed')) : '—'}</dd><dd className="muted small">{m.last ? t('checked {age} ago', { age: age(m.last.at) }) : t('not checked yet')}</dd></div>
          <div className="fact"><dt>{t('Uptime, 24h')}</dt><dd>{m.uptime24h == null ? '—' : pct(m.uptime24h)}</dd><dd className="muted small">p95 {ms(m.p95ms)}</dd></div>
        </>}
        {ai && <>
          <div className="fact"><dt>{t('Requests, 1h')}</dt><dd>{ai.total.toLocaleString()}</dd><dd className="muted small">p95 {ms(ai.p95)}</dd></div>
          <div className="fact"><dt>{t('Failing, 1h')}</dt><dd className={ai.failRate >= 0.05 ? 'text-bad' : ''}>{pct(ai.failRate)}</dd><dd className="muted small">{t(ai.failed === 1 ? '{n} request' : '{n} requests', { n: ai.failed.toLocaleString() })}</dd></div>
          <div className="fact"><dt>{t('Exceptions, 1h')}</dt><dd>{ai.exceptions.toLocaleString()}</dd><dd className="muted small">Application Insights</dd></div>
        </>}
      </dl>

      <div className="monitor-charts">
        {m.url && m.history.length > 1 && (
          <TimeChart
            title={t('Response time, 24h')}
            points={m.history.map((h) => ({ at: h.at, value: h.ok ? h.ms : null, failed: !h.ok }))}
            markers={markers}
            format={ms}
            limit={m.latencyWarnMs}
          />
        )}
        {ai?.series?.length > 1 && (
          <TimeChart
            title={t('Failed requests, 24h')}
            bars
            points={ai.series.map((b) => ({ at: b.at, value: b.total ? b.failed / b.total : 0, detail: t('{failed} of {total}', { failed: b.failed, total: b.total }) }))}
            markers={markers}
            format={(v) => pct(v)}
          />
        )}
      </div>

      <div className="monitor-lists">
        {ai?.topFailures?.length > 0 && (
          <div>
            <h3 className="small">{t('Top failing operations, 1h')}</h3>
            <ul className="mini-list">
              {ai.topFailures.map((f) => (
                <li key={`${f.name}${f.code}`}><span className="mono small">{f.name}</span><span className="muted small">{f.count} × HTTP {f.code}</span></li>
              ))}
            </ul>
          </div>
        )}
        {m.markers.length > 0 && (
          <div>
            <h3 className="small">{t('Recent deploys')}</h3>
            <ul className="mini-list">
              {m.markers.slice(0, 5).map((d) => (
                <li key={`${d.label}${d.at}`}>
                  <a href={d.webUrl} target="_blank" rel="noreferrer noopener" className="small">{d.label}</a>
                  <span className="muted small">{d.status} · {dateTime(d.at)}{d.by ? ` · ${d.by}` : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {m.aiError && <p className="small text-warn">Application Insights: {tx(m.aiError)}</p>}
        {!m.link && <p className="muted small">{t('Link this monitor to its release stage or pipeline in Settings to see deploys here.')}</p>}
      </div>
    </section>
  );
}

/**
 * 24h time series (line or bars) with deploy markers as vertical lines.
 * Failed checks show as red ticks on the baseline. Hover shows the value.
 */
function TimeChart({ title, points, markers, format, limit, bars = false }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const W = width || 520;
  const H = 120;
  const pad = { l: 44, r: 8, t: 10, b: 18 };
  const t1 = Date.now();
  const t0 = t1 - 24 * HOUR;
  const x = (at) => pad.l + ((Date.parse(at) - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const values = points.map((p) => p.value).filter((v) => v != null);
  const max = Math.max(limit || 0, ...values, bars ? 0.01 : 1) * 1.15;
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);

  let path = '';
  if (!bars) {
    let pen = false;
    for (const p of points) {
      if (p.value == null) {
        pen = false;
        continue;
      }
      path += `${pen ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`;
      pen = true;
    }
  }
  const barW = Math.max(2, ((W - pad.l - pad.r) / Math.max(points.length, 1)) - 2);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = null;
    for (const p of points) if (!best || Math.abs(x(p.at) - px) < Math.abs(x(best.at) - px)) best = p;
    setHover(best);
  };

  return (
    <figure className="chart time-chart">
      <figcaption className="chart-title">{title}</figcaption>
      <div className="chart-body" ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={title} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {[0, max / 2].map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={pad.l - 6} y={y(v) + 4} className="axis" textAnchor="end">{format(v)}</text>
            </g>
          ))}
          {limit && <line x1={pad.l} x2={W - pad.r} y1={y(limit)} y2={y(limit)} className="limit-line" />}
          {bars
            ? points.map((p) => p.value > 0 && <rect key={p.at} x={x(p.at) - barW / 2} y={y(p.value)} width={barW} height={Math.max(1, y(0) - y(p.value))} rx="2" className={p.value >= 0.05 ? 'bar bar-bad' : 'bar'} />)
            : <path d={path} className="line" />}
          {points.filter((p) => p.failed).map((p) => <rect key={`f${p.at}`} x={x(p.at) - 1.5} y={y(0) - 8} width="3" height="8" className="fail-tick" />)}
          {markers.map((d) => (
            <g key={`${d.label}${d.at}`}>
              <line x1={x(d.at)} x2={x(d.at)} y1={pad.t} y2={H - pad.b} className="deploy-line" />
              <text x={x(d.at) + 3} y={pad.t + 8} className="deploy-label">{d.label}</text>
            </g>
          ))}
          {hover && <line x1={x(hover.at)} x2={x(hover.at)} y1={pad.t} y2={H - pad.b} className="hover-line" />}
          <text x={pad.l} y={H - 4} className="axis">{t('24h ago')}</text>
          <text x={W - pad.r} y={H - 4} className="axis" textAnchor="end">{t('now')}</text>
        </svg>
        {hover && (
          <div className="tooltip" style={{ left: `${(x(hover.at) / W) * 100}%`, top: `${(pad.t / H) * 100}%`, transform: 'translate(-50%, 0)' }}>
            <strong>{hover.failed ? t('Check failed') : hover.value == null ? '—' : format(hover.value)}</strong>
            <div className="muted">{dateTime(hover.at)}{hover.detail ? ` · ${hover.detail}` : ''}</div>
          </div>
        )}
      </div>
    </figure>
  );
}
