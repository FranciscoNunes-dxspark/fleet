// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note; { heading } starts a part of a section.
// `views` are the views ? opens on that section from. The slash commands come from commands.js, as
// a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-2 / tab', 'Items, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['ctrl+p', 'Command palette: every slash command (yours too) and the keys of the view you\'re in, filtered as you type; ↵ runs one (a command that takes more goes into the prompt)'],
      ['!', 'Run a shell command, e.g.  !node --version'],
      ['r', 'Refresh'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
      [',', 'Settings (/settings): accent colour, mouse, updates, history'],
      ['?', 'This help'],
      ['q / ctrl+c', 'Quit'],
      ['mouse', 'Click a tab, a row or the prompt · double-click does ↵ · the wheel scrolls\ndrag to select text, copied when you let go'],
    ],
  },
  {
    title: 'Lists',
    rows: [
      ['j k / ↑ ↓', 'Move'],
      ['g G', 'Top, bottom'],
      ['ctrl+d ctrl+u', 'Page down, up'],
      ['y', 'Copy it'],
    ],
  },
  {
    title: 'Items',
    views: ['items'],
    rows: [['↵', 'Show the item']],
  },
  {
    title: 'Log',
    about: 'what has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Your own commands and keys',
    about: 'in the settings file (config.json), read when Bosun starts; what\'s wrong with them is said in the log then',
    rows: [
      ['"commands"', '{ "morning": ["/one", "/two"], "v": "!node --version" }: a line as typed at the prompt, or a list run in order, stopping at the first that fails (or that you answer no); { "run": …, "desc": … } gives it a description. They show in the / menu, the palette and Slash commands below'],
      ['$1 $2  $*', 'What\'s typed after it: a word each ("quoted words" are one), or all of it; a command with no $ gets it at the end of its line'],
      ['"keys"', '{ "global": { "ctrl+s": "/settings" }, "items": { "x": "y" } }: a key to another key (the view does what that one does) or to a command line, anywhere or in one view (items, log). They work while a view has the keys, never while typing; Your keys (above Slash commands) lists them'],
      ['key names', 'a character (x, X, +), ctrl+s, alt+x, shift+tab, F1-F12, enter, esc, tab, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown'],
    ],
  },
  {
    title: 'Viewer',
    about: 'output, items',
    rows: [
      ['j k  space  g G', 'Scroll'],
      ['esc / q', 'Close'],
    ],
  },
];
