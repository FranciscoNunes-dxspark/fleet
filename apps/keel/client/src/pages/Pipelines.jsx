import { Fragment, useRef, useState } from 'react';
import { useSticky, useStickyParams } from '../sticky.js';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime, pct } from '../format.js';
import { Chip, Confirm, Empty, ErrorBox, ExternalLink, Loading, PageHeader, Toggle, pinInView } from '../ui.jsx';
import { ApprovalsPanel, ReleasesTab } from './Releases.jsx';
import { Trend } from './PipelineDetail.jsx';
import { t, tj } from '../i18n.js';

export default function Pipelines() {
  const builds = useApi('/pipelines');
  const rel = useApi('/releases');
  const { meta } = useApp();
  const [params, setParams] = useStickyParams('pipelines', ['tab']);
  const tab = ['releases', 'tests'].includes(params.get('tab')) ? params.get('tab') : 'builds';

  const data = builds.data;
  const failing = data ? data.filter((p) => p.health === 'failing').length : 0;
  const allRuns = data ? data.flatMap((p) => p.running) : [];
  const queuedCount = allRuns.filter((r) => r.status === 'notStarted').length;
  const runningCount = allRuns.length - queuedCount;
  const defs = rel.data?.definitions || [];
  const approvals = rel.data?.approvals || [];

  return (
    <div className="page page-wide">
      <PageHeader
        title={t('Pipelines')}
        sub={data
          ? [
            t('{n} build and YAML pipelines judged on their main branch over {days} days', { n: data.length, days: meta.thresholds.buildLookbackDays }),
            t('{n} failing', { n: failing }),
            t('{n} running now', { n: runningCount }),
            ...(queuedCount ? [t('{n} queued', { n: queuedCount })] : []),
            ...(defs.length ? [t(defs.length === 1 ? '{n} classic release pipeline' : '{n} classic release pipelines', { n: defs.length })] : []),
          ].join(' · ')
          : t('Loading pipelines…')}
      />

      {approvals.length > 0 && <ApprovalsPanel approvals={approvals} />}

      <div className="segmented" role="tablist" aria-label={t('Pipeline type')}>
        <button type="button" role="tab" aria-selected={tab === 'builds'} className={tab === 'builds' ? 'on' : ''} onClick={() => setParams({}, { replace: true })}>
          {t('Builds & YAML')}<span className="seg-count">{data?.length ?? '…'}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'releases'} className={tab === 'releases' ? 'on' : ''} onClick={() => setParams({ tab: 'releases' }, { replace: true })}>
          {t('Releases')}<span className="seg-count">{rel.data ? defs.length : '…'}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'tests'} className={tab === 'tests' ? 'on' : ''} onClick={() => setParams({ tab: 'tests' }, { replace: true })}>
          {t('Flaky tests')}
        </button>
      </div>

      {tab === 'builds' && (data ? <BuildsTab data={data} /> : builds.error ? <ErrorBox error={builds.error} onRetry={builds.reload} /> : <Loading />)}
      {tab === 'tests' && <FlakyTests />}
      {tab === 'releases' && (rel.data ? <ReleasesTab defs={defs} /> : rel.error ? <ErrorBox error={rel.error} onRetry={rel.reload} /> : <Loading label={t('Loading release pipelines…')} />)}
    </div>
  );
}

const HEALTH = {
  failing: { tone: 'bad', label: 'Failing' },
  unstable: { tone: 'warn', label: 'Unstable' },
  healthy: { tone: 'ok', label: 'Healthy' },
  unknown: { tone: 'muted', label: 'No runs' },
};
const RESULT = { succeeded: 'ok', partiallySucceeded: 'warn', failed: 'bad', canceled: 'muted' };
const RESULT_LABEL = { succeeded: 'succeeded', failed: 'failed', partiallySucceeded: 'partially succeeded', canceled: 'canceled' };
const resultLabel = (r) => (RESULT_LABEL[r] ? t(RESULT_LABEL[r]) : r);
const RUNNING = '__running__';

// Azure DevOps folder paths look like "\TEAMA\Builds"; the root is "\".
const folderLabel = (path) => (!path || path === '\\' ? t('No folder') : path.replace(/^\\/, '').split('\\').join(' / '));

function BuildsTab({ data }) {
  const { refresh, toast } = useApp();
  const [onlyProblems, setOnlyProblems] = useSticky('pipelines.onlyProblems', false);
  const [byFolder, setByFolder] = useSticky('pipelines.byFolder', true);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [q, setQ] = useState('');

  const rows = data.filter((p) => (!onlyProblems || p.health === 'failing' || p.health === 'unstable' || p.running.length)
    && (!q || `${p.definition.name} ${p.repoName} ${p.projectName} ${p.definition.path}`.toLowerCase().includes(q.toLowerCase())));

  // Running pipelines are listed first, and also stay in their own folder so a
  // row never moves out from under you when you start (or finish) a run.
  const running = rows.filter((p) => p.running.length);
  const rest = rows;
  const groups = [];
  if (running.length) groups.push({ key: RUNNING, label: t('Running or queued'), rows: running });
  if (byFolder) {
    const folders = new Map();
    for (const p of rest) {
      const key = `${data.some((x) => x.projectId !== p.projectId) ? `${p.projectName}:` : ''}${p.definition.path || '\\'}`;
      if (!folders.has(key)) folders.set(key, { key, label: `${folderLabel(p.definition.path)}`, project: p.projectName, rows: [] });
      folders.get(key).rows.push(p);
    }
    const multiProject = new Set([...folders.values()].map((f) => f.project)).size > 1;
    groups.push(...[...folders.values()]
      .map((f) => ({ ...f, label: multiProject ? `${f.project} · ${f.label}` : f.label }))
      .sort((a, b) => (a.label === t('No folder')) - (b.label === t('No folder')) || a.label.localeCompare(b.label)));
  } else if (rest.length) {
    groups.push({ key: 'all', label: running.length ? t('All pipelines') : null, rows: rest });
  }

  const toggleGroup = (key) => setCollapsed((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const queue = async (p, rowEl) => {
    pinInView(rowEl);
    try {
      await api('/pipelines/queue', { method: 'POST', body: { projectId: p.projectId, definitionId: p.definition.id, branch: p.branch } });
      toast(t('Queued {name} on {branch}', { name: p.definition.name, branch: p.branch }));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  return (
    <>
      <div className="filters">
        <input type="search" className="input" placeholder={t('Search pipeline, repo or folder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search pipelines')} />
        <Toggle checked={byFolder} onChange={setByFolder}>{t('Group by folder')}</Toggle>
        <Toggle checked={onlyProblems} onChange={setOnlyProblems} count={data.filter((p) => p.health === 'failing' || p.health === 'unstable').length}>{t('Only failing or unstable')}</Toggle>
      </div>

      {!rows.length ? <Empty title={t('No pipelines match.')} /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Pipeline')}</th>
                <th>{t('Health')}</th>
                <th>{t('Last run')}</th>
                <th>{t('Runs on its branch')} <span className="muted small">{t('(newest first)')}</span></th>
                <th className="num">{t('Pass rate')}</th>
                <th className="num">{t('Median')}</th>
                <th><span className="sr-only">{t('Actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const isCollapsed = collapsed.has(g.key);
                const problems = g.rows.filter((p) => p.health === 'failing').length;
                return (
                  <Fragment key={g.key}>
                    {g.label && (
                      <tr className={`pipeline-group-row ${g.key === RUNNING ? 'pipeline-group-running' : ''}`}>
                        <td colSpan={7}>
                          <button type="button" className="th-btn" aria-expanded={!isCollapsed} onClick={() => toggleGroup(g.key)}>
                            <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span> {g.label}
                            <span className="muted">{g.rows.length}</span>
                            {problems > 0 && g.key !== RUNNING && <span className="text-bad small">{t('{n} failing', { n: problems })}</span>}
                          </button>
                        </td>
                      </tr>
                    )}
                    {!isCollapsed && g.rows.map((p) => <PipelineRow key={p.key} p={p} showFolder={!byFolder || g.key === RUNNING} onQueue={queue} />)}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function PipelineRow({ p, showFolder, onQueue }) {
  const { can, openDrawer, meta } = useApp();
  const canRun = can('pipelines.run');
  const rowRef = useRef(null);
  const run = p.running[0];
  const queued = run?.status === 'notStarted';
  return (
    <tr ref={rowRef}>
      <td className="cell-title">
        <button type="button" className="link-btn strong" onClick={() => openDrawer({ type: 'pipeline', key: p.key })}>{p.definition.name}</button>
        <div className="sub">
          <span>{p.projectName}{p.repoName ? ` / ${p.repoName}` : ''}</span>
          {showFolder && p.definition.path && p.definition.path !== '\\' && <span>{folderLabel(p.definition.path)}</span>}
          {p.branch && <code className="branch">{p.branch}</code>}
        </div>
      </td>
      <td>
        <div className="chips">
          {run && <Chip tone={queued ? 'muted' : 'info'}>{t(queued ? 'Queued' : 'Running')}</Chip>}
          <Chip tone={HEALTH[p.health].tone}>{t(HEALTH[p.health].label)}</Chip>
        </div>
        {run && (
          <div className="small muted">
            {tj(queued ? '{run} queued {age} ago' : '{run} started {age} ago', { run: <a href={run.webUrl} target="_blank" rel="noreferrer noopener">{run.buildNumber}</a>, age: age(queued ? run.queuedAt : run.startedAt || run.queuedAt) })}
            {run.requestedFor?.displayName ? ` ${t('by {name}', { name: run.requestedFor.displayName })}` : ''}{run.sourceBranch && run.sourceBranch !== p.branch ? ` ${t('on {branch}', { branch: run.sourceBranch })}` : ''}
            {p.running.length > 1 && ` ${t('(+{n} more)', { n: p.running.length - 1 })}`}
          </div>
        )}
        {p.health === 'failing' && <div className="small text-bad">{p.lastGreenAt ? t('{n} in a row, last green {age} ago', { n: p.failStreak, age: age(p.lastGreenAt) }) : t('{n} in a row', { n: p.failStreak })}</div>}
      </td>
      <td className="small">
        {p.lastRun ? <>
          <a href={p.lastRun.webUrl} target="_blank" rel="noreferrer noopener" title={`${resultLabel(p.lastRun.result)} · ${dateTime(p.lastRun.finishedAt)}`}>{p.lastRun.buildNumber}</a>
          {p.lastRun.result !== 'succeeded' && <span className={`small text-${RESULT[p.lastRun.result] === 'bad' ? 'bad' : 'warn'}`}> {resultLabel(p.lastRun.result)}</span>}
          <div className="muted">
            {t('{age} ago', { age: age(p.lastRun.finishedAt) })} · {p.lastRun.requestedFor?.displayName}
            {p.lastRun.sourceBranch !== p.branch && <> · <code className="branch">{p.lastRun.sourceBranch.replace(/^refs\/pull\/(\d+)\/merge$/, 'PR $1')}</code></>}
          </div>
        </> : '—'}
      </td>
      <td>
        {!p.recent.length && !run && <span className="muted small">{t('No runs in the last {n} days', { n: meta.thresholds.buildLookbackDays })}{p.paused ? ` · ${t('paused')}` : ''}</span>}
        <div className="runs" aria-label={t(p.recent.length === 1 ? 'Last {n} result' : 'Last {n} results', { n: p.recent.length })}>
          {p.recent.map((r) => (
            <a key={r.id} href={r.webUrl} target="_blank" rel="noreferrer noopener" className={`run run-${RESULT[r.result] || 'muted'}`} title={`${r.buildNumber} · ${resultLabel(r.result)} · ${dateTime(r.finishedAt)}`}>
              <span className="sr-only">{resultLabel(r.result)}</span>
            </a>
          ))}
        </div>
      </td>
      <td className={`num ${p.passRate !== null && p.passRate < 0.8 ? 'text-warn strong' : ''}`}>{pct(p.passRate)}</td>
      <td className="num muted">{p.medianDurationMin != null ? `${Math.round(p.medianDurationMin)}m` : '—'}<Trend trend={p.durationTrend} /></td>
      <td className="row-actions">
        {canRun && <Confirm text={t('Run on {branch}?', { branch: p.branch })} onConfirm={() => onQueue(p, rowRef.current)} className="btn btn-small btn-ghost">{t('Run')}</Confirm>}
        <ExternalLink href={(run || p.lastRun)?.webUrl || p.webUrl}>{t('Open')}</ExternalLink>
      </td>
    </tr>
  );
}

/**
 * Tests that fail now and then on a pipeline's own branch and pass again
 * without a fix (server/domain/tests.js). Worst first; each links to the
 * run where it last failed.
 */
export function FlakyTests({ pipelineKey = null, limit = null }) {
  const { openDrawer } = useApp();
  const { data, error, reload } = useApi('/tests/flaky');
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label={t('Reading test results…')} />;
  const tests = data.tests.filter((x) => !pipelineKey || x.pipeline.key === pipelineKey);
  const shown = limit ? tests.slice(0, limit) : tests;
  if (pipelineKey && !tests.length) return null;

  const intro = !pipelineKey && (
    <p className="muted small delivery-intro">
      {t('Tests that failed and then passed again without a fix, on each pipeline\'s own branch over the last {days} days: re-run on the same commit and passed, or failed at least twice with passes in between. Only failed runs\' test results are read.', { days: data.days })}
      {' '}{t('{runs} runs of {pipelines} pipelines looked at.', { runs: data.analyzed.runs, pipelines: data.analyzed.pipelines })}
    </p>
  );
  const body = (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('Test')}</th>
            {!pipelineKey && <th>{t('Pipeline')}</th>}
            <th className="num">{t('Failed')}</th>
            {!pipelineKey && <th className="num" title={t('Times it went from failing to passing or back')}>{t('Flips')}</th>}
            <th>{t('Last failed')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((x) => (
            <tr key={`${x.pipeline.org || ''}:${x.pipeline.key}:${x.name}`}>
              <td className="flaky-test">
                <span className="strong mono small" title={x.name}>{x.shortName}</span>
                <div className="chips">
                  {x.sameCommit && <Chip tone="warn" title={t('It failed, then passed when the same commit was run again')}>{t('Passed on a re-run')}</Chip>}
                  {x.failingNow && <Chip tone="bad">{t('Failed in the latest run')}</Chip>}
                </div>
                {x.error && <div className="small muted truncate" title={x.error}>{x.error}</div>}
              </td>
              {!pipelineKey && (
                <td>
                  <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'pipeline', key: x.pipeline.key, org: x.pipeline.org })}>{x.pipeline.name}</button>
                  <div className="small muted">{x.pipeline.projectName} · {x.pipeline.branch}</div>
                </td>
              )}
              <td className="num">{x.fails}/{x.runs} <span className="muted small">{pct(x.failRate)}</span>{pipelineKey && <div className="small muted">{t('{n} flips', { n: x.flips })}</div>}</td>
              {!pipelineKey && <td className="num">{x.flips}</td>}
              <td>
                <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'pipeline', key: x.pipeline.key, buildId: x.lastFailedRun.id, org: x.pipeline.org })}>{x.lastFailedRun.buildNumber}</button>
                <div className="small muted">{t('{age} ago', { age: age(x.lastFailedAt) })}</div>
              </td>
            </tr>
          ))}
          {!shown.length && (
            <tr><td colSpan={pipelineKey ? 3 : 5} className="muted">
              {data.noTestData
                ? t('No test results could be read for the failed runs. Either the pipelines publish no test results, or the token lacks the Test Management (Read) scope.')
                : t('No flaky tests found in this period.')}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
  if (pipelineKey) {
    return (
      <section className="detail-section">
        <h3>{t('Flaky tests')} <span className="muted small">{tests.length}</span></h3>
        {body}
        {limit && tests.length > limit && <p className="small muted">{t('{n} more on Pipelines → Flaky tests.', { n: tests.length - limit })}</p>}
      </section>
    );
  }
  return <section>{intro}{body}</section>;
}
