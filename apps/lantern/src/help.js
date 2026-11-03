// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-6 / tab', 'Pages, Findings, Compare, Waterfall, Domains, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['!', 'Run a shell command in the folder, e.g.  !curl -I https://shop.example/'],
      ['esc', 'Cancel the running audit, or clear the activity lines'],
      ['ctrl+r', 'Audit the selected page again'],
      ['/env [name]', "The project's environment (.fleet/project.json), or switch every app to another; on a production one the frames are red"],
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
    title: 'Pages',
    about: "the URLs to audit: lantern.json's, and one per environment from .fleet/project.json (each environment's \"lantern\": { \"url\" } or { \"urls\" })",
    views: ['pages'],
    rows: [
      ['↵ / l', 'Its findings (audits it first when it hasn\'t been)'],
      ['a', 'Audit it: three runs in a headless Chrome (the median shown), axe-core, its links, headers and certificate'],
      ['alt+a', 'Audit every page'],
      ['s', 'Only the security checks, which need no browser'],
      ['c', 'Compare it with the same page in another environment (or its last run)'],
      ['w', 'Its requests, in the Waterfall'],
      ['o', 'Open it in the browser'],
      ['t', "Copy it as a page context (its URL and how many findings), for another Lantern's /take"],
      ['y', 'Copy its URL'],
      'LCP, CLS and INP are lab numbers: a headless Chrome on this machine, not what visitors measure. Green is good, yellow needs improvement, red is poor (Google\'s thresholds).',
    ],
  },
  {
    title: 'Findings',
    about: 'everything found on the selected page, worst first',
    views: ['findings'],
    rows: [
      ['↵ / l', 'What it is, the element, the WCAG rule, why it matters and the fix'],
      ['f', 'Category: all, performance, accessibility, SEO and basics, security'],
      ['s', 'Severity: all, or critical, high, medium, low and worse'],
      ['x', 'Ignore this rule on this page (asks; /unignore puts it back)'],
      ['o', "Open axe's page on the rule, or the URL it is about"],
      ['y', 'Copy the element\'s selector (or the URL)'],
      'Accessibility: axe-core\'s impact critical, serious, moderate, minor is shown as CRIT, HIGH, MED, LOW.',
    ],
  },
  {
    title: 'Compare',
    about: 'the same page in two environments, or two runs of it: each vital, the weight, the requests and the findings by category',
    views: ['compare'],
    rows: [
      ['e', 'The other side: the next environment'],
      ['p', 'The previous run of the selected page against its latest'],
      ['a', 'Audit both sides again'],
      ['y', 'Copy the comparison'],
    ],
  },
  {
    title: 'Waterfall',
    about: "the selected page's requests in the order they went, with when each started and finished",
    views: ['waterfall'],
    rows: [
      ['↵', "Hand the request to Hail (a request context; its URL and method, no headers or cookies)"],
      ['l', 'What it was: status, type, size and timing'],
      ['o', 'Open it in the browser'],
      ['y', 'Copy its URL'],
    ],
  },
  {
    title: 'Domains',
    about: 'the hosts the pages are on: DNS, redirects, https and the certificate',
    views: ['domains'],
    rows: [
      ['↵ / l', 'Its records (A, AAAA, CNAME, CAA, MX), the redirects from http:// and the bare domain, the certificate and the findings'],
      ['r', 'Check them all again (/domains)'],
      ['y', 'Copy the host'],
      'missing-caa: no CAA record names the CAs that may issue · no-https-redirect: http isn\'t sent to https · cert-expiring: under 30 days left (high under 7) · dangling-cname: a CNAME to a name that no longer resolves.',
    ],
  },
  {
    title: 'Log',
    about: 'what Lantern has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: 'a finding, a domain, the report, output',
    rows: [
      ['j k  space  g alt+g', 'Scroll'],
      ['/ ctrl+f', 'Search: matches light up as you type, ↵ stops typing, n N go from match to match, esc clears it'],
      ['y alt+y', 'Copy what is on screen, or all of it'],
      ['esc / q', 'Close'],
    ],
  },
  {
    title: 'In a pipeline',
    about: 'lantern audit, security and domains, without the screen',
    rows: [
      ['lantern audit [url…|folder]', 'Every page (the chosen environment\'s), as text; exits 1 when --fail-on fails'],
      ['--fail-on <terms>', 'high · a11y:serious · security:medium · perf:lcp>2.5s · perf:cls>0.1 · perf:inp>200ms · perf:weight>2mb, comma-separated; none never fails'],
      ['--runs <n>', 'Measure each page n times (3)'],
      ['--json · --sarif [file]', 'The results as JSON, or SARIF for code scanning'],
      ['lantern security [url…|folder]', "Headers, cookies, mixed content, source maps, the certificate; --json is the family's security JSON"],
      ['lantern domains [host…|folder]', 'DNS, redirects, https and the certificate of each host'],
    ],
  },
];
