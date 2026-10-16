// Parse-only syntax check for client files, without a full build:
//   node scripts/check-syntax.mjs client/src/pages/Board.jsx client/src/ui.jsx
// Also flags a file that calls t( / tx( / tj( without importing it from i18n.js.
import fs from 'node:fs';
import { parseAst } from 'rolldown/parseAst';

let failed = false;
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8');
  try {
    parseAst(src, { lang: file.endsWith('x') ? 'jsx' : 'js' });
  } catch (err) {
    failed = true;
    console.log(`${file}: ${err.message.split('\n').slice(0, 6).join('\n')}`);
    continue;
  }
  const imported = (src.match(/import\s*\{([^}]*)\}\s*from\s*'[./]*\/?i18n\.js'/) || [])[1] || '';
  for (const fn of ['t', 'tx', 'tj']) {
    const used = new RegExp(`(^|[^\\w.$])${fn}\\(`).test(src);
    // i18n.js defines them; locale files only mention them in comments.
    if (used && !new RegExp(`\\b${fn}\\b`).test(imported) && !/i18n\.js$|[\\/]locales[\\/]/.test(file)) {
      failed = true;
      console.log(`${file}: uses ${fn}( but doesn't import it from i18n.js`);
    }
  }
}
console.log(failed ? 'FAILED' : 'ok');
process.exit(failed ? 1 : 0);
