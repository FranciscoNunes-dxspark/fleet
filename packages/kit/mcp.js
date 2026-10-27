// An MCP server over stdio (JSON-RPC 2.0, one message a line), hand-rolled rather than the SDK: the
// apps only ever offer tools, which takes a few dozen lines, and the Bun builds stay small. Trawl's
// `trawl mcp` and Fleet's `fleet mcp` are built on it. stdout carries only protocol messages, so
// anything else a server says goes to stderr.
import { createInterface } from 'node:readline';

/** The protocol versions understood; an unknown one asked for is answered with the newest. */
export const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

/** A tool's failure in words Claude can act on: returned as the tool's result, marked isError. */
export class ToolError extends Error {}

/**
 * Handles one JSON-RPC message; `handle(msg)` resolves with the response, or null for a notification.
 * `tools` is what tools/list answers ({ name, description, inputSchema, annotations? }), or a function
 * returning it (or a promise of it); `call(name, args)` runs one and resolves with its text, and
 * resolves undefined (or throws an Error with `unknown` set) for a tool it doesn't have.
 */
export function mcpHandler({ name, version, instructions, tools, call }) {
  return async function handle(msg) {
    const reply = (result) => (msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => (msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS.at(-1),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: typeof tools === 'function' ? await tools() : tools });
      case 'tools/call': {
        const { name: tool, arguments: args = {} } = msg.params ?? {};
        try {
          const text = await call(tool, args ?? {});
          if (text === undefined) return fail(-32602, `Unknown tool: ${tool}`);
          return reply({ content: [{ type: 'text', text: String(text) }] });
        } catch (e) {
          if (e?.unknown) return fail(-32602, `Unknown tool: ${tool}`);
          // Tool failures go back to Claude as results it can read and act on.
          return reply({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : `Error: ${e?.message ?? e}` }], isError: true });
        }
      }
      default:
        if (msg.method?.startsWith('notifications/')) return null;
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  };
}

/**
 * Serves `handle` on `input`/`output`, one JSON-RPC message per line, answering each as it finishes
 * (Claude calls tools in parallel). `onClose` runs when the input ends: the client went away.
 */
export function serveMcp({ handle, input = process.stdin, output = process.stdout, onClose = () => process.exit(0) }) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const res = await handle(msg).catch((e) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } }));
    if (res) output.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', onClose);
  return rl;
}

/**
 * Keeps stdout for the protocol: console.log and its kin (a library's chatter) go to stderr instead,
 * since a stray line on stdout would be read as a broken message.
 */
export function quietConsole() {
  const toErr = (...args) => console.error(...args);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}
