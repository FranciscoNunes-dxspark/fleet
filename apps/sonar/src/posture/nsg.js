// What a network security group lets in from the internet, judged as Azure does: its inbound rules
// in priority order (lowest number first), the first that matches deciding, then the default rules,
// whose last denies everything from outside the virtual network. Pure: an NSG as ARM (and Resource
// Graph, and a Bicep what-if) gives it, { id, name, properties: { securityRules, defaultSecurityRules } }.

// The ports reaching which from anywhere is a finding of its own.
export const ADMIN_PORTS = { 22: 'SSH', 3389: 'RDP' };
export const DATABASE_PORTS = { 1433: 'SQL Server', 3306: 'MySQL', 5432: 'PostgreSQL', 6379: 'Redis', 27017: 'MongoDB' };
// Ports tried to tell whether a rule with a wide range is what decides for some port.
const PROBES = [...Object.keys(ADMIN_PORTS), ...Object.keys(DATABASE_PORTS), 21, 23, 80, 443, 445, 5985, 5986, 8080, 8443, 9200].map(Number);

// What a source of "anywhere" is written as.
const ANYWHERE = new Set(['*', 'internet', '0.0.0.0/0', '0.0.0.0', 'any', '::/0']);

const lower = (s) => String(s ?? '').trim().toLowerCase();
const props = (r) => r?.properties ?? r ?? {};
const list = (one, many) => [...(Array.isArray(many) ? many : []), ...(one != null && one !== '' ? [one] : [])].map(String);

/** A rule's sources, as written (sourceAddressPrefix and sourceAddressPrefixes together). */
export const sourcesOf = (rule) => list(props(rule).sourceAddressPrefix, props(rule).sourceAddressPrefixes);

/** Whether a rule's source is anywhere on the internet: *, Internet, 0.0.0.0/0. */
export const fromAnywhere = (rule) => sourcesOf(rule).some((s) => ANYWHERE.has(lower(s)));

/** A rule's destination ports as [from, to] ranges; '*' is [0, 65535]. */
export function portRanges(rule) {
  const p = props(rule);
  return list(p.destinationPortRange, p.destinationPortRanges).flatMap((r) => {
    const s = r.trim();
    if (s === '*' || lower(s) === 'any') return [[0, 65535]];
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(s);
    return m ? [[Number(m[1]), Number(m[2] ?? m[1])]] : [];
  });
}

/** Whether the rule's ports take in `port`. */
export const coversPort = (rule, port) => portRanges(rule).some(([a, b]) => port >= a && port <= b);

/** Whether the rule's ports are every port. */
export const everyPort = (rule) => portRanges(rule).some(([a, b]) => a <= 0 && b >= 65535);

const inbound = (r) => lower(props(r).direction || 'inbound') === 'inbound';
// TCP is what every port named here is reached over; a UDP or ICMP rule decides nothing for it.
const tcp = (r) => ['*', 'tcp', 'any', ''].includes(lower(props(r).protocol));

/** The NSG's inbound rules, its own then the defaults, in the order Azure tries them. */
export function inboundRules(nsg) {
  const p = props(nsg);
  const own = (p.securityRules ?? []).filter(inbound).sort((a, b) => Number(props(a).priority ?? 65000) - Number(props(b).priority ?? 65000));
  // When the defaults aren't given (a template, say), Azure's last one is there all the same.
  const defaults = p.defaultSecurityRules?.length ? p.defaultSecurityRules.filter(inbound) : [{ name: 'DenyAllInBound', properties: { access: 'Deny', direction: 'Inbound', protocol: '*', sourceAddressPrefix: '*', destinationPortRange: '*', priority: 65500 } }];
  return [...own, ...defaults];
}

/**
 * The rule that decides whether TCP `port` is reached from the internet through this NSG: the first
 * inbound rule whose source takes in the internet and whose ports take in `port`. A rule from a
 * narrower source (an office's range, VirtualNetwork) doesn't match traffic from just anywhere.
 */
export function decidingRule(nsg, port) {
  return inboundRules(nsg).find((r) => tcp(r) && coversPort(r, port) && fromAnywhere(r)) ?? null;
}

/** Whether TCP `port` is let in from anywhere by this NSG. */
export const allowsFromAnywhere = (nsg, port) => lower(props(decidingRule(nsg, port)).access) === 'allow';

/**
 * The NSG's own Allow rules that let the internet in, each with the ports it decides for:
 * [{ rule, admin: [22…], database: [1433…], every }]. `every` is a rule on every port that decides
 * for at least one of them (the rest may be shadowed by a deny above it).
 */
export function openRules(nsg) {
  const out = [];
  for (const rule of props(nsg).securityRules ?? []) {
    const p = props(rule);
    if (!inbound(rule) || lower(p.access) !== 'allow' || !tcp(rule) || !fromAnywhere(rule)) continue;
    const decides = (port) => decidingRule(nsg, port) === rule;
    const admin = Object.keys(ADMIN_PORTS).map(Number).filter(decides);
    const database = Object.keys(DATABASE_PORTS).map(Number).filter(decides);
    const every = everyPort(rule) && PROBES.some(decides);
    if (admin.length || database.length || every) out.push({ rule, admin, database, every });
  }
  return out;
}
