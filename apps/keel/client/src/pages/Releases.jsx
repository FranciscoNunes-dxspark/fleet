import { Fragment, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.js';
import { age, bytes, dateTime } from '../format.js';
import { Chip, Confirm, Empty } from '../ui.jsx';
import { t } from '../i18n.js';
import { approvalPath } from '../orgs.js';

const HEALTH = {
  failing: { tone: 'bad', label: 'Failing' },
  unstable: { tone: 'warn', label: 'Unstable' },
  healthy: { tone: 'ok', label: 'Healthy' },
  unknown: { tone: 'muted', label: 'Never deployed' },
};
const STAGE_TONE = {
  succeeded: 'ok', partiallySucceeded: 'warn', rejected: 'bad', canceled: 'muted', declined: 'muted',
  inProgress: 'info', queued: 'info', scheduled: 'info', notStarted: 'muted',
};
const STAGE_LABEL = {
  succeeded: 'Succeeded', partiallySucceeded: 'Partially succeeded', rejected: 'Failed', canceled: 'Canceled', declined: 'Declined',
  inProgress: 'Deploying', queued: 'Queued', scheduled: 'Scheduled', notStarted: 'Not deployed',
};
// Labels are English keys, translated when shown; unknown Azure DevOps statuses pass through.
const stageLabel = (status) => (STAGE_LABEL[status] ? t(STAGE_LABEL[status]) : status);
const folderLabel = (path) => (!path || path === '\\' ? t('No folder') : path.replace(/^\\/, '').split('\\').join(' / '));

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
      await api(approvalPath(a), { method: 'POST', body: { status, comment: comments[a.key] || '' } });
      const what = `${a.pipeline}${a.stage ? ` → ${a.stage}` : ''}`;
      toast(t(status === 'approved' ? 'Approved: {name}' : 'Rejected: {name}', { name: what }));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel approvals" aria-label={t('Approvals waiting')}>
      <h2 className="section-title">
        {t('Approvals waiting')}{' '}
        <span className="muted small">{approvals.length > mine.length ? t('{n} you can act on, {m} assigned to others', { n: mine.length, m: approvals.length - mine.length }) : t('{n} you can act on', { n: mine.length })}</span>
      </h2>
      <ul className="approval-list">
        {approvals.map((a) => (
          <li key={a.key} className={`approval ${a.canDecide ? 'approval-mine' : ''}`}>
            <div className="approval-main">
              <div>
                <Chip tone={a.kind === 'yaml' ? 'info' : 'accent'}>{a.kind === 'yaml' ? t('Pipeline check') : t('Release approval')}</Chip>
                {' '}<strong>{a.pipeline}</strong>{a.stage && <> → <strong>{a.stage}</strong></>}
              </div>
              <div className="small muted">
                {a.projectName}
                {a.run && <> · {a.run.webUrl ? <a href={a.run.webUrl} target="_blank" rel="noreferrer noopener">{a.run.name}</a> : a.run.name}</>}
                {' '}· {t('waiting {age}', { age: age(a.createdOn) })}
                {a.approvers.length > 0 && <> · {t('approvers: {names}', { names: a.approvers.map((x) => x.displayName).join(', ') })}</>}
                {a.minRequired > 1 && <> · {t('needs {n}', { n: a.minRequired })}</>}
              </div>
              {a.instructions && <p className="approval-instructions small">“{a.instructions}”</p>}
            </div>
            {a.canDecide && canDecide ? (
              <div className="approval-actions">
                <input
                  className="input" placeholder={t('Comment (optional)')} value={comments[a.key] || ''}
                  onChange={(e) => setComments((c) => ({ ...c, [a.key]: e.target.value }))} aria-label={t('Comment for {name}', { name: a.pipeline })}
                />
                <button type="button" className="btn btn-small btn-primary" disabled={busy === a.key} onClick={() => decide(a, 'approved')}>{busy === a.key ? '…' : t('Approve')}</button>
                <Confirm text={a.stage ? t('Reject the {stage} deployment?', { stage: a.stage }) : t('Reject the stage deployment?')} onConfirm={() => decide(a, 'rejected')} className="btn btn-small btn-ghost text-bad">{t('Reject')}</Confirm>
              </div>
            ) : <span className="small muted">{t('Assigned to others. Open it in Azure DevOps to see who.')}</span>}
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
      <span className="stage stage-muted" title={t('{stage}: never deployed', { stage: stage.name })}>
        <span className="stage-name">{stage.name}</span><span className="stage-status">{t('Not deployed')}</span>
      </span>
    );
  }
  const tone = STAGE_TONE[shown.status] || 'muted';
  const title = [
    `${stage.name}: ${stageLabel(shown.status)} · ${shown.releaseName} · ${dateTime(shown.at)}`,
    shown.requestedFor ? (shown.reason
      ? t('By {name} ({reason})', { name: shown.requestedFor.displayName, reason: shown.reason })
      : t('By {name}', { name: shown.requestedFor.displayName })) : '',
    stage.active && stage.latest ? t('Last finished: {release} ({status})', { release: stage.latest.releaseName, status: stageLabel(stage.latest.status) }) : '',
  ].filter(Boolean).join('\n');
  return (
    <a className={`stage stage-${tone}`} href={shown.webUrl} target="_blank" rel="noreferrer noopener" title={title}>
      <span className="stage-name">{stage.name}</span>
      <span className="stage-status">{stageLabel(shown.status)} · {shown.releaseName} · {age(shown.at)}</span>
    </a>
  );
}

export function ReleasesTab({ defs, github = [] }) {
  const { refresh, toast, can } = useApp();
  const canRun = can('releases.run');
  const [q, setQ] = useState('');
  const [deploying, setDeploying] = useState(null);

  if (!defs.length && !github.length) {
    return (
      <Empty title={t('No classic release pipelines in your tracked projects.')}>
        {t("Release pipelines (Pipelines → Releases in Azure DevOps) show up here with each stage's latest deployment.")}
      </Empty>
    );
  }
  const needle = q.toLowerCase();
  const rows = defs.filter((d) => !q || `${d.name} ${d.projectName} ${d.path} ${d.stages.map((s) => s.name).join(' ')}`.toLowerCase().includes(needle));
  const repos = github
    .map((r) => ({ ...r, releases: r.releases.filter((x) => !q || `${r.repoName} ${x.tag} ${x.name} ${x.assets.map((a) => a.name).join(' ')}`.toLowerCase().includes(needle)) }))
    .filter((r) => r.releases.length);
  const folders = new Map();
  for (const d of rows) {
    const key = `${d.projectName}|${d.path}`;
    if (!folders.has(key)) folders.set(key, { key, label: `${d.projectName} · ${folderLabel(d.path)}`, rows: [] });
    folders.get(key).rows.push(d);
  }

  const createRelease = async (d) => {
    try {
      const r = await api('/releases/create', { method: 'POST', body: { projectId: d.projectId, definitionId: d.id } });
      toast(t('Created {name}', { name: r.name }));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  return (
    <>
      <div className="filters">
        <input type="search" className="input" placeholder={github.length ? t('Search releases, stages, repos or files') : t('Search release pipeline or stage')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search release pipelines')} />
      </div>
      {defs.length > 0 && <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('Release pipeline')}</th>
              <th>{t('Health')}</th>
              <th>{t('Stages')} <span className="muted small">{t('(latest deployment)')}</span></th>
              <th>{t('Latest release')}</th>
              <th><span className="sr-only">{t('Actions')}</span></th>
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
                            {d.artifacts.filter((a) => a.sourceName).slice(0, 2).map((a) => <span key={a.alias}>{t('from {source}', { source: a.sourceName })}</span>)}
                          </div>
                        </td>
                        <td><Chip tone={HEALTH[d.health].tone}>{t(HEALTH[d.health].label)}</Chip></td>
                        <td><div className="stages">{d.stages.map((s) => <StageChip key={s.id} stage={s} />)}</div></td>
                        <td className="small">
                          {latest ? <>
                            <a href={latest.webUrl} target="_blank" rel="noreferrer noopener">{latest.name}</a>
                            <div className="muted">{t('{age} ago', { age: age(latest.createdOn) })}{latest.createdBy ? ` · ${latest.createdBy.displayName}` : ''}</div>
                          </> : '—'}
                        </td>
                        <td className="row-actions">
                          {canRun && <Confirm text={t('Create a new release of {name} from the latest artifacts?', { name: d.name })} onConfirm={() => createRelease(d)} className="btn btn-small btn-ghost">{t('Create release')}</Confirm>}
                          {canRun && <button
                            type="button" className="btn btn-small btn-ghost" aria-expanded={deploying === d.key} disabled={!d.releases.length}
                            onClick={() => setDeploying((k) => (k === d.key ? null : d.key))}
                          >
                            {t('Deploy…')}
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
      </div>}
      {repos.length > 0 && <GithubReleases repos={repos} />}
    </>
  );
}

/**
 * GitHub releases of the tracked repos, each with the files built for it. A repo shows its latest
 * release and anything newer (pre-releases, drafts); older ones are a click away.
 */
function GithubReleases({ repos }) {
  const [open, setOpen] = useState({});
  return (
    <section aria-label={t('GitHub releases')}>
      <h2 className="section-title">{t('GitHub releases')}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('Release')}</th>
              <th>{t('Files')}</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((r) => {
              const key = `${r.org || ''}:${r.repoId}`;
              const latest = r.releases.findIndex((x) => x.latest);
              const first = latest < 0 ? 1 : latest + 1;
              const shown = open[key] ? r.releases : r.releases.slice(0, first);
              return (
                <Fragment key={key}>
                  <tr className="pipeline-group-row">
                    <td colSpan={2}>
                      <a href={r.webUrl} target="_blank" rel="noreferrer noopener">{r.repoName}</a>
                      <span className="muted">{r.projectName}</span>
                    </td>
                  </tr>
                  {shown.map((x) => <GithubReleaseRow key={x.id} release={x} />)}
                  {r.releases.length > first && (
                    <tr>
                      <td colSpan={2}>
                        <button type="button" className="btn btn-small btn-ghost" aria-expanded={!!open[key]} onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                          {open[key] ? t('Show fewer') : t(r.releases.length - first === 1 ? '{n} older release' : '{n} older releases', { n: r.releases.length - first })}
                        </button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GithubReleaseRow({ release: x }) {
  return (
    <tr>
      <td className="cell-title">
        <a className="strong" href={x.webUrl} target="_blank" rel="noreferrer noopener">{x.name}</a>
        {x.latest && <> <Chip tone="ok">{t('Latest')}</Chip></>}
        {x.prerelease && <> <Chip tone="warn">{t('Pre-release')}</Chip></>}
        {x.draft && <> <Chip tone="muted">{t('Draft')}</Chip></>}
        <div className="sub">
          {x.name !== x.tag && <span>{x.tag}</span>}
          {x.publishedAt && <span title={dateTime(x.publishedAt)}>{t('{age} ago', { age: age(x.publishedAt) })}</span>}
          {x.author && <span>{x.author.displayName}</span>}
        </div>
      </td>
      <td>
        {x.assets.length ? (
          <ul className="release-files">
            {x.assets.map((a) => (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noreferrer noopener">{a.name}</a>
                <span className="muted small">{[bytes(a.size), t(a.downloads === 1 ? '{n} download' : '{n} downloads', { n: a.downloads })].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        ) : <span className="muted small">{t('No files attached')}</span>}
      </td>
    </tr>
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
      toast(t('Deploying {release} to {stage}', { release: release.name, stage: stage.name }));
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
      <label>{t('Release')}
        <select className="input" value={releaseId} onChange={(e) => { setReleaseId(e.target.value); setStageId(''); }}>
          {def.releases.map((r) => <option key={r.id} value={r.id}>{r.name} · {t('{age} ago', { age: age(r.createdOn) })}</option>)}
        </select>
      </label>
      <label>{t('Stage')}
        <select className="input" value={stage ? String(stage.id) : ''} onChange={(e) => setStageId(e.target.value)}>
          {stages.map((s) => <option key={s.id} value={s.id}>{s.name} ({stageLabel(s.status)})</option>)}
        </select>
      </label>
      <label className="grow">{t('Comment')}
        <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('Optional')} />
      </label>
      <div className="deploy-actions">
        <Confirm
          text={t(verb === 'Redeploy'
            ? 'Redeploy {release} to {stage}? Approvals and gates on that stage still apply.'
            : 'Deploy {release} to {stage}? Approvals and gates on that stage still apply.', { release: release?.name, stage: stage?.name })}
          onConfirm={deploy}
          className="btn btn-small btn-primary"
        >
          {busy ? t('Starting…') : t(verb)}
        </Confirm>
        <button type="button" className="btn btn-small btn-ghost" onClick={onDone}>{t('Cancel')}</button>
      </div>
    </div>
  );
}
