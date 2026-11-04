// Pilot's command line. Every query runs headless and prints text for Claude (or --json), then exits;
// `pilot mcp` serves the same queries over MCP; `pilot init` adds Pilot's skill to a project.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VERSION } from './app.js';

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
  routes [filter]               URLs, actions and the views they return
  problems [filter]             references Pilot couldn't resolve, and names decided at run time
  mcp                           serve these as MCP tools over stdio:
                                  claude mcp add pilot -- pilot mcp --root <dir>
  init                          add Pilot's Claude Code skill to the project (.claude/skills/pilot)

Options:
  --root <dir>                  the project or solution folder (default: the current one)
  --json                        print data instead of text
  --no-cache                    read every file again (the cache is in ~/.cache/pilot, PILOT_CACHE)
  --vendor                      read library files (wwwroot/lib, *.min.js, jquery-*.js) for selectors too
  --ignore <a,b>                more folders to leave out (names, or paths from the root)
  --version, --help`;

export function parseArgs(argv) {
  const opts = { root: process.cwd(), json: false, cache: true, vendor: false, ignore: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' || a === '-r') opts.root = argv[++i];
    else if (a.startsWith('--root=')) opts.root = a.slice(7);
    else if (a === '--json') opts.json = true;
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--vendor') opts.vendor = true;
    else if (a === '--ignore') opts.ignore.push(...String(argv[++i] ?? '').split(',').filter(Boolean));
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
  if (opts.command === 'init') {
    const { SKILL } = await import('./skill.js');
    const dir = join(opts.root, '.claude', 'skills', 'pilot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), SKILL);
    write(`Wrote ${join(dir, 'SKILL.md')}.\nFor the MCP tools as well, run in the project:\n  claude mcp add pilot -- pilot mcp --root "${opts.root}"\n`);
    return 0;
  }
  const q = await import('./queries.js');
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
