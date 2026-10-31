// What fixes a finding: the command that moves a package to the version that fixes it, run where its
// manifest is, or (where no command does it safely) what to change by hand. Pure. Everything that goes
// into a command line is checked first: a package's name and version as the registry would have them,
// a project file's name as a plain one, never more.
import { basename } from 'node:path';

const NPM_NAME = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;
const NUGET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]*$/;
const FILE = /^[\w][\w .-]*$/;

/** Whether `name` and `version` are what the registry of `ecosystem` would have given. */
export function safe(ecosystem, name, version) {
  return (ecosystem === 'npm' ? NPM_NAME : NUGET_NAME).test(String(name)) && VERSION.test(String(version));
}

/**
 * How to fix `finding` (audit.js's) in `manifest` (lockfiles.js's, one it was found in), to `version`
 * (the finding's fix by default): { run: { command, cwd }, text } when a command does it, else { text }
 * saying what to change, or null when nothing fixes it yet.
 */
export function fixPlan(finding, manifest, version = finding.fixed) {
  const { pkg } = finding;
  if (!version) return null;
  if (!safe(pkg.ecosystem, pkg.name, version)) return { text: `${pkg.name} ${version} isn't a name and version Bilge will put in a command.` };
  if (pkg.ecosystem === 'npm') {
    if (manifest.kind !== 'lock') return { text: `${manifest.path} has no lock file: npm install makes one, then /audit again.` };
    if (pkg.direct) {
      const command = `npm install ${pkg.name}@^${version}${pkg.dev ? ' --save-dev' : ''}`;
      return { run: { command, cwd: manifest.dir }, text: `${command}  (in ${manifest.path.replace(/\/?[^/]+$/, '') || '.'})` };
    }
    // Something else brings it in: npm update moves it within the ranges asked for, and an override
    // where they don't reach.
    return {
      run: { command: `npm update ${pkg.name}`, cwd: manifest.dir },
      text: `npm update ${pkg.name} moves it within what its parents ask for. If ${version} is outside that, add to package.json:\n  "overrides": { "${pkg.name}": "^${version}" }\nthen npm install.`,
    };
  }
  const project = manifest.project ? basename(manifest.project) : null;
  if (!project) return { text: `No project file beside ${manifest.path}: dotnet add <project> package ${pkg.name} --version ${version}` };
  if (!FILE.test(project)) return { text: `dotnet add "${project}" package ${pkg.name} --version ${version}` };
  const command = `dotnet add "${project}" package ${pkg.name} --version ${version}`;
  // A transitive package is pinned by referencing it directly, which NuGet's own advice is too.
  return { run: { command, cwd: manifest.dir }, text: `${command}${pkg.direct ? '' : '  (a direct reference pins what another package brings in)'}` };
}
