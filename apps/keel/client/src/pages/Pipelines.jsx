import { Fragment, useRef, useState } from 'react';
import { useSticky, useStickyParams } from '../sticky.js';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime, pct } from '../format.js';
import { Chip, Confirm, Empty, ErrorBox, ExternalLink, Loading, PageHeader, Toggle, pinInView } from '../ui.jsx';
import { ApprovalsPanel, ReleasesTab } from './Releases.jsx';

export default function Pipelines() {
  const builds = useApi('/pipelines');
  const rel = useApi('/releases');
  const { meta } = useApp();
  const [params, setParams] = useStickyParams('pipelines', ['tab']);
  const tab = params.get('tab') === 'releases' ? 'releases' : 'builds';

  const data = builds.data;
  const failing = data ? data.filter((p) => p.health === 'failing').length : 0;
  const runningCount = data ? data.reduce((s, p) => s + p.running.length, 0) : 0;
  const defs = rel.data?.definitions || [];
  const approvals = rel.data?.approvals || [];

  return (
    <div className="page">
      <PageHeader
        title="Pipelines"
        sub={data
          ? `${data.length} build and YAML pipelines judged on their main branch over ${meta.thresholds.buildLookbackDays} days · ${failing} failing · ${runningCount} running now${defs.length ? ` · ${defs.length} classic release pipeline${defs.length === 1 ? '' : 's'}` : ''}`
          : 'Loading pipelines…'}
      />

      {approvals.length > 0 && <ApprovalsPanel approvals={approvals} />}

      <div className="segmented" role="tablist" aria-label="Pipeline type">
        <button type="button" role="tab" aria-selected={tab === 'builds'} className={tab === 'builds' ? 'on' : ''} onClick={() => setParams({}, { replace: true })}>
          Builds &amp; YAML<span className="seg-count">{data?.length ?? '…'}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'releases'} className={tab === 'releases' ? 'on' : ''} onClick={() => setParams({ tab: 'releases' }, { replace: true })}>
          Releases<span className="seg-count">{rel.data ? defs.length : '…'}</span>
        </button>
      </div>

      {tab === 'builds' && (data ? <BuildsTab data={data} /> : builds.error ? <ErrorBox error={builds.error} onRetry={builds.reload} /> : <Loading />)}
      {tab === 'releases' && (rel.data ? <ReleasesTab defs={defs} /> : rel.error ? <ErrorBox error={rel.error} onRetry={rel.reload} /> : <Loading label="Loading release pipelines…" />)}
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
const RESULT_LABEL = { failed: 'failed', partiallySucceeded: 'partially succeeded', canceled: 'canceled' };
const RUNNING = '__running__';

// Azure DevOps folder paths look like "\TEAMA\Builds"; the root is "\".
const folderLabel = (path) => (!path || path === '\\' ? 'No folder' : path.replace(/^\\/, '').split('\\').join(' / '));

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
  if (running.length) groups.push({ key: RUNNING, label: 'Running now', rows: running });
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
      .sort((a, b) => (a.label === 'No folder') - (b.label === 'No folder') || a.label.localeCompare(b.label)));
  } else if (rest.length) {
    groups.push({ key: 'all', label: running.length ? 'All pipelines' : null, rows: rest });
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
      toast(`Queued ${p.definition.name} on ${p.branch}`);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  return (
    <>
      <div className="filters">
        <input type="search" className="input" placeholder="Search pipeline, repo or folder" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search pipelines" />
        <Toggle checked={byFolder} onChange={setByFolder}>Group by folder</Toggle>
        <Toggle checked={onlyProblems} onChange={setOnlyProblems} count={data.filter((p) => p.health === 'failing' || p.health === 'unstable').length}>Only failing or unstable</Toggle>
      </div>

      {!rows.length ? <Empty title="No pipelines match." /> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Health</th>
                <th>Last run</th>
                <th>Runs on its branch <span className="muted small">(newest first)</span></th>
                <th className="num">Pass rate</th>
                <th className="num">Median</th>
                <th><span className="sr-only">Actions</span></th>
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
                            {problems > 0 && g.key !== RUNNING && <span className="text-bad small">{problems} failing</span>}
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
  const { can } = useApp();
  const canRun = can('pipelines.run');
  const rowRef = useRef(null);
  const run = p.running[0];
  return (
    <tr ref={rowRef}>
      <td className="cell-title">
        <span className="strong">{p.definition.name}</span>
        <div className="sub">
          <span>{p.projectName}{p.repoName ? ` / ${p.repoName}` : ''}</span>
          {showFolder && p.definition.path && p.definition.path !== '\\' && <span>{folderLabel(p.definition.path)}</span>}
          {p.branch && <code className="branch">{p.branch}</code>}
        </div>
      </td>
      <td>
        <div className="chips">
          {run && <Chip tone="info">Running</Chip>}
          <Chip tone={HEALTH[p.health].tone}>{HEALTH[p.health].label}</Chip>
        </div>
        {run && (
          <div className="small muted">
            <a href={run.webUrl} target="_blank" rel="noreferrer noopener">{run.buildNumber}</a> started {age(run.startedAt || run.queuedAt)} ago
            {run.requestedFor?.displayName ? ` by ${run.requestedFor.displayName}` : ''}{run.sourceBranch && run.sourceBranch !== p.branch ? ` on ${run.sourceBranch}` : ''}
            {p.running.length > 1 && ` (+${p.running.length - 1} more)`}
          </div>
        )}
        {p.health === 'failing' && <div className="small text-bad">{p.failStreak} in a row{p.lastGreenAt ? `, last green ${age(p.lastGreenAt)} ago` : ''}</div>}
      </td>
      <td className="small">
        {p.lastRun ? <>
          <a href={p.lastRun.webUrl} target="_blank" rel="noreferrer noopener" title={`${p.lastRun.result} · ${dateTime(p.lastRun.finishedAt)}`}>{p.lastRun.buildNumber}</a>
          {p.lastRun.result !== 'succeeded' && <span className={`small text-${RESULT[p.lastRun.result] === 'bad' ? 'bad' : 'warn'}`}> {RESULT_LABEL[p.lastRun.result] || p.lastRun.result}</span>}
          <div className="muted">
            {age(p.lastRun.finishedAt)} ago · {p.lastRun.requestedFor?.displayName}
            {p.lastRun.sourceBranch !== p.branch && <> · <code className="branch">{p.lastRun.sourceBranch.replace(/^refs\/pull\/(\d+)\/merge$/, 'PR $1')}</code></>}
          </div>
        </> : '—'}
      </td>
      <td>
        <div className="runs" aria-label={`Last ${p.recent.length} results`}>
          {p.recent.map((r) => (
            <a key={r.id} href={r.webUrl} target="_blank" rel="noreferrer noopener" className={`run run-${RESULT[r.result] || 'muted'}`} title={`${r.buildNumber} · ${r.result} · ${dateTime(r.finishedAt)}`}>
              <span className="sr-only">{r.result}</span>
            </a>
          ))}
        </div>
      </td>
      <td className={`num ${p.passRate !== null && p.passRate < 0.8 ? 'text-warn strong' : ''}`}>{pct(p.passRate)}</td>
      <td className="num muted">{p.medianDurationMin != null ? `${Math.round(p.medianDurationMin)}m` : '—'}</td>
      <td className="row-actions">
        {canRun && <Confirm text={`Run on ${p.branch}?`} onConfirm={() => onQueue(p, rowRef.current)} className="btn btn-small btn-ghost">Run</Confirm>}
        <ExternalLink href={(run || p.lastRun)?.webUrl}>Open</ExternalLink>
      </td>
    </tr>
  );
}
