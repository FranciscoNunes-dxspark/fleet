// Testing in production: a slot's share of the traffic, /route's words, and /route through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, productionShare, routingFrom, withRoute } from '../src/routing.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('routing: the rules, a slot given its share or none, what production keeps, /route\'s words', () => {
  assert.deepEqual(routingFrom({ properties: { experiments: { rampUpRules: [{ actionHostName: 'a-beta.azurewebsites.net', reroutePercentage: 20 }] } } }), [{ slot: 'a-beta', host: 'a-beta.azurewebsites.net', percent: 20 }]);
  assert.deepEqual(routingFrom({}), []);
  const rules = [{ slot: 'staging', host: 's', percent: 10 }];
  const beta = { slot: 'beta', host: 'b' };
  assert.deepEqual(withRoute(rules, beta, 30).rules, [...rules, { slot: 'beta', host: 'b', percent: 30 }]);
  assert.deepEqual(withRoute(rules, { slot: 'staging', host: 's' }, 0).rules, []);
  assert.match(withRoute(rules, beta, 95).error, /would take 105%/);
  assert.equal(productionShare(withRoute(rules, beta, 30).rules), 60);
  assert.deepEqual(parseRoute('contoso-web staging 25'), { app: 'contoso-web', slot: 'staging', percent: 25 });
  assert.deepEqual(parseRoute('contoso-web/staging 7.5%'), { app: 'contoso-web', slot: 'staging', percent: 7.5 });
  assert.match(parseRoute('contoso-web staging lots').error, /isn't a percentage/);
  assert.match(parseRoute('contoso-web').error, /Say where/);
});

test('/route: the slot\'s share beside it, changed after typing the app\'s name, and taken away with 0', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  const rules = () => Object.values(app.provider.state.routing)[0];
  try {
    await until(() => /└ ● staging +→ 10%/.test(frame()), 'staging taking a tenth');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('routing   production 90%, staging 10%'), 'the split in the details');
    app.stdin.write('/');
    await type(app.stdin, 'route contoso-web staging 25');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Send 25% of contoso-web's traffic to staging?") && frame().includes('Production then keeps 75%'), 'the question');
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => rules()[0]?.percent === 25 && /└ ● staging +→ 25%/.test(frame()), 'staging taking a quarter');
    app.stdin.write('/');
    await type(app.stdin, 'route contoso-web staging 0');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Stop sending contoso-web's traffic to staging"), 'the question');
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => rules().length === 0 && !/→ \d+%/.test(frame()), 'no share left');
    app.stdin.write('/');
    await type(app.stdin, 'route contoso-web beta 5');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-web has no slot called beta (it has staging)'), 'a slot it does not have');
  } finally {
    app.unmount();
  }
});
