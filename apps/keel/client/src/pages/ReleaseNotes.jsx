import { useState } from 'react';
import { api } from '../api.js';
import { useApi, useApp } from '../context.js';
import { date } from '../format.js';
import { Chip, Empty, ErrorBox, Loading, PageHeader } from '../ui.jsx';

const iso = (d) => d.toISOString().slice(0, 10);

export default function ReleaseNotes() {
  const { data: prData, error } = useApi('/prs');
  const { toast, openDrawer } = useApp();
  const [from, setFrom] = useState(iso(new Date(Date.now() - 14 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [title, setTitle] = useState('');
  const [repoIds, setRepoIds] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState(null);

  if (!prData) return error ? <ErrorBox error={error} /> : <Loading />;

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
      toast('Markdown copied');
    } catch {
      toast('Copy failed — select the text and copy it manually', 'bad');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([result.markdown], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `release-notes-${from}-to-${to}.md` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleRepo = (id) => setRepoIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const byProject = [...new Set(prData.repos.map((r) => r.projectName))];

  return (
    <div className="page">
      <PageHeader title="Release notes" sub="Build notes from merged pull requests and the work items they delivered." />

      <form className="panel release-form" onSubmit={generate}>
        <div className="form-row">
          <label>From<input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required /></label>
          <label>To<input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></label>
          <label className="grow">Title<input className="input" placeholder="Release notes" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        </div>
        <fieldset className="repo-pick">
          <legend>Repositories <span className="muted small">{repoIds.length ? `${repoIds.length} selected` : 'all tracked repos'}</span></legend>
          {byProject.map((p) => (
            <div key={p} className="repo-group">
              <span className="muted small">{p}</span>
              {prData.repos.filter((r) => r.projectName === p).map((r) => (
                <label key={r.id} className="check"><input type="checkbox" checked={repoIds.includes(r.id)} onChange={() => toggleRepo(r.id)} /> {r.name}</label>
              ))}
            </div>
          ))}
        </fieldset>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Building…' : 'Build release notes'}</button>
      </form>

      <ErrorBox error={genError} />

      {result && (
        result.groups.length === 0 ? <Empty title="No pull requests were merged in that range." /> : (
          <div className="release-out">
            <section>
              <h2 className="section-title">Preview</h2>
              {result.features.length > 0 && <p className="small"><strong>{result.features.length}</strong> features or improvements, <strong>{result.fixes.length}</strong> bug fixes.</p>}
              {result.groups.map((g) => (
                <div key={g.key} className="release-group">
                  <h3>{g.key} <span className="muted small">{g.prs.length}</span></h3>
                  <ul className="link-list">
                    {g.prs.map((pr) => (
                      <li key={pr.id}>
                        <a href={pr.webUrl} target="_blank" rel="noreferrer noopener" className="mono">!{pr.id}</a>
                        <span>{pr.title}</span>
                        <span className="muted small">{pr.author} · {date(pr.closedAt)}</span>
                        {pr.workItems.map((w) => (
                          <button key={w.id} type="button" className="chip chip-muted chip-btn" onClick={() => openDrawer({ type: 'workitem', id: w.id })} title={w.title}>{w.type} {w.id}</button>
                        ))}
                        {!pr.workItems.length && <Chip tone="warn">No work item</Chip>}
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
                  <button type="button" className="btn btn-small" onClick={copy}>Copy</button>
                  <button type="button" className="btn btn-small btn-ghost" onClick={download}>Download .md</button>
                </div>
              </div>
              <textarea className="input markdown-out" readOnly value={result.markdown} aria-label="Release notes markdown" />
            </section>
          </div>
        )
      )}
    </div>
  );
}
