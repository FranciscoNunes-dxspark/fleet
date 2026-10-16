// Lists t()/tj() texts in the given client files that have no Portuguese translation yet:
//   node scripts/missing-pt.mjs client/src/pages/Totals.jsx client/src/platformLabels.js
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const dict = (await import(pathToFileURL('client/src/locales/pt.js').href)).default;
const re = /\bt[j]?\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const missing = new Set();
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(re)) {
    const key = (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"');
    if (!dict[key]) missing.add(key);
  }
}
for (const k of missing) console.log(JSON.stringify(k));
console.log(`${missing.size} missing`);
