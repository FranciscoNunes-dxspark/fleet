import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../server/azdo/client.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a 401 among good answers is asked once more; twice in a row, the token is rejected', async (t) => {
  let answers = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return answers.shift() ?? json(200, { value: [] });
  });
  const client = createClient({ orgUrl: 'https://dev.azure.com/acme', pat: 'x' });

  // Azure DevOps turned a good token down for a moment: the second ask answers.
  answers = [json(401, { message: 'unauthorized' }), json(200, { count: 1, value: [{ id: 'r1' }] })];
  assert.deepEqual((await client.api('_apis/git/repositories')).value, [{ id: 'r1' }]);
  assert.equal(calls, 2);

  // Turned down again: it really is rejected, said once, without asking a third time.
  calls = 0;
  answers = [json(401, {}), json(401, {})];
  await assert.rejects(client.api('_apis/git/repositories'), (err) => err.code === 'token-rejected' && err.status === 401);
  assert.equal(calls, 2);
});
