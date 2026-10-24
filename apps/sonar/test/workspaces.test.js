// Log Analytics workspaces: in Resources, picked as the scope for Logs, completion from their own tables.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_TABLES, workspaceQuery } from '../src/demo.js';
import { completeQuery, workspaceStarter } from '../src/insights.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('completion from a workspace\'s own tables, and the demo workspace\'s answers', () => {
  assert.deepEqual(completeQuery('AppR', 4, WORKSPACE_TABLES).items, ['AppRequests']);
  assert.deepEqual(completeQuery('AppRequests | where Dur', 23, WORKSPACE_TABLES).items, ['DurationMs']);
  assert.deepEqual(completeQuery('req', 3).items, ['requests'], 'Application Insights\' by default');
  const now = Date.parse('2026-10-24T12:00:00Z');
  const items = [{ itemType: 'request', timestamp: '2026-10-24T11:00:00Z', name: 'GET /', resultCode: '200', success: true, duration: 5, operation_Id: 'o', cloud_RoleName: 'web' }];
  const tables = workspaceQuery(workspaceStarter, now, 1, items);
  assert.deepEqual(tables.rows, [['ContainerAppConsoleLogs_CL', 12], ['AppRequests', 1]]);
  assert.deepEqual(workspaceQuery("AppRequests | where AppRoleName == 'web' | count", now, 1, items).rows, [[1]]);
  assert.throws(() => workspaceQuery('Heartbeat', now), /it answers AppExceptions, AppRequests/);
});

test('a workspace in Resources: ↵ queries it in Logs, completion knows its tables, and c offers it', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'find contoso-logs');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Log Analytics workspace') && frame().includes('30 days'), 'its details');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('╭─ Logs') && frame().includes('ContainerAppConsoleLogs_CL') && frame().includes('AppRequests'), 'its tables in Logs');
    assert.match(frame(), /contoso-logs · \d+ rows/);
    app.stdin.write('e');
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('\x15');
    await type(app.stdin, 'AppE');
    await until(() => frame().includes('AppExceptions') && frame().includes('tab completes'), 'completion from its tables');
    app.stdin.write(KEYS.tab);
    await type(app.stdin, " | where AppRoleName == 'contoso-api' | take 5");
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('ExceptionType') && /5 rows/.test(frame()), 'its exceptions');
    app.stdin.write('c');
    await until(() => frame().includes('Application Insights to query') && /contoso-logs\s+contoso-prod\s+Log Analytics workspace/.test(frame()), 'the workspace offered');
  } finally {
    app.unmount();
  }
});
