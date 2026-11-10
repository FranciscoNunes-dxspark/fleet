// Writes latest.json, what the window's updater reads (Tauri's format): the version, and for each
// platform the file it installs from this version's release (desktop-v<version>) and that file's
// signature. Run on the release job's downloaded artifacts:
//   node scripts/latest-json.mjs <version> <folder with the bundles> > latest.json
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const [version, folder] = process.argv.slice(2);
if (!version || !folder) throw new Error('usage: latest-json.mjs <version> <folder>');
const repo = process.env.GITHUB_REPOSITORY || 'FranciscoNunes-dxspark/fleet';

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(folder);

// Which file each platform updates from: the AppImage on Linux, the NSIS setup on Windows, the app
// archive on macOS (the bundles the updater can install by itself).
const PLATFORMS = {
  'linux-x86_64': (f) => f.endsWith('.AppImage'),
  'windows-x86_64': (f) => /-setup\.exe$/.test(f),
  'darwin-aarch64': (f) => f.endsWith('.app.tar.gz'),
};

const platforms = {};
for (const [platform, matches] of Object.entries(PLATFORMS)) {
  const file = files.find((f) => matches(f) && files.includes(`${f}.sig`));
  if (!file) continue;
  platforms[platform] = {
    signature: readFileSync(`${file}.sig`, 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/desktop-v${version}/${basename(file)}`,
  };
}
if (!Object.keys(platforms).length) throw new Error(`No signed bundles under ${folder}.`);

console.log(JSON.stringify({ version, notes: `Fleet desktop ${version}`, pub_date: new Date().toISOString(), platforms }, null, 2));
