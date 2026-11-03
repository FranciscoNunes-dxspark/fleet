// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-5 / tab', 'Requests, Hosts, Security, Setup, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['!', 'Run a shell command in the folder, e.g.  !curl -x http://127.0.0.1:8888 http://example.com'],
      ['space', 'Pause recording (traffic still passes), or record again'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
      ['/env [name]', "The project's environment (.fleet/project.json), or switch every app to another"],
      ['?', 'This help'],
      [',', 'Settings'],
      ['q', 'Quit (the proxy stops with it)'],
      ['mouse', 'Click a tab, a row or the prompt · double-click does ↵ · the wheel scrolls\ndrag to select text, copied when you let go (ctrl+c copies it again; it never quits) · ctrl+v pastes'],
    ],
  },
  {
    title: 'Lists',
    rows: [
      ['j k / ↑ ↓', 'Move (on the last row, the list follows what comes in)'],
      ['g alt+g', 'Top, bottom'],
      ['ctrl+d ctrl+u', 'Page down, up'],
    ],
  },
  {
    title: 'Requests',
    about: 'everything that passed through, oldest first, as it happens: method, status, how it came (http, tls for HTTPS read through interception, tun for a tunnel, ✗ for a refused handshake), host, path, size and time',
    views: ['requests'],
    rows: [
      ['↵ / l', 'The request and its response: headers, bodies (JSON laid out), timings; credentials hidden until s'],
      ['h', 'Write it to lookout.http with credentials as {{variables}}, and open it in Hail (/hail <file> picks another file)'],
      ['t', "Copy it for Hail's /take (credentials as variables too)"],
      ['f', 'Filter: host:api.example.com status:4xx method:post and words (the URL, headers, bodies)'],
      ['p', 'Pass its host through untouched from now on (a client that pins its certificate refuses Lookout\'s); again takes it off'],
      ['y', 'Copy its URL (secrets in it masked)'],
      ['e', 'Export what is shown as a HAR file (/export)'],
      ['c', 'Forget everything captured (asks)'],
      'Statuses: 2xx green, 3xx blue, 4xx yellow, 5xx and errors red. A refused row is a client that turned the certificate down: p passes its host through.',
    ],
  },
  {
    title: 'Detail',
    about: 'one request and its response',
    rows: [
      ['s', 'Show or hide the credentials: Authorization, cookies, API keys, secret fields and values that look like keys or tokens'],
      ['d / r', 'The response\'s / request\'s body as a tree or a table (JSON, JSON lines, CSV), with a path query'],
      ['h t p', 'To Hail as a .http file, copied for Hail, pass its host through'],
      ['j k  space  / n N  y Y', 'Scroll, search, copy what is on screen or all of it'],
      ['esc / q', 'Close'],
    ],
  },
  {
    title: 'Hosts',
    about: 'every host seen, busiest first: requests, errors, and how its HTTPS went (read, tunnelled, refused)',
    views: ['hosts'],
    rows: [
      ['↵ / l', 'Its requests (a host: filter)'],
      ['p', 'Pass it through untouched, or intercept it again'],
      ['y', 'Copy its name'],
    ],
  },
  {
    title: 'Security',
    about: 'what the captured traffic says about the apps that sent it; the same as lookout security',
    views: ['security'],
    rows: [
      ['↵ / l', 'What it is, where, why it matters and the fix'],
      ['y', 'Copy where'],
      'token-over-http, cookie-over-http, secret-in-body-over-http: credentials in the clear (a step milder to localhost) · credentials-in-query: a token in a URL, which logs and Referer headers keep · cookie-not-secure, cookie-not-httponly: how a server sets its cookies.',
    ],
  },
  {
    title: 'Setup',
    about: 'what sends traffic through Lookout, and how to trust its certificate authority on each system',
    views: ['setup'],
    rows: [
      ['y', 'Copy the HTTPS_PROXY line (for a .env, or what Bosun runs)'],
      ['b', "Copy Bosun's \"env\" for bosun.json (with NODE_EXTRA_CA_CERTS while HTTPS is intercepted)"],
      ['c', "Copy the certificate's path"],
      ['i', 'HTTPS interception on or off (/intercept)'],
      ['j k  space', 'Scroll'],
    ],
  },
  {
    title: 'Log',
    about: 'what Lookout has done, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Without the screen',
    about: 'lookout security, ca and env',
    rows: [
      ['lookout security [capture.har]', "What the traffic says, from a HAR file or the last session (only its findings are kept); exits 1 when one is as bad as --fail-on (high by default)"],
      ['--json, --sarif [file]', "The family's security JSON (Fleet adds it up), or SARIF for code scanning"],
      ['lookout ca [--pem]', 'Make the certificate authority when there is none, and say how to trust it here (--pem prints it)'],
      ['lookout env [--port n]', 'The proxy settings, for a shell, Bosun, a browser or an emulator'],
    ],
  },
];
