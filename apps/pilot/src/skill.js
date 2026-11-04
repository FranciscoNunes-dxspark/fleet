// The Claude Code skill `pilot init` writes into a project (.claude/skills/pilot/SKILL.md): when to
// reach for Pilot and in what order, through the CLI, so it works with or without the MCP server.
export const SKILL = `---
name: pilot
description: Map this ASP.NET MVC project before changing its UI. Use it to find which .cshtml views, partials, layouts, view components, TypeScript/JavaScript and LESS/CSS files make up a page, where a CSS class or id is styled, marked up and scripted, and which pages a change to a shared file reaches. Reach for it before editing any view, script or stylesheet for a UI change.
---

# Pilot: what to change, and where

Pilot indexes the project (controllers, views, layouts, partials, components, bundles, TypeScript,
JavaScript, LESS, SCSS, CSS) into one graph. Ask it before reading folders by hand: it answers with
\`path:line\` places from the project root. Run it from the project root (or pass \`--root\`). The first
run reads everything; later runs reuse a cache and only re-read changed files. If the \`pilot\` MCP
server is connected, its tools have the same names and answers.

## The order that works

1. \`pilot overview\`: the projects, areas, layouts, top-level stylesheets, bundles.
2. \`pilot page <url | Controller.Action | view>\`: for the screen the user means. It gives the action,
   the view, its layouts, the render tree (partials, components, templates, child actions, sections,
   in the order they render), the scripts and styles in load order, each with the file to edit
   (a .ts for a compiled .js, a .less for a compiled .css, the members of a bundle), the requests
   its scripts and markup make with the action and partial answering each and the element the
   answer goes into, its UI components (data tables, calendars, pickers…) and a complexity score.
3. \`pilot selector .some-class\` (or \`#id\`, \`[data-x]\`, \`btn-*\`): before changing or adding a style
   or markup. It lists every rule styling it, with the full nested LESS selector, every view marking
   it up and every script selecting or toggling it.
4. \`pilot impact <file>\`: before changing a shared partial, layout, script or stylesheet; it lists
   the pages it reaches. Prefer a change local to the page when a shared file reaches many.
5. \`pilot file <path>\`: one file in context: uses, used by, pages, classes and where each is styled.
6. \`pilot style @variable\` (or \`.mixin\`, \`--custom-prop\`): to reuse the project's variables and mixins
   instead of new literal values.

Also: \`pilot path <from> <to>\` (how a script reaches a partial, a page a stylesheet…),
\`pilot widgets [kind]\`, \`pilot complexity\`, \`pilot stylesheets\` and \`pilot split <file>\` (how to
break up a large LESS file by where its rules are used), \`pilot find <name>\`, \`pilot routes\`,
\`pilot problems\`. Add \`--json\` for data. \`pilot ui\` opens the same in a browser, with graphs,
for the user.

## Around a change

- Before: \`pilot context <page>\` gives the page's code in one document, the parts that matter only.
  With the site running, \`pilot shot <page> --url http://localhost:5000\` keeps a "before".
- A style that doesn't apply: \`pilot cascade <page> .class\` shows every rule in order, what wins,
  and rules in stylesheets the page doesn't load.
- Renaming a class or id: \`pilot rename .old .new\` previews every line; \`--apply\` writes them.
- After: \`pilot changes\` lists the pages the edits reach; \`pilot shot <page>\` again compares
  with the before (read the diff PNG it names).
- Housekeeping: \`pilot dead\`, \`pilot design\` (use the variables it names instead of literal
  colours), \`pilot repeats\`, \`pilot a11y\`, \`pilot weight\`; \`pilot diagram <page>\` for a PR.

## On a new project, and with the site running

- \`pilot doctor\` first: how much Pilot understood, so you know how far to trust it.
- \`pilot styleguide\` before adding styles: reuse the project's colours, variables and components.
- With the site running: \`pilot inspect <page> .class\` (what really styles it), \`pilot coverage
  <pages>\` (CSS and JS really used), \`pilot responsive <page>\` (each breakpoint), \`pilot shots
  changed\` (every page your edits reach, compared).
- Refactors: \`pilot split <file> --apply\` and \`pilot extract <n> --apply\` (preview without
  \`--apply\`; both back up what they change).

## Rules of thumb

- Edit sources, not outputs: Pilot says "built from … edit that instead" for compiled .js/.css and
  bundle outputs.
- Styles: put a rule in the stylesheet that already styles that component (selector shows it), using
  the variables the project defines (style). Check the stylesheet is loaded on the page (page's
  Styles list) before relying on it.
- Scripts: a class or id renamed in a view must be renamed in every script selector selector lists.
- Partials returned to AJAX requests: \`page\` and \`path\` show which script inserts them where;
  markup changed in such a partial must still fit the element it lands in and the script's selectors.
- Splitting stylesheets: follow \`split\`'s import order, and keep the order-sensitive classes it
  lists in the same relative order.
- Pilot reads with patterns, not a compiler: names built at run time are reported as such, and a
  "(guessed)" match was found by name outside MVC's usual view folders. Check those by reading.
`;
