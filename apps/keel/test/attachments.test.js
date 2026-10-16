import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';
import { screenshotPng } from '../server/mock/files.js';

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
