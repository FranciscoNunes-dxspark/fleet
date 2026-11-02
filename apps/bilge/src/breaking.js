// /breaking <package>: what Claude is asked about a major version's changes, for this code. The lines
// of the project that use the package are found by searching its source for the package's imports
// (import, require, `using`), a bounded walk; Claude gets those, the package's registry page and
// repository, and may read the files around them. Pure, but for `findUsages`, which reads the disk.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// What's searched, per ecosystem, and the folders never worth it (lockfiles.js's, and what builds make).
const SOURCES = { npm: /\.(m|c)?(j|t)sx?$|\.(vue|svelte|astro)$/i, NuGet: /\.(cs|fs|vb|razor|cshtml)$/i };
const SKIP = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', 'TestResults', 'artifacts']);
export const MAX_FILES = 4000;
export const MAX_LINES = 80;
const PER_FILE = 12;
const MAX_BYTES = 512 * 1024;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The expression that finds `pkg`'s imports in a line of source: npm's module names, NuGet's namespaces. */
export function importPattern(pkg) {
  const name = escape(pkg.name);
  if (pkg.ecosystem === 'npm') return new RegExp(`(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*|^\\s*import\\s+|\\bjest\\.mock\\s*\\(\\s*)['"\`]${name}(?:/[^'"\`]*)?['"\`]`);
  // A package's namespaces mostly start with its id (Newtonsoft.Json, Serilog.Sinks…): C#'s using, F#'s open, VB's Imports, Razor's @using.
  return new RegExp(`^\\s*(?:global\\s+)?(?:@?using\\s+(?:static\\s+)?(?:\\w+\\s*=\\s*)?|open\\s+|Imports\\s+)${name}(?:\\.[\\w.]+)?\\s*;?\\s*$`);
}

/** The lines of `text` that import `pkg`: [{ line, text }], at most `max`. */
export function usageLines(text, pkg, max = PER_FILE) {
  const re = importPattern(pkg);
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < max; i++) if (re.test(lines[i])) out.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
  return out;
}

/**
 * The project's lines that import `pkg`, under `root`: [{ path, line, text }] ('/'-separated paths),
 * at most MAX_LINES from at most MAX_FILES files, big files skipped. `signal` stops the walk.
 */
export function findUsages(root, pkg, { signal, maxFiles = MAX_FILES, maxLines = MAX_LINES } = {}) {
  const source = SOURCES[pkg.ecosystem];
  if (!source) return [];
  const out = [];
  let files = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxLines || files >= maxFiles || signal?.aborted) return;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP.has(e.name)) walk(path);
      } else if (e.isFile() && source.test(e.name)) {
        files++;
        try {
          if (statSync(path).size > MAX_BYTES) continue;
          const short = relative(root, path).split(sep).join('/');
          for (const u of usageLines(readFileSync(path, 'utf8'), pkg)) if (out.length < maxLines) out.push({ path: short, ...u });
        } catch {}
      }
    }
  };
  walk(root);
  return out;
}

/** What Claude is asked: the package, the versions, where to read about it, and how to answer. */
export function breakingPrompt(pkg, from, to, { page, repository } = {}) {
  return [
    `This project uses the ${pkg.ecosystem} package ${pkg.name} at ${from}. Its newest version is ${to}, a major version up.`,
    `Say what changes between ${from} and ${to} that matters for this code: the breaking changes it would run into, and what to change.`,
    `Its registry page: ${page}${repository ? `\nIts repository: ${repository} (its release notes, changelog or migration guide say what changed, where you can read them)` : ''}`,
    "Standard input has the lines of this project that import it, each as path:line, found by searching the source. You may read those files, and others, to see how it's used.",
    'Start with two or three sentences: how much work the move is here. Then each breaking change that touches this code, with the files and lines it affects and what to change them to. Then, briefly, the breaking changes that don\'t touch it.',
    "Where you don't know what changed in a version, say so plainly rather than guessing.",
    'The answer is shown as plain text in a terminal 80 to 100 columns wide: short paragraphs, "-" lists and `code` are fine; no tables, no headings deeper than one #.',
  ].join('\n');
}

/** What goes on Claude's standard input: the lines that import the package, or that none were found. */
export function breakingInput(pkg, usages) {
  if (!usages.length) return `No line of this project's source imports ${pkg.name} by its name (it may be used only through another package, a tool, or a build step).`;
  return [`The lines that import ${pkg.name} (${usages.length}${usages.length >= MAX_LINES ? ', the first ones found' : ''}):`, ...usages.map((u) => `${u.path}:${u.line}: ${u.text}`)].join('\n');
}
