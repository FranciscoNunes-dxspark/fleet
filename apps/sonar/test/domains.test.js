// /domains: an app's custom domains checked from the outside, through the kit's webchecks.js, over the
// demo's stand-in network (nothing leaves the machine).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { customDomains, domainsText } from '../src/domains.js';
import { demoAzure } from '../src/demo.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test("an app's custom domains leave Azure's own names out; the demo's are checked by the kit's checks", async () => {
  assert.deepEqual(customDomains({ hostNames: ['contoso-web.azurewebsites.net', 'shop.contoso.com', 'x.azurestaticapps.net'] }), ['shop.contoso.com']);
  assert.deepEqual(customDomains({ host: 'a.azurewebsites.net' }), []);
  const azure = demoAzure();
  const shop = await azure.domain('shop.contoso.com');
  assert.deepEqual(shop.findings.map((f) => f.rule).sort(), ['cert-expiring', 'missing-caa']);
  assert.equal(shop.enforced, true);
  assert.equal(shop.days, 20);
  const api = await azure.domain('api.contoso.com');
  assert.deepEqual(api.findings.map((f) => f.rule), ['no-https-redirect']);
  assert.match(domainsText([shop]), /^shop\.contoso\.com\n {2}MED  The certificate expires in 20 days[\s\S]*\n {2}A +20\.50\.2\.10\n {2}AAAA +—\n {2}CNAME +contoso-web\.azurewebsites\.net/);
});

test('/domains <app> shows its custom domains: records, https, the certificate and the findings', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'domains contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Domains of contoso-web'), 'the viewer');
    await until(() => frame().includes('No CAA record'), 'the checks');
    assert.match(frame(), /The certificate expires in 20 days/);
    app.stdin.write(' ');
    await until(() => /HTTPS +enforced \(http is sent to https\)/.test(frame()), 'the records, a page down');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Domains of contoso-web'), 'the viewer closed');
    app.stdin.write('/');
    await type(app.stdin, 'domains contoso-orders');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-orders has no custom domain'), 'the answer');
  } finally {
    app.unmount();
  }
});
