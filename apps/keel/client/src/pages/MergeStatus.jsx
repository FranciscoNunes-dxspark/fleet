import { useEffect } from 'react';
import { prPath } from '../api.js';
import { useApi, useApp } from '../context.js';
import { t, tx } from '../i18n.js';
import { ErrorBox, Loading } from '../ui.jsx';

// Azure DevOps conflict kinds, named "<source><target>" (English; t() at render).
const CONFLICT_LABEL = {
  editEdit: 'Edited in both branches',
  addAdd: 'Added in both branches',
  deleteEdit: 'Deleted here, edited in the target',
  editDelete: 'Edited here, deleted in the target',
  addRename: 'Added here, renamed in the target',
  deleteRename: 'Deleted here, renamed in the target',
  renameAdd: 'Renamed here, added in the target',
  renameDelete: 'Renamed here, deleted in the target',
  renameRename: 'Renamed differently in each branch',
  rename1to2: 'Renamed to two different names',
  rename2to1: 'Two files renamed to the same name',
  fileDirectory: 'A file here, a folder in the target',
  directoryFile: 'A folder here, a file in the target',
  directoryChild: 'Folder conflict',
};

/**
 * The pull request's merge when it isn't clean: the conflicting files, how to
 * fix them locally, and Restart merge. Shown for active PRs only.
 */
export default function MergeStatus({ pr, target, writable, busy, onRestart, onRefresh }) {
  const { toast } = useApp();
  const conflicted = pr.mergeStatus === 'conflicts';
  const { data, error, reload } = useApi(conflicted ? `${prPath(target)}/conflicts` : null);

  // A queued merge finishes in seconds: look again until it's done.
  useEffect(() => {
    if (pr.mergeStatus !== 'queued') return undefined;
    const timer = setTimeout(onRefresh, 5000);
    return () => clearTimeout(timer);
  }, [pr.mergeStatus, onRefresh]);

  const commands = [
    'git fetch origin',
    `git checkout ${pr.sourceBranch}`,
    `git merge origin/${pr.targetBranch}`,
    '# fix the conflicted files, then:',
    'git add <files>',
    'git commit',
    'git push',
  ].join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands);
      toast(t('Commands copied'));
    } catch {
      toast(t('Couldn’t copy. Your browser blocked the clipboard.'), 'bad');
    }
  };

  const restart = writable && (
    <button type="button" className="btn btn-small" disabled={!!busy || pr.mergeStatus === 'queued'} onClick={onRestart}>
      {busy === 'restartMerge' ? t('Restarting…') : t('Restart merge')}
    </button>
  );

  return (
    <section className={`detail-section merge-status merge-${pr.mergeStatus}`} aria-live="polite">
      <h3>
        {conflicted ? t('Merge conflicts') : pr.mergeStatus === 'queued' ? t('Checking the merge…') : t('Merge')}
        {conflicted && data && <span className="muted small">{t(data.conflicts.length === 1 ? '{n} file' : '{n} files', { n: data.conflicts.length })}</span>}
      </h3>

      {pr.mergeStatus === 'queued' && <p className="small muted"><span className="spinner" aria-hidden="true" /> {t('Azure DevOps is merging {source} into {target} to look for conflicts.', { source: pr.sourceBranch, target: pr.targetBranch })}</p>}
      {pr.mergeStatus === 'failure' && <p className="small text-bad">{pr.mergeFailureMessage ? t('The merge failed: {reason}', { reason: tx(pr.mergeFailureMessage) }) : t('The merge failed.')}</p>}
      {pr.mergeStatus === 'rejectedByPolicy' && <p className="small text-warn">{t('A branch policy rejected the merge.')}</p>}
      {pr.mergeStatus === 'notSet' && <p className="small muted">{t('Azure DevOps hasn’t run the merge yet.')}</p>}

      {conflicted && (
        <>
          {error && <ErrorBox error={error} onRetry={reload} />}
          {!data && !error && <Loading />}
          {data && (data.conflicts.length ? (
            <ul className="conflict-list">
              {data.conflicts.map((c) => (
                <li key={c.id} className={c.status === 'resolved' ? 'resolved' : ''}>
                  <span className="mono small conflict-path">{c.path.replace(/^\//, '')}</span>
                  <span className="small muted">{t(CONFLICT_LABEL[c.type] || 'Conflict')}{c.status === 'resolved' ? ` · ${t('resolved')}` : c.status === 'partiallyResolved' ? ` · ${t('partly resolved')}` : ''}</span>
                </li>
              ))}
            </ul>
          ) : <p className="small muted">{t('Azure DevOps didn’t list the files. Open the pull request there to see them.')}</p>)}

          <details className="conflict-fix">
            <summary className="small">{t('Fix them on your computer')}</summary>
            <p className="small muted">{t('Merge {target} into your branch, fix the files, and push. The push runs the merge again.', { target: pr.targetBranch })}</p>
            <pre className="code-block small">{commands}</pre>
            <button type="button" className="btn btn-small btn-ghost" onClick={copy}>{t('Copy commands')}</button>
          </details>
        </>
      )}

      <div className="merge-actions">
        {restart}
        <span className="small muted">{t('Restart merge checks again without a push, for example after the target branch changed.')}</span>
      </div>
    </section>
  );
}
