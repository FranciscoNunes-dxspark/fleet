// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note; { heading } starts a part of a section.
// `views` are the views ? opens on that section from. The slash commands come from commands.js, as
// a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-6 / tab', 'Resources, Logs, Problems, Live, Alerts, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['ctrl+p', 'Command palette: every slash command (yours too) and the keys of the view you\'re in, filtered as you type; ↵ runs one (a command that takes more goes into the prompt)'],
      ['t', 'The time span Logs, Problems and the metrics in Resources look at: 1h, 24h, 7d, 30d'],
      ['r', 'Read the subscription again'],
      ['!', 'Run a shell command, e.g.  !az account show'],
      ['esc', 'Cancel what is running, or clear the activity lines'],
      [',', 'Settings (/settings): theme (dark, light, or auto from the terminal), accent colour, mouse, updates, notifying when a job takes over 10 s (a bell and a desktop notification), history'],
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
    ],
  },
  {
    title: 'Resources',
    about: "the subscription's web and function apps (ƒ) by resource group, their slots under them; beside them the one under the cursor, with its metrics over the time span (CPU, memory, 5xx, response time)",
    views: ['resources'],
    rows: [
      ['↵ / a', 'Its settings: v shows a hidden value (V all), e edits, n adds, x removes, d compares with another slot, y copies'],
      ['R', 'Restart it'],
      ['S', 'Stop it, or start it if it is stopped'],
      ['W', 'Swap a slot into production (on an app, pick the slot)'],
      ['D', 'Its deployments: who, when, through what, how it went, which is active; ↵ shows one\'s log'],
      ['l  p', 'Its logs · its problems'],
      ['L', 'Its log as it\'s written, in Live'],
      ['o  b', 'Open it in the Azure portal · open its site'],
      ['y', 'Copy its address'],
      'Anything that changes Azure asks first. For production (an app or resource group named prod, production, prd or live), and for every swap, you type the app\'s name.',
    ],
  },
  {
    title: 'Logs',
    about: 'a KQL query over Application Insights, and what came back',
    views: ['logs'],
    rows: [
      ['e / i', 'Edit the query: tab completes tables, columns and operators, ↑↓ go through the queries run before, ↵ runs it, esc stops editing'],
      ['↵', 'Run the query, or show the row under the cursor whole'],
      ['s', 'Save the query under a name; /queries runs it again, /export <file> saves the grid (.csv, .json, .md)'],
      ['h l / ← →', 'Across the columns'],
      ['y  Y', 'Copy the row (JSON) · every row (tab-separated)'],
      ['H', 'Copy a request row as a request for Hail, to paste into a .http file and send again'],
      ['c', 'Which Application Insights to look in (the selected app\'s own by default)'],
    ],
  },
  {
    title: 'Problems',
    about: 'exceptions grouped as Application Insights groups them, most frequent first, with how they went over the span',
    views: ['problems'],
    rows: [
      ['↵', 'The latest occurrence: everything in that operation, in order (requests, dependencies, exceptions, traces)'],
      ['w', 'Ask Claude why it happens: it reads the latest occurrence, and the code when Sonar was started in the app\'s folder'],
      ['l', 'Its exceptions in Logs'],
      ['y', 'Copy the message'],
      ['c', 'Which Application Insights to look in'],
    ],
  },
  {
    title: 'Live',
    about: "an app's log as it's written (App Service's log stream), the newest at the bottom; it streams while Live is on screen",
    views: ['live'],
    rows: [
      ['j k  g G', 'Scroll back · G follows the end again'],
      ['p', 'Pause, or go on (lines that come meanwhile are dropped)'],
      ['c  R', 'Clear · Reconnect'],
      ['y', 'Copy what\'s there'],
      'Nothing coming? On Linux, an app writes its log to the stream only once App Service logs are on (in the portal: App Service logs, Application logging: File System).',
    ],
  },
  {
    title: 'Alerts',
    about: "the subscription's alerts still firing (metric and log alerts) that began in the time span, most severe first; under them the availability tests of the Application Insights in scope",
    views: ['alerts'],
    rows: [
      ['↵', 'On an alert: all of it (severity, signal, target, rule, when it fired) · on a test: its results in Logs'],
      ['o', 'An alert\'s target in the Azure portal'],
      ['y', 'Copy its name'],
      ['c', 'Which Application Insights the availability tests come from'],
    ],
  },
  {
    title: 'Log',
    about: 'what has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Your own commands and keys',
    about: 'in the settings file (config.json), read when Sonar starts; what\'s wrong with them is said in the log then',
    rows: [
      ['"commands"', '{ "prod": "/sub Contoso Production", "errors": "/kql exceptions | order by timestamp desc | take 50" }: a line as typed at the prompt, or a list run in order, stopping at the first that fails (or that you answer no); { "run": …, "desc": … } gives it a description. They show in the / menu, the palette and Slash commands below'],
      ['$1 $2  $*', 'What\'s typed after it: a word each ("quoted words" are one), or all of it; a command with no $ gets it at the end of its line'],
      ['"keys"', '{ "global": { "ctrl+e": "/kql exceptions | take 50" }, "resources": { "x": "R" } }: a key to another key (the view does what that one does) or to a command line, anywhere or in one view (resources, logs, problems, live, alerts, log). They work while a view has the keys, never while typing; Your keys (above Slash commands) lists them'],
      ['key names', 'a character (x, X, +), ctrl+s, alt+x, shift+tab, F1-F12, enter, esc, tab, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown'],
    ],
  },
  {
    title: 'Viewer',
    about: 'settings compared, a row, an operation',
    rows: [
      ['j k  space  g G', 'Scroll'],
      ['y', 'Copy it'],
      ['esc / q', 'Close'],
    ],
  },
];
