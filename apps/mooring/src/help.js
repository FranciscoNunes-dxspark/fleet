// What ? shows (the kit's HelpView, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-5 / tab', 'Files, Transfers, Console, Hosts, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['ctrl+p', "The command palette: every command and this view's keys, filtered as you type"],
      ['!', 'Run a shell command on this machine, e.g.  !ssh-add -l'],
      ['$', 'Run a command on the server, in the folder the right pane shows, e.g.  $ ls -l  (the output is in Console)'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
      ['ctrl+r', 'Read both folders again'],
      [',', 'Settings'],
      ['?', 'This help'],
      ['q', 'Quit'],
      ['mouse', 'Click a tab, a pane or a row · double-click does ↵ · the wheel scrolls\ndrag to select text, copied when you let go (ctrl+c copies it again; it never quits) · ctrl+v pastes'],
      "Mooring runs ssh without a terminal: it signs in with a key or your ssh agent, or with a password for a host saved with /add … password (asked for, masked, every time it connects, and never saved). A host ssh doesn't know yet is offered for trust (its fingerprint shown: compare it with one you know); a changed key is never offered.",
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
    title: 'Files',
    about: "this machine's folder on the left, the server's on the right; the focused pane has the bright border",
    views: ['files'],
    rows: [
      ['← → / h l', 'Focus the left or the right pane'],
      ['↵', 'Open a folder (on a file: what is known of it)'],
      ['backspace / -', 'The folder above (the cursor stays on the one you left)'],
      ['~', 'Home'],
      ['space', 'Mark the entry (and move on); c, d and x act on what is marked'],
      ['c', "Copy what is marked (or under the cursor) to the other pane's folder: queued in Transfers (asks before replacing a file)"],
      ['m', 'A new folder'],
      ['r', 'Rename'],
      ['d x', 'Delete what is marked or under the cursor (asks first; a folder goes with all that is in it)'],
      ['i', 'Size, mode, time and, for a link, where it points'],
      ['.', 'Show files starting with a dot, or not'],
      '/cd and /lcd go to a typed path; /get and /put queue a named entry.',
    ],
  },
  {
    title: 'Transfers',
    about: 'uploads and downloads: waiting, running (two at a time), done or failed, each with its progress',
    views: ['transfers'],
    rows: [
      ['↵', 'Where it goes from and to, and why it failed'],
      ['x', 'Cancel it (what reached the other side is removed)'],
      ['r', 'Try a failed or cancelled one again'],
      ['d', 'Take it off the list'],
      ['c', 'Clear the ones that are done'],
    ],
  },
  {
    title: 'Console',
    about: 'commands run on the server with $ (or /ssh): each in the folder the right pane shows, output as it arrives. No terminal: nothing full-screen (vim, top) or interactive (sudo asking for a password) works here',
    views: ['console'],
    rows: [
      ['↵ $ i', 'Type a command (the prompt opens with $)'],
      ['x', 'Cancel the command that is running'],
      ['y', "Copy the output of the command under the cursor"],
      ['c', 'Clear the console'],
      ['cd <folder>', 'Moves the right pane instead (a command run alone could not stay there)'],
    ],
  },
  {
    title: 'Hosts',
    about: 'the saved hosts: where each is and which key signs in to it (never a password)',
    views: ['hosts'],
    rows: [
      ['↵ / c', 'Connect'],
      ['a', 'Save a host (/add <name> <user@host> [key=<file>] [password])'],
      ['e', 'Change it (the line comes up at the prompt)'],
      ['x d', 'Forget it (asks first)'],
    ],
  },
  {
    title: 'Log',
    about: 'what Mooring has done, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: "a file's details, a command's output",
    rows: [
      ['j k  space  g alt+g', 'Scroll'],
      ['y alt+y', 'Copy what is on screen, or all of it'],
      ['esc / q', 'Close'],
    ],
  },
];
