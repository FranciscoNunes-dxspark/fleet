// A second demo organization, for trying several organizations without a real
// Azure DevOps: the demo data under other names ("fabrikam-demo" with projects
// Retail, Logistics and Field), with its own project and repo ids. Work item
// and build numbers are the same as the first demo organization on purpose,
// so the multi-organization code has to keep #4107 here apart from #4107 there.
import { createMockProvider } from './provider.js';

const RENAMES = [
  // The organization address only: people keep their email, as the same person does across real organizations.
  ['dev.azure.com/contoso-demo', 'dev.azure.com/fabrikam-demo'],
  ['p-commerce', 'f-commerce'], ['p-platform', 'f-platform'], ['p-mobile', 'f-mobile'],
  ['Commerce', 'Retail'], ['Platform', 'Logistics'], ['Mobile', 'Field'],
];
const REPOS = ['storefront-web', 'checkout-api', 'payments-service', 'catalog-service', 'identity-service', 'api-gateway', 'infra-terraform', 'shared-libs', 'mobile-app', 'notifications-service'];
const OUT = [...RENAMES, ...REPOS.map((r) => [`r-${r}`, `rf-${r}`])];
// Reverse order on the way in, so "rf-x" becomes "r-x" before anything else touches it.
const IN = OUT.map(([a, b]) => [b, a]).reverse();

const swap = (pairs) => {
  const fix = (v) => {
    if (typeof v === 'string') return pairs.reduce((s, [a, b]) => (s.includes(a) ? s.split(a).join(b) : s), v);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [fix(k), fix(x)]));
    }
    return v;
  };
  return fix;
};
const toVariant = swap(OUT);
const toBase = swap(IN);

export function createMockVariant() {
  const base = createMockProvider();
  const out = {};
  for (const [name, value] of Object.entries(base)) {
    out[name] = typeof value === 'function'
      ? (...args) => Promise.resolve(value(...toBase(args))).then(toVariant)
      : toVariant(value);
  }
  return out;
}
