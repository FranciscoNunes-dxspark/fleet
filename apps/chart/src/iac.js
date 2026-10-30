// Everything Chart reads and runs goes through one object with one interface: `detect(dir)` (what the
// folder holds), `plan` and `state` (terraform or tofu, through their command lines), `whatIf` (az's
// what-if of a Bicep or ARM file), `init`, `readFile` (a saved plan) and `locate` (where a resource is
// declared). The command lines run through the kit's run.js, so whatever they're signed in to and set
// up for is what Chart uses; nothing may wait on a prompt (-input=false). Everything put in a command
// line is checked first by safeArg(). demo.js's demoChart() has the same interface.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run as runCommand } from '@fleet/kit/run.js';
import { parseAny, parseTerraformPlan, parseTerraformState, parseWhatIf } from './plan.js';

const SKIP = new Set(['.terraform', '.git', 'node_modules', 'bin', 'obj', 'dist']);
export const BINARIES = ['terraform', 'tofu'];

// A path, a resource group, a location: letters, digits and the punctuation paths have, no quotes, no
// shell's own characters.
const SAFE = /^[\w\\/:. ()@+-]+$/;

/** Whether `value` can go into a command line between double quotes. */
export const safeArg = (value) => SAFE.test(String(value ?? '')) && !/\$|`|"/.test(String(value));

const rel = (root, file) => relative(root, file).split(sep).join('/') || basename(file);

/** What `dir` holds, three folders deep: Terraform's folders (.tf), Bicep and ARM files, parameter files, saved plans. */
export function detectFolder(dir, depth = 3) {
  const out = { dir, tfDirs: [], bicep: [], params: [], saved: [] };
  const walk = (d, level) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (files.some((f) => f.endsWith('.tf'))) out.tfDirs.push(d === dir ? '.' : rel(dir, d));
    for (const f of files) {
      const p = rel(dir, join(d, f));
      if (/\.bicep$/i.test(f) || /^(azuredeploy|main|template)\.json$/i.test(f)) out.bicep.push(p);
      else if (/\.bicepparam$|\.parameters\.json$/i.test(f)) out.params.push(p);
      else if (/(plan|what-?if).*\.json$/i.test(f)) out.saved.push(p);
    }
    if (level >= depth) return;
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), level + 1);
  };
  walk(dir, 0);
  return out;
}

/** The first `resource "type" "name"` block in the .tf files under `dir`: { path, line }, or null. */
export function locateResource(dir, type, name, depth = 4) {
  const re = new RegExp(`^\\s*resource\\s+"${type.replace(/[^\w-]/g, '')}"\\s+"${name.replace(/[^\w-]/g, '')}"`, 'm');
  let found = null;
  const walk = (d, level) => {
    if (found) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.filter((x) => x.isFile() && x.name.endsWith('.tf')).sort((a, b) => a.name.localeCompare(b.name))) {
      const text = readFileSync(join(d, e.name), 'utf8');
      const m = re.exec(text);
      if (m) {
        found = { path: rel(dir, join(d, e.name)), line: text.slice(0, m.index + m[0].length - m[0].trimStart().length).split('\n').length };
        return;
      }
    }
    if (level >= depth) return;
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), level + 1);
  };
  walk(dir, 0);
  return found;
}

/** What a failed command says, with a missing program said plainly. */
export function explain(error, program) {
  const text = String(error.message ?? error);
  if (/not found|not recognized|ENOENT/i.test(text) && text.length < 300) return new Error(`${program} isn't installed (or isn't on the PATH).`);
  if (/Please run "az login"|az login/i.test(text)) return new Error(`az isn't signed in: run az login.\n${text.split('\n')[0]}`);
  if (/terraform init|tofu init|Plugin reinitialization required|Module not installed|Backend initialization required/i.test(text)) return new Error(`The folder needs init first: /init runs it.\n${text.split('\n').find((l) => /Error/.test(l)) ?? text.split('\n')[0]}`);
  return error;
}

export function createChart({ run = runCommand } = {}) {
  return {
    name: 'cli',
    async detect(dir) {
      return detectFolder(dir);
    },
    /** A plan (or a refresh-only one: what drifted), as plan.js's. */
    async plan(dir, { bin = 'terraform', refreshOnly = false, signal } = {}) {
      if (!BINARIES.includes(bin)) throw new Error(`Chart runs ${BINARIES.join(' or ')}, not ${bin}.`);
      const out = join(tmpdir(), `chart-${randomUUID()}.tfplan`);
      if (!safeArg(out)) throw new Error(`The temporary folder ${tmpdir()} has characters Chart won't put in a command line.`);
      try {
        await run(`${bin} plan -input=false -lock=false -no-color${refreshOnly ? ' -refresh-only' : ''} -out="${out}"`, { cwd: dir, signal }).catch((e) => Promise.reject(explain(e, bin)));
        const { stdout } = await run(`${bin} show -json "${out}"`, { cwd: dir, signal }).catch((e) => Promise.reject(explain(e, bin)));
        return parseTerraformPlan(stdout);
      } finally {
        rmSync(out, { force: true });
      }
    },
    async state(dir, { bin = 'terraform', signal } = {}) {
      if (!BINARIES.includes(bin)) throw new Error(`Chart runs ${BINARIES.join(' or ')}, not ${bin}.`);
      const { stdout } = await run(`${bin} show -json -no-color`, { cwd: dir, signal }).catch((e) => Promise.reject(explain(e, bin)));
      // An empty state says so in words, not JSON.
      if (!stdout.trim().startsWith('{')) return { tool: 'terraform', version: null, resources: [] };
      return parseTerraformState(stdout);
    },
    async init(dir, { bin = 'terraform', signal } = {}) {
      return run(`${bin} init -input=false -no-color`, { cwd: dir, signal }).catch((e) => Promise.reject(explain(e, bin)));
    },
    /** az's what-if for a Bicep or ARM `file` (relative to `dir`): into resource group `resourceGroup`, or at the subscription in `location`. */
    async whatIf(dir, { file, resourceGroup, location, params, signal } = {}) {
      for (const v of [file, resourceGroup, location, params].filter(Boolean)) if (!safeArg(v)) throw new Error(`"${v}" has characters Chart won't put in a command line.`);
      if (!resourceGroup && !location) throw new Error('A what-if needs a resource group (--rg) or, at the subscription, a location (--location).');
      const scope = resourceGroup ? `group what-if --resource-group "${resourceGroup}"` : `sub what-if --location "${location}"`;
      const command = `az deployment ${scope} --template-file "${file}"${params ? ` --parameters "${params}"` : ''} --no-pretty-print --output json`;
      const { stdout } = await run(command, { cwd: dir, signal }).catch((e) => Promise.reject(explain(e, 'az')));
      return parseWhatIf(stdout);
    },
    async readFile(path) {
      return parseAny(readFileSync(path, 'utf8'));
    },
    async locate(dir, change) {
      return change.type && change.name && !change.type.includes('/') ? locateResource(dir, change.type, change.name) : null;
    },
  };
}
