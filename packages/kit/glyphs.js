// Characters for the console Windows opens a program in when nothing else is set (conhost, with
// Consolas), which draws only what its one font has, with no fallback to another font: anything else
// is a box. Where Splice, Trawl and the others are in such a console, what they write has each
// character Consolas lacks swapped for one it has (its WGL4 set), as wide as the one it replaces (where
// that's two columns, as ⚠ and ▶ are, the stand-in has a space after it).
// Windows Terminal, VS Code's terminal and the others fall back to fonts that have them, and are left alone.

const PLAIN = {
  '‖': '║',
  '↵': '┘',
  '⏎': '┘',
  '↻': '~',
  '⇄': '≡',
  '⇅': '↨',
  '⊘': 'Ø',
  '⎇': '¥',
  '⎿': '└',
  '⏺': '● ',
  '┏': '┌',
  '╭': '┌',
  '╮': '┐',
  '╯': '┘',
  '╰': '└',
  '▁': '_',
  '▂': '_',
  '▃': '▄',
  '▅': '▄',
  '▆': '█',
  '▇': '█',
  '▉': '█',
  '▊': '█',
  '▋': '▌',
  '▍': '▌',
  '▎': '▌',
  '▏': '│',
  '△': '^',
  '▶': '► ',
  '▸': '►',
  '▾': '▼',
  '◀': '◄ ',
  '◂': '◄',
  '◆': '◊',
  '◉': '●',
  '◌': '○',
  '◐': '●',
  '◔': '○',
  '⚠': '! ',
  '✓': '√',
  '✔': '√ ',
  '✕': 'x',
  '✗': 'x',
  '✢': '*',
  '✱': '*',
  '✳': '* ',
  '✶': '*',
  '✻': '*',
  '✽': '*',
  '❚': '▌',
  '❤': '♥',
  '❯': '>',
};
const MISSING = new RegExp(`[${Object.keys(PLAIN).join('')}]`, 'gu');

/** `text` with the characters Consolas lacks swapped for ones it has. */
export function plainGlyphs(text) {
  return text.replace(MISSING, (ch) => PLAIN[ch]);
}

/**
 * Whether the terminal is Windows' own console, which can't fall back to another font: Windows, and
 * none of the variables the other terminals set (Windows Terminal's WT_SESSION, TERM_PROGRAM from
 * VS Code, WezTerm and the like, ConEmu's, and TERM from mintty and the MSYS shells). FLEET_GLYPHS
 * says it outright: `plain` or `full`.
 */
export function plainConsole({ env = process.env, platform = process.platform } = {}) {
  if (env.FLEET_GLYPHS === 'plain') return true;
  if (env.FLEET_GLYPHS === 'full') return false;
  return platform === 'win32' && !env.WT_SESSION && !env.TERM_PROGRAM && !env.ConEmuANSI && !env.TERM;
}

/** Has what's written to `stdout` as text go through plainGlyphs, in Windows' own console. Returns whether it does. */
export function plainOutput(stdout, options) {
  if (!plainConsole(options)) return false;
  const own = stdout.write;
  stdout.write = function (chunk, ...rest) {
    return own.call(this, typeof chunk === 'string' ? plainGlyphs(chunk) : chunk, ...rest);
  };
  return true;
}
