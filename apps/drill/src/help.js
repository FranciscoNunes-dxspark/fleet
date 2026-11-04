// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-5 / tab', 'Failures, Tree, Flaky, Output, Log (shift+tab goes back)'],
      ['ctrl+r', 'Look for the tests again and run every one'],
      ['alt+r (R)', 'Run the tests that failed again'],
      ['c', 'Run only the tests touching what git says changed (as Splice shows it): the changed test files, the ones named like a changed file, the ones importing it'],
      ['w', 'Watch: each saved file runs the tests touching it; w again stops'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['!', 'Run a shell command in the folder, e.g.  !npm ls vitest'],
      ['esc', 'Cancel the run, or clear the activity lines'],
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
    title: 'Failures',
    about: 'every failed test, and under it the one the cursor is on: the assertion, expected and actual as a diff, and the stack cut to the project\'s own frames',
    views: ['failures'],
    rows: [
      ['↵ / l', 'Into the failure: j k go from frame to frame'],
      ['↵ on a frame', "Open its file at its line in your editor (/editor, else DRILL_EDITOR, VISUAL or EDITOR; a terminal editor's command is copied instead)"],
      ['h / esc', 'Back to the list'],
      ['r', 'Run this test again'],
      ['o', "Open a Playwright failure's trace in Playwright's trace viewer (npx playwright show-trace)"],
      ['t', "Copy the failure for Splice (a test context: file, line, name, message): Splice blames the file at that line"],
      ['y', 'Copy the failure as text'],
      'Expected is red with -, what came instead green with +. A Playwright failure also lists its screenshot, video and trace.',
    ],
  },
  {
    title: 'Tree',
    about: 'every file, the suites in it and their tests, with how each went and how long it took',
    views: ['tree'],
    rows: [
      ['↵ / l', 'A file or suite folds and unfolds; a test shows its failure (or what it is)'],
      ['f', 'Failures only, or everything'],
      ['r', 'Run the test, the suite or the file again'],
      ['t', 'Copy a test for Splice'],
      ['y', "Copy the test's or file's name"],
      '✗ failed · ✓ passed · ○ skipped · ↻ passed on a retry (flaky). Files and suites say how many of each.',
    ],
  },
  {
    title: 'Flaky',
    about: 'tests that both passed and failed in their last ten runs (kept per project in ~/.drill)',
    views: ['flaky'],
    rows: [
      ['↵', 'Its runs, oldest first'],
      ['r', 'Run it again'],
      ['t', 'Copy it for Splice'],
      '✓ passed · ✗ failed · ↻ passed on a retry.',
    ],
  },
  {
    title: 'Output',
    about: "what the runners wrote as they ran, drawn as a terminal would (colours, progress)",
    views: ['output'],
    rows: [
      ['j k / ↑ ↓  space', 'Look back'],
      ['G', 'Back to the end'],
      ['y', 'Copy what is on screen'],
    ],
  },
  {
    title: 'Log',
    about: 'what Drill has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: 'a test, the settings, output',
    rows: [
      ['j k  space  g alt+g', 'Scroll'],
      ['/ ctrl+f', 'Search: matches light up as you type, ↵ stops typing, n N go from match to match, esc clears it'],
      ['y alt+y', 'Copy what is on screen, or all of it'],
      ['esc / q', 'Close'],
    ],
  },
  {
    title: 'End-to-end tests',
    about: "Playwright's, run only when the app answers",
    rows: [
      'Before Playwright runs, Drill asks the address its config names (baseURL, or webServer\'s url or port; drill.json\'s e2e.url wins) with a plain request. When nothing answers, the tests wait and Drill says what Bosun\'s mood says: start the app in Bosun. Drill never starts a copy of its own.',
    ],
  },
  {
    title: 'In a pipeline',
    about: 'drill run and drill list, without the screen',
    rows: [
      ['drill run [folder]', 'The failures first, then the counts; exits 0 passed, 1 a test failed, 2 couldn\'t run'],
      ['--fail-on <which>', 'any (the default), not-flaky (leaves out the ones known to be flaky), none'],
      ['--runner <name>', 'Only vitest, jest, node, playwright or dotnet (again for more)'],
      ['--changed', 'Only the tests touching what git says changed'],
      ['--json [--all]', 'The result as JSON: counts, each runner, each failure (message, expected, actual, diff, frames), the flaky ones; --all adds every test'],
      ['drill list [folder]', 'The suites found, their versions and where they came from (--json too)'],
    ],
  },
];
