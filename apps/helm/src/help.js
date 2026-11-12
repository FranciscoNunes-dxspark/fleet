// What F1 shows: sections of [keys, what they do].
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['F5 / ctrl+r', 'Run the whole script'],
      ['F8 / ctrl+e', 'Run the selection, or the current line'],
      ['esc / ctrl+c', 'Stop a running script (the session starts again, without its variables)'],
      ['ctrl+t / alt+1-2', 'Move between the Script and Console views'],
      ['ctrl+s / ctrl+o / ctrl+n', 'Save, open, new script'],
      ['ctrl+l', 'Clear the output'],
      ['F1 / alt+h', 'This help'],
      ['ctrl+q', 'Quit (asks twice when the script has unsaved changes)'],
    ],
  },
  {
    title: 'Script',
    rows: [
      ['shift+arrows', 'Select (also shift+home/end/pgup/pgdn); ctrl+a selects all; esc drops it'],
      ['ctrl+c / ctrl+x', 'Copy / cut the selection; ctrl+v pastes'],
      ['ctrl+z / ctrl+y', 'Undo / redo'],
      ['ctrl+f / ctrl+g', 'Find, then find the next one'],
      ['alt+up / alt+down', 'Give the output more / less room'],
      ['mouse', 'Click to place the cursor, drag to select, the wheel scrolls; click a tab to switch views'],
      ['home / end', 'Home goes to the first character, then the line start'],
    ],
  },
  {
    title: 'Console',
    rows: [
      ['tab', 'Complete the command or path (again for the next match)'],
      ['up / down', 'Earlier commands'],
      ['pgup / pgdn', 'Scroll the output'],
    ],
  },
];
