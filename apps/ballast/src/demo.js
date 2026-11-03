// An in-memory project with the provider's interface, for `ballast --demo` and the tests: a Vite shop
// whose feature branch moved to date-fns 4 and imports all of it (main had three functions of date-fns
// 2), a date picker that still brings date-fns 2 (two versions bundled), tslib twice through two paths,
// lodash whole, a budget the main chunk is over, source maps shipped and a key in the bundle. Its
// build goes through the same parser as rollup-plugin-visualizer's data. Nothing is read, built or
// asked. `state` is the tests' handle: what it holds and `calls`, what was asked of it.
// bilge-ignore-file: its made-up secret is there to be found in the demo, not in Ballast.
import { join } from 'node:path';
import { parseVisualizer } from './stats.js';
import { finishChunk } from './build.js';
import { summarize } from './compare.js';
import { readBudgets } from './budgets.js';
import { bundleSecrets, mapFinding } from './security.js';
import { lastRun } from './history.js';

export const DEMO_COMMIT = 'c0ffee15e2a94b7d8f3a6c1e0b9d2f4a7c8e5d13';
export const DEMO_LAST = 'b4d5e6f70a1b2c3d4e5f60718293a4b5c6d7e8f9';
export const DEMO_MAIN = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const DAY = 24 * 60 * 60 * 1000;

// date-fns's functions, each a module of its own: imported whole (`import * as`, or one barrel import)
// they all come along.
const DATE_FNS = 'add addBusinessDays addDays addHours addISOWeekYears addMilliseconds addMinutes addMonths addQuarters addSeconds addWeeks addYears areIntervalsOverlapping clamp closestIndexTo closestTo compareAsc compareDesc constructFrom constructNow daysToWeeks differenceInBusinessDays differenceInCalendarDays differenceInCalendarISOWeekYears differenceInCalendarISOWeeks differenceInCalendarMonths differenceInCalendarQuarters differenceInCalendarWeeks differenceInCalendarYears differenceInDays differenceInHours differenceInISOWeekYears differenceInMilliseconds differenceInMinutes differenceInMonths differenceInQuarters differenceInSeconds differenceInWeeks differenceInYears eachDayOfInterval eachHourOfInterval eachMinuteOfInterval eachMonthOfInterval eachQuarterOfInterval eachWeekOfInterval eachWeekendOfInterval eachWeekendOfMonth eachWeekendOfYear eachYearOfInterval endOfDay endOfDecade endOfHour endOfISOWeek endOfISOWeekYear endOfMinute endOfMonth endOfQuarter endOfSecond endOfToday endOfTomorrow endOfWeek endOfYear endOfYesterday format formatDistance formatDistanceStrict formatDistanceToNow formatDistanceToNowStrict formatDuration formatISO formatISO9075 formatISODuration formatRFC3339 formatRFC7231 formatRelative fromUnixTime getDate getDay getDayOfYear getDaysInMonth getDaysInYear getDecade getDefaultOptions getHours getISODay getISOWeek getISOWeekYear getISOWeeksInYear getMilliseconds getMinutes getMonth getOverlappingDaysInIntervals getQuarter getSeconds getTime getUnixTime getWeek getWeekOfMonth getWeekYear getWeeksInMonth getYear hoursToMilliseconds interval intervalToDuration intlFormat intlFormatDistance isAfter isBefore isDate isEqual isExists isFirstDayOfMonth isFriday isFuture isLastDayOfMonth isLeapYear isMatch isMonday isPast isSameDay isSameHour isSameISOWeek isSameMinute isSameMonth isSameQuarter isSameSecond isSameWeek isSameYear isValid isWeekend isWithinInterval lastDayOfMonth lightFormat max min parse parseISO parseJSON startOfDay startOfHour startOfISOWeek startOfMonth startOfQuarter startOfWeek startOfYear sub subDays subMonths toDate'.split(' ');

const own = (extra = 0) => [
  ['src/main.jsx', 1240],
  ['src/App.jsx', 3420],
  ['src/pages/Checkout.jsx', 8130 + extra],
  ['src/pages/Products.jsx', 6210],
  ['src/components/Cart.jsx', 4420],
  ['src/components/ProductCard.jsx', 2890],
  ['src/lib/api.js', 3110],
  ['src/lib/format.js', 1830],
  ['src/store/cart.js', 2240],
  ['\0vite/preload-helper.js', 1910],
];
const shared = [
  ['node_modules/lodash/lodash.js', 71530],
  ['node_modules/axios/lib/core/Axios.js', 5210],
  ['node_modules/axios/lib/adapters/xhr.js', 7340],
  ['node_modules/axios/lib/helpers/buildURL.js', 1420],
  ['node_modules/axios/lib/utils.js', 9870],
  ['node_modules/axios/lib/defaults/index.js', 3880],
  ['node_modules/axios/lib/core/AxiosError.js', 2310],
  ['node_modules/axios/lib/axios.js', 1960],
  ['node_modules/axios/lib/core/AxiosHeaders.js', 4120],
  ['node_modules/zustand/esm/index.mjs', 1890],
  ['node_modules/zustand/esm/vanilla.mjs', 1210],
  ['node_modules/tslib/tslib.es6.mjs', 10240],
  ['node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs', 14820],
  ['node_modules/@floating-ui/core/dist/floating-ui.core.mjs', 11630],
];
const vendor = [
  ['node_modules/react/cjs/react.production.min.js', 6930],
  ['node_modules/react/index.js', 190],
  ['node_modules/react-dom/cjs/react-dom.production.min.js', 131840],
  ['node_modules/react-dom/client.js', 620],
  ['node_modules/scheduler/cjs/scheduler.production.min.js', 4180],
];
const pickerOf = (dateFns) => [
  ['src/pages/Calendar.jsx', 5120],
  ['node_modules/react-datepicker/dist/es/index.js', 48310],
  ...['format', 'addDays', 'addMonths', 'subMonths', 'parseISO', 'startOfWeek', 'endOfWeek', 'startOfMonth', 'endOfMonth', 'isSameDay', 'isSameMonth', 'isBefore', 'isAfter', 'getDay'].map((f, i) => [`${dateFns}/esm/${f}/index.js`, 1400 + ((i * 337) % 900)]),
];

/** rollup-plugin-visualizer's raw data for `chunks` ({ file: [[id, bytes]] }), as a Vite build writes it. */
export function visualizerData(chunks) {
  const nodeMetas = {};
  const nodeParts = {};
  let n = 0;
  for (const [file, modules] of Object.entries(chunks)) {
    for (const [id, bytes] of modules) {
      const meta = Object.values(nodeMetas).find((m) => m.id === `/${id.replace(/^\0/, '')}` || m.id === id);
      const metaUid = meta?.uid ?? `d3m0-${n++}`;
      const partUid = `d3m0-${n++}`;
      nodeParts[partUid] = { renderedLength: bytes, gzipLength: 0, brotliLength: 0, metaUid };
      if (meta) meta.moduleParts[file] = partUid;
      else nodeMetas[metaUid] = { uid: metaUid, id: id.startsWith('\0') ? id : `/${id}`, moduleParts: { [file]: partUid }, imported: [], importedBy: [], ...(id === 'src/main.jsx' ? { isEntry: true } : {}) };
    }
  }
  return { version: 2, tree: { name: 'root', children: [] }, nodeParts, nodeMetas, env: { rollup: '4.24.0' }, options: { gzip: false, brotli: false, sourcemap: false } };
}

// What a demo file weighs compressed, in place of zlib on files that aren't there.
const RATIO = { js: [0.31, 0.27], css: [0.2, 0.17], html: [0.5, 0.42] };

const VERSIONS = {
  'node_modules/lodash': '4.17.20',
  'node_modules/axios': '1.6.7',
  'node_modules/zustand': '4.5.2',
  'node_modules/tslib': '2.6.2',
  'node_modules/@floating-ui/dom': '1.6.3',
  'node_modules/@floating-ui/core': '1.6.0',
  'node_modules/@floating-ui/dom/node_modules/tslib': '2.6.2',
  'node_modules/react': '18.3.1',
  'node_modules/react-dom': '18.3.1',
  'node_modules/scheduler': '0.23.2',
  'node_modules/react-datepicker': '6.9.0',
  'node_modules/react-datepicker/node_modules/date-fns': '2.30.0',
};

const LICENCES = { lodash: 'MIT', axios: 'MIT', zustand: 'MIT', tslib: '0BSD', '@floating-ui/dom': 'MIT', '@floating-ui/core': 'MIT', react: 'MIT', 'react-dom': 'MIT', scheduler: 'MIT', 'react-datepicker': 'MIT', 'date-fns': 'MIT' };

/** A demo build at `root`: `head` the feature branch's, else main's. */
export function demoBuild(root, { head = true, extra = 0 } = {}) {
  const dateFns = head ? DATE_FNS.map((f, i) => [`node_modules/date-fns/${f}.js`, 650 + ((i * 523) % 1000)]) : ['format', 'addDays', 'parseISO'].map((f, i) => [`node_modules/date-fns/esm/${f}/index.js`, [9820, 1460, 3310][i]]);
  const versions = { ...VERSIONS, 'node_modules/date-fns': head ? '4.1.0' : '2.30.0' };
  // In main, the picker shares date-fns 2 with the app; on the branch, npm nests its own copy.
  const picker = pickerOf(head ? 'node_modules/react-datepicker/node_modules/date-fns' : 'node_modules/date-fns');
  // tslib twice: the app's, and the copy @floating-ui/dom's range kept for itself.
  const sharedHere = head ? [...shared, ['node_modules/@floating-ui/dom/node_modules/tslib/tslib.es6.mjs', 10240]] : shared;
  const data = visualizerData({
    'assets/index-B7xk2Lq9.js': [...own(extra), ...sharedHere, ...dateFns],
    'assets/vendor-react-Cq81Ma0d.js': vendor,
    'assets/calendar-D2kLp0aZ.js': picker,
  });
  const parsed = parseVisualizer(data);
  const chunks = parsed.chunks.map((c) => {
    const [g, b] = RATIO.js;
    return finishChunk({ file: `dist/${c.name}`, sizes: { raw: c.bytes, gzip: Math.round(c.bytes * g), brotli: Math.round(c.bytes * b) }, modules: c.modules, entry: c.entry }, { versionAt: (p) => versions[p] ?? null });
  });
  for (const [file, raw, kind] of [
    ['dist/assets/index-Ds81mQa1.css', 38210, 'css'],
    ['dist/index.html', 912, 'html'],
  ]) {
    chunks.push(finishChunk({ file, sizes: { raw, gzip: Math.round(raw * RATIO[kind][0]), brotli: Math.round(raw * RATIO[kind][1]) } }));
  }
  chunks.sort((a, b) => b.gzip - a.gzip);
  const licences = {};
  for (const c of chunks) for (const m of c.modules) if (m.pkg?.version) licences[`${m.pkg.name}@${m.pkg.version}`] = LICENCES[m.pkg.name] ?? null;
  return { root, tool: 'rollup', source: { kind: 'stats', path: 'dist/stats.json', label: 'rollup-plugin-visualizer data, dist/stats.json' }, chunks, licences, lock: 'package-lock.json', at: Date.now() };
}

// OSV's answers for the demo's packages, as advisories.js gives them.
const ADVISORIES = {
  'lodash@4.17.20': [
    { id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], summary: 'Command Injection in lodash', severity: 'high', score: 7.2, fixed: '4.17.21', url: 'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm' },
    { id: 'GHSA-29mw-wpgm-hmr9', aliases: ['CVE-2020-28500'], summary: 'Regular Expression Denial of Service (ReDoS) in lodash', severity: 'medium', score: 5.3, fixed: '4.17.21', url: 'https://osv.dev/vulnerability/GHSA-29mw-wpgm-hmr9' },
  ],
  'axios@1.6.7': [{ id: 'GHSA-8hc4-vh64-cxmj', aliases: ['CVE-2024-39338'], summary: 'Server-Side Request Forgery in axios', severity: 'high', fixed: '1.7.4', url: 'https://osv.dev/vulnerability/GHSA-8hc4-vh64-cxmj' }],
};

// The demo bundle's text where the key sits: a value the build inlined from the environment.
const KEY = ['sk', 'live', 'Zq8Xv3Lm0Rt5Wy2Bn7Kd4Hs9'].join('_');
const BUNDLE_TEXT = `const e=${JSON.stringify(`${'x'.repeat(40)}`)};function t(){return fetch("/api/pay",{headers:{"x-key":"${KEY}"}})}export{t as pay};\n//# sourceMappingURL=index-B7xk2Lq9.js.map\n`;

export function demoBallast({ noStats = false, mainSaved = true, budgets = null } = {}) {
  const now = Date.now();
  const state = {
    calls: [],
    written: new Map(),
    noStats,
    built: false,
    runs: [],
    budgets: budgets ?? { budgets: { 'dist/assets/index-*.js': '100kB', total: '250kB' }, failOn: ['budget', 'growth>10%'], measure: 'gzip' },
  };
  // The branch's build of yesterday (Checkout a little smaller), and main's, kept as if read before.
  const root = join('/', 'demo', 'shop');
  state.runs.push(summarize(demoBuild(root, { extra: -1500 }), { commit: DEMO_LAST, branch: 'feature/calendar', at: now - DAY }));
  if (mainSaved) state.runs.push(summarize(demoBuild(root, { head: false }), { commit: DEMO_MAIN, branch: 'main', at: now - 2 * DAY }));
  return {
    name: 'demo',
    state,
    async read(dir, { stats = null } = {}) {
      state.calls.push(['read', dir, stats]);
      if (state.noStats && !state.built) return { root: dir, tool: null, source: { kind: 'none', label: 'nothing read' }, chunks: [], licences: {}, lock: 'package-lock.json', at: Date.now() };
      return demoBuild(dir);
    },
    budgets(dir) {
      state.calls.push(['budgets', dir]);
      return { ...readBudgets(state.budgets), from: 'ballast.json' };
    },
    plan(dir) {
      return { tool: 'vite', command: `npx vite build --sourcemap --emptyOutDir --outDir "${join('/', 'tmp', 'ballast-demo', 'vite')}"`, outDir: join('/', 'tmp', 'ballast-demo', 'vite'), outLabel: 'dist', text: "Vite's build with source maps into a folder of Ballast's own (your dist/ is left alone); its maps say what each chunk holds." };
    },
    async build(dir, plan) {
      state.calls.push(['build', plan.command]);
      state.built = true;
      return demoBuild(dir);
    },
    async git(dir) {
      state.calls.push(['git', dir]);
      return { commit: DEMO_COMMIT, branch: 'feature/calendar', dirty: false };
    },
    async resolveRef(dir, ref) {
      state.calls.push(['resolveRef', ref]);
      if (ref === 'main' || DEMO_MAIN.startsWith(ref)) return DEMO_MAIN;
      if (DEMO_LAST.startsWith(ref)) return DEMO_LAST;
      return null;
    },
    async buildRef(dir, commit, { progress = () => {} } = {}) {
      state.calls.push(['buildRef', commit]);
      progress('building (vite)');
      return demoBuild(dir, { head: commit !== DEMO_MAIN ? true : false });
    },
    runs: () => state.runs,
    saveRun(root, summary) {
      state.calls.push(['saveRun', summary.key]);
      state.runs = [summary, ...state.runs.filter((r) => r.key !== summary.key)];
      return state.runs;
    },
    lastRun: (key) => lastRun(state.runs, key),
    async advisories(list) {
      state.calls.push(['advisories', list.map((p) => `${p.name}@${p.version}`)]);
      return new Map(list.map((p) => [`${p.name}@${p.version}`, ADVISORIES[`${p.name}@${p.version}`] ?? []]));
    },
    async security(dir) {
      state.calls.push(['security', dir]);
      const maps = ['dist/assets/index-B7xk2Lq9.js.map', 'dist/assets/vendor-react-Cq81Ma0d.js.map', 'dist/assets/calendar-D2kLp0aZ.js.map'].map((path) => ({ path, sources: true }));
      return { dirs: ['dist'], files: 8, findings: [...bundleSecrets('dist/assets/index-B7xk2Lq9.js', BUNDLE_TEXT), mapFinding('dist', maps)] };
    },
    writeFile(path, text) {
      state.written.set(path, text);
    },
    explain: (e) => String(e?.message ?? '').split('\n')[0],
  };
}
