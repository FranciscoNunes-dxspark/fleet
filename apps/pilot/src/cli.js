// Pilot's command line. Every query runs headless and prints text for Claude (or --json), then exits;
// `pilot mcp` serves the same queries over MCP; `pilot init` adds Pilot's skill to a project.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPILED, VERSION } from './app.js';

const HELP = `Pilot ${VERSION}: an ASP.NET MVC project mapped for Claude Code

Usage: pilot [--root <dir>] <command> [arguments] [--json]

  overview                      the project at a glance: projects, areas, layouts, stylesheets, bundles
  page <target>                 everything a page is made of: action, view, layouts, render tree, scripts
                                and styles in load order with their sources (target: /Orders/Edit/5,
                                Orders.Edit, Admin/Users.Index, Views/Orders/Edit.cshtml, _Header)
  file <path>                   one file in context: uses, used by, pages, classes and where they're styled
  impact <path>                 the pages, views and files a change to this file reaches
  selector <sel>                a class, id or data- attribute everywhere: styled, marked up, scripted
                                (.btn-save, #orders, [data-order-id], btn-*; --vendor adds libraries)
  style <name>                  a LESS/SCSS variable, custom property or mixin: definitions and uses
  find <name>                   views, partials, actions, components, bundles, functions, variables, files
  complexity [filter]           every page with a complexity score (views, depth, markup, scripts,
                                widgets, requests), highest first
  widgets [kind]                the UI components: data tables, calendars, date pickers, charts, selects,
                                modals… by library, with where each is and its pages
  stylesheets                   the project's stylesheets, largest first
  split <stylesheet> [--apply]  how to split a large LESS/SCSS/CSS file: by where its rules are used;
                                --apply writes the files (checked with lessc/sass when installed)
  extract [n] [--apply]         block n of repeats made one partial (--name, --force if copies differ)
  path <from> <to>              how two things are connected (files, URLs, Controller.Action)
  changes [--base <ref>]        the pages what git says changed reaches (uncommitted, and since <ref>)
  context <page> [--budget n]   the code that matters for a page, in one Markdown document (n chars)
  rename <old> <new> [--apply]  a class or id renamed in styles, views and scripts (a preview first)
  cascade <page> <selector>     every rule styling it on that page, in order, and what wins
  dead                          views, scripts, stylesheets, variables, mixins and classes nothing uses
  design                        colours that have a variable, look-alike colours, breakpoints, z-index,
                                !important, inline styles
  repeats [--min n]             markup repeated across views: candidates for a partial
  a11y [rule]                   accessibility problems the markup shows
  weight [filter]               what each page loads and weighs; libraries loaded twice
  diagram <target>              a page, a file's neighbourhood (--depth) or a path (--to) as Mermaid
                                (--format dot for Graphviz)
  shot <page>                   a screenshot of the running site (--url once, --widths 1280,mobile,
                                --cookie name=value, --as before|after): before, then after and a diff
  doctor                        how much of the project Pilot understood, and what it couldn't follow
  models [filter]               view models: which views use them, which properties they read
  text [filter]                 text written into views rather than through resources
  images                        images missing, heavy or unused
  styleguide                    the project's colours, variables, fonts, breakpoints and components
  report [--out file]           everything as one HTML file to share (.pilot/report.html)
  inspect <page> <selector>     the real element on the running site: box, computed styles, the rules
                                that style it and what wins
  coverage <page…>              the CSS rules and script bytes those pages really use
  responsive <page>             the page at each breakpoint: screenshots, sideways scrolling, culprits
  shots [changed|all|<page…>]   screenshots of many pages, compared, with a report (--threshold n
                                exits 1 when a page changed more than n%)
  hook                          Claude Code's PostToolUse hook (pilot init --hook installs it)
  routes [filter]               URLs, actions and the views they return
  problems [filter]             references Pilot couldn't resolve, and names decided at run time
  ui                            the web UI: graphs, pages, components, stylesheets (--port, --no-open)
  mcp                           serve these as MCP tools over stdio:
                                  claude mcp add pilot -- pilot mcp --root <dir>
  init [--mcp] [--hook]         add Pilot's Claude Code skill to the project (.claude/skills/pilot);
                                --mcp also adds the MCP server to the project's .mcp.json, --hook a
                                hook telling Claude what each edit reaches (--shots: and screenshots),
                                run as --command <c> (default: pilot, from the PATH)

Options:
  --root <dir>                  the project or solution folder (default: the current one)
  --json                        print data instead of text
  --no-cache                    read every file again (the cache is in ~/.cache/pilot, PILOT_CACHE)
  --vendor                      read library files (wwwroot/lib, *.min.js, jquery-*.js) for selectors too
  --ignore <a,b>                more folders to leave out (names, or paths from the root)
  --version, --help`;

export function parseArgs(argv) {
  const opts = { root: process.cwd(), json: false, cache: true, vendor: false, ignore: [], rest: [], open: true, port: null, cookies: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '-r') [opts.root, opts.rootGiven] = [argv[++i], true];
    else if (a.startsWith('--root=')) [opts.root, opts.rootGiven] = [a.slice(7), true];
    else if (a === '--json') opts.json = true;
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--vendor') opts.vendor = true;
    else if (a === '--ignore') opts.ignore.push(...String(argv[++i] ?? '').split(',').filter(Boolean));
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--mcp') opts.mcp = true;
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--budget') opts.budget = Number(argv[++i]);
    else if (a === '--apply') opts.apply = true;
    else if (a === '--min') opts.min = Number(argv[++i]);
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--depth') opts.depth = Number(argv[++i]);
    else if (a === '--format') opts.format = argv[++i];
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--widths' || a === '--width') opts.widths = String(argv[++i]).split(',').map((w) => (/^\d+$/.test(w) ? Number(w) : w));
    else if (a === '--mobile') opts.widths = [...(opts.widths ?? [1280]), 'mobile'];
    else if (a === '--as') opts.as = argv[++i];
    else if (a === '--cookie') opts.cookies.push(argv[++i]);
    else if (a === '--force') opts.force = true;
    else if (a === '--name') opts.name = argv[++i];
    else if (a === '--threshold') opts.threshold = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--hook') opts.hook = true;
    else if (a === '--shots') opts.shots = true;
    else if (a === '--command') opts.mcpCommand = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-v') opts.version = true;
    else opts.rest.push(a);
  }
  opts.root = resolve(opts.root);
  [opts.command = 'overview', ...opts.args] = opts.rest;
  return opts;
}

/** Runs one command; resolves with the exit code. `write` takes the output. */
export async function run(argv, { write = (s) => process.stdout.write(s), error = (s) => process.stderr.write(s) } = {}) {
  const opts = parseArgs(argv);
  if (opts.version) {
    write(`${VERSION}\n`);
    return 0;
  }
  if (opts.help || opts.command === 'help') {
    write(`${HELP}\n`);
    return 0;
  }
  if (!existsSync(opts.root)) {
    error(`No folder ${opts.root}\n`);
    return 2;
  }
  if (opts.command === 'mcp') {
    const { serve } = await import('./mcp.js');
    serve({ root: mcpRoot(opts) });
    return null;
  }
  if (opts.command === 'ui') {
    const { startUi } = await import('./web/server.js');
    await startUi({ root: opts.root, port: opts.port, open: opts.open, vendor: opts.vendor, ignore: opts.ignore, log: (s) => error(`${s}\n`) });
    return null;
  }
  if (opts.command === 'hook') {
    // Claude Code's PostToolUse hook: its JSON on stdin, what to tell Claude on stdout (or nothing).
    const [{ runHook }, { buildIndex }] = await Promise.all([import('./hook.js'), import('./index.js')]);
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    try {
      const out = await runHook({ input, build: (root) => buildIndex(root, { progress: () => {} }) });
      if (out) write(`${out}\n`);
    } catch (e) {
      error(`Pilot's hook: ${e.message}\n`);
    }
    return 0;
  }
  if (opts.command === 'init') {
    const { SKILL } = await import('./skill.js');
    const dir = join(opts.root, '.claude', 'skills', 'pilot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), SKILL);
    write(`Wrote ${join(dir, 'SKILL.md')}: Claude Code picks the skill up in this project.\n`);
    if (opts.hook) {
      const { installHook } = await import('./hook.js');
      const server = mcpServer(opts.mcpCommand);
      const command = [server.command, ...server.args.slice(0, -1)].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
      try {
        write(`Added the hook to ${installHook(opts.root, command, { shots: !!opts.shots })}: after each edit, Claude hears which pages the file is on and what looks wrong${opts.shots ? ', and how much those pages changed in screenshots (pages that have a before; the site must be running)' : ''}.\n`);
      } catch (e) {
        error(`${e.message}\n`);
        return 2;
      }
    }
    if (opts.mcp) {
      let result;
      try {
        result = writeMcpJson(opts.root, mcpServer(opts.mcpCommand));
      } catch (e) {
        error(`${e.message}\n`);
        return 2;
      }
      const { file, server, merged } = result;
      write(`${merged ? 'Added Pilot to' : 'Wrote'} ${file}: ${[server.command, ...server.args].join(' ')}\n`);
      if (server.command === 'node') write('That command holds this checkout\'s path: fine for you, but give teammates `--command pilot` before checking it in.\n');
      write('Claude Code asks once whether to use it; /mcp in Claude Code shows it connected.\n');
    } else {
      write(`For the MCP tools too: pilot init --mcp (the project's .mcp.json), or for you alone:\n  claude mcp add pilot -- pilot mcp --root "${opts.root}"\n`);
    }
    return 0;
  }
  const liveCookies = () => [...opts.cookies, ...String(process.env.PILOT_COOKIE ?? '').split(';').map((x) => x.trim()).filter(Boolean)];
  const q = await import('./queries.js');
  const a = await import('./analysis.js');
  const arg = opts.args.join(' ');
  const needs = (what) => {
    if (!arg) throw Object.assign(new Error(`pilot ${opts.command} needs ${what}.`), { usage: true });
    return arg;
  };
  const commands = {
    overview: (idx) => q.overview(idx),
    page: (idx) => q.page(idx, needs('a URL, Controller.Action or view')),
    file: (idx) => q.file(idx, needs('a file')),
    impact: (idx) => q.impact(idx, needs('a file')),
    selector: (idx) => q.selector(idx, needs('a selector'), { vendor: opts.vendor }),
    style: (idx) => q.styleSymbol(idx, needs('a variable or mixin')),
    find: (idx) => q.find(idx, needs('a name')),
    complexity: (idx) => a.complexity(idx, { filter: arg }),
    widgets: (idx) => a.widgets(idx, { kind: arg }),
    stylesheets: (idx) => a.stylesheets(idx),
    split: async (idx) => (opts.apply ? (await import('./refactor.js')).splitApply(idx, needs('a stylesheet'), { apply: true, force: !!opts.force }) : a.split(idx, needs('a stylesheet'))),
    extract: async (idx) => (await import('./refactor.js')).extractPartial(idx, Number(opts.args[0]) || 1, { name: opts.name ?? null, apply: !!opts.apply, force: !!opts.force }),
    doctor: async (idx) => (await import('./insight.js')).doctor(idx),
    models: async (idx) => (await import('./insight.js')).models(idx, { filter: arg }),
    text: async (idx) => (await import('./insight.js')).texts(idx, { filter: arg }),
    images: async (idx) => (await import('./insight.js')).images(idx),
    styleguide: async (idx) => (await import('./insight.js')).styleguide(idx),
    report: async (idx) => (await import('./report.js')).report(idx, { out: opts.out ?? null }),
    inspect: async (idx) => {
      if (opts.args.length !== 2) throw Object.assign(new Error('pilot inspect needs a page and a selector: pilot inspect /Orders .btn-save'), { usage: true });
      return (await import('./live.js')).inspect(idx, opts.args[0], opts.args[1], { url: opts.url ?? null, mobile: (opts.widths ?? []).includes('mobile'), cookies: liveCookies() });
    },
    coverage: async (idx) => (await import('./live.js')).coverage(idx, opts.args.length ? opts.args : [needs('one or more pages')], { url: opts.url ?? null, cookies: liveCookies() }),
    responsive: async (idx) => (await import('./live.js')).responsive(idx, needs('a page'), { url: opts.url ?? null, widths: opts.widths?.filter((w) => typeof w === 'number') ?? null, cookies: liveCookies() }),
    shots: async (idx) => (await import('./live.js')).shots(idx, opts.args.length && !['all', 'changed'].includes(opts.args[0]) ? opts.args : opts.args[0] ?? 'changed', { url: opts.url ?? null, widths: opts.widths ?? [1280], as: opts.as ?? null, cookies: liveCookies(), limit: opts.limit || 40, threshold: Number.isFinite(opts.threshold) ? opts.threshold : null, base: opts.base ?? null }),
    path: (idx) => {
      if (opts.args.length !== 2) throw Object.assign(new Error('pilot path needs two things: pilot path <from> <to>'), { usage: true });
      return a.path(idx, opts.args[0], opts.args[1]);
    },
    changes: async (idx) => (await import('./changes.js')).changes(idx, { base: opts.base ?? null }),
    context: async (idx) => (await import('./context.js')).context(idx, needs('a page'), { budget: opts.budget || 60000 }),
    rename: async (idx) => {
      if (opts.args.length !== 2) throw Object.assign(new Error('pilot rename needs the old and the new name: pilot rename .old .new [--apply]'), { usage: true });
      return (await import('./rename.js')).rename(idx, opts.args[0], opts.args[1], { apply: !!opts.apply });
    },
    cascade: async (idx) => {
      if (opts.args.length !== 2) throw Object.assign(new Error('pilot cascade needs a page and a class or id: pilot cascade /Orders .btn-save'), { usage: true });
      return (await import('./cascade.js')).cascade(idx, opts.args[0], opts.args[1]);
    },
    dead: async (idx) => (await import('./audit.js')).deadCode(idx),
    design: async (idx) => (await import('./audit.js')).design(idx),
    repeats: async (idx) => (await import('./audit.js')).repeats(idx, { min: opts.min || 6 }),
    a11y: async (idx) => (await import('./audit.js')).a11y(idx, { rule: arg }),
    weight: async (idx) => (await import('./audit.js')).weight(idx, { filter: arg }),
    diagram: async (idx) => (await import('./diagram.js')).diagram(idx, needs('a page, file or action'), { to: opts.to ?? null, depth: opts.depth || 1, format: opts.format === 'dot' ? 'dot' : 'mermaid' }),
    shot: async (idx) => {
      const cookies = [...opts.cookies, ...String(process.env.PILOT_COOKIE ?? '').split(';').map((x) => x.trim()).filter(Boolean)];
      return (await import('./shots.js')).shot(idx, needs('a page'), { url: opts.url ?? null, widths: opts.widths ?? [1280], as: opts.as ?? null, cookies });
    },
    routes: (idx) => q.routes(idx, { filter: arg }),
    problems: (idx) => q.problems(idx, { filter: arg }),
  };
  const command = commands[opts.command];
  if (!command) {
    error(`Unknown command "${opts.command}".\n\n${HELP}\n`);
    return 2;
  }
  try {
    const { buildIndex } = await import('./index.js');
    const idx = buildIndex(opts.root, { cache: opts.cache, vendor: opts.vendor, ignore: opts.ignore, progress: (m) => error(`\rReading ${m}`) });
    const result = await command(idx);
    write(opts.json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.text}\n`);
    return result.data?.error ? 1 : 0;
  } catch (e) {
    error(`${e.usage ? e.message : `Pilot failed: ${e.stack ?? e.message}`}\n`);
    return 2;
  }
}

/**
 * How Claude Code should start Pilot's MCP server: `command` as given, else `pilot` from the PATH,
 * or (run from a checkout) node with this checkout's bin/pilot.js. No --root: the server reads the
 * project Claude Code names in CLAUDE_PROJECT_DIR (mcpRoot).
 */
export function mcpServer(command = null, { compiled = COMPILED } = {}) {
  if (command) return { command, args: ['mcp'] };
  if (compiled) return { command: 'pilot', args: ['mcp'] };
  return { command: 'node', args: [fileURLToPath(new URL('../bin/pilot.js', import.meta.url)), 'mcp'] };
}

/**
 * The folder `pilot mcp` reads: --root, else the project Claude Code names in CLAUDE_PROJECT_DIR
 * (it doesn't promise to start servers there), else the current folder.
 */
export function mcpRoot(opts, env = process.env) {
  if (opts.rootGiven || !env.CLAUDE_PROJECT_DIR) return opts.root;
  return resolve(env.CLAUDE_PROJECT_DIR);
}

/** Puts `server` in `root`/.mcp.json as "pilot", keeping every other server there. */
export function writeMcpJson(root, server) {
  const file = join(root, '.mcp.json');
  let json = {};
  const merged = existsSync(file);
  if (merged) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw Object.assign(new Error(`${file} isn't valid JSON; fix it or add Pilot with: claude mcp add pilot --scope project -- pilot mcp`), { usage: true });
    }
  }
  json.mcpServers = { ...(json.mcpServers ?? {}), pilot: { ...server } };
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return { file, server, merged };
}
