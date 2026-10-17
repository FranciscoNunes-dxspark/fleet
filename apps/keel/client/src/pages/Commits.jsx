import { useMemo, useState } from 'react';
import { useSticky } from '../sticky.js';
import { useApi, useApp } from '../context.js';
import { dateTime } from '../format.js';
import { Empty, ErrorBox, Loading, PageHeader, Person } from '../ui.jsx';
import { locale, t } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';

const PERIODS = [1, 7, 14, 30, 90];
const SHOW_MAX = 500;
const enc = encodeURIComponent;

/** "Today", "Yesterday" or "Monday, 12 Oct". */
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t('Today');
  if (d.toDateString() === yesterday.toDateString()) return t('Yesterday');
  return d.toLocaleDateString(locale(), { weekday: 'long', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

// Git authors are a name and an email, not Azure DevOps accounts; Person only needs a name.
const authorOf = (c) => ({ displayName: c.author?.name || c.author?.email || '?', uniqueName: c.author?.email || '' });

/**
 * Commit history: the default branch of every tracked repo, newest first and
 * grouped by day, or one repo on any branch. Commits link to the work items
 * and pull requests their messages mention.
 */
export default function Commits() {
  const { openDrawer } = useApp();
  const projectLabel = useProjectLabel();
  const { data: repoList } = useApi('/repos');
  const [project, setProject] = useSticky('commits.project', '');
  const [repo, setRepo] = useSticky('commits.repo', '');
  const [branch, setBranch] = useSticky('commits.branch', '');
  const [days, setDays] = useSticky('commits.days', 14);
  const [author, setAuthor] = useSticky('commits.author', '');
  const [q, setQ] = useState('');

  const chosen = repoList?.find((r) => r.id === repo) || null;
  const { data: branches } = useApi(chosen ? `/repos/${enc(chosen.projectId)}/${enc(chosen.id)}/branches` : null);
  const path = chosen
    ? `/commits?days=${days}&project=${enc(chosen.projectId)}&repo=${enc(chosen.id)}${branch ? `&branch=${enc(branch)}` : ''}`
    : `/commits?days=${days}`;
  const { data, error, reload, loading } = useApi(repoList ? path : null);

  const authors = useMemo(() => {
    const byEmail = new Map();
    for (const c of data?.commits || []) {
      const key = (c.author?.email || c.author?.name || '').toLowerCase();
      if (key && !byEmail.has(key)) byEmail.set(key, c.author?.name || c.author?.email);
    }
    return [...byEmail.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.commits.filter((c) => (!project || chosen || c.projectId === project)
      && (!author || (c.author?.email || c.author?.name || '').toLowerCase() === author)
      && (!needle || `${c.message} ${c.id} ${c.repoName} ${c.author?.name} ${c.author?.email}`.toLowerCase().includes(needle.replace(/^#/, ''))));
  }, [data, q, project, chosen, author]);

  const groups = useMemo(() => {
    const groups = [];
    for (const c of rows.slice(0, SHOW_MAX)) {
      const key = new Date(c.author?.date || 0).toDateString();
      if (groups.at(-1)?.key !== key) groups.push({ key, label: dayLabel(c.author?.date), commits: [] });
      groups.at(-1).commits.push(c);
    }
    return groups;
  }, [rows]);

  if (!repoList || !data) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const projects = [...new Map(repoList.map((r) => [r.projectId, projectLabel(r.projectName, r.org)])).entries()];
  const repos = repoList.filter((r) => r.defaultBranch && (!project || r.projectId === project));
  const people = new Set(rows.map((c) => (c.author?.email || c.author?.name || '').toLowerCase())).size;
  const activeRepos = new Set(rows.map((c) => c.repoId)).size;
  const open = (c) => openDrawer({ type: 'commit', projectId: c.projectId, repoId: c.repoId, id: c.id, org: c.org, projectName: c.projectName, repoName: c.repoName });
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div className="page page-wide">
      <PageHeader
        title={t('Commits')}
        sub={`${t(rows.length === 1 ? '{n} commit' : '{n} commits', { n: rows.length })} · ${t(people === 1 ? '{n} person' : '{n} people', { n: people })} · ${t(activeRepos === 1 ? '{n} repo' : '{n} repos', { n: activeRepos })}${loading ? ` · ${t('Loading…')}` : ''}`}
      />

      <div className="filters">
        <input type="search" className="input" placeholder={t('Search message, ID, work item')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search commits')} />
        <select className="input" value={project} onChange={(e) => { setProject(e.target.value); setRepo(''); setBranch(''); }} aria-label={t('Project')}>
          <option value="">{t('All projects')}</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select className="input" value={repo} onChange={(e) => { setRepo(e.target.value); setBranch(''); }} aria-label={t('Repository')}>
          <option value="">{t('All repos')}</option>
          {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        {chosen && (
          <select className="input" value={branch} onChange={(e) => setBranch(e.target.value)} aria-label={t('Branch')}>
            <option value="">{t('{name} (default)', { name: chosen.defaultBranch })}</option>
            {(branches || []).filter((b) => b.name !== chosen.defaultBranch).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        )}
        <select className="input" value={author} onChange={(e) => setAuthor(e.target.value)} aria-label={t('Author')}>
          <option value="">{t('Any author')}</option>
          {authors.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          {author && !authors.some(([key]) => key === author) && <option value={author}>{author}</option>}
        </select>
        <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t('Period')}>
          {PERIODS.map((n) => <option key={n} value={n}>{n === 1 ? t('Last 24 hours') : t('Last {n} days', { n })}</option>)}
        </select>
      </div>

      {data.failed?.length > 0 && (
        <p className="small text-warn">{t("Couldn't read {names}.", { names: data.failed.map((f) => f.repoName).join(', ') })}</p>
      )}

      {!rows.length ? (
        <Empty title={t('No commits match.')}>{t('Try a longer period or clear a filter.')}</Empty>
      ) : (
        <div className="commit-days">
          {groups.map((g) => (
            <section key={g.key} className="commit-day">
              <h2 className="commit-day-head">{g.label} <span className="muted small">{t(g.commits.length === 1 ? '{n} commit' : '{n} commits', { n: g.commits.length })}</span></h2>
              <ul className="commit-list">
                {g.commits.map((c) => (
                  <li key={`${c.repoId}:${c.id}`} className="commit-row clickable" onClick={() => open(c)}>
                    <div className="commit-main">
                      <button type="button" className="row-link" onClick={stop(() => open(c))}>{c.subject || t('(no message)')}</button>
                      <div className="sub">
                        <span>{projectLabel(c.projectName, c.org)} / {c.repoName}</span>
                        <code className="mono muted">{c.id.slice(0, 8)}</code>
                        {c.prId && <button type="button" className="chip chip-info chip-btn" onClick={stop(() => openDrawer({ type: 'pr', projectId: c.projectId, repoId: c.repoId, id: c.prId }))} title={t('Open pull request {id}', { id: c.prId })}>PR {c.prId}</button>}
                        {c.workItemIds.map((id) => (
                          <button key={id} type="button" className="chip chip-muted chip-btn" onClick={stop(() => openDrawer({ type: 'workitem', id, org: c.org }))} title={t('Open work item {id}', { id })}>#{id}</button>
                        ))}
                      </div>
                    </div>
                    <span className="commit-author"><Person person={authorOf(c)} /></span>
                    {c.changes ? (
                      <span className="commit-changes mono small" title={t('{a} added, {e} edited, {d} deleted', { a: c.changes.added, e: c.changes.edited, d: c.changes.deleted })}>
                        <span className="text-ok">+{c.changes.added}</span> <span className="muted">~{c.changes.edited}</span> <span className="text-bad">−{c.changes.deleted}</span>
                      </span>
                    ) : <span className="commit-changes" />}
                    <time className="commit-time muted small" dateTime={c.author?.date} title={dateTime(c.author?.date)}>
                      {new Date(c.author?.date).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}
                    </time>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {rows.length > SHOW_MAX && <p className="muted small">{t('Showing the newest {n}. Narrow the filters to see older commits.', { n: SHOW_MAX })}</p>}
        </div>
      )}
    </div>
  );
}
