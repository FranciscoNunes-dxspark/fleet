// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
// Chart reads and plans; what changes infrastructure is /apply (a plan Chart saved, or a what-if) and /deploy, only after the name of where it goes is typed.
import { basename, isAbsolute, join, resolve } from 'node:path';
import { run } from '@fleet/kit/run.js';
import { contextIn, copiedNote, notMine, splitArgs, takeLine } from '@fleet/kit/family.js';
import { resolveFolder, samePath } from '@fleet/kit/folders.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { diffLines, valueLines } from './diff.js';
import { summarize, summaryLine } from './plan.js';
import { ACTION_MARK, ACTION_WORD, SEVERITY_LABEL, changeRows, findChange, siteOf } from './rows.js';
import { markdownReport } from './share.js';
import { CURRENCIES, costLines, costWords, planCosts, totalWords } from './costs.js';
import { affectedBy, affectsLine, parseDot } from './graph.js';
import { BINARIES } from './iac.js';
import { folderFindings } from './security.js';
import { countFindings, findingPlace, findingsLine, withoutIgnoredFindings } from '@fleet/kit/findings.js';
import { describeEnvironments, markProduction, productionQuestion, setEnvironment } from '@fleet/kit/environments.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const bin = (ctx) => ctx.config.terraform ?? 'terraform';
const toolName = (b) => (b === 'tofu' ? 'OpenTofu' : 'Terraform');
// The project's chosen environment as Chart reads it ({ name, prod, workspace?, varFile?, resourceGroup?, parametersFile? }), or null.
const envOf = (ctx) => ctx.env?.() ?? null;
// What terraform runs with: the tool, and the environment's workspace and var file.
const tfOpts = (ctx) => {
  const e = envOf(ctx);
  return { bin: bin(ctx), ...(e?.workspace ? { workspace: e.workspace } : {}), ...(e?.varFile ? { varFile: e.varFile } : {}) };
};
// " (prod)" after a folder's name in what's said and logged, when an environment is chosen.
const inEnv = (ctx) => (envOf(ctx) ? ` (${envOf(ctx).name})` : '');

/** The plan on screen is being replaced: the file kept for applying it goes (nothing can apply it any more). */
function replacePlan(ctx) {
  const file = ctx.data?.plan?.planFile;
  if (file) ctx.provider.discard?.(file);
}

/** What the folder holds: its Terraform folders, Bicep files, parameter files and saved plans. */
export async function look(ctx) {
  const dir = ctx.cwd();
  const r = await ctx.task(
    `look in ${basename(dir) || dir}`,
    async () => {
      const found = await ctx.provider.detect(dir);
      ctx.setData((d) => ({ ...(d?.found?.dir === found.dir ? d : {}), found }));
      const parts = [found.tfDirs.length ? `${plural(found.tfDirs.length, 'Terraform folder')} (/plan)` : '', found.bicep.length ? `${plural(found.bicep.length, 'Bicep or ARM file')} (/whatif)` : '', found.saved.length ? `${plural(found.saved.length, 'saved plan')} (/open)` : ''].filter(Boolean);
      return { stdout: parts.length ? parts.join(', ') : 'No .tf, .bicep or saved plan here: /move to one, or /open a plan file.' };
    },
    { label: 'Looking' },
  );
  return r.ok;
}

/** A folder of the cwd's to run in: the one named, else the first with .tf files. */
function tfDir(ctx, name) {
  const dirs = ctx.data?.found?.tfDirs ?? [];
  const n = String(name ?? '').trim();
  if (n) return isAbsolute(n) ? n : join(ctx.cwd(), n);
  return join(ctx.cwd(), dirs[0] ?? '.');
}

const label = (ctx, dir) => (samePath(dir, ctx.cwd()) ? basename(dir) : `${basename(ctx.cwd())}/${dir.slice(ctx.cwd().length + 1).split(/[\\/]/).join('/')}`);

/** /plan [folder]: terraform (or tofu) plan, its changes and what drifted; the plan file kept for /apply. */
export async function plan(ctx, folder = '') {
  const dir = tfDir(ctx, folder);
  const b = bin(ctx);
  const opts = tfOpts(ctx);
  const env = envOf(ctx);
  const r = await ctx.task(
    `${b} plan ${label(ctx, dir)}${inEnv(ctx)}`,
    async (signal) => {
      // Kept as a plan file, the only thing /apply applies.
      const p = await ctx.provider.plan(dir, { ...opts, keep: true, signal });
      replacePlan(ctx);
      // The environment it was made for goes with it: a plan of dev's is never applied to prod.
      ctx.setData((d) => ({ ...d, plan: p, drift: p.drift, source: { kind: 'terraform', dir, label: label(ctx, dir), env: env?.name ?? null, workspace: opts.workspace ?? null, at: Date.now() } }));
      return { stdout: `${summaryLine(summarize(p.changes)) || 'No changes.'}${p.drift.length ? `; ${plural(p.drift.length, 'resource')} changed outside ${toolName(b)}` : ''}` };
    },
    { label: `Planning (${toolName(b)})` },
  );
  if (r.ok) {
    ctx.setView('changes');
    void price(ctx);
    ctx.logActivity(`Planned ${label(ctx, dir)}${inEnv(ctx)}: ${summaryLine(summarize(ctx.data.plan.changes)) || 'no changes'}`);
  }
  return r.ok;
}

/** /drift [folder]: a refresh-only plan: what changed outside Terraform since the last apply. */
export async function drift(ctx, folder = '') {
  const dir = tfDir(ctx, folder);
  const b = bin(ctx);
  const r = await ctx.task(
    `${b} plan -refresh-only ${label(ctx, dir)}${inEnv(ctx)}`,
    async (signal) => {
      const p = await ctx.provider.plan(dir, { ...tfOpts(ctx), refreshOnly: true, signal });
      ctx.setData((d) => ({ ...d, drift: p.drift, driftAt: Date.now() }));
      return { stdout: p.drift.length ? `${plural(p.drift.length, 'resource')} changed outside ${toolName(b)}` : `Nothing changed outside ${toolName(b)}.` };
    },
    { label: 'Looking for drift' },
  );
  if (r.ok) {
    ctx.setView('drift');
    const n = ctx.data.drift.length;
    if (n) ctx.logActivity(`Drift in ${label(ctx, dir)}: ${plural(n, 'resource')} changed outside ${toolName(b)}`);
  }
  return r.ok;
}

/** /state [folder]: every resource Terraform keeps track of. */
export async function state(ctx, folder = '') {
  const dir = tfDir(ctx, folder);
  const b = bin(ctx);
  const r = await ctx.task(
    `${b} show ${label(ctx, dir)}${inEnv(ctx)}`,
    async (signal) => {
      const { varFile, ...opts } = tfOpts(ctx);
      const s = await ctx.provider.state(dir, { ...opts, signal });
      ctx.setData((d) => ({ ...d, state: s }));
      return { stdout: s.resources.length ? plural(s.resources.length, 'resource') : 'The state is empty.' };
    },
    { label: 'Reading the state' },
  );
  if (r.ok) ctx.setView('state');
  return r.ok;
}

/** /init [folder]: terraform init, which a folder needs before its first plan (and after a provider or module changes). */
export async function init(ctx, folder = '') {
  const dir = tfDir(ctx, folder);
  const b = bin(ctx);
  const r = await ctx.task(`${b} init ${label(ctx, dir)}`, (signal) => ctx.provider.init(dir, { bin: b, signal }), { label: 'Initialising' });
  return r.ok;
}

/**
 * What /whatif's arguments say: { file, resourceGroup, location, params }, the environment's resource
 * group and parameters file (`env`) then the last ones used filling the gaps.
 */
export function whatIfArgs(rest, { last = {}, found, env } = {}) {
  const own = typedWhatIfArgs(rest);
  // What's typed wins; then the environment's, so switching it moves the target; then the last ones.
  const group = own.resourceGroup ?? (own.location ? undefined : env?.resourceGroup);
  const params = own.params ?? env?.parametersFile;
  return lastWhatIfArgs({ ...own, ...(group ? { resourceGroup: group } : {}), ...(params ? { params } : {}) }, { last, found });
}

function typedWhatIfArgs(rest) {
  const words = splitArgs(rest ?? '');
  const out = {};
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--rg' || w === '-g' || w === '--resource-group') out.resourceGroup = words[++i];
    else if (w === '--location' || w === '-l') out.location = words[++i];
    else if (w === '--params' || w === '-p' || w === '--parameters') out.params = words[++i];
    else if (!out.file) out.file = w;
  }
  return out;
}

function lastWhatIfArgs(out, { last, found }) {
  const file = out.file ?? last.file ?? found?.bicep?.[0];
  const sameFile = file === last.file;
  return {
    file,
    resourceGroup: out.resourceGroup ?? (out.location ? undefined : last.resourceGroup),
    location: out.location ?? (out.resourceGroup ? undefined : last.location),
    params: out.params ?? (sameFile ? last.params : undefined) ?? found?.params?.find((p) => p.startsWith(String(file ?? '').replace(/[^/]*$/, ''))),
  };
}

/** What a template's missing parameters are, asked one at a time (esc cancels): { name: value }. Typed in, kept only in memory for the one command, and masked unless the name doesn't look like a secret. */
async function askParameters(ctx, names) {
  const values = {};
  for (const [i, name] of names.entries()) {
    const a = await ctx.confirm({
      secret: true,
      plain: !/pass|secret|key|token|pwd|credential/i.test(name),
      title: `Parameter ${name} (${i + 1} of ${names.length})`,
      detail: 'The template needs a value and has no default. It is sent to Azure for this command and not saved.',
    });
    if (!a) return null;
    values[name] = a.value;
  }
  return values;
}

/** /whatif <file> --rg <group> | --location <region> [--params <file>]: what deploying a Bicep or ARM file would change, as Azure says. */
export async function whatIf(ctx, rest = '', typed = {}) {
  const env = envOf(ctx);
  const args = whatIfArgs(rest, { last: ctx.config.whatIf ?? {}, found: ctx.data?.found, env });
  if (!args.file) return ctx.note('/whatif needs a .bicep or ARM file: /whatif main.bicep --rg shop-prod', 'error') ?? false;
  if (!args.resourceGroup && !args.location) return ctx.note(`/whatif ${args.file} needs where to: --rg <resource group>, or --location <region> at the subscription.`, 'error') ?? false;
  // The last ones kept are what was typed (or kept before), not the environment's: switching to an
  // environment without a resource group mustn't fall back on another environment's.
  ctx.setConfig((c) => ({ ...c, whatIf: whatIfArgs(rest, { last: c.whatIf ?? {}, found: ctx.data?.found }) }));
  const where = args.resourceGroup ? `into ${args.resourceGroup}` : `at the subscription, ${args.location}`;
  const attempt = () =>
    ctx.task(
      `what-if ${args.file} ${where}${inEnv(ctx)}`,
      async (signal) => {
        const p = await ctx.provider.whatIf(ctx.cwd(), { ...args, values: typed.values, signal });
        replacePlan(ctx);
        ctx.setData((d) => ({ ...d, plan: p, drift: [], source: { kind: 'bicep', label: `${args.file} ${where}`, args, env: env?.name ?? null, at: Date.now() } }));
        return { stdout: summaryLine(summarize(p.changes)) || 'No changes.' };
      },
      { label: 'Asking Azure (what-if)' },
    );
  let r = await attempt();
  // A template with parameters that have no default and no value in a parameters file: ask for them, once, and go again.
  if (!r.ok && r.error?.missing?.length && !typed.values) {
    const values = await askParameters(ctx, r.error.missing);
    if (!values) return false;
    typed.values = values;
    r = await attempt();
  }
  if (r.ok) {
    ctx.setView('changes');
    void price(ctx);
    ctx.logActivity(`What-if ${args.file} ${where}: ${summaryLine(summarize(ctx.data.plan.changes)) || 'no changes'}`);
  }
  return r.ok;
}

/** In a production environment, the kit's question once more (No first); true straight away elsewhere. */
async function productionAgrees(ctx, what) {
  const q = productionQuestion(envOf(ctx), what);
  if (!q) return true;
  return Boolean(await ctx.confirm({ ...q, options: [{ label: 'No, cancel', value: false }, { label: 'Yes, it is meant for production', value: true }] }));
}

// What an apply or deployment does, in the order it loses things: what's destroyed first.
const GROUPS = [
  ['delete', 'Destroyed'],
  ['replace', 'Replaced (destroyed, then created again)'],
  ['forget', 'Forgotten (left in place, out of the state)'],
  ['update', 'Changed in place'],
  ['deploy', 'Deployed'],
  ['create', 'Created'],
];

/** The lines shown before an apply or a deployment: what it does, the destroys first, each with why and what it costs. */
export function applyLines(plan, { title, costs, dependsOn } = {}) {
  const total = totalWords(costs);
  const lines = [title, `${summaryLine(summarize(plan.changes)) || 'No changes.'}${total ? `, ${total}` : ''}`, ''];
  for (const [action, heading] of GROUPS) {
    const these = changeRows(plan.changes).filter((c) => c.action === action);
    if (!these.length) continue;
    lines.push(`${heading}:`);
    for (const c of these) {
      const cost = costWords(costs?.byAddress?.[c.address], costs?.currency);
      lines.push(`  ${ACTION_MARK[c.action]} ${c.address}${c.reason ? `  (${c.reason})` : ''}${cost ? `  ${cost}` : ''}`);
      const affects = dependsOn ? affectsLine(c, dependsOn) : null;
      if (affects) lines.push(`      ${affects.replace(/^\S+ \S+ /, '')}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * The typed confirmation an apply or deployment needs: `name` (the environment, workspace or resource
 * group it goes to) typed exactly, with what it does on screen; then, in production, the kit's question.
 * Resolves whether to go ahead; anything else typed, or esc, is a no and says so.
 */
async function confirmByName(ctx, { name, verb, what, overview }) {
  ctx.showText(`${verb} · type ${name} to go ahead`, overview.join('\n'));
  const answer = await ctx.confirm({
    secret: true,
    plain: true,
    danger: true,
    title: `Type ${name} to ${verb.toLowerCase()} ${what}`,
    detail: 'What it does is above, what is destroyed first. Anything else, or esc, cancels.',
  });
  const ok = answer && answer.value.trim() === name;
  if (!ok) {
    ctx.closeOverlay();
    if (answer) ctx.note(`That isn't ${name}: nothing was ${verb === 'Apply' ? 'applied' : 'deployed'}.`, 'error');
    return false;
  }
  const yes = await productionAgrees(ctx, `${verb} ${what}`);
  ctx.closeOverlay();
  return yes;
}

/** A deployment of `args` (whatIfArgs') after its what-if, which is the plan on screen: the typed name, then az deployment create. */
async function deployWhatIf(ctx, args, typed = {}) {
  const where = args.resourceGroup ? `into ${args.resourceGroup}` : `at the subscription, ${args.location}`;
  const p = ctx.data.plan;
  const env = envOf(ctx);
  const name = env?.name ?? args.resourceGroup ?? args.location;
  const go = await confirmByName(ctx, { name, verb: 'Deploy', what: `${args.file} ${where}${env ? ` (${env.name})` : ''}`, overview: applyLines(p, { title: `az deployment create of ${args.file} ${where}`, costs: costsOf(ctx.data), dependsOn: dependenciesOf(ctx.data) }) });
  if (!go) return false;
  const attempt = () =>
    ctx.task(
      `deploy ${args.file} ${where}${inEnv(ctx)}`,
      async (signal) => {
        const d = await ctx.provider.deploy(ctx.cwd(), { ...args, values: typed.values, signal });
        return { stdout: `${d.state}${d.name ? `: deployment ${d.name}` : ''}${d.outputs.length ? `, outputs ${d.outputs.join(', ')}` : ''}` };
      },
      { label: 'Deploying' },
    );
  let r = await attempt();
  // The values a what-if was given by hand are never kept, so a deployment after it asks for them again.
  if (!r.ok && r.error?.missing?.length && !typed.values) {
    const values = await askParameters(ctx, r.error.missing);
    if (!values) return false;
    typed.values = values;
    r = await attempt();
  }
  if (r.ok) {
    // The plan on screen was of what has now been done.
    ctx.setData((d) => ({ ...d, plan: null, source: null }));
    ctx.logActivity(`Deployed ${args.file} ${where}${inEnv(ctx)}: ${summaryLine(summarize(p.changes)) || 'no changes'}`, 'change');
  }
  return r.ok;
}

/** /deploy [file] --rg <group> | --location <region> [--params <file>]: a what-if of a Bicep or ARM file, then the deployment if the name it goes to is typed (the same arguments as /whatif). */
export async function deploy(ctx, rest = '') {
  const args = whatIfArgs(rest, { last: ctx.config.whatIf ?? {}, found: ctx.data?.found, env: envOf(ctx) });
  if (!args.file) return ctx.note('/deploy needs a .bicep or ARM file: /deploy main.bicep --rg shop-prod', 'error') ?? false;
  if (!args.resourceGroup && !args.location) return ctx.note(`/deploy ${args.file} needs where to: --rg <resource group>, or --location <region> at the subscription.`, 'error') ?? false;
  // The what-if always runs first, so its changes are what's confirmed; a failed one stops here.
  const typed = {};
  const planned = await whatIf(ctx, rest, typed);
  if (!planned) return false;
  return deployWhatIf(ctx, args, typed);
}

/**
 * /apply: the plan on screen, for real, and only one Chart made: a Terraform plan it saved (/plan,
 * terraform apply of that file), or a what-if (az deployment create of the same file and arguments).
 * It shows what it does, the destroys first, and goes ahead only once the environment's (or else the
 * workspace's or resource group's) name is typed; in production the kit asks once more.
 */
export async function apply(ctx) {
  const p = ctx.data?.plan;
  const s = ctx.data?.source;
  if (!p || !s) return ctx.note('No plan to apply: /plan (or /whatif) first, then /apply.', 'error') ?? false;
  const env = envOf(ctx);
  if ((s.env ?? null) !== (env?.name ?? null)) return ctx.note(`This plan was made for ${s.env ?? 'no environment'}, and the project is on ${env?.name ?? 'none'} now: /plan again, then /apply.`, 'error') ?? false;
  if (!p.changes.some((c) => !['noop', 'read', 'ignore'].includes(c.action))) return ctx.note('Nothing to apply: the plan changes nothing.') ?? false;
  if (s.kind === 'bicep') return deployWhatIf(ctx, s.args);
  if (s.kind !== 'terraform' || !p.planFile) return ctx.note("/apply applies only a plan Chart made and saved itself (/plan). A plan opened from a file isn't one: Terraform's own apply is for that.", 'error') ?? false;
  const b = bin(ctx);
  const opts = tfOpts(ctx);
  const workspace = s.workspace ?? (await ctx.provider.workspace?.(s.dir, opts).catch(() => null)) ?? 'default';
  const name = env?.name ?? workspace;
  const where = `${s.label}${env ? ` (${env.name}, workspace ${workspace})` : ` (workspace ${workspace})`}`;
  const go = await confirmByName(ctx, { name, verb: 'Apply', what: `this plan to ${where}`, overview: applyLines(p, { title: `${b} apply of the plan Chart saved for ${where}`, costs: costsOf(ctx.data), dependsOn: dependenciesOf(ctx.data) }) });
  if (!go) return false;
  const summary = summaryLine(summarize(p.changes)) || 'no changes';
  const r = await ctx.task(
    `${b} apply ${where}`,
    (signal, stream) => ctx.provider.apply(s.dir, { bin: b, planFile: p.planFile, ...(opts.workspace ? { workspace: opts.workspace } : {}), onLine: stream?.line, signal }),
    { label: `Applying (${toolName(b)})` },
  );
  // Applied or refused, the plan file is gone: what's on screen can't be applied again.
  ctx.setData((d) => {
    if (d?.plan !== p) return d;
    if (r.ok) return { ...d, plan: null, source: null };
    const spent = { ...p, planFile: null };
    return { ...d, plan: spent, ...(d.costs?.for === p ? { costs: { ...d.costs, for: spent } } : {}) };
  });
  if (r.ok) ctx.logActivity(`Applied ${where}: ${summary}`, 'change');
  return r.ok;
}

/** /open <file>: a saved plan or state (terraform show -json's) or a what-if result. */
export async function open(ctx, file = '') {
  const name = file.trim() || ctx.data?.found?.saved?.[0];
  if (!name) return ctx.note('/open needs a JSON file: terraform show -json plan.tfplan > plan.json makes one.', 'error') ?? false;
  const path = isAbsolute(name) ? name : resolve(ctx.cwd(), name);
  const r = await ctx.task(
    `open ${name}`,
    async () => {
      const read = await ctx.provider.readFile(path);
      if (read.kind === 'state') {
        ctx.setData((d) => ({ ...d, state: read }));
        return { stdout: `A state: ${plural(read.resources.length, 'resource')}`, kind: 'state' };
      }
      replacePlan(ctx);
      ctx.setData((d) => ({ ...d, plan: read, drift: read.drift, source: { kind: 'file', label: name, path, at: Date.now() } }));
      return { stdout: summaryLine(summarize(read.changes)) || 'No changes.', kind: 'plan' };
    },
    { label: 'Reading' },
  );
  if (r.ok) ctx.setView(r.result.kind === 'state' ? 'state' : 'changes');
  if (r.ok && r.result.kind === 'plan') void price(ctx);
  return r.ok;
}

/** ctrl+r: the last plan again, however it was made; with none, the folder looked at again. */
export function again(ctx) {
  const s = ctx.data?.source;
  if (s?.kind === 'terraform') return plan(ctx, s.dir);
  if (s?.kind === 'bicep') return whatIf(ctx, '');
  if (s?.kind === 'file') return open(ctx, s.path);
  return look(ctx);
}

const currencyOf = (ctx) => ctx.config.currency ?? 'USD';

/** The costs worked out for the plan on screen, or null (none yet, or they were another plan's). */
export const costsOf = (data) => (data?.costs && data.costs.for === data.plan ? data.costs : null);

/**
 * What the plan on screen costs a month (costs.js, prices from the Azure Retail Prices API), worked
 * out beside it: it doesn't hold up the next command, and a newer plan's prices replace it.
 */
export async function price(ctx) {
  const p = ctx.data?.plan;
  if (!p || ctx.config.costs === false || !ctx.provider.prices) return false;
  if (!p.changes.some((c) => ['create', 'delete', 'replace', 'update'].includes(c.action))) return false;
  const currency = currencyOf(ctx);
  const keep = (costs) => ctx.setData((d) => (d?.plan === p ? { ...d, costs: { ...costs, for: p } } : d));
  keep({ pending: true, currency });
  try {
    const costs = await planCosts(p, { prices: (q) => ctx.provider.prices(q, { currency }), currency });
    keep(costs);
    if (costs.failed) ctx.note(`No prices for ${plural(costs.failed, 'resource')}: ${Object.values(costs.byAddress).find((c) => /couldn't be asked/.test(c.note ?? ''))?.note ?? 'the price list failed'}`, 'error');
    return true;
  } catch (e) {
    keep({ error: String(e.message).split('\n')[0], currency });
    ctx.note(`No prices: ${String(e.message).split('\n')[0]}`, 'error');
    return false;
  }
}

/** /currency [code]: the currency prices are shown in (USD unless set), and the plan on screen priced again in it. */
export function currency(ctx, value = '') {
  const v = value.trim().toUpperCase();
  if (!v) return ctx.note(`Prices are in ${currencyOf(ctx)}. /currency ${CURRENCIES.slice(0, 4).join('|')}… changes it.`);
  if (!CURRENCIES.includes(v)) return ctx.note(`The Azure price list has ${CURRENCIES.join(', ')}.`, 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, currency: v }));
  ctx.note(`Prices in ${v} from now on.`, 'ok');
  void price(ctx);
  return true;
}

/** What depends on what in the plan on screen: its own (configuration or ids), or /graph's for it; null when neither says. */
export const dependenciesOf = (data) => data?.plan?.dependsOn ?? (data?.graph && data.graph.for === data.plan ? data.graph.dependsOn : null);

/** A change's detail lines about what depends on it: what destroying or replacing it affects, or what it is affected by. */
function dependencyLines(c, dependsOn, changes) {
  if (!dependsOn) return [];
  const affects = affectsLine(c, dependsOn);
  const by = affectedBy(changes, dependsOn)[c.address];
  return [...(affects ? [`${affects} (g shows what depends on what)`] : []), ...(by ? [`Depends on ${by.join(', ')}, which ${by.length === 1 ? 'is' : 'are'} destroyed or replaced`] : [])];
}

/** g: what depends on what, with the cursor on `change` (the one selected). */
export function showDepends(ctx, change) {
  ctx.openDepends(change?.address ?? null);
  return true;
}

/** /graph [folder]: what depends on what from `terraform graph`, for a plan that came without its configuration. */
export async function graph(ctx, folder = '') {
  const p = ctx.data?.plan;
  if (!p || p.tool !== 'terraform') return ctx.note('/graph needs a Terraform plan on screen: /plan or /open one first.', 'error') ?? false;
  const dir = folder.trim() ? tfDir(ctx, folder) : (ctx.data.source?.dir ?? tfDir(ctx, ''));
  const { varFile, ...opts } = tfOpts(ctx);
  const r = await ctx.task(
    `${opts.bin} graph ${label(ctx, dir)}`,
    async (signal) => {
      const dependsOn = parseDot(await ctx.provider.graph(dir, { ...opts, signal }), p.changes.map((c) => c.address));
      ctx.setData((d) => (d?.plan === p ? { ...d, graph: { for: p, dependsOn } } : d));
      const edges = Object.values(dependsOn).reduce((n, list) => n + list.length, 0);
      return { stdout: `${edges} ${edges === 1 ? 'dependency' : 'dependencies'} between the plan's resources` };
    },
    { label: 'Asking terraform graph' },
  );
  if (r.ok) ctx.openDepends(null);
  return r.ok;
}

/** ↵ on a change: what changes in it, attribute by attribute, and where it's declared. */
export async function showChange(ctx, c, { drifted = false } = {}) {
  const where = await ctx.provider.locate(ctx.data?.source?.dir ?? ctx.cwd(), c).catch(() => null);
  const costs = drifted ? null : costsOf(ctx.data);
  const head = [
    `${c.address}  ${drifted ? 'changed outside the code' : ACTION_WORD[c.action]}${c.reason ? `: ${c.reason}` : ''}`,
    ...(c.movedFrom ? [`Moved from ${c.movedFrom}`] : []),
    ...(c.id ? [`Id: ${c.id}`] : []),
    ...(where ? [`Declared in ${where.path}:${where.line} (t copies it for Splice)`] : []),
    ...(siteOf(c) ? ['An App Service app: s copies it for Locker'] : []),
    ...(drifted ? [] : dependencyLines(c, dependenciesOf(ctx.data), ctx.data?.plan?.changes ?? [])),
    ...(costs?.byAddress?.[c.address] ? costLines(costs.byAddress[c.address], costs.currency) : costs?.pending && !drifted ? ['Cost: being priced…'] : []),
    ...(drifted ? [] : securityOf(ctx.data, ctx.config).planned.filter((f) => f.resource === c.address).map((f) => `Security: ${SEVERITY_LABEL[f.severity]} ${f.title}${f.excerpt ? ` (${f.excerpt})` : ''}. ${f.fix}`)),
    '',
  ];
  const lines = diffLines(c.diff);
  ctx.showText(`${c.address}${drifted ? ' · drift' : ''}`, [...head, ...(lines.length ? lines : ['(no attributes change)'])].join('\n'));
  return true;
}

/**
 * What security.js found, without what the settings' `securityIgnore` names (a rule, or `rule:where`):
 * { planned (the plan on screen's), source (the folder's files', once read) }.
 */
export function securityOf(data, config = {}) {
  const ignore = config.securityIgnore ?? [];
  return { planned: withoutIgnoredFindings(data?.plan?.security ?? [], ignore), source: withoutIgnoredFindings(data?.sources?.findings ?? [], ignore) };
}

/** A finding's detail lines: what, where, what was seen, why it matters and what to set. */
export function findingLines(f) {
  return [
    `${SEVERITY_LABEL[f.severity] ?? '?'}  ${f.title}`,
    '',
    `Where:      ${findingPlace(f)}`,
    ...(f.resource && f.resource !== f.where ? [`Resource:   ${f.resource}${f.type && !f.resource.startsWith(f.type) ? ` (${f.type})` : ''}`] : []),
    ...(f.attribute ? [`Attribute:  ${f.attribute}`] : []),
    ...(f.excerpt ? [`Seen:       ${f.excerpt}`] : []),
    `Rule:       ${f.rule} (securityIgnore: "${f.rule}" or "${f.rule}:${f.where}" in the settings leaves it out)`,
    '',
    ...(f.why ? [`Why: ${f.why}`] : []),
    ...(f.fix ? [`Fix: ${f.fix}`] : []),
  ];
}

/**
 * /security [folder]: the folder's .tf, .tfvars, .bicep and .bicepparam files read as they are
 * (nothing is run), for misconfigurations and passwords written into them, beside what the plan on
 * screen would deploy; the Security view shows both.
 */
export async function security(ctx, folder = '') {
  const n = folder.trim();
  const dir = n ? (isAbsolute(n) ? n : join(ctx.cwd(), n)) : ctx.cwd();
  const r = await ctx.task(
    `security ${label(ctx, dir)}`,
    async () => {
      const files = await ctx.provider.sources(dir);
      const findings = folderFindings(files);
      ctx.setData((d) => ({ ...d, sources: { dir, files: files.length, findings, at: Date.now() } }));
      const { planned, source } = securityOf(ctx.data, ctx.config);
      const parts = [`${plural(files.length, 'source file')} read: ${findingsLine(countFindings(source)) || 'nothing found'}`, ctx.data?.plan ? `the plan on screen: ${findingsLine(countFindings(planned)) || 'nothing found'}` : ''].filter(Boolean);
      return { stdout: parts.join('; ') };
    },
    { label: 'Reading the source files' },
  );
  if (r.ok) ctx.setView('security');
  return r.ok;
}

/** ↵ on a finding: what it is, where, and what to set; for a plan's, where its resource is declared. */
export async function showFinding(ctx, f) {
  const change = f.line ? null : (ctx.data?.plan?.changes ?? []).find((c) => c.address === f.resource);
  const where = change ? await ctx.provider.locate(ctx.data?.source?.dir ?? ctx.cwd(), change).catch(() => null) : null;
  const lines = findingLines(f);
  if (where) lines.splice(3, 0, `Declared:   ${where.path}:${where.line} (t copies it for Splice)`);
  if (change) lines.splice(3, 0, `Planned:    ${ACTION_WORD[change.action]}`);
  ctx.showText(`${f.title} · ${findingPlace(f)}`, lines.join('\n'));
  return true;
}

/** t on a finding: the line it is on (a source file's), or where its resource is declared (a plan's), for Splice. */
export async function shareFinding(ctx, f) {
  if (f.line) {
    const line = takeLine('file', { path: f.where, line: f.line });
    ctx.copy(line, 'a line for Splice');
    ctx.note(copiedNote('splice', line));
    return true;
  }
  const change = (ctx.data?.plan?.changes ?? []).find((c) => c.address === f.resource);
  if (!change) return ctx.note(`Couldn't find ${f.resource} in the plan on screen.`, 'error') ?? false;
  return shareDeclaration(ctx, change);
}

/** ↵ on a resource of the state: its values, the sensitive ones masked. */
export function showResource(ctx, r) {
  ctx.showText(r.address, [`${r.address}  ${r.provider}${r.mode === 'data' ? ', a data source' : ''}`, '', ...valueLines(r.values, r.sensitive)].join('\n'));
  return true;
}

/** t: where a resource is declared, for Splice to blame (who wrote it, and when). */
export async function shareDeclaration(ctx, c) {
  const where = await ctx.provider.locate(ctx.data?.source?.dir ?? ctx.cwd(), c).catch(() => null);
  if (!where) return ctx.note(`Couldn't find resource "${c.type}" "${c.name}" in the .tf files here.`, 'error') ?? false;
  const line = takeLine('file', where);
  ctx.copy(line, 'a line for Splice');
  ctx.note(copiedNote('splice', line));
  return true;
}

/** s: an App Service app the plan touches, for Locker (its settings and Key Vault references). */
export function shareSite(ctx, c) {
  const site = siteOf(c);
  if (!site) return ctx.note(`${c.address} isn't an App Service app: s hands one to Locker.`, 'error') ?? false;
  const line = takeLine('site', site);
  ctx.copy(line, 'a line for Locker');
  ctx.note(copiedNote('locker', line));
  return true;
}

/** /show <address>: a change, found by its address or the end of it. */
export function show(ctx, text) {
  const all = [...(ctx.data?.plan?.changes ?? []), ...(ctx.data?.drift ?? [])];
  const c = findChange(all, text);
  if (!c) return ctx.note(text ? `No single change matches "${text}".` : '/show needs a resource address.', 'error') ?? false;
  return showChange(ctx, c, { drifted: !ctx.data.plan?.changes.includes(c) });
}

/** /report: the plan as Markdown, to copy (alt+y) into a pull request's comment. */
export function report(ctx) {
  const p = ctx.data?.plan;
  if (!p) return ctx.note('No plan yet: /plan, /whatif or /open first.', 'error') ?? false;
  ctx.showText('Report (alt+y copies it all)', markdownReport({ ...p, drift: ctx.data.drift ?? p.drift }, { label: ctx.data.source?.label ?? basename(ctx.cwd()), costs: costsOf(ctx.data) }));
  return true;
}

/** /tool [terraform|tofu]: which one Chart runs. */
export function tool(ctx, value = '') {
  const v = value.trim();
  if (!v) return ctx.note(`Chart runs ${bin(ctx)}. /tool terraform|tofu changes it.`);
  if (!BINARIES.includes(v)) return ctx.note(`/tool is one of ${BINARIES.join(', ')}.`, 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, terraform: v }));
  ctx.note(`Running ${v} from now on.`, 'ok');
  return true;
}

/** What the chosen environment makes Chart do, in words: "workspace prod, var file prod.tfvars, what-ifs into rg-shop". */
export function envSummary(e) {
  if (!e) return '';
  const parts = [e.workspace ? `workspace ${e.workspace}` : '', e.varFile ? `var file ${e.varFile}` : '', e.resourceGroup ? `what-ifs into ${e.resourceGroup}` : '', e.parametersFile ? `parameters ${e.parametersFile}` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : 'its "chart" section says nothing, so plans run as they would without it';
}

/** /env [name]: which environment the project is on (every app's), or switch every app to another. */
export function env(ctx, name = '') {
  const n = name.trim();
  if (!n) {
    const e = envOf(ctx);
    return ctx.note(`${describeEnvironments(ctx.cwd())}${e ? `\nChart: ${envSummary(e)}.` : ''}`);
  }
  const r = setEnvironment(ctx.cwd(), n, { by: 'chart' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  // The hook notices within a second; the frames go red (or back) now.
  markProduction(r.env.prod);
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production)' : ''}, for every app.\nChart: ${envSummary(envOf(ctx))}.${ctx.data?.plan ? ' The plan on screen is the last environment\'s: ctrl+r plans again.' : ''}`, 'ok');
  return true;
}

/** /move <folder>: look at another folder: a path, or a folder beside this one or in it. */
export function move(ctx, folder = '') {
  const dir = ctx.cwd();
  if (!folder.trim()) return ctx.note(`Looking at ${dir}. /move <folder> looks at another (one beside this, in it, or a path).`);
  const target = resolveFolder(dir, folder);
  if (!target) return ctx.note(`There's no folder ${folder.trim()} here or beside ${basename(dir)}.`, 'error') ?? false;
  if (samePath(target, dir)) return ctx.note(`Chart is in ${basename(target)} already.`);
  ctx.moveTo(target);
  return look(ctx);
}

/** /take: Chart takes no sibling's context yet; says whose it is. */
export function take(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  return ctx.note(notMine('chart', context), 'error') ?? false;
}

/** ! and /run: a shell command in the folder, its output in the activity line (/last has it all). */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !terraform validate', 'error') ?? false;
  const r = await ctx.task(command, (signal) => run(command, { cwd: ctx.cwd(), signal }), { label: 'Running' });
  return r.ok;
}

/** /theme: dark, light or auto; with no argument says which. */
export function setTheme(ctx, value) {
  if (!value) return ctx.note(`Theme: ${ctx.config.theme ?? 'auto'} (${theme.mode} here). /theme ${THEMES.join('|')} changes it.`);
  if (!THEMES.includes(value)) return ctx.note(`Theme is one of ${THEMES.join(', ')}.`, 'error') ?? false;
  const next = { ...ctx.config, theme: value };
  ctx.setConfig(next);
  applyTheme(next);
  ctx.note(`Theme: ${value}`);
  return true;
}

/** /accent: a #rrggbb colour, or `default`. */
export function accent(ctx, value) {
  if (!value) return ctx.note(`Accent: ${ctx.config.accent ?? 'default'} (${theme.accent}). /accent #rrggbb changes it.`);
  if (value !== 'default' && !isColour(value)) return ctx.note('An accent is #rrggbb, or "default".', 'error') ?? false;
  const next = { ...ctx.config };
  if (value === 'default') delete next.accent;
  else next.accent = value;
  ctx.setConfig(next);
  setAccent(next.accent);
  ctx.note(`Accent: ${value}`);
  return true;
}

/** /mouse: on or off. */
export function mouse(ctx, value) {
  if (!['on', 'off'].includes(value)) return ctx.note(`Mouse is ${ctx.config.mouse === false ? 'off' : 'on'}. /mouse on|off changes it.`);
  ctx.setConfig({ ...ctx.config, mouse: value === 'on' });
  ctx.note(`Mouse: ${value}${value === 'off' ? ' (the terminal selects text again)' : ''}`);
  return true;
}

/** /settings: what's set, and where it's kept. */
export function settings(ctx) {
  const c = ctx.config;
  const on = (v) => (v === false ? 'off' : 'on');
  const w = c.whatIf;
  ctx.showText(
    'Settings',
    [
      `Theme            ${c.theme ?? 'auto'} (${theme.mode} here)       /theme dark|light|auto`,
      `Accent colour    ${c.accent ?? 'default'}       /accent #rrggbb`,
      `Mouse            ${on(c.mouse)}       /mouse on|off`,
      `Runs             ${bin(ctx)}       /tool terraform|tofu`,
      `Prices           ${c.costs === false ? 'off' : `in ${currencyOf(ctx)}, from prices.azure.com`}       /currency <code> · "costs": false in the file turns them off`,
      `Environment      ${envOf(ctx) ? `${envOf(ctx).name}${envOf(ctx).prod ? ' (production)' : ''}: ${envSummary(envOf(ctx))}` : 'none (.fleet/project.json names them)'}       /env [name]`,
      `Last what-if     ${w ? `${w.file} ${w.resourceGroup ? `--rg ${w.resourceGroup}` : `--location ${w.location}`}${w.params ? ` --params ${w.params}` : ''}` : 'none'}`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()}`,
    ].join('\n'),
  );
  return true;
}
