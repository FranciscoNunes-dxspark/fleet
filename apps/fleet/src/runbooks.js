// Runbooks: Markdown files whose steps run in the apps. A step is a line inside a fenced code block
// whose info string names an app (```trawl, ```hail …): each non-empty line of it is one line for that
// app's prompt, a slash command or a family:v1: context, handed over as a hand-off is. The prose before
// a block explains its first step. Runbooks live in .fleet/runbooks/ of the folder Fleet started in
// and of its checkout, and in ~/.fleet/runbooks (FLEET_HOME moves it). Reading and parsing are here,
// the folders injected, so the tests use their own; drafting one from the family's activity log too.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { repoRoot } from '@fleet/kit/family.js';
import { fleetHome } from './state.js';
import { IDS, SPACES } from './spaces.js';

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;

/**
 * A runbook's text as { title, steps: [{ app, line, prose }], outro }. `prose` is the text before the
 * step's block (only its first step has it), headings without their #s; `outro` is what follows the
 * last block. A fenced block for anything but an app (```bash) is prose as it is. `ids` are the apps.
 */
export function parseRunbook(text, { name = 'runbook', ids = IDS } = {}) {
  const steps = [];
  let title = null;
  let prose = [];
  let fence = null; // { marker, app, lines }
  const flushProse = () => {
    // Blank lines run together into one, and none at either end.
    const out = [];
    for (const l of prose) if (l.trim() || (out.length && out.at(-1) !== '')) out.push(l.trim() ? l.trimEnd() : '');
    while (out.length && out.at(-1) === '') out.pop();
    prose = [];
    return out.join('\n');
  };
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (fence) {
      const close = FENCE.exec(raw);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length && !close[2]) {
        if (fence.app) {
          const explained = flushProse();
          fence.lines.forEach((line, i) => steps.push({ app: fence.app, line, prose: i === 0 ? explained : '' }));
        } else prose.push(...fence.lines);
        fence = null;
      } else if (fence.app) {
        if (raw.trim()) fence.lines.push(raw.trim());
      } else fence.lines.push(raw);
      continue;
    }
    const open = FENCE.exec(raw);
    if (open) {
      const info = open[2].toLowerCase();
      fence = { marker: open[1], app: ids.includes(info) ? info : null, lines: [] };
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading && heading[1] === '#' && title == null && !steps.length) title = heading[2];
    else prose.push(heading ? heading[2] : raw);
  }
  // A block left open at the end still counts, as Markdown renders it.
  if (fence?.app) {
    const explained = flushProse();
    fence.lines.forEach((line, i) => steps.push({ app: fence.app, line, prose: i === 0 ? explained : '' }));
  } else if (fence) prose.push(...fence.lines);
  return { title: title || name, steps, outro: flushProse() };
}

/** The folders runbooks are read from, in order: the start folder's, its checkout's, then Fleet's own. */
export function runbookDirs({ cwd = process.cwd(), env = process.env } = {}) {
  const here = resolve(cwd);
  const root = repoRoot(here);
  const dirs = [join(here, '.fleet', 'runbooks')];
  if (root && root !== here) dirs.push(join(root, '.fleet', 'runbooks'));
  dirs.push(join(fleetHome(env), 'runbooks'));
  return [...new Set(dirs)];
}

/**
 * The runbooks in `dirs`: [{ name, file, where, title, steps, outro }], by folder then name; a file
 * that can't be read is left out. `where` is the folder as it's shown (relative to `cwd` when inside it).
 */
export function listRunbooks(dirs, { cwd = process.cwd(), ids = IDS } = {}) {
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort();
    } catch {
      continue;
    }
    const rel = relative(resolve(cwd), dir);
    const where = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : dir;
    for (const n of names) {
      const file = join(dir, n);
      try {
        const name = basename(n, '.md');
        out.push({ name, file, where, ...parseRunbook(readFileSync(file, 'utf8'), { name, ids }) });
      } catch {
        // Unreadable: not listed.
      }
    }
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const timeOf = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const titleOf = (id) => SPACES.find((s) => s.id === id)?.title ?? id;

/**
 * A runbook drafted from the family's activity (`entries`, readActivity's: newest first). The log says
 * what the apps did, in words, not the commands that did it, so the draft says so: what happened as a
 * list to work from, and an empty step to fill in, in the block of the app that did the last thing.
 */
export function draftRunbook(entries, { now = Date.now(), ids = IDS } = {}) {
  const happened = [...entries].sort((a, b) => a.at - b.at);
  const last = happened.at(-1)?.app;
  const app = ids.includes(last) ? last : ids[0];
  const lines = [
    `# Draft of ${dateOf(now)} ${timeOf(now)}`,
    '',
    'Drafted by Fleet from what the family did in the hour before. The activity log says what each app',
    'did, not the commands that did it, so the steps are yours to write: each step is a line for an',
    "app's prompt (a slash command, or a family:v1: line it copied) in a block named after the app.",
    '',
    '## What happened',
    '',
    ...(happened.length
      ? happened.map((e) => `- ${timeOf(e.at)} ${titleOf(e.app)}: ${String(e.text ?? '').replace(/\s+/g, ' ').trim()}`)
      : ['- Nothing in the last hour: the apps log what changes something (a push, a restart, a write).']),
    '',
    '## Steps',
    '',
    'What the first step is for.',
    '',
    `\`\`\`${app}`,
    '```',
    '',
  ];
  return lines.join('\n');
}

/** Writes `text` as `<date>-draft.md` in `dir` (made if need be), never over another: the path written. */
export function writeDraft(dir, text, { now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const stem = `${dateOf(now)}-draft`;
  let file = join(dir, `${stem}.md`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem}-${n}.md`);
  writeFileSync(file, text);
  return file;
}
