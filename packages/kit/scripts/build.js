// Compiles an app into standalone executables with Bun (no Node needed to run them). Run it from the
// app's folder (apps/<app>), as its `npm run build` does:
//   bun ../../packages/kit/scripts/build.js                 this machine's platform
//   bun ../../packages/kit/scripts/build.js --all           every release target
//   bun ../../packages/kit/scripts/build.js bun-linux-x64   specific targets
// It reads the app's package.json (the version, and an optional "fleet" section: `entry`, the app's
// entry point, default src/cli.jsx; `app`, its configureApp module, default src/app.js; `out`, the
// output folder, default dist; `compile`, more of Bun's compile options; `includes`, the folders of
// other apps built into this one, as Fleet holds all seven, whose versions are baked in too, each from
// its own package.json) and the app's names from its configureApp module. Output goes to
// <out>/<app>-<platform>[.exe], the names the updater looks for.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { versionVariable as variableOf } from '../app.js';
import { buildTargets } from '../update.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { entry = 'src/cli.jsx', app: appModule = 'src/app.js', out = 'dist', compile = {}, includes = [] } = pkg.fleet ?? {};
const app = await import(pathToFileURL(resolve(appModule)).href);
const { name, title, versionVariable } = app.default ?? app.APP;
const TARGETS = buildTargets(name);
// Each app inside reads its own process.env.<APP>_VERSION (its src/app.js), so each is defined here.
const included = Object.fromEntries(
  includes.map((dir) => {
    const own = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return [`process.env.${variableOf(own.name)}`, JSON.stringify(own.version)];
  }),
);

const args = process.argv.slice(2);
const here = `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const targets = args.includes('--all') ? Object.keys(TARGETS) : args.length ? args : [here];

// Ink only loads react-devtools-core when DEV=true, but the bundler still wants to resolve it.
const noDevtools = {
  name: 'no-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { connectToDevTools() {} };', loader: 'js' }));
  },
};

for (const target of targets) {
  if (!TARGETS[target]) throw new Error(`Unknown target ${target}. Known: ${Object.keys(TARGETS).join(', ')}`);
  const outfile = `${out}/${TARGETS[target]}`;
  // The mascot as the .exe icon: the .ico on the dark square that the app's scripts/logo.js draws
  // (logo.ico, pinch.ico). Bun can only write it when building on Windows, so CI builds that target there.
  const icon = readdirSync('assets').find((f) => f.endsWith('.ico') && !f.includes('transparent'));
  const windows = target.includes('windows') && process.platform === 'win32' ? { icon: `assets/${icon}`, title } : undefined;
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { target, outfile, windows, ...compile },
    minify: true,
    plugins: [noDevtools],
    // The version, as the app's configureApp reads it (process.env.<APP>_VERSION). NODE_ENV picks React's
    // production build (several times faster to draw); defined in the bundle, it never reaches the
    // environment of what the app starts (git, az, its hooks).
    define: { ...included, [`process.env.${versionVariable}`]: JSON.stringify(pkg.version), 'process.env.NODE_ENV': '"production"' },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`${target} → ${outfile}`);
}
