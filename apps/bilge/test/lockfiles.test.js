// Reading lock files and projects: npm's (3 and 1), NuGet's, a .csproj with central versions, and finding them in a folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exactVersion, findManifests, keyOf, mergePackages, parseCentralVersions, parseNpmLock, parseNugetLock, parseProject, scanFolder } from '../src/lockfiles.js';

const NPM3 = JSON.stringify(
  {
    name: 'shop',
    lockfileVersion: 3,
    packages: {
      '': { name: 'shop', workspaces: ['web'], dependencies: { express: '^4.17.0' }, devDependencies: { typescript: '^5.0.0' } },
      web: { name: 'web', dependencies: { react: '^18.0.0' } },
      'node_modules/express': { version: '4.17.1', license: 'MIT' },
      'node_modules/typescript': { version: '5.4.5', dev: true, license: 'Apache-2.0' },
      'node_modules/react': { version: '18.2.0', license: 'MIT' },
      'node_modules/web': { resolved: 'web', link: true },
      'node_modules/debug': { version: '2.6.9', license: 'MIT' },
      'node_modules/express/node_modules/debug': { version: '2.6.9' },
      'node_modules/send/node_modules/debug': { version: '4.3.4', devOptional: true },
      'node_modules/str': { name: 'string-width', version: '4.2.3' },
      'node_modules/from-git': { version: 'git+https://example.com/x.git' },
    },
  },
  null,
  2,
);

test("npm's lock file 3: every installed package once, direct ones the root's and the workspaces', with their line", () => {
  const list = parseNpmLock(NPM3);
  const by = Object.fromEntries(list.map((p) => [`${p.name}@${p.version}`, p]));
  assert.deepEqual(Object.keys(by).sort(), ['debug@2.6.9', 'debug@4.3.4', 'express@4.17.1', 'react@18.2.0', 'string-width@4.2.3', 'typescript@5.4.5']);
  assert.equal(by['express@4.17.1'].direct, true);
  assert.equal(by['react@18.2.0'].direct, true, "a workspace's dependency is the project's own");
  assert.equal(by['debug@2.6.9'].direct, false);
  assert.equal(by['typescript@5.4.5'].dev, true);
  assert.equal(by['debug@4.3.4'].dev, true);
  assert.equal(by['express@4.17.1'].license, 'MIT');
  assert.equal(by['express@4.17.1'].line, NPM3.split('\n').findIndex((l) => l.includes('"node_modules/express"')) + 1);
});

test("npm's lock file 1: nested dependencies, the top level direct", () => {
  const list = parseNpmLock(JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: '4.17.20' }, mocha: { version: '10.0.0', dev: true, dependencies: { minimist: { version: '1.2.5', dev: true } } } } }));
  assert.deepEqual(list.map((p) => [p.name, p.version, p.direct, p.dev]), [['lodash', '4.17.20', true, false], ['mocha', '10.0.0', true, true], ['minimist', '1.2.5', false, true]]);
});

test("NuGet's lock file: each framework's packages once, a project reference left out", () => {
  const lock = { version: 1, dependencies: { 'net8.0': { 'Newtonsoft.Json': { type: 'Direct', requested: '[12.0.1, )', resolved: '12.0.1' }, 'System.Memory': { type: 'Transitive', resolved: '4.5.5' }, Shared: { type: 'Project' } }, 'net6.0': { 'newtonsoft.json': { type: 'Transitive', resolved: '12.0.1' }, 'System.Memory': { type: 'CentralTransitive', resolved: '4.5.5' } } } };
  const list = parseNugetLock(`﻿${JSON.stringify(lock, null, 2)}`);
  assert.deepEqual(list.map((p) => [p.name, p.version, p.direct]), [['Newtonsoft.Json', '12.0.1', true], ['System.Memory', '4.5.5', false]]);
  assert.ok(list[0].line > 1);
});

test('a .csproj: its references with exact versions, central ones from Directory.Packages.props, inexact ones named', () => {
  const central = parseCentralVersions('<Project><ItemGroup><PackageVersion Include="Serilog" Version="3.1.1" /><PackageVersion Include="Polly" Version="8.*" /></ItemGroup></Project>');
  assert.deepEqual(central, { serilog: '3.1.1', polly: '8.*' });
  const { packages, inexact } = parseProject(
    `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="[12.0.1]" />
    <PackageReference Include="Dapper">
      <Version>2.1.35</Version>
    </PackageReference>
    <PackageReference Include="Serilog" />
    <PackageReference Include="Polly" />
    <PackageReference Include="xunit" Version="2.*" />
  </ItemGroup>
</Project>`,
    central,
  );
  assert.deepEqual(packages.map((p) => [p.name, p.version, p.line]), [['Newtonsoft.Json', '12.0.1', 3], ['Dapper', '2.1.35', 4], ['Serilog', '3.1.1', 7]]);
  assert.deepEqual(inexact, ['Polly', 'xunit']);
  assert.equal(exactVersion('1.2.3-beta.1'), '1.2.3-beta.1');
  assert.equal(exactVersion('[1.0,2.0)'), null);
});

test('a folder: its lock files and projects, node_modules, bin and obj left alone, a workspace package.json folded into its lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'bilge-scan-'));
  try {
    const put = (path, text) => {
      mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...path.split('/')), text);
    };
    put('package.json', '{}');
    put('package-lock.json', NPM3);
    put('web/package.json', '{}');
    put('node_modules/express/package-lock.json', NPM3);
    put('src/Api/Api.csproj', '<Project><ItemGroup><PackageReference Include="Serilog" /></ItemGroup></Project>');
    put('src/Directory.Packages.props', '<Project><ItemGroup><PackageVersion Include="Serilog" Version="3.1.1" /></ItemGroup></Project>');
    put('src/Api/bin/Debug/x.csproj', '<Project />');
    put('src/Worker/Worker.csproj', '<Project />');
    put('src/Worker/packages.lock.json', JSON.stringify({ version: 1, dependencies: { 'net8.0': { 'Newtonsoft.Json': { type: 'Direct', resolved: '13.0.3' } } } }));
    put('tools/old/package.json', '{}');
    assert.deepEqual(findManifests(root).map((f) => f.slice(root.length + 1).split(/[\\/]/).join('/')), ['package-lock.json', 'src/Api/Api.csproj', 'src/Worker/packages.lock.json', 'tools/old/package.json', 'web/package.json']);
    const scan = scanFolder(root);
    assert.deepEqual(scan.manifests.map((m) => [m.path, m.kind, m.packages.length]), [['package-lock.json', 'lock', 6], ['src/Api/Api.csproj', 'project', 1], ['src/Worker/packages.lock.json', 'lock', 1], ['tools/old/package.json', 'manifest', 0]]);
    assert.match(scan.manifests[1].note, /no packages\.lock\.json/);
    assert.match(scan.manifests[2].project, /Worker\.csproj$/);
    assert.equal(scan.packages.length, 8);
    assert.deepEqual(scan.packages.find((p) => p.name === 'Serilog').where, [{ path: 'src/Api/Api.csproj', line: 1 }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same package in two manifests is one, direct if either asks for it, found in both', () => {
  const a = { path: 'a/package-lock.json', packages: [{ ecosystem: 'npm', name: 'lodash', version: '4.17.20', direct: false, dev: true, line: 3 }] };
  const b = { path: 'b/package-lock.json', packages: [{ ecosystem: 'npm', name: 'lodash', version: '4.17.20', direct: true, dev: false, line: 9 }] };
  const [p] = mergePackages([a, b]);
  assert.equal(p.key, 'npm:lodash@4.17.20');
  assert.deepEqual([p.direct, p.dev, p.where], [true, false, [{ path: 'a/package-lock.json', line: 3 }, { path: 'b/package-lock.json', line: 9 }]]);
  assert.equal(keyOf({ ecosystem: 'NuGet', name: 'Newtonsoft.Json', version: '13.0.1' }), 'NuGet:newtonsoft.json@13.0.1');
});
