export const HELP = `Anywhere
  1-3 / tab        Inbox, Pull requests, Pipelines (shift+tab goes back)
  ,                Settings, over the current tab (esc closes it; /settings too)
  / or :           Command prompt (slash commands, with completion)
  o                Open the selection in the browser (Azure DevOps or GitHub)
  r                Ask Azure DevOps again now (Keel also checks by itself, as the web app does)
  esc              Stop waiting for what's running, or clear the activity lines
  ?                This help
  q / ctrl+c       Quit

Lists
  j k / ↑ ↓        Move            g G         Top, bottom
  ctrl+d ctrl+u    Page down, up   /find <text>   Filter (empty clears it)

Inbox (what needs you, most urgent first; the same rules as the web app's Inbox)
  ↵                A pull request or pipeline opens in its tab; anything else in the browser
  s                Snooze for a day (/snooze 2d, /snooze 1w; /unsnooze brings them all back)
  a  x             On an approval: approve or reject the deployment (asks first)

Pull requests (waiting on your review, then yours, then everyone else's)
  a                Approve         A           Approve with suggestions
  w                Wait for the author         x           Reject (asks first)
  0                Clear your vote
  c                Complete (asks first; merge settings from Keel's Settings)
  m                Auto-complete on or off
  ↵                The full pull request       /comment <text>   Comment
  f                Everything, waiting on your review, yours (/show all|review|mine)

Pipelines (failing first, then unstable, healthy and idle)
  n                Run it on its branch (/run <branch> for another)
  c                Cancel the run that's queued or running (asks first)
  ↵                Latest runs, full height

Settings (, or /settings; the same settings as the web app's, in the same data folder)
  space            Track a project or not; a repo in or out; the next choice; on or off
  ↵                A tracked project's repos (open or close)
  - +              How often Keel checks for changes
  x                Remove an added organization (asks first)
  esc              Close Settings
  /addorg <address> [--github]   Another Azure DevOps organization, or a GitHub owner

Prompt
  tab              Complete        ↑ ↓         Pick a suggestion, or walk history
  esc              Back to the view (the text is kept)
  ctrl+u ctrl+w    Clear the line · Delete a word

Slash commands
  /approve  /suggest  /wait  /reject  /reset  /complete  /autocomplete  /comment <text>  /pr <id>
  /snooze [2d|1w]  /unsnooze  /deploy [comment]  /stop [comment]  /run [branch]  /cancel
  /open  /find [text]  /show [all|review|mine]  /refresh  /last  /log  /help  /quit

Viewer (a pull request, the last output, the log, this help)
  j k  space  g G  Scroll         esc / q     Close`;
