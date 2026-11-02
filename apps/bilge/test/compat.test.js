// Whether an update fits: npm's ranges, .NET's frameworks, and what stands in the way of a version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowestIn, satisfies } from '../src/versions.js';
import { nuspecFrameworks, parseFramework, projectFrameworks, runsOn, unsupported } from '../src/frameworks.js';
import { problems, updateProblems } from '../src/compat.js';

test("npm's ranges: carets, tildes, x-ranges, hyphens, comparators and alternatives", () => {
  const cases = [
    ['18.3.1', '^18.0', true],
    ['19.1.0', '^16.8 || ^17.0 || ^18.0', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2', true],
    ['1.3.0', '~1.2.0', false],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1', false],
    ['2.3.9', '1.2 - 2.3', true],
    ['2.4.0', '1.2 - 2.3', false],
    ['16.0.0', '>=18', false],
    ['14.17.0', '>= 14.17', true],
    ['20.19.1', '^20.19.0 || ^22.13.0 || >=24', true],
    ['21.0.0', '^20.19.0 || ^22.13.0 || >=24', false],
    ['5.0.0', '*', true],
    ['5.0.0', '', true],
  ];
  for (const [v, range, want] of cases) assert.equal(satisfies(v, range), want, `${v} in ${range}`);
  assert.equal(satisfies('1.0.0', 'latest'), null);
  assert.equal(lowestIn('>=16'), '16.0.0');
  assert.equal(lowestIn('^20.19.0 || >=24'), '20.19.0');
  assert.equal(lowestIn('>16'), '17.0.0');
  assert.equal(lowestIn('*'), '0.0.0');
});

test(".NET's frameworks: short and long names, what runs where, a project's and a .nuspec's", () => {
  assert.equal(parseFramework('.NETFramework,Version=v4.8').name, 'net48');
  assert.equal(parseFramework('.NETCoreApp,Version=v8.0').name, 'net8.0');
  assert.equal(parseFramework('.NETStandard2.0').name, 'netstandard2.0');
  assert.equal(parseFramework('net8.0-windows7.0').name, 'net8.0-windows');
  assert.equal(parseFramework('net8.0/win-x64').name, 'net8.0');
  assert.equal(parseFramework('netcoreapp3.1').name, 'netcoreapp3.1');
  assert.equal(parseFramework('MonoAndroid10'), null);
  const f = parseFramework;
  assert.equal(runsOn(f('net6.0'), f('net8.0')), true);
  assert.equal(runsOn(f('net8.0'), f('net6.0')), false);
  assert.equal(runsOn(f('netstandard2.0'), f('net472')), true);
  assert.equal(runsOn(f('netstandard2.1'), f('net48')), false);
  assert.equal(runsOn(f('netstandard2.1'), f('netcoreapp3.1')), true);
  assert.equal(runsOn(f('net8.0-windows'), f('net8.0')), false);
  assert.equal(runsOn(f('net8.0'), f('net8.0-windows')), true);
  assert.equal(runsOn(f('net48'), f('net8.0')), false);
  assert.deepEqual(unsupported(['net462', 'net8.0', 'net9.0'], ['net6.0', 'net8.0']), ['net6.0']);
  assert.deepEqual(unsupported(['net462', 'netstandard2.0'], ['net6.0']), []);
  // A group for every framework, or one Bilge doesn't know, says nothing against it.
  assert.deepEqual(unsupported(['', 'net8.0'], ['net6.0']), []);
  assert.deepEqual(unsupported(['MonoAndroid10', 'net8.0'], ['net6.0']), []);
  assert.deepEqual(projectFrameworks('<TargetFramework> net8.0 </TargetFramework>'), ['net8.0']);
  assert.deepEqual(projectFrameworks('<TargetFrameworks>net8.0;net48;</TargetFrameworks>'), ['net8.0', 'net48']);
  assert.deepEqual(nuspecFrameworks('<dependencies><group targetFramework=".NETFramework4.6.2"><dependency id="x" /></group><group targetFramework="net8.0" /></dependencies><frameworkReferences><frameworkReferenceGroup targetFramework="net9.0" /></frameworkReferences>'), ['net462', 'net8.0', 'net9.0']);
  assert.equal(nuspecFrameworks('<dependencies />'), null);
});

const pkg = (ecosystem, name, version, path, extra = {}) => ({ ecosystem, name, version, key: `${ecosystem}:${name}@${version}`, where: [{ path }], ...extra });

test("what stands in the way of a version: its frameworks, its Node, its peers, and the packages whose peers won't take it", () => {
  const web = 'web/package-lock.json';
  const api = 'src/Api/packages.lock.json';
  const react = pkg('npm', 'react', '18.2.0', web, { direct: true });
  const redux = pkg('npm', 'react-redux', '8.1.3', web, { peers: { react: '^16.8 || ^17.0 || ^18.0' } });
  const express = pkg('npm', 'express', '4.17.1', web);
  const sql = pkg('NuGet', 'Microsoft.Data.SqlClient', '5.1.1', api);
  const data = {
    manifests: [
      { path: web, ecosystem: 'npm', node: { range: '>=16', from: 'engines.node in package.json' } },
      { path: api, ecosystem: 'NuGet', frameworks: ['net6.0'] },
    ],
    packages: [react, redux, express, sql],
  };
  assert.deepEqual(problems(express, '5.1.0', { node: '>= 18' }, data), ['5.1.0 needs Node >= 18; the project says >=16 (engines.node in package.json)']);
  assert.deepEqual(problems(express, '4.21.2', { node: '>= 0.10.0' }, data), []);
  assert.deepEqual(problems(react, '19.1.0', {}, data), ['react-redux 8.1.3 wants react ^16.8 || ^17.0 || ^18.0']);
  assert.deepEqual(problems(react, '18.3.1', {}, data), []);
  assert.deepEqual(problems(redux, '9.0.0', { peers: { react: '^19' } }, data), ['9.0.0 wants react ^19; 18.2.0 is installed']);
  assert.deepEqual(problems(sql, '6.1.1', { frameworks: ['net462', 'net8.0', 'net9.0'] }, data), ['6.1.1 is built for net462, net8.0, net9.0, not net6.0 (src/Api)']);
  assert.deepEqual(problems(sql, '5.2.3', { frameworks: ['net462', 'net6.0', 'netstandard2.0'] }, data), []);
  // What isn't known isn't held against it: no needs, or a project that says no Node.
  assert.deepEqual(problems(sql, '6.1.1', null, data), []);
  assert.deepEqual(problems(express, '5.1.0', { node: '>= 18' }, { ...data, manifests: [{ path: web, ecosystem: 'npm' }] }), []);
  // .nvmrc's 20 is any 20.x, so a version that needs 20.11 fits it.
  const nvm = { ...data, manifests: [{ path: web, ecosystem: 'npm', node: { version: '20', from: '.nvmrc' } }] };
  assert.deepEqual(problems(express, '9.0.0', { node: '>=20.11' }, nvm), []);
  assert.equal(problems(express, '9.0.0', { node: '>=22' }, nvm).length, 1);
  const latest = new Map([[react.key, { latest: '19.1.0' }], [express.key, { latest: '5.1.0', needs: { node: '>= 18' } }], [redux.key, { latest: '8.1.3' }]]);
  assert.deepEqual([...updateProblems({ ...data, latest }).keys()], [react.key, express.key]);
});
