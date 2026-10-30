// `fleet mcp`: the whole family as one MCP server for Claude Code, read-only. Most tools run here,
// on the apps' own modules (imported when first called, so listing the tools stays quick); Trawl's
// are Trawl's own server (`trawl mcp`), in a child process through proxy.js. Every answer leaves through bound.js's `finish`: secrets masked, the size bounded.
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ToolError, mcpHandler, quietConsole, serveMcp } from '@fleet/kit/mcp.js';
import { COMPILED, VERSION } from '../app.js';
import { finish } from './bound.js';
import { bosunTools } from './bosun.js';
import { familyTools } from './family.js';
import { gitTools } from './git.js';
import { hailTools } from './hail.js';
import { childServer, trawlCommand } from './proxy.js';
import { sonarSide } from './sonar.js';

export const INSTRUCTIONS = `Fleet reads the world of the family's apps for the project this server was started in, read-only: nothing here changes anything.
git_* is the repository (Splice). bosun_* is the project's processes as Bosun ran them (from its recordings; the current run included). hail_* is the project's .http requests and the responses Hail kept. sonar_* is Application Insights through the user's az sign-in. trawl_* is databases through Trawl's saved connections (start with trawl_list_connections). family_* is what the apps did lately (family_timeline), how they feel (family_moods: a quick read of what's wrong now) and what the project points at (family_wiring).
Secrets are never shown: they come back as ••••. Long answers are cut; ask for less (n, lines, limit, a path).`;

// Trawl's tools keep their own names under this prefix.
const TRAWL = 'trawl_';

/**
 * The server: `handle(msg)` for one JSON-RPC message, `close()`, and `call(name, args)` (its text,
 * for the tests). `project` is the folder the tools read for; `demo` puts Sonar and
 * Trawl on their demo data; `sonar` replaces that provider (the tests); `trawl` replaces
 * the child server (anything with `tools()`, `call()` and `close()`), or false to leave it out.
 */
export function createFleetServer({ project = process.cwd(), demo = false, compiled = COMPILED, sonar, trawl } = {}) {
  const root = resolve(project);
  const ctx = {
    project: root,
    demo,
    resolve: (p) => (p ? (isAbsolute(String(p)) ? resolve(String(p)) : resolve(root, String(p))) : root),
    relative: (p) => {
      const r = relative(root, p);
      return r && !r.startsWith('..') && !isAbsolute(r) ? r.replaceAll('\\', '/') : p;
    },
    dirOf: (p) => dirname(p),
  };
  const flag = demo ? ['--demo'] : [];
  const trawlServer = trawl === undefined ? childServer({ command: trawlCommand(flag, { compiled }), title: 'Trawl', cwd: root, version: VERSION }) : trawl || null;

  const local = [...gitTools, ...bosunTools, ...hailTools, ...sonarSide({ demo, override: sonar }), ...familyTools].map((t) => ({
    ...t,
    annotations: { readOnlyHint: true, openWorldHint: !/^(family|git|bosun|hail)_/.test(t.name), ...(t.annotations ?? {}) },
  }));

  // Trawl's list is its own server's answer; when Trawl can't start, its tools are left out.
  let trawlList = null;
  const trawlTools = () => {
    if (!trawlServer) return Promise.resolve([]);
    trawlList ??= trawlServer.tools().then(
      (list) => list.map((t) => ({ ...t, name: `${TRAWL}${t.name}`, description: `Trawl (SQL): ${t.description}` })),
      (e) => {
        process.stderr.write(`fleet mcp: Trawl's tools are left out: ${e.message}\n`);
        trawlList = null;
        return [];
      },
    );
    return trawlList;
  };

  const strip = ({ run: _run, ...t }) => t;
  const list = async () => [...local.map(strip), ...(await trawlTools())];

  async function call(name, args) {
    const tool = local.find((t) => t.name === name);
    let text;
    if (tool) text = await tool.run(args ?? {}, ctx);
    else if (trawlServer && String(name).startsWith(TRAWL)) text = await trawlServer.call(String(name).slice(TRAWL.length), args ?? {});
    else return undefined;
    return finish(text);
  }

  // Errors are masked too: a message can quote what failed.
  const guarded = async (name, args) => {
    try {
      return await call(name, args);
    } catch (e) {
      if (e instanceof ToolError) throw new ToolError(finish(e.message, 4000));
      throw new ToolError(finish(`Error: ${e?.message ?? e}`, 4000));
    }
  };

  const handle = mcpHandler({ name: 'fleet', version: VERSION, instructions: INSTRUCTIONS, tools: list, call: guarded });
  const close = () => {
    trawlServer?.close();
  };
  return { handle, close, call: guarded, list, ctx };
}

const USAGE = `fleet mcp [--project <dir>] [--demo]

Runs Fleet as an MCP server over stdio for Claude Code, reading the family's world for the
project in <dir> (default: the current folder), read-only and with secrets masked.
Register it once:  claude mcp add fleet -- fleet mcp
--demo puts Sonar and Trawl on their demo data.`;

/** `fleet mcp [args]`: serves on stdin and stdout until the client goes. */
export function serve(args = []) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  const at = args.indexOf('--project');
  const project = resolve(at >= 0 ? (args[at + 1] ?? '') : process.cwd());
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    process.stderr.write(`fleet mcp: ${project} isn't a folder.\n`);
    process.exit(2);
  }
  quietConsole();
  const demo = args.includes('--demo');
  const server = createFleetServer({ project, demo });
  serveMcp({
    handle: server.handle,
    onClose: () => {
      server.close();
      process.exit(0);
    },
  });
  process.stderr.write(`fleet ${VERSION} MCP server ready for ${project}${demo ? ' (demo data)' : ''}\n`);
}
