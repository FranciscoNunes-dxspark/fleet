// What fixes a finding: the command that moves a package to the version that fixes it, run where its
// manifest is, or (where no command does it safely) what to change by hand. Pure. Everything that goes
// into a command line is checked first: a package's name and version as the registry would have them,
// a project file's name as a plain one, never more.
import { basename } from 'node:path';

const NPM_NAME = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;
const NUGET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]*$/;
const FILE = /^[\w][\w .-]*$/;

// What each of npm's, Yarn's and pnpm's commands is for the same job. Only safe() names and versions reach them.
const TOOLS = {
  npm: {
    name: 'npm',
    add: (name, spec, dev) => `npm install ${name}@${spec}${dev ? ' --save-dev' : ''}`,
    update: (name) => `npm update ${name}`,
    check: (name) => `npm ls ${name}`,
    override: (name, version) => `"overrides": { "${name}": "^${version}" }`,
  },
  yarn: {
    name: 'yarn',
    add: (name, spec, dev) => `yarn add ${name}@${spec}${dev ? ' --dev' : ''}`,
    // Yarn 2+ moves a package anywhere in the tree with up -R; Yarn 1 only what the project asks for.
    update: (name, manifest) => (manifest.berry ? `yarn up -R ${name}` : null),
    check: (name) => `yarn why ${name}`,
    override: (name, version) => `"resolutions": { "${name}": "^${version}" }`,
  },
  pnpm: {
    name: 'pnpm',
    add: (name, spec, dev) => `pnpm add ${name}@${spec}${dev ? ' --save-dev' : ''}`,
    update: (name) => `pnpm update ${name}`,
    check: (name) => `pnpm why ${name}`,
    override: (name, version) => `"pnpm": { "overrides": { "${name}": "^${version}" } }`,
  },
};

/** The tool a JavaScript manifest's lock file is for: npm, yarn or pnpm. */
export const toolOf = (manifest) => (TOOLS[manifest?.tool] ? manifest.tool : 'npm');

/** A manifest's folder as Bilge shows it ('.' for the top). */
const folderOf = (manifest) => manifest.path.replace(/\/?[^/]+$/, '') || '.';

/** Whether `name` and `version` are what the registry of `ecosystem` would have given. */
export function safe(ecosystem, name, version) {
  return (ecosystem === 'npm' ? NPM_NAME : NUGET_NAME).test(String(name)) && VERSION.test(String(version));
}

/**
 * How to fix `finding` (audit.js's) in `manifest` (lockfiles.js's, one it was found in), to `version`
 * (the finding's fix by default): { run: { command, cwd }, check: { command, cwd }, text } when a
 * command does it, else { text } saying what to change, or null when nothing fixes it yet. `check` is
 * what says, once it has run, whether the project still holds together: npm ls on the package (an
 * invalid peer or range fails it; yarn why and pnpm why for theirs), dotnet restore on the project (a framework the package isn't built
 * for, NU1202, fails it).
 */
export function fixPlan(finding, manifest, version = finding.fixed) {
  const { pkg } = finding;
  if (!version) return null;
  if (!safe(pkg.ecosystem, pkg.name, version)) return { text: `${pkg.name} ${version} isn't a name and version Bilge will put in a command.` };
  if (pkg.ecosystem === 'npm') {
    const tool = TOOLS[toolOf(manifest)];
    if (manifest.kind !== 'lock') return { text: `${manifest.path} has no lock file: npm install makes one, then /audit again.` };
    const check = { command: tool.check(pkg.name), cwd: manifest.dir };
    if (pkg.direct) {
      const command = tool.add(pkg.name, `^${version}`, pkg.dev);
      return { run: { command, cwd: manifest.dir }, check, text: `${command}  (in ${folderOf(manifest)})` };
    }
    // Something else brings it in: the tool's update moves it within the ranges asked for, and an
    // override where they don't reach. Yarn 1 has no command that moves a package it doesn't ask for.
    const update = tool.update(pkg.name, manifest);
    const pin = `add to package.json:\n  ${tool.override(pkg.name, version)}\nthen ${tool.name} install.`;
    if (!update) return { text: `Yarn 1 can't move a package something else brings in by itself. To move ${pkg.name} to ${version}, ${pin}` };
    return { run: { command: update, cwd: manifest.dir }, check, text: `${update} moves it within what its parents ask for. If ${version} is outside that, ${pin}` };
  }
  const project = manifest.project ? basename(manifest.project) : null;
  if (!project) return { text: `No project file beside ${manifest.path}: dotnet add <project> package ${pkg.name} --version ${version}` };
  if (!FILE.test(project)) return { text: `dotnet add "${project}" package ${pkg.name} --version ${version}` };
  const command = `dotnet add "${project}" package ${pkg.name} --version ${version}`;
  // A transitive package is pinned by referencing it directly, which NuGet's own advice is too.
  return { run: { command, cwd: manifest.dir }, check: { command: `dotnet restore "${project}"`, cwd: manifest.dir }, text: `${command}${pkg.direct ? '' : '  (a direct reference pins what another package brings in)'}` };
}
