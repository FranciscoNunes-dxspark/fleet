// "Its path to production" in a work item's or a pull request's panel: the change's steps along
// the Line (trace.js), from planned to live, each in the stage's place, with where it is now.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, fullDateTime } from '../format.js';
import { t } from '../i18n.js';
import { stageName } from './names.js';
import { traceChange, whereNow } from './trace.js';

const prPath = (p) => `/prs/${encodeURIComponent(p.projectId)}/${encodeURIComponent(p.repoId)}/${p.id}`;

function stepText(s) {
  const pr = s.pr ? `!${s.pr.id}` : '';
  switch (s.code) {
    case 'created': return t('Created');
    case 'started': return t('Started');
    case 'not-started': return t('Not started yet');
    case 'no-prs': return t('No pull request yet');
    case 'closed-without-code': return t('Closed without a pull request');
    case 'pr-open': return t('{pr} open for review in {repo}', { pr, repo: s.pr.repoName });
    case 'pr-reviewed': return t('{pr} reviewed in {repo}', { pr, repo: s.pr.repoName });
    case 'pr-abandoned': return t('{pr} abandoned', { pr });
    case 'not-merged': return t('{pr} not merged yet', { pr });
    case 'merged': return t('{pr} merged into {branch}', { pr, branch: s.branch });
    case 'built': return s.result === 'failed' ? t('{pipeline} {label} failed after the merge', { pipeline: s.pipeline, label: s.label }) : t('Built by {pipeline} {label}', { pipeline: s.pipeline, label: s.label });
    case 'not-built': return t('No build since the merge yet');
    case 'built-since': return t('Built by {pipeline} since (its runs from then are no longer listed)', { pipeline: s.pipeline });
    case 'no-target': return t('No production target deploys {repo}', { repo: s.repo });
    case 'waiting': return t('Waiting to ship to {target}', { target: s.target });
    case 'awaiting-approval': return t('{label} to {target} is waiting for approval', { label: s.label, target: s.target });
    case 'deploying': return t('Deploying to {target} ({label})', { label: s.label, target: s.target });
    case 'deployed': return t('In {target} with {label} or earlier', { label: s.label, target: s.target });
    case 'on-production-branch': return t('In {target}: on {branch}', { target: s.target, branch: s.branch });
    case 'monitor-up': return t('{name} is up', { name: s.name });
    case 'monitor-degraded': return t('{name} is degraded', { name: s.name });
    case 'monitor-down': return t('{name} is down', { name: s.name });
    case 'monitor-deploying': case 'monitor-settling': return t('{name} is being deployed', { name: s.name });
    default: return t('{name}: not checked yet', { name: s.name || '' });
  }
}

/** `workItem` (a work item's detail) or `pr` (a pull request's detail): the change to trace. */
export default function Trace({ workItem = null, pr = null }) {
  const { openDrawer, refreshKey } = useApp();
  const pipelines = useApi('/pipelines');
  const pending = useApi('/deploys/pending');
  const production = useApi('/production');
  const [prs, setPrs] = useState(pr ? [pr] : null);
  const refs = workItem?.pullRequests || [];
  const refsKey = refs.map((p) => `${p.repoId}/${p.id}`).join(',');
  useEffect(() => {
    if (pr) { setPrs([pr]); return undefined; }
    let live = true;
    Promise.all(refs.map((p) => api(prPath(p)).catch(() => null))).then((list) => live && setPrs(list.filter(Boolean)));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr, refsKey, refreshKey]);

  if (!prs || !pipelines.data || !pending.data) return null;
  const steps = traceChange({ workItem, prs, pipelines: pipelines.data, targets: pending.data.targets || [], monitors: production.data?.monitors || [] });
  const now = whereNow(steps);
  return (
    <section className="detail-section trace">
      <h3>{t('Its path to production')} <span className="muted small">{t('now: {stage}', { stage: stageName(now) })}</span></h3>
      <ol className="trace-steps">
        {steps.map((s, i) => (
          <li key={i} className={`trace-step trace-${s.state}`}>
            <span className="trace-dot" aria-hidden="true" />
            <span className="trace-stage">{stageName(s.stage)}</span>
            <span className="trace-text">
              {s.pr && s.code !== 'pr-open' && s.code !== 'pr-reviewed' ? stepText(s) : s.pr
                ? <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'pr', projectId: s.pr.projectId, repoId: s.pr.repoId, id: s.pr.id })}>{stepText(s)}</button>
                : s.open ? <button type="button" className="link-btn" onClick={() => openDrawer(s.open)}>{stepText(s)}</button> : stepText(s)}
              {s.pr?.title && (s.code === 'pr-open' || s.code === 'pr-reviewed') && <span className="muted small"> · {s.pr.title}</span>}
            </span>
            {s.at && <span className="trace-at muted small" title={fullDateTime(s.at)}>{age(s.at)}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
