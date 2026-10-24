// A container app's metrics beside it in Resources, as a web app's are.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('a container app shows its requests, CPU, memory and replicas over the span', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-worker'), 'the resources');
    app.stdin.write('/');
    await type(app.stdin, 'find contoso-worker');
    app.stdin.write(KEYS.enter);
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('container app') && /replicas\s+\S+\s+\d · peak \d/.test(frame()), 'its metrics');
    assert.match(frame(), /requests\s+\S+\s+\d+ requests/);
    assert.match(frame(), /cpu\s+\S+\s+\d+ millicores · peak/);
    assert.match(frame(), /memory\s+\S+\s+\d+ MB · peak/);
  } finally {
    app.unmount();
  }
});
