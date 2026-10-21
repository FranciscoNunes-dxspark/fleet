import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';
import { screenshotPng } from '../server/mock/files.js';
import { createMockProvider } from '../server/mock/provider.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const GUID = '1f2e3d4c-5b6a-4789-8abc-def012345678';
const relations = [
  { rel: 'AttachedFile', url: `https://dev.azure.com/acme/abc/_apis/wit/attachments/${GUID}`, attributes: { name: 'error.png', resourceSize: 2048, comment: 'From QA', authorizedDate: '2026-10-01T10:00:00Z' } },
  { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://dev.azure.com/acme/_apis/wit/workItems/1' },
  { rel: 'AttachedFile', url: 'https://dev.azure.com/acme/_apis/wit/attachments/not-a-guid', attributes: { name: 'odd' } },
];
const provider = () => createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'test-token' });

test('attachments come from AttachedFile relations', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 7, fields: {}, relations }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await provider().listAttachments(7), [
    { id: GUID, name: 'error.png', size: 2048, comment: 'From QA', addedAt: '2026-10-01T10:00:00Z' },
  ]);
});

test('downloads stream from the attachments API with the file name', async () => {
  let asked;
  globalThis.fetch = async (url, init) => {
    asked = { url: new URL(url), auth: init.headers.Authorization };
    return new Response('hello', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': '5' } });
  };
  const file = await provider().downloadAttachment(GUID, 'notes v2.txt');
  assert.equal(asked.url.pathname, `/acme/_apis/wit/attachments/${GUID}`);
  assert.equal(asked.url.searchParams.get('fileName'), 'notes v2.txt');
  assert.equal(asked.url.searchParams.get('download'), 'true');
  assert.ok(asked.auth.startsWith('Basic '));
  assert.equal(file.length, 5);
  assert.equal(await new Response(file.stream).text(), 'hello');
});

test('signed storage redirects are followed without the token', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ host: new URL(url).host, auth: init.headers.Authorization });
    return seen.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://blob.example.net/file?sig=x' } })
      : new Response('data', { status: 200 });
  };
  await provider().downloadAttachment(GUID, 'a.bin');
  assert.equal(seen[1].host, 'blob.example.net');
  assert.equal(seen[1].auth, undefined);
});

test('the demo screenshot is a valid PNG', () => {
  const png = screenshotPng(3);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 480);
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});

test('uploading stores the file in the project, then links it to the work item', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), method: init.method, type: init.headers['Content-Type'], body: init.body });
    const reply = calls.length === 1 ? { id: GUID, url: `https://dev.azure.com/acme/_apis/wit/attachments/${GUID}` } : { id: 7 };
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const content = Buffer.from('log line\n');
  assert.deepEqual(await provider().uploadAttachment('Web Shop', 7, 'app log.txt', content), { id: GUID, name: 'app log.txt', size: 9 });
  const [upload, link] = calls;
  assert.equal(upload.method, 'POST');
  assert.equal(upload.url.pathname, '/acme/Web%20Shop/_apis/wit/attachments');
  assert.equal(upload.url.searchParams.get('fileName'), 'app log.txt');
  assert.equal(upload.type, 'application/octet-stream');
  assert.equal(upload.body, content, 'the bytes go as they are, not as JSON');
  assert.equal(link.method, 'PATCH');
  assert.equal(link.url.pathname, '/acme/_apis/wit/workitems/7');
  assert.deepEqual(JSON.parse(link.body), [{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: `https://dev.azure.com/acme/_apis/wit/attachments/${GUID}` } }]);
});

test('the service keeps only the file name and refuses empty files', async () => {
  const uploaded = [];
  const service = createService({
    provider: {
      getWorkItems: async (ids) => ids.filter((id) => id === 7).map((id) => ({ id, projectName: 'Shop' })),
      uploadAttachment: async (projectName, id, name, content) => (uploaded.push([projectName, id, name]), { id: GUID, name, size: content.length }),
    },
    settings: { load: async () => DEFAULT_SETTINGS, save: async () => DEFAULT_SETTINGS },
  });
  await service.addWorkItemAttachment(7, { name: 'C:\\fakepath\\shot.png', content: Buffer.from('x') });
  assert.deepEqual(uploaded, [['Shop', 7, 'shot.png']]);
  await assert.rejects(service.addWorkItemAttachment(7, { name: 'a.txt', content: Buffer.alloc(0) }), /empty/);
  await assert.rejects(service.addWorkItemAttachment(7, { name: '  ', content: Buffer.from('x') }), /needs a name/);
  await assert.rejects(service.addWorkItemAttachment(99, { name: 'a.txt', content: Buffer.from('x') }), { status: 404 });
});

test('in the demo, an attached file is listed and downloads as it was uploaded', async () => {
  const demo = createMockProvider();
  const [w] = await demo.getWorkItems([4107]);
  const added = await demo.uploadAttachment(w.projectName, 4107, 'notes.txt', Buffer.from('hello demo'));
  assert.ok((await demo.listAttachments(4107)).some((a) => a.id === added.id && a.name === 'notes.txt' && a.size === 10));
  const file = await demo.downloadAttachment(added.id, 'notes.txt');
  assert.equal(await new Response(file.stream).text(), 'hello demo');
});
