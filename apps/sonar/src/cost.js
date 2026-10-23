// What things cost this month so far, beside how they're doing: the provider's costs(sub) (Cost
// Management's MonthToDate ActualCost by resource) read once a day, shown per resource group and in a
// resource's details. Pure.

/** An amount in the costs' currency, as people write it: €61.20, $3.12. */
export function money(amount, currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

/** A resource's own cost (by its id), or null when the costs don't name it. */
export const costOf = (costs, id) => (costs && id && costs.byId[String(id).toLowerCase()] != null ? costs.byId[String(id).toLowerCase()] : null);

/** A resource group's cost: everything under /subscriptions/<sub>/resourceGroups/<group>/, or null if nothing is. */
export function groupCost(costs, sub, group) {
  if (!costs) return null;
  const prefix = `/subscriptions/${sub}/resourcegroups/${group}/`.toLowerCase();
  let total = null;
  for (const [id, cost] of Object.entries(costs.byId)) if (id.startsWith(prefix)) total = (total ?? 0) + cost;
  return total;
}

/** The day costs are kept for: read again when it changes. */
export const costDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
