import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ToolError, mcpHandler, serveMcp } from '../mcp.js';

const handler = () =>
  mcpHandler({
    name: 'demo',
    version: '1.2.3',
    instructions: 'Say hello.',
    tools: async () => [{ name: 'hello', description: 'Hello', inputSchema: { type: 'object', properties: {} } }],
    call: async (name, args) => {
      if (name === 'hello') return `hello ${args.who ?? 'you'}`;
      if (name === 'refuse') throw new ToolError('No.');
      if (name === 'break') throw new Error('broken');
      return undefined;
    },
  });

test('initialize answers the version asked for, or the newest', async () => {
  const handle = handler();
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.serverInfo, { name: 'demo', version: '1.2.3' });
  assert.equal(init.result.instructions, 'Say hello.');
  const odd = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.match(odd.result.protocolVersion, /^20\d\d-/);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
});

test('tools are listed and called; failures come back as results', async () => {
  const handle = handler();
  const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(list.result.tools[0].name, 'hello');
  const call = (name, args) => handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  assert.equal((await call('hello', { who: 'Claude' })).result.content[0].text, 'hello Claude');
  assert.deepEqual((await call('refuse')).result, { content: [{ type: 'text', text: 'No.' }], isError: true });
  assert.equal((await call('break')).result.content[0].text, 'Error: broken');
  assert.equal((await call('missing')).error.code, -32602);
});

test('serveMcp reads a message a line and answers on the output', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = false;
  serveMcp({ handle: handler(), input, output, onClose: () => (closed = true) });
  const lines = [];
  output.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  input.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\nnot json\n');
  input.end();
  await new Promise((r) => setTimeout(r, 50));
  // The ping waits for its handler; the parse error is answered at once, so order isn't fixed.
  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.deepEqual(byId[7], { jsonrpc: '2.0', id: 7, result: {} });
  assert.equal(byId.null.error.code, -32700);
  assert.ok(closed);
});
