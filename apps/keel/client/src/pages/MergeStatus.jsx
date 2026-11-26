import { useEffect, useState } from 'react';
import { api, prPath } from '../api.js';
import { useApi, useApp } from '../context.js';
import { t, tx } from '../i18n.js';
import { Checkbox, ErrorBox, Loading } from '../ui.jsx';
import { blockLines, initialPicks, pickedText, swapOrder, takeAll, toggleLine, undecided } from '../conflictpick.js';
import { Button } from '@radix-ui/themes';

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

// What Keel can do about each kind (as server/domain/conflicts.js conflictChoices): keep one
// branch's side of an edit or a delete, and write the merged text of a file both branches edited.
const KEEPS = new Set(['editEdit', 'addAdd', 'deleteEdit', 'editDelete']);
const EDITS = new Set(['editEdit', 'addAdd']);
const MARKER = /^<{7}( |$)/;
const markersIn = (text) => text.split('\n').filter((l) => MARKER.test(l)).length;

// Lines both branches agree on, between conflicts: a few either side of each is enough to place it.
const CONTEXT = 3;

function SameLines({ lines, first, last }) {
  const head = first ? [] : lines.slice(0, CONTEXT);
  const tail = last ? [] : lines.slice(-CONTEXT);
  const shown = head.length + tail.length >= lines.length ? [lines, []] : [head, tail];
  const hidden = lines.length - shown[0].length - shown[1].length;
  return (
    <div className="pick-same">
      {shown[0].map((l, i) => <div key={`h${i}`} className="pick-line">{l || ' '}</div>)}
      {hidden > 0 && <div className="pick-hidden small muted">{t(hidden === 1 ? '{n} line both branches agree on' : '{n} lines both branches agree on', { n: hidden })}</div>}
      {shown[1].map((l, i) => <div key={`t${i}`} className="pick-line">{l || ' '}</div>)}
    </div>
  );
}

/** One side of a conflict: its lines, each with a box to keep it. */
function PickSide({ branch, lines, picked, onToggle }) {
  return (
    <div className="pick-side">
      <div className="pick-branch small mono">{branch}</div>
      {lines.length ? lines.map((l, j) => (
        <label key={j} className={`pick-row${picked[j] ? ' on' : ''}`}>
          <Checkbox checked={picked[j]} onChange={() => onToggle(j)} aria-label={t('Keep line {n} of {branch}', { n: j + 1, branch })} />
          <span className="pick-line">{l || ' '}</span>
        </label>
      )) : <div className="small muted pick-empty">{t('Nothing here: this branch removed these lines.')}</div>}
    </div>
  );
}

/**
 * The merged file of a conflict both branches edited. Keel merges what only one branch changed;
 * each place both changed shows both sides' lines, to keep any of them from either, in either
 * order. Edit as text turns it into the whole file, with what's still unsettled between markers.
 */
function ConflictEditor({ pr, target, conflict, busy, onResolve, onClose }) {
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const [picks, setPicks] = useState([]);
  const [text, setText] = useState(null);
  // Read once, not through useApi: a refresh mustn't throw away what's being picked or typed.
  useEffect(() => {
    let live = true;
    api(`${prPath(target)}/conflicts/${conflict.id}`)
      .then((d) => { if (live) { setLoaded(d); setPicks(initialPicks(d.merged?.chunks ?? [])); } })
      .catch((e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [target, conflict.id]);
  if (error) return <ErrorBox error={error} />;
  if (!loaded) return <Loading />;
  const chunks = loaded.merged?.chunks ?? [];
  const names = { source: pr.sourceBranch, target: pr.targetBranch };
  const picked = pickedText(chunks, picks, names);
  const open = undecided(picks);
  const left = text === null ? open : markersIn(text);
  const total = chunks.filter((c) => !c.same).length;
  let n = 0;
  return (
    <div className="conflict-editor">
      {text === null ? (
        <>
          <p className="small muted">{total
            ? t('Keel merged what only one branch changed. Where both changed the same lines, tick the lines to keep from either side, or take a whole side.')
            : t('Keel merged the two branches with nothing left to settle. Check it and save.')}</p>
          <div className="pick-file mono">
            {chunks.map((c, i) => {
              if (c.same) return <SameLines key={i} lines={c.same} first={i === 0} last={i === chunks.length - 1} />;
              n++;
              const p = picks[i];
              const result = p.decided ? blockLines(c, p) : null;
              return (
                <div key={i} className={`pick-block${p.decided ? ' decided' : ''}`}>
                  <div className="pick-head">
                    <span className="small"><strong>{t('Conflict {n} of {total}', { n, total })}</strong>{!p.decided && <span className="text-warn"> · {t('to settle')}</span>}</span>
                    <span className="pick-take">
                      <Button size="1" variant="soft" color="gray" type="button" onClick={() => setPicks(takeAll(picks, i, 'source'))}>{t('All of {branch}', { branch: pr.sourceBranch })}</Button>
                      <Button size="1" variant="soft" color="gray" type="button" onClick={() => setPicks(takeAll(picks, i, 'target'))}>{t('All of {branch}', { branch: pr.targetBranch })}</Button>
                      <Button size="1" variant="soft" color="gray" type="button" onClick={() => setPicks(takeAll(picks, i, 'both'))}>{t('Both')}</Button>
                      <Button size="1" variant="soft" color="gray" type="button" onClick={() => setPicks(takeAll(picks, i, 'none'))}>{t('Neither')}</Button>
                    </span>
                  </div>
                  <div className="pick-sides">
                    <PickSide branch={pr.sourceBranch} lines={c.source} picked={p.source} onToggle={(j) => setPicks(toggleLine(picks, i, 'source', j))} />
                    <PickSide branch={pr.targetBranch} lines={c.target} picked={p.target} onToggle={(j) => setPicks(toggleLine(picks, i, 'target', j))} />
                  </div>
                  {result && (
                    <div className="pick-result">
                      <div className="pick-head">
                        <span className="small muted">{t('Becomes')}</span>
                        <Button size="1" variant="ghost" color="gray" type="button" onClick={() => setPicks(swapOrder(picks, i))} title={t('Which side’s lines come first when you keep lines from both')}>
                          {t('{branch} first', { branch: p.first === 'source' ? pr.sourceBranch : pr.targetBranch })} ⇅
                        </Button>
                      </div>
                      {result.length ? result.map((l, j) => <div key={j} className="pick-line">{l || ' '}</div>) : <div className="small muted">{t('Nothing: these lines go.')}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <p className="small muted">{t('The whole file. Each place still to settle is between <<<<<<< ({source}) and >>>>>>> ({target}): keep what should stay and delete the markers.', names)}</p>
          <textarea className="input" rows={Math.min(24, Math.max(8, text.split('\n').length + 1))} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('Merged file')} />
        </>
      )}
      <div className="merge-actions">
        <Button size="1" type="button" disabled={!!busy || left > 0} onClick={() => onResolve({ content: text ?? picked })}>
          {busy === `content:${conflict.id}` ? t('Saving…') : t('Save merged file')}
        </Button>
        {text === null
          ? <Button size="1" variant="ghost" color="gray" type="button" onClick={() => setText(picked)}>{t('Edit as text')}</Button>
          : (
            <>
              <Button size="1" variant="ghost" color="gray" type="button" onClick={() => setText(null)} title={t('Goes back to your picks; changes typed here are lost')}>{t('Back to picking lines')}</Button>
              <Button size="1" variant="ghost" color="gray" type="button" onClick={() => setText(loaded.source)}>{t('Start from {branch}', { branch: pr.sourceBranch })}</Button>
              <Button size="1" variant="ghost" color="gray" type="button" onClick={() => setText(loaded.target)}>{t('Start from {branch}', { branch: pr.targetBranch })}</Button>
            </>
          )}
        <Button size="1" variant="ghost" color="gray" type="button" onClick={onClose}>{t('Cancel')}</Button>
        {left > 0 && <span className="small text-warn">{text === null
          ? t(left === 1 ? '{n} conflict still to settle' : '{n} conflicts still to settle', { n: left })
          : t(left === 1 ? '{n} place still marked' : '{n} places still marked', { n: left })}</span>}
      </div>
    </div>
  );
}

/**
 * The pull request's merge when it isn't clean: the conflicting files, how to
 * fix them locally or one by one here, and Restart merge. Shown for active PRs only.
 */
export default function MergeStatus({ pr, target, writable, busy, onRestart, onRefresh, github = false }) {
  const { toast, refresh } = useApp();
  const conflicted = pr.mergeStatus === 'conflicts';
  // GitHub doesn't list the conflicting files, and checks the merge again by itself after a push.
  const { data, error, reload } = useApi(conflicted && !github ? `${prPath(target)}/conflicts` : null);
  const [editing, setEditing] = useState(null);
  const [resolving, setResolving] = useState(null);

  const resolve = async (c, resolution) => {
    setResolving(resolution.keep ? `${resolution.keep}:${c.id}` : `content:${c.id}`);
    try {
      const done = await api(`${prPath(target)}/conflicts/${c.id}/resolve`, { method: 'POST', body: resolution });
      setEditing(null);
      toast(done.merging ? t('Every conflict is resolved: Azure DevOps is merging again.') : t('Resolved {path}. {n} left.', { path: c.path.replace(/^\//, ''), n: done.left }));
      reload();
      if (done.merging) refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setResolving(null);
    }
  };

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

  const restart = writable && !github && (
    <Button size="1" variant="outline" color="gray" type="button" disabled={!!busy || pr.mergeStatus === 'queued'} onClick={onRestart}>
      {busy === 'restartMerge' ? t('Restarting…') : t('Restart merge')}
    </Button>
  );

  return (
    <section className={`detail-section merge-status merge-${pr.mergeStatus}`} aria-live="polite">
      <h3>
        {conflicted ? t('Merge conflicts') : pr.mergeStatus === 'queued' ? t('Checking the merge…') : t('Merge')}
        {conflicted && data && <span className="muted small">{t(data.conflicts.length === 1 ? '{n} file' : '{n} files', { n: data.conflicts.length })}</span>}
      </h3>

      {pr.mergeStatus === 'queued' && <p className="small muted"><span className="spinner" aria-hidden="true" /> {github
        ? t('GitHub is checking whether {source} merges cleanly into {target}.', { source: pr.sourceBranch, target: pr.targetBranch })
        : t('Azure DevOps is merging {source} into {target} to look for conflicts.', { source: pr.sourceBranch, target: pr.targetBranch })}</p>}
      {pr.mergeStatus === 'failure' && <p className="small text-bad">{pr.mergeFailureMessage ? t('The merge failed: {reason}', { reason: tx(pr.mergeFailureMessage) }) : t('The merge failed.')}</p>}
      {pr.mergeStatus === 'rejectedByPolicy' && <p className="small text-warn">{t('A branch policy rejected the merge.')}</p>}
      {pr.mergeStatus === 'notSet' && <p className="small muted">{t('Azure DevOps hasn’t run the merge yet.')}</p>}

      {conflicted && (
        <>
          {github && <p className="small muted">{t('GitHub doesn’t list the conflicting files here. Open the pull request there to see them.')}</p>}
          {error && <ErrorBox error={error} onRetry={reload} />}
          {!github && !data && !error && <Loading />}
          {data && (data.conflicts.length ? (
            <ul className="conflict-list">
              {data.conflicts.map((c) => (
                <li key={c.id} className={c.status === 'resolved' ? 'resolved' : ''}>
                  <span className="mono small conflict-path">{c.path.replace(/^\//, '')}</span>
                  <span className="small muted">{t(CONFLICT_LABEL[c.type] || 'Conflict')}{c.status === 'resolved' ? ` · ${t('resolved')}` : c.status === 'partiallyResolved' ? ` · ${t('partly resolved')}` : ''}</span>
                  {writable && c.status !== 'resolved' && editing !== c.id && (KEEPS.has(c.type) ? (
                    <span className="conflict-actions">
                      <Button size="1" variant="outline" color="gray" type="button" disabled={!!resolving} title={c.type === 'deleteEdit' ? t('Delete the file, as {branch} did', { branch: pr.sourceBranch }) : t('Take the file as it is on {branch}', { branch: pr.sourceBranch })} onClick={() => resolve(c, { keep: 'source' })}>
                        {resolving === `source:${c.id}` ? t('Saving…') : t('Keep {branch}', { branch: pr.sourceBranch })}
                      </Button>
                      <Button size="1" variant="outline" color="gray" type="button" disabled={!!resolving} title={c.type === 'editDelete' ? t('Delete the file, as {branch} did', { branch: pr.targetBranch }) : t('Take the file as it is on {branch}', { branch: pr.targetBranch })} onClick={() => resolve(c, { keep: 'target' })}>
                        {resolving === `target:${c.id}` ? t('Saving…') : t('Keep {branch}', { branch: pr.targetBranch })}
                      </Button>
                      {EDITS.has(c.type) && <Button size="1" variant="ghost" type="button" disabled={!!resolving} onClick={() => setEditing(c.id)}>{t('Edit merged file…')}</Button>}
                    </span>
                  ) : <span className="small muted">{t('Keel can’t resolve a rename or folder conflict. Fix it on your computer or in Azure DevOps.')}</span>)}
                  {editing === c.id && <ConflictEditor pr={pr} target={target} conflict={c} busy={resolving} onResolve={(r) => resolve(c, r)} onClose={() => setEditing(null)} />}
                </li>
              ))}
            </ul>
          ) : <p className="small muted">{t('Azure DevOps didn’t list the files. Open the pull request there to see them.')}</p>)}

          <details className="conflict-fix">
            <summary className="small">{t('Fix them on your computer')}</summary>
            <p className="small muted">{t('Merge {target} into your branch, fix the files, and push. The push runs the merge again.', { target: pr.targetBranch })}</p>
            <pre className="code-block small">{commands}</pre>
            <Button size="1" variant="ghost" color="gray" type="button" onClick={copy}>{t('Copy commands')}</Button>
          </details>
        </>
      )}

      {restart && (
        <div className="merge-actions">
          {restart}
          <span className="small muted">{t('Restart merge checks again without a push, for example after the target branch changed.')}</span>
        </div>
      )}
    </section>
  );
}
