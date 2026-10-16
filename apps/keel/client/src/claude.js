// "Start in Claude": turns a work item into a prompt and opens Claude Code
// (terminal, via claude-cli://) or Claude Desktop (via claude://) in the
// repo's local folder. Nothing runs until you press Enter in Claude.
// Folders are per device, so they live in this browser, not on the account.

const FOLDERS_KEY = 'keel.claudeFolders.v1'; // repoId -> absolute local path
const LAST_REPO_KEY = 'keel.claudeRepo.v1'; // projectName -> repoId

// Documented prompt limits: 5,000 characters for claude-cli://, about 14,000 for claude://.
export const LIMITS = { cli: 5000, desktop: 14000 };

const read = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') || {};
  } catch {
    return {};
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
};

export const loadFolders = () => read(FOLDERS_KEY);
export function saveFolder(repoId, folder) {
  const all = loadFolders();
  if (folder) all[repoId] = folder;
  else delete all[repoId];
  write(FOLDERS_KEY, all);
}

export const lastRepoFor = (projectName) => read(LAST_REPO_KEY)[projectName] || null;
export const rememberRepo = (projectName, repoId) => write(LAST_REPO_KEY, { ...read(LAST_REPO_KEY), [projectName]: repoId });

/** Claude only accepts absolute local paths: no network shares, no "..". Returns an error message or null. */
export function folderProblem(folder) {
  const f = folder.trim();
  if (!f) return null;
  if (/^\\\\|^\/\//.test(f)) return 'Network paths aren’t supported. Use a local folder.';
  if (!/^[A-Za-z]:[\\/]|^\//.test(f)) return 'Use the full path, for example C:\\src\\my-repo.';
  if (/(^|[\\/])\.\.([\\/]|$)/.test(f)) return 'Use the full path without "..".';
  return null;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
export const branchFor = (w) => `${w.type === 'Bug' ? 'bugfix' : 'feature'}/${w.id}-${slug(w.title) || 'work'}`;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max).trimEnd()}… (truncated, see the work item)` : text);

/** The prompt, shortened field by field until it fits Claude's limit. */
export function buildPrompt(w, repo, limit = LIMITS.cli) {
  const build = (cap) => {
    const lines = [
      `Let's work on Azure DevOps ${w.type} ${w.id}: ${w.title}`,
      '',
      `Project: ${w.projectName}`,
      repo && `Repository: ${repo.name}${repo.defaultBranch ? ` (default branch ${repo.defaultBranch})` : ''}`,
      `State: ${w.state}${w.priority ? `, priority ${w.priority}` : ''}${w.assignedTo ? `, assigned to ${w.assignedTo.displayName}` : ''}`,
      w.tags.length > 0 && `Tags: ${w.tags.join(', ')}`,
      w.parent && `Parent: ${w.parent.type} ${w.parent.id}: ${w.parent.title}`,
      `Link: ${w.webUrl}`,
    ];
    if (w.description) lines.push('', w.type === 'Bug' ? 'Description / repro steps:' : 'Description:', clip(w.description, cap));
    if (w.acceptanceCriteria) lines.push('', 'Acceptance criteria:', clip(w.acceptanceCriteria, cap));
    if (w.children.length) {
      lines.push('', 'Child items:');
      for (const c of w.children.slice(0, 15)) lines.push(`- ${c.type} ${c.id} (${c.state}): ${c.title}`);
    }
    const comments = w.comments.filter((c) => c.text.trim()).slice(0, 3);
    if (comments.length) {
      lines.push('', 'Recent comments:');
      for (const c of comments) lines.push(`- ${c.author?.displayName || 'Someone'}: ${clip(c.text.replace(/\s+/g, ' '), Math.round(cap / 3))}`);
    }
    lines.push(
      '',
      'How to work:',
      '1. Read the relevant code first, then give me a short plan before changing anything.',
      `2. Work on a new branch ${branchFor(w)}${repo?.defaultBranch ? ` from ${repo.defaultBranch}` : ''}.`,
      `3. Mention AB#${w.id} in commit messages so Azure DevOps links them to the work item.`,
      '4. Run the tests. Don’t push or open a pull request until I say so.',
    );
    return lines.filter((l) => l !== false && l !== null && l !== undefined).join('\n');
  };
  for (const cap of [4000, 2400, 1500, 900, 500, 250]) {
    const prompt = build(cap);
    if (prompt.length <= limit) return prompt;
  }
  return build(120).slice(0, limit);
}

/** Claude Code in a terminal. Without a folder it opens in your home folder. */
export const cliLink = (folder, prompt) =>
  `claude-cli://open?${folder ? `cwd=${encodeURIComponent(folder)}&` : ''}q=${encodeURIComponent(prompt)}`;

/** Claude Desktop, Code tab. It asks you to confirm the folder. */
export const desktopLink = (folder, prompt) =>
  `claude://code/new?${folder ? `folder=${encodeURIComponent(folder)}&` : ''}q=${encodeURIComponent(prompt)}`;
