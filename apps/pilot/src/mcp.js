// `pilot mcp`: Pilot as an MCP server over stdio, so Claude Code can ask about an ASP.NET MVC project
// while it works on its UI. The index is built once and kept; before each call, files whose size or
// time changed are read again (at most every two seconds), so edits Claude just made are seen.
import { resolve } from 'node:path';
import { ToolError, mcpHandler, quietConsole, serveMcp } from '@fleet/kit/mcp.js';
import { VERSION } from './app.js';
import { buildIndex } from './index.js';
import { file, find, impact, overview, page, problems, routes, selector, styleSymbol } from './queries.js';
import { complexity, path as pathBetween, split, stylesheets, widgets } from './analysis.js';

export const INSTRUCTIONS = `Pilot maps an ASP.NET MVC / ASP.NET Core project (.cshtml views, controllers, view components, bundles, TypeScript, JavaScript, LESS, SCSS, CSS) as one graph, so you can find what to change for a UI improvement without reading the whole tree.
Start with overview. For a screen the user names by URL, controller action or view, call page: it gives the action, the view, its layouts, every partial, component, template and child action in the order they render, the scripts and styles the page loads, each with the source file to edit (.ts for a compiled .js, .less for a compiled .css, bundle members), the requests its scripts and markup make (AJAX, fetch, data-ajax, htmx, Ajax.BeginForm) with the action and partial view answering each and the element it lands in, the UI components on it (data tables, calendars, pickers, charts…) and its complexity score.
path shows how two things connect (a script to the partial its request returns); widgets lists the UI components by kind; complexity ranks pages; stylesheets and split help break up a large LESS file by where its rules are used.
Before changing a CSS class or id, call selector: it lists where it is styled (with the full nested LESS selector), marked up and used by scripts. Before changing a shared partial, layout, script or stylesheet, call impact to see which pages it reaches.
Before editing a page, context gives its code in one document. After editing, changes lists the pages to check; screenshot takes the page (before, then after with a diff) when the site runs locally. cascade explains why a style doesn't apply; rename renames a class or id everywhere (preview first). dead_code, design, repeats, accessibility and weight audit the project; diagram draws a page or path as Mermaid.
On a new project, call doctor first: it says how much Pilot understood. styleguide lists the project's own colours, variables and components to reuse. view_models, hard_coded_text and images cover the models, text and images. With the site running locally: inspect shows what really styles an element, coverage what CSS and script a page really uses, responsive how it holds up at each breakpoint, screenshots many pages at once. split_apply and extract_partial do the refactors split and repeats suggest (preview first, then apply).
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
  { name: 'path', description: 'How two things are connected, step by step: files, URLs or Controller.Action (e.g. a script → the action it calls → the partial it returns).', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } },
  { name: 'widgets', description: 'The UI components in the project (data tables, calendars, date pickers, charts, selects, modals, tabs, editors, uploads, trees…) by kind and library, where each is set up, the element it binds to and the pages it is on.', inputSchema: { type: 'object', properties: { kind: { type: 'string', description: 'Only this kind or library, e.g. "data table", "DataTables", "calendar"' } } } },
  { name: 'complexity', description: 'Every page with a complexity score 0-100 (own views and partials, nesting, markup and script lines, widgets, server requests, child actions), highest first.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'stylesheets', description: 'The project stylesheets, largest first, with rules and imports: to find the one to split.', inputSchema: { type: 'object', properties: {} } },
  { name: 'split_apply', description: 'Writes the split of a stylesheet that split proposes: the new files beside it and the imports in it (unused last), the original backed up in .pilot/backup. With lessc or sass installed, compiles before and after and puts everything back if the CSS would change (unless force). Preview first with apply false.', inputSchema: { type: 'object', properties: { path, apply: { type: 'boolean' }, force: { type: 'boolean' } }, required: ['path'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'extract_partial', description: 'Makes block n of repeats (1 = the largest) one partial: writes it once and replaces each copy with a call (Html.Partial or <partial>). Lists the differences between copies and writes nothing when they differ, unless force. Preview with apply false.', inputSchema: { type: 'object', properties: { n: { type: 'number' }, name: { type: 'string', description: 'The partial name, e.g. _InfoCard' }, apply: { type: 'boolean' }, force: { type: 'boolean' } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'doctor', description: 'How much of the project Pilot understood (partials, layouts, actions, assets, requests, images: found, guessed, missing, decided at run time) and the patterns it could not follow. Check this first on a new project to know how far to trust the other tools.', inputSchema: { type: 'object', properties: {} } },
  { name: 'view_models', description: 'The view models views use (@model): their class, which views use them, which properties the markup reads, never reads, or reads but the class does not have.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'hard_coded_text', description: 'Text written into views (between tags, and placeholder/title/alt/aria-label) rather than through resources or a localizer, by view.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'images', description: 'Images referenced but missing, heavy ones, and ones no view or stylesheet uses.', inputSchema: { type: 'object', properties: {} } },
  { name: 'styleguide', description: 'The project\'s own design system: colour and size variables with their uses, colours written out, fonts and sizes, breakpoints, component class families with example markup, UI libraries. Use it to reuse existing values and components instead of inventing new ones.', inputSchema: { type: 'object', properties: {} } },
  { name: 'inspect', description: 'On the running site (local Chrome/Edge): the element(s) a selector finds on a page, their box and computed styles, and every rule that styles them in cascade order with what wins and where each rule is written. Exact, unlike cascade.', inputSchema: { type: 'object', properties: { page: { type: 'string' }, selector: { type: 'string' }, url: { type: 'string', description: 'The running site, e.g. http://localhost:5000 (remembered)' }, mobile: { type: 'boolean' } }, required: ['page', 'selector'] }, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'coverage', description: 'On the running site: the CSS rules and script bytes the given pages really use, by stylesheet and script, and classes styled but used by none of them (hover/focus rules aside).', inputSchema: { type: 'object', properties: { pages: { type: 'array', items: { type: 'string' } }, url: { type: 'string' } }, required: ['pages'] }, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'responsive', description: 'On the running site: the page at each of the project\'s breakpoints: a screenshot (read the PNG), whether it scrolls sideways, and the elements that stick out, traced to the markup.', inputSchema: { type: 'object', properties: { page: { type: 'string' }, url: { type: 'string' }, widths: { type: 'array', items: { type: 'number' } } }, required: ['page'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'screenshots', description: 'Screenshots of many pages (the ones the changes reach, all, or a list) with one browser, each compared with its before, and an HTML report.', inputSchema: { type: 'object', properties: { which: { type: 'string', enum: ['changed', 'all'] }, pages: { type: 'array', items: { type: 'string' } }, url: { type: 'string' }, threshold: { type: 'number' } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'report', description: 'Writes everything Pilot found as one HTML file (.pilot/report.html) to share.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'split', description: 'How to split a large LESS/SCSS/CSS file: each top-level block assigned to a new file by what it is (variables, mixins, fonts, element styles) or where its classes are used (one controller, a shared partial, the layout, a class family, unused), with line ranges and an import order that keeps the cascade.', inputSchema: { type: 'object', properties: { path }, required: ['path'] } },
  { name: 'routes', description: 'URLs, the actions answering them and the views they return.', inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Only rows containing this text' } } } },
  { name: 'problems', description: 'References Pilot could not resolve (missing partials, layouts, scripts, styles, imports) and those decided at run time.', inputSchema: { type: 'object', properties: { filter: { type: 'string', description: 'Only problems in files or messages containing this text' } } } },
  { name: 'changes', description: 'The pages the changed files reach (git: uncommitted and untracked files, and with base everything since that branch/commit), most affected first: what to check after a change.', inputSchema: { type: 'object', properties: { base: { type: 'string', description: 'A branch, tag or commit, e.g. main' } } } },
  { name: 'context', description: 'The code that matters for one page in a single Markdown document within a budget: the view and its partials whole, the controller actions (the page\'s and those its requests reach), the script parts touching its markup, the CSS rules for its classes, its layouts last. Read this instead of opening files one by one.', inputSchema: { type: 'object', properties: { target, budget: { type: 'number', description: 'Characters, default 60000' } }, required: ['target'] } },
  { name: 'rename', description: 'Renames a CSS class or id in styles, views and scripts. A preview unless apply is true; warns where it can\'t be done by text (LESS &-suffix names, names built at run time, collisions, built files).', inputSchema: { type: 'object', properties: { from: { type: 'string', description: '.old-class or #old-id' }, to: { type: 'string' }, apply: { type: 'boolean', description: 'Write the files (default false: preview)' } }, required: ['from', 'to'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: 'cascade', description: 'Every rule that can style a class or id on a page, in the order the browser applies them (LESS imports inlined), with specificity, declarations, which value wins per property, and rules in stylesheets the page does not load. Use when a style change "does not show".', inputSchema: { type: 'object', properties: { page: target, selector: { type: 'string', description: '.class or #id' } }, required: ['page', 'selector'] } },
  { name: 'dead_code', description: 'Views, scripts, stylesheets, LESS variables and mixins, and styled classes that nothing uses.', inputSchema: { type: 'object', properties: {} } },
  { name: 'design', description: 'Design consistency: colours written out that a variable holds, look-alike colours, breakpoints, z-index values, !important, inline styles in views.', inputSchema: { type: 'object', properties: {} } },
  { name: 'repeats', description: 'Markup repeated across views (min lines shaped alike), with a partial name to extract it into.', inputSchema: { type: 'object', properties: { min: { type: 'number' } } } },
  { name: 'accessibility', description: 'Accessibility problems the markup shows: images without alt, unlabelled fields, empty buttons and links, clickable elements without keyboard access, positive tabindex, missing lang, duplicate ids.', inputSchema: { type: 'object', properties: { rule: { type: 'string', description: 'Only one rule, e.g. img-alt' } } } },
  { name: 'weight', description: 'What each page loads and weighs (scripts, styles), libraries loaded twice, and the heaviest files.', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } },
  { name: 'diagram', description: 'A page (or a file\'s neighbourhood, or a path with to) as a Mermaid diagram, for a pull request or docs; format dot for Graphviz.', inputSchema: { type: 'object', properties: { target, to: { type: 'string' }, depth: { type: 'number' }, format: { type: 'string', enum: ['mermaid', 'dot'] } }, required: ['target'] } },
  { name: 'screenshot', description: 'A full-page screenshot of a page of the running site with the local Chrome/Edge: the first is kept as before, later ones as after with a diff (share changed, regions, diff PNG). Read the PNG files it names to see them. Needs the site running: give url once.', inputSchema: { type: 'object', properties: { page: { type: 'string', description: 'A path (/Orders/Edit/5), URL or Controller.Action' }, url: { type: 'string', description: 'The running site, e.g. http://localhost:5000 (remembered)' }, widths: { type: 'array', items: { type: ['number', 'string'] }, description: 'e.g. [1280, "mobile"]' }, as: { type: 'string', enum: ['before', 'after'] }, cookies: { type: 'array', items: { type: 'string' }, description: 'name=value, for a signed-in session' } }, required: ['page'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
].map((t) => ({ ...t, annotations: t.annotations ?? { readOnlyHint: true, openWorldHint: false } }));

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
      path: () => pathBetween(current(), need(args, 'from'), need(args, 'to')),
      widgets: () => widgets(current(), { kind: args.kind ?? '' }),
      complexity: () => complexity(current(), { filter: args.filter ?? '' }),
      stylesheets: () => stylesheets(current()),
      split: () => split(current(), need(args, 'path')),
      changes: async () => (await import('./changes.js')).changes(current(), { base: args.base ?? null }),
      context: async () => (await import('./context.js')).context(current(), need(args, 'target'), { budget: Number(args.budget) || 60000 }),
      rename: async () => (await import('./rename.js')).rename(current(), need(args, 'from'), need(args, 'to'), { apply: args.apply === true }),
      cascade: async () => (await import('./cascade.js')).cascade(current(), need(args, 'page'), need(args, 'selector')),
      dead_code: async () => (await import('./audit.js')).deadCode(current()),
      design: async () => (await import('./audit.js')).design(current()),
      repeats: async () => (await import('./audit.js')).repeats(current(), { min: Number(args.min) || 6 }),
      accessibility: async () => (await import('./audit.js')).a11y(current(), { rule: args.rule ?? '' }),
      weight: async () => (await import('./audit.js')).weight(current(), { filter: args.filter ?? '' }),
      diagram: async () => (await import('./diagram.js')).diagram(current(), need(args, 'target'), { to: args.to ?? null, depth: Number(args.depth) || 1, format: args.format === 'dot' ? 'dot' : 'mermaid' }),
      split_apply: async () => (await import('./refactor.js')).splitApply(current(), need(args, 'path'), { apply: args.apply === true, force: args.force === true }),
      extract_partial: async () => (await import('./refactor.js')).extractPartial(current(), Number(args.n) || 1, { name: args.name ?? null, apply: args.apply === true, force: args.force === true }),
      doctor: async () => (await import('./insight.js')).doctor(current()),
      view_models: async () => (await import('./insight.js')).models(current(), { filter: args.filter ?? '' }),
      hard_coded_text: async () => (await import('./insight.js')).texts(current(), { filter: args.filter ?? '' }),
      images: async () => (await import('./insight.js')).images(current()),
      styleguide: async () => (await import('./insight.js')).styleguide(current()),
      inspect: async () => (await import('./live.js')).inspect(current(), need(args, 'page'), need(args, 'selector'), { url: args.url ?? null, mobile: args.mobile === true }),
      coverage: async () => (await import('./live.js')).coverage(current(), Array.isArray(args.pages) ? args.pages : [need(args, 'pages')], { url: args.url ?? null }),
      responsive: async () => (await import('./live.js')).responsive(current(), need(args, 'page'), { url: args.url ?? null, widths: Array.isArray(args.widths) && args.widths.length ? args.widths : null }),
      screenshots: async () => (await import('./live.js')).shots(current(), Array.isArray(args.pages) && args.pages.length ? args.pages : args.which === 'all' ? 'all' : 'changed', { url: args.url ?? null, threshold: args.threshold ?? null }),
      report: async () => (await import('./report.js')).report(current()),
      screenshot: async () => (await import('./shots.js')).shot(current(), need(args, 'page'), { url: args.url ?? null, widths: Array.isArray(args.widths) && args.widths.length ? args.widths : [1280], as: args.as ?? null, cookies: Array.isArray(args.cookies) ? args.cookies : [] }),
      problems: () => problems(current(), { filter: args.filter ?? '' }),
    }[name];
    if (!run) return undefined;
    return (await run()).text;
  };
  return { call, index: current };
}

export function serve({ root = process.cwd() } = {}) {
  quietConsole();
  const server = createServer({ root: resolve(root) });
  const handle = mcpHandler({ name: 'pilot', version: VERSION, instructions: INSTRUCTIONS, tools: TOOLS, call: server.call });
  serveMcp({ handle });
}
