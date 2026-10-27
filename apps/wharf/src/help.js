// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-4 / tab', 'Containers, Images, Pods, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['!', 'Run a shell command, e.g.  !docker compose ps'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
      ['ctrl+r', 'Read Docker again now (it is read every few seconds)'],
      ['?', 'This help'],
      ['q', 'Quit (containers keep running: Wharf only looks at them)'],
      ['mouse', 'Click a tab, a row or the prompt · double-click does ↵ · the wheel scrolls\ndrag to select text, copied when you let go (ctrl+c copies it again; it never quits) · ctrl+v pastes'],
    ],
  },
  {
    title: 'Lists',
    rows: [
      ['j k / ↑ ↓', 'Move'],
      ['g alt+g', 'Top, bottom'],
      ['ctrl+d ctrl+u', 'Page down, up'],
      ['y', 'Copy its id'],
    ],
  },
  {
    title: 'Containers',
    about: 'every container Docker has, a compose project\'s together under its name, with CPU and memory for the running ones',
    views: ['containers'],
    rows: [
      ['↵ / l', 'Its log, following it'],
      ['s', 'Stop it, or start it'],
      ['r', 'Restart it'],
      ['x', 'Remove it (asks first; a running one is stopped)'],
      ['i', 'Everything docker inspect says'],
      ['o', 'Open its first published port in the browser'],
      ['a', 'Only the running ones, or all of them'],
      ['p', 'Pause it, or let it run again'],
      ['y', 'Copy its id'],
      ['/up /down', 'docker compose up -d or down for a project, run where its files are (down asks first)'],
      ['/exec', 'One command inside a running container, no terminal: /exec shop-db-1 ls /app'],
      'In the list: ● green running · yellow starting, paused or restarting · red unhealthy or exited with an error · grey stopped.',
    ],
  },
  {
    title: 'Images',
    about: 'what docker images lists, the ones nothing is tagged with last',
    views: ['images'],
    rows: [
      ['x', 'Remove it (asks first; one a container uses asks again to force it)'],
      ['p', 'Remove the images nothing uses (/prune images)'],
      ['y', 'Copy its id'],
    ],
  },
  {
    title: 'Pods',
    about: "the cluster kubectl is set to, with a namespace's pods together under its name; read only while this view is on screen",
    views: ['pods'],
    rows: [
      ['↵ / l', 'Its log (every container of it), following it'],
      ['x', 'Delete it (asks first); its controller starts another'],
      ['r', 'Restart the deployment it belongs to, pod by pod (asks first)'],
      ['i', 'kubectl describe, events included'],
      ['y', 'Copy its name'],
      ['/namespace', 'One namespace, or all of them'],
      ['/context', 'Another cluster from kubeconfig (asks: kubectl itself switches)'],
      'In the list: ● green running and ready · yellow starting, terminating or not all ready · red crash-looping, failing to pull, killed · grey completed. CPU and memory show when the cluster has a metrics server.',
    ],
  },
  {
    title: 'Log',
    about: 'what Wharf has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: 'a container\'s log, inspect, output',
    rows: [
      ['j k  space  g alt+g', 'Scroll'],
      ['/ ctrl+f', 'Search: matches light up as you type, ↵ stops typing, n N go from match to match (from the newest in a log), esc clears it'],
      ['f', 'In a container\'s log: follow it (on by default), or stay where you are'],
      ['e', 'In a container\'s log: only the lines that read as trouble'],
      ['y alt+y', 'Copy what is on screen, or all of it'],
      ['t', 'In a log: copy its newest trouble line for Sonar, Hail or Bosun (/take there); /take here takes one they copied'],
      ['wheel', 'Scroll'],
      ['esc / q', 'Close'],
    ],
  },
];
