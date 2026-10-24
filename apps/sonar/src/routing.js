// Testing in production: an app's ramp-up rules (its config/web experiments.rampUpRules), which send a
// share of production's traffic to a slot. Pure: the provider reads and writes them (azure/arm.js
// routing, setRouting; demo.js too).
import { splitArgs } from '@fleet/kit/family.js';

/** ARM's site config as [{ slot, host, percent }]: each slot's share of the traffic. */
export function routingFrom(config) {
  return (config?.properties?.experiments?.rampUpRules ?? []).map((r) => ({ slot: r.name ?? String(r.actionHostName ?? '').split('.')[0], host: r.actionHostName ?? '', percent: Number(r.reroutePercentage ?? 0) }));
}

/** The rules as ARM takes them back. */
export const rampUpRules = (rules) => rules.map((r) => ({ actionHostName: r.host, reroutePercentage: r.percent, name: r.slot }));

/** What production keeps: 100 less what the slots take. */
export const productionShare = (rules) => Math.max(0, 100 - (rules ?? []).reduce((n, r) => n + r.percent, 0));

/** The rules with `slot` (a slot target) taking `percent` of the traffic; 0 takes its rule away. { rules } or { error }. */
export function withRoute(rules, slot, percent) {
  const others = (rules ?? []).filter((r) => r.slot.toLowerCase() !== slot.slot.toLowerCase());
  if (!percent) return { rules: others };
  const total = others.reduce((n, r) => n + r.percent, 0) + percent;
  if (total > 100) return { error: `The slots would take ${total}% of the traffic: ${others.map((r) => `${r.slot} has ${r.percent}%`).join(', ')}.` };
  return { rules: [...others, { slot: slot.slot, host: slot.host, percent }] };
}

/** /route's words: <app> <slot> <percent>, or <app/slot> <percent>. { app, slot, percent } or { error }. */
export function parseRoute(text) {
  const words = splitArgs(String(text ?? '').trim());
  const usage = 'Say where: /route <app> <slot> <percent>, e.g. /route contoso-web staging 10 (0 stops it)';
  let app;
  let slot;
  let pct;
  if (words.length === 3) [app, slot, pct] = words;
  else if (words.length === 2 && words[0].includes('/')) [[app, slot], pct] = [words[0].split('/'), words[1]];
  else return { error: usage };
  const n = Number(String(pct).replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) return { error: `${pct} isn't a percentage from 0 to 100.` };
  return { app, slot, percent: Math.round(n * 10) / 10 };
}
