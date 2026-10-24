// Cosmos DB: the account's API and throughput in words, and its databases listed through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { apiOf, containerFrom, cosmosFrom, dataExplorerUrl, throughputFrom, throughputText } from '../src/cosmos.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('cosmos: the API from kind and capabilities, throughput in words, a collection\'s shard key', () => {
  assert.equal(apiOf({ kind: 'GlobalDocumentDB', properties: { capabilities: [{ name: 'EnableTable' }] } }), 'Table');
  assert.equal(apiOf({ kind: 'MongoDB' }), 'MongoDB');
  assert.equal(cosmosFrom({ id: '/subscriptions/s/resourceGroups/rg/x', name: 'a', properties: { capabilities: [{ name: 'EnableServerless' }], disableLocalAuth: true } }).serverless, true);
  assert.equal(cosmosFrom({ id: 'x', name: 'a', properties: { disableLocalAuth: true } }).localAuth, 'Entra only');
  assert.deepEqual(throughputFrom({ properties: { resource: { throughput: 400 } } }), { manual: 400 });
  assert.equal(throughputFrom({}), null);
  assert.equal(throughputText({ autoscale: 1000 }), 'autoscale up to 1000 RU/s');
  assert.equal(containerFrom({ name: 'c', properties: { resource: { id: 'c', shardKey: { userId: 'Hash' } } } }).partitionKey, 'userId');
  assert.equal(dataExplorerUrl({ id: '/x' }), 'https://portal.azure.com/#resource/x/dataExplorer');
});

test('↵ on a Cosmos DB account: its databases, their containers, partition keys and throughput', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'find contoso-cosmos');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Cosmos DB account (NoSQL)') && frame().includes('West Europe, North Europe'), 'its details');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-cosmos: databases and containers') && frame().includes('events'), 'its databases');
    assert.match(frame(), /shop\s+database\s+autoscale up to 4000 RU\/s, shared/);
    assert.match(frame(), /└ orders\s+\/customerId\s+400 RU\/s/);
    assert.match(frame(), /└ carts\s+\/userId\s+the database's\s+ttl 86400 s/);
    assert.match(frame(), /└ events\s+\/deviceId, \/day \(hierarchical\)\s+autoscale up to 1000 RU\/s/);
  } finally {
    app.unmount();
  }
});
