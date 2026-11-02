// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
// Chart reads and plans; the one thing that changes infrastructure is /deploy (a Bicep or ARM file), and only after a confirmation.
import { basename, isAbsolute, join, resolve } from 'node:path';
import { run } from '@fleet/kit/run.js';
import { contextIn, copiedNote, notMine, splitArgs, takeLine } from '@fleet/kit/family.js';
import { resolveFolder, samePath } from '@fleet/kit/folders.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { diffLines, valueLines } from './diff.js';
import { summarize, summaryLine } from './plan.js';
import { ACTION_WORD, findChange, siteOf } from './rows.js';
import { markdownReport } from './share.js';
import { BINARIES } from './iac.js';
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

/** /plan [folder]: terraform (or tofu) plan, its changes and what drifted; nothing is applied. */
export async function plan(ctx, folder = '') {
  const dir = tfDir(ctx, folder);
  const b = bin(ctx);
  const opts = tfOpts(ctx);
  const env = envOf(ctx);
  const r = await ctx.task(
    `${b} plan ${label(ctx, dir)}${inEnv(ctx)}`,
    async (signal) => {
      const p = await ctx.provider.plan(dir, { ...opts, signal });
      // The environment it was made for goes with it: a plan of dev's is never applied to prod.
      ctx.setData((d) => ({ ...d, plan: p, drift: p.drift, source: { kind: 'terraform', dir, label: label(ctx, dir), env: env?.name ?? null, workspace: opts.workspace ?? null, at: Date.now() } }));
      return { stdout: `${summaryLine(summarize(p.changes)) || 'No changes.'}${p.drift.length ? `; ${plural(p.drift.length, 'resource')} changed outside ${toolName(b)}` : ''}` };
    },
    { label: `Planning (${toolName(b)})` },
  );
  if (r.ok) {
    ctx.setView('changes');
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

/** /deploy [file] --rg <group> | --location <region> [--params <file>]: runs a what-if of a Bicep or ARM file, then deploys it if the confirmation that follows it is a yes (the same arguments as /whatif). */
export async function deploy(ctx, rest = '') {
  const args = whatIfArgs(rest, { last: ctx.config.whatIf ?? {}, found: ctx.data?.found, env: envOf(ctx) });
  if (!args.file) return ctx.note('/deploy needs a .bicep or ARM file: /deploy main.bicep --rg shop-prod', 'error') ?? false;
  if (!args.resourceGroup && !args.location) return ctx.note(`/deploy ${args.file} needs where to: --rg <resource group>, or --location <region> at the subscription.`, 'error') ?? false;
  const where = args.resourceGroup ? `into ${args.resourceGroup}` : `at the subscription, ${args.location}`;
  // The what-if always runs first, so the changes are on screen behind the question; a failed one stops here.
  const typed = {};
  const planned = await whatIf(ctx, rest, typed);
  if (!planned) return false;
  const summary = summaryLine(summarize(ctx.data.plan.changes)) || 'no changes';
  // "No" comes first so that ↵ alone never deploys.
  const yes = await ctx.confirm({
    title: `Deploy ${args.file} ${where}?`,
    detail: `What-if: ${summary}`,
    danger: true,
    options: [{ label: 'No, cancel', value: false }, { label: 'Yes, deploy it', value: true }],
  });
  if (!yes) return false;
  if (!(await productionAgrees(ctx, `Deploy ${args.file} ${where}`))) return false;
  const r = await ctx.task(
    `deploy ${args.file} ${where}`,
    async (signal) => {
      const d = await ctx.provider.deploy(ctx.cwd(), { ...args, values: typed.values, signal });
      return { stdout: `${d.state}${d.name ? `: deployment ${d.name}` : ''}${d.outputs.length ? `, outputs ${d.outputs.join(', ')}` : ''}` };
    },
    { label: 'Deploying' },
  );
  if (r.ok) {
    // The plan on screen was of what has now been done.
    ctx.setData((d) => ({ ...d, plan: null, source: null }));
    ctx.logActivity(`Deployed ${args.file} ${where}`);
  }
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
      ctx.setData((d) => ({ ...d, plan: read, drift: read.drift, source: { kind: 'file', label: name, path, at: Date.now() } }));
      return { stdout: summaryLine(summarize(read.changes)) || 'No changes.', kind: 'plan' };
    },
    { label: 'Reading' },
  );
  if (r.ok) ctx.setView(r.result.kind === 'state' ? 'state' : 'changes');
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

/** ↵ on a change: what changes in it, attribute by attribute, and where it's declared. */
export async function showChange(ctx, c, { drifted = false } = {}) {
  const where = await ctx.provider.locate(ctx.data?.source?.dir ?? ctx.cwd(), c).catch(() => null);
  const head = [
    `${c.address}  ${drifted ? 'changed outside the code' : ACTION_WORD[c.action]}${c.reason ? `: ${c.reason}` : ''}`,
    ...(c.movedFrom ? [`Moved from ${c.movedFrom}`] : []),
    ...(c.id ? [`Id: ${c.id}`] : []),
    ...(where ? [`Declared in ${where.path}:${where.line} (t copies it for Splice)`] : []),
    ...(siteOf(c) ? ['An App Service app: s copies it for Locker'] : []),
    '',
  ];
  const lines = diffLines(c.diff);
  ctx.showText(`${c.address}${drifted ? ' · drift' : ''}`, [...head, ...(lines.length ? lines : ['(no attributes change)'])].join('\n'));
  return true;
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
  ctx.showText('Report (alt+y copies it all)', markdownReport({ ...p, drift: ctx.data.drift ?? p.drift }, { label: ctx.data.source?.label ?? basename(ctx.cwd()) }));
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
