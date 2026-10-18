import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { age } from '../format.js';
import { Markdown } from '../markdown.jsx';
import { Avatar, Chip, ErrorBox, Loading } from '../ui.jsx';
import { Icon } from '../icons.jsx';
import { CATEGORY_TONE } from './WorkItems.jsx';
import { t, tj } from '../i18n.js';
import { wiPath } from '../orgs.js';

const MAX_DESCRIPTION = 4000;
const repoKey = (r) => `${r.projectId}|${r.id}`;

const COMMITS_IN_DRAFT = 20;

/**
 * The repo's PR template, or a short summary skeleton listing (at most 20) commits.
 * Kept in English on purpose: it becomes the PR description in Azure DevOps, read by the whole team.
 */
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
  const [suggested, setSuggested] = useState(null);
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
    api(wiPath(preset.workItemId, preset.org))
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

  // Reviewers to suggest: who recently worked in the folders this change touches (see server/domain/reviewers.js).
  useEffect(() => {
    setSuggested(null);
    if (!current || !compare?.files?.items?.length) return undefined;
    let live = true; // a slower answer for an earlier branch pair must not win
    api(`/repos/${encodeURIComponent(current.projectId)}/${encodeURIComponent(current.id)}/reviewers`, {
      method: 'POST',
      body: { paths: compare.files.items.map((f) => f.path), target },
    }).then((r) => live && setSuggested(r.suggestions)).catch(() => live && setSuggested([]));
    return () => { live = false; };
  }, [compare]); // eslint-disable-line react-hooks/exhaustive-deps

  if (reposError) return <ErrorBox error={reposError} />;
  if (!repos) return <Loading />;
  if (!repoList.length) return <p className="muted">{t('Track at least one repository in Settings to create pull requests.')}</p>;

  const addWorkItem = async (e) => {
    e.preventDefault();
    const id = Number(wiInput.replace(/\D/g, ''));
    if (!id) return;
    try {
      const w = await api(wiPath(id, current?.org));
      setWorkItems((list) => (list.some((x) => x.id === w.id) ? list : [...list, pickWi(w)]));
      setWiInput('');
    } catch {
      toast(t("Work item {id} wasn't found", { id }), 'bad');
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
      toast(t('Created pull request !{id}', { id: pr.id }));
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
        <optgroup label={t('Recently pushed')}>
          {recent.map((b) => <option key={b.name} value={b.name} disabled={b.name === exclude}>{t('{name} · {age} ago', { name: b.name, age: age(b.pushedAt) })}</option>)}
        </optgroup>
      )}
      <optgroup label={recent.length ? t('Other branches') : t('Branches')}>
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
      <div className="detail-kicker">{t('New pull request')}</div>
      <h2 className="detail-title">{title || t('Untitled pull request')}</h2>

      <section className="detail-section">
        <div className="form-grid form-grid-wide">
          <label>{t('Repository')}
            <select className="input" value={repo} onChange={(e) => { setRepo(e.target.value); setTitleTouched(false); setDescTouched(false); }}>
              {[...new Set(repoList.map((r) => r.projectName))].map((p) => (
                <optgroup key={p} label={p}>
                  {repoList.filter((r) => r.projectName === p).map((r) => <option key={r.id} value={repoKey(r)}>{r.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        {!branches ? <Loading label={t('Loading branches…')} /> : (
          <div className="branch-pick">
            <label>{t('From')}
              <select className="input mono" value={source} onChange={(e) => setSource(e.target.value)} aria-label={t('Source branch')}>
                {branchOptions(target)}
              </select>
            </label>
            <button
              type="button"
              className="branch-swap"
              onClick={() => { setSource(target); setTarget(source); }}
              disabled={!source || !target}
              title={t('Swap: merge {target} into {source}', { source, target })}
              aria-label={t('Swap source and target branches')}
            >
              <Icon name="swap" size={16} />
            </button>
            <label>{t('Into')}
              <select className="input mono" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('Target branch')}>
                {branchOptions(source)}
              </select>
            </label>
          </div>
        )}
        {comparing && <Loading label={t('Comparing branches…')} />}
        <ErrorBox error={compareError} />
        {compare && !comparing && (
          <div className="compare-summary small">
            <span>{tj(compare.ahead === 1 ? '{n} commit to merge' : '{n} commits to merge', { n: <strong>{compare.ahead}</strong> })}</span>
            <span>{tj(compare.files.total === 1 ? '{n} file changed' : '{n} files changed', { n: <strong>{compare.files.total}</strong> })}</span>
            {compare.behind > 0 && <span className="text-warn">{t(compare.behind === 1 ? '{n} commit behind {branch}: consider updating the branch' : '{n} commits behind {branch}: consider updating the branch', { n: compare.behind, branch: target })}</span>}
            {compare.ahead === 0 && <span className="text-warn">{t("Nothing to merge: {source} has no commits that {target} doesn't", { source, target })}</span>}
          </div>
        )}
        {existing.map((p) => (
          <p key={p.id} className="callout small">
            {tj('A pull request for these branches is already open: {link}', {
              link: <button type="button" className="link-btn" onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id })}>!{p.id} {p.title}</button>,
            })}
          </p>
        ))}
        {compare && compare.commits.length > 0 && (
          <details className="commit-list">
            <summary className="small">{compare.ahead > compare.commits.length ? t('Commits ({n} of {total})', { n: compare.commits.length, total: compare.ahead }) : t('Commits ({n})', { n: compare.commits.length })}</summary>
            <ul>
              {compare.commits.map((c) => (
                <li key={c.id} className="small">
                  <code className="muted">{c.id.slice(0, 7)}</code> {c.message.split('\n')[0]} <span className="muted">{t('· {author} · {age} ago', { author: c.author, age: age(c.date) })}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="detail-section">
        <label className="field">{t('Title')}
          <input className="input" value={title} maxLength={400} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} required />
        </label>
        <div className="field">
          <div className="field-head">
            <span>{t('Description')} {compare?.template && !descTouched && <span className="muted small">{t("from the repo's PR template")}</span>}</span>
            <span className="segmented segmented-compact" role="tablist" aria-label={t('Description view')}>
              <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>{t('Write')}</button>
              <button type="button" role="tab" aria-selected={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>{t('Preview')}</button>
            </span>
          </div>
          {preview
            ? <div className="md-preview"><Markdown text={description || t('_Nothing to preview._')} people={people || []} /></div>
            : <textarea className="input" rows={10} value={description} onChange={(e) => { setDescription(e.target.value); setDescTouched(true); }} aria-label={t('Description (Markdown)')} />}
          <span className={`small ${tooLong ? 'text-bad' : 'muted'}`}>{t('{count} / {max} characters · Markdown', { count: description.length.toLocaleString(), max: MAX_DESCRIPTION.toLocaleString() })}</span>
        </div>
      </section>

      <section className="detail-section">
        <h3>{t('Work items')}</h3>
        <ul className="link-list">
          {workItems.map((w) => (
            <li key={w.id}>
              <span className="mono muted">{w.id}</span> <span>{w.title}</span>
              <Chip tone={CATEGORY_TONE[w.stateCategory] || 'muted'}>{w.state}</Chip>
              {w.suggested && <span className="muted small">{t('suggested from branch or commits')}</span>}
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setWorkItems((l) => l.filter((x) => x.id !== w.id))} aria-label={t('Unlink {id}', { id: w.id })}>{t('Remove')}</button>
            </li>
          ))}
          {!workItems.length && <li className="muted small">{t('None linked. Many branch policies require at least one.')}</li>}
        </ul>
        <div className="inline-form">
          <input className="input" inputMode="numeric" placeholder={t('Work item ID')} value={wiInput} onChange={(e) => setWiInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addWorkItem(e)} aria-label={t('Work item ID to link')} />
          <button type="button" className="btn btn-small" onClick={addWorkItem} disabled={!wiInput.trim()}>{t('Link')}</button>
        </div>
      </section>

      <section className="detail-section">
        <h3>{t('Reviewers')} <span className="muted small">{t('branch policies may add more automatically')}</span></h3>
        <ul className="reviewer-list">
          {reviewers.map((r) => (
            <li key={r.id}>
              <Avatar person={r} size={22} />
              <span className="truncate">{r.displayName}</span>
              <label className="check small"><input type="checkbox" checked={r.isRequired} onChange={(e) => setReviewers((l) => l.map((x) => (x.id === r.id ? { ...x, isRequired: e.target.checked } : x)))} /> {t('Required')}</label>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setReviewers((l) => l.filter((x) => x.id !== r.id))}>{t('Remove')}</button>
            </li>
          ))}
        </ul>
        <SuggestedReviewers suggestions={(suggested || []).filter((x) => !reviewers.some((r) => r.id === x.person.id))} onAdd={(p) => setReviewers((l) => [...l, { ...p, isRequired: false }])} />
        {candidates.length > 0 && (
          <select className="input" value="" onChange={(e) => { const p = candidates.find((c) => c.id === e.target.value); if (p) setReviewers((l) => [...l, { ...p, isRequired: false }]); }} aria-label={t('Add a reviewer')}>
            <option value="">{t('Add a reviewer…')}</option>
            {candidates.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        )}
      </section>

      <section className="detail-section">
        <label className="check"><input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} /> {t('Create as draft')} <span className="muted small">{t("(reviewers aren't notified until you publish)")}</span></label>
        <label className="check"><input type="checkbox" checked={autoComplete && !isDraft} disabled={isDraft} onChange={(e) => setAutoComplete(e.target.checked)} /> {t('Set auto-complete')} <span className="muted small">{t('(completes when policies pass, using your Settings defaults)')}</span></label>
      </section>

      <ErrorBox error={submitError} />
      <section className="detail-actions sticky-actions">
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>{busy ? t('Creating…') : isDraft ? t('Create draft pull request') : t('Create pull request')}</button>
        {existing.length > 0 && <span className="small muted">{t('A pull request for these branches already exists.')}</span>}
        {tooLong && <span className="small text-bad">{t('Shorten the description to 4,000 characters to create the pull request.')}</span>}
        {!title.trim() && <span className="small muted">{t('Add a title to create the pull request.')}</span>}
      </section>
    </form>
  );
}

const pickWi = ({ id, title, type, state, stateCategory }) => ({ id, title, type, state, stateCategory });

/**
 * People who know the code this change touches, with why: how many of its
 * files are in folders they committed to recently, and the reviews they owe.
 * Shared with the pull request panel (PrDetail.jsx).
 */
export function SuggestedReviewers({ suggestions, onAdd, busy = false }) {
  if (!suggestions?.length) return null;
  return (
    <div className="suggested-reviewers">
      <div className="small muted">{t('Suggested: they changed these folders recently')}</div>
      <ul className="reviewer-list">
        {suggestions.map((x) => (
          <li key={x.person.id}>
            <Avatar person={x.person} size={22} />
            <span className="suggested-who">
              <span className="truncate">{x.person.displayName}</span>
              <span className="small muted truncate" title={x.folders.join('\n')}>
                {t(x.commits === 1 ? '{n} commit in {folders}' : '{n} commits in {folders}', { n: x.commits, folders: x.folders.length === 1 ? x.folders[0] : t('{n} of these folders', { n: x.folders.length }) })}
                {x.lastAt ? ` · ${t('last {age} ago', { age: age(x.lastAt) })}` : ''}
                {' · '}<span className={x.overloaded ? 'text-warn' : ''}>{t(x.reviewsOwed === 1 ? '{n} review owed' : '{n} reviews owed', { n: x.reviewsOwed })}</span>
              </span>
            </span>
            <button type="button" className="btn btn-small" onClick={() => onAdd(x.person)} disabled={busy}>{t('Add')}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
