// A run across the project's suites, the same for the app and `drill run`: each suite in turn (the
// end-to-end ones last, and only when the app they test is up), each test marked with the suite it
// came from, and a re-run's tests put back in place of the ones they ran again. Pure but for the
// provider's calls.
import { readMoods } from '@fleet/kit/family.js';
import { appDown } from './e2e.js';
import { countTests } from './model.js';
import { suitePath } from './runners.js';

/** The order suites run in: unit tests first, .NET's next, the end-to-end ones last. */
const ORDER = { vitest: 0, jest: 0, node: 0, dotnet: 1, playwright: 2 };
export const ordered = (suites) => [...suites].sort((a, b) => ORDER[a.runner] - ORDER[b.runner]);

/** Whether `test` (a result's, with `from`, its suite's id) belongs to `suite`. */
export const inSuite = (suite, test) => (test.from ? test.from === suite.id : test.runner === suite.runner && (!suite.dir || test.file.startsWith(`${suite.dir}/`)));

/**
 * Runs `suites` (all of them, or what `tests` or `files` pick in each: a suite none of them is in
 * isn't run). `onSuite(suite, phase, result?)` hears 'start' and 'done' for each; `moods` is read for
 * what Bosun says when the app isn't up. Resolves { results, tests, counts, ranAll }.
 */
export async function runSuites(provider, { root, suites, tests = null, files = null, filesBySuite = null, signal, onData, onSuite = () => {}, moods = () => readMoods('drill') }) {
  const results = [];
  const all = [];
  for (const suite of ordered(suites)) {
    if (signal?.aborted) break;
    const picked = tests ? tests.filter((t) => inSuite(suite, t)) : null;
    if (tests && !picked.length) continue;
    const pickedFiles = filesBySuite ? filesBySuite.get(suite.id) ?? null : files;
    if ((filesBySuite || files) && !tests && !pickedFiles?.length) continue;
    onSuite(suite, 'start');
    let result;
    if (suite.runner === 'playwright' && suite.url) {
      const check = await provider.appUp(suite.url, { signal });
      if (!check.up) result = { suite: suite.id, runner: suite.runner, dir: suite.dir, ran: false, waiting: true, tests: [], errors: [], error: appDown(suite.url, check, moods()) };
    }
    result ??= await provider.runSuite(suite, { root, tests: picked, files: pickedFiles, signal, onData });
    for (const t of result.tests) t.from = suite.id;
    results.push(result);
    all.push(...result.tests);
    onSuite(suite, 'done', result);
  }
  return { results, tests: all, counts: countTests(all), ranAll: results.length > 0 && results.every((r) => r.ran) };
}

/**
 * The tests after a run of some of them: `next`'s in place of the same ids in `prev`, new ones added
 * after their file's, and, where a whole file or suite ran again, the tests it no longer has dropped.
 */
export function mergeTests(prev, next, { rerunFiles = null, rerunSuites = null } = {}) {
  const fresh = new Map(next.map((t) => [t.id, t]));
  const gone = (t) => !fresh.has(t.id) && ((rerunSuites && rerunSuites.has(t.from)) || (rerunFiles && rerunFiles.has(t.file)));
  const out = prev.filter((t) => !gone(t)).map((t) => fresh.get(t.id) ?? t);
  const have = new Set(out.map((t) => t.id));
  for (const t of next) {
    if (have.has(t.id)) continue;
    const at = out.findLastIndex((x) => x.file === t.file);
    if (at >= 0) out.splice(at + 1, 0, t);
    else out.push(t);
    have.add(t.id);
  }
  return out;
}

/**
 * Which suite runs each of `paths` (test files relative to the project): the one whose results had it
 * (`known`, the last run's tests), else by its name and place: C# files to the dotnet suite whose
 * folder holds them (as the classes in them, `classesOf(path)`), an e2e/ or .spec. file to Playwright
 * when there is one, the rest to the first other suite whose folder holds it. A Map of suite id → the
 * paths (or class names) to give it.
 */
export function filesBySuiteOf(suites, paths, { known = [], classesOf = () => [] } = {}) {
  const map = new Map();
  const put = (id, value) => {
    if (!map.has(id)) map.set(id, []);
    for (const v of [].concat(value)) if (!map.get(id).includes(v)) map.get(id).push(v);
  };
  const holds = (s, p) => !s.dir || p.startsWith(`${s.dir}/`);
  for (const p of paths) {
    const seen = known.find((t) => t.file === p && t.from);
    if (seen && suites.some((s) => s.id === seen.from)) {
      put(seen.from, p);
      continue;
    }
    if (/\.(?:cs|fs|vb)$/.test(p)) {
      const s = suites.filter((x) => x.runner === 'dotnet' && holds(x, p)).sort((a, b) => b.dir.length - a.dir.length)[0];
      const classes = classesOf(p);
      if (s && classes.length) put(s.id, classes);
      continue;
    }
    const e2e = suites.find((s) => s.runner === 'playwright' && holds(s, p));
    if (e2e && (/(^|\/)e2e\//.test(p) || /\.spec\.[cm]?[jt]sx?$/.test(p) && !suites.some((s) => s.runner !== 'playwright' && s.runner !== 'dotnet'))) {
      put(e2e.id, p);
      continue;
    }
    const unit = suites.filter((s) => s.runner !== 'playwright' && s.runner !== 'dotnet' && holds(s, p)).sort((a, b) => b.dir.length - a.dir.length)[0];
    if (unit) put(unit.id, p);
  }
  return map;
}

export { suitePath };
