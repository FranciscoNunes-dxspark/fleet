// Copying to the system clipboard, through tools the system already has (as credentials.js does),
// so the compiled build needs no native module: PowerShell's Set-Clipboard on Windows, pbcopy on
// macOS, wl-copy, xclip or xsel on Linux. Over SSH, or when none of them works, it asks the
// terminal instead (OSC 52), which Windows Terminal, iTerm2, kitty, WezTerm and tmux understand.
// Reading it back, for ctrl+v where the terminal doesn't paste by itself, goes through the same tools.
import { execFile } from 'node:child_process';
import { osc52 } from './selection.js';

function run(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
    // A program that isn't there fails through the callback; writing to it mustn't throw as well.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// The text crosses as base64 so no console code page can mangle it.
const POWERSHELL = '$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); Set-Clipboard -Value $t';

function systemCopy(text) {
  if (process.platform === 'win32') return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL], Buffer.from(text, 'utf8').toString('base64'));
  if (process.platform === 'darwin') return run('pbcopy', [], text);
  if (process.env.WAYLAND_DISPLAY) return run('wl-copy', [], text);
  return run('xclip', ['-selection', 'clipboard'], text).catch(() => run('xsel', ['--clipboard', '--input'], text));
}

/** Copies `text`: 'system' when the system's clipboard took it, 'terminal' when it went by OSC 52. */
export async function copyToClipboard(text, { write = (s) => process.stdout.write(s) } = {}) {
  const terminal = () => (write(osc52(text)), 'terminal');
  // Over SSH the system clipboard is the far machine's: only the terminal can reach yours.
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return terminal();
  try {
    await systemCopy(text);
    return 'system';
  } catch {
    return terminal();
  }
}

// Back out as base64 too, for the same reason.
const POWERSHELL_READ = '$t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))) }';

function systemRead() {
  if (process.platform === 'win32') {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_READ], '').then((b64) => Buffer.from(b64.trim(), 'base64').toString('utf8'));
  }
  if (process.platform === 'darwin') return run('pbpaste', [], '');
  if (process.env.WAYLAND_DISPLAY) return run('wl-paste', ['--no-newline'], '');
  return run('xclip', ['-selection', 'clipboard', '-o'], '').catch(() => run('xsel', ['--clipboard', '--output'], ''));
}

/** The system clipboard's text, or '' when there's none or it can't be read (over SSH it's the far machine's). */
export async function readClipboard({ read = systemRead } = {}) {
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return '';
  try {
    return String((await read()) ?? '').replace(/\r\n?/g, '\n');
  } catch {
    return '';
  }
}

/**
 * Makes ctrl+v paste where the terminal sends it on as a key (conhost, or a terminal with no paste
 * binding) rather than pasting itself: the key is taken out of what Ink reads from `stdin`, and the
 * clipboard's text goes back into the stream in its place, which every app takes as a paste. Returns an undo.
 */
export function pasteOnCtrlV(stdin, { read = readClipboard } = {}) {
  const own = stdin.read;
  stdin.read = function (...args) {
    const chunk = own.apply(this, args);
    if (chunk !== '\x16') return chunk;
    read().then((text) => {
      if (text) stdin.unshift(text);
    });
    return own.apply(this, args);
  };
  return () => {
    stdin.read = own;
  };
}
