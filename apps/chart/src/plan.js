// What a plan says, in one shape for every tool: Terraform's (and OpenTofu's) `show -json` of a plan or
// of the state, and Azure's what-if of a Bicep or ARM deployment. Pure.
//
// A change: { address, type, name, module?, mode, provider?, action, reason?, diff, id?, resourceGroup? }
//   action: create | update | replace | delete | read | noop | forget | deploy | ignore | unsupported
//   diff:   [{ path, kind: add | remove | change | unknown, before?, after?, forces?, sensitive?, noise? }]
import { attributeDiff } from './diff.js';

/** Terraform's actions as one word: ["delete","create"] (or the other way round) is a replacement. */
export function actionOf(actions = []) {
  const a = [...actions].sort().join(',');
  if (a === 'create,delete') return 'replace';
  if (a === 'no-op') return 'noop';
  return ['create', 'update', 'delete', 'read', 'forget'].includes(a) ? a : a || 'noop';
}

// Terraform's own words for why a resource is replaced, deleted or read, said as a person would.
const REASONS = {
  replace_because_cannot_update: 'an argument that forces replacement changed',
  replace_because_tainted: 'it is tainted',
  replace_by_request: 'asked for with -replace',
  replace_by_triggers: 'its replace_triggered_by changed',
  delete_because_no_resource_config: 'it is no longer in the configuration',
  delete_because_no_module: 'its module is no longer in the configuration',
  delete_because_wrong_repetition: 'it changed between count and for_each',
  delete_because_count_index: 'its count index is out of range',
  delete_because_each_key: 'its for_each key is gone',
  delete_because_no_move_target: 'its moved block has no target',
  read_because_config_unknown: 'its configuration is known only after apply',
  read_because_dependency_pending: 'something it depends on changes',
};

function terraformChange(rc) {
  const c = rc.change ?? {};
  const action = actionOf(c.actions);
  return {
    address: rc.address,
    type: rc.type,
    name: rc.name,
    ...(rc.module_address ? { module: rc.module_address } : {}),
    mode: rc.mode ?? 'managed',
    provider: String(rc.provider_name ?? '').replace(/^registry\.(terraform|opentofu)\.io\//, ''),
    action,
    ...(rc.action_reason ? { reason: REASONS[rc.action_reason] ?? rc.action_reason.replace(/_/g, ' ') } : {}),
    ...(rc.previous_address ? { movedFrom: rc.previous_address } : {}),
    diff: attributeDiff(c.before, c.after, { unknown: c.after_unknown, beforeSensitive: c.before_sensitive, afterSensitive: c.after_sensitive, forces: c.replace_paths }),
    ...(action === 'create' ? {} : { id: c.before?.id ?? null }),
    ...(c.before?.resource_group_name || c.after?.resource_group_name ? { resourceGroup: c.after?.resource_group_name ?? c.before?.resource_group_name } : {}),
  };
}

/**
 * `terraform show -json <planfile>`, parsed: { tool: 'terraform', version, changes, drift, outputs,
 * errored }. `changes` leave out data sources that are only read, `drift` is what changed outside
 * Terraform since the last apply (`resource_drift`), `outputs` the outputs that change.
 */
export function parseTerraformPlan(json) {
  const plan = typeof json === 'string' ? JSON.parse(json) : json;
  if (!plan || !('resource_changes' in plan || 'resource_drift' in plan || 'planned_values' in plan)) throw new Error("That isn't a Terraform plan: terraform show -json <planfile> makes one.");
  const changes = (plan.resource_changes ?? []).filter((rc) => rc.mode !== 'data' || actionOf(rc.change?.actions) !== 'read').map(terraformChange);
  const drift = (plan.resource_drift ?? []).map(terraformChange);
  const outputs = Object.entries(plan.output_changes ?? {})
    .map(([name, c]) => ({ name, action: actionOf(c.actions), sensitive: Boolean(c.sensitive), diff: attributeDiff({ value: c.before }, { value: c.after }, { unknown: { value: c.after_unknown }, beforeSensitive: c.sensitive ? { value: true } : {}, afterSensitive: c.sensitive ? { value: true } : {} }) }))
    .filter((o) => o.action !== 'noop');
  return { tool: 'terraform', version: plan.terraform_version ?? null, changes, drift, outputs, errored: Boolean(plan.errored) };
}

/**
 * `terraform show -json` of the state: every resource, modules' too, as
 * { address, type, name, module?, mode, provider, values, sensitive }.
 */
export function parseTerraformState(json) {
  const state = typeof json === 'string' ? JSON.parse(json) : json;
  const out = [];
  const walk = (mod) => {
    for (const r of mod?.resources ?? []) {
      out.push({ address: r.address, type: r.type, name: r.name, ...(mod.address ? { module: mod.address } : {}), mode: r.mode ?? 'managed', provider: String(r.provider_name ?? '').replace(/^registry\.(terraform|opentofu)\.io\//, ''), values: r.values ?? {}, sensitive: r.sensitive_values ?? {} });
    }
    for (const child of mod?.child_modules ?? []) walk(child);
  };
  walk(state?.values?.root_module);
  return { tool: 'terraform', version: state?.terraform_version ?? null, resources: out };
}

const WHAT_IF = { Create: 'create', Delete: 'delete', Modify: 'update', Deploy: 'deploy', NoChange: 'noop', Ignore: 'ignore', Unsupported: 'unsupported' };
const PROPERTY = { Create: 'add', Delete: 'remove', Modify: 'change', Array: 'change', NoEffect: 'change' };

/** An Azure resource id's parts: { type, name, resourceGroup?, subscription? } (a child's type and name joined: Microsoft.Web/sites/slots, app/staging). */
export function parseResourceId(id) {
  const parts = String(id ?? '').split('/').filter(Boolean);
  const at = (key) => {
    const i = parts.findIndex((p) => p.toLowerCase() === key);
    return i >= 0 ? parts[i + 1] : undefined;
  };
  const p = parts.findIndex((x) => x.toLowerCase() === 'providers');
  if (p < 0) return { type: parts.includes('resourceGroups') && parts.length === 4 ? 'Microsoft.Resources/resourceGroups' : 'unknown', name: parts.at(-1) ?? id, resourceGroup: at('resourcegroups'), subscription: at('subscriptions') };
  const rest = parts.slice(p + 2);
  const types = [parts[p + 1]];
  const names = [];
  for (let i = 0; i < rest.length; i += 2) {
    types.push(rest[i]);
    if (rest[i + 1] !== undefined) names.push(rest[i + 1]);
  }
  return { type: types.join('/'), name: names.join('/'), resourceGroup: at('resourcegroups'), subscription: at('subscriptions') };
}

/** A what-if delta, flattened: its children's paths under its own. */
function flattenDelta(delta = [], prefix = '') {
  const out = [];
  for (const d of delta) {
    const path = prefix ? (/^\d+$/.test(d.path) ? `${prefix}[${d.path}]` : `${prefix}.${d.path}`) : d.path;
    if (d.children?.length) {
      out.push(...flattenDelta(d.children, path));
      continue;
    }
    out.push({ path, kind: PROPERTY[d.propertyChangeType] ?? 'change', ...(d.before !== undefined ? { before: d.before } : {}), ...(d.after !== undefined ? { after: d.after } : {}), ...(d.propertyChangeType === 'NoEffect' ? { noise: true } : {}) });
  }
  return out;
}

/**
 * `az deployment group|sub what-if --no-pretty-print -o json`, parsed: { tool: 'bicep', changes,
 * drift: [], outputs: [], errored }. A NoEffect property (one Azure will change back, or reports
 * differently) is marked `noise`.
 */
export function parseWhatIf(json) {
  const result = typeof json === 'string' ? JSON.parse(json) : json;
  const body = result?.properties ?? result;
  if (!body || !Array.isArray(body.changes)) {
    if (body?.error) throw new Error(`What-if failed: ${body.error.message ?? body.error.code}`);
    throw new Error("That isn't a what-if result: az deployment group what-if --no-pretty-print -o json makes one.");
  }
  const changes = body.changes.map((c) => {
    const { type, name, resourceGroup, subscription } = parseResourceId(c.resourceId);
    const action = WHAT_IF[c.changeType] ?? 'unsupported';
    const diff = c.delta?.length ? flattenDelta(c.delta) : action === 'create' ? attributeDiff(null, c.after) : action === 'delete' ? attributeDiff(c.before, null) : [];
    return { address: `${type}/${name}`, type, name, mode: 'managed', provider: type.split('/')[0], action, ...(c.unsupportedReason ? { reason: c.unsupportedReason } : {}), diff, id: c.resourceId, ...(resourceGroup ? { resourceGroup } : {}), ...(subscription ? { subscription } : {}) };
  });
  return { tool: 'bicep', version: null, changes, drift: [], outputs: [], errored: body.status === 'Failed' };
}

/** What a JSON file is: a Terraform plan, a Terraform state, or a what-if result, parsed; throws for anything else. */
export function parseAny(text) {
  const json = JSON.parse(String(text).replace(/^﻿/, ''));
  if ('resource_changes' in json || 'resource_drift' in json || 'planned_values' in json) return { kind: 'plan', ...parseTerraformPlan(json) };
  if (json.values?.root_module || ('format_version' in json && 'terraform_version' in json && !('resource_changes' in json))) return { kind: 'state', ...parseTerraformState(json) };
  if (Array.isArray(json.changes) || Array.isArray(json.properties?.changes)) return { kind: 'plan', ...parseWhatIf(json) };
  throw new Error("That file is neither a Terraform plan or state (terraform show -json) nor a what-if result.");
}

// The order changes are listed in: what loses something first.
export const ACTIONS = ['delete', 'replace', 'forget', 'update', 'deploy', 'create', 'read', 'unsupported', 'ignore', 'noop'];
export const actionRank = (a) => {
  const i = ACTIONS.indexOf(a);
  return i < 0 ? ACTIONS.length : i;
};

/** How many changes of each kind: { create, update, replace, delete, … }. */
export function summarize(changes) {
  const out = {};
  for (const c of changes) out[c.action] = (out[c.action] ?? 0) + 1;
  return out;
}

/** "+3 ~2 ±1 -1" for what a plan does; '' when it does nothing. */
export function summaryLine(s) {
  const parts = [['create', '+'], ['update', '~'], ['deploy', '~'], ['replace', '±'], ['delete', '-'], ['forget', '⊘']]
    .map(([a, sign]) => (s[a] ? `${sign}${s[a]}` : ''))
    .filter(Boolean);
  return parts.join(' ');
}

/** Changes in the order shown: what loses something first, then by address. */
export const ordered = (changes) => [...changes].sort((a, b) => actionRank(a.action) - actionRank(b.action) || a.address.localeCompare(b.address));
