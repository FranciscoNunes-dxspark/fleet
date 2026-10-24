import { Fragment, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useApp } from '../context.js';
import { age, dateTime, pct } from '../format.js';
import { Fade, useWidth } from '../charts.jsx';
import { Chip, Empty, ErrorBox, Loading, PageHeader, ProductionTabs } from '../ui.jsx';
import { t, tj, tx } from '../i18n.js';
import { deployStatus } from './DeployDetail.jsx';
import { api } from '../api.js';
import { regressionBug } from '../regressionBug.js';
import { PREF_KEYS, pushPref } from '../prefs.js';

const STATE = {
  up: { tone: 'ok', label: 'Up' },
  degraded: { tone: 'warn', label: 'Degraded' },
  down: { tone: 'bad', label: 'Down' },
  deploying: { tone: 'info', label: 'Deploying' },
  settling: { tone: 'info', label: 'Just deployed' },
  unknown: { tone: 'muted', label: 'No data yet' },
};
// Problems first: outages, then degraded, then deploys under way. Ties keep their order from Settings.
const RANK = { down: 0, degraded: 1, deploying: 2, settling: 3, up: 4, unknown: 5 };
const HOUR = 3_600_000;
// Deploys whose contents can be shown (DeployDetail.jsx); running or waiting ones link to Azure DevOps.
const FINISHED = new Set(['succeeded', 'partiallySucceeded', 'failed', 'rejected']);
// Issues worth a bug report: an outage, failing requests, and failures that rose after a deploy.
const BUG_WORTHY = new Set(['down', 'failures', 'deploy-regression']);
const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

function loadView() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEYS.production) || 'null')?.view === 'compact' ? 'compact' : 'detailed';
  } catch {
    return 'detailed';
  }
}

function saveView(view) {
  try {
    localStorage.setItem(PREF_KEYS.production, JSON.stringify({ view }));
  } catch {
    // Storage unavailable (private mode): the choice lasts for this visit only.
  }
  pushPref('production', { view }); // follows your account to other devices
}

export default function Production() {
  const { data, error, reload } = useApi('/production');
  const [view, setView] = useState(loadView);
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  const monitors = [...data.monitors].sort((a, b) => (RANK[a.state] ?? RANK.unknown) - (RANK[b.state] ?? RANK.unknown));
  const pick = (v) => {
    setView(v);
    saveView(v);
  };
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
        {monitors.length > 0 && (
          <div className="segmented segmented-compact" role="radiogroup" aria-label={t('Monitor view')}>
            <button type="button" role="radio" aria-checked={view === 'compact'} className={view === 'compact' ? 'on' : ''} onClick={() => pick('compact')}>{t('Compact')}</button>
            <button type="button" role="radio" aria-checked={view === 'detailed'} className={view === 'detailed' ? 'on' : ''} onClick={() => pick('detailed')}>{t('Detailed')}</button>
          </div>
        )}
        <Link className="btn btn-small" to="/settings#production">{t('Manage monitors')}</Link>
      </PageHeader>
      <ProductionTabs />

      {!monitors.length && (
        <Empty title={t('No production monitors yet.')}>
          {tj('Add one in {link}: a URL to check, and optionally an Application Insights App ID and API key for error rates. Link it to the release stage or pipeline that deploys it to see deploys on the charts.', {
            link: <Link to="/settings#production">{t('Settings → Production monitors')}</Link>,
          })}
        </Empty>
      )}

      {monitors.length > 0 && (view === 'compact'
        ? <CompactList monitors={monitors} />
        : (
          <div className="monitor-list">
            {monitors.map((m) => <MonitorCard key={m.id} m={m} />)}
          </div>
        ))}
    </div>
  );
}

/** One row per monitor, to see many at once; a row opens into its full card. */
function CompactList({ monitors }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((was) => {
    const next = new Set(was);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <div className="table-wrap">
      <table className="table monitor-table">
        <thead>
          <tr>
            <th>{t('Monitor')}</th>
            <th>{t('State')}</th>
            <th className="num">{t('Response')}</th>
            <th className="num">{t('Uptime, 24h')}</th>
            <th className="num">{t('Failing, 1h')}</th>
            <th>{t('Response time, 24h')}</th>
            <th>{t('Last deploy')}</th>
          </tr>
        </thead>
        <tbody>
          {monitors.map((m) => {
            const isOpen = open.has(m.id);
            const s = STATE[m.state] || STATE.unknown;
            const issue = m.issues[0];
            const deploy = m.markers[0];
            return (
              <Fragment key={m.id}>
                {/* The whole row opens the card; the button is there for the keyboard (its click bubbles up). */}
                <tr className={`clickable monitor-row monitor-row-${m.state}`} onClick={() => toggle(m.id)}>
                  <td className="cell-title">
                    <button type="button" className="row-link" aria-expanded={isOpen}>
                      <span aria-hidden="true" className="muted">{isOpen ? '▾' : '▸'}</span> {m.name}
                    </button>
                    {issue
                      ? <div className={`reason reason-${issue.severity} small`}>{tx(issue.text)}{m.issues.length > 1 && <span className="muted">{t('+{n} more', { n: m.issues.length - 1 })}</span>}</div>
                      : m.url && <div className="muted small monitor-row-url">{m.url}</div>}
                  </td>
                  <td><Chip tone={s.tone}>{t(s.label)}</Chip></td>
                  <td className="num">{m.url && m.last ? (m.last.ok ? ms(m.last.ms) : m.last.status || t('Failed')) : '—'}</td>
                  <td className="num">{m.url && m.uptime24h != null ? pct(m.uptime24h) : '—'}</td>
                  <td className={`num${m.ai?.failRate >= 0.05 ? ' text-bad' : ''}`}>{m.ai ? pct(m.ai.failRate) : '—'}</td>
                  <td>{m.url ? <ResponseSpark history={m.history} /> : <span className="muted">—</span>}</td>
                  <td>
                    {deploy
                      ? <><div className="monitor-row-deploy">{deploy.label}</div><div className="muted small">{t('{age} ago', { age: age(deploy.at) })}</div></>
                      : <span className="muted">—</span>}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="monitor-row-detail">
                    <td colSpan={7}><MonitorCard m={m} /></td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Response time over 24h, small enough for a row; failed checks are red ticks on the baseline. */
function ResponseSpark({ history }) {
  if (history.length < 2) return <span className="muted">—</span>;
  const W = 120;
  const H = 28;
  const t1 = Date.now();
  const t0 = t1 - 24 * HOUR;
  const x = (at) => 1 + ((Date.parse(at) - t0) / (t1 - t0)) * (W - 2);
  const hi = Math.max(1, ...history.filter((h) => h.ok).map((h) => h.ms));
  const y = (v) => H - 2 - (v / hi) * (H - 4);
  let path = '';
  let pen = false;
  for (const h of history) {
    if (!h.ok) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${x(h.at).toFixed(1)},${y(h.ms).toFixed(1)}`;
    pen = true;
  }
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Response time, 24h')}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {history.filter((h) => !h.ok).map((h) => <rect key={h.at} x={x(h.at) - 1} y={H - 6} width="2" height="6" className="fail-tick" />)}
    </svg>
  );
}

function MonitorCard({ m }) {
  const { openDrawer, can, toast } = useApp();
  const [filing, setFiling] = useState(null);
  // A bug with what Keel knows; for a regression, what the deploy shipped (and links to its work items).
  const fileBug = async (issue) => {
    setFiling(issue.code);
    try {
      const changes = issue.code === 'deploy-regression' && m.targetKey && issue.deploy?.id != null
        ? await api(`/deploys/${encodeURIComponent(m.link.projectId)}/changes?target=${encodeURIComponent(m.targetKey)}&id=${encodeURIComponent(issue.deploy.id)}`).catch(() => null)
        : null;
      openDrawer(regressionBug(m, issue, changes));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setFiling(null);
    }
  };
  const s = STATE[m.state] || STATE.unknown;
  // What a deploy shipped (DeployDetail.jsx), for monitors linked to a release stage or pipeline.
  const openDeploy = (d) => m.targetKey && d?.id != null && openDrawer({ type: 'deploy', projectId: m.link.projectId, target: m.targetKey, id: d.id });
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
          {m.issues.map((i) => (
            <li key={i.code} className={`reason reason-${i.severity}`}>
              {tx(i.text)}
              {i.code === 'deploying' && m.deploy?.webUrl && <> · <a href={m.deploy.webUrl} target="_blank" rel="noreferrer noopener">{t('View the deploy')}</a></>}
              {i.code === 'deploy-regression' && m.targetKey && i.deploy?.id != null && <> · <button type="button" className="link-btn" onClick={() => openDeploy(i.deploy)}>{t('See what changed')}</button></>}
              {BUG_WORTHY.has(i.code) && can('workitems.write') && <> · <button type="button" className="link-btn" onClick={() => fileBug(i)} disabled={!!filing}>{filing === i.code ? t('Preparing…') : t('File a bug')}</button></>}
            </li>
          ))}
        </ul>
      )}

      <dl className="fact-row monitor-facts">
        {m.url && <>
          <div className="fact"><dt>{t('Response')}</dt><dd>{m.last ? (m.last.ok ? ms(m.last.ms) : m.last.status || t('Failed')) : '—'}</dd><dd className="muted small">{m.last ? t('checked {age} ago', { age: age(m.last.at) }) : t('not checked yet')}</dd></div>
          <div className="fact"><dt>{t('Uptime, 24h')}</dt><dd>{m.uptime24h == null ? '—' : pct(m.uptime24h)}</dd><dd className="muted small">p95 {ms(m.p95ms)}</dd></div>
        </>}
        {ai && <>
          <div className="fact"><dt>{t('Requests, 1h')}</dt><dd>{ai.total.toLocaleString()}</dd><dd className="muted small">p95 {ms(ai.p95)}</dd></div>
          <div className="fact"><dt>{t('Failing, 1h')}</dt><dd className={ai.failRate >= 0.05 ? 'text-bad' : ''}>{pct(ai.failRate)}</dd><dd className="muted small">{t(ai.failed === 1 ? '{n} server error (5xx)' : '{n} server errors (5xx)', { n: ai.failed.toLocaleString() })}</dd></div>
          {ai.notFound != null && (
            <div className="fact" title={t("Requests for pages that don't exist, mostly bots and old links. Not counted as failing.")}>
              <dt>{t('Not found, 1h')}</dt><dd>{ai.notFound.toLocaleString()}</dd><dd className="muted small">{t('404, not counted as failing')}</dd>
            </div>
          )}
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
            title={t('Server errors (5xx), 24h')}
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
        {ai?.topNotFound?.length > 0 && (
          <div>
            <h3 className="small">{t('Most requested missing pages (404), 1h')}</h3>
            <ul className="mini-list">
              {ai.topNotFound.map((f) => (
                <li key={f.name}><span className="mono small">{f.name}</span><span className="muted small">{f.count} ×</span></li>
              ))}
            </ul>
          </div>
        )}
        {m.markers.length > 0 && (
          <div>
            <h3 className="small">{t('Recent deploys')}</h3>
            <ul className="deploy-rows">
              {m.markers.slice(0, 5).map((d) => {
                const status = deployStatus(d.status);
                const body = (
                  <>
                    <span className="deploy-row-main">
                      <span className="deploy-row-label">{d.label}</span>
                      <span className="muted small">{dateTime(d.at)}{d.by ? ` · ${d.by}` : ''}</span>
                    </span>
                    <Chip tone={status.tone}>{t(status.label)}</Chip>
                  </>
                );
                return (
                  <li key={`${d.label}${d.at}`}>
                    {m.targetKey && FINISHED.has(d.status)
                      ? <button type="button" className="deploy-row" onClick={() => openDeploy(d)} title={t('What this deploy shipped')}>{body}<span className="deploy-row-go" aria-hidden="true">›</span></button>
                      : <a className="deploy-row" href={d.webUrl} target="_blank" rel="noreferrer noopener" title={t('Open in Azure DevOps')}>{body}<span className="deploy-row-go" aria-hidden="true">↗</span></a>}
                  </li>
                );
              })}
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
  // The shaded area under the line: one closed shape per unbroken run of readings.
  let area = '';
  const fade = `area${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (!bars) {
    let run = [];
    const close = () => {
      if (run.length > 1) area += `M${run[0][0]},${y(0).toFixed(1)}${run.map(([px, py]) => `L${px},${py}`).join('')}L${run.at(-1)[0]},${y(0).toFixed(1)}Z`;
      run = [];
    };
    let pen = false;
    for (const p of points) {
      if (p.value == null) {
        pen = false;
        close();
        continue;
      }
      const px = x(p.at).toFixed(1);
      const py = y(p.value).toFixed(1);
      path += `${pen ? 'L' : 'M'}${px},${py}`;
      run.push([px, py]);
      pen = true;
    }
    close();
  }
  // A bar spans its own bucket (Application Insights' are 30 minutes, and leaves out empty ones), ending at "now".
  const gaps = points.slice(1).map((p, i) => Date.parse(p.at) - Date.parse(points[i].at)).filter((g) => g > 0);
  const bucket = gaps.length ? Math.min(...gaps) : 30 * 60_000;
  const inPlot = (px) => Math.min(W - pad.r, Math.max(pad.l, px));
  const barOf = (p) => {
    const from = inPlot(x(p.at)) + 1;
    const to = inPlot(x(new Date(Date.parse(p.at) + bucket).toISOString())) - 1;
    return { x: from, width: Math.max(2, to - from) };
  };

  // Deploy labels: beside their line, on its left near the right edge; newest first, and one that
  // would overlap a newer one is left out (its line stays, and hovering it names the deploy).
  const labelW = (s) => String(s).length * 6.2;
  const placed = [];
  const labels = new Map();
  for (const d of [...markers].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const at = x(d.at);
    const w = labelW(d.label);
    const right = at + 3 + w <= W - pad.r;
    const from = right ? at + 3 : at - 3 - w;
    if (from < pad.l || placed.some(([a, b]) => from < b + 6 && from + w > a - 6)) continue;
    placed.push([from, from + w]);
    labels.set(d, right ? { x: at + 3, anchor: 'start' } : { x: at - 3, anchor: 'end' });
  }

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
            ? points.map((p) => p.value > 0 && <rect key={p.at} {...barOf(p)} y={y(p.value)} height={Math.max(1, y(0) - y(p.value))} rx="2" className={p.value >= 0.05 ? 'bar bar-bad' : 'bar'} />)
            : <><Fade id={fade} className="fade fade-area" /><path d={area} className="area" style={{ fill: `url(#${fade})` }} /><path d={path} className="line" /></>}
          {points.filter((p) => p.failed).map((p) => <rect key={`f${p.at}`} x={x(p.at) - 1.5} y={y(0) - 8} width="3" height="8" className="fail-tick" />)}
          {markers.map((d) => {
            const l = labels.get(d);
            return (
              <g key={`${d.label}${d.at}`}>
                <title>{d.label}</title>
                <line x1={x(d.at)} x2={x(d.at)} y1={pad.t} y2={H - pad.b} className="deploy-line" />
                {l && <text x={l.x} y={pad.t + 8} textAnchor={l.anchor} className="deploy-label">{d.label}</text>}
              </g>
            );
          })}
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
