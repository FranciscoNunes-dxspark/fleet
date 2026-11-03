// How to build a project once with stats turned on, when it has none to read, and how to install a
// copy of it (a git worktree of main) first. Pure: the provider runs what these say, after asking.
//
// - Vite: `vite build --sourcemap --outDir <temp>`, into a folder of Ballast's own so the project's
//   dist/ (deployed, maybe) never gets source maps; the maps say what each chunk holds, and the files
//   are named as they would be in dist/.
// - webpack: `webpack --json <temp>/stats.json`: its stats, the build itself where it always goes.
// - esbuild called by the build script: the same command with --metafile=<temp>/meta.json.
// - Anything else with a build script: the script, then a look at the output folder it fills.

/** A path the plan may put in a command line: no quote, nothing a shell would read as more. */
export const safePath = (p) => typeof p === 'string' && p.length > 0 && !/["`$\n\r%!]/.test(p);

/** A git ref Ballast will put in a command line: main, origin/main, a tag, a commit. */
export const safeRef = (ref) => typeof ref === 'string' && /^[\w][\w./-]{0,199}$/.test(ref) && !ref.includes('..');

/** The package manager a folder's lock file says: npm, yarn or pnpm. */
export function packageManager(files) {
  if (files.has('pnpm-lock.yaml')) return 'pnpm';
  if (files.has('yarn.lock')) return 'yarn';
  return 'npm';
}

/** The command that installs the project exactly as its lock file says (for a worktree of main). */
export function installCommand(files) {
  const pm = packageManager(files);
  if (pm === 'pnpm') return 'pnpm install --frozen-lockfile';
  if (pm === 'yarn') return files.has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
  return files.has('package-lock.json') || files.has('npm-shrinkwrap.json') ? 'npm ci' : 'npm install';
}

/**
 * The build with stats for a project: { tool, command, statsPath?, outDir?, outLabel?, text } or null
 * when nothing says how it builds. `pkg` is its package.json, `files` the names in its folder, `temp`
 * a folder of Ballast's own for what the build writes.
 */
export function buildPlan({ pkg = {}, files = new Set(), temp }) {
  if (!safePath(temp)) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = String(pkg.scripts?.build ?? '');
  const run = packageManager(files) === 'npm' ? 'npm run build' : `${packageManager(files)} run build`;
  const has = (re) => [...files].some((f) => re.test(f));
  if (deps.vite || has(/^vite\.config\.[mc]?[jt]s$/) || /\bvite build\b/.test(script)) {
    const outDir = `${temp}/vite`;
    return { tool: 'vite', command: `npx vite build --sourcemap --emptyOutDir --outDir "${outDir}"`, outDir, outLabel: 'dist', text: `Vite's build with source maps into a folder of Ballast's own (your dist/ is left alone); its maps say what each chunk holds.` };
  }
  if (deps.webpack || has(/^webpack\.config\.[mc]?[jt]s$/) || /\bwebpack\b/.test(script)) {
    const statsPath = `${temp}/stats.json`;
    return { tool: 'webpack', command: `npx webpack --mode production --json "${statsPath}"`, statsPath, text: 'webpack\'s production build, writing its stats beside it.' };
  }
  if (/^\s*esbuild\s/.test(script) && !/[;&|<>]/.test(script)) {
    const statsPath = `${temp}/meta.json`;
    return { tool: 'esbuild', command: `npx ${script.trim()} --metafile="${statsPath}"`, statsPath, text: 'The build script\'s esbuild, writing its metafile.' };
  }
  if (script) return { tool: 'script', command: run, text: 'The build script; then a look at the output folder it fills (no stats: sizes, and what source maps say).' };
  return null;
}
