// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note; { heading } starts a part of a section.
// `views` are the views ? opens on that section from. The slash commands come from commands.js, as
// a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-4 / tab', 'Resources, Logs, Problems, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['t', 'The time span Logs and Problems look at: 1h, 24h, 7d, 30d'],
      ['r', 'Read the subscription again'],
      ['!', 'Run a shell command, e.g.  !az account show'],
      ['esc', 'Cancel what is running, or clear the activity lines'],
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
    ],
  },
  {
    title: 'Resources',
    about: "the subscription's web and function apps (ƒ) by resource group, their slots under them",
    views: ['resources'],
    rows: [
      ['↵ / a', 'Its settings: v shows a hidden value (V all), e edits, n adds, x removes, d compares with another slot, y copies'],
      ['R', 'Restart it'],
      ['S', 'Stop it, or start it if it is stopped'],
      ['W', 'Swap a slot into production (on an app, pick the slot)'],
      ['l  p', 'Its logs · its problems'],
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
      ['h l / ← →', 'Across the columns'],
      ['y  Y', 'Copy the row (JSON) · every row (tab-separated)'],
      ['c', 'Which Application Insights to look in (the selected app\'s own by default)'],
    ],
  },
  {
    title: 'Problems',
    about: 'exceptions grouped as Application Insights groups them, most frequent first, with how they went over the span',
    views: ['problems'],
    rows: [
      ['↵', 'The latest occurrence: everything in that operation, in order (requests, dependencies, exceptions, traces)'],
      ['l', 'Its exceptions in Logs'],
      ['y', 'Copy the message'],
      ['c', 'Which Application Insights to look in'],
    ],
  },
  {
    title: 'Log',
    about: 'what has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
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
