// Compiles the terminal app (cli/) into standalone executables with Bun (no Node or checkout needed to run them).
//   npm run build:cli                    this machine's platform
//   npm run build:cli -- --all           every release target
//   bun scripts/build-cli.js bun-linux-x64   specific targets
// Output goes to release/ (dist/ is the web UI's).
import pkg from '../package.json' with { type: 'json' };

const TARGETS = {
  'bun-windows-x64': 'keel-windows-x64.exe',
  'bun-linux-x64': 'keel-linux-x64',
  'bun-linux-arm64': 'keel-linux-arm64',
  'bun-darwin-x64': 'keel-macos-x64',
  'bun-darwin-arm64': 'keel-macos-arm64',
};

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
  const outfile = `release/${TARGETS[target]}`;
  // Pinch as the .exe's icon (scripts/logo.mjs draws it). Bun can only write it when building on Windows,
  // so the release builds that target there.
  const windows = target.includes('windows') ? { title: 'Keel', ...(process.platform === 'win32' ? { icon: 'assets/pinch.ico' } : {}) } : undefined;
  const result = await Bun.build({
    entrypoints: ['cli/cli.jsx'],
    // Bun would otherwise load a .env and bunfig.toml from whatever folder it's run in; Keel reads ~/.keel/.env itself.
    compile: { target, outfile, windows, autoloadDotenv: false, autoloadBunfig: false },
    minify: true,
    plugins: [noDevtools],
    // KEEL_VERSION also tells server/root.js to look for .env and data in ~/.keel. NODE_ENV picks React's production build.
    define: { 'process.env.KEEL_VERSION': JSON.stringify(pkg.version), 'process.env.NODE_ENV': '"production"' },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`${target} → ${outfile}`);
}
