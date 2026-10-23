// What the siblings copy for Sonar, taken at its prompt: /take <context>, or the context on its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { takeLine, encodeContext } from '../src/family.js';
import { deploymentHasCommit, take } from '../src/actions.js';
import { problemLike } from '../src/ui/ProblemsView.jsx';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const command = async (app, line) => {
  app.stdin.write('/');
  await type(app.stdin, line.replace(/^\//, ''));
  app.stdin.write(KEYS.enter);
};

test('a commit by its hash, whole or short, in a deployment; a problem like an exception', () => {
  const d = { id: '/x/deployments/abc', name: 'f00dfeed99', message: 'Release\n\nCommit 9b1c7e2d4f60a8c3e1f2b7d9a5c4e3f2a1b0c9d8' };
  assert.ok(deploymentHasCommit(d, '9b1c7e2d4f60a8c3e1f2b7d9a5c4e3f2a1b0c9d8'));
  assert.ok(deploymentHasCommit(d, '9B1C7E2'));
  assert.ok(deploymentHasCommit(d, '9b1c7e2aaaaaaa'), 'the first seven are enough');
  assert.ok(deploymentHasCommit(d, 'f00dfeed99aabbccdd'), 'a name that is the start of the hash');
  assert.ok(!deploymentHasCommit(d, '1234567'));
  assert.ok(!deploymentHasCommit(d, 'abc'), 'too short to say');
  const p = { type: 'Microsoft.Data.SqlClient.SqlException', message: 'Transaction (Process ID 61) was deadlocked on lock resources' };
  assert.ok(problemLike(p, { type: 'SqlException' }));
  assert.ok(problemLike(p, { type: 'System.Data.SqlClient.SqlException' }));
  assert.ok(problemLike(p, { message: 'was deadlocked' }));
  assert.ok(!problemLike(p, { type: 'TimeoutException', message: 'timed out' }));
});

test('/take commit lists the deployments that shipped it across the apps, ↵ shows one\'s log', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    await command(app, takeLine('commit', { hash: '9b1c7e2d4f60', subject: 'The new checkout' }));
    await until(() => frame().includes('Deployments of 9b1c7e2d4f') && /❯ ⏺ contoso-web\s+succeeded\s+3d ago\s+Ana Silva\s+active\s+Release 2\.14\.0/.test(frame()), 'its deployments');
    assert.match(frame(), /5 deployments of it, in 5 of 5 apps and slots/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-web: deployment d3, succeeded'), 'its log');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Deployments of 9b1c7e2d4f'), 'back to the list');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Deployments of 9b1c7e2d4f'), 'closed');
    await command(app, takeLine('commit', { hash: '1234567890' }));
    await until(() => frame().includes('None of the 5 apps and slots has a deployment of it'), 'none of it');
  } finally {
    app.unmount();
  }
});

test('/take exception shows the problems like it, x shows them all; a bare context at the prompt is taken too', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    // Typed (or pasted) at the prompt without /take.
    app.stdin.write('/');
    await until(() => frame().includes('enter run'), 'the prompt');
    app.stdin.write(KEYS.backspace);
    await type(app.stdin, encodeContext('exception', { app: 'contoso-api', type: 'System.Data.SqlClient.SqlException', message: 'deadlocked', frames: [] }));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('╭─ Problems') && frame().includes('only SqlException (x all)') && frame().includes('contoso-prod-ai · contoso-api'), 'only the problems like it');
    assert.match(frame(), /SqlException\s+contoso-api/);
    assert.doesNotMatch(frame(), /TimeoutException/);
    app.stdin.write('x');
    await until(() => !frame().includes('(x all)') && frame().includes('TimeoutException'), 'all of them again');
  } finally {
    app.unmount();
  }
});

test('/take logline finds its request in Logs; other kinds are for the app that takes them', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  const notes = [];
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    const op = app.provider.state.telemetry.find((i) => i.itemType === 'request' && i.cloud_RoleName === 'contoso-web' && Date.parse(i.timestamp) > Date.now() - 20 * 3600_000).operation_Id;
    await command(app, takeLine('logline', { process: 'web', text: 'GET /api/cart 500', requestId: op }));
    await until(() => frame().includes('╭─ Logs') && frame().includes(`operation_Id == '${op}'`) && /\d+ rows/.test(frame()), "the request's whole story in Logs");
    assert.match(frame(), /request/);
    await command(app, takeLine('logline', { process: 'web', text: 'listening on 3000' }));
    await until(() => frame().includes('carries no request or operation id'), 'nothing to look for');
    await command(app, takeLine('request', { method: 'GET', url: 'https://x/y' }));
    await until(() => frame().includes("That's request GET https://x/y, for Hail: paste it into Hail's prompt instead."), 'a request is for Hail');
    await command(app, takeLine('query', { sql: 'select 1' }));
    await until(() => frame().includes("for Trawl: paste it into Trawl's prompt instead"), 'a query is for Trawl');
    await command(app, 'take nonsense');
    await until(() => frame().includes("That isn't a line one of the other apps copied"), 'nonsense refused');
  } finally {
    app.unmount();
  }
  // Straight through the action, as a check of what it says.
  const ctx = { note: (t, s) => notes.push([t, s]) };
  await take(ctx, takeLine('file', { path: 'src/a.js', line: 3 }));
  assert.deepEqual(notes, [["That's src/a.js:3, for Splice: paste it into Splice's prompt instead.", 'error']]);
});
