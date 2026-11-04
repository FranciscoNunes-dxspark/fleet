// `pilot mcp`: Pilot as an MCP server over stdio, so Claude Code can ask about an ASP.NET MVC project
// while it works on its UI. The index is built once and kept; before each call, files whose size or
// time changed are read again (at most every two seconds), so edits Claude just made are seen.
import { resolve } from 'node:path';
import { ToolError, mcpHandler, quietConsole, serveMcp } from '@fleet/kit/mcp.js';
import { VERSION } from './app.js';
import { buildIndex } from './index.js';
import { file, find, impact, overview, page, problems, routes, selector, styleSymbol } from './queries.js';

export const INSTRUCTIONS = `Pilot maps an ASP.NET MVC / ASP.NET Core project (.cshtml views, controllers, view components, bundles, TypeScript, JavaScript, LESS, SCSS, CSS) as one graph, so you can find what to change for a UI improvement without reading the whole tree.
Start with overview. For a screen the user names by URL, controller action or view, call page: it gives the action, the view, its layouts, every partial, component, template and child action in the order they render, and the scripts and styles the page loads, each with the source file to edit (.ts for a compiled .js, .less for a compiled .css, bundle members).
Before changing a CSS class or id, call selector: it lists where it is styled (with the full nested LESS selector), marked up and used by scripts. Before changing a shared partial, layout, script or stylesheet, call impact to see which pages it reaches.
file shows one file in context; style follows a LESS/SCSS variable or mixin; find looks anything up by name; routes lists URLs and actions; problems lists references Pilot could not resolve.
Every place is given as path:line from the project root. Pilot reads files with patterns, not a compiler: names built at run time are reported as such, and a "(guessed)" match is one found by name outside MVC's usual folders.`;

const target = { type: 'string', description: 'A URL (/Orders/Edit/5), Controller.Action (Orders.Edit, Admin/Users.Index), or a view path or name' };
const path = { type: 'string', description: 'A file path from the project root (or absolute), or a unique file name' };

export const TOOLS = [
  { name: 'overview', description: 'The project at a glance: web projects, areas, counts, layouts and how many views use each, top-level stylesheets, bundles, build configs.', inputSchema: { type: 'object', properties: {} } },
  { name: 'page', description: 'Everything a page is made of: the action(s), view, layout chain, the render tree (partials, components, templates, child actions, sections) and the scripts and styles it loads in order, each with its source file to edit.', inputSchema: { type: 'object', properties: { target }, required: ['target'] } },
  { name: 'file', description: 'One file in context: what it uses and what uses it, the pages it ends up on, what it is built from or builds to, its classes and where each is styled (views and scripts), definitions (scripts), variables and mixins (styles), actions (controllers).', inputSchema: { type: 'object', properties: { path, classes: { type: 'boolean', description: 'List the classes it uses and where each is styled (default true)' } }, required: ['path'] } },
  { name: 'impact', description: 'What a change to a file reaches: the files that include it, the views and layouts, and the pages (URLs and actions).', inputSchema: { type: 'object', properties: { path }, required: ['path'] } },
  {
    name: 'selector',
    description: 'A CSS class, id or data- attribute everywhere: the rules styling it (file:line and the full nested selector), the views marking it up and the scripts selecting or toggling it. Wildcards (btn-*) list matching names with counts.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string', description: '.class, #id, [data-attr], a bare name (class or id), or a wildcard like .btn-*' }, vendor: { type: 'boolean', description: 'Also list rules in libraries (bootstrap, wwwroot/lib)' } }, required: ['selector'] },
  },
  { name: 'style', description: 'A LESS or SCSS variable (@brand, $brand), CSS custom property (--brand) or mixin (.rounded): where it is defined, every use, and which top-level stylesheets compile it in.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'find', description: 'Anything by name: views, partials, controllers, actions, view components, bundles, script functions and classes, style variables and mixins, files.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'routes', description: 'URLs, the actions answering them and the views they return.', inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Only rows containing this text' } } } },
  { name: 'problems', description: 'References Pilot could not resolve (missing partials, layouts, scripts, styles, imports) and those decided at run time.', inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Only problems in files or messages containing this text' } } } },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

/** The server's state: the index of `root`, refreshed before a call when it's older than `fresh` ms. */
export function createServer({ root, fresh = 2000, build = buildIndex } = {}) {
  let idx = null;
  const current = () => {
    if (!idx) idx = build(root);
    else if (Date.now() - idx.builtAt > fresh) idx.build();
    return idx;
  };
  const need = (args, key) => {
    const v = args[key];
    if (v == null || String(v).trim() === '') throw new ToolError(`${key} is required.`);
    return String(v);
  };
  const call = async (name, args) => {
    const run = {
      overview: () => overview(current()),
      page: () => page(current(), need(args, 'target')),
      file: () => file(current(), need(args, 'path'), { classes: args.classes !== false }),
      impact: () => impact(current(), need(args, 'path')),
      selector: () => selector(current(), need(args, 'selector'), { vendor: !!args.vendor }),
      style: () => styleSymbol(current(), need(args, 'name')),
      find: () => find(current(), need(args, 'query'), { limit: Number(args.limit) || 40 }),
      routes: () => routes(current(), { filter: args.filter ?? '' }),
      problems: () => problems(current(), { filter: args.filter ?? '' }),
    }[name];
    if (!run) return undefined;
    return run().text;
  };
  return { call, index: current };
}

export function serve({ root = process.cwd() } = {}) {
  quietConsole();
  const server = createServer({ root: resolve(root) });
  const handle = mcpHandler({ name: 'pilot', version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS, call: server.call });
  serveMcp({ handle });
}
