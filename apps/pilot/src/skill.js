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
   in the order they render) and the scripts and styles in load order, each with the file to edit:
   a .ts for a compiled .js, a .less for a compiled .css, the members of a bundle.
3. \`pilot selector .some-class\` (or \`#id\`, \`[data-x]\`, \`btn-*\`): before changing or adding a style
   or markup. It lists every rule styling it, with the full nested LESS selector, every view marking
   it up and every script selecting or toggling it.
4. \`pilot impact <file>\`: before changing a shared partial, layout, script or stylesheet; it lists
   the pages it reaches. Prefer a change local to the page when a shared file reaches many.
5. \`pilot file <path>\`: one file in context: uses, used by, pages, classes and where each is styled.
6. \`pilot style @variable\` (or \`.mixin\`, \`--custom-prop\`): to reuse the project's variables and mixins
   instead of new literal values.

Also: \`pilot find <name>\`, \`pilot routes [filter]\`, \`pilot problems [filter]\`. Add \`--json\` for data.

## Rules of thumb

- Edit sources, not outputs: Pilot says "built from … edit that instead" for compiled .js/.css and
  bundle outputs.
- Styles: put a rule in the stylesheet that already styles that component (selector shows it), using
  the variables the project defines (style). Check the stylesheet is loaded on the page (page's
  Styles list) before relying on it.
- Scripts: a class or id renamed in a view must be renamed in every script selector selector lists.
- Pilot reads with patterns, not a compiler: names built at run time are reported as such, and a
  "(guessed)" match was found by name outside MVC's usual view folders. Check those by reading.
`;
