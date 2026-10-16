import { useMemo, useState } from 'react';
import { useApi, useApp } from '../context.js';
import {
  LIMITS, buildPrompt, cliLink, desktopLink, folderProblem, lastRepoFor, loadFolders, rememberRepo, saveFolder,
} from '../claude.js';
import { t, tj } from '../i18n.js';

/** Work item panel: open Claude Code or Claude Desktop with this item as the prompt. */
export default function ClaudeStart({ w }) {
  const { data: allRepos } = useApi('/repos');
  const { toast } = useApp();
  const [folders, setFolders] = useState(loadFolders);
  const [picked, setPicked] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const repos = useMemo(() => (allRepos || []).filter((r) => r.projectName === w.projectName), [allRepos, w.projectName]);
  // Default: the repo of a linked PR, else the last one used in this project, else the first.
  const repoId = (repos.some((r) => r.id === picked) && picked)
    || [...w.pullRequests.map((p) => p.repoId), lastRepoFor(w.projectName)].find((id) => repos.some((r) => r.id === id))
    || repos[0]?.id;
  const repo = repos.find((r) => r.id === repoId) || null;
  const folder = repo ? folders[repo.id] || '' : '';
  const problem = folderProblem(draft);

  const saveDraft = () => {
    if (problem) return;
    saveFolder(repo.id, draft.trim());
    setFolders(loadFolders());
    setEditing(false);
  };
  const opened = () => repo && rememberRepo(w.projectName, repo.id);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildPrompt(w, repo, LIMITS.desktop));
      toast(t('Prompt copied'));
    } catch {
      toast(t('Couldn’t copy. Your browser blocked the clipboard.'), 'bad');
    }
  };

  return (
    <section className="detail-section claude-start">
      <h3>{t('Start in Claude')}</h3>
      <div className="claude-row">
        <label>{t('Repository')}
          <select className="input" value={repoId || ''} onChange={(e) => { setPicked(e.target.value); setEditing(false); }} disabled={!repos.length}>
            {!repos.length && <option value="">{allRepos ? t('No tracked repos in this project') : t('Loading…')}</option>}
            {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        {repo && (editing || !folder ? (
          <form className="claude-folder" onSubmit={(e) => { e.preventDefault(); saveDraft(); }}>
            <label>{t('Local folder for {repo}', { repo: repo.name })}
              <input className="input mono" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="C:\src\repo-name" spellCheck={false} autoComplete="off" aria-invalid={!!problem} />
            </label>
            <button type="submit" className="btn btn-small" disabled={!draft.trim() || !!problem}>{t('Save')}</button>
            {folder && <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(false)}>{t('Cancel')}</button>}
          </form>
        ) : (
          <div className="claude-folder-set">
            <span className="muted small">{t('Local folder')}</span>
            <span className="mono small claude-path" title={folder}>{folder}</span>
            <button type="button" className="link-btn small" onClick={() => { setDraft(folder); setEditing(true); }}>{t('Change')}</button>
          </div>
        ))}
      </div>
      {/* folderProblem() returns one of a few fixed English sentences from claude.js. */}
      {problem && <p className="small text-bad">{t(problem)}</p>}
      {repo && !folder && !editing && <p className="muted small">{t('Without a folder, Claude Code opens in your home folder and Claude Desktop asks you to pick one.')}</p>}

      <div className="detail-actions">
        <a className="btn btn-small btn-primary" href={cliLink(folder, buildPrompt(w, repo, LIMITS.cli))} onClick={opened}>Claude Code (CLI)</a>
        <a className="btn btn-small" href={desktopLink(folder, buildPrompt(w, repo, LIMITS.desktop))} onClick={opened}>Claude Desktop</a>
        <button type="button" className="btn btn-small btn-ghost" onClick={copy}>{t('Copy prompt')}</button>
      </div>
      <p className="muted small">
        {tj('Opens Claude with this item as the prompt. Nothing runs until you press Enter. If nothing opens: for the CLI, send one prompt in an interactive {cmd} session first; for Desktop, install Claude Desktop.', { cmd: <span className="mono">claude</span> })}
      </p>
    </section>
  );
}
