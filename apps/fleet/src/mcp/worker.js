// `fleet --mcp-worker keel [--demo]`: a small MCP server of one app's tools, in a process that is that
// app as far as the kit is concerned (src/main.js imports this only after the app's own configureApp
// module), which `fleet mcp` starts and passes those tools' calls to. Only Keel needs one so far.
import { ToolError, mcpHandler, quietConsole, serveMcp } from '@fleet/kit/mcp.js';
import { version } from '@fleet/kit/version.js';
import { KEEL_TOOLS, keelHandlers, openKeelForReading } from './keel.js';

export async function runWorker(id, args) {
  if (id !== 'keel') throw new Error(`fleet --mcp-worker: no worker for ${id}`);
  quietConsole();
  const demo = args.includes('--demo');
  // Opened on the first call, so a Keel that isn't set up only fails the calls, as a sentence.
  let handlers = null;
  const open = () => (handlers ??= openKeelForReading({ demo }).then(keelHandlers, (e) => {
    handlers = null;
    throw e;
  }));
  const handle = mcpHandler({
    name: 'fleet-keel',
    version: version(),
    tools: KEEL_TOOLS,
    async call(name, callArgs) {
      if (!KEEL_TOOLS.some((t) => t.name === name)) return undefined;
      const h = await open();
      try {
        return await h[name](callArgs);
      } catch (e) {
        throw e instanceof ToolError ? e : new ToolError(`Keel: ${String(e.message ?? e).split('\n')[0]}`);
      }
    },
  });
  serveMcp({ handle });
}
