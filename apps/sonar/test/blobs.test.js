// A storage account's blobs: Storage's XML, addresses and sizes, and browsing through the UI over the demo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { blobUrl, isText, parseBlobs, parseContainers, shortName, sizeText } from '../src/blobs.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('blobs: Storage\'s XML read, names decoded, addresses encoded part by part, sizes and text in words', () => {
  const { containers, next } = parseContainers('<EnumerationResults><Containers><Container><Name>a&amp;b</Name><Properties /></Container></Containers><NextMarker>x</NextMarker></EnumerationResults>');
  assert.deepEqual([containers[0].name, containers[0].access, next], ['a&b', 'private', 'x']);
  const page = parseBlobs('<Blobs><BlobPrefix><Name>d/</Name></BlobPrefix><Blob><Name>&lt;odd&gt;.txt</Name><Properties><Content-Length>3</Content-Length></Properties></Blob></Blobs><NextMarker></NextMarker>');
  assert.deepEqual([page.prefixes, page.blobs[0].name, page.blobs[0].size, page.next], [['d/'], '<odd>.txt', 3, null]);
  assert.equal(blobUrl({ host: 'h' }, 'c', 'a b/c#d.txt'), 'https://h/c/a%20b/c%23d.txt');
  assert.equal(blobUrl({ host: 'h' }, 'c'), 'https://h/c');
  assert.ok(isText({ name: 'x.json', type: 'application/octet-stream' }));
  assert.ok(isText({ name: 'x', type: 'text/plain' }));
  assert.ok(!isText({ name: 'x.zip', type: 'application/zip' }));
  assert.deepEqual([sizeText(512), sizeText(3500), sizeText(5 * 1024 * 1024), sizeText(3 * 1024 ** 3)], ['512 B', '3.4 KB', '5.0 MB', '3.0 GB']);
  assert.equal(shortName('orders/2026/x.csv', 'orders/'), '2026/x.csv');
});

test('↵ on a storage account: containers, folders, a blob in the viewer, its address copied; too big or not text is said; without the role, which one', async () => {
  const copied = [];
  const app = start({ copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contosoprodstore'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'find contosoprodstore');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('storage account'), 'the account');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contosoprodstore: containers') && frame().includes('invoices'), 'its containers');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contosoprodstore/exports/') && frame().includes('readme.txt'), 'the top of exports');
    assert.match(frame(), /▸ orders\//);
    app.stdin.write('j');
    await until(() => /❯\s+readme\.txt/.test(frame()), 'the cursor on readme.txt');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Nightly exports of the orders'), 'the blob shown');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('contosoprodstore/exports/') && !frame().includes('Nightly exports'), 'back');
    app.stdin.write('k');
    await until(() => /❯ ▸ orders\//.test(frame()), 'the cursor on orders/');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contosoprodstore/exports/orders/') && frame().includes('2026-10-24.csv'), 'the folder');
    assert.match(frame(), /2026-10-23\.csv\s+91 B\s+\S+ ago\s+Hot\s+text\/csv/);
    app.stdin.write('j');
    await until(() => /❯\s+2026-10-23\.csv/.test(frame()), 'the cursor on the first csv');
    app.stdin.write('y');
    await until(() => copied.length === 1, 'its address copied');
    assert.equal(copied[0], 'https://contosoprodstore.blob.core.windows.net/exports/orders/2026-10-23.csv');
    app.stdin.write('k');
    await until(() => /❯ ▸ archive\//.test(frame()), 'the cursor on archive/');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('2026-09.zip'), 'the archive');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('2026-09.zip is 5.0 MB: the viewer shows blobs up to 1.0 MB'), 'too big said');
    for (let i = 0; i < 4; i++) {
      app.stdin.write(KEYS.esc);
      await new Promise((r) => setTimeout(r, 60));
    }
    await until(() => frame().includes('╭─ Contoso Production'), 'back in Resources');
    app.stdin.write('/');
    await type(app.stdin, 'sub Contoso Dev');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Contoso Dev') && frame().includes('contosodevstore'), 'the dev subscription');
    app.stdin.write('/');
    await type(app.stdin, 'find contosodevstore');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('storage account'), 'the dev account');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Storage Blob Data Reader on contosodevstore is needed'), 'the role it needs');
  } finally {
    app.unmount();
  }
});
