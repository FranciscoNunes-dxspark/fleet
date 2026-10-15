import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime, isBlocked, shortIteration } from '../format.js';
import { Avatar, Chip, ErrorBox, ExternalLink, Loading } from '../ui.jsx';
import { CATEGORY_TONE } from './WorkItems.jsx';

export default function WorkItemDetail({ id }) {
  const { data: w, error, reload } = useApi(`/workitems/${id}`);
  const { data: people } = useApi('/people');
  const { refresh, toast, openDrawer, meta } = useApp();
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');

  if (!w) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const act = async (body, done) => {
    setBusy(true);
    try {
      await api(`/workitems/${id}/actions`, { method: 'POST', body });
      toast(done);
      refresh();
      return true;
    } catch (e) {
      toast(e.message, 'bad');
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Processes with a Blocked state use the State picker; others use the tag.
  const hasBlockedState = w.allowedStates.some((s) => s.name.toLowerCase() === meta.blockedTag.toLowerCase());
  const blocked = w.tags.some((t) => t.toLowerCase() === meta.blockedTag.toLowerCase());
  const toggleBlocked = () => act(
    { type: 'update', changes: { tags: blocked ? w.tags.filter((t) => t.toLowerCase() !== meta.blockedTag.toLowerCase()) : [...w.tags, meta.blockedTag] } },
    blocked ? 'Marked unblocked' : 'Marked blocked',
  );

  return (
    <div className="detail">
      <div className="detail-kicker">{w.projectName} · {w.type} <span className="mono">{w.id}</span></div>
      <h2 className="detail-title">{w.title}</h2>
      <div className="chips">
        <Chip tone={CATEGORY_TONE[w.stateCategory]}>{w.state}</Chip>
        {isBlocked(w, meta.blockedTag) && w.state.toLowerCase() !== meta.blockedTag.toLowerCase() && <Chip tone="bad">Blocked</Chip>}
        {w.priority && <Chip tone={w.priority === 1 ? 'bad' : 'muted'}>Priority {w.priority}</Chip>}
        {w.severity && <Chip>{w.severity}</Chip>}
        {w.tags.filter((t) => t.toLowerCase() !== meta.blockedTag.toLowerCase()).map((t) => <Chip key={t}>{t}</Chip>)}
      </div>

      <dl className="facts">
        <div><dt>Iteration</dt><dd>{shortIteration(w.iterationPath) || '—'}</dd></div>
        <div><dt>Area</dt><dd>{w.areaPath}</dd></div>
        <div><dt>{w.type === 'Task' ? 'Remaining' : 'Points'}</dt><dd>{(w.type === 'Task' ? w.remainingWork : w.storyPoints) ?? '—'}</dd></div>
        <div><dt>In state for</dt><dd>{age(w.stateChangedAt)}</dd></div>
        <div><dt>Last updated</dt><dd>{age(w.changedAt)} ago</dd></div>
        <div><dt>Created</dt><dd>{age(w.createdAt)} ago by {w.createdBy?.displayName}</dd></div>
      </dl>

      <section className="detail-section">
        <h3>Update</h3>
        <div className="form-grid">
          <label>State
            <select className="input" value={w.state} disabled={busy} onChange={(e) => act({ type: 'update', changes: { state: e.target.value } }, `Moved to ${e.target.value}`)}>
              {w.allowedStates.map((s) => <option key={s.name}>{s.name}</option>)}
            </select>
          </label>
          <label>Assigned to
            <select className="input" value={w.assignedTo?.uniqueName || ''} disabled={busy} onChange={(e) => act({ type: 'update', changes: { assignedTo: e.target.value } }, 'Assignee updated')}>
              <option value="">Unassigned</option>
              {w.assignedTo && !(people || []).some((p) => p.uniqueName === w.assignedTo.uniqueName) && <option value={w.assignedTo.uniqueName}>{w.assignedTo.displayName}</option>}
              {(people || []).map((p) => <option key={p.id} value={p.uniqueName}>{p.displayName}</option>)}
            </select>
          </label>
          <label>Priority
            <select className="input" value={w.priority ?? ''} disabled={busy} onChange={(e) => act({ type: 'update', changes: { priority: e.target.value } }, 'Priority updated')}>
              {w.priority == null && <option value="">—</option>}
              {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          {!hasBlockedState && <div className="form-grid-action">
            <button type="button" className="btn btn-small" disabled={busy} onClick={toggleBlocked}>{blocked ? 'Remove blocked tag' : 'Mark as blocked'}</button>
          </div>}
        </div>
      </section>

      {(w.parent || w.children.length > 0) && (
        <section className="detail-section">
          <h3>Hierarchy</h3>
          <ul className="link-list">
            {w.parent && (
              <li>
                <span className="muted small">Parent</span>
                <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'workitem', id: w.parent.id })}><span className="mono muted">{w.parent.id}</span> {w.parent.title}</button>
              </li>
            )}
            {w.children.map((c) => (
              <li key={c.id}>
                <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'workitem', id: c.id })}><span className="mono muted">{c.id}</span> {c.title}</button>
                <Chip tone={CATEGORY_TONE[c.stateCategory]}>{c.state}</Chip>
                <span className="muted small">{c.assignedTo?.displayName || 'Unassigned'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {w.pullRequests.length > 0 && (
        <section className="detail-section">
          <h3>Pull requests</h3>
          <ul className="link-list">
            {w.pullRequests.map((p) => (
              <li key={`${p.repoId}/${p.id}`}>
                <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'pr', ...p })}>Pull request <span className="mono">!{p.id}</span></button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {w.description && (
        <section className="detail-section">
          <h3>{w.type === 'Bug' ? 'Description / repro steps' : 'Description'}</h3>
          <div className="prose">{w.description}</div>
        </section>
      )}
      {w.acceptanceCriteria && (
        <section className="detail-section">
          <h3>Acceptance criteria</h3>
          <div className="prose">{w.acceptanceCriteria}</div>
        </section>
      )}

      <section className="detail-section">
        <h3>Comments</h3>
        <ul className="comments">
          {w.comments.map((c, i) => (
            <li key={i}>
              <div className="comment-head"><Avatar person={c.author} size={18} /> <strong>{c.author?.displayName}</strong> <span className="muted small">{dateTime(c.createdAt)}</span></div>
              <div className="prose">{c.text}</div>
            </li>
          ))}
          {!w.comments.length && <li className="muted small">No comments yet.</li>}
        </ul>
        <form className="comment-form" onSubmit={async (e) => { e.preventDefault(); if (await act({ type: 'comment', text: comment }, 'Comment posted')) setComment(''); }}>
          <textarea className="input" rows={3} placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
          <button type="submit" className="btn btn-primary btn-small" disabled={!comment.trim() || busy}>Post comment</button>
        </form>
      </section>

      <section className="detail-actions sticky-actions">
        {w.type !== 'Epic' && w.type !== 'Feature' && (
          <button type="button" className="btn btn-small" onClick={() => openDrawer({ type: 'newpr', workItemId: w.id })}>Create pull request</button>
        )}
        <ExternalLink href={w.webUrl}>Open in Azure DevOps</ExternalLink>
      </section>
    </div>
  );
}
