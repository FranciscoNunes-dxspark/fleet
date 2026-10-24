// Service Bus: the pure rules, and the dead letters driven through the UI over the demo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bodyPreview, deadLetterPath, entityFrom, messageFrom, resendHeaders, resubmitPath, secretBody, totals } from '../src/servicebus.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('service bus: entities and where their dead letters are, a message from its headers, what a resubmitted copy carries, secret bodies', () => {
  const sub = entityFrom('subscription', { name: 'audit', properties: { countDetails: { activeMessageCount: 1, deadLetterMessageCount: 2 } } }, 'events');
  assert.deepEqual([sub.name, sub.path, deadLetterPath(sub), resubmitPath(sub)], ['events/audit', 'events/subscriptions/audit', 'events/subscriptions/audit/$DeadLetterQueue', 'events']);
  const q = entityFrom('queue', { name: 'q', properties: { messageCount: 4 } });
  assert.equal(resubmitPath(q), 'q');
  assert.deepEqual(totals([sub, { ...q, active: 4, deadLetter: 0, scheduled: 1 }]), { active: 5, deadLetter: 2, scheduled: 1 });
  const m = messageFrom({ headers: new Headers({ BrokerProperties: '{"MessageId":"a","SequenceNumber":5,"CorrelationId":"c-1","DeliveryCount":3}', 'Content-Type': 'text/plain', DeadLetterReason: '"Bad"', DeadLetterErrorDescription: '"It \\"broke\\""', Tenant: '"t1"', Location: 'https://x/lock' }), text: 'hi' });
  assert.deepEqual([m.id, m.sequence, m.reason, m.description, m.properties.Tenant ?? m.properties.tenant, m.lock, m.body], ['a', 5, 'Bad', 'It "broke"', 't1', 'https://x/lock', 'hi']);
  const h = resendHeaders(m);
  assert.deepEqual(JSON.parse(h.BrokerProperties), { MessageId: 'a', CorrelationId: 'c-1' });
  assert.equal(h['Content-Type'], 'text/plain');
  assert.equal(Object.keys(h).some((k) => /deadletter/i.test(k)), false);
  assert.ok(secretBody('{"card":{"token":"tok_1"}}'));
  assert.ok(secretBody('Server=x;Password=y'));
  assert.ok(!secretBody('{"orderId":"o-1"}'));
  assert.equal(bodyPreview('a\n  b', 10), 'a b');
  assert.equal(bodyPreview('x'.repeat(20), 10), `${'x'.repeat(9)}…`);
});

test('a namespace\'s queues and dead letters: peeked, a secret-looking body hidden until v, two resubmitted, the rest purged', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  const payments = () => app.provider.state.serviceBus[0].entities.find((e) => e.name === 'payments');
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'find contoso-bus');
    app.stdin.write(KEYS.enter);
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Service Bus namespace') && frame().includes('5 dead letters'), 'its details');
    assert.match(frame(), /payments\s+4 dead/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-bus: queues, topics, subscriptions') && frame().includes('events/audit'), 'its entities');
    assert.match(frame(), /queue\s+payments\s+12 active\s+4 dead\s+2 scheduled/);
    app.stdin.write('j');
    await until(() => /❯ queue\s+payments/.test(frame()), 'the cursor on payments');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Dead letters of payments') && frame().includes('4720'), 'its dead letters');
    assert.match(frame(), /4719 .*•••••• \(looks secret/);
    assert.doesNotMatch(frame(), /tok_live/);
    // The secret one, whole: hidden until v.
    app.stdin.write('j');
    await until(() => /❯ 4712/.test(frame()), 'the cursor on 4712');
    app.stdin.write('j');
    await until(() => /❯ 4719/.test(frame()), 'the cursor on 4719');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Dead letter 4719 of payments') && frame().includes('MaxDeliveryCountExceeded'), 'the dead letter');
    assert.doesNotMatch(frame(), /tok_live/);
    app.stdin.write('v');
    await until(() => frame().includes('tok_live_9f8e7d6c5b4a'), 'the body shown');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Dead letters of payments'), 'back to the list');
    // The first two, picked with v, resubmitted: production, so the namespace's name is typed.
    app.stdin.write('g');
    await until(() => /❯ 4711/.test(frame()), 'the cursor on the first');
    app.stdin.write('v');
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write('j');
    await until(() => /❯ 4712/.test(frame()), 'two picked');
    app.stdin.write('R');
    await until(() => frame().includes('Resubmit 2 dead letters of payments to payments?'), 'the question');
    await type(app.stdin, 'contoso-bus');
    app.stdin.write(KEYS.enter);
    await until(() => payments().dead.length === 2 && payments().active === 14, 'two moved');
    await until(() => frame().includes('Moved 2 of 2 to payments') && !frame().includes('4711'), 'the list read again');
    app.stdin.write('X');
    await until(() => frame().includes("Purge payments's dead letters"), 'the question');
    await type(app.stdin, 'contoso-bus');
    app.stdin.write(KEYS.enter);
    await until(() => payments().dead.length === 0 && frame().includes('payments has no dead letters'), 'all purged');
    app.stdin.write(KEYS.esc);
    await until(() => /payments\s+14 active\s+0 dead/.test(frame()), 'the counts read again');
  } finally {
    app.unmount();
  }
});
