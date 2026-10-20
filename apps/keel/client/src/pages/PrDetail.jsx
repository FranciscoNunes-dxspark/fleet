import { useEffect, useRef, useState } from 'react';
import { api, prPath } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime, dateTimeZone, defaultAt, localZone, REVIEW_STATE, VOTES } from '../format.js';
import { Avatar, Chip, Confirm, ErrorBox, ExternalLink, Loading } from '../ui.jsx';
import { Markdown } from '../markdown.jsx';
import { t, tj, tx } from '../i18n.js';
import { useOrgKind, useProjectLabel } from '../orgs.js';
import MergeStatus from './MergeStatus.jsx';
import { SuggestedReviewers } from './NewPr.jsx';

// Labels are getters so they follow the current language.
const FILE_KIND = {
  added: { letter: 'A', tone: 'ok', get label() { return t('Added'); }, count: '{n} added' },
  edited: { letter: 'M', tone: 'info', get label() { return t('Modified'); }, count: '{n} modified' },
  deleted: { letter: 'D', tone: 'bad', get label() { return t('Deleted'); }, count: '{n} deleted' },
  renamed: { letter: 'R', tone: 'warn', get label() { return t('Renamed'); }, count: '{n} renamed' },
};
/**
 * Builds a folder tree from file paths, collapsing chains of single-child
 * folders ("src/api/Controllers") the way editors show compact folders.
 */
function fileTree(items) {
  const root = { name: '', folders: new Map(), files: [] };
  for (const f of items) {
    const parts = f.path.replace(/^\//, '').split('/');
    const name = parts.pop();
    let node = root;
    for (const p of parts) {
      if (!node.folders.has(p)) node.folders.set(p, { name: p, folders: new Map(), files: [] });
      node = node.folders.get(p);
    }
    node.files.push({ ...f, name });
  }
  const compact = (node) => {
    let folders = [...node.folders.values()].map(compact);
    folders = folders.map((c) => {
      let cur = c;
      while (!cur.files.length && cur.folders.length === 1) cur = { ...cur.folders[0], name: `${cur.name}/${cur.folders[0].name}` };
      return cur;
    });
    const count = node.files.length + folders.reduce((s, c) => s + c.count, 0);
    return { name: node.name, files: node.files.sort((a, b) => a.name.localeCompare(b.name)), folders: folders.sort((a, b) => a.name.localeCompare(b.name)), count };
  };
  return compact(root);
}

// Where a file's diff opens in Azure DevOps: a PR's Files tab by default (commits pass their own).
const prFileHref = (webUrl, path) => `${webUrl}?_a=files&path=${encodeURIComponent(path)}`;
// GitHub: the pull request's Files changed tab.
export const githubPrFileHref = (webUrl) => `${webUrl}/files`;

function FileRow({ f, webUrl, fileHref = prFileHref, github = false }) {
  const kind = FILE_KIND[f.kind] || FILE_KIND.edited;
  return (
    <li className="file-row">
      <span className={`file-kind chip chip-${kind.tone}`} title={kind.label} aria-label={kind.label}>{kind.letter}</span>
      <a className="file-name" href={fileHref(webUrl, f.path)} target="_blank" rel="noreferrer noopener" title={github ? t('Open the diff for {path} on GitHub', { path: f.path }) : t('Open the diff for {path} in Azure DevOps', { path: f.path })}>{f.name}</a>
      {f.originalPath && <span className="muted small file-from" title={f.originalPath}>{t('from {name}', { name: f.originalPath.split('/').pop() })}</span>}
    </li>
  );
}

function Folder({ node, webUrl, depth, fileHref, github }) {
  return (
    <li>
      <details open={depth < 3 || node.count <= 8}>
        <summary className="folder-row"><span className="folder-name">{node.name}/</span><span className="muted small">{node.count}</span></summary>
        <FolderBody node={node} webUrl={webUrl} depth={depth + 1} fileHref={fileHref} github={github} />
      </details>
    </li>
  );
}

function FolderBody({ node, webUrl, depth, fileHref, github }) {
  return (
    <ul className="file-tree">
      {node.folders.map((c) => <Folder key={c.name} node={c} webUrl={webUrl} depth={depth} fileHref={fileHref} github={github} />)}
      {node.files.map((f) => <FileRow key={f.path} f={f} webUrl={webUrl} fileHref={fileHref} github={github} />)}
    </ul>
  );
}

/** Changed files as a folder tree; also used by the commit panel (CommitDetail.jsx). */
export function ChangedFiles({ files, webUrl, fileHref, empty = t('No file changes in the latest update.'), github = false }) {
  const counts = Object.entries(FILE_KIND)
    .map(([k, v]) => [v.count, files.items.filter((f) => f.kind === k).length])
    .filter(([, n]) => n)
    .map(([key, n]) => t(key, { n }));
  const tree = fileTree(files.items);
  return (
    <section className="detail-section">
      <h3>{t('Files changed')} <span className="muted small">{files.total}{files.truncated ? '+' : ''}{counts.length ? ` · ${counts.join(', ')}` : ''}</span></h3>
      {files.error && <p className="text-bad small">{t("Couldn't load the file list: {error}", { error: tx(files.error) })}</p>}
      {!files.error && !files.items.length && <p className="muted small">{empty}</p>}
      <FolderBody node={tree} webUrl={webUrl} depth={0} fileHref={fileHref} github={github} />
      {files.truncated && <p className="muted small">{github ? t('GitHub returned the first 3,000 files only.') : t('Azure DevOps returned the first 2,000 files only.')}</p>}
    </section>
  );
}

const VOTE_BUTTONS = [
  { vote: 10, get label() { return t('Approve'); }, tone: 'ok' },
  { vote: 5, get label() { return t('Approve with suggestions'); }, tone: 'ok' },
  { vote: -5, get label() { return t('Wait for author'); }, tone: 'warn' },
  { vote: -10, get label() { return t('Reject'); }, tone: 'bad' },
  { vote: 0, get label() { return t('Reset vote'); }, tone: 'none' },
];
// A GitHub review approves or requests changes; it can't be taken back from Keel.
const GITHUB_VOTE_BUTTONS = [
  { vote: 10, get label() { return t('Approve'); }, tone: 'ok' },
  { vote: -5, get label() { return t('Request changes'); }, tone: 'warn' },
];

const POLICY = {
  approved: { tone: 'ok', get label() { return t('Passed'); } },
  rejected: { tone: 'bad', get label() { return t('Failed'); } },
  running: { tone: 'info', get label() { return t('Running'); } },
  queued: { tone: 'muted', get label() { return t('Pending'); } },
  broken: { tone: 'bad', get label() { return t('Broken'); } },
};

export default function PrDetail({ target }) {
  const { data: pr, error, reload } = useApi(prPath(target));
  const projectLabel = useProjectLabel();
  const orgKind = useOrgKind();
  const { data: people } = useApi('/people');
  const { refresh, toast, openDrawer, can } = useApp();
  const writable = can('prs.write');
  const [busy, setBusy] = useState(null);
  const [comment, setComment] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [completing, setCompleting] = useState(false);

  if (!pr) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const act = async (body, done) => {
    setBusy(body.type + (body.vote ?? ''));
    try {
      await api(`${prPath(target)}/actions`, { method: 'POST', body });
      toast(done);
      refresh();
      return true;
    } catch (e) {
      toast(e.message, 'bad');
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Complete at a set time (server/schedules.js): Keel completes it then, as you, if it's still ready.
  const schedule = async (opts) => {
    setBusy('schedule');
    try {
      await api(`${prPath(target)}/schedule`, { method: 'POST', body: opts });
      toast(t('Pull request !{id} will be completed {when}', { id: pr.id, when: dateTime(opts.at) }));
      refresh();
      return true;
    } catch (e) {
      toast(e.message, 'bad');
      return false;
    } finally {
      setBusy(null);
    }
  };
  const cancelSchedule = async () => {
    setBusy('unschedule');
    try {
      await api(`/schedules/${encodeURIComponent(pr.schedule.id)}`, { method: 'DELETE' });
      toast(t('Scheduled completion canceled'));
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const github = orgKind(pr.org) === 'github';
  const state = REVIEW_STATE[pr.reviewState];
  const mentionable = [...(people || []), pr.author, ...pr.reviewers, ...pr.threads.recent.map((c) => c.author)];
  const candidates = (people || []).filter((p) => p.id !== pr.author?.id && !pr.reviewers.some((r) => r.id === p.id));
  // GitHub refuses reviews and review requests from a pull request's author, so those buttons go.
  const ownGithub = github && pr.isMine;
  // You aren't a reviewer until you vote or are added (myVote is null).
  const canAddMe = pr.status === 'active' && pr.myVote === null && !ownGithub;

  return (
    <div className="detail">
      <div className="detail-kicker">{projectLabel(pr.projectName, pr.org)} / {pr.repoName} <span className="mono">!{pr.id}</span></div>
      <h2 className="detail-title">{pr.title}</h2>
      <div className="chips">
        {pr.status === 'active'
          ? <Chip tone={state.tone}>{state.label}</Chip>
          : <Chip tone={pr.status === 'completed' ? 'ok' : 'muted'}>{pr.status === 'completed' ? t('Completed') : t('Abandoned')}</Chip>}
        {pr.hasConflicts && <Chip tone="bad">{t('Merge conflicts')}</Chip>}
        {pr.autoComplete && <Chip tone="ok">{github ? t('Auto-merge on') : t('Auto-complete set')}</Chip>}
        {pr.schedule?.status === 'scheduled' && <Chip tone="info" title={dateTimeZone(pr.schedule.at)}>{t('Completes {when}', { when: dateTime(pr.schedule.at) })}</Chip>}
        {pr.labels.map((l) => <Chip key={l}>{l}</Chip>)}
      </div>
      <p className="detail-meta">
        <Avatar person={pr.author} size={20} /> {t('{name} opened {age} ago', { name: pr.author?.displayName || '', age: age(pr.createdAt) })}
        <br /><code className="branch">{pr.sourceBranch} → {pr.targetBranch}</code>
      </p>

      {pr.schedule && <ScheduleNote s={pr.schedule} busy={busy === 'unschedule'} onCancel={writable ? cancelSchedule : null} />}

      {pr.status === 'active' && pr.mergeStatus !== 'succeeded' && (
        <MergeStatus pr={pr} target={target} writable={writable} busy={busy} github={github} onRefresh={reload} onRestart={() => act({ type: 'restartMerge' }, t('Merge restarted'))} />
      )}

      {writable && pr.status === 'active' && (
        <section className="detail-section">
          <h3>{t('Your vote')} {pr.myVote !== null && <span className="muted small">{t('currently: {vote}', { vote: VOTES[pr.myVote].label })}</span>}</h3>
          {pr.isMine && (
            <p className="muted small vote-note">
              {github
                ? t('This is your pull request. GitHub doesn\'t let you review your own.')
                : t('This is your pull request. Azure DevOps records your vote, but branch policies usually don\'t count it toward the required approvals unless "Allow requestors to approve their own changes" is on.')}
            </p>
          )}
          {!ownGithub && <div className="vote-row">
            {(github ? GITHUB_VOTE_BUTTONS : VOTE_BUTTONS).map((b) => (
              <button
                key={b.vote}
                type="button"
                className={`btn btn-small vote-btn vote-btn-${b.tone} ${pr.myVote === b.vote && b.vote !== 0 ? 'selected' : ''}`}
                disabled={!!busy}
                aria-pressed={pr.myVote === b.vote}
                onClick={() => act({ type: 'vote', vote: b.vote }, b.vote === 0 ? t('Vote reset') : t('Voted: {vote}', { vote: b.label }))}
              >
                {busy === `vote${b.vote}` ? '…' : b.label}
              </button>
            ))}
          </div>}
        </section>
      )}

      <section className="detail-section">
        <h3>{t('Checks')}</h3>
        {pr.policies.length ? (
          <ul className="check-list">
            {pr.policies.map((p) => (
              <li key={p.name}>
                <Chip tone={POLICY[p.status]?.tone || 'muted'}>{POLICY[p.status]?.label || p.status}</Chip>
                <span>{p.name}</span>
                {!p.isBlocking && <span className="muted small">{t('optional')}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="muted small">{github ? t('No checks have run on the latest commit.') : t('No branch policies apply to this target branch.')}</p>}
      </section>

      <section className="detail-section">
        <h3>{t('Reviewers')}</h3>
        <ul className="reviewer-list">
          {pr.reviewers.map((r) => (
            <li key={r.id}>
              <Avatar person={r} vote={r.vote} size={22} />
              <span className="truncate">{r.displayName}</span>
              {r.isRequired && <Chip>{t('Required')}</Chip>}
              <span className={`small vote-text-${VOTES[r.vote]?.tone}`}>{VOTES[r.vote]?.label}</span>
            </li>
          ))}
          {!pr.reviewers.length && <li className="text-bad small">{t('No reviewers yet.')}</li>}
        </ul>
        {writable && pr.status === 'active' && (candidates.length > 0 || canAddMe) && (
          <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (reviewer && await act({ type: 'addReviewer', reviewerId: reviewer }, t('Reviewer added'))) setReviewer(''); }}>
            {candidates.length > 0 && <>
              <select className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)} aria-label={t('Reviewer to add')}>
                <option value="">{t('Add a reviewer…')}</option>
                {candidates.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
              <button type="submit" className="btn btn-small" disabled={!reviewer || !!busy}>{t('Add')}</button>
            </>}
            {/* "me" is resolved on the server, in this pull request's organization. */}
            {canAddMe && <button type="button" className="btn btn-small btn-ghost" disabled={!!busy} title={t('Add yourself as a reviewer')} onClick={() => act({ type: 'addReviewer', reviewerId: 'me' }, t('You were added as a reviewer'))}>{t('Add me')}</button>}
          </form>
        )}
        {writable && pr.status === 'active' && pr.files?.items?.length > 0 && (
          <PrSuggestions pr={pr} busy={!!busy} onAdd={(p) => act({ type: 'addReviewer', reviewerId: p.id }, t('Reviewer added'))} />
        )}
      </section>

      {pr.workItems.length > 0 && (
        <section className="detail-section">
          <h3>{t('Linked work items')}</h3>
          <ul className="link-list">
            {pr.workItems.map((w) => (
              <li key={w.id}>
                <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'workitem', id: w.id, org: pr.org })}>
                  <span className="mono muted">{w.id}</span> {w.title}
                </button>
                <Chip tone={w.stateCategory === 'Completed' ? 'ok' : 'muted'}>{w.state}</Chip>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pr.description && (
        <section className="detail-section">
          <h3>{t('Description')}</h3>
          <Markdown text={pr.description} people={mentionable} />
        </section>
      )}

      {pr.files && <ChangedFiles files={pr.files} webUrl={pr.webUrl} github={github} fileHref={github ? githubPrFileHref : undefined} />}

      <section className="detail-section">
        <h3>{t('Discussion')} <span className="muted small">{t(pr.threads.total === 1 ? '{open} open of {total} thread' : '{open} open of {total} threads', { open: pr.threads.active, total: pr.threads.total })}</span></h3>
        <ul className="comments">
          {pr.threads.recent.map((c, i) => (
            <li key={i}>
              <div className="comment-head">
                <Avatar person={c.author} size={18} /> <strong>{c.author?.displayName}</strong>
                <span className="muted small">{dateTime(c.publishedAt)}</span>
                {c.status === 'active' && <Chip tone="warn">{t('Active')}</Chip>}
              </div>
              {c.filePath && <code className="small muted">{c.filePath}</code>}
              <Markdown text={c.content} people={mentionable} />
            </li>
          ))}
          {!pr.threads.recent.length && <li className="muted small">{t('No comments yet.')}</li>}
        </ul>
        {writable && (
        <form className="comment-form" onSubmit={async (e) => { e.preventDefault(); if (await act({ type: 'comment', content: comment }, t('Comment posted'))) setComment(''); }}>
          <textarea className="input" rows={3} placeholder={t('Leave a comment (Markdown supported)')} value={comment} onChange={(e) => setComment(e.target.value)} aria-label={t('Comment')} />
          <button type="submit" className="btn btn-primary btn-small" disabled={!comment.trim() || !!busy}>{t('Post comment')}</button>
        </form>
        )}
      </section>

      {completing && pr.status === 'active' && (
        <CompleteForm pr={pr} github={github} busy={!!busy} onCancel={() => setCompleting(false)} onSchedule={async (opts) => {
          if (await schedule(opts)) setCompleting(false);
        }} onComplete={async (opts) => {
          if (await act({ type: 'complete', ...opts }, t('Pull request !{id} completed', { id: pr.id }))) setCompleting(false);
        }} />
      )}

      <section className="detail-actions sticky-actions">
        {pr.status !== 'active' && <span className="small muted">{pr.status === 'completed' ? t('This pull request is completed.') : pr.status === 'abandoned' ? t('This pull request is abandoned.') : t('This pull request is {status}.', { status: pr.status })}</span>}
        {writable && pr.status === 'active' && pr.isDraft && <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => act({ type: 'publish' }, t('Published'))}>{t('Publish draft')}</button>}
        {writable && pr.status === 'active' && !pr.isDraft && !completing && (
          <button type="button" className="btn btn-small btn-primary" disabled={!!busy || pr.hasConflicts} title={pr.hasConflicts ? t('Resolve the merge conflicts first') : undefined} onClick={() => setCompleting(true)}>{t('Complete…')}</button>
        )}
        {writable && pr.status === 'active' && !pr.isDraft && (github
          ? pr.autoComplete
            ? <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => act({ type: 'autoComplete', enabled: false }, t('Auto-merge turned off'))}>{t('Turn off auto-merge')}</button>
            : <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => act({ type: 'autoComplete', enabled: true }, t('Auto-merge on'))}>{t('Turn on auto-merge')}</button>
          : pr.autoComplete
            ? <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => act({ type: 'autoComplete', enabled: false }, t('Auto-complete cancelled'))}>{t('Cancel auto-complete')}</button>
            : <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => act({ type: 'autoComplete', enabled: true }, t('Auto-complete set'))}>{t('Set auto-complete')}</button>)}
        {writable && !github && pr.status === 'active' && pr.mergeStatus === 'succeeded' && (
          <button type="button" className="btn btn-small btn-ghost" disabled={!!busy} title={t('Restart merge checks again without a push, for example after the target branch changed.')} onClick={() => act({ type: 'restartMerge' }, t('Merge restarted'))}>{t('Restart merge')}</button>
        )}
        {writable && pr.status === 'active' && (github
          ? <Confirm text={t('Close this pull request without merging?')} onConfirm={() => act({ type: 'abandon' }, t('Pull request closed'))} className="btn btn-small btn-ghost text-bad">{t('Close')}</Confirm>
          : <Confirm text={t('Abandon this pull request?')} onConfirm={() => act({ type: 'abandon' }, t('Pull request abandoned'))} className="btn btn-small btn-ghost text-bad">{t('Abandon')}</Confirm>)}
        <ExternalLink href={pr.webUrl} />
      </section>
    </div>
  );
}

// Label and hint are English; translated with t() at render.
const MERGE_TYPES = [
  ['squash', 'Squash commit', 'One commit on the target with all the changes'],
  ['noFastForward', 'Merge (no fast-forward)', 'Keeps every commit plus a merge commit'],
  ['rebase', 'Rebase and fast-forward', 'Replays the commits on the target, no merge commit'],
  ['rebaseMerge', 'Semi-linear merge', 'Rebases, then adds a merge commit'],
];

// GitHub's three: squash, a merge commit, or rebase (no semi-linear merge).
const GITHUB_MERGE_TYPES = [
  ['squash', 'Squash and merge', 'One commit on the target with all the changes'],
  ['noFastForward', 'Create a merge commit', 'Keeps every commit plus a merge commit'],
  ['rebase', 'Rebase and merge', 'Replays the commits on the target, no merge commit'],
];

const MERGE_LABEL = Object.fromEntries([...MERGE_TYPES, ...GITHUB_MERGE_TYPES].map(([v, label]) => [v, label]));

/** A scheduled completion on its pull request: when, how and by whom, or how it went. */
function ScheduleNote({ s, busy, onCancel }) {
  if (s.status === 'scheduled') {
    return (
      <p className="callout small schedule-note">
        {t('Keel will complete it {when} ({merge}), if by then it is approved, its required checks have passed and it has no conflicts.', { when: dateTimeZone(s.at), merge: t(MERGE_LABEL[s.mergeStrategy] || s.mergeStrategy) })}
        {s.ownerName && ` ${t('Scheduled by {name}.', { name: s.ownerName })}`}
        {onCancel && <> <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>{busy ? t('Canceling…') : t('Cancel it')}</button></>}
      </p>
    );
  }
  if (s.status === 'done') return <p className="callout small">{t('Completed as scheduled, {when}.', { when: dateTime(s.finishedAt || s.at) })}</p>;
  return <p className="callout callout-warn small">{t("Wasn't completed as scheduled ({when}): {reason}.", { when: dateTime(s.at), reason: tx(s.reason) })}</p>;
}

/** Merge now, or at a set time: merge type, commit message, cleanup options, optional policy override (now only). */
function CompleteForm({ pr, busy, onCancel, onComplete, onSchedule, github = false }) {
  const { meta } = useApp();
  const defaults = meta.autoComplete || {};
  const types = github ? GITHUB_MERGE_TYPES : MERGE_TYPES;
  const [mergeStrategy, setMergeStrategy] = useState(types.some(([v]) => v === defaults.mergeStrategy) ? defaults.mergeStrategy : types[0][0]);
  // GitHub's own default title when squashing: "Title (#12)".
  const [message, setMessage] = useState(github ? `${pr.title} (#${pr.id})` : `Merged PR ${pr.id}: ${pr.title}`);
  const [deleteSourceBranch, setDeleteSourceBranch] = useState(defaults.deleteSourceBranch ?? false);
  const [transitionWorkItems, setTransitionWorkItems] = useState(defaults.transitionWorkItems ?? true);
  const [bypassPolicy, setBypassPolicy] = useState(false);
  const [bypassReason, setBypassReason] = useState('');
  const [when, setWhen] = useState('now');
  const [at, setAt] = useState(() => defaultAt());
  const later = when === 'at';
  const pending = pr.policies.filter((p) => p.isBlocking && p.status !== 'approved');
  const usesMessage = mergeStrategy !== 'rebase';
  const formRef = useRef(null);
  // Bring the form into view when it opens (it sits near the bottom of a long panel).
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    formRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    formRef.current?.querySelector('select')?.focus({ preventScroll: true });
  }, []);

  return (
    <section className="detail-section complete-form" aria-label={t('Complete pull request')} ref={formRef}>
      <h3>{t('Complete pull request')}</h3>
      <div className="complete-when" role="radiogroup" aria-label={t('When')}>
        <label className="check"><input type="radio" name="complete-when" checked={!later} onChange={() => setWhen('now')} /> {t('Now')}</label>
        <label className="check"><input type="radio" name="complete-when" checked={later} onChange={() => setWhen('at')} /> {t('At')}</label>
        <input className="input" type="datetime-local" value={at} onChange={(e) => { setAt(e.target.value); setWhen('at'); }} aria-label={t('Complete at')} aria-describedby="complete-at-zone" />
        {localZone() && <span className="muted small" id="complete-at-zone">{t('{zone} time', { zone: localZone() })}</span>}
      </div>
      {later && <p className="muted small">{t('Keel completes it then, as you, if it is approved, its required checks have passed and it has no conflicts; otherwise it tells you why not. Policies are never overridden.')}</p>}
      {!later && pending.length > 0 && (
        <p className="callout small">
          {t(pending.length === 1 ? '{n} required check not passed: {checks}.' : '{n} required checks not passed: {checks}.', {
            n: pending.length,
            checks: pending.map((p) => t(p.status === 'rejected' ? '{name} (failed)' : '{name} (pending)', { name: p.name })).join(', '),
          })}
          {' '}{github ? t('GitHub will refuse to merge it until they pass. You can turn on auto-merge instead.') : t('Azure DevOps will refuse to complete it unless you override policies, or you can set auto-complete instead.')}
        </p>
      )}
      <label className="field">{t('Merge type')}
        <select className="input" value={mergeStrategy} onChange={(e) => setMergeStrategy(e.target.value)}>
          {types.map(([v, label, hint]) => <option key={v} value={v}>{t(label)}: {t(hint)}</option>)}
        </select>
      </label>
      {usesMessage && (
        <label className="field">{t('Merge commit message')}
          <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
      )}
      <label className="check"><input type="checkbox" checked={deleteSourceBranch} onChange={(e) => setDeleteSourceBranch(e.target.checked)} /> {tj('Delete {branch} after merging', { branch: <code className="branch">{pr.sourceBranch}</code> })}</label>
      {!github && <label className="check"><input type="checkbox" checked={transitionWorkItems} onChange={(e) => setTransitionWorkItems(e.target.checked)} /> {t('Complete linked work items')}{pr.workItems.length ? ` (${pr.workItems.length})` : ''}</label>}
      {!later && !github && <label className="check"><input type="checkbox" checked={bypassPolicy} onChange={(e) => setBypassPolicy(e.target.checked)} /> {t('Override branch policies')} <span className="muted small">{t('(needs bypass permission; recorded in the PR history)')}</span></label>}
      {!later && bypassPolicy && (
        <label className="field">{t('Reason for overriding')}
          <input className="input" value={bypassReason} onChange={(e) => setBypassReason(e.target.value)} placeholder={t('e.g. Hotfix for production incident')} />
        </label>
      )}
      <div className="complete-actions">
        {later ? (
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={busy || !at}
            onClick={() => onSchedule({ at: new Date(at).toISOString(), mergeStrategy, mergeCommitMessage: usesMessage ? message : undefined, deleteSourceBranch, transitionWorkItems })}
          >
            {busy ? t('Scheduling…') : t('Schedule completion')}
          </button>
        ) : (
          <button
            type="button"
            className={`btn btn-small ${bypassPolicy ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy || (bypassPolicy && !bypassReason.trim())}
            onClick={() => onComplete({ mergeStrategy, mergeCommitMessage: usesMessage ? message : undefined, deleteSourceBranch, transitionWorkItems, bypassPolicy, bypassReason })}
          >
            {busy ? t('Completing…') : bypassPolicy ? t('Override and complete merge') : t('Complete merge')}
          </button>
        )}
        <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>{t('Cancel')}</button>
      </div>
    </section>
  );
}

/** Reviewers to suggest for an open pull request, from the folders it changes. */
function PrSuggestions({ pr, onAdd, busy }) {
  const [suggested, setSuggested] = useState(null);
  const paths = pr.files.items.map((f) => f.path).join('\n');
  useEffect(() => {
    let live = true;
    api(`/repos/${encodeURIComponent(pr.projectId)}/${encodeURIComponent(pr.repoId)}/reviewers`, {
      method: 'POST',
      body: { paths: paths.split('\n'), target: pr.targetBranch, author: pr.author?.id, exclude: pr.reviewers.map((r) => r.id) },
    }).then((r) => live && setSuggested(r.suggestions)).catch(() => live && setSuggested([]));
    return () => { live = false; };
  }, [pr.key, paths]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = (suggested || []).filter((x) => !pr.reviewers.some((r) => r.id === x.person.id));
  return <SuggestedReviewers suggestions={left.slice(0, 3)} onAdd={onAdd} busy={busy} />;
}
