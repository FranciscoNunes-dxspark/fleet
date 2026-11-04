// Which test runners a project has, and where: package.json's scripts and dependencies, the runners'
// config files, and .NET test projects (a .csproj referencing the test SDK, xUnit, NUnit or MSTest).
// A drill.json in the folder says it instead. Pure over a small file-system interface (`fs`: `read(path)`
// → text or null, `list(dir)` → [{ name, dir }]), which the provider gives the disk and tests a map.
import { basename, dirname, join, relative } from 'node:path';
import { RUNNERS } from './parsers/index.js';

export const CONFIG_FILE = 'drill.json';

// Folders never looked in for package.json files, test projects or test files.
export const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'out', 'coverage', 'test-results', 'playwright-report', '.next', '.nuxt', '.svelte-kit', 'vendor', 'target', 'packages-cache']);

const slashes = (p) => p.replace(/\\/g, '/');

/** The project's drill.json, checked: { runners?, e2e?, watch? }, with `problems` saying what's wrong in it. */
export function readDrillJson(text) {
  if (text == null) return null;
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { problems: [`drill.json isn't JSON: ${e.message}`] };
  }
  const problems = [];
  const runners = [];
  for (const [i, r] of (Array.isArray(json.runners) ? json.runners : []).entries()) {
    if (!RUNNERS.includes(r?.runner)) problems.push(`drill.json runners[${i}]: "runner" is one of ${RUNNERS.join(', ')}`);
    else runners.push(r);
  }
  if (json.runners && !Array.isArray(json.runners)) problems.push('drill.json: "runners" is a list');
  const url = typeof json.e2e?.url === 'string' ? json.e2e.url : null;
  if (json.e2e?.url && !/^https?:\/\//.test(json.e2e.url)) problems.push('drill.json: "e2e.url" is an http:// or https:// address');
  return { runners: json.runners ? runners : null, e2e: url && /^https?:\/\//.test(url) ? { url } : null, watch: { ignore: Array.isArray(json.watch?.ignore) ? json.watch.ignore.map(String) : [] }, problems };
}

/** The folders under `root` (itself first) holding a file `want(name)` likes, `depth` levels down at most. */
function findFiles(fs, root, want, depth = 4) {
  const out = [];
  const walk = (dir, level) => {
    for (const e of fs.list(dir) ?? []) {
      if (e.dir) {
        if (level < depth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), level + 1);
      } else if (want(e.name)) out.push(join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

/** The package manager's way of running a package's binary: pnpm exec, yarn, or npx (never installing). */
function execFor(fs, dir, root) {
  for (let d = dir; ; d = dirname(d)) {
    if (fs.read(join(d, 'pnpm-lock.yaml')) != null) return 'pnpm exec';
    if (fs.read(join(d, 'yarn.lock')) != null) return 'yarn';
    if (fs.read(join(d, 'package-lock.json')) != null) return 'npx --no';
    if (d === root || dirname(d) === d) return 'npx --no';
  }
}

/** The version of `pkg` installed for `dir` (its node_modules or one above it, up to `root`'s), or null. */
export function installedVersion(fs, dir, root, pkg) {
  for (let d = dir; ; d = dirname(d)) {
    const text = fs.read(join(d, 'node_modules', ...pkg.split('/'), 'package.json'));
    if (text) {
      try {
        return JSON.parse(text).version ?? null;
      } catch {
        return null;
      }
    }
    if (d === root || dirname(d) === d) return null;
  }
}

const CONFIGS = {
  vitest: /^vitest\.(?:config|workspace)\.[cm]?[jt]s$/,
  jest: /^jest\.config\.(?:[cm]?[jt]s|json)$/,
  playwright: /^playwright\.config\.[cm]?[jt]s$/,
};

/**
 * The address Playwright's tests run against, from its config's text: `baseURL`, else the
 * `webServer`'s `url` (or `port`, on localhost). Null when it names none.
 */
export function playwrightUrl(text) {
  const s = String(text ?? '');
  const base = /\bbaseURL\s*:\s*(?:process\.env\.\w+\s*(?:\?\?|\|\|)\s*)?['"`](https?:\/\/[^'"`]+)['"`]/.exec(s);
  if (base) return base[1];
  const web = /\bwebServer\s*:\s*[{[]([\s\S]*?)[}\]]/.exec(s);
  if (web) {
    const url = /\burl\s*:\s*['"`](https?:\/\/[^'"`]+)['"`]/.exec(web[1]);
    if (url) return url[1];
    const port = /\bport\s*:\s*(\d{2,5})/.exec(web[1]);
    if (port) return `http://localhost:${port[1]}`;
  }
  return null;
}

/** The files and folders after `node --test` in a script ("node --test test/ src/**\/*.test.js"), its options left out. */
export function nodeTestArgs(script) {
  const m = /\bnode\s+(?:[^|&;]*?\s)??--test(?![\w-])([^|&;]*)/.exec(String(script ?? ''));
  if (!m) return null;
  return m[1]
    .trim()
    .split(/\s+/)
    .filter((a) => a && !a.startsWith('-'))
    .map((a) => a.replace(/^['"]|['"]$/g, ''));
}

/** Whether a .NET project file is a test project: the test SDK, a test framework, or IsTestProject. */
export const isTestProject = (text) => /Microsoft\.NET\.Test\.Sdk|"xunit|Include="xunit|Include="NUnit|Include="MSTest|MSTest\.Sdk|<IsTestProject>\s*true/i.test(String(text ?? ''));

/**
 * The suites to run in `root`: [{ id, runner, cwd, dir, exec, version, url?, target?, args?, command? }],
 * and notes on what was found or wrong. `dir` is the suite's folder relative to `root` ('' for it).
 */
export function detect(root, fs) {
  const notes = [];
  const config = readDrillJson(fs.read(join(root, CONFIG_FILE)));
  if (config?.problems?.length) notes.push(...config.problems);
  const suites = [];
  const add = (s) => {
    const dir = slashes(relative(root, s.cwd));
    const id = `${s.runner}:${dir || '.'}${s.target ? `:${basename(s.target)}` : ''}`;
    if (!suites.some((x) => x.id === id)) suites.push({ ...s, dir, id });
  };
  const versionOf = (runner, cwd) => (runner === 'vitest' ? installedVersion(fs, cwd, root, 'vitest') : runner === 'jest' ? installedVersion(fs, cwd, root, 'jest') : runner === 'playwright' ? installedVersion(fs, cwd, root, '@playwright/test') ?? installedVersion(fs, cwd, root, 'playwright') : null);
  const urlOf = (cwd) => {
    if (config?.e2e?.url) return config.e2e.url;
    for (const name of (fs.list(cwd) ?? []).map((e) => e.name).filter((n) => CONFIGS.playwright.test(n))) {
      const url = playwrightUrl(fs.read(join(cwd, name)));
      if (url) return url;
    }
    return null;
  };

  if (config?.runners) {
    for (const r of config.runners) {
      const cwd = join(root, ...String(r.cwd ?? '.').split(/[\\/]/));
      add({
        runner: r.runner,
        cwd,
        exec: execFor(fs, cwd, root),
        version: r.version ?? versionOf(r.runner, cwd),
        ...(typeof r.command === 'string' ? { command: r.command } : {}),
        ...(Array.isArray(r.args) ? { args: r.args.map(String) } : {}),
        ...(typeof r.target === 'string' ? { target: r.target } : {}),
        ...(r.runner === 'playwright' ? { url: urlOf(cwd) } : {}),
        from: 'drill.json',
      });
    }
    return { root, suites, notes, config };
  }

  for (const file of findFiles(fs, root, (n) => n === 'package.json', 3)) {
    let pkg;
    try {
      pkg = JSON.parse(fs.read(file));
    } catch {
      continue;
    }
    const cwd = dirname(file);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = Object.values(pkg.scripts ?? {}).join('\n');
    const names = (fs.list(cwd) ?? []).map((e) => e.name);
    const has = (runner) => names.some((n) => CONFIGS[runner].test(n));
    const base = { cwd, exec: execFor(fs, cwd, root), from: slashes(relative(root, file)) || 'package.json' };
    if (deps.vitest || /\bvitest\b/.test(scripts) || has('vitest')) add({ ...base, runner: 'vitest', version: versionOf('vitest', cwd) });
    if (deps.jest || /\bjest\b/.test(scripts) || has('jest') || pkg.jest) add({ ...base, runner: 'jest', version: versionOf('jest', cwd) });
    const nodeArgs = Object.values(pkg.scripts ?? {}).map(nodeTestArgs).find(Boolean);
    if (nodeArgs) add({ ...base, runner: 'node', version: null, args: nodeArgs });
    if (deps['@playwright/test'] || /\bplaywright test\b/.test(scripts) || has('playwright')) add({ ...base, runner: 'playwright', version: versionOf('playwright', cwd), url: urlOf(cwd) });
  }

  for (const file of findFiles(fs, root, (n) => /\.(?:cs|fs|vb)proj$/.test(n), 5)) {
    if (!isTestProject(fs.read(file))) continue;
    add({ runner: 'dotnet', cwd: dirname(file), target: basename(file), exec: null, version: null, from: slashes(relative(root, file)) });
  }
  if (!suites.length) notes.push('No tests found: no Vitest, Jest, node --test or Playwright in a package.json, and no .NET test project. A drill.json can name them.');
  return { root, suites, notes, config };
}
