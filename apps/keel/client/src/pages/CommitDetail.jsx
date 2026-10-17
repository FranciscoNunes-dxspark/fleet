import { useApi, useApp } from '../context.js';
import { dateTime } from '../format.js';
import { Chip, ErrorBox, ExternalLink, Loading, Person } from '../ui.jsx';
import { t } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';
import { ChangedFiles } from './PrDetail.jsx';

const enc = encodeURIComponent;
// A file's change within this commit, in Azure DevOps.
const commitFileHref = (webUrl, path) => `${webUrl}?path=${enc(path)}&_a=compare`;

/** One commit: the whole message, who and when, what it links to and the files it changed. */
export default function CommitDetail({ target }) {
  const { openDrawer } = useApp();
  const projectLabel = useProjectLabel();
  const { data: c, error, reload } = useApi(`/commits/${enc(target.projectId)}/${enc(target.repoId)}/${enc(target.id)}`);
  if (!c) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const [subject, ...rest] = c.message.split('\n');
  const body = rest.join('\n').trim();
  const committedLater = c.committedAt && Math.abs(Date.parse(c.committedAt) - Date.parse(c.author.date)) > 60_000;

  return (
    <div className="detail commit-detail">
      <div className="detail-kicker">{[target.projectName && projectLabel(target.projectName, target.org), target.repoName].filter(Boolean).join(' / ')}</div>
      <h2 className="detail-title">{subject || t('(no message)')}</h2>
      <div className="chips">
        <code className="branch" title={c.id}>{c.id.slice(0, 8)}</code>
        {c.parents?.length > 1 && <Chip>{t('Merge commit')}</Chip>}
        {c.prId && <button type="button" className="chip chip-info chip-btn" onClick={() => openDrawer({ type: 'pr', projectId: target.projectId, repoId: target.repoId, id: c.prId })}>PR {c.prId}</button>}
        {c.workItemIds.map((id) => (
          <button key={id} type="button" className="chip chip-muted chip-btn" onClick={() => openDrawer({ type: 'workitem', id, org: target.org })}>#{id}</button>
        ))}
      </div>

      <dl className="facts">
        <div><dt>{t('Author')}</dt><dd><Person person={{ displayName: c.author.name || c.author.email, uniqueName: c.author.email }} /></dd></div>
        <div><dt>{t('Authored')}</dt><dd>{dateTime(c.author.date)}</dd></div>
        {committedLater && <div><dt>{t('Committed')}</dt><dd>{dateTime(c.committedAt)}</dd></div>}
        {c.author.email && <div><dt>{t('Email')}</dt><dd className="mono small">{c.author.email}</dd></div>}
      </dl>

      {body && (
        <section className="detail-section">
          <h3>{t('Message')}</h3>
          <pre className="commit-message">{body}</pre>
        </section>
      )}

      <ChangedFiles files={{ total: c.files.length, items: c.files }} webUrl={c.webUrl} fileHref={commitFileHref} empty={t('No file changes in this commit.')} />

      <section className="detail-actions">
        <ExternalLink href={c.webUrl} />
      </section>
    </div>
  );
}
