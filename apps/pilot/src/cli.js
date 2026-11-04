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
  split <stylesheet>            how to split a large LESS/SCSS/CSS file: by where its rules are used
  path <from> <to>              how two things are connected (files, URLs, Controller.Action)
  routes [filter]               URLs, actions and the views they return
  problems [filter]             references Pilot couldn't resolve, and names decided at run time
  ui                            the web UI: graphs, pages, components, stylesheets (--port, --no-open)
  mcp                           serve these as MCP tools over stdio:
                                  claude mcp add pilot -- pilot mcp --root <dir>
  init [--mcp] [--command <c>]  add Pilot's Claude Code skill to the project (.claude/skills/pilot);
                                --mcp also adds the MCP server to the project's .mcp.json, run as
                                <c> (default: pilot, from the PATH)

Options:
  --root <dir>                  the project or solution folder (default: the current one)
  --json                        print data instead of text
  --no-cache                    read every file again (the cache is in ~/.cache/pilot, PILOT_CACHE)
  --vendor                      read library files (wwwroot/lib, *.min.js, jquery-*.js) for selectors too
  --ignore <a,b>                more folders to leave out (names, or paths from the root)
  --version, --help`;

export function parseArgs(argv) {
  const opts = { root: process.cwd(), json: false, cache: true, vendor: false, ignore: [], rest: [], open: true, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '-r') opts.root = argv[++i];
    else if (a.startsWith('--root=')) opts.root = a.slice(7);
    else if (a === '--json') opts.json = true;
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--vendor') opts.vendor = true;
    else if (a === '--ignore') opts.ignore.push(...String(argv[++i] ?? '').split(',').filter(Boolean));
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--mcp') opts.mcp = true;
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
    serve({ root: opts.root });
    return null;
  }
  if (opts.command === 'ui') {
    const { startUi } = await import('./web/server.js');
    await startUi({ root: opts.root, port: opts.port, open: opts.open, vendor: opts.vendor, ignore: opts.ignore, log: (s) => error(`${s}\n`) });
    return null;
  }
  if (opts.command === 'init') {
    const { SKILL } = await import('./skill.js');
    const dir = join(opts.root, '.claude', 'skills', 'pilot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), SKILL);
    write(`Wrote ${join(dir, 'SKILL.md')}: Claude Code picks the skill up in this project.\n`);
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
    split: (idx) => a.split(idx, needs('a stylesheet')),
    path: (idx) => {
      if (opts.args.length !== 2) throw Object.assign(new Error('pilot path needs two things: pilot path <from> <to>'), { usage: true });
      return a.path(idx, opts.args[0], opts.args[1]);
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
    const result = command(idx);
    write(opts.json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.text}\n`);
    return result.data?.error ? 1 : 0;
  } catch (e) {
    error(`${e.usage ? e.message : `Pilot failed: ${e.stack ?? e.message}`}\n`);
    return 2;
  }
}

/**
 * How Claude Code should start Pilot's MCP server: `command` as given, else `pilot` from the PATH,
 * or (run from a checkout) node with this checkout's bin/pilot.js. No --root: Claude Code starts the
 * server in the project's folder.
 */
export function mcpServer(command = null, { compiled = COMPILED } = {}) {
  if (command) return { command, args: ['mcp'] };
  if (compiled) return { command: 'pilot', args: ['mcp'] };
  return { command: 'node', args: [fileURLToPath(new URL('../bin/pilot.js', import.meta.url)), 'mcp'] };
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
  json.mcpServers = { ...(json.mcpServers ?? {}), pilot: { type: 'stdio', ...server } };
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return { file, server, merged };
}
