// What ? shows (the kit's HelpView, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-5 / tab', 'Drift, Vault, Expiry, Sources, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['ctrl+p', 'The command palette: every command and this view\'s keys, filtered as you type'],
      ['!', 'Run a shell command, e.g.  !az keyvault list -o table'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
      ['ctrl+r', 'Read the folder, the app and the vault again'],
      [',', 'Settings'],
      ['?', 'This help'],
      ['q', 'Quit'],
      ['mouse', 'Click a tab, a row or the prompt · double-click does ↵ · the wheel scrolls\ndrag to select text, copied when you let go (ctrl+c copies it again; it never quits) · ctrl+v pastes'],
      'Values are never shown, logged or handed to another app: v shows them until esc, y copies one (cleared from the clipboard after 30 s).',
    ],
  },
  {
    title: 'Lists',
    rows: [
      ['j k / ↑ ↓', 'Move'],
      ['g alt+g', 'Top, bottom'],
      ['ctrl+d ctrl+u', 'Page down, up'],
    ],
  },
  {
    title: 'Drift',
    about: "every key of the project's sources, the App Service app's settings and the vault, one row each; the same letter is the same value",
    views: ['drift'],
    rows: [
      ['↵', 'Where it is, and what each source says of it (no values)'],
      ['v', 'Show its values, the vault\'s read now, until esc'],
      ['y', 'Copy one source\'s value (asks first; cleared after 30 s)'],
      ['a', 'Add it to .env, the value from another source (asks first)'],
      ['d', 'Only the rows whose values differ or that are broken, or all'],
      ['m', 'Only the rows a source lacks, or all'],
      ['c', 'Which sources are columns'],
      ['h l / ← →', 'Scroll the columns when they don\'t all fit'],
      ['t', 'Copy the app for Sonar (/appsettings there)'],
      ['o', 'The app in the Azure portal'],
      '= A green: the same in every source · = A = B yellow: they differ · → vault: a Key Vault reference that resolves · ✗ broken: one that doesn\'t (no such secret, disabled, expired), or a disabled or expired secret · ● set: in the vault · · missing.',
    ],
  },
  {
    title: 'Vault',
    about: "the key vault's secrets and certificates: enabled, type, updated, expires; never their values until you ask",
    views: ['vault'],
    rows: [
      ['↵', 'What Key Vault says of it'],
      ['v', 'Show its value until esc'],
      ['y', 'Copy its value (asks first; cleared after 30 s)'],
      ['e', 'A new value, typed hidden: a new version (asks first)'],
      ['n', 'A new secret'],
      ['x', 'Disable it, or enable a disabled one (asks first)'],
      ['o', 'The vault in the Azure portal'],
    ],
  },
  {
    title: 'Expiry',
    about: 'the secrets and certificates that have run out or run out within 30 days (/expiry changes it), soonest first',
    views: ['expiry'],
    rows: [
      ['↵', 'What Key Vault says of it'],
      ['e', 'A new value for a secret (asks first)'],
    ],
  },
  {
    title: 'Sources',
    about: 'what Locker read: the folder\'s .env files, appsettings*.json, user secrets and Hail\'s env files, the app, the vault',
    views: ['sources'],
    rows: [
      ['↵', 'Its keys (values masked)'],
      ['space', 'A column in the drift view, or not'],
    ],
  },
  {
    title: 'Log',
    about: 'what Locker has done, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: 'a key\'s sources, values, output',
    rows: [
      ['j k  space  g alt+g', 'Scroll'],
      ['y alt+y', 'Copy what is on screen, or all of it (values are cleared from the clipboard after 30 s)'],
      ['esc / q', 'Close (values shown are forgotten)'],
    ],
  },
];
