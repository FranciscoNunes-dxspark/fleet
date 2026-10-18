import { useMemo, useState } from 'react';
import { useSticky, useStickyParams } from '../sticky.js';
import { useApi, useApp } from '../context.js';
import { age, REVIEW_STATE } from '../format.js';
import { Avatar, Chip, CodeTabs, Empty, ErrorBox, Loading, PageHeader, Person, Th, Toggle, useSort } from '../ui.jsx';
import { t } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';
import { SavedViews } from '../views.jsx';

export default function PullRequests() {
  const { data, error, reload } = useApi('/prs');
  const { meta, openDrawer, can } = useApp();
  const projectLabel = useProjectLabel();
  const [params, setParams] = useStickyParams('prs', ['author', 'reviewer']);
  const [q, setQ] = useState('');
  const [project, setProject] = useSticky('prs.project', '');
  const [repo, setRepo] = useSticky('prs.repo', '');
  const author = params.get('author') || '';
  const reviewer = params.get('reviewer') || '';
  const [flags, setFlags] = useSticky('prs.flags', { mine: false, myReview: false, conflicts: false, stale: false, hideDrafts: false });
  const staleHours = meta.thresholds.stalePrDays * 24;

  const { sort, setSort, apply } = useSort({ key: 'age', dir: -1 }, {
    title: (p) => p.title.toLowerCase(),
    repo: (p) => `${p.projectName}/${p.repoName}`.toLowerCase(),
    author: (p) => p.author?.displayName?.toLowerCase(),
    age: (p) => p.ageHours,
    approvals: (p) => p.approvals,
  });

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.prs.filter((p) => (!project || p.projectId === project)
      && (!repo || p.repoId === repo)
      && (!author || p.author?.id === author)
      && (!reviewer || p.reviewers.some((r) => r.id === reviewer && r.vote === 0))
      && (!flags.mine || p.isMine)
      && (!flags.myReview || p.needsMyReview)
      && (!flags.conflicts || p.hasConflicts)
      && (!flags.stale || (!p.isDraft && p.ageHours >= staleHours))
      && (!flags.hideDrafts || !p.isDraft)
      && (!needle || `${p.title} ${p.id} ${p.sourceBranch} ${p.repoName} ${p.author?.displayName}`.toLowerCase().includes(needle)));
  }, [data, q, project, repo, author, reviewer, flags, staleHours]);

  if (!data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const projects = [...new Map(data.repos.map((r) => [r.projectId, projectLabel(r.projectName, r.org)])).entries()];
  const repos = data.repos.filter((r) => !project || r.projectId === project);
  const counts = {
    myReview: data.prs.filter((p) => p.needsMyReview).length,
    mine: data.prs.filter((p) => p.isMine).length,
    conflicts: data.prs.filter((p) => p.hasConflicts).length,
    stale: data.prs.filter((p) => !p.isDraft && p.ageHours >= staleHours).length,
  };
  const flag = (k) => (v) => setFlags((f) => ({ ...f, [k]: v }));
  // Saved views and shared links (views.jsx): everything the filters below set.
  const filters = { q, project, repo, author, reviewer, flags };
  const applyFilters = (f) => {
    setQ(f.q || '');
    setProject(f.project || '');
    setRepo(f.repo || '');
    const next = new URLSearchParams(params);
    for (const k of ['author', 'reviewer']) {
      if (f[k]) next.set(k, f[k]);
      else next.delete(k);
    }
    setParams(next, { replace: true });
    setFlags({ mine: false, myReview: false, conflicts: false, stale: false, hideDrafts: false, ...(f.flags || {}) });
  };
  const authorName = data.people.find((p) => p.id === author)?.displayName || data.prs.find((p) => p.author?.id === author)?.author?.displayName;
  const reviewerName = data.people.find((p) => p.id === reviewer)?.displayName;

  return (
    <div className="page page-wide">
      <PageHeader title={t('Pull requests')} sub={t(data.repos.length === 1 ? '{n} active across {repos} repo' : '{n} active across {repos} repos', { n: data.prs.length, repos: data.repos.length })}>
        {can('prs.write') && <button type="button" className="btn btn-primary" onClick={() => openDrawer({ type: 'newpr' })}>{t('New pull request')}</button>}
      </PageHeader>
      <CodeTabs />

      <div className="filters">
        <input type="search" className="input" placeholder={t('Search title, branch, repo, ID')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search pull requests')} />
        <select className="input" value={project} onChange={(e) => { setProject(e.target.value); setRepo(''); }} aria-label={t('Project')}>
          <option value="">{t('All projects')}</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label={t('Repository')}>
          <option value="">{t('All repos')}</option>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select className="input" value={author} onChange={(e) => setParam('author', e.target.value)} aria-label={t('Author')}>
          <option value="">{t('Any author')}</option>
          {data.people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          {author && !data.people.some((p) => p.id === author) && <option value={author}>{authorName || t('Selected author')}</option>}
        </select>
      </div>
      <div className="toggles">
        <Toggle checked={flags.myReview} onChange={flag('myReview')} count={counts.myReview}>{t('Needs my review')}</Toggle>
        <Toggle checked={flags.mine} onChange={flag('mine')} count={counts.mine}>{t('Created by me')}</Toggle>
        <Toggle checked={flags.conflicts} onChange={flag('conflicts')} count={counts.conflicts}>{t('Conflicts')}</Toggle>
        <Toggle checked={flags.stale} onChange={flag('stale')} count={counts.stale}>{t('Older than {n}d', { n: meta.thresholds.stalePrDays })}</Toggle>
        <Toggle checked={flags.hideDrafts} onChange={flag('hideDrafts')}>{t('Hide drafts')}</Toggle>
        {reviewer && <button type="button" className="toggle on" onClick={() => setParam('reviewer', '')}>{reviewerName ? t('Pending review by {name}', { name: reviewerName }) : t('Pending review by someone')} ✕</button>}
      </div>
      <SavedViews page="prs" filters={filters} apply={applyFilters} />

      {!rows.length ? (
        <Empty title={t('No pull requests match.')}>{t('Clear a filter to see more.')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <Th id="title" sort={sort} setSort={setSort}>{t('Pull request')}</Th>
                <Th id="author" sort={sort} setSort={setSort}>{t('Author')}</Th>
                <Th id="age" sort={sort} setSort={setSort} className="num">{t('Age')}</Th>
                <Th id="approvals" sort={sort} setSort={setSort}>{t('Reviewers')}</Th>
                <th>{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {apply(rows).map((p) => (
                <tr key={p.key} className={`clickable ${p.needsMyReview ? 'row-mine' : ''}`} onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id })}>
                  <td className="cell-title">
                    <button type="button" className="row-link" onClick={(e) => { e.stopPropagation(); openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id }); }}>
                      {p.title}
                    </button>
                    <div className="sub">
                      <span>{p.projectName} / {p.repoName}</span>
                      <code className="branch">{p.sourceBranch} → {p.targetBranch}</code>
                      <span className="mono muted">!{p.id}</span>
                    </div>
                  </td>
                  <td><Person person={p.author} /></td>
                  <td className={`num ${!p.isDraft && p.ageHours >= staleHours ? 'text-warn' : ''}`}>{age(p.createdAt)}</td>
                  <td>
                    <div className="avatars">
                      {p.reviewers.length ? p.reviewers.map((r) => <Avatar key={r.id} person={r} vote={r.vote} />) : <span className="text-bad small">{t('None')}</span>}
                    </div>
                  </td>
                  <td>
                    <div className="chips">
                      <Chip tone={REVIEW_STATE[p.reviewState].tone}>{REVIEW_STATE[p.reviewState].label}</Chip>
                      {p.needsMyReview && <Chip tone="accent">{t('Your review')}</Chip>}
                      {p.hasConflicts && <Chip tone="bad">{t('Conflicts')}</Chip>}
                      {p.autoComplete && <Chip tone="ok">{t('Auto-complete')}</Chip>}
                      {p.labels.map((l) => <Chip key={l}>{l}</Chip>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
