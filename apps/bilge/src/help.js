// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note. `views` are the views ? opens on that
// section from. The slash commands come from commands.js, as a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-4 / tab', 'Vulnerabilities, Packages, Manifests, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['!', 'Run a shell command in the folder, e.g.  !npm ls lodash'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
      ['ctrl+r', 'Read the lock files again and ask OSV about them'],
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
    title: 'Vulnerabilities',
    about: 'every package with a known advisory against its version, worst first, from OSV (osv.dev: GitHub\'s, npm\'s and NuGet\'s advisories and more)',
    views: ['vulns'],
    rows: [
      ['↵ / l', 'Its advisories, where it is, and the fix'],
      ['f', 'Fix it: npm install, npm update or dotnet add to the version that fixes them (asks first, then reads again)'],
      ['o', 'Open the advisory in the browser'],
      ['x', 'Ignore its advisories (asks; /unignore puts them back)'],
      ['t', 'Copy where it is in its lock file for Splice, whose blame says who brought it in'],
      ['d', 'Show or hide the packages only used for development'],
      ['y', 'Copy its advisories\' ids'],
      'CRIT and HIGH in red, MED yellow, LOW blue: GitHub\'s own word where it has one, else the CVSS score. "via" marks a package another one brings in.',
    ],
  },
  {
    title: 'Packages',
    about: 'every package in the lock files, the ones asked for directly first',
    views: ['packages'],
    rows: [
      ['↵ / l', 'Its licence, newest version, advisories and where it is'],
      ['a', 'All of them, the direct ones, the outdated ones, or the flagged ones (an advisory, a copyleft or denied licence, deprecated)'],
      ['u', 'Ask the registries for the newest versions and licences (/outdated; /outdated all for every package)'],
      ['f', 'Fix it, when it has advisories'],
      ['o', 'Its page on npm or NuGet'],
      ['t', 'Copy where it is for Splice\'s blame'],
      ['y', 'Copy name@version'],
      'Licences: copyleft in red, weak copyleft (LGPL, MPL…) yellow, unknown grey. Newest: a major version behind in red, minor yellow, patch blue.',
    ],
  },
  {
    title: 'Manifests',
    about: 'the lock files and projects found in the folder and below it (node_modules, bin and obj left out)',
    views: ['manifests'],
    rows: [
      ['↵ / l', 'Its packages, in the Packages view'],
      ['t', 'Copy it for Splice, whose history says who changed it'],
      ['y', 'Copy its path'],
      'A .csproj without a packages.lock.json gives only its own references: set RestorePackagesWithLockFile to true and build to see everything. A package.json without a lock file gives nothing.',
    ],
  },
  {
    title: 'Log',
    about: 'what Bilge has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: 'a finding, a package, the report, output',
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
    about: 'bilge audit, without the screen',
    rows: [
      ['bilge audit [folder]', 'The findings as text; exits 1 when one is as bad as --fail-on (high by default)'],
      ['--fail-on <level>', 'critical, high, medium, low, or none to never fail'],
      ['--json', 'The findings as JSON'],
      ['bilge sbom [folder] [-o file]', 'A CycloneDX bill of materials, to the file or the output'],
      'Advisories ignored with /ignore are left out of both (the settings in ~/.bilge).',
    ],
  },
];
