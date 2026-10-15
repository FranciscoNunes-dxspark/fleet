import { Fragment, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { age, dateTime } from '../format.js';
import { Chip, Confirm, Empty } from '../ui.jsx';

const HEALTH = {
  failing: { tone: 'bad', label: 'Failing' },
  unstable: { tone: 'warn', label: 'Unstable' },
  healthy: { tone: 'ok', label: 'Healthy' },
  unknown: { tone: 'muted', label: 'Never deployed' },
};
const STAGE_TONE = {
  succeeded: 'ok', partiallySucceeded: 'warn', rejected: 'bad', canceled: 'muted',
  inProgress: 'info', queued: 'info', scheduled: 'info', notStarted: 'muted',
};
const STAGE_LABEL = {
  succeeded: 'Succeeded', partiallySucceeded: 'Partially succeeded', rejected: 'Failed', canceled: 'Canceled',
  inProgress: 'Deploying', queued: 'Queued', scheduled: 'Scheduled', notStarted: 'Not deployed',
};
const folderLabel = (path) => (!path || path === '\\' ? 'No folder' : path.replace(/^\\/, '').split('\\').join(' / '));

/** Deployments waiting for a decision: classic release approvals and YAML environment checks. */
export function ApprovalsPanel({ approvals }) {
  const { refresh, toast, can } = useApp();
  const canDecide = can('approvals.decide');
  const [comments, setComments] = useState({});
  const [busy, setBusy] = useState(null);
  const mine = approvals.filter((a) => a.canDecide && canDecide);

  const decide = async (a, status) => {
    setBusy(a.key);
    try {
      await api(`/approvals/${a.kind}/${encodeURIComponent(a.id)}`, { method: 'POST', body: { status, comment: comments[a.key] || '' } });
      toast(`${status === 'approved' ? 'Approved' : 'Rejected'}: ${a.pipeline}${a.stage ? ` → ${a.stage}` : ''}`);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel approvals" aria-label="Approvals waiting">
      <h2 className="section-title">
        Approvals waiting{' '}
        <span className="muted small">{mine.length} you can act on{approvals.length > mine.length ? `, ${approvals.length - mine.length} assigned to others` : ''}</span>
      </h2>
      <ul className="approval-list">
        {approvals.map((a) => (
          <li key={a.key} className={`approval ${a.canDecide ? 'approval-mine' : ''}`}>
            <div className="approval-main">
              <div>
                <Chip tone={a.kind === 'yaml' ? 'info' : 'accent'}>{a.kind === 'yaml' ? 'Pipeline check' : 'Release approval'}</Chip>
                {' '}<strong>{a.pipeline}</strong>{a.stage && <> → <strong>{a.stage}</strong></>}
              </div>
              <div className="small muted">
                {a.projectName}
                {a.run && <> · {a.run.webUrl ? <a href={a.run.webUrl} target="_blank" rel="noreferrer noopener">{a.run.name}</a> : a.run.name}</>}
                {' '}· waiting {age(a.createdOn)}
                {a.approvers.length > 0 && <> · approvers: {a.approvers.map((x) => x.displayName).join(', ')}</>}
                {a.minRequired > 1 && <> · needs {a.minRequired}</>}
              </div>
              {a.instructions && <p className="approval-instructions small">“{a.instructions}”</p>}
            </div>
            {a.canDecide && canDecide ? (
              <div className="approval-actions">
                <input
                  className="input" placeholder="Comment (optional)" value={comments[a.key] || ''}
                  onChange={(e) => setComments((c) => ({ ...c, [a.key]: e.target.value }))} aria-label={`Comment for ${a.pipeline}`}
                />
                <button type="button" className="btn btn-small btn-primary" disabled={busy === a.key} onClick={() => decide(a, 'approved')}>{busy === a.key ? '…' : 'Approve'}</button>
                <Confirm text={`Reject the ${a.stage || 'stage'} deployment?`} onConfirm={() => decide(a, 'rejected')} className="btn btn-small btn-ghost text-bad">Reject</Confirm>
              </div>
            ) : <span className="small muted">Assigned to others. Open it in Azure DevOps to see who.</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StageChip({ stage }) {
  const shown = stage.active || stage.latest;
  if (!shown) {
    return (
      <span className="stage stage-muted" title={`${stage.name}: never deployed`}>
        <span className="stage-name">{stage.name}</span><span className="stage-status">Not deployed</span>
      </span>
    );
  }
  const tone = STAGE_TONE[shown.status] || 'muted';
  const title = [
    `${stage.name}: ${STAGE_LABEL[shown.status] || shown.status} · ${shown.releaseName} · ${dateTime(shown.at)}`,
    shown.requestedFor ? `By ${shown.requestedFor.displayName}${shown.reason ? ` (${shown.reason})` : ''}` : '',
    stage.active && stage.latest ? `Last finished: ${stage.latest.releaseName} (${STAGE_LABEL[stage.latest.status] || stage.latest.status})` : '',
  ].filter(Boolean).join('\n');
  return (
    <a className={`stage stage-${tone}`} href={shown.webUrl} target="_blank" rel="noreferrer noopener" title={title}>
      <span className="stage-name">{stage.name}</span>
      <span className="stage-status">{STAGE_LABEL[shown.status] || shown.status} · {shown.releaseName} · {age(shown.at)}</span>
    </a>
  );
}

export function ReleasesTab({ defs }) {
  const { refresh, toast, can } = useApp();
  const canRun = can('releases.run');
  const [q, setQ] = useState('');
  const [deploying, setDeploying] = useState(null);

  if (!defs.length) {
    return (
      <Empty title="No classic release pipelines in your tracked projects.">
        Release pipelines (Pipelines → Releases in Azure DevOps) show up here with each stage&apos;s latest deployment.
      </Empty>
    );
  }
  const rows = defs.filter((d) => !q || `${d.name} ${d.projectName} ${d.path} ${d.stages.map((s) => s.name).join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const folders = new Map();
  for (const d of rows) {
    const key = `${d.projectName}|${d.path}`;
    if (!folders.has(key)) folders.set(key, { key, label: `${d.projectName} · ${folderLabel(d.path)}`, rows: [] });
    folders.get(key).rows.push(d);
  }

  const createRelease = async (d) => {
    try {
      const r = await api('/releases/create', { method: 'POST', body: { projectId: d.projectId, definitionId: d.id } });
      toast(`Created ${r.name}`);
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  return (
    <>
      <div className="filters">
        <input type="search" className="input" placeholder="Search release pipeline or stage" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search release pipelines" />
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Release pipeline</th>
              <th>Health</th>
              <th>Stages <span className="muted small">(latest deployment)</span></th>
              <th>Latest release</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {[...folders.values()].sort((a, b) => a.label.localeCompare(b.label)).map((g) => (
              <Fragment key={g.key}>
                {folders.size > 1 && <tr className="pipeline-group-row"><td colSpan={5}>{g.label} <span className="muted">{g.rows.length}</span></td></tr>}
                {g.rows.map((d) => {
                  const latest = d.releases[0];
                  return (
                    <Fragment key={d.key}>
                      <tr>
                        <td className="cell-title">
                          <a className="strong" href={d.webUrl} target="_blank" rel="noreferrer noopener">{d.name}</a>
                          <div className="sub">
                            <span>{d.projectName}</span>
                            {d.artifacts.filter((a) => a.sourceName).slice(0, 2).map((a) => <span key={a.alias}>from {a.sourceName}</span>)}
                          </div>
                        </td>
                        <td><Chip tone={HEALTH[d.health].tone}>{HEALTH[d.health].label}</Chip></td>
                        <td><div className="stages">{d.stages.map((s) => <StageChip key={s.id} stage={s} />)}</div></td>
                        <td className="small">
                          {latest ? <>
                            <a href={latest.webUrl} target="_blank" rel="noreferrer noopener">{latest.name}</a>
                            <div className="muted">{age(latest.createdOn)} ago{latest.createdBy ? ` · ${latest.createdBy.displayName}` : ''}</div>
                          </> : '—'}
                        </td>
                        <td className="row-actions">
                          {canRun && <Confirm text={`Create a new release of ${d.name} from the latest artifacts?`} onConfirm={() => createRelease(d)} className="btn btn-small btn-ghost">Create release</Confirm>}
                          {canRun && <button
                            type="button" className="btn btn-small btn-ghost" aria-expanded={deploying === d.key} disabled={!d.releases.length}
                            onClick={() => setDeploying((k) => (k === d.key ? null : d.key))}
                          >
                            Deploy…
                          </button>}
                        </td>
                      </tr>
                      {deploying === d.key && (
                        <tr className="deploy-row"><td colSpan={5}><DeployForm def={d} onDone={() => setDeploying(null)} /></td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Deploy (or redeploy) one release to one stage. */
function DeployForm({ def, onDone }) {
  const { refresh, toast } = useApp();
  const [releaseId, setReleaseId] = useState(String(def.releases[0]?.id || ''));
  const release = def.releases.find((r) => String(r.id) === releaseId);
  const stages = release?.stages || [];
  const [stageId, setStageId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  // Default to the first stage this release hasn't reached yet.
  const stage = stages.find((s) => String(s.id) === stageId) || stages.find((s) => s.status !== 'succeeded') || stages[0];
  const verb = stage?.status === 'succeeded' ? 'Redeploy' : 'Deploy';

  const deploy = async () => {
    setBusy(true);
    try {
      await api('/releases/deploy', { method: 'POST', body: { projectId: def.projectId, releaseId: release.id, environmentId: stage.id, comment } });
      toast(`Deploying ${release.name} to ${stage.name}`);
      refresh();
      onDone();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="deploy-form">
      <label>Release
        <select className="input" value={releaseId} onChange={(e) => { setReleaseId(e.target.value); setStageId(''); }}>
          {def.releases.map((r) => <option key={r.id} value={r.id}>{r.name} · {age(r.createdOn)} ago</option>)}
        </select>
      </label>
      <label>Stage
        <select className="input" value={stage ? String(stage.id) : ''} onChange={(e) => setStageId(e.target.value)}>
          {stages.map((s) => <option key={s.id} value={s.id}>{s.name} ({STAGE_LABEL[s.status] || s.status})</option>)}
        </select>
      </label>
      <label className="grow">Comment
        <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional" />
      </label>
      <div className="deploy-actions">
        <Confirm
          text={`${verb} ${release?.name} to ${stage?.name}? Approvals and gates on that stage still apply.`}
          onConfirm={deploy}
          className="btn btn-small btn-primary"
        >
          {busy ? 'Starting…' : verb}
        </Confirm>
        <button type="button" className="btn btn-small btn-ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
