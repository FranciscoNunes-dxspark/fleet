// ↵ on a frame: the file at that line in your editor, started through the kit's run.js like every
// other program. Each editor takes a line its own way; the command is built here. A terminal editor
// (vim, nano…) needs the terminal Drill is drawing on, which run.js never gives a program: for those
// Drill copies the command instead. Pure.
import { basename } from 'node:path';
import { quote, safeFile } from './runners.js';

const TERMINAL = new Set(['vi', 'vim', 'nvim', 'nano', 'pico', 'emacs', 'micro', 'hx', 'helix', 'kak', 'ne', 'joe', 'mcedit', 'ed']);
const GOTO = new Set(['code', 'code-insiders', 'codium', 'cursor', 'windsurf', 'positron']);
const COLON = new Set(['subl', 'sublime_text', 'zed', 'mate', 'lapce', 'fleet']);
const JETBRAINS = new Set(['idea', 'idea64', 'rider', 'rider64', 'webstorm', 'webstorm64', 'pycharm', 'goland', 'clion', 'phpstorm', 'rubymine']);

/** The editor to use: the setting, else DRILL_EDITOR, VISUAL or EDITOR; null when none is set. */
export const editorSetting = (config = {}, env = process.env) => config.editor || env.DRILL_EDITOR || env.VISUAL || env.EDITOR || null;

/**
 * The command opening `file` (absolute) at `line`: { command, terminal } where `terminal` says the
 * editor runs in a terminal; null when the editor or the file can't go in a command line. The setting
 * may carry options ("code --reuse-window"); --wait and -w are dropped, as nothing waits for it.
 */
export function editorCommand(editor, file, line, { column, platform = process.platform } = {}) {
  const words = String(editor ?? '').trim().match(/"[^"]*"|\S+/g) ?? [];
  if (!words.length || !safeFile(file)) return null;
  const program = words[0].replace(/^"|"$/g, '');
  if (!safeFile(program)) return null;
  const options = words.slice(1).filter((w) => w !== '--wait' && w !== '-w' && /^[\w=.:,-]+$/.test(w));
  const name = basename(program).replace(/\.(?:exe|cmd|bat|sh)$/i, '').toLowerCase();
  const q = (a) => quote(a, platform);
  const at = Number(line) > 0 ? Number(line) : null;
  const head = [q(program), ...options];
  let args;
  if (GOTO.has(name)) args = at ? ['-g', q(`${file}:${at}${column ? `:${column}` : ''}`)] : [q(file)];
  else if (COLON.has(name)) args = [q(at ? `${file}:${at}${column ? `:${column}` : ''}` : file)];
  else if (JETBRAINS.has(name)) args = at ? ['--line', String(at), q(file)] : [q(file)];
  else if (name === 'notepad++') args = at ? [`-n${at}`, q(file)] : [q(file)];
  else if (TERMINAL.has(name)) args = at ? [`+${at}`, q(file)] : [q(file)];
  else args = [q(file)];
  return { command: [...head, ...args].join(' '), terminal: TERMINAL.has(name) };
}
