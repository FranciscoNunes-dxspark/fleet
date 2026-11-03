// Every string the web app passes to t() or tj() has its European Portuguese text: the kit's translation
// check (codescan.js, Bilge's Code view) over the client, the server and the terminal app as they are,
// which is scripts/missing-pt.mjs run on every file at once. Translations nothing uses and JSX text
// outside t() are Bilge's to show; only a missing one fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18nFindings } from '@fleet/kit/codescan.js';

const root = fileURLToPath(new URL('..', import.meta.url));

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(full));
    else if (/\.(m?js|jsx)$/.test(e.name)) out.push({ path: relative(root, full).split(sep).join('/'), text: readFileSync(full, 'utf8') });
  }
  return out;
}

test('every t() and tj() string in the web app has its Portuguese text', () => {
  const found = i18nFindings(['client', 'server', 'cli'].flatMap((d) => files(join(root, d))));
  const missing = found.filter((f) => f.rule === 'i18n-missing').map((f) => `${f.path}:${f.line} ${f.excerpt}`);
  assert.deepEqual(missing, [], `Add these to client/src/locales/pt/:\n${missing.join('\n')}`);
  // The check did read the dictionaries: what nothing uses shows it found them.
  assert.ok(found.some((f) => f.rule === 'i18n-unused' && f.path.startsWith('client/src/locales/pt/')));
});
