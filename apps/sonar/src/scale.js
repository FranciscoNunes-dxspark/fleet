// App Service plans (serverfarms): their tier, size and instance count, what /scale asks for, and the
// autoscale settings that target a plan, summed up. Pure: the provider reads and changes them
// (azure/arm.js plan, scalePlan, autoscaleSettings; demo.js too).
import { splitArgs } from './family.js';

const groupOf = (id) => /\/resourceGroups\/([^/]+)/i.exec(id ?? '')?.[1] ?? '';

/** A plan as ARM has it: its SKU (name, tier, instances), how many apps it runs, its limits. */
export function planFrom(p) {
  const props = p.properties ?? {};
  return {
    id: p.id,
    name: p.name,
    resourceGroup: groupOf(p.id),
    location: p.location,
    kind: p.kind ?? '',
    sku: { name: p.sku?.name ?? '', tier: p.sku?.tier ?? skuTier(p.sku?.name) ?? '', capacity: Number(p.sku?.capacity ?? props.currentNumberOfWorkers ?? 1) },
    maxWorkers: props.maximumNumberOfWorkers ?? null,
    elasticMax: props.maximumElasticWorkerCount ?? null,
    sites: props.numberOfSites ?? null,
    status: props.status ?? '',
  };
}

// The tier of each SKU name, as App Service names them.
const TIERS = [
  [/^F1$/i, 'Free'],
  [/^D1$/i, 'Shared'],
  [/^B[1-3]$/i, 'Basic'],
  [/^S[1-3]$/i, 'Standard'],
  [/^P[1-3]$/i, 'Premium'],
  [/^P[1-3]v2$/i, 'PremiumV2'],
  [/^P[0-3]v3$/i, 'PremiumV3'],
  [/^P[1-5]mv3$/i, 'PremiumMV3'],
  [/^P[0-3]v4$/i, 'PremiumV4'],
  [/^I[1-6]v2$/i, 'IsolatedV2'],
  [/^I[1-6]mv2$/i, 'IsolatedMV2'],
  [/^EP[1-3]$/i, 'ElasticPremium'],
  [/^WS[1-3]$/i, 'WorkflowStandard'],
  [/^Y1$/i, 'Dynamic'],
  [/^FC1$/i, 'FlexConsumption'],
];

/** A SKU name's tier ("P1v3" → "PremiumV3"), or null for a name App Service doesn't have. */
export const skuTier = (name) => TIERS.find(([re]) => re.test(String(name ?? '')))?.[1] ?? null;

/** The SKU name as App Service writes it: "p1v3" → "P1v3". */
export const skuName = (name) => String(name).toUpperCase().replace(/MV(\d)$/, 'mv$1').replace(/([^m])V(\d)$/, '$1v$2');

/** Whether a plan scales by itself, so its instances can't be set (Consumption, Flex Consumption). */
export const consumption = (plan) => /^(Dynamic|FlexConsumption)$/i.test(plan?.sku?.tier ?? '');

/** "P1v3 PremiumV3 · 2 instances". */
export const planLine = (plan) => `${plan.sku.name}${plan.sku.tier ? ` ${plan.sku.tier}` : ''}${consumption(plan) ? ' · scales by itself' : ` · ${plan.sku.capacity} instance${plan.sku.capacity === 1 ? '' : 's'}`}`;

/**
 * /scale's words: [app] then a number of instances or a SKU name. `names` are the apps' labels, so a
 * first word that's one of them names the app. { app, instances } or { app, sku }, or { error }.
 */
export function parseScale(text, names = []) {
  const words = splitArgs(String(text ?? '').trim());
  if (!words.length) return { error: 'Say how: /scale [app] <instances> or /scale [app] <tier>, e.g. /scale 3 or /scale contoso-web P1v3' };
  const lower = names.map((n) => n.toLowerCase());
  const app = words.length > 1 ? words[0] : lower.includes(words[0].toLowerCase()) ? words[0] : null;
  const what = words.length > 1 ? words.slice(1).join(' ') : app ? '' : words[0];
  if (app && !lower.includes(app.toLowerCase())) return { error: `There's no app called ${app}.` };
  if (!what) return { error: `Say how to scale ${app}: a number of instances, or a tier such as P1v3.` };
  if (/^\d+$/.test(what)) {
    const n = Number(what);
    if (n < 1 || n > 100) return { error: `${n} instances? Between 1 and 100 (the plan's own limit may be lower).` };
    return { app, instances: n };
  }
  if (!skuTier(what)) return { error: `${what} isn't an App Service tier: B1, S1, P1v3, P2mv3, I1v2, EP1…` };
  return { app, sku: skuName(what) };
}

/** What the plan's SKU becomes: { name, tier, capacity } (ARM works the size and family out from the name). */
export function scaledSku(plan, { instances, sku }) {
  if (sku) return { name: sku, tier: skuTier(sku), capacity: plan.sku.capacity };
  return { name: plan.sku.name, tier: plan.sku.tier, capacity: instances };
}

/** An autoscale setting (Microsoft.Insights/autoscalesettings): whether it's on, what it targets, its profiles and rules. */
export function autoscaleFrom(a) {
  const p = a.properties ?? {};
  return {
    id: a.id,
    name: a.name ?? p.name,
    enabled: p.enabled !== false,
    target: p.targetResourceUri ?? '',
    profiles: (p.profiles ?? []).map((pr) => ({
      name: pr.name,
      min: Number(pr.capacity?.minimum ?? 0),
      max: Number(pr.capacity?.maximum ?? 0),
      default: Number(pr.capacity?.default ?? 0),
      fixed: Boolean(pr.fixedDate),
      recurring: Boolean(pr.recurrence),
      rules: (pr.rules ?? []).map((r) => ({
        metric: r.metricTrigger?.metricName ?? '',
        operator: r.metricTrigger?.operator ?? '',
        threshold: r.metricTrigger?.threshold,
        direction: r.scaleAction?.direction ?? '',
        change: Number(r.scaleAction?.value ?? 1),
        type: r.scaleAction?.type ?? 'ChangeCount',
      })),
    })),
  };
}

/** The autoscale settings that target the plan `id` (case aside). */
export const autoscaleFor = (settings, id) => (settings ?? []).filter((a) => a.target.toLowerCase() === String(id ?? '').toLowerCase());

const OPS = { GreaterThan: '>', GreaterThanOrEqual: '≥', LessThan: '<', LessThanOrEqual: '≤', Equals: '=', NotEquals: '≠' };

/** One rule in words: "CpuPercentage > 70 → +1". */
export const ruleWords = (r) => `${r.metric} ${OPS[r.operator] ?? r.operator} ${r.threshold} → ${r.direction === 'Decrease' ? '-' : '+'}${r.change}${r.type === 'PercentChangeCount' ? '%' : ''}`;

/** A plan's autoscale in a line: "on: 2–5 instances, CpuPercentage > 70 → +1, CpuPercentage < 30 → -1", or "off" / null with none. */
export function autoscaleSummary(list) {
  if (!list?.length) return null;
  const on = list.filter((a) => a.enabled);
  if (!on.length) return `off (${list.map((a) => a.name).join(', ')})`;
  const pr = on[0].profiles.find((p) => !p.fixed && !p.recurring) ?? on[0].profiles[0];
  if (!pr) return 'on, with no profile';
  const more = on[0].profiles.length > 1 ? ` (+${on[0].profiles.length - 1} profile${on[0].profiles.length > 2 ? 's' : ''})` : '';
  return `on: ${pr.min}–${pr.max} instances${pr.rules.length ? `, ${pr.rules.map(ruleWords).join(', ')}` : ''}${more}`;
}
