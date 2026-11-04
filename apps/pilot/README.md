<p align="center"><img src="assets/logo.png" width="96" alt="Pilot"></p>

# Pilot

An ASP.NET MVC project mapped for Claude Code. Pilot reads a project's controllers, `.cshtml`
views, layouts, partials, view components, editor and display templates, bundles, TypeScript,
JavaScript, LESS, SCSS and CSS, and links them into one graph. Claude (or you) can then ask:

- **What is this page made of?** The action, the view, its layouts, every partial, component,
  template and child action in the order they render, and every script and stylesheet the page
  loads, each with the file to edit.
- **Where is this class styled, marked up and scripted?** Every rule (with its full nested LESS
  selector and any `@media`), every view and every script selector.
- **What does a change to this file reach?** The files that include it, the views and layouts, and
  the pages (URLs).
- **What does this page ask the server for?** Every request its scripts and markup make (`$.get`,
  `$.post`, `.load`, `$.ajax`, `fetch`, axios, Angular's `http`, `@Url.Action` in a script, `data-url`,
  unobtrusive `data-ajax`, htmx, `Ajax.BeginForm`), the action answering it, the partial view, view or
  JSON it returns, and the element the answer goes into: `orders.ts:14 GET /Orders/Row →
  OrdersController.Row → partial _OrderRow.cshtml → into #orders (Index.cshtml:5)`.
- **Which UI components are on it?** Data tables, calendars, date pickers, charts, selects, modals,
  tabs, editors, uploads, trees and more (DataTables, Kendo, DevExtreme, ag-Grid, FullCalendar,
  flatpickr, select2, Chart.js, TinyMCE…), with the element each binds to.
- **How complex is it?** A score from 0 to 100 for every page, with what adds to it.
- **How could this big stylesheet be split?** By where its rules are used, with line ranges and an
  import order that keeps the cascade.

And `pilot ui` shows all of it in the browser: an interactive dependency graph, the pages ranked by
complexity, each page's structure, requests, components and assets, the components, the stylesheets
and their split, selectors, and the source of any `file:line`.

It is made for UI work on large projects, where reading folders by hand to find the right
partial or stylesheet costs more than the change itself. It works with MVC 5 (.NET Framework:
`BundleConfig`, `_ViewStart`, `Html.Partial`, `Html.Action`, Web Compiler) and ASP.NET Core MVC
(attribute routes, tag helpers, `<partial>`, `<vc:…>`, `wwwroot`, `bundleconfig.json`, tsconfig
`outDir`, webpack entries), and with solutions holding several web projects.

## Install and use with Claude Code

```bash
pilot init                                   # in the project: adds .claude/skills/pilot/SKILL.md
claude mcp add pilot -- pilot mcp --root .   # optional: the same queries as MCP tools
```

The skill tells Claude when to reach for Pilot and in what order; it calls the CLI, so it works
without the MCP server. With the server, Claude gets the tools `overview`, `page`, `file`, `impact`,
`selector`, `style`, `find`, `routes` and `problems`, with the same answers. The server keeps the
index in memory and re-reads the files that changed (at most every two seconds) before a call, so
it sees Claude's own edits.

From a checkout of this repository: `node apps/pilot/bin/pilot.js …` (Node 22+); `npm run build`
in `apps/pilot` makes a standalone executable.

## Commands

| Command | What it answers |
| --- | --- |
| `pilot overview` | Web projects, areas, counts, layouts and how many views use each, top-level stylesheets, bundles, build configs |
| `pilot page <target>` | Everything a page is made of. A target is a URL (`/Orders/Edit/5`, `http://localhost/products/3`), `Controller.Action` (`Orders.Edit`, `OrdersController.Edit`, `Admin/Users.Index`), a route (`Orders/Edit`) or a view (`Views/Orders/Edit.cshtml`, `_Header`) |
| `pilot file <path>` | One file in context: what it uses and what uses it, the pages it ends up on, what it's built from or builds to; a view's or script's classes and where each is styled, event attributes and the functions they call; a script's definitions and server calls; a stylesheet's variables and mixins; a controller's actions, URLs and views |
| `pilot impact <path>` | The pages, views, layouts and files a change to this file reaches |
| `pilot selector <sel>` | `.class`, `#id`, `[data-attr]`, a bare name (class or id) or a wildcard (`.btn-*`): where it's styled, marked up and scripted. `--vendor` adds rules in libraries |
| `pilot style <name>` | A LESS or SCSS variable (`@brand`, `$brand`), custom property (`--brand`) or mixin (`.rounded`): definitions, uses, and the top-level stylesheets that compile it in |
| `pilot find <name>` | Views, partials, controllers, actions, view components, bundles, script functions and classes, style variables and mixins, files |
| `pilot path <from> <to>` | How two things connect, step by step, forward first: `pilot path Orders.Index _OrderRow` → the view, its script, the request, the action, the partial |
| `pilot widgets [kind]` | The UI components by kind and library, where each is set up, the element it binds to and its pages |
| `pilot complexity [filter]` | Every page with its complexity score, highest first |
| `pilot stylesheets` | The stylesheets, largest first |
| `pilot split <stylesheet>` | How to split a large LESS/SCSS/CSS file (below) |
| `pilot ui` | The web UI (below); `--port`, `--no-open` |
| `pilot routes [filter]` | URLs, the actions answering them and their views |
| `pilot problems [filter]` | References Pilot couldn't resolve (missing partials, layouts, scripts, styles, imports) and names decided at run time |
| `pilot mcp` | Serves the queries as MCP tools over stdio |
| `pilot init` | Writes the Claude Code skill into the project |

`page` also lists the requests the page makes and what answers them, its components, and its
score.

Options: `--root <dir>` (default: the current folder), `--json` (data instead of text),
`--no-cache`, `--vendor` (read library files for selectors too), `--ignore <a,b>` (more folders to
leave out). Exit codes: 0 answered, 1 not found, 2 a usage error or a failure.

Every place is printed as `path:line` from the root.

## What it follows

- **Views to views.** A view's `Layout`, else its nearest `_ViewStart`'s (none for partials);
  `Html.Partial`/`RenderPartial`/`PartialAsync`, `<partial name>`, `RenderPage`;
  `EditorFor`/`DisplayFor` with a template name; `Html.Action`/`RenderAction` (child actions, to the
  action's view); `Component.InvokeAsync` and `<vc:…>` (to `Components/<Name>/<View>.cshtml` and the
  class). Names are looked up as MVC does (the view's folder, the area's, `Views/<Controller>`,
  `Shared`), then by name anywhere in the project, marked "(guessed)".
- **Sections.** `@section X { … }` placed where the layout calls `RenderSection("X")`, through
  nested layouts.
- **Controllers to views.** `View()`, `View("Name")`, `PartialView(…)`, `[ActionName]`, `[NonAction]`,
  `[ChildActionOnly]`, HTTP verbs, actions inherited from the project's base controllers.
- **URLs to actions.** Attribute routes (`[Route]`, `[HttpGet("{id:int}")]`, `[controller]`,
  constraints), and conventional `[area/]controller/action` with each project's `MapRoute` /
  `MapControllerRoute` defaults. Links (`ActionLink`, `Url.Action`, `BeginForm`, `asp-action`,
  `href="/x/y"`) and script calls (`$.post('/Orders/Save')`, `fetch(`/api/x/${id}`)`) are linked to
  the actions they reach.
- **Assets.** `<script src>`, `<link href>`, `asp-src-include`, `Scripts.Render`/`Styles.Render`,
  `~/` and `wwwroot`; `BundleConfig` bundles (`{version}`, `IncludeDirectory`, wildcards).
- **Built files to sources.** `.js` from `.ts` beside it or by tsconfig `outDir`/`rootDir`/`outFile`;
  `.css` from `.less`/`.scss` beside it or by Web Compiler's `compilerconfig.json`; outputs of
  `bundleconfig.json` and webpack entries; `.min` files from the plain one. A reference to a file
  that isn't built yet reaches its source.
- **Imports.** ES modules, `require`, AMD `define([…])`, `/// <reference>`, tsconfig `paths` and
  `baseUrl`; LESS `@import` (with options), SCSS `@import`/`@use`/`@forward` and partials.
- **Selectors.** In views: `class` (with Razor in it: `@(x ? "a" : "b")`), `@class =` in helpers,
  `id`, `data-` attributes, `on…` handlers; inline `<script>` and `<style>`. In scripts: jQuery
  and DOM selectors, `addClass`/`classList`/`className`, markup in strings, and string literals
  that are selectors. In styles: every rule's full selector, with `&` and nesting resolved, mixins
  (definitions are not page classes), variables, `@media`.

Libraries (`wwwroot/lib`, `*.min.js`, `jquery-*.js`, `bootstrap*`, `.d.ts`…) are indexed so
references resolve, but not read for selectors unless `--vendor` is given. `bin`, `obj`,
`node_modules`, `packages` and hidden folders are skipped.

## The web UI

`pilot ui` indexes the project, serves a page on `http://127.0.0.1:4170` (the next free port if that
one's taken) and opens the browser. Everything is in Pilot itself, with no build step and nothing
loaded from the network. It listens on this machine only, answers only requests addressed to
`127.0.0.1` or `localhost`, and only shows files of the project. Edits show up on the next click
(files that changed are read again); **Re-index** reads everything again.

- **Overview**: counts, the most complex pages, layouts, components, the largest stylesheets.
- **Pages**: every page with its score, views, depth, script lines, widgets and requests; sort and
  filter. A page shows its **Structure** (the render tree, outermost layout first, the layouts' part
  faded), its **Requests** (script → method and URL → action → partial and what it includes → the
  element it lands in), its **Components**, its **Scripts & styles** in load order with the sources to
  edit, and its **Score** broken down.
- **Graph**: a node and what's around it: what uses it on the left, what it uses on the right,
  `depth` steps each way. Edge kinds can be shown or hidden (layout, partial, renders, script, style,
  import, calls, link…), libraries too; layered or force layout; drag to pan, wheel to zoom, hover
  to light a node's edges, click for its details, double-click to centre on it. **path to…** draws
  the chain from the centre to anything else.
- **Components**: the widgets by kind and library, with where each is set up, what it binds to and
  its pages.
- **Stylesheets**: the largest first; one shows its split as a coloured map of the file, the new
  files with their line ranges and why, the `@import` list to replace it with, and the classes whose
  order matters.
- **Selectors**: where a class or id is styled, marked up and scripted.
- **Problems**: what couldn't be resolved, and what's decided at run time.

Any `file:line` opens the file there, in a panel beside the page.

## Complexity

A page's score adds up what belongs to the page itself (its view, the partials, components,
templates and child actions it renders, its sections, and the scripts it loads with their imports),
not its layouts', which every page shares:

| Measure | Points |
| --- | --- |
| views and partials | 8 × log₂(1 + n) |
| nesting depth | 3 × depth |
| markup lines | 8 × log₂(1 + lines / 40) |
| script lines | 10 × log₂(1 + lines / 80) |
| widgets | 3 × their weight (a data table, calendar, rich editor or framework 3; a chart, map, wizard, tree or upload 2; a select, date picker, modal, tabs or form 1; a table 0.5…) |
| server requests | 3 each |
| child actions, view components | 4 and 3 each |
| names decided at run time | 2 each |
| distinct classes | 3 × log₂(1 + n / 15) |

The total `t` becomes `100 × (1 − e^(−t/120))`: 0–29 simple, 30–54 moderate, 55–74 complex, 75 and up
very complex. It's a way to rank pages against each other in one project, not an absolute measure.

## Splitting a stylesheet

`pilot split <file>` (or the Stylesheets view) reads the file's top-level blocks and gives each a new
file:

- variables → `base/variables`, mixin definitions → `base/mixins`, `@font-face` → `base/fonts`,
  `@keyframes` → `base/animations`, rules on elements only (`body`, `h1`) → `base/elements`;
- a rule whose classes are used only by the layout and its shared partials → `layout`;
- only by one controller's views → `pages/<controller>`; only by one shared partial or view component
  → `components/<name>`;
- across pages, by the classes' common prefix (`.btn-*` → `components/btn`), else by the section
  heading it's under (`// ===== Forms =====` → `common/forms`), else `common/shared`;
- classes no view or script uses → `unused` (check for names built at run time before deleting).

`@media` blocks go with the rules inside them. The suggested `@import` order (base, layout, common,
components, pages) keeps each file's own order; classes styled in more than one new file are listed,
as their order matters. A file that only imports others points at the largest of them instead. Pilot
suggests; it doesn't move anything.

## Limits

Pilot reads files with patterns, not with Razor's compiler, Roslyn or a TypeScript or LESS
compiler. A name built at run time (`Html.Partial(Model.Name)`, `View(viewName)`, `'btn-' + kind`)
isn't followed; `page`, `file` and `problems` list those it saw. A request whose URL is a variable
(`$.get(url)`) is found but can't be followed, unless the URL is written in the view
(`data-url="@Url.Action(…)"`) or as a literal. Components are found by their libraries' usual calls
and markup; a project's own wrappers around them count only if they call the library where Pilot
can see it. Custom view locations and feature
folders are found by name, as guesses. Razor Pages, Blazor and `.vbhtml` beyond the basics aren't
modelled.

## The cache

The parsed files are kept in `~/.cache/pilot` (`%LOCALAPPDATA%\pilot` on Windows; `PILOT_CACHE`
moves it), keyed by the project's path. A file is read again when its size or time changes, so a
large project is indexed once and then in about a second.
