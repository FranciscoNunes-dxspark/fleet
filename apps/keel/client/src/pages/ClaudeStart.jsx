import { useMemo, useState } from 'react';
import { useApi, useApp } from '../context.js';
import { useSticky } from '../sticky.js';
import {
  LIMITS, buildPrompt, cliLink, desktopLink, folderProblem, lastRepoFor, loadFolders, loadRules, rememberRepo, saveFolder,
} from '../claude.js';
import { t, tj } from '../i18n.js';
import { Button, TextField } from '@radix-ui/themes';
import { Select } from '../ui.jsx';

/**
 * Work item panel: open Claude Code or Claude Desktop with this item as the prompt. Folded to its
 * title until opened, so it doesn't push the item's details down; open or folded is remembered.
 */
export default function ClaudeStart({ w }) {
  const { data: allRepos } = useApi('/repos');
  const { toast } = useApp();
  const [folders, setFolders] = useState(loadFolders);
  const [picked, setPicked] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useSticky('claude.open', false);

  const repos = useMemo(() => (allRepos || []).filter((r) => r.projectName === w.projectName), [allRepos, w.projectName]);
  // Default: the repo of a linked PR, else the last one used in this project, else the first.
  const repoId = (repos.some((r) => r.id === picked) && picked)
    || [...w.pullRequests.map((p) => p.repoId), lastRepoFor(w.projectName)].find((id) => repos.some((r) => r.id === id))
    || repos[0]?.id;
  const repo = repos.find((r) => r.id === repoId) || null;
  const folder = repo ? folders[repo.id] || '' : '';
  const problem = folderProblem(draft);
  const rules = loadRules();

  const saveDraft = () => {
    if (problem) return;
    saveFolder(repo.id, draft.trim());
    setFolders(loadFolders());
    setEditing(false);
  };
  const opened = () => repo && rememberRepo(w.projectName, repo.id);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(buildPrompt(w, repo, LIMITS.desktop, rules));
      toast(t('Prompt copied'));
    } catch {
      toast(t('Couldn’t copy. Your browser blocked the clipboard.'), 'bad');
    }
  };

  return (
    <section className={`detail-section claude-start${open ? '' : ' folded'}`}>
      <h3>
        <button type="button" className="fold-toggle" aria-expanded={open} aria-controls="claude-start-body" onClick={() => setOpen(!open)}>
          <svg className="fold-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {t('Start in Claude')}
        </button>
      </h3>
      {open && <div id="claude-start-body" className="claude-body">
        <div className="claude-row">
          <label>{t('Repository')}
            <Select className="input" value={repoId || ''} onChange={(e) => { setPicked(e.target.value); setEditing(false); }} disabled={!repos.length}>
              {!repos.length && <option value="">{allRepos ? t('No tracked repos in this project') : t('Loading…')}</option>}
              {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </label>
          {repo && (editing || !folder ? (
            <form className="claude-folder" onSubmit={(e) => { e.preventDefault(); saveDraft(); }}>
              <label>{t('Local folder for {repo}', { repo: repo.name })}
                <TextField.Root className="mono" variant="surface" color="gray" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="C:\src\repo-name" spellCheck={false} autoComplete="off" aria-invalid={!!problem} />
              </label>
              <Button size="1" variant="outline" color="gray" type="submit" disabled={!draft.trim() || !!problem}>{t('Save')}</Button>
              {folder && <Button size="1" variant="ghost" color="gray" type="button" onClick={() => setEditing(false)}>{t('Cancel')}</Button>}
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
          <a className="btn btn-small btn-primary" href={cliLink(folder, buildPrompt(w, repo, LIMITS.cli, rules))} onClick={opened}>Claude Code (CLI)</a>
          <a className="btn btn-small" href={desktopLink(folder, buildPrompt(w, repo, LIMITS.desktop, rules))} onClick={opened}>Claude Desktop</a>
          <Button size="1" variant="ghost" color="gray" type="button" onClick={copy}>{t('Copy prompt')}</Button>
        </div>
        <p className="muted small">
          {tj('Opens Claude with this item as the prompt. Nothing runs until you press Enter. If nothing opens: for the CLI, send one prompt in an interactive {cmd} session first; for Desktop, install Claude Desktop.', { cmd: <span className="mono">claude</span> })}
        </p>
      </div>}
    </section>
  );
}
