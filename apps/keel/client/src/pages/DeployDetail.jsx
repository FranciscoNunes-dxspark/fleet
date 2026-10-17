import { useApi, useApp } from '../context.js';
import { age, dateTime } from '../format.js';
import { Chip, ErrorBox, ExternalLink, Loading, TypeLabel } from '../ui.jsx';
import { t } from '../i18n.js';

const enc = encodeURIComponent;
export const DEPLOY_STATUS = {
  succeeded: { tone: 'ok', label: 'Succeeded' },
  partiallySucceeded: { tone: 'warn', label: 'Partially succeeded' },
  failed: { tone: 'bad', label: 'Failed' },
};

/**
 * What a production deploy shipped: the work items, pull requests and commits
 * since the environment's previous successful deploy. Opened from Production
 * (a deploy, or a "failures up since ..." warning) and from Insights.
 */
export default function DeployDetail({ target }) {
  const { openDrawer } = useApp();
  const { data, error, reload } = useApi(`/deploys/${enc(target.projectId)}/changes?target=${enc(target.target)}&id=${enc(target.id)}`);
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const { deploy, previous } = data;
  const status = DEPLOY_STATUS[deploy.status] || { tone: 'muted', label: deploy.status };
  const openCommit = (c) => openDrawer({ type: 'commit', projectId: c.projectId, repoId: c.repoId, id: c.id, org: target.org, projectName: c.projectName, repoName: c.repoName });

  return (
    <div className="detail deploy-detail">
      <div className="detail-kicker">{[data.target.name, data.repo?.name].filter(Boolean).join(' · ')}</div>
      <h2 className="detail-title">{deploy.label}</h2>
      <div className="chips">
        <Chip tone={status.tone}>{t(status.label)}</Chip>
        <span className="muted small">{t('{age} ago', { age: age(deploy.at) })}{deploy.by ? ` · ${deploy.by}` : ''}</span>
      </div>

      <dl className="facts">
        <div><dt>{t('Deployed')}</dt><dd>{dateTime(deploy.at)}</dd></div>
        <div><dt>{t('Changes since')}</dt><dd>{previous ? `${previous.label} · ${dateTime(previous.at)}` : '—'}</dd></div>
        <div><dt>{t('Commits')}</dt><dd>{data.commits.length}</dd></div>
        <div><dt>{t('People')}</dt><dd>{data.authors.join(', ') || '—'}</dd></div>
      </dl>

      {data.unknown && <p className="callout">{t("Azure DevOps didn't say which commit this deploy shipped, so its changes can't be listed.")}</p>}
      {data.partial && !data.unknown && <p className="callout">{t('No earlier deploy in the last 90 days to compare with, so only the deployed commit is shown.')}</p>}
      {data.redeploy && <p className="callout">{t('Same code as {label}: nothing new was shipped.', { label: previous.label })}</p>}

      {data.workItems.length > 0 && (
        <section className="detail-section">
          <h3>{t('Work items')} <span className="muted small">{data.workItems.length}</span></h3>
          <ul className="deploy-list">
            {data.workItems.map((w) => (
              <li key={w.id}>
                <button type="button" className="row-link" onClick={() => openDrawer({ type: 'workitem', id: w.id, org: target.org })}>{w.title}</button>
                <div className="sub"><TypeLabel type={w.type} /><span className="mono">#{w.id}</span><span>{w.state}</span>{w.assignedTo && <span>{w.assignedTo}</span>}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.pullRequests.length > 0 && (
        <section className="detail-section">
          <h3>{t('Pull requests')} <span className="muted small">{data.pullRequests.length}</span></h3>
          <ul className="deploy-list">
            {data.pullRequests.map((p) => (
              <li key={p.id}>
                <button type="button" className="row-link" onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id })}>{p.title}</button>
                <div className="sub"><span className="mono">!{p.id}</span>{p.author && <span>{p.author}</span>}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.commits.length > 0 && (
        <section className="detail-section">
          <h3>{t('Commits')} <span className="muted small">{data.commits.length}</span></h3>
          <ul className="deploy-list">
            {data.commits.map((c) => (
              <li key={c.id}>
                <button type="button" className="row-link" onClick={() => openCommit(c)}>{c.subject || t('(no message)')}</button>
                <div className="sub"><code className="mono">{c.id.slice(0, 8)}</code><span>{c.author?.name}</span><span>{dateTime(c.author?.date)}</span></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="detail-actions">
        <ExternalLink href={deploy.webUrl} />
      </section>
    </div>
  );
}
