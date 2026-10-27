// Moving the fleet to another folder (ctrl+] m, or an app's { move } message): the bar becomes a
// small line editor for the folder, with tab completing folder names, pure but for listing a folder,
// which comes in as `readdir`. The host then starts every running app again there (host.js `moveTo`).
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fit, stringWidth } from '@fleet/kit/text.js';
import { keyLength } from './keys.js';

/** A line being edited: { text, cursor } (the cursor an index into text, at most its length). */
export const lineOf = (text = '') => ({ text, cursor: text.length });

// The last path separator in `s` (either, as Windows takes both), or -1.
const lastSeparator = (s) => Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));

/** `text` with a leading ~ made the home folder. */
export const expandHome = (text, home = homedir()) => (text === '~' ? home : /^~[\\/]/.test(text) ? join(home, text.slice(2)) : text);

/** The folder `text` names, absolute: from `cwd` when it's relative, ~ the home folder. */
export function resolveFolder(text, { cwd = process.cwd(), home = homedir() } = {}) {
  const expanded = expandHome(String(text).trim(), home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** `dir` as the bar says it: under the home folder, from ~. */
export function shortFolder(dir, home = homedir()) {
  if (dir === home) return '~';
  return home && dir.startsWith(home + sep) ? `~${sep}${dir.slice(home.length + 1)}` : dir;
}

/** Whether `dir` is a folder there is. */
export function isFolder(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The folders in `dir` (names), what tab completes from; none when it can't be read. */
export function foldersIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isFolder(join(dir, e.name))))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Completes the folder name being typed at the end of `text`: { text, matches }. One match is
 * completed with a separator after it, several as far as they agree; hidden folders only when the
 * name typed starts with a dot. `readdir(dir)` lists a folder's folders.
 */
export function completeFolder(text, { cwd = process.cwd(), home = homedir(), readdir = foldersIn, caseless = process.platform === 'win32' } = {}) {
  const cut = lastSeparator(text);
  const head = text.slice(0, cut + 1);
  const name = text.slice(cut + 1);
  const dir = head ? resolveFolder(head, { cwd, home }) : resolveFolder('.', { cwd, home });
  const fold = (s) => (caseless ? s.toLowerCase() : s);
  const matches = readdir(dir)
    .filter((n) => fold(n).startsWith(fold(name)) && (name.startsWith('.') || !n.startsWith('.')))
    .sort((a, b) => a.localeCompare(b));
  if (!matches.length) return { text, matches };
  if (matches.length === 1) return { text: `${head}${matches[0]}${text.includes('\\') && !text.includes('/') ? '\\' : '/'}`, matches };
  let common = matches[0];
  for (const m of matches) while (!fold(m).startsWith(fold(common))) common = common.slice(0, -1);
  return { text: `${head}${common.length > name.length ? common : name}`, matches };
}

/**
 * Edits `line` with what was typed: { line, done }, `done` 'submit' (↵), 'cancel' (esc, ctrl+c) or
 * 'complete' (tab: the caller completes, since that reads the disk), else null. Pastes go in as text,
 * without their line breaks; other keys (arrows up and down, the mouse) do nothing.
 */
export function editLine(line, input) {
  let { text, cursor } = line;
  for (let i = 0; i < input.length; ) {
    const n = keyLength(input, i);
    const key = input.slice(i, i + n);
    i += n;
    if (key === '\r' || key === '\n') return { line: { text, cursor }, done: 'submit' };
    if (key === '\x1b' || key === '\x03' || key === '\x07') return { line: { text, cursor }, done: 'cancel' };
    if (key === '\t') return { line: { text, cursor }, done: 'complete' };
    if (key === '\x7f' || key === '\b') {
      if (cursor > 0) {
        text = text.slice(0, cursor - 1) + text.slice(cursor);
        cursor--;
      }
    } else if (key === '\x1b[3~') text = text.slice(0, cursor) + text.slice(cursor + 1);
    else if (key === '\x1b[D' || key === '\x1bOD' || key === '\x02') cursor = Math.max(0, cursor - 1);
    else if (key === '\x1b[C' || key === '\x1bOC' || key === '\x06') cursor = Math.min(text.length, cursor + 1);
    else if (key === '\x1b[H' || key === '\x1bOH' || key === '\x1b[1~' || key === '\x01') cursor = 0;
    else if (key === '\x1b[F' || key === '\x1bOF' || key === '\x1b[4~' || key === '\x05') cursor = text.length;
    else if (key === '\x15') {
      text = text.slice(cursor);
      cursor = 0;
    } else if (key === '\x0b') text = text.slice(0, cursor);
    else if (key === '\x17') {
      // ctrl+w: back to the separator before, as a shell takes a word.
      const before = text.slice(0, cursor).replace(/[^\\/]*[\\/]?$/, '');
      text = before + text.slice(cursor);
      cursor = before.length;
    } else if (key.length && key[0] !== '\x1b' && key.charCodeAt(0) >= 0x20 && key !== '\x7f') {
      text = text.slice(0, cursor) + key + text.slice(cursor);
      cursor += key.length;
    }
  }
  return { line: { text, cursor }, done: null };
}

/**
 * The bar while it asks: `label`, the line with its cursor (inverse), and `hint` at the right, as one
 * line of ANSI text `width` columns wide. The line's start gives way when it's too long to show the
 * cursor.
 */
export function renderAsk({ label, line, hint = '', keep = false, width }) {
  const BAR = '\x1b[0m\x1b[48;5;236m\x1b[38;5;250m';
  const said = ` ${label} `;
  const head = stringWidth(said) > width - 2 ? fit(said, Math.max(0, width - 2)) : said;
  let tail = hint ? `  ${hint} ` : ' ';
  let before = line.text.slice(0, line.cursor);
  const at = line.text.slice(line.cursor, line.cursor + 1) || ' ';
  let after = line.text.slice(line.cursor + 1);
  // With no room for the whole line and the hint, the hint goes first, unless it says something
  // (`keep`: the folders tab found, or that there's no such folder), which then takes up to half.
  if (keep && stringWidth(tail) > width / 2) tail = `  ${fit(hint, Math.max(0, Math.floor(width / 2) - 3))} `;
  const showHint = keep || stringWidth(head) + stringWidth(line.text) + 1 + stringWidth(tail) <= width;
  const room = width - stringWidth(head) - (showHint ? stringWidth(tail) : 1);
  while (before && stringWidth(before) + 1 + 1 > room) before = before.slice(1);
  if (before !== line.text.slice(0, line.cursor)) before = `…${before.slice(1)}`;
  after = fit(after, Math.max(0, room - stringWidth(before) - 1));
  const used = stringWidth(head) + stringWidth(before) + 1 + stringWidth(after);
  const right = showHint ? tail : ' ';
  const gap = Math.max(0, width - used - stringWidth(right));
  const text = `\x1b[1m\x1b[38;5;229m${head}\x1b[22m\x1b[38;5;255m${before}\x1b[7m${at}\x1b[27m${after}${' '.repeat(gap)}\x1b[38;5;244m${right}`;
  return `${BAR}${text}\x1b[0m`;
}
