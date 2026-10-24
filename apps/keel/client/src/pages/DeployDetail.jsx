import { useApi, useApp } from '../context.js';
import { downloadText } from './ReleaseNotes.jsx';
import { age, dateTime } from '../format.js';
import { Chip, ErrorBox, ExternalLink, Loading, TypeLabel } from '../ui.jsx';
import { t } from '../i18n.js';

const enc = encodeURIComponent;
// Deploy outcomes from release stages and pipeline runs; labels are translated where shown.
export const DEPLOY_STATUS = {
  succeeded: { tone: 'ok', label: 'Succeeded' },
  partiallySucceeded: { tone: 'warn', label: 'Partially succeeded' },
  failed: { tone: 'bad', label: 'Failed' },
  rejected: { tone: 'bad', label: 'Rejected' },
  inProgress: { tone: 'info', label: 'In progress' },
  queued: { tone: 'muted', label: 'Queued' },
  canceled: { tone: 'muted', label: 'Canceled' },
};
export const deployStatus = (status) => DEPLOY_STATUS[status] || { tone: 'muted', label: status || '—' };

function CommitList({ commits, onOpen }) {
  return (
    <ul className="deploy-list">
      {commits.map((c) => (
        <li key={c.id}>
          <button type="button" className="row-link" onClick={() => onOpen(c)}>{c.subject || t('(no message)')}</button>
          <div className="sub"><code className="mono">{c.id.slice(0, 8)}</code><span>{c.author?.name}</span><span>{dateTime(c.author?.date)}</span></div>
        </li>
      ))}
    </ul>
  );
}

/**
 * A set of changes (see describeChanges in server/service.js): the work items,
 * each pull request with its commits, and the commits pushed without one.
 * Used for what a deploy shipped and for what's waiting to ship.
 */
export function ChangeSections({ changes: data, org }) {
  const { openDrawer } = useApp();
  const openCommit = (c) => openDrawer({ type: 'commit', projectId: c.projectId, repoId: c.repoId, id: c.id, org, projectName: c.projectName, repoName: c.repoName });
  return (
    <>
      {data.workItems.length > 0 && (
        <section className="detail-section">
          <h3>{t('Work items')} <span className="muted small">{data.workItems.length}</span></h3>
          <ul className="deploy-list">
            {data.workItems.map((w) => (
              <li key={w.id}>
                <button type="button" className="row-link" onClick={() => openDrawer({ type: 'workitem', id: w.id, org })}>{w.title}</button>
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
                <button type="button" className="row-link" onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id, org })}>{p.title}</button>
                <div className="sub"><span className="mono">!{p.id}</span>{p.author && <span>{p.author}</span>}{p.mergedAt && <span>{t('merged {date}', { date: dateTime(p.mergedAt) })}</span>}</div>
                <details className="deploy-pr-commits">
                  <summary className="small muted">{t(p.commits.length === 1 ? '{n} commit' : '{n} commits', { n: p.commits.length })}</summary>
                  <CommitList commits={p.commits} onOpen={openCommit} />
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.directCommits.length > 0 && (
        <section className="detail-section">
          <h3>{data.pullRequests.length ? t('Commits without a pull request') : t('Commits')} <span className="muted small">{data.directCommits.length}</span></h3>
          <CommitList commits={data.directCommits} onOpen={openCommit} />
        </section>
      )}
    </>
  );
}

const isBug = (w) => /bug|defect|issue/i.test(w.type);
const isTask = (w) => /task/i.test(w.type);

/** A deploy's release notes in Markdown, like the Release notes page but for exactly what this deploy shipped. */
export function deployNotes(data) {
  const { deploy, target } = data;
  const items = data.workItems.filter((w) => !isTask(w));
  const lines = [`# ${target.name} · ${deploy.label}`, '', `_${dateTime(deploy.at)} · ${t(data.pullRequests.length === 1 ? '{n} pull request' : '{n} pull requests', { n: data.pullRequests.length })} · ${t(data.commits.length === 1 ? '{n} commit' : '{n} commits', { n: data.commits.length })}_`, ''];
  const section = (title, list) => list.length && lines.push(`## ${title}`, '', ...list, '');
  section(t('Features and improvements'), items.filter((w) => !isBug(w)).map((w) => `- ${w.title} (AB#${w.id})`));
  section(t('Bug fixes'), items.filter(isBug).map((w) => `- ${w.title} (AB#${w.id})`));
  section(t('Pull requests'), data.pullRequests.map((p) => `- ${p.webUrl ? `[!${p.id}](${p.webUrl})` : `!${p.id}`} ${p.title}${p.author ? ` _(${p.author})_` : ''}`));
  section(t('Commits without a pull request'), data.directCommits.map((c) => `- ${c.webUrl ? `[${c.id.slice(0, 8)}](${c.webUrl})` : c.id.slice(0, 8)} ${c.subject}${c.author?.name ? ` _(${c.author.name})_` : ''}`));
  if (!data.commits.length) lines.push(t('Nothing new was shipped.'), '');
  return `${lines.join('\n').trim()}\n`;
}

/**
 * What a production deploy shipped: the work items, pull requests and commits
 * since the environment's previous successful deploy. Opened from Production
 * (a deploy, or a "failures up since ..." warning) and from Insights.
 */
export default function DeployDetail({ target }) {
  const { toast } = useApp();
  const { data, error, reload } = useApi(`/deploys/${enc(target.projectId)}/changes?target=${enc(target.target)}&id=${enc(target.id)}`);
  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const { deploy, previous } = data;
  const status = DEPLOY_STATUS[deploy.status] || { tone: 'muted', label: deploy.status };

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

      <ChangeSections changes={data} org={target.org} />

      <section className="detail-actions">
        {!data.unknown && (
          <>
            <button type="button" className="btn btn-small" onClick={async () => {
              try {
                await navigator.clipboard.writeText(deployNotes(data));
                toast(t('Release notes copied as Markdown'));
              } catch {
                toast(t('Copy failed. Select the text and copy it yourself.'), 'bad');
              }
            }}
            >
              {t('Copy release notes')}
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => downloadText(`${deploy.label}-release-notes.md`.replace(/[^\w.-]+/g, '-'), deployNotes(data))}>{t('Download .md')}</button>
          </>
        )}
        <ExternalLink href={deploy.webUrl} />
      </section>
    </div>
  );
}
