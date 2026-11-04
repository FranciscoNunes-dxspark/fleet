// /openapi-diff and hail openapi-diff: each rule in each direction over small pairs of documents, the
// fixtures' pairs (OpenAPI 3.0 to 3.1, Swagger 2), the reports, the headless exit codes, git:<ref>:<path>
// from a repository made here, and the viewer through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countsLine, diffJson, diffMarkdown, diffSources, diffSpecs, diffText, failingChanges, gitSource, loadSpec } from '../src/openapi-diff.js';
import { diffArgs, runOpenapiDiff } from '../src/headless.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openapi');

let cleanup;
let repo;
let gitConfig;
before(() => {
  cleanup = tempHome();
  repo = mkdtempSync(join(tmpdir(), 'hail-oad-'));
  // No git identity is needed or used (CI has none): commits name theirs on the command line.
  gitConfig = join(repo, '..', `hail-oad-gitconfig-${process.pid}`);
  writeFileSync(gitConfig, '');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  copyFileSync(join(FIXTURES, 'shop-v1.yaml'), join(repo, 'openapi.yaml'));
  git('add', '.');
  git('commit', '-q', '-m', 'v1');
  git('tag', 'v1');
  copyFileSync(join(FIXTURES, 'shop-v2.yaml'), join(repo, 'openapi.yaml'));
  writeFileSync(join(repo, 'api.http'), '### Orders\nGET https://shop.example.com/api/orders\n');
});
after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(gitConfig, { force: true });
  cleanup();
});

// A document of `paths` with `schemas` as its components.
const doc = (paths, schemas = {}, more = {}) => ({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths, components: { schemas }, ...more });
// GET /x answering `schema`, and POST /x taking it.
const answering = (schema, schemas) => doc({ '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema } } } } } } }, schemas);
const taking = (schema, schemas, required = true) => doc({ '/x': { post: { requestBody: { required, content: { 'application/json': { schema } } }, responses: { 204: { description: 'ok' } } } } }, schemas);
const obj = (properties, required = []) => ({ type: 'object', required, properties });
// The changes as "level rule @ where", to compare whole.
const said = (a, b) => diffSpecs(a, b).changes.map((c) => `${c.level} ${c.rule}${c.where ? ` @ ${c.where}` : ''}`);

test('operations: removed breaks, added doesn\'t, a renamed path parameter is the same path', () => {
  const v1 = doc({ '/a/{id}': { get: { operationId: 'getA', responses: { 200: { description: 'ok' } } }, delete: { responses: { 204: { description: 'gone' } } } } });
  const v2 = doc({ '/a/{aId}': { get: { operationId: 'fetchA', deprecated: true, responses: { 200: { description: 'ok' } } } }, '/b': { get: { responses: { 200: { description: 'ok' } } } } });
  assert.deepEqual(said(v1, v2), ['breaking operation-removed', 'may-break operation-id-changed', 'non-breaking operation-deprecated', 'non-breaking operation-added']);
  const r = diffSpecs(v1, v2);
  assert.equal(r.changes[0].operation, 'DELETE /a/{id}');
  assert.equal(r.changes[1].operation, 'GET /a/{aId}');
  assert.deepEqual(r.counts, { breaking: 1, 'may-break': 1, 'non-breaking': 2 });
  assert.deepEqual(said(v1, v1), []);
});

test('parameters: a new required one breaks, a new optional one doesn\'t, and their schemas are requests', () => {
  const p = (params) => doc({ '/x/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { parameters: params, responses: { 200: { description: 'ok' } } } } });
  const q = (name, schema, required = false) => ({ name, in: 'query', required, schema });
  assert.deepEqual(said(p([]), p([q('a', { type: 'string' }, true), q('b', { type: 'string' })])), ['breaking request-parameter-required-added @ query parameter a', 'non-breaking request-parameter-added @ query parameter b']);
  assert.deepEqual(said(p([q('a', { type: 'string' })]), p([q('a', { type: 'string' }, true)])), ['breaking request-parameter-became-required @ query parameter a']);
  assert.deepEqual(said(p([q('a', { type: 'string' }, true)]), p([q('a', { type: 'string' })])), ['non-breaking request-parameter-became-optional @ query parameter a']);
  assert.deepEqual(said(p([q('a', { type: 'string' })]), p([])), ['may-break request-parameter-removed @ query parameter a']);
  // Narrower breaks a request, wider doesn't.
  assert.deepEqual(said(p([q('n', { type: 'number' })]), p([q('n', { type: 'integer' })])), ['breaking request-type-narrowed @ query parameter n']);
  assert.deepEqual(said(p([q('n', { type: 'integer' })]), p([q('n', { type: 'number' })])), ['non-breaking request-type-widened @ query parameter n']);
  assert.deepEqual(said(p([q('e', { type: 'string', enum: ['a', 'b'] })]), p([q('e', { type: 'string', enum: ['a'] })])), ['breaking request-enum-value-removed @ query parameter e']);
  assert.deepEqual(said(p([q('e', { type: 'string', enum: ['a'] })]), p([q('e', { type: 'string', enum: ['a', 'b'] })])), ['non-breaking request-enum-value-added @ query parameter e']);
  assert.deepEqual(said(p([q('e', { type: 'string' })]), p([q('e', { type: 'string', enum: ['a'] })])), ['breaking request-enum-added @ query parameter e']);
  // A header's name is the same whatever its case.
  const h = (name) => p([{ name, in: 'header', schema: { type: 'string' } }]);
  assert.deepEqual(said(h('X-Trace'), h('x-trace')), []);
});

test('request bodies: what a client sends breaks it when the new version accepts less', () => {
  const base = obj({ name: { type: 'string', maxLength: 50 }, age: { type: 'integer', nullable: true }, kind: { type: 'string', enum: ['a', 'b'] }, id: { type: 'string', readOnly: true } }, ['name']);
  const changed = obj({ name: { type: 'string', maxLength: 20 }, age: { type: 'integer' }, kind: { type: 'string', enum: ['a', 'c'] }, email: { type: 'string' }, owner: { type: 'string' }, id: { type: 'string', readOnly: true }, made: { type: 'string', readOnly: true } }, ['name', 'kind', 'owner', 'made']);
  assert.deepEqual(said(taking(base), taking(changed)), [
    'breaking request-maxLength-narrowed @ request body $.name',
    'breaking request-no-longer-nullable @ request body $.age',
    'breaking request-property-became-required @ request body $.kind',
    'breaking request-enum-value-removed @ request body $.kind',
    'breaking request-property-required-added @ request body $.owner',
    'non-breaking request-enum-value-added @ request body $.kind',
    'non-breaking request-property-added @ request body $.email',
  ]);
  // The other way round, it accepts more, but for the enum value it had and doesn't now.
  assert.deepEqual(diffSpecs(taking(changed), taking(base)).changes.filter((c) => c.level === 'breaking').map((c) => c.text), ['enum value "c" removed']);
  assert.deepEqual(said(taking(obj({ a: { type: 'string' } })), taking(obj({}, []))), ['may-break request-property-removed @ request body $.a']);
  assert.deepEqual(said(taking(obj({ a: { type: 'string' } })), taking({ ...obj({}), additionalProperties: false })), ['breaking request-property-removed @ request body $.a', 'may-break request-additional-properties-closed @ request body']);
  // The body itself.
  assert.deepEqual(said(taking(base, {}, false), taking(base, {}, true)), ['breaking request-body-became-required @ request body']);
  assert.deepEqual(said(doc({ '/x': { post: { responses: { 204: { description: 'ok' } } } } }), taking(base)), ['breaking request-body-required-added @ request body']);
  const xml = doc({ '/x': { post: { requestBody: { content: { 'application/json': { schema: base }, 'application/xml': { schema: base } } }, responses: { 204: { description: 'ok' } } } } });
  assert.deepEqual(said(xml, taking(base, {}, false)), ['breaking request-media-type-removed @ request body']);
});

test('responses: what a client gets breaks it when the new version may say more or other', () => {
  const base = obj({ id: { type: 'integer' }, note: { type: 'string' }, total: { type: 'number' }, state: { type: 'string', enum: ['open', 'shut'] }, name: { type: 'string' }, secret: { type: 'string', writeOnly: true } }, ['id', 'name']);
  const changed = obj({ id: { type: 'number' }, total: { type: 'integer' }, state: { type: 'string', enum: ['open', 'shut', 'lost'] }, name: { type: 'string', nullable: true }, added: { type: 'string' } }, ['id']);
  assert.deepEqual(said(answering(base), answering(changed)), [
    'breaking response-property-removed @ response 200 $.note',
    'breaking response-type-widened @ response 200 $.id',
    'breaking response-became-nullable @ response 200 $.name',
    'may-break response-enum-value-added @ response 200 $.state',
    'may-break response-property-became-optional @ response 200 $.name',
    'non-breaking response-type-narrowed @ response 200 $.total',
    'non-breaking response-property-added @ response 200 $.added',
  ]);
  assert.deepEqual(said(answering({ type: 'string', enum: ['a', 'b'] }), answering({ type: 'string', enum: ['a'] })), ['non-breaking response-enum-value-removed @ response 200']);
  // A change of type is no narrowing or widening: it breaks either way.
  assert.deepEqual(said(answering({ type: 'string' }), answering({ type: 'integer' })), ['breaking response-type-changed @ response 200']);
  assert.deepEqual(said(taking({ type: 'string' }), taking({ type: 'integer' })), ['breaking request-type-changed @ request body']);
  // Statuses and media types.
  const st = (codes) => doc({ '/x': { get: { responses: Object.fromEntries(codes.map((c) => [c, { description: c, content: { 'application/json': { schema: { type: 'object' } } } }])) } } });
  assert.deepEqual(said(st(['200', '404']), st(['201', '500'])), ['breaking response-status-removed @ response 200', 'may-break response-success-status-added @ response 201', 'non-breaking response-status-removed @ response 404', 'non-breaking response-status-added @ response 500']);
  const media = (types) => doc({ '/x': { get: { responses: { 200: { description: 'ok', content: Object.fromEntries(types.map((t) => [t, { schema: { type: 'object' } }])) } } } } });
  assert.deepEqual(said(media(['application/json', 'text/csv']), media(['application/json', 'application/xml'])), ['breaking response-media-type-removed @ response 200', 'non-breaking response-media-type-added @ response 200']);
});

test('$refs within the document, a schema that contains itself, allOf and oneOf', () => {
  const schemas = (node) => ({ Node: obj({ name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }, ...node }) });
  const v1 = answering({ $ref: '#/components/schemas/Node' }, schemas({ size: { type: 'integer' } }));
  const v2 = answering({ $ref: '#/components/schemas/Node' }, schemas({}));
  // Said once, where it first is: comparing Node within Node again would never end.
  assert.deepEqual(said(v1, v2), ['breaking response-property-removed @ response 200 $.size']);
  // allOf's parts make one object.
  const all = (extra) => answering({ allOf: [{ $ref: '#/components/schemas/Base' }, obj(extra)] }, { Base: obj({ id: { type: 'string' } }, ['id']) });
  assert.deepEqual(said(all({ a: { type: 'string' }, b: { type: 'string' } }), all({ a: { type: 'string' } })), ['breaking response-property-removed @ response 200 $.b']);
  // oneOf's variants are paired by the $ref each is.
  const one = (refs, catSound = 'string') => answering({ oneOf: refs.map((r) => ({ $ref: `#/components/schemas/${r}` })) }, { Cat: obj({ sound: { type: catSound } }), Dog: obj({ bark: { type: 'string' } }), Fish: obj({}) });
  assert.deepEqual(said(one(['Cat', 'Dog']), one(['Cat', 'Dog', 'Fish'])), ['may-break response-variant-added @ response 200']);
  assert.deepEqual(said(one(['Cat', 'Dog']), one(['Dog'])), ['non-breaking response-variant-removed @ response 200']);
  assert.deepEqual(said(one(['Cat']), one(['Cat'], 'integer')), ['breaking response-type-changed @ response 200 $<Cat>.sound']);
  const takes = (refs) => taking({ oneOf: refs.map((r) => ({ $ref: `#/components/schemas/${r}` })) }, { Cat: obj({}), Dog: obj({}) });
  assert.deepEqual(said(takes(['Cat', 'Dog']), takes(['Dog'])), ['breaking request-variant-removed @ request body']);
  // A $ref to another file isn't followed, and isn't a change.
  assert.deepEqual(said(answering({ $ref: 'other.yaml#/Thing' }), answering({ $ref: 'other.yaml#/Thing' })), []);
});

test('OpenAPI 3.1 type lists and const, Swagger 2 inline parameters, x-nullable, formData and basePath', () => {
  // 3.1 says nullable as a type list.
  const v31 = (type) => ({ ...answering({ type }), openapi: '3.1.0' });
  assert.deepEqual(said(v31('string'), v31(['string', 'null'])), ['breaking response-became-nullable @ response 200']);
  assert.deepEqual(said({ ...taking({ type: ['string', 'null'] }), openapi: '3.1.0' }, { ...taking({ type: 'string' }), openapi: '3.1.0' }), ['breaking request-no-longer-nullable @ request body']);
  assert.deepEqual(said(answering({ type: 'string', const: 'a' }), answering({ type: 'string', enum: ['a', 'b'] })), ['may-break response-enum-value-added @ response 200']);
  // Swagger 2.
  const sw = (params, more = {}) => ({ swagger: '2.0', info: { title: 'S', version: '1' }, basePath: '/v1', paths: { '/x': { post: { consumes: ['application/x-www-form-urlencoded'], parameters: params, responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Out' } } } } } }, definitions: { Out: obj({ a: { type: 'string' } }) }, ...more });
  const limit = (max) => ({ name: 'limit', in: 'query', type: 'integer', maximum: max });
  const form = (required) => ({ name: 'name', in: 'formData', type: 'string', required });
  assert.deepEqual(said(sw([limit(100), form(false)]), sw([limit(50), form(true)])), ['breaking request-maximum-narrowed @ query parameter limit', 'breaking request-body-became-required @ request body', 'breaking request-property-became-required @ request body $.name']);
  assert.deepEqual(said(sw([]), { ...sw([]), definitions: { Out: obj({ a: { type: 'string', 'x-nullable': true } }) } }), ['breaking response-became-nullable @ response 200 $.a']);
  assert.deepEqual(said(sw([]), { ...sw([]), basePath: '/v2' }), ['breaking base-path-changed']);
  // An OpenAPI 3 server's path is the base path too.
  assert.deepEqual(said(doc({}, {}, { servers: [{ url: 'https://a.example.com/api' }] }), doc({}, {}, { servers: [{ url: 'https://b.example.com/api/' }] })), []);
});

test('security: a newly secured operation breaks its clients', () => {
  const sec = (security) => doc({ '/x': { get: { ...(security ? { security } : {}), responses: { 200: { description: 'ok' } } } } });
  assert.deepEqual(said(sec(null), sec([{ key: [] }])), ['breaking security-added']);
  assert.deepEqual(said(sec([{ key: [] }]), sec([{ oauth: [] }])), ['may-break security-changed']);
  assert.deepEqual(said(sec([{ key: [] }]), sec([])), ['non-breaking security-removed']);
  assert.deepEqual(said(sec([{}, { key: [] }]), sec([{ key: [] }])), ['breaking security-added']);
});

test('the fixtures: OpenAPI 3.0 to 3.1, and Swagger 2, with the reports', async () => {
  const shop = await Promise.all(['shop-v1.yaml', 'shop-v2.yaml'].map((f) => loadSpec(f, { cwd: FIXTURES })));
  assert.equal(shop[0].kind, 'OpenAPI 3.0.3');
  assert.equal(shop[1].kind, 'OpenAPI 3.1.0');
  const r = diffSpecs(shop[0].spec, shop[1].spec);
  assert.equal(countsLine(r.counts), '9 breaking · 3 may break · 5 non-breaking');
  const rules = new Set(r.changes.map((c) => `${c.level} ${c.rule} ${c.operation}`));
  for (const want of [
    'breaking operation-removed DELETE /orders/{id}',
    'breaking request-parameter-required-added GET /orders',
    'breaking response-property-removed GET /orders/{orderId}',
    'breaking response-type-widened POST /orders',
    'breaking request-maxLength-narrowed POST /orders',
    'may-break response-enum-value-added GET /orders',
    'non-breaking request-enum-value-added GET /orders',
    'non-breaking operation-added GET /customers',
  ])
    assert.ok(rules.has(want), want);
  const meta = { old: { source: 'shop-v1.yaml', ...shop[0], spec: undefined }, new: { source: 'shop-v2.yaml', ...shop[1], spec: undefined } };
  const text = diffText(r, meta);
  assert.match(text, /^shop-v1\.yaml \(Shop 1\.0\.0, OpenAPI 3\.0\.3\)\n→ shop-v2\.yaml \(Shop 2\.0\.0, OpenAPI 3\.1\.0\)\n9 breaking/);
  assert.match(text, /Breaking \(9\)\n {2}DELETE \/orders\/\{id\}\n {4}✗ removed {2}operation-removed/);
  const md = diffMarkdown(r, meta);
  assert.match(md, /^## API changes: `shop-v1\.yaml` → `shop-v2\.yaml`\n\n\*\*9 breaking · 3 may break · 5 non-breaking\*\* · Shop 1\.0\.0 → 2\.0\.0/);
  assert.match(md, /### May break \(3\)\n\n\| Operation \| Where \| Change \| Rule \|/);
  assert.match(md, /\| `GET \/orders` \| header parameter X-Tenant \| new required parameter \| `request-parameter-required-added` \|/);
  const json = diffJson(r, meta, 'may-break');
  assert.equal(json.check, 'openapi-diff');
  assert.equal(json.failing, 12);
  assert.equal(failingChanges(r.changes, 'breaking').length, 9);
  assert.equal(failingChanges(r.changes, 'none').length, 0);
  const pets = await Promise.all(['pets-v1.json', 'pets-v2.json'].map((f) => loadSpec(f, { cwd: FIXTURES })));
  assert.deepEqual(said(pets[0].spec, pets[1].spec), [
    'breaking request-enum-value-removed @ query parameter kind',
    'breaking response-became-nullable @ response 200 $[].tag',
    'breaking request-property-required-added @ request body $.owner',
    'breaking response-became-nullable @ response 201 $.tag',
  ]);
  assert.match(diffText({ changes: [], counts: { breaking: 0, 'may-break': 0, 'non-breaking': 0 } }, meta), /no changes\n\nThe operations, parameters, bodies and responses are the same\./);
});

test('sources: git:<ref>:<path>, git:<ref> taking the other one\'s path, and the arguments', () => {
  assert.deepEqual(gitSource('git:main:api/openapi.yaml'), { ref: 'main', path: 'api/openapi.yaml' });
  assert.deepEqual(gitSource('git:HEAD~1'), { ref: 'HEAD~1', path: '' });
  assert.equal(gitSource('openapi.yaml'), null);
  assert.deepEqual(diffSources('git:main', 'openapi.yaml'), { old: 'git:main:openapi.yaml', new: 'openapi.yaml' });
  assert.deepEqual(diffSources('git:v1:openapi.yaml', undefined), { old: 'git:v1:openapi.yaml', new: 'openapi.yaml' });
  assert.deepEqual(diffSources('git:HEAD', undefined, '/p/openapi.yaml'), { old: 'git:HEAD:/p/openapi.yaml', new: '/p/openapi.yaml' });
  assert.match(diffSources('git:main', 'https://x.example.com/o.json').problem, /names no file/);
  assert.match(diffSources('a.yaml', undefined).problem, /Name two/);
  assert.deepEqual(diffArgs(['a', 'b', '--fail-on', 'may-break', '--json']), { old: 'a', new: 'b', failOn: 'may-break', format: 'json', help: false });
  assert.match(diffArgs(['a', '--fail-on', 'high']).problem, /breaking, may-break or none/);
  assert.match(diffArgs(['a', '--json', '--markdown']).problem, /not both/);
  assert.match(diffArgs(['a', 'b', 'c']).problem, /Two descriptions at most/);
});

test('hail openapi-diff: exit codes 0, 1 and 2, --json, --markdown, and git:<ref>:<path>', async () => {
  const go = async (...args) => {
    const out = [];
    const err = [];
    const code = await runOpenapiDiff(args, { print: (l) => out.push(l), printError: (l) => err.push(l), cwd: FIXTURES });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  let r = await go('shop-v1.yaml', 'shop-v2.yaml');
  assert.equal(r.code, 1);
  assert.match(r.out, /9 breaking · 3 may break · 5 non-breaking/);
  assert.equal((await go('shop-v1.yaml', 'shop-v2.yaml', '--fail-on', 'none')).code, 0);
  assert.equal((await go('shop-v1.yaml', 'shop-v1.yaml')).code, 0);
  r = await go('shop-v1.yaml', 'shop-v2.yaml', '--json', '--fail-on=may-break');
  const json = JSON.parse(r.out);
  assert.equal(json.failOn, 'may-break');
  assert.equal(json.failing, 12);
  assert.equal(json.old.kind, 'OpenAPI 3.0.3');
  assert.deepEqual(Object.keys(json.changes[0]).sort(), ['level', 'operation', 'rule', 'text', 'where']);
  r = await go('pets-v1.json', 'pets-v2.json', '--markdown');
  assert.match(r.out, /^## API changes/);
  // Couldn't run: no such file, not a description, a bad option.
  r = await go('nope.yaml', 'shop-v2.yaml');
  assert.equal(r.code, 2);
  assert.match(r.err, /nope\.yaml: Couldn't read nope\.yaml: there's no such file/);
  writeFileSync(join(repo, 'not.json'), '{"hello": 1}');
  assert.equal(await runOpenapiDiff([join(repo, 'not.json'), join(FIXTURES, 'shop-v1.yaml')], { print() {}, printError() {} }), 2);
  assert.equal((await go('a', '--bogus')).code, 2);
  // From git: the file as it was at v1 against how it is now, and a ref that isn't there.
  const out = [];
  let code = await runOpenapiDiff(['git:v1:openapi.yaml'], { print: (l) => out.push(l), printError: (l) => out.push(l), cwd: repo });
  assert.equal(code, 1, out.join('\n'));
  assert.match(out.join('\n'), /^git:v1:openapi\.yaml \(Shop 1\.0\.0, OpenAPI 3\.0\.3\)\n→ openapi\.yaml \(Shop 2\.0\.0/);
  const err = [];
  code = await runOpenapiDiff(['git:nothere:openapi.yaml', 'openapi.yaml'], { print() {}, printError: (l) => err.push(l), cwd: repo });
  assert.equal(code, 2);
  assert.match(err.join('\n'), /Couldn't read openapi\.yaml at nothere/);
});

test('through the UI: /openapi-diff compares the contract with git, in the viewer, and m copies Markdown', async () => {
  const copied = [];
  const config = { history: [], contracts: { [join(repo, 'api.http')]: join(repo, 'openapi.yaml') } };
  const app = start({ initialFile: join(repo, 'api.http'), config, copy: (text) => copied.push(text) });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Orders'), 'the request');
    app.stdin.write('/');
    await type(app.stdin, 'openapi-diff git:v1');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('API changes: 9 breaking'), 'the viewer');
    // A long temp folder (Windows') cuts the line after "OpenAPI 3.".
    assert.match(f(), /git:v1:.*openapi\.yaml \(Shop 1\.0\.0, OpenAPI 3\./);
    assert.match(f(), /DELETE \/orders\/\{id\}/);
    assert.match(f(), /m copy as Markdown/);
    app.stdin.write('m');
    await until(() => copied.length === 1, 'the Markdown copied');
    assert.match(copied[0], /^## API changes: `git:v1:.*openapi\.yaml` → `openapi\.yaml`/);
    app.stdin.write(KEYS.esc);
    // Alone: HEAD's (v1 too) against the file now.
    app.stdin.write('/');
    await type(app.stdin, 'openapi-diff');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('API changes: 9 breaking'), 'HEAD against the file');
  } finally {
    app.unmount();
  }
});

test('schemas shared by many operations, each referring to several of the next layer, are compared once and said for each', () => {
  // Seven layers of 20 schemas, each pointing at three of the next; 400 operations over the first layer.
  const doc = (changed) => {
    const schemas = {};
    for (let i = 0; i < 140; i++) {
      const layer = Math.floor(i / 20);
      const properties = { id: { type: 'string', maxLength: changed && i === 139 ? 10 : 20 }, count: { type: 'integer' } };
      if (changed && i % 5 === 2) delete properties.count;
      if (layer < 6) {
        const next = (k) => ({ $ref: `#/components/schemas/S${(layer + 1) * 20 + ((i * 3 + k) % 20)}` });
        Object.assign(properties, { a: next(0), b: next(1), list: { type: 'array', items: next(2) } });
      }
      schemas[`S${i}`] = { type: 'object', properties };
    }
    const paths = Object.fromEntries(Array.from({ length: 400 }, (_, p) => [`/r${p}`, { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/S${p % 20}` } } } } } } }]));
    return { openapi: '3.0.3', paths, components: { schemas } };
  };
  const started = performance.now();
  const r = diffSpecs(doc(false), doc(true));
  // Compared again for every operation, it took 2.5 s.
  assert.ok(performance.now() - started < 1500);
  assert.equal(r.changes.length, 102020);
  // Two operations over the same schema say the same, each under its own name.
  const of = (op) => r.changes.filter((c) => c.operation === op).map((c) => [c.level, c.rule, c.where, c.text]);
  assert.equal(of('GET /r0').length, 255);
  assert.deepEqual(of('GET /r20'), of('GET /r0'));
  assert.deepEqual(of('GET /r1')[0], ['breaking', 'response-property-removed', 'response 200 $.a.a.a.count', 'removed']);
});

test('a big enum shared by many operations is compared value by value, not each value against every other', () => {
  const values = Array.from({ length: 20000 }, (_, i) => `v${i}`);
  const doc = (list) => ({
    openapi: '3.0.3',
    paths: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`/r${i}`, { get: { parameters: [{ $ref: '#/components/parameters/kind' }], responses: { 200: { description: 'ok' } } } }])),
    components: { parameters: { kind: { name: 'kind', in: 'query', schema: { type: 'string', enum: list } } } },
  });
  const started = performance.now();
  const r = diffSpecs(doc(values), doc([...values.slice(1), 'w']));
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual([r.counts.breaking, r.counts['non-breaking']], [50, 50]);
  assert.equal(r.changes[0].text, 'enum value "v0" removed');
});
