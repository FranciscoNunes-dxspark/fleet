import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime, isBlocked, shortIteration } from '../format.js';
import { Avatar, Chip, ErrorBox, ExternalLink, Loading } from '../ui.jsx';
import { t } from '../i18n.js';
import { CATEGORY_TONE } from './WorkItems.jsx';
import ClaudeStart from './ClaudeStart.jsx';

// What "Add child" creates by default under each type (the form lets you change it).
const CHILD_TYPE = { Epic: 'Feature', Feature: 'User Story', 'User Story': 'Task', 'Product Backlog Item': 'Task', Requirement: 'Task', Issue: 'Task', Bug: 'Task' };

export default function WorkItemDetail({ id }) {
  const { data: w, error, reload } = useApi(`/workitems/${id}`);
  const { data: people } = useApi('/people');
  const { refresh, toast, openDrawer, meta, can } = useApp();
  const editable = can('workitems.write');
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
  const blocked = w.tags.some((tag) => tag.toLowerCase() === meta.blockedTag.toLowerCase());
  const toggleBlocked = () => act(
    { type: 'update', changes: { tags: blocked ? w.tags.filter((tag) => tag.toLowerCase() !== meta.blockedTag.toLowerCase()) : [...w.tags, meta.blockedTag] } },
    blocked ? t('Marked unblocked') : t('Marked blocked'),
  );

  return (
    <div className="detail">
      <div className="detail-kicker">{w.projectName} · {w.type} <span className="mono">{w.id}</span></div>
      <h2 className="detail-title">{w.title}</h2>
      <div className="chips">
        <Chip tone={CATEGORY_TONE[w.stateCategory]}>{w.state}</Chip>
        {isBlocked(w, meta.blockedTag) && w.state.toLowerCase() !== meta.blockedTag.toLowerCase() && <Chip tone="bad">{t('Blocked')}</Chip>}
        {w.priority && <Chip tone={w.priority === 1 ? 'bad' : 'muted'}>{t('Priority {n}', { n: w.priority })}</Chip>}
        {w.severity && <Chip>{w.severity}</Chip>}
        {w.tags.filter((tag) => tag.toLowerCase() !== meta.blockedTag.toLowerCase()).map((tag) => <Chip key={tag}>{tag}</Chip>)}
      </div>

      <dl className="facts">
        <div><dt>{t('Iteration')}</dt><dd>{shortIteration(w.iterationPath) || '—'}</dd></div>
        <div><dt>{t('Area')}</dt><dd>{w.areaPath}</dd></div>
        <div><dt>{w.type === 'Task' ? t('Remaining') : t('Points')}</dt><dd>{(w.type === 'Task' ? w.remainingWork : w.storyPoints) ?? '—'}</dd></div>
        <div><dt>{t('In state for')}</dt><dd>{age(w.stateChangedAt)}</dd></div>
        <div><dt>{t('Last updated')}</dt><dd>{t('{age} ago', { age: age(w.changedAt) })}</dd></div>
        <div><dt>{t('Created')}</dt><dd>{t('{age} ago by {name}', { age: age(w.createdAt), name: w.createdBy?.displayName || '' })}</dd></div>
      </dl>

      {editable && <section className="detail-section">
        <h3>{t('Update')}</h3>
        <div className="form-grid">
          <label>{t('State')}
            <select className="input" value={w.state} disabled={busy} onChange={(e) => act({ type: 'update', changes: { state: e.target.value } }, t('Moved to {state}', { state: e.target.value }))}>
              {w.allowedStates.map((s) => <option key={s.name}>{s.name}</option>)}
            </select>
          </label>
          <label>{t('Assigned to')}
            <select className="input" value={w.assignedTo?.uniqueName || ''} disabled={busy} onChange={(e) => act({ type: 'update', changes: { assignedTo: e.target.value } }, t('Assignee updated'))}>
              <option value="">{t('Unassigned')}</option>
              {w.assignedTo && !(people || []).some((p) => p.uniqueName === w.assignedTo.uniqueName) && <option value={w.assignedTo.uniqueName}>{w.assignedTo.displayName}</option>}
              {(people || []).map((p) => <option key={p.id} value={p.uniqueName}>{p.displayName}</option>)}
            </select>
          </label>
          <label>{t('Priority')}
            <select className="input" value={w.priority ?? ''} disabled={busy} onChange={(e) => act({ type: 'update', changes: { priority: e.target.value } }, t('Priority updated'))}>
              {w.priority == null && <option value="">—</option>}
              {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          {!hasBlockedState && <div className="form-grid-action">
            <button type="button" className="btn btn-small" disabled={busy} onClick={toggleBlocked}>{blocked ? t('Remove blocked tag') : t('Mark as blocked')}</button>
          </div>}
        </div>
      </section>}

      {can('prs.write') && w.type !== 'Epic' && w.type !== 'Feature' && <ClaudeStart w={w} />}

      {(w.parent || w.children.length > 0) && (
        <section className="detail-section">
          <h3>{t('Hierarchy')}</h3>
          <ul className="link-list">
            {w.parent && (
              <li>
                <span className="muted small">{t('Parent')}</span>
                <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'workitem', id: w.parent.id })}><span className="mono muted">{w.parent.id}</span> {w.parent.title}</button>
              </li>
            )}
            {w.children.map((c) => (
              <li key={c.id}>
                <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'workitem', id: c.id })}><span className="mono muted">{c.id}</span> {c.title}</button>
                <Chip tone={CATEGORY_TONE[c.stateCategory]}>{c.state}</Chip>
                <span className="muted small">{c.assignedTo?.displayName || t('Unassigned')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {w.pullRequests.length > 0 && (
        <section className="detail-section">
          <h3>{t('Pull requests')}</h3>
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
          <h3>{w.type === 'Bug' ? t('Description / repro steps') : t('Description')}</h3>
          <div className="prose">{w.description}</div>
        </section>
      )}
      {w.acceptanceCriteria && (
        <section className="detail-section">
          <h3>{t('Acceptance criteria')}</h3>
          <div className="prose">{w.acceptanceCriteria}</div>
        </section>
      )}

      <section className="detail-section">
        <h3>{t('Comments')}</h3>
        <ul className="comments">
          {w.comments.map((c, i) => (
            <li key={i}>
              <div className="comment-head"><Avatar person={c.author} size={18} /> <strong>{c.author?.displayName}</strong> <span className="muted small">{dateTime(c.createdAt)}</span></div>
              <div className="prose">{c.text}</div>
            </li>
          ))}
          {!w.comments.length && <li className="muted small">{t('No comments yet.')}</li>}
        </ul>
        {editable && (
        <form className="comment-form" onSubmit={async (e) => { e.preventDefault(); if (await act({ type: 'comment', text: comment }, t('Comment posted'))) setComment(''); }}>
          <textarea className="input" rows={3} placeholder={t('Add a comment')} value={comment} onChange={(e) => setComment(e.target.value)} aria-label={t('Comment')} />
          <button type="submit" className="btn btn-primary btn-small" disabled={!comment.trim() || busy}>{t('Post comment')}</button>
        </form>
        )}
      </section>

      <section className="detail-actions sticky-actions">
        {can('prs.write') && w.type !== 'Epic' && w.type !== 'Feature' && (
          <button type="button" className="btn btn-small" onClick={() => openDrawer({ type: 'newpr', workItemId: w.id })}>{t('Create pull request')}</button>
        )}
        {editable && w.type !== 'Task' && (
          <button type="button" className="btn btn-small" onClick={() => openDrawer({ type: 'newworkitem', projectName: w.projectName, parentId: w.id, parentTitle: w.title, type: CHILD_TYPE[w.type] || 'Task' })}>{t('Add child')}</button>
        )}
        <ExternalLink href={w.webUrl}>{t('Open in Azure DevOps')}</ExternalLink>
      </section>
    </div>
  );
}
