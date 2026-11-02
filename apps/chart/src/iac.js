// Everything Chart reads and runs goes through one object with one interface: `detect(dir)` (what the
// folder holds), `plan` and `state` (terraform or tofu, through their command lines), `whatIf` (az's
// what-if of a Bicep or ARM file), `init`, `readFile` (a saved plan) and `locate` (where a resource is
// declared); `deploy` is the one thing that changes anything, and only /deploy calls it, after asking. The command lines run through the kit's run.js, so whatever they're signed in to and set
// up for is what Chart uses; nothing may wait on a prompt (-input=false). Everything put in a command
// line is checked first by safeArg(). demo.js's demoChart() has the same interface.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run as runCommand } from '@fleet/kit/run.js';
import { parseAny, parseTerraformPlan, parseTerraformState, parseWhatIf } from './plan.js';

const SKIP = new Set(['.terraform', '.git', 'node_modules', 'bin', 'obj', 'dist']);
export const BINARIES = ['terraform', 'tofu'];

// A path, a resource group, a location: letters, digits and the punctuation paths have (~ too: Windows'
// short names, C:\Users\RUNNER~1, and between double quotes no shell expands it), no quotes, no
// shell's own characters.
const SAFE = /^[\w\\/:. ()@+~-]+$/;

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

/** The parameters az says a template needs and was given no value for ("Missing input parameters: a, b"), or []. */
export function missingParameters(error) {
  const m = /Missing input parameters: *(.+)/i.exec(String(error?.message ?? error));
  return m ? m[1].split(',').map((n) => n.trim()).filter((n) => /^[A-Za-z_][\w]*$/.test(n)) : [];
}

// A workspace's name as Terraform takes it.
const WORKSPACE = /^[\w-]+$/;

/** Throws unless `bin` is one Chart runs, and an environment's workspace and var file can go in a command line. */
function checkTool(bin, { workspace, varFile } = {}) {
  if (!BINARIES.includes(bin)) throw new Error(`Chart runs ${BINARIES.join(' or ')}, not ${bin}.`);
  if (workspace && !WORKSPACE.test(workspace)) throw new Error(`"${workspace}" isn't a workspace name Terraform takes.`);
  if (varFile && !safeArg(varFile)) throw new Error(`"${varFile}" has characters Chart won't put in a command line.`);
}

// An environment's workspace goes in TF_WORKSPACE rather than through `terraform workspace select`, so
// choosing one in Chart never changes which workspace the folder is on for a terraform run outside it.
const workspaceEnv = (workspace) => (workspace ? { TF_WORKSPACE: workspace } : undefined);

export const PRICES_URL = 'https://prices.azure.com/api/retail/prices';
// Enough pages for any one service in one region; a filter that matches more is too broad to be one price.
const MAX_PRICE_PAGES = 20;

/** The Retail Prices API's $filter for `query` (serviceName, armRegionName, armSkuName, skuName, productName): pay-as-you-go prices only. */
export function priceFilter(query) {
  const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const fields = ['serviceName', 'armRegionName', 'armSkuName', 'skuName', 'productName'].filter((k) => query[k] !== undefined && query[k] !== null);
  return [...fields.map((k) => `${k} eq ${quote(query[k])}`), "priceType eq 'Consumption'"].join(' and ');
}

export function createChart({ run = runCommand, fetch: fetchPrices = globalThis.fetch } = {}) {
  // Prices for the session: each query asked once (its promise kept, so two changes asking together ask once).
  const priceCache = new Map();
  /** Runs one az deployment command; typed-in `values` go in a temporary parameters file (never the command line, where a process list would show them), removed afterwards. */
  async function az(dir, command, { values, signal } = {}) {
    const names = Object.keys(values ?? {});
    const file = names.length ? join(tmpdir(), `chart-${randomUUID()}.json`) : null;
    if (file && !safeArg(file)) throw new Error(`The temporary folder ${tmpdir()} has characters Chart won't put in a command line.`);
    try {
      if (file) {
        const parameters = Object.fromEntries(names.map((n) => [n, { value: values[n] }]));
        writeFileSync(file, JSON.stringify({ $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#', contentVersion: '1.0.0.0', parameters }), { mode: 0o600 });
      }
      return await run(`${command}${file ? ` --parameters "@${file}"` : ''}`, { cwd: dir, signal }).catch((e) => {
        const err = explain(e, 'az');
        const missing = missingParameters(err);
        if (missing.length) err.missing = missing;
        return Promise.reject(err);
      });
    } finally {
      if (file) rmSync(file, { force: true });
    }
  }
  return {
    name: 'cli',
    async detect(dir) {
      return detectFolder(dir);
    },
    /** A plan (or a refresh-only one: what drifted), as plan.js's; `workspace` and `varFile` are the environment's. */
    async plan(dir, { bin = 'terraform', refreshOnly = false, workspace, varFile, signal } = {}) {
      checkTool(bin, { workspace, varFile });
      const out = join(tmpdir(), `chart-${randomUUID()}.tfplan`);
      if (!safeArg(out)) throw new Error(`The temporary folder ${tmpdir()} has characters Chart won't put in a command line.`);
      const env = workspaceEnv(workspace);
      try {
        await run(`${bin} plan -input=false -lock=false -no-color${refreshOnly ? ' -refresh-only' : ''}${varFile ? ` -var-file="${varFile}"` : ''} -out="${out}"`, { cwd: dir, signal, env }).catch((e) => Promise.reject(explain(e, bin)));
        const { stdout } = await run(`${bin} show -json "${out}"`, { cwd: dir, signal, env }).catch((e) => Promise.reject(explain(e, bin)));
        return parseTerraformPlan(stdout);
      } finally {
        rmSync(out, { force: true });
      }
    },
    async state(dir, { bin = 'terraform', workspace, signal } = {}) {
      checkTool(bin, { workspace });
      const { stdout } = await run(`${bin} show -json -no-color`, { cwd: dir, signal, env: workspaceEnv(workspace) }).catch((e) => Promise.reject(explain(e, bin)));
      // An empty state says so in words, not JSON.
      if (!stdout.trim().startsWith('{')) return { tool: 'terraform', version: null, resources: [] };
      return parseTerraformState(stdout);
    },
    async init(dir, { bin = 'terraform', signal } = {}) {
      return run(`${bin} init -input=false -no-color`, { cwd: dir, signal }).catch((e) => Promise.reject(explain(e, bin)));
    },
    /** az's what-if for a Bicep or ARM `file` (relative to `dir`): into resource group `resourceGroup`, or at the subscription in `location`. */
    async whatIf(dir, { file, resourceGroup, location, params, values, signal } = {}) {
      for (const v of [file, resourceGroup, location, params].filter(Boolean)) if (!safeArg(v)) throw new Error(`"${v}" has characters Chart won't put in a command line.`);
      if (!resourceGroup && !location) throw new Error('A what-if needs a resource group (--rg) or, at the subscription, a location (--location).');
      const scope = resourceGroup ? `group what-if --resource-group "${resourceGroup}"` : `sub what-if --location "${location}"`;
      const command = `az deployment ${scope} --template-file "${file}"${params ? ` --parameters "${params}"` : ''} --no-pretty-print --output json`;
      const { stdout } = await az(dir, command, { values, signal });
      return parseWhatIf(stdout);
    },
    /** az's deployment of a Bicep or ARM `file`: the same scope and arguments as `whatIf`, for real. Only /deploy calls it, after asking. */
    async deploy(dir, { file, resourceGroup, location, params, values, signal } = {}) {
      for (const v of [file, resourceGroup, location, params].filter(Boolean)) if (!safeArg(v)) throw new Error(`"${v}" has characters Chart won't put in a command line.`);
      if (!file) throw new Error('A deployment needs a Bicep or ARM file.');
      if (!resourceGroup && !location) throw new Error('A deployment needs a resource group (--rg) or, at the subscription, a location (--location).');
      const scope = resourceGroup ? `group create --resource-group "${resourceGroup}"` : `sub create --location "${location}"`;
      const command = `az deployment ${scope} --template-file "${file}"${params ? ` --parameters "${params}"` : ''} --output json`;
      const { stdout } = await az(dir, command, { values, signal });
      let json = {};
      try {
        json = JSON.parse(stdout);
      } catch {
        // az printed something else: the deployment still went through.
      }
      // Outputs can hold secrets, so only their names are kept.
      return { name: json.name ?? null, state: json.properties?.provisioningState ?? 'Succeeded', outputs: Object.keys(json.properties?.outputs ?? {}) };
    },
    /** The Azure Retail Prices API's items for `query` (priceFilter's) in `currency`, every page of them; kept for the session. */
    async prices(query, { currency = 'USD', signal } = {}) {
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${currency} isn't a currency code (USD, EUR, GBP…).`);
      const key = JSON.stringify([currency, priceFilter(query)]);
      if (!priceCache.has(key)) {
        const ask = (async () => {
          const items = [];
          let url = `${PRICES_URL}?currencyCode='${currency}'&$filter=${encodeURIComponent(priceFilter(query))}`;
          for (let page = 0; url && page < MAX_PRICE_PAGES; page++) {
            const res = await fetchPrices(url, { signal, headers: { accept: 'application/json' } }).catch((e) => {
              throw new Error(`Couldn't reach prices.azure.com: ${e.cause?.code ?? e.message}`);
            });
            if (!res.ok) throw new Error(`The Azure price list answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
            const body = await res.json();
            items.push(...(body.Items ?? []));
            url = body.NextPageLink || null;
          }
          return items;
        })();
        // A failure isn't kept: the next plan asks again.
        priceCache.set(key, ask.catch((e) => {
          priceCache.delete(key);
          throw e;
        }));
      }
      return priceCache.get(key);
    },
    async readFile(path) {
      return parseAny(readFileSync(path, 'utf8'));
    },
    async locate(dir, change) {
      return change.type && change.name && !change.type.includes('/') ? locateResource(dir, change.type, change.name) : null;
    },
  };
}
