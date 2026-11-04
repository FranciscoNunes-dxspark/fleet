// The project's files Pilot reads, found by walking the folder: views, C#, scripts, styles and the
// build configs that say what compiles to what. Build output, packages and tools' folders are left
// out; libraries (wwwroot/lib, *.min.js, jquery-*.js) are kept so references to them resolve, but
// marked `vendor` and not read for selectors unless asked.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', 'packages', 'TestResults', '.git', '.vs', '.vscode', '.idea', '.pilot', 'bower_components', 'jspm_packages', '.angular', '.nuget', 'artifacts', 'publish', 'App_Data']);

const KINDS = {
  '.cshtml': 'view',
  '.vbhtml': 'view',
  '.cs': 'cs',
  '.ts': 'script',
  '.tsx': 'script',
  '.js': 'script',
  '.jsx': 'script',
  '.mjs': 'script',
  '.less': 'style',
  '.scss': 'style',
  '.css': 'style',
  '.csproj': 'project',
};
const CONFIGS = new Set(['bundleconfig.json', 'compilerconfig.json', 'tsconfig.json', 'webpack.config.js']);

const VENDOR = /(^|\/)(lib|libs|vendor|vendors|third[-_]?party|externals?|bower_components|node_modules)\/|\.min\.(js|css)$|\.d\.ts$|(^|\/)(jquery|bootstrap|modernizr|respond|knockout|angular|kendo|select2|moment|popper|globalize|underscore|lodash|backbone|require|font-awesome|toastr|datatables|_references)[\w.-]*\.(js|css|less)$/i;

export const isVendor = (rel) => VENDOR.test(rel);

/** The kind Pilot reads a file as, or null for files it leaves alone. */
export function kindOf(name) {
  const lower = name.toLowerCase();
  if (CONFIGS.has(lower)) return 'config';
  if (/\.(js|css)\.map$/.test(lower) || lower.endsWith('.designer.cs') || lower.endsWith('.g.cs')) return null;
  const ext = /\.[^.]+$/.exec(lower)?.[0];
  return KINDS[ext] ?? null;
}

/**
 * Every file under `root` Pilot reads: [{ rel, kind, size, mtime }], `rel` `/`-separated. `ignore` is a
 * list of folder names or path prefixes to leave out besides SKIP_DIRS.
 */
export function walk(root, { ignore = [], maxFiles = 200000 } = {}) {
  const out = [];
  const prefixes = ignore.filter((i) => i.includes('/')).map((i) => i.replace(/^\/+|\/+$/g, '') + '/');
  const names = new Set(ignore.filter((i) => !i.includes('/')));
  const visit = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || names.has(e.name) || (e.name.startsWith('.') && e.name !== '.well-known')) continue;
        if (prefixes.some((p) => `${r}/`.startsWith(p))) continue;
        visit(join(dir, e.name), r);
      } else if (e.isFile()) {
        const kind = kindOf(e.name);
        if (!kind) continue;
        try {
          const st = statSync(join(dir, e.name));
          out.push({ rel: r, kind, size: st.size, mtime: Math.floor(st.mtimeMs) });
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
  };
  visit(root, '');
  return out;
}
