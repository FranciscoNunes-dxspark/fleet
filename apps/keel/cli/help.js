export const HELP = `Anywhere
  1-5 / tab        Inbox, Pull requests, Pipelines, Work items, Production (shift+tab goes back)
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
  ↵                A pull request, work item, pipeline or monitor opens in its tab; anything else in the browser
  s                Snooze for a day (/snooze 2d, /snooze 1w; /unsnooze brings them all back)
  a  x             On an approval: approve or reject the deployment (asks first)

Pull requests (waiting on your review, then yours, then everyone else's; each goes
publish → approval → complete, and the pane says which step it's at and what it waits on)
  a                Approve         A           Approve with suggestions
  w                Wait for the author         x           Reject (asks first)
  0                Clear your vote             p           Publish a draft
  c                Complete (asks first; merge settings from Keel's Settings)
  m                Auto-complete on or off
  ↵                The full pull request       /comment <text>   Comment
  f                Everything, waiting on your review, yours (/show all|review|mine)

Pipelines (failing first, then unstable, healthy and idle)
  n                Run it on its branch (/run <branch> for another)
  c                Cancel the run that's queued or running (asks first)
  ↵                Latest runs, full height

Work items (open ones in your tracked projects: in progress, then resolved, then new)
  s                Move it to another state (a list to pick from; /state <name> too)
  i                Take it (assign it to you)     /assign <person>  /unassign
  b                Blocked tag on or off          /priority <1-4>
  ↵                The full work item: description, children, pull requests, comments
  f                Next view: all open, current sprint, bugs, blocked, no update in N days,
                   unassigned, mine (/show <view>)
  /comment <text>  Comment              /new <type> <title>   Create one (asks: sprint or backlog)
  /wi <id>         Go to a work item by number

Production (monitors that need you first: down, degraded, deploying; then the rest)
  ↵                Everything about it: issues, what fails most, deploys, and all that's waiting
                   to ship to its environment (pull requests, commits, work items, coming next)
  o                Open the site

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
  /publish  /approve  /suggest  /wait  /reject  /reset  /complete  /autocomplete  /comment <text>  /pr <id>
  /state [state]  /take  /assign <person>  /unassign  /blocked  /priority <1-4>  /new <type> <title>  /wi <id>
  /snooze [2d|1w]  /unsnooze  /deploy [comment]  /stop [comment]  /run [branch]  /cancel
  /summary [last|-N|date]  /open  /find [text]  /show [view]  /refresh  /last  /log  /logout  /help  /quit

Weekly summary (/summary; /summary last, /summary -3, /summary 2026-10-06 for earlier weeks)
  What got finished, merged and deployed that week, and what's blocked now: the web app's
  Weekly summary, as the text its "Copy as text" gives, ready to paste into an email or chat

Mouse (where the terminal reports it; Settings turns it off)
  click            A tab, a row, the prompt or a suggestion     double-click   As ↵
  wheel            Scroll the list or the viewer under the pointer
  drag             Select text on screen; it's copied when you let go

Viewer (a pull request, a work item, the weekly summary, the last output, the log, this help)
  j k  space  g G  Scroll         esc / q     Close`;
