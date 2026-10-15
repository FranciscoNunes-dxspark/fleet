import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age } from '../format.js';
import { Markdown } from '../markdown.jsx';
import { Avatar, Chip, ErrorBox, Loading } from '../ui.jsx';
import { CATEGORY_TONE } from './WorkItems.jsx';

const MAX_DESCRIPTION = 4000;
const repoKey = (r) => `${r.projectId}|${r.id}`;

const COMMITS_IN_DRAFT = 20;

/** The repo's PR template, or a short summary skeleton listing (at most 20) commits. */
function draftDescription(compare) {
  if (compare.template) return compare.template.slice(0, MAX_DESCRIPTION);
  const subjects = compare.commits.map((c) => c.message.split('\n')[0].trim().slice(0, 120)).filter(Boolean);
  const more = Math.max(compare.ahead, subjects.length) - COMMITS_IN_DRAFT;
  const lines = ['## Summary', '', ''];
  if (subjects.length > 1) {
    lines.push('## Commits', '', ...subjects.slice(0, COMMITS_IN_DRAFT).map((s) => `- ${s}`));
    if (more > 0) lines.push(`- …and ${more} more`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Create a pull request: pick repo and branches, review what's in it, then
 * title, description, work items, reviewers, draft and auto-complete.
 */
export default function NewPr({ preset = {} }) {
  const { data: repos, error: reposError } = useApi('/repos');
  const { data: people } = useApi('/people');
  const { openDrawer, refresh, toast, meta } = useApp();

  const [repo, setRepo] = useState('');
  const [branches, setBranches] = useState(null);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [compare, setCompare] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState(null);

  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [descTouched, setDescTouched] = useState(false);
  const [preview, setPreview] = useState(false);
  const [workItems, setWorkItems] = useState([]);
  const [wiInput, setWiInput] = useState('');
  const [reviewers, setReviewers] = useState([]);
  const [isDraft, setIsDraft] = useState(false);
  const [autoComplete, setAutoComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const compareSeq = useRef(0);

  const repoList = useMemo(() => [...(repos || [])].sort((a, b) => a.projectName.localeCompare(b.projectName) || a.name.localeCompare(b.name)), [repos]);
  const current = repoList.find((r) => repoKey(r) === repo);

  // Default repo: the preset one, else the first tracked repo.
  useEffect(() => {
    if (repo || !repoList.length) return;
    const pre = repoList.find((r) => r.id === preset.repoId);
    setRepo(repoKey(pre || repoList[0]));
  }, [repoList, repo, preset.repoId]);

  // A work item you started from is linked up front.
  useEffect(() => {
    if (!preset.workItemId) return;
    api(`/workitems/${preset.workItemId}`)
      .then((w) => setWorkItems((list) => (list.some((x) => x.id === w.id) ? list : [...list, pickWi(w)])))
      .catch(() => {});
  }, [preset.workItemId]);

  // Load branches when the repo changes; default target is the repo's default branch.
  useEffect(() => {
    if (!current) return;
    setBranches(null);
    setCompare(null);
    api(`/repos/${encodeURIComponent(current.projectId)}/${encodeURIComponent(current.id)}/branches`)
      .then((list) => {
        setBranches(list);
        const tgt = current.defaultBranch && list.some((b) => b.name === current.defaultBranch) ? current.defaultBranch : list[0]?.name || '';
        setTarget(tgt);
        // Source: a branch named after the preset work item, else the most recent push that isn't the target.
        const byItem = preset.workItemId && list.find((b) => b.name.includes(String(preset.workItemId)));
        setSource((byItem || list.find((b) => b.name !== tgt && b.pushedAt) || list.find((b) => b.name !== tgt))?.name || '');
      })
      .catch((e) => {
        setBranches([]);
        setCompareError(e);
      });
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compare whenever the branch pair changes.
  useEffect(() => {
    if (!current || !source || !target) return;
    const mine = ++compareSeq.current;
    setComparing(true);
    setCompareError(null);
    const qs = new URLSearchParams({ source, target }).toString();
    api(`/repos/${encodeURIComponent(current.projectId)}/${encodeURIComponent(current.id)}/compare?${qs}`)
      .then((c) => {
        if (mine !== compareSeq.current) return;
        setCompare(c);
        if (!titleTouched) setTitle(c.suggestedTitle || '');
        if (!descTouched) setDescription(draftDescription(c));
        setWorkItems((list) => [...list, ...c.suggestedWorkItems.filter((w) => !list.some((x) => x.id === w.id)).map((w) => ({ ...w, suggested: true }))]);
      })
      .catch((e) => mine === compareSeq.current && setCompareError(e))
      .finally(() => mine === compareSeq.current && setComparing(false));
  }, [current?.id, source, target]); // eslint-disable-line react-hooks/exhaustive-deps

  if (reposError) return <ErrorBox error={reposError} />;
  if (!repos) return <Loading />;
  if (!repoList.length) return <p className="muted">Track at least one repository in Settings to create pull requests.</p>;

  const addWorkItem = async (e) => {
    e.preventDefault();
    const id = Number(wiInput.replace(/\D/g, ''));
    if (!id) return;
    try {
      const w = await api(`/workitems/${id}`);
      setWorkItems((list) => (list.some((x) => x.id === w.id) ? list : [...list, pickWi(w)]));
      setWiInput('');
    } catch {
      toast(`Work item ${id} wasn't found`, 'bad');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setSubmitError(null);
    try {
      const pr = await api('/prs', {
        method: 'POST',
        body: {
          projectId: current.projectId,
          repoId: current.id,
          source,
          target,
          title,
          description,
          isDraft,
          autoComplete: autoComplete && !isDraft,
          reviewers: reviewers.map(({ id, isRequired }) => ({ id, isRequired })),
          workItemIds: workItems.map((w) => w.id),
        },
      });
      toast(`Created pull request !${pr.id}`);
      refresh();
      openDrawer({ type: 'pr', projectId: pr.projectId, repoId: pr.repoId, id: pr.id });
    } catch (err) {
      setSubmitError(err);
    } finally {
      setBusy(false);
    }
  };

  const recent = (branches || []).filter((b) => b.pushedAt);
  const others = (branches || []).filter((b) => !b.pushedAt);
  const branchOptions = (exclude) => (
    <>
      {recent.length > 0 && (
        <optgroup label="Recently pushed">
          {recent.map((b) => <option key={b.name} value={b.name} disabled={b.name === exclude}>{b.name} · {age(b.pushedAt)} ago</option>)}
        </optgroup>
      )}
      <optgroup label={recent.length ? 'Other branches' : 'Branches'}>
        {others.map((b) => <option key={b.name} value={b.name} disabled={b.name === exclude}>{b.name}</option>)}
      </optgroup>
    </>
  );
  const candidates = (people || []).filter((p) => p.id !== meta.me.id && !reviewers.some((r) => r.id === p.id));
  const existing = compare?.existing || [];
  const tooLong = description.length > MAX_DESCRIPTION;
  const canSubmit = !busy && !comparing && source && target && source !== target && title.trim() && !tooLong && !existing.length;

  return (
    // Enter in a text field shouldn't create the pull request by accident.
    <form className="detail new-pr" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); }}>
      <div className="detail-kicker">New pull request</div>
      <h2 className="detail-title">{title || 'Untitled pull request'}</h2>

      <section className="detail-section">
        <div className="form-grid form-grid-wide">
          <label>Repository
            <select className="input" value={repo} onChange={(e) => { setRepo(e.target.value); setTitleTouched(false); setDescTouched(false); }}>
              {[...new Set(repoList.map((r) => r.projectName))].map((p) => (
                <optgroup key={p} label={p}>
                  {repoList.filter((r) => r.projectName === p).map((r) => <option key={r.id} value={repoKey(r)}>{r.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        {!branches ? <Loading label="Loading branches…" /> : (
          <div className="branch-pick">
            <label>From
              <select className="input mono" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source branch">
                {branchOptions(target)}
              </select>
            </label>
            <span className="branch-arrow" aria-hidden="true">→</span>
            <label>Into
              <select className="input mono" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target branch">
                {branchOptions(source)}
              </select>
            </label>
          </div>
        )}
        {comparing && <Loading label="Comparing branches…" />}
        <ErrorBox error={compareError} />
        {compare && !comparing && (
          <div className="compare-summary small">
            <span><strong>{compare.ahead}</strong> commit{compare.ahead === 1 ? '' : 's'} to merge</span>
            <span><strong>{compare.files.total}</strong> file{compare.files.total === 1 ? '' : 's'} changed</span>
            {compare.behind > 0 && <span className="text-warn">{compare.behind} commit{compare.behind === 1 ? '' : 's'} behind {target}: consider updating the branch</span>}
            {compare.ahead === 0 && <span className="text-warn">Nothing to merge: {source} has no commits that {target} doesn't</span>}
          </div>
        )}
        {existing.map((p) => (
          <p key={p.id} className="callout small">
            A pull request for these branches is already open: <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id })}>!{p.id} {p.title}</button>
          </p>
        ))}
        {compare && compare.commits.length > 0 && (
          <details className="commit-list">
            <summary className="small">Commits ({compare.commits.length}{compare.ahead > compare.commits.length ? ` of ${compare.ahead}` : ''})</summary>
            <ul>
              {compare.commits.map((c) => (
                <li key={c.id} className="small">
                  <code className="muted">{c.id.slice(0, 7)}</code> {c.message.split('\n')[0]} <span className="muted">· {c.author} · {age(c.date)} ago</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="detail-section">
        <label className="field">Title
          <input className="input" value={title} maxLength={400} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} required />
        </label>
        <div className="field">
          <div className="field-head">
            <span>Description {compare?.template && !descTouched && <span className="muted small">from the repo's PR template</span>}</span>
            <span className="segmented segmented-compact" role="tablist" aria-label="Description view">
              <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Write</button>
              <button type="button" role="tab" aria-selected={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Preview</button>
            </span>
          </div>
          {preview
            ? <div className="md-preview"><Markdown text={description || '_Nothing to preview._'} people={people || []} /></div>
            : <textarea className="input" rows={10} value={description} onChange={(e) => { setDescription(e.target.value); setDescTouched(true); }} aria-label="Description (Markdown)" />}
          <span className={`small ${tooLong ? 'text-bad' : 'muted'}`}>{description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()} characters · Markdown</span>
        </div>
      </section>

      <section className="detail-section">
        <h3>Work items</h3>
        <ul className="link-list">
          {workItems.map((w) => (
            <li key={w.id}>
              <span className="mono muted">{w.id}</span> <span>{w.title}</span>
              <Chip tone={CATEGORY_TONE[w.stateCategory] || 'muted'}>{w.state}</Chip>
              {w.suggested && <span className="muted small">suggested from branch or commits</span>}
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setWorkItems((l) => l.filter((x) => x.id !== w.id))} aria-label={`Unlink ${w.id}`}>Remove</button>
            </li>
          ))}
          {!workItems.length && <li className="muted small">None linked. Many branch policies require at least one.</li>}
        </ul>
        <div className="inline-form">
          <input className="input" inputMode="numeric" placeholder="Work item ID" value={wiInput} onChange={(e) => setWiInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addWorkItem(e)} aria-label="Work item ID to link" />
          <button type="button" className="btn btn-small" onClick={addWorkItem} disabled={!wiInput.trim()}>Link</button>
        </div>
      </section>

      <section className="detail-section">
        <h3>Reviewers <span className="muted small">branch policies may add more automatically</span></h3>
        <ul className="reviewer-list">
          {reviewers.map((r) => (
            <li key={r.id}>
              <Avatar person={r} size={22} />
              <span className="truncate">{r.displayName}</span>
              <label className="check small"><input type="checkbox" checked={r.isRequired} onChange={(e) => setReviewers((l) => l.map((x) => (x.id === r.id ? { ...x, isRequired: e.target.checked } : x)))} /> Required</label>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setReviewers((l) => l.filter((x) => x.id !== r.id))}>Remove</button>
            </li>
          ))}
        </ul>
        {candidates.length > 0 && (
          <select className="input" value="" onChange={(e) => { const p = candidates.find((c) => c.id === e.target.value); if (p) setReviewers((l) => [...l, { ...p, isRequired: false }]); }} aria-label="Add a reviewer">
            <option value="">Add a reviewer…</option>
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        )}
      </section>

      <section className="detail-section">
        <label className="check"><input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} /> Create as draft <span className="muted small">(reviewers aren't notified until you publish)</span></label>
        <label className="check"><input type="checkbox" checked={autoComplete && !isDraft} disabled={isDraft} onChange={(e) => setAutoComplete(e.target.checked)} /> Set auto-complete <span className="muted small">(completes when policies pass, using your Settings defaults)</span></label>
      </section>

      <ErrorBox error={submitError} />
      <section className="detail-actions sticky-actions">
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{busy ? 'Creating…' : isDraft ? 'Create draft pull request' : 'Create pull request'}</button>
        {existing.length > 0 && <span className="small muted">A pull request for these branches already exists.</span>}
        {tooLong && <span className="small text-bad">Shorten the description to 4,000 characters to create the pull request.</span>}
        {!title.trim() && <span className="small muted">Add a title to create the pull request.</span>}
      </section>
    </form>
  );
}

const pickWi = ({ id, title, type, state, stateCategory }) => ({ id, title, type, state, stateCategory });
