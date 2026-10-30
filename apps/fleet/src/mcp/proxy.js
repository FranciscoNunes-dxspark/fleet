// An MCP client of another process's server: how `fleet mcp` reaches the tools that must run in a
// process of their own app (Trawl's `trawl mcp`, Keel's worker). The child starts on first use and
// lives as long as this server; its stderr is kept to say why it failed, never passed to stdout.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ToolError } from '@fleet/kit/mcp.js';
import { APPS_DIR, launchCommand } from '../spaces.js';

/** How to start Trawl's own MCP server, `trawl mcp`, as Fleet starts Trawl. */
export const trawlCommand = (args = [], { compiled } = {}) => launchCommand('trawl', ['mcp', ...args], { compiled });

/**
 * A child MCP server started with `command` ([file, args]): `request(method, params)`, `tools()`
 * (its list, asked once), `call(name, args)` (its text, or a ToolError with it), `close()`.
 * `title` names it in errors; `timeout` bounds the start and each request, in ms.
 */
export function childServer({ command, title, env = process.env, cwd, timeout = 60_000, startTimeout = 15_000, version = '0' }) {
  let child = null;
  let ready = null;
  let seq = 0;
  const waiting = new Map();
  let stderr = '';
  let listed = null;

  const failAll = (error) => {
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(error);
    }
    waiting.clear();
  };

  const send = (method, params, ms = timeout) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new ToolError(`${title} didn't answer within ${Math.round(ms / 1000)} s.`));
      }, ms);
      timer.unref?.();
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    });

  const start = () => {
    const [file, args] = command;
    child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.stdin.on('error', () => {});
    const gone = (why) => {
      const said = stderr.trim().split('\n').filter((l) => !/MCP server ready/.test(l)).slice(-3).join(' ');
      failAll(new ToolError(`${title} stopped (${why})${said ? `: ${said}` : ''}.`));
      child = null;
      ready = null;
      listed = null;
    };
    child.on('error', (e) => gone(e.message));
    child.on('exit', (code, signal) => gone(signal ?? `exit ${code}`));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => {
      let msg;
      try {
        msg = JSON.parse(l);
      } catch {
        return;
      }
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new ToolError(`${title}: ${msg.error.message}`));
      else w.resolve(msg.result);
    });
    return send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fleet', version } }, startTimeout).then((r) => {
      child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    });
  };

  const request = async (method, params) => {
    if (!ready) {
      ready = start();
      ready.catch(() => {
        ready = null;
        child?.kill();
      });
    }
    await ready;
    return send(method, params);
  };

  return {
    request,
    async tools() {
      listed ??= request('tools/list').then((r) => r.tools ?? []);
      listed.catch(() => (listed = null));
      return listed;
    },
    async call(name, args) {
      const res = await request('tools/call', { name, arguments: args });
      const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (res.isError) throw new ToolError(text);
      return text;
    },
    close() {
      const c = child;
      if (!c) return;
      c.stdin.end();
      setTimeout(() => c.kill(), 2000).unref?.();
    },
  };
}
