import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSource } from '../client/src/images.js';

const ORG = ['https://dev.azure.com/acme/'];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

test('an image pasted into the text as base64 is shown as it is, with or without an organization', () => {
  assert.equal(imageSource(PNG, ORG), PNG);
  assert.equal(imageSource(PNG, []), PNG, 'demo data and GitHub-only setups too');
  assert.equal(imageSource('data:image/jpeg;base64,/9j/4AAQ', ORG), 'data:image/jpeg;base64,/9j/4AAQ');
  assert.equal(imageSource(' DATA:IMAGE/PNG;BASE64,iVBO\nRw0K ', ORG), 'DATA:IMAGE/PNG;BASE64,iVBORw0K', 'a line-wrapped one is joined up');
});

test('other data: addresses stay out', () => {
  assert.equal(imageSource('data:image/svg+xml;base64,PHN2Zz4=', ORG), null, 'an SVG is a document, not a picture');
  assert.equal(imageSource('data:text/html;base64,PGgxPg==', ORG), null);
  assert.equal(imageSource('data:image/png,<not base64>', ORG), null);
  assert.equal(imageSource('data:image/png;base64,abc"onerror=x', ORG), null);
});

test('images in the organization load through the server, anything else is never fetched', () => {
  assert.equal(imageSource('https://dev.azure.com/acme/_apis/wit/attachments/1', ORG), `/api/image?url=${encodeURIComponent('https://dev.azure.com/acme/_apis/wit/attachments/1')}`);
  assert.equal(imageSource('/acme/_apis/wit/attachments/2', ORG), `/api/image?url=${encodeURIComponent('https://dev.azure.com/acme/_apis/wit/attachments/2')}`);
  assert.equal(imageSource('https://evil.example/pixel.gif', ORG), null);
  assert.equal(imageSource('https://dev.azure.com/acme/x', []), null);
  assert.equal(imageSource('', ORG), null);
});
