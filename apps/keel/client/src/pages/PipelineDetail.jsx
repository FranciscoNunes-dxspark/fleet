import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime, pct } from '../format.js';
import { t, tx } from '../i18n.js';
import { Chip, Confirm, ErrorBox, Loading } from '../ui.jsx';
import { useProjectLabel } from '../orgs.js';
import { FlakyTests } from './Pipelines.jsx';
import { RunTimesChart } from '../charts.jsx';

// Pipeline details (drawer): the pipeline's latest runs, and for one run its
// stages, jobs and steps, the failed steps' errors and last log lines, the
// commits it built and its test results. A running run refreshes itself.

const HEALTH = {
  healthy: { tone: 'ok', label: 'Healthy' },
  failing: { tone: 'bad', label: 'Failing' },
  unstable: { tone: 'warn', label: 'Unstable' },
  unknown: { tone: 'muted', label: 'No runs' },
};
const REASON = { manual: 'Manual', individualCI: 'CI', batchedCI: 'CI', pullRequest: 'Pull request', schedule: 'Scheduled', resourceTrigger: 'Triggered by a resource', buildCompletion: 'After another build' };
const RESULT = {
  succeeded: { tone: 'ok', label: 'succeeded' },
  succeededWithIssues: { tone: 'warn', label: 'succeeded with warnings' },
  partiallySucceeded: { tone: 'warn', label: 'partially succeeded' },
  failed: { tone: 'bad', label: 'failed' },
  canceled: { tone: 'muted', label: 'canceled' },
  skipped: { tone: 'muted', label: 'skipped' },
  abandoned: { tone: 'muted', label: 'canceled' },
};

/** Tone and words for a run or a timeline record. */
function statusOf({ status, state, result }) {
  const s = status || state;
  if (s === 'notStarted' || s === 'pending') return { tone: 'muted', label: s === 'pending' ? 'waiting' : 'queued', live: false };
  if (s === 'inProgress' || s === 'cancelling') return { tone: 'info', label: 'running', live: true };
  return { ...(RESULT[result] || { tone: 'muted', label: result || 'finished' }), live: false };
}

const seconds = (from, to) => (from ? Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)) : null);
function duration(s) {
  if (s == null) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function Dot({ s }) {
  return <span className={`run-dot run-dot-${s.tone}${s.live ? ' run-dot-live' : ''}`} aria-hidden="true" />;
}

export default function PipelineDetail({ target }) {
  const [projectId, definitionId] = [target.key.slice(0, target.key.lastIndexOf(':')), target.key.slice(target.key.lastIndexOf(':') + 1)];
  const { data, error, reload } = useApi(`/pipelines/${encodeURIComponent(projectId)}/${encodeURIComponent(definitionId)}/runs`);
  const { meta, can, toast, refresh } = useApp();
  const [openId, setOpenId] = useState(target.buildId || null);
  const projectLabel = useProjectLabel();

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;
  const p = data.pipeline;
  const runs = data.runs;
  const name = p?.definition.name || runs[0]?.definition.name || t('Pipeline');
  const projectName = p?.projectName || runs[0]?.projectName;
  // The open run: the one asked for, else one running now, else the latest; -1 = all closed.
  const shown = openId === -1 ? null : runs.find((r) => r.id === openId) || runs.find((r) => r.status !== 'completed') || runs[0] || null;
  const health = HEALTH[p?.health] || HEALTH.unknown;
  const durations = runs.filter((r) => r.status === 'completed' && r.startedAt).map((r) => seconds(r.startedAt, r.finishedAt)).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
  const branch = p?.branch || runs[0]?.sourceBranch;
  // Finished runs, oldest first, for the run times chart.
  const timed = runs.filter((r) => r.status === 'completed' && r.startedAt && r.finishedAt && r.result !== 'canceled').reverse().map((r) => ({
    id: r.id,
    label: r.buildNumber,
    branch: r.sourceBranch.replace(/^refs\/pull\/(\d+)\/merge$/, 'PR $1'),
    failed: r.result === 'failed',
    runMin: seconds(r.startedAt, r.finishedAt) / 60,
    waitMin: r.queuedAt ? Math.max(0, seconds(r.queuedAt, r.startedAt) / 60) : 0,
  }));

  const queue = async () => {
    try {
      await api('/pipelines/queue', { method: 'POST', body: { projectId, definitionId: Number(definitionId), branch } });
      toast(t('Run queued on {branch}', { branch }));
      refresh();
      reload();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  return (
    <div className="detail pipeline-detail">
      <div className="detail-kicker">{[projectName && projectLabel(projectName, data.org || target.org), p?.repoName].filter(Boolean).join(' / ')}</div>
      <h2 className="detail-title">{name}</h2>
      <div className="chips">
        <Chip tone={health.tone}>{t(health.label)}</Chip>
        {branch && <code className="branch">{branch}</code>}
      </div>

      <dl className="facts">
        <div><dt>{t('Success rate')}</dt><dd>{p?.passRate == null ? '—' : pct(p.passRate)}</dd></div>
        <div><dt>{t('Typical duration')}</dt><dd>{median == null ? '—' : duration(median)}<Trend trend={p?.durationTrend} /></dd></div>
        <div><dt>{t('Typical wait for an agent')}</dt><dd>{p?.medianQueueMin == null ? '—' : duration(Math.round(p.medianQueueMin * 60))}</dd></div>
        <div><dt>{t('Last green')}</dt><dd>{p?.lastGreenAt ? t('{age} ago', { age: age(p.lastGreenAt) }) : '—'}</dd></div>
      </dl>

      {timed.length >= 3 && (
        <RunTimesChart
          label={t('Run times, last {n} runs', { n: timed.length })}
          runs={timed}
          onOpen={(r) => setOpenId(r.id)}
        />
      )}

      <section className="detail-section">
        <h3>{t('Recent runs')}</h3>
        {!runs.length && <p className="muted small">{t('No runs yet.')}</p>}
        <ul className="run-list">
          {runs.map((r) => {
            const s = statusOf(r);
            const open = shown?.id === r.id;
            return (
              <li key={r.id} className={open ? 'open' : ''}>
                <button type="button" className="run-row" aria-expanded={open} onClick={() => setOpenId(open ? -1 : r.id)}>
                  <Dot s={s} />
                  <span className="run-name">{r.buildNumber}</span>
                  <span className="run-meta">
                    <code className="branch">{r.sourceBranch.replace(/^refs\/pull\/(\d+)\/merge$/, 'PR $1')}</code>
                    {' · '}{t(REASON[r.reason] || r.reason || 'Run')}
                    {r.requestedFor?.displayName ? ` · ${r.requestedFor.displayName}` : ''}
                  </span>
                  <span className="run-when">
                    {t(s.label)}{' · '}
                    {r.status === 'notStarted' ? t('{age} ago', { age: age(r.queuedAt) }) : t('{age} ago', { age: age(r.startedAt || r.queuedAt) })}
                    {r.startedAt && <> · {duration(seconds(r.startedAt, r.finishedAt))}</>}
                  </span>
                </button>
                {open && <RunDetail projectId={projectId} run={r} />}
              </li>
            );
          })}
        </ul>
      </section>

      <FlakyTests pipelineKey={target.key} limit={5} />

      <section className="detail-actions sticky-actions">
        {can('pipelines.run') && branch && (
          <Confirm text={t('Run on {branch}?', { branch })} onConfirm={queue} className="btn btn-small btn-primary">{t('Run')}</Confirm>
        )}
        <a className="btn btn-ghost btn-small" href={`${meta.orgUrl}/${encodeURIComponent(projectName || projectId)}/_build?definitionId=${definitionId}`} target="_blank" rel="noreferrer noopener">{t('Open in Azure DevOps')} ↗</a>
      </section>
    </div>
  );
}

/** Stages → jobs → steps of one run. Phases are folded into their jobs, checkpoints left out. */
function useTree(records) {
  return useMemo(() => {
    const byParent = new Map();
    for (const r of records) {
      if (!byParent.has(r.parentId)) byParent.set(r.parentId, []);
      byParent.get(r.parentId).push(r);
    }
    const kids = (id) => (byParent.get(id) || [])
      .filter((r) => !r.type.startsWith('Checkpoint'))
      .sort((a, b) => a.order - b.order)
      .flatMap((r) => (r.type === 'Phase' ? kids(r.id) : [r]));
    return { roots: kids(null), kids };
  }, [records]);
}

function RunDetail({ projectId, run }) {
  const { data, error, reload } = useApi(`/builds/${encodeURIComponent(projectId)}/${run.id}`);
  const live = run.status !== 'completed' || (data?.timeline || []).some((r) => r.state === 'inProgress');
  // A running run refreshes every 10 seconds while it's open.
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(reload, 10_000);
    return () => clearInterval(timer);
  }, [live, reload]);
  const { roots, kids } = useTree(data?.timeline || []);

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label={t('Loading the run…')} />;

  return (
    <div className="run-detail">
      {data.approvals.map((a) => (
        <div key={a.id} className="callout callout-warn small">
          {t('Waiting for approval to {stage}.', { stage: a.stage || t('continue') })}{' '}
          <Link to="/pipelines">{t('Approve or reject on the Pipelines page')}</Link>
          {a.instructions && <div className="muted">“{a.instructions}”</div>}
        </div>
      ))}

      {!roots.length && <p className="muted small">{run.status === 'notStarted' ? t('Waiting for an agent. The stages appear when the run starts.') : t('No stages reported for this run.')}</p>}
      <ol className="stage-list">
        {roots.map((st) => <TimelineNode key={st.id} rec={st} kids={kids} logs={data.logs} depth={0} />)}
      </ol>

      {data.tests && (
        <div className="run-block">
          <h4>{t('Tests')}</h4>
          <TestBar tests={data.tests} />
        </div>
      )}

      {data.changes.length > 0 && (
        <div className="run-block">
          <h4>{t('Commits')}</h4>
          <ul className="mini-list">
            {data.changes.map((c) => (
              <li key={c.id}>
                <span className="small">{c.message}</span>
                <span className="muted small">
                  {c.author}{c.at ? ` · ${dateTime(c.at)}` : ''}{' · '}
                  {c.webUrl ? <a href={c.webUrl} target="_blank" rel="noreferrer noopener" className="mono">{c.id.slice(0, 8)}</a> : <span className="mono">{c.id.slice(0, 8)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="small"><a href={run.webUrl} target="_blank" rel="noreferrer noopener">{t('Open this run in Azure DevOps')} ↗</a></p>
    </div>
  );
}

function TimelineNode({ rec, kids, logs, depth }) {
  const s = statusOf(rec);
  const children = kids(rec.id);
  // Open by default: anything failed or running, and the first level of a stage.
  const interesting = s.tone === 'bad' || s.live || rec.warningCount > 0;
  const [open, setOpen] = useState(interesting || (depth === 0 && children.length <= 1));
  const secs = seconds(rec.startedAt, rec.finishedAt);
  return (
    <li className={`tl tl-${rec.type.toLowerCase()}`}>
      <button type="button" className="tl-row" onClick={() => setOpen((o) => !o)} aria-expanded={children.length ? open : undefined} disabled={!children.length && !rec.issues.length && !logs[rec.id]}>
        <Dot s={s} />
        <span className="tl-name">{rec.name}</span>
        {(rec.errorCount > 0 || rec.warningCount > 0) && (
          <span className="tl-counts small">
            {rec.errorCount > 0 && <span className="text-bad">{t(rec.errorCount === 1 ? '1 error' : '{n} errors', { n: rec.errorCount })}</span>}
            {rec.errorCount > 0 && rec.warningCount > 0 && ' · '}
            {rec.warningCount > 0 && <span className="text-warn">{t(rec.warningCount === 1 ? '1 warning' : '{n} warnings', { n: rec.warningCount })}</span>}
          </span>
        )}
        <span className="tl-time muted small">{s.live ? t('running {d}', { d: duration(secs) }) : rec.state === 'completed' && secs != null ? duration(secs) : t(s.label)}</span>
      </button>
      {open && rec.issues.length > 0 && (
        <ul className="tl-issues">
          {rec.issues.map((i, n) => <li key={n} className={i.type === 'error' ? 'text-bad' : 'text-warn'}>{tx(i.message)}</li>)}
        </ul>
      )}
      {open && logs[rec.id] && (
        <details className="log-tail" open>
          <summary className="small muted">{t('Last lines of the log')}</summary>
          <pre>{logs[rec.id]}</pre>
        </details>
      )}
      {open && children.length > 0 && (
        <ol className="tl-children">
          {children.map((c) => <TimelineNode key={c.id} rec={c} kids={kids} logs={logs} depth={depth + 1} />)}
        </ol>
      )}
    </li>
  );
}

function TestBar({ tests }) {
  const { total, passed, failed, other } = tests;
  const w = (n) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <div>
      <div className="test-bar" role="img" aria-label={t('{passed} passed, {failed} failed, {other} other, of {total}', { passed, failed, other, total })}>
        <span className="test-pass" style={{ width: w(passed) }} />
        <span className="test-fail" style={{ width: w(failed) }} />
        <span className="test-other" style={{ width: w(other) }} />
      </div>
      <p className="small">
        <span className="text-ok">{t('{n} passed', { n: passed })}</span>
        {' · '}<span className={failed ? 'text-bad' : 'muted'}>{t('{n} failed', { n: failed })}</span>
        {other > 0 && <span className="muted"> · {t('{n} other', { n: other })}</span>}
        <span className="muted"> · {t('{n} in total', { n: total })}</span>
      </p>
    </div>
  );
}

/** "↑ 35%" when runs got at least 20% slower this week than the week before ("↓" when faster). */
export function Trend({ trend }) {
  if (!trend || trend.change == null || Math.abs(trend.change) < 0.2) return null;
  const up = trend.change > 0;
  return (
    <span className={`trend ${up ? 'text-warn' : 'text-ok'}`} title={t('Median {recent} this week, {before} the week before', { recent: `${Math.round(trend.recentMin)}m`, before: `${Math.round(trend.beforeMin)}m` })}>
      {up ? '↑' : '↓'} {Math.round(Math.abs(trend.change) * 100)}%
    </span>
  );
}
