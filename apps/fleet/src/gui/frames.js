// A virtual terminal's row as the window draws it, pure: runs of cells that share a style, each
// [column, text, style, cells]. The style is the SGR parameters vt.js keeps (`''` for none), which the
// window turns into CSS (the client's sgr.js). The window places each run at its column and gives it
// exactly its cells' width, so a font whose characters aren't quite one cell wide can't push the rest
// of the row out of line. A wide character is a run of its own, two cells wide; one whose second half
// is gone draws as a blank, as on a terminal.
import { stringWidth } from '@fleet/kit/text.js';

/** Whether cells of `style` show even when blank: a background, or inverse video. */
export function paintsBlank(style) {
  const parts = String(style ?? '').split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '38') {
      // A colour's own parameters: 38;5;n or 38;2;r;g;b.
      i += parts[i + 1] === '5' ? 2 : 4;
      continue;
    }
    if (p === '48' || p === '7' || /^(4[0-7]|10[0-7])$/.test(p)) return true;
  }
  return false;
}

/** Row cells (`chars`, `styles`) → [[column, text, style, cells], …], trailing blanks that show nothing left out. */
export function rowRuns(chars, styles) {
  const runs = [];
  let run = null;
  const close = () => {
    if (run) runs.push([run.x, run.text, run.style, run.cells]);
    run = null;
  };
  for (let x = 0; x < chars.length; x++) {
    let ch = chars[x];
    if (ch === '') continue;
    const style = styles[x] ?? '';
    const ascii = ch.length === 1 && ch.charCodeAt(0) <= 0x7e;
    if (!ascii && chars[x + 1] === '' && stringWidth(ch) === 2) {
      close();
      runs.push([x, ch, style, 2]);
      continue;
    }
    if (!ascii && stringWidth(ch) === 2) ch = ' ';
    if (!run || run.style !== style) {
      close();
      run = { x, text: '', style, cells: 0 };
    }
    run.text += ch;
    run.cells++;
  }
  close();
  // Blanks at the end of a row draw as nothing unless they're coloured.
  while (runs.length) {
    const last = runs.at(-1);
    if (paintsBlank(last[2])) break;
    const trimmed = last[1].replace(/ +$/, '');
    if (trimmed) {
      runs[runs.length - 1] = [last[0], trimmed, last[2], last[3] - (last[1].length - trimmed.length)];
      break;
    }
    runs.pop();
  }
  return runs;
}
