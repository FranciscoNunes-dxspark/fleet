// Splice's side: the project's git repository, read through Splice's own git runner (no prompt, no
// editor, no optional locks, so a read never takes the index lock) and its parsers. Every command
// here only reads; refs and paths from Claude are checked so none can pass as an option.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '@fleet/kit/family.js';
import { ToolError } from '@fleet/kit/mcp.js';
import { clip, count, line, stamp } from './bound.js';

const splice = () => Promise.all([import('../../../splice/src/git.js'), import('../../../splice/src/parse.js')]).then(([g, p]) => ({ ...g, ...p }));

/** The repository the project is in, or a ToolError saying there's none. */
function repoOf(ctx, folder) {
  const root = repoRoot(ctx.resolve(folder));
  if (!root) throw new ToolError(`${ctx.resolve(folder)} isn't inside a git repository.`);
  return root;
}

/** A revision Claude named, refused when it could be read as an option. */
function rev(value, fallback = 'HEAD') {
  const s = String(value ?? '').trim() || fallback;
  if (s.startsWith('-') || /[\s\0]/.test(s)) throw new ToolError(`"${s}" isn't a revision (a commit hash, branch, tag or HEAD~2).`);
  return s;
}

/** Runs git read-only in `root`, its failures as ToolErrors in git's own words. */
async function read(root, args) {
  const { git } = await splice();
  try {
    return await git(root, args);
  } catch (e) {
    throw new ToolError(`git ${args[0]}: ${String(e.message).trim().split('\n').slice(0, 3).join(' ')}`);
  }
}

const folderArg = { folder: { type: 'string', description: 'A folder of another repository (default: the project)' } };

export const gitTools = [
  {
    name: 'git_status',
    description: "The repository's state, as Splice shows it: the branch, its upstream and how far ahead or behind, any operation in progress, and the changed files (conflicts, unstaged, staged, untracked).",
    inputSchema: { type: 'object', properties: { ...folderArg } },
    async run({ folder }, ctx) {
      const root = repoOf(ctx, folder);
      const { parseStatus, groupChanges } = await splice();
      const { branch, files } = parseStatus(await read(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
      const { conflicts, unstaged, staged } = groupChanges(files);
      const out = [`Repository ${root}`, `branch: ${branch.head ?? `(detached at ${branch.oid?.slice(0, 12) ?? 'nothing'})`}${branch.upstream ? `, tracking ${branch.upstream} (ahead ${branch.ahead}, behind ${branch.behind})` : ', no upstream'}`];
      const gitDir = (await read(root, ['rev-parse', '--absolute-git-dir'])).trim();
      for (const [file, what] of [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert'], ['BISECT_LOG', 'a bisect']])
        if (existsSync(join(gitDir, file))) {
          out.push(`in the middle of ${what}`);
          break;
        }
      const list = (title, items) => items.length && out.push(`${title} (${items.length}):`, ...items.slice(0, 300).map((f) => `  ${f.code} ${f.path}${f.orig ? ` (from ${f.orig})` : ''}`), ...(items.length > 300 ? [`  … and ${items.length - 300} more`] : []));
      list('Conflicts', conflicts);
      list('Staged', staged);
      list('Unstaged', unstaged);
      if (!files.length) out.push('Nothing changed: the working tree is clean.');
      return out.join('\n');
    },
  },
  {
    name: 'git_log',
    description: 'Commits, newest first: hash, date, author, refs and subject. With `graph`, the branch graph as text (git log --graph). Optionally from a revision, or only those touching a path.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'How many commits (default 30, at most 500)' },
        ref: { type: 'string', description: 'Start from this revision (default HEAD)' },
        all: { type: 'boolean', description: 'Every branch, not only the current one' },
        path: { type: 'string', description: 'Only commits touching this path (relative to the repository)' },
        graph: { type: 'boolean', description: 'Draw the graph (default false)' },
        ...folderArg,
      },
    },
    async run({ n, ref, all, path, graph, folder }, ctx) {
      const root = repoOf(ctx, folder);
      const { LOG_FORMAT, DECORATE_REFS, parseLog } = await splice();
      const max = count(n, 30, 500);
      const where = all ? ['--all'] : [rev(ref)];
      const paths = path ? ['--', String(path)] : [];
      if (graph) return clip(await read(root, ['log', '--graph', '--decorate', ...DECORATE_REFS, `--format=%h %ad %an%d %s`, '--date=short', `-n${max}`, ...where, ...paths]));
      const rows = parseLog(await read(root, ['log', '--decorate=full', ...DECORATE_REFS, `--format=${LOG_FORMAT}`, `-n${max}`, ...where, ...paths]));
      if (!rows.length) return 'No commits.';
      return rows
        .map(({ commit: c }) => {
          const refs = c.refs.filter((r) => r.type !== 'head').map((r) => (r.type === 'tag' ? `tag ${r.name}` : r.head ? `HEAD → ${r.name}` : r.name));
          return `${c.hash.slice(0, 12)}  ${stamp(c.time * 1000).slice(0, 16)}  ${line(c.author, 40)}${refs.length ? `  (${refs.join(', ')})` : ''}${c.parents.length > 1 ? '  [merge]' : ''}  ${line(c.subject, 200)}`;
        })
        .join('\n');
    },
  },
  {
    name: 'git_show',
    description: "One commit: its author, dates and whole message, the files it changed with their line counts, and its diff (cut at `max_chars`). Optionally only one path's diff.",
    inputSchema: {
      type: 'object',
      properties: {
        commit: { type: 'string', description: 'A hash, branch, tag or HEAD~1 (default HEAD)' },
        path: { type: 'string', description: "Only this path's changes" },
        max_chars: { type: 'integer', description: 'Cut the diff at this many characters (default 20000, at most 40000)' },
        ...folderArg,
      },
    },
    async run({ commit, path, max_chars, folder }, ctx) {
      const root = repoOf(ctx, folder);
      const r = rev(commit);
      const text = await read(root, ['show', '--no-ext-diff', '--format=fuller', '--stat=120', '--patch', '-M', r, ...(path ? ['--', String(path)] : [])]);
      return clip(text, count(max_chars, 20_000, 40_000));
    },
  },
  {
    name: 'git_diff',
    description: "The working tree's changes not committed yet: unstaged by default, staged with `staged` (cut at `max_chars`). Or between two revisions with `from` (and `to`, default the working tree).",
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'What is staged, rather than what is not' },
        from: { type: 'string', description: 'Compare from this revision instead' },
        to: { type: 'string', description: 'Compare up to this revision (with `from`)' },
        path: { type: 'string', description: "Only this path's changes" },
        stat: { type: 'boolean', description: 'Only the files and line counts, no diff' },
        max_chars: { type: 'integer', description: 'Cut at this many characters (default 20000, at most 40000)' },
        ...folderArg,
      },
    },
    async run({ staged, from, to, path, stat, max_chars, folder }, ctx) {
      const root = repoOf(ctx, folder);
      const range = from ? [rev(from), ...(to ? [rev(to)] : [])] : staged ? ['--cached'] : [];
      const text = await read(root, ['diff', '--no-ext-diff', '-M', ...(stat ? ['--stat=120'] : ['--stat=120', '--patch']), ...range, ...(path ? ['--', String(path)] : [])]);
      return text.trim() ? clip(text, count(max_chars, 20_000, 40_000)) : 'No changes.';
    },
  },
  {
    name: 'git_blame',
    description: 'Who last changed each line of a file, and in which commit: a range of lines (at most 400), at HEAD or another revision.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file, relative to the repository' },
        start: { type: 'integer', description: 'First line (default 1)' },
        end: { type: 'integer', description: 'Last line (default start + 99; at most 400 lines)' },
        commit: { type: 'string', description: 'Blame as of this revision (default: the working tree)' },
        ...folderArg,
      },
      required: ['path'],
    },
    async run({ path, start, end, commit, folder }, ctx) {
      const root = repoOf(ctx, folder);
      if (!path) throw new ToolError('Which file? `path` is relative to the repository.');
      const { parseBlame, isoDate } = await splice();
      const from = count(start, 1, 10_000_000);
      const to = Math.min(from + 399, count(end, from + 99, 10_000_000));
      if (to < from) throw new ToolError('`end` comes before `start`.');
      const raw = await read(root, ['blame', '--porcelain', '-L', `${from},${to}`, ...(commit ? [rev(commit)] : []), '--', String(path)]);
      return parseBlame(raw)
        .map((l) => `${l.commit.uncommitted ? 'not committed' : l.commit.hash.slice(0, 10)}  ${l.commit.uncommitted ? '' : isoDate(l.commit.time, l.commit.tz)}  ${line(l.commit.author, 24).padEnd(24)}  ${String(l.line).padStart(5)}  ${line(l.text, 300)}`)
        .join('\n');
    },
  },
  {
    name: 'git_branches',
    description: 'The local branches (the current one marked, each with its upstream, ahead/behind and last commit), the remote branches and the newest tags.',
    inputSchema: { type: 'object', properties: { remote: { type: 'boolean', description: 'Also list the remote branches (default true)' }, ...folderArg } },
    async run({ remote = true, folder }, ctx) {
      const root = repoOf(ctx, folder);
      const FORMAT = '%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(objectname:short)%1f%(contents:subject)';
      const rows = (await read(root, ['for-each-ref', '--sort=-committerdate', `--format=${FORMAT}`, 'refs/heads', ...(remote ? ['refs/remotes'] : []), 'refs/tags']))
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\x1f'));
      const show = ([, head, upstream, track, date, hash, subject], name) =>
        `${head === '*' ? '* ' : '  '}${name}${upstream ? `  → ${upstream}${track ? ` ${track}` : ''}` : ''}  ${hash}  ${stamp(Number(date) * 1000).slice(0, 10)}  ${line(subject, 120)}`;
      const of = (prefix) => rows.filter((r) => r[0].startsWith(prefix) && !r[0].endsWith('/HEAD')).map((r) => show(r, r[0].slice(prefix.length)));
      const local = of('refs/heads/');
      const remotes = of('refs/remotes/');
      const tags = of('refs/tags/');
      return [
        `Local branches (${local.length}):`,
        ...local.slice(0, 200),
        ...(remote ? ['', `Remote branches (${remotes.length}):`, ...remotes.slice(0, 200)] : []),
        ...(tags.length ? ['', `Tags, newest first (${tags.length}):`, ...tags.slice(0, 20)] : []),
      ].join('\n');
    },
  },
];
