import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { date } from '../format.js';
import { CodeTabs, Chip, Empty, ErrorBox, Loading, PageHeader } from '../ui.jsx';
import { t } from '../i18n.js';
import { useProjectLabel } from '../orgs.js';

const iso = (d) => d.toISOString().slice(0, 10);

/** Saves text as a file the browser downloads. */
export function downloadText(name, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Release notes (a tab of Pull requests): the pull requests merged in a date
 * range and the work items they delivered, as Markdown grouped into features,
 * fixes, and pull requests by repo. A single deploy's notes are on its panel
 * (DeployDetail.jsx).
 */
export default function ReleaseNotes() {
  const { data: prData, error } = useApi('/prs');
  const { toast, openDrawer } = useApp();
  const projectLabel = useProjectLabel();
  const [from, setFrom] = useState(iso(new Date(Date.now() - 14 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [title, setTitle] = useState('');
  const [repoIds, setRepoIds] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState(null);

  const head = (
    <>
      <PageHeader title={t('Release notes')} sub={t('Build notes from merged pull requests and the work items they delivered.')} />
      <CodeTabs />
    </>
  );
  if (!prData) return <div className="page page-wide">{head}{error ? <ErrorBox error={error} /> : <Loading />}</div>;

  const generate = async (e) => {
    e.preventDefault();
    setBusy(true);
    setGenError(null);
    try {
      setResult(await api('/changelog', { method: 'POST', body: { from, to, repoIds, title: title || undefined } }));
    } catch (err) {
      setGenError(err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.markdown);
      toast(t('Markdown copied'));
    } catch {
      toast(t('Copy failed. Select the text and copy it yourself.'), 'bad');
    }
  };

  const toggleRepo = (id) => setRepoIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const byProject = [...new Map(prData.repos.map((r) => [`${r.org || ''}:${r.projectId}`, { key: `${r.org || ''}:${r.projectId}`, label: projectLabel(r.projectName, r.org) }])).values()];

  return (
    <div className="page page-wide">
      {head}
      <form className="panel release-form" onSubmit={generate}>
        <div className="form-row">
          <label>{t('From')}<input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required /></label>
          <label>{t('To')}<input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></label>
          <label className="grow">{t('Title')}<input className="input" placeholder={t('Release notes')} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        </div>
        <fieldset className="repo-pick">
          <legend>{t('Repositories')} <span className="muted small">{repoIds.length ? t('{n} selected', { n: repoIds.length }) : t('all tracked repos')}</span></legend>
          {byProject.map((p) => (
            <div key={p.key} className="repo-group">
              <span className="muted small">{p.label}</span>
              {prData.repos.filter((r) => `${r.org || ''}:${r.projectId}` === p.key).map((r) => (
                <label key={r.id} className="check"><input type="checkbox" checked={repoIds.includes(r.id)} onChange={() => toggleRepo(r.id)} /> {r.name}</label>
              ))}
            </div>
          ))}
        </fieldset>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? t('Building…') : t('Build release notes')}</button>
      </form>

      <ErrorBox error={genError} />

      {result && (
        result.groups.length === 0 ? <Empty title={t('No pull requests were merged in that range.')} /> : (
          <div className="release-out">
            <section>
              <h2 className="section-title">{t('Preview')}</h2>
              {(result.features.length > 0 || result.fixes.length > 0) && <p className="small">{t('{features} features or improvements, {fixes} bug fixes.', { features: result.features.length, fixes: result.fixes.length })}</p>}
              {result.groups.map((g) => (
                <div key={g.key} className="release-group">
                  <h3>{g.key} <span className="muted small">{g.prs.length}</span></h3>
                  <ul className="link-list">
                    {g.prs.map((pr) => (
                      <li key={`${pr.org || ''}:${pr.id}`}>
                        <button type="button" className="link-btn mono" onClick={() => openDrawer({ type: 'pr', projectId: pr.projectId, repoId: pr.repoId, id: pr.id, org: pr.org })}>!{pr.id}</button>
                        <span>{pr.title}</span>
                        <span className="muted small">{pr.author} · {date(pr.closedAt)}</span>
                        {pr.workItems.map((w) => (
                          <button key={w.id} type="button" className="chip chip-muted chip-btn" onClick={() => openDrawer({ type: 'workitem', id: w.id, org: w.org })} title={w.title}>{w.type} {w.id}</button>
                        ))}
                        {!pr.workItems.length && <Chip tone="warn">{t('No work item')}</Chip>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
            <section>
              <div className="md-head">
                <h2 className="section-title">Markdown</h2>
                <div className="page-actions">
                  <button type="button" className="btn btn-small" onClick={copy}>{t('Copy')}</button>
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => downloadText(`release-notes-${from}-to-${to}.md`, result.markdown)}>{t('Download .md')}</button>
                </div>
              </div>
              <textarea className="input markdown-out" readOnly value={result.markdown} aria-label={t('Release notes in Markdown')} />
            </section>
          </div>
        )
      )}
    </div>
  );
}
