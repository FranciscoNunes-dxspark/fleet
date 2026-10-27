// Writes src/gui/assets.js: the window's files (apps/fleet/gui) and the apps' logos as one module,
// for the compiled build, which has no checkout to read them from (server.js `loadClient`). Run it
// after changing anything in gui/ or a logo: `node scripts/gui-assets.js`. test/gui-assets.test.js
// fails while it's out of date.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadClient } from '../src/gui/server.js';

const out = fileURLToPath(new URL('../src/gui/assets.js', import.meta.url));

/** The module's text for `files`. */
export function assetsModule(files) {
  const lines = [
    '// Written by scripts/gui-assets.js from apps/fleet/gui and the apps\' logos: the window\'s files for the',
    "// compiled build. Don't edit it by hand; run the script.",
    'export const FILES = {',
    ...Object.keys(files)
      .sort()
      .map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(files[name])},`),
    '};',
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(out, assetsModule(await loadClient({ fromDisk: true })));
  console.log(`Wrote ${out}`);
}
