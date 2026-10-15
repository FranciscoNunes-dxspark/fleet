import { useEffect, useRef, useState } from 'react';
import { api, prPath } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime, REVIEW_STATE, VOTES } from '../format.js';
import { Avatar, Chip, Confirm, ErrorBox, ExternalLink, Loading } from '../ui.jsx';
import { Markdown } from '../markdown.jsx';

const FILE_KIND = {
  added: { letter: 'A', tone: 'ok', label: 'Added' },
  edited: { letter: 'M', tone: 'info', label: 'Modified' },
  deleted: { letter: 'D', tone: 'bad', label: 'Deleted' },
  renamed: { letter: 'R', tone: 'warn', label: 'Renamed' },
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

function FileRow({ f, webUrl }) {
  const kind = FILE_KIND[f.kind] || FILE_KIND.edited;
  return (
    <li className="file-row">
      <span className={`file-kind chip chip-${kind.tone}`} title={kind.label} aria-label={kind.label}>{kind.letter}</span>
      <a className="file-name" href={`${webUrl}?_a=files&path=${encodeURIComponent(f.path)}`} target="_blank" rel="noreferrer noopener" title={`Open the diff for ${f.path} in Azure DevOps`}>{f.name}</a>
      {f.originalPath && <span className="muted small file-from" title={f.originalPath}>from {f.originalPath.split('/').pop()}</span>}
    </li>
  );
}

function Folder({ node, webUrl, depth }) {
  return (
    <li>
      <details open={depth < 3 || node.count <= 8}>
        <summary className="folder-row"><span className="folder-name">{node.name}/</span><span className="muted small">{node.count}</span></summary>
        <FolderBody node={node} webUrl={webUrl} depth={depth + 1} />
      </details>
    </li>
  );
}

function FolderBody({ node, webUrl, depth }) {
  return (
    <ul className="file-tree">
      {node.folders.map((c) => <Folder key={c.name} node={c} webUrl={webUrl} depth={depth} />)}
      {node.files.map((f) => <FileRow key={f.path} f={f} webUrl={webUrl} />)}
    </ul>
  );
}

function ChangedFiles({ files, webUrl }) {
  const counts = Object.entries(FILE_KIND)
    .map(([k, v]) => [v.label, files.items.filter((f) => f.kind === k).length])
    .filter(([, n]) => n)
    .map(([label, n]) => `${n} ${label.toLowerCase()}`);
  const tree = fileTree(files.items);
  return (
    <section className="detail-section">
      <h3>Files changed <span className="muted small">{files.total}{files.truncated ? '+' : ''}{counts.length ? ` · ${counts.join(', ')}` : ''}</span></h3>
      {files.error && <p className="text-bad small">Couldn't load the file list: {files.error}</p>}
      {!files.error && !files.items.length && <p className="muted small">No file changes in the latest update.</p>}
      <FolderBody node={tree} webUrl={webUrl} depth={0} />
      {files.truncated && <p className="muted small">Azure DevOps returned the first 2,000 files only.</p>}
    </section>
  );
}

const VOTE_BUTTONS = [
  { vote: 10, label: 'Approve', tone: 'ok' },
  { vote: 5, label: 'Approve with suggestions', tone: 'ok' },
  { vote: -5, label: 'Wait for author', tone: 'warn' },
  { vote: -10, label: 'Reject', tone: 'bad' },
  { vote: 0, label: 'Reset vote', tone: 'none' },
];

const POLICY = {
  approved: { tone: 'ok', label: 'Passed' },
  rejected: { tone: 'bad', label: 'Failed' },
  running: { tone: 'info', label: 'Running' },
  queued: { tone: 'muted', label: 'Pending' },
  broken: { tone: 'bad', label: 'Broken' },
};

export default function PrDetail({ target }) {
  const { data: pr, error, reload } = useApi(prPath(target));
  const { data: people } = useApi('/people');
  const { refresh, toast, openDrawer } = useApp();
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

  const state = REVIEW_STATE[pr.reviewState];
  const mentionable = [...(people || []), pr.author, ...pr.reviewers, ...pr.threads.recent.map((c) => c.author)];
  const candidates = (people || []).filter((p) => p.id !== pr.author?.id && !pr.reviewers.some((r) => r.id === p.id));

  return (
    <div className="detail">
      <div className="detail-kicker">{pr.projectName} / {pr.repoName} <span className="mono">!{pr.id}</span></div>
      <h2 className="detail-title">{pr.title}</h2>
      <div className="chips">
        {pr.status === 'active'
          ? <Chip tone={state.tone}>{state.label}</Chip>
          : <Chip tone={pr.status === 'completed' ? 'ok' : 'muted'}>{pr.status === 'completed' ? 'Completed' : 'Abandoned'}</Chip>}
        {pr.hasConflicts && <Chip tone="bad">Merge conflicts</Chip>}
        {pr.autoComplete && <Chip tone="ok">Auto-complete set</Chip>}
        {pr.labels.map((l) => <Chip key={l}>{l}</Chip>)}
      </div>
      <p className="detail-meta">
        <Avatar person={pr.author} size={20} /> {pr.author?.displayName} opened {age(pr.createdAt)} ago
        <br /><code className="branch">{pr.sourceBranch} → {pr.targetBranch}</code>
      </p>

      {pr.status === 'active' && (
        <section className="detail-section">
          <h3>Your vote {pr.myVote !== null && <span className="muted small">currently: {VOTES[pr.myVote].label}</span>}</h3>
          {pr.isMine && (
            <p className="muted small vote-note">
              This is your pull request. Azure DevOps records your vote, but branch policies usually don't count it toward the required approvals
              unless "Allow requestors to approve their own changes" is on.
            </p>
          )}
          <div className="vote-row">
            {VOTE_BUTTONS.map((b) => (
              <button
                key={b.vote}
                type="button"
                className={`btn btn-small vote-btn vote-btn-${b.tone} ${pr.myVote === b.vote && b.vote !== 0 ? 'selected' : ''}`}
                disabled={!!busy}
                aria-pressed={pr.myVote === b.vote}
                onClick={() => act({ type: 'vote', vote: b.vote }, b.vote === 0 ? 'Vote reset' : `Voted: ${b.label}`)}
              >
                {busy === `vote${b.vote}` ? '…' : b.label}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="detail-section">
        <h3>Checks</h3>
        {pr.policies.length ? (
          <ul className="check-list">
            {pr.policies.map((p) => (
              <li key={p.name}>
                <Chip tone={POLICY[p.status]?.tone || 'muted'}>{POLICY[p.status]?.label || p.status}</Chip>
                <span>{p.name}</span>
                {!p.isBlocking && <span className="muted small">optional</span>}
              </li>
            ))}
          </ul>
        ) : <p className="muted small">No branch policies apply to this target branch.</p>}
      </section>

      <section className="detail-section">
        <h3>Reviewers</h3>
        <ul className="reviewer-list">
          {pr.reviewers.map((r) => (
            <li key={r.id}>
              <Avatar person={r} vote={r.vote} size={22} />
              <span className="truncate">{r.displayName}</span>
              {r.isRequired && <Chip>Required</Chip>}
              <span className={`small vote-text-${VOTES[r.vote]?.tone}`}>{VOTES[r.vote]?.label}</span>
            </li>
          ))}
          {!pr.reviewers.length && <li className="text-bad small">No reviewers yet.</li>}
        </ul>
        {candidates.length > 0 && (
          <form className="inline-form" onSubmit={async (e) => { e.preventDefault(); if (reviewer && await act({ type: 'addReviewer', reviewerId: reviewer }, 'Reviewer added')) setReviewer(''); }}>
            <select className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)} aria-label="Reviewer to add">
              <option value="">Add a reviewer…</option>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
            <button type="submit" className="btn btn-small" disabled={!reviewer || !!busy}>Add</button>
          </form>
        )}
      </section>

      {pr.workItems.length > 0 && (
        <section className="detail-section">
          <h3>Linked work items</h3>
          <ul className="link-list">
            {pr.workItems.map((w) => (
              <li key={w.id}>
                <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'workitem', id: w.id })}>
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
          <h3>Description</h3>
          <Markdown text={pr.description} people={mentionable} />
        </section>
      )}

      {pr.files && <ChangedFiles files={pr.files} webUrl={pr.webUrl} />}

      <section className="detail-section">
        <h3>Discussion <span className="muted small">{pr.threads.active} open of {pr.threads.total} threads</span></h3>
        <ul className="comments">
          {pr.threads.recent.map((c, i) => (
            <li key={i}>
              <div className="comment-head">
                <Avatar person={c.author} size={18} /> <strong>{c.author?.displayName}</strong>
                <span className="muted small">{dateTime(c.publishedAt)}</span>
                {c.status === 'active' && <Chip tone="warn">Open</Chip>}
              </div>
              {c.filePath && <code className="small muted">{c.filePath}</code>}
              <Markdown text={c.content} people={mentionable} />
            </li>
          ))}
          {!pr.threads.recent.length && <li className="muted small">No comments yet.</li>}
        </ul>
        <form className="comment-form" onSubmit={async (e) => { e.preventDefault(); if (await act({ type: 'comment', content: comment }, 'Comment posted')) setComment(''); }}>
          <textarea className="input" rows={3} placeholder="Leave a comment (Markdown supported)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
          <button type="submit" className="btn btn-primary btn-small" disabled={!comment.trim() || !!busy}>Post comment</button>
        </form>
      </section>

      {completing && pr.status === 'active' && (
        <CompleteForm pr={pr} busy={!!busy} onCancel={() => setCompleting(false)} onComplete={async (opts) => {
          if (await act({ type: 'complete', ...opts }, `Pull request !${pr.id} completed`)) setCompleting(false);
        }} />
      )}

      <section className="detail-actions sticky-actions">
        {pr.status !== 'active' && <span className="small muted">This pull request is {pr.status}.</span>}
        {pr.status === 'active' && pr.isDraft && <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => act({ type: 'publish' }, 'Published')}>Publish draft</button>}
        {pr.status === 'active' && !pr.isDraft && !completing && (
          <button type="button" className="btn btn-small btn-primary" disabled={!!busy || pr.hasConflicts} title={pr.hasConflicts ? 'Resolve the merge conflicts first' : undefined} onClick={() => setCompleting(true)}>Complete…</button>
        )}
        {pr.status === 'active' && !pr.isDraft && (pr.autoComplete
          ? <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => act({ type: 'autoComplete', enabled: false }, 'Auto-complete cancelled')}>Cancel auto-complete</button>
          : <button type="button" className="btn btn-small" disabled={!!busy} onClick={() => act({ type: 'autoComplete', enabled: true }, 'Auto-complete set')}>Set auto-complete</button>)}
        {pr.status === 'active' && <Confirm text="Abandon this pull request?" onConfirm={() => act({ type: 'abandon' }, 'Pull request abandoned')} className="btn btn-small btn-ghost text-bad">Abandon</Confirm>}
        <ExternalLink href={pr.webUrl}>Open in Azure DevOps</ExternalLink>
      </section>
    </div>
  );
}

const MERGE_TYPES = [
  ['squash', 'Squash commit', 'One commit on the target with all the changes'],
  ['noFastForward', 'Merge (no fast-forward)', 'Keeps every commit plus a merge commit'],
  ['rebase', 'Rebase and fast-forward', 'Replays the commits on the target, no merge commit'],
  ['rebaseMerge', 'Semi-linear merge', 'Rebases, then adds a merge commit'],
];

/** Merge now: merge type, commit message, cleanup options, optional policy override. */
function CompleteForm({ pr, busy, onCancel, onComplete }) {
  const { meta } = useApp();
  const defaults = meta.autoComplete || {};
  const [mergeStrategy, setMergeStrategy] = useState(defaults.mergeStrategy || 'squash');
  const [message, setMessage] = useState(`Merged PR ${pr.id}: ${pr.title}`);
  const [deleteSourceBranch, setDeleteSourceBranch] = useState(defaults.deleteSourceBranch ?? true);
  const [transitionWorkItems, setTransitionWorkItems] = useState(defaults.transitionWorkItems ?? true);
  const [bypassPolicy, setBypassPolicy] = useState(false);
  const [bypassReason, setBypassReason] = useState('');
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
    <section className="detail-section complete-form" aria-label="Complete pull request" ref={formRef}>
      <h3>Complete pull request</h3>
      {pending.length > 0 && (
        <p className="callout small">
          {pending.length} required check{pending.length === 1 ? '' : 's'} not passed: {pending.map((p) => `${p.name} (${p.status === 'rejected' ? 'failed' : 'pending'})`).join(', ')}.
          {' '}Azure DevOps will refuse to complete it unless you override policies, or you can set auto-complete instead.
        </p>
      )}
      <label className="field">Merge type
        <select className="input" value={mergeStrategy} onChange={(e) => setMergeStrategy(e.target.value)}>
          {MERGE_TYPES.map(([v, label, hint]) => <option key={v} value={v}>{label}: {hint}</option>)}
        </select>
      </label>
      {usesMessage && (
        <label className="field">Merge commit message
          <textarea className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
      )}
      <label className="check"><input type="checkbox" checked={deleteSourceBranch} onChange={(e) => setDeleteSourceBranch(e.target.checked)} /> Delete <code className="branch">{pr.sourceBranch}</code> after merging</label>
      <label className="check"><input type="checkbox" checked={transitionWorkItems} onChange={(e) => setTransitionWorkItems(e.target.checked)} /> Complete linked work items{pr.workItems.length ? ` (${pr.workItems.length})` : ''}</label>
      <label className="check"><input type="checkbox" checked={bypassPolicy} onChange={(e) => setBypassPolicy(e.target.checked)} /> Override branch policies <span className="muted small">(needs bypass permission; recorded in the PR history)</span></label>
      {bypassPolicy && (
        <label className="field">Reason for overriding
          <input className="input" value={bypassReason} onChange={(e) => setBypassReason(e.target.value)} placeholder="e.g. Hotfix for production incident" />
        </label>
      )}
      <div className="complete-actions">
        <button
          type="button"
          className={`btn btn-small ${bypassPolicy ? 'btn-danger' : 'btn-primary'}`}
          disabled={busy || (bypassPolicy && !bypassReason.trim())}
          onClick={() => onComplete({ mergeStrategy, mergeCommitMessage: usesMessage ? message : undefined, deleteSourceBranch, transitionWorkItems, bypassPolicy, bypassReason })}
        >
          {busy ? 'Completing…' : bypassPolicy ? 'Override and complete merge' : 'Complete merge'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
