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
| `pilot routes [filter]` | URLs, the actions answering them and their views |
| `pilot problems [filter]` | References Pilot couldn't resolve (missing partials, layouts, scripts, styles, imports) and names decided at run time |
| `pilot mcp` | Serves the queries as MCP tools over stdio |
| `pilot init` | Writes the Claude Code skill into the project |

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

## Limits

Pilot reads files with patterns, not with Razor's compiler, Roslyn or a TypeScript or LESS
compiler. A name built at run time (`Html.Partial(Model.Name)`, `View(viewName)`, `'btn-' + kind`)
isn't followed; `page`, `file` and `problems` list those it saw. Custom view locations and feature
folders are found by name, as guesses. Razor Pages, Blazor and `.vbhtml` beyond the basics aren't
modelled.

## The cache

The parsed files are kept in `~/.cache/pilot` (`%LOCALAPPDATA%\pilot` on Windows; `PILOT_CACHE`
moves it), keyed by the project's path. A file is read again when its size or time changes, so a
large project is indexed once and then in about a second.
