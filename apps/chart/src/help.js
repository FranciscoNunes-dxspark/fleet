// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-5 / tab', 'Changes, Drift, State, Log, Depends (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['!', 'Run a shell command in the folder, e.g.  !terraform validate'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
      ['ctrl+r', 'The last plan again (or what-if, or file); with none, look at the folder again'],
      ['?', 'This help'],
      ['q', 'Quit'],
      ['mouse', 'Click a tab, a row or the prompt · double-click does ↵ · the wheel scrolls\ndrag to select text, copied when you let go (ctrl+c copies it again; it never quits) · ctrl+v pastes'],
    ],
  },
  {
    title: 'Lists',
    rows: [
      ['j k / ↑ ↓', 'Move'],
      ['g alt+g', 'Top, bottom (in Changes, home: g there is what depends on what)'],
      ['ctrl+d ctrl+u', 'Page down, up'],
    ],
  },
  {
    title: 'Changes',
    about: 'what the plan (/plan), what-if (/whatif) or saved plan (/open) would do, what loses something first. /apply applies a plan Chart saved (or deploys a what-if) once you type the environment\'s or workspace\'s name; a plan opened from a file is never applied',
    views: ['changes'],
    rows: [
      ['↵ / l', 'What changes in it, attribute by attribute (sensitive values never shown), where it is declared, and what it costs a month'],
      ['g', 'What depends on what, on this resource: what destroying or replacing it affects'],
      ['a', 'Show the resources that don\'t change too, or hide them'],
      ['t', 'Copy where it is declared for Splice, whose blame says who wrote it'],
      ['s', 'Copy an App Service app for Locker, which shows its settings'],
      ['y', 'Copy its address'],
      'In red: - destroy and ± replace (with why: an argument that forces replacement, no longer in the configuration…). Yellow ~ update, green + create.',
      "The cost column: what each change adds a month at Azure's retail prices (+$234/month, a destroy negative; usage-priced, on its plan, or no price), the total in the title. /currency changes the currency.",
    ],
  },
  {
    title: 'Drift',
    about: 'what changed outside Terraform since the last apply: the plan\'s own refresh, or /drift (a refresh-only plan)',
    views: ['drift'],
    rows: [
      ['↵ / l', 'What changed, attribute by attribute'],
      ['t', 'Copy where it is declared for Splice'],
      ['s', 'Copy an App Service app for Locker'],
      ['y', 'Copy its address'],
    ],
  },
  {
    title: 'State',
    about: 'every resource Terraform keeps track of, by module (/state)',
    views: ['state'],
    rows: [
      ['↵ / l', 'Its values (sensitive ones masked)'],
      ['t', 'Copy where it is declared for Splice'],
      ['y', 'Copy its address'],
    ],
  },
  {
    title: 'Depends',
    about: "what depends on what: the plan's resources as a tree, under each what depends on it (from the plan's configuration, /graph's terraform graph, or a what-if's resource ids)",
    views: ['depends'],
    rows: [
      ['↵ / l', 'What changes in it, and what destroying or replacing it affects'],
      ['y', 'Copy its address'],
      'In red: what is destroyed or replaced, with how many depend on it. Yellow ← : what depends on one of those.',
    ],
  },
  {
    title: 'Log',
    about: 'what Chart has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: 'a change, a resource, the report, output',
    rows: [
      ['j k  space  g alt+g', 'Scroll'],
      ['/ ctrl+f', 'Search: matches light up as you type, ↵ stops typing, n N go from match to match, esc clears it'],
      ['y alt+y', 'Copy what is on screen, or all of it'],
      ['esc / q', 'Close'],
    ],
  },
  {
    title: 'In a pipeline',
    about: 'chart check, without the screen',
    rows: [
      ['chart check [folder|plan.json]', 'A folder is planned now (terraform, or --tofu); a file is read. It prints what the plan does'],
      ['--fail-on <what>', 'Exit 1 when the plan does it: destroy (the default: a delete or a replacement), replace, change, drift, or none'],
      ['--markdown', 'The plan as Markdown, for a pull request\'s comment'],
      ['--json', 'The summary, changes, drift, outputs and cost as JSON'],
      ['--currency <code> / --no-costs', 'Prices in another currency (USD by default), or none asked for'],
    ],
  },
];
