// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-5 / tab', 'Chunks, Modules, Duplicates, Compare, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['!', 'Run a shell command in the folder, e.g.  !npm run build'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
      ['ctrl+r', 'Read the build again (its stats file, else its output folder) and compare it again'],
      ['/env [name]', "The project's environment (.fleet/project.json), or switch every app to another"],
      ['?', 'This help'],
      ['q', 'Quit'],
      ['mouse', 'Click a tab, a row or the prompt · double-click does ↵ · the wheel scrolls\ndrag to select text, copied when you let go (ctrl+c copies it again; it never quits) · ctrl+v pastes'],
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
    title: 'Chunks',
    about: 'every file the build ships: raw, gzip and brotli (node:zlib, from the files on the disk), its share of the whole, and the budget it is over',
    views: ['chunks'],
    rows: [
      ['↵ / l', 'What is inside it, in Modules'],
      ['s', 'Sort by size or by name'],
      ['c', 'The budgets and the growth, as ballast check sees them'],
      ['y', 'Copy its path'],
      'Budgets come from ballast.json or package.json\'s "fleet": { "ballast": … }; OVER in red marks a file over its own. "entry" marks what a page loads first.',
    ],
  },
  {
    title: 'Modules',
    about: 'what is inside a chunk (or every chunk), biggest first: node_modules grouped by package (its copies under it when it has several), the project\'s own files by folder',
    views: ['modules'],
    rows: [
      ['↵ / l / →', 'Open or close a package or folder; on a file, where it is and what it weighs'],
      ['← / h', 'Close it, or go up to the one it is in'],
      ['c / C', 'The next chunk, the one before (all chunks first)'],
      ['p', 'The package: its copies, what brings each in, its licence and its advisories (OSV)'],
      ['w', 'Copy "/why <package>" for Bilge, which says which manifest brings it in'],
      ['t', 'Copy a file of the project\'s own for Splice, whose history says who made it heavy'],
      ['y', 'Copy its path'],
      'Sizes are each module\'s share of its chunk: the stats\' (or the source map\'s) bytes, scaled to the file; gzip and brotli are estimated at the chunk\'s own ratio.',
    ],
  },
  {
    title: 'Duplicates',
    about: 'packages bundled more than once: at two versions, or one version from two install paths, the most to win first',
    views: ['duplicates'],
    rows: [
      ['↵ / l', 'Each copy: its version, size, what brings it in, and how to keep one'],
      ['p', 'The package: licence and advisories'],
      ['w', 'Copy "/why <package>" for Bilge'],
      ['y', 'Copy its name'],
    ],
  },
  {
    title: 'Compare',
    about: 'this build against the last one read, or main\'s (kept in ~/.ballast by commit; built in a git worktree when it isn\'t, after asking)',
    views: ['compare'],
    rows: [
      ['b', 'Against the last build, or main'],
      ['m', 'The comparison as Markdown, for a pull request'],
      ['↵ / l', 'A chunk\'s or package\'s sizes before and after, and why it changed'],
      ['p', 'The package: licence and advisories'],
      ['w', 'Copy "/why <package>" for Bilge'],
      ['y', 'Copy the headline'],
      '"now imported whole": three times the modules it had, ten at least (an import * or a barrel file). A package\'s size is its share of the chunks it is in.',
    ],
  },
  {
    title: 'Log',
    about: 'what Ballast has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: 'a package, a module, a change, the Markdown, output',
    rows: [
      ['j k  space  g alt+g', 'Scroll'],
      ['/ ctrl+f', 'Search: matches light up as you type, ↵ stops typing, n N go from match to match, esc clears it'],
      ['y alt+y', 'Copy what is on screen, or all of it'],
      ['wheel', 'Scroll'],
      ['esc / q', 'Close'],
    ],
  },
  {
    title: 'In a pipeline',
    about: 'ballast check, compare and security, without the screen',
    rows: [
      ['ballast check [folder]', 'The budgets (and the growth); exits 1 when one fails'],
      ['--budget <glob>=<size>', 'A budget of its own, e.g. dist/assets/index-*.js=180kB (more than one; replaces the file\'s for the same glob)'],
      ['--fail-on <condition>', 'budget, growth>5%, growth>10kB, or none (more than one; ballast.json\'s failOn, else budget)'],
      ['--base last|main|<ref>', 'What growth is against: the last build read, or a ref\'s kept build'],
      ['--base-stats <file>', 'A stats file from a build of the base (main\'s, from its pipeline)'],
      ['--build', 'Build what isn\'t there: this project with stats, or the base in a git worktree'],
      ['ballast compare [folder]', 'The change against --base (last by default); --markdown for a pull request, --json, -o file'],
      ['ballast security [folder]', "Source maps shipped and secrets in the bundles; --json is the family's security JSON, --sarif [file], --fail-on <level>"],
      ['--stats <file> --measure m', 'Read this stats file; measure gzip (the default), brotli or raw'],
    ],
  },
];
