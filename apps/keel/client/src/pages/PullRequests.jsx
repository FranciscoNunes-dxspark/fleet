import { useMemo, useState } from 'react';
import { useSticky, useStickyParams } from '../sticky.js';
import { useApi, useApp } from '../context.js';
import { age, dateTime, dateTimeZone, REVIEW_STATE } from '../format.js';
import { Avatar, Chip, CodeTabs, Empty, ErrorBox, Loading, PageHeader, Person, Th, Toggle, useSort } from '../ui.jsx';
import { t } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';
import { SavedViews } from '../views.jsx';

const DAYS = [7, 30, 90];
const OUTCOME = { completed: { tone: 'ok', label: 'Completed' }, abandoned: { tone: 'muted', label: 'Abandoned' } };

export default function PullRequests() {
  const { meta, openDrawer, can } = useApp();
  const projectLabel = useProjectLabel();
  const [params, setParams] = useStickyParams('prs', ['author', 'reviewer', 'state', 'days']);
  // Active pull requests, or the history: those completed or abandoned in the last 7, 30 or 90 days.
  const closed = params.get('state') === 'closed';
  const days = DAYS.includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
  const active = useApi(closed ? null : '/prs');
  const history = useApi(closed ? `/prs/closed?days=${days}` : null);
  const current = closed ? history : active;
  // While another period loads, its list isn't shown under the new period's name.
  const data = closed && current.data?.days !== days ? null : current.data;
  const { error, reload } = current;
  const [q, setQ] = useState('');
  const [project, setProject] = useSticky('prs.project', '');
  const [repo, setRepo] = useSticky('prs.repo', '');
  const author = params.get('author') || '';
  const reviewer = params.get('reviewer') || '';
  const [flags, setFlags] = useSticky('prs.flags', { mine: false, myReview: false, conflicts: false, stale: false, hideDrafts: false });
  const [outcome, setOutcome] = useSticky('prs.outcome', '');
  const staleHours = meta.thresholds.stalePrDays * 24;

  const getters = {
    title: (p) => p.title.toLowerCase(),
    repo: (p) => `${p.projectName}/${p.repoName}`.toLowerCase(),
    author: (p) => p.author?.displayName?.toLowerCase(),
    age: (p) => p.ageHours,
    approvals: (p) => p.approvals,
  };
  const activeSort = useSort({ key: 'age', dir: -1 }, getters);
  // Newest first; the open time is how long it was in review.
  const closedSort = useSort({ key: 'closed', dir: -1 }, { ...getters, closed: (p) => Date.parse(p.closedAt), open: (p) => Date.parse(p.closedAt) - Date.parse(p.createdAt) });
  const { sort, setSort, apply } = closed ? closedSort : activeSort;

  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    next.delete('f'); // a shared link's filters were applied when it opened (views.jsx)
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
      && (!flags.mine || p.isMine)
      && (closed
        ? !outcome || p.status === outcome
        : (!reviewer || p.reviewers.some((r) => r.id === reviewer && r.vote === 0))
          && (!flags.myReview || p.needsMyReview)
          && (!flags.conflicts || p.hasConflicts)
          && (!flags.stale || (!p.isDraft && p.ageHours >= staleHours))
          && (!flags.hideDrafts || !p.isDraft))
      && (!needle || `${p.title} ${p.id} ${p.sourceBranch} ${p.targetBranch} ${p.repoName} ${p.author?.displayName}`.toLowerCase().includes(needle)));
  }, [data, closed, q, project, repo, author, reviewer, flags, outcome, staleHours]);

  const setState = (next) => {
    const p = new URLSearchParams(params);
    p.delete('f');
    if (next === 'closed') p.set('state', 'closed');
    else p.delete('state');
    setParams(p, { replace: true });
  };
  const viewTabs = (
    <div className="segmented segmented-compact" role="tablist" aria-label={t('Which pull requests')}>
      <button type="button" role="tab" aria-selected={!closed} className={closed ? '' : 'on'} onClick={() => setState('active')}>{t('Active')}</button>
      <button type="button" role="tab" aria-selected={closed} className={closed ? 'on' : ''} onClick={() => setState('closed')}>{t('Closed')}</button>
    </div>
  );

  if (!data) {
    return (
      <div className="page page-wide">
        <PageHeader title={t('Pull requests')} />
        <CodeTabs />
        <div className="filters">{viewTabs}</div>
        {error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />}
      </div>
    );
  }

  const projects = [...new Map(data.repos.map((r) => [r.projectId, projectLabel(r.projectName, r.org)])).entries()];
  const repos = data.repos.filter((r) => !project || r.projectId === project);
  const counts = {
    completed: data.prs.filter((p) => p.status === 'completed').length,
    abandoned: data.prs.filter((p) => p.status === 'abandoned').length,
    myReview: data.prs.filter((p) => p.needsMyReview).length,
    mine: data.prs.filter((p) => p.isMine).length,
    conflicts: data.prs.filter((p) => p.hasConflicts).length,
    stale: data.prs.filter((p) => !p.isDraft && p.ageHours >= staleHours).length,
  };
  const flag = (k) => (v) => setFlags((f) => ({ ...f, [k]: v }));
  // Saved views and shared links (views.jsx): everything the filters below set.
  const filters = closed ? { state: 'closed', days, q, project, repo, author, flags: { mine: flags.mine }, outcome } : { q, project, repo, author, reviewer, flags };
  const applyFilters = (f) => {
    setQ(f.q || '');
    setProject(f.project || '');
    setRepo(f.repo || '');
    setOutcome(f.outcome || '');
    const next = new URLSearchParams(params);
    next.delete('f');
    for (const k of ['author', 'reviewer', 'state', 'days']) {
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
      <PageHeader
        title={t('Pull requests')}
        sub={closed
          ? t(data.repos.length === 1 ? '{n} closed in the last {days} days across {repos} repo' : '{n} closed in the last {days} days across {repos} repos', { n: data.prs.length, days, repos: data.repos.length })
          : t(data.repos.length === 1 ? '{n} active across {repos} repo' : '{n} active across {repos} repos', { n: data.prs.length, repos: data.repos.length })}
      >
        {can('prs.write') && <button type="button" className="btn btn-primary" onClick={() => openDrawer({ type: 'newpr' })}>{t('New pull request')}</button>}
      </PageHeader>
      <CodeTabs />

      <div className="filters">
        {viewTabs}
        {closed && (
          <select className="input" value={days} onChange={(e) => setParam('days', e.target.value === '30' ? '' : e.target.value)} aria-label={t('Closed in the last')}>
            {DAYS.map((d) => <option key={d} value={d}>{t('Closed in the last {n} days', { n: d })}</option>)}
          </select>
        )}
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
      {closed ? (
        <div className="toggles">
          <Toggle checked={outcome === 'completed'} onChange={(v) => setOutcome(v ? 'completed' : '')} count={counts.completed}>{t('Completed')}</Toggle>
          <Toggle checked={outcome === 'abandoned'} onChange={(v) => setOutcome(v ? 'abandoned' : '')} count={counts.abandoned}>{t('Abandoned')}</Toggle>
          <Toggle checked={flags.mine} onChange={flag('mine')} count={counts.mine}>{t('Created by me')}</Toggle>
        </div>
      ) : (
        <div className="toggles">
          <Toggle checked={flags.myReview} onChange={flag('myReview')} count={counts.myReview}>{t('Needs my review')}</Toggle>
          <Toggle checked={flags.mine} onChange={flag('mine')} count={counts.mine}>{t('Created by me')}</Toggle>
          <Toggle checked={flags.conflicts} onChange={flag('conflicts')} count={counts.conflicts}>{t('Conflicts')}</Toggle>
          <Toggle checked={flags.stale} onChange={flag('stale')} count={counts.stale}>{t('Older than {n}d', { n: meta.thresholds.stalePrDays })}</Toggle>
          <Toggle checked={flags.hideDrafts} onChange={flag('hideDrafts')}>{t('Hide drafts')}</Toggle>
          {reviewer && <button type="button" className="toggle on" onClick={() => setParam('reviewer', '')}>{reviewerName ? t('Pending review by {name}', { name: reviewerName }) : t('Pending review by someone')} ✕</button>}
        </div>
      )}
      <SavedViews page="prs" filters={filters} apply={applyFilters} />

      {!rows.length ? (
        <Empty title={t('No pull requests match.')}>{closed && !data.prs.length ? t('None were completed or abandoned in this period.') : t('Clear a filter to see more.')}</Empty>
      ) : closed ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <Th id="title" sort={sort} setSort={setSort}>{t('Pull request')}</Th>
                <Th id="author" sort={sort} setSort={setSort}>{t('Author')}</Th>
                <Th id="closed" sort={sort} setSort={setSort}>{t('Closed')}</Th>
                <Th id="open" sort={sort} setSort={setSort} className="num">{t('Open for')}</Th>
                <th>{t('Reviewers')}</th>
                <th>{t('Outcome')}</th>
              </tr>
            </thead>
            <tbody>
              {apply(rows).map((p) => (
                <tr key={p.key} className="clickable" onClick={() => openDrawer({ type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id })}>
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
                  <td>
                    <span title={dateTime(p.closedAt)}>{t('{age} ago', { age: age(p.closedAt) })}</span>
                    {p.closedBy && <div className="small muted">{t('by {name}', { name: p.closedBy.displayName })}</div>}
                  </td>
                  <td className="num">{age(p.createdAt, Date.parse(p.closedAt))}</td>
                  <td>
                    <div className="avatars">
                      {p.reviewers.length ? p.reviewers.map((r) => <Avatar key={r.id} person={r} vote={r.vote} />) : <span className="muted small">{t('None')}</span>}
                    </div>
                  </td>
                  <td>
                    <div className="chips">
                      <Chip tone={OUTCOME[p.status]?.tone || 'muted'}>{t(OUTCOME[p.status]?.label || p.status)}</Chip>
                      {p.labels.map((l) => <Chip key={l}>{l}</Chip>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
                      {/* On GitHub: held while its checks run, or after they fail (domain/prs.js prFlow). */}
                      {p.checks === 'running' && <Chip tone="warn">{t('Checks running')}</Chip>}
                      {p.checks === 'failed' && <Chip tone="bad">{t('Checks failed')}</Chip>}
                      {p.autoComplete && <Chip tone="ok">{t('Auto-complete')}</Chip>}
                      {p.completesAt && <Chip tone="info" title={dateTimeZone(p.completesAt)}>{t('Completes {when}', { when: dateTime(p.completesAt) })}</Chip>}
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
