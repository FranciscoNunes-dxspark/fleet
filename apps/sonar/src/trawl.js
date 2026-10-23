// Opening an Azure SQL database in Trawl, the sibling SQL client: the slash command T copies for
// Trawl's prompt, the SQL login an app already uses (found in its connection strings or settings, and
// named, never copied: Trawl reads the password from Azure itself), and the server firewall. Pure.

// Each key a SQL connection string may spell its parts with, lower-cased.
const KEYS = {
  server: ['server', 'data source', 'address', 'addr', 'network address'],
  database: ['database', 'initial catalog'],
  user: ['user id', 'uid', 'user', 'username'],
  password: ['password', 'pwd'],
  auth: ['authentication'],
};

/** "key=value;…" pairs, values maybe quoted ("…" or '…', the quote doubled inside), keys lower-cased. */
function pairs(text) {
  const out = {};
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    const eq = s.indexOf('=', i);
    if (eq < 0) break;
    const key = s.slice(i, eq).trim().toLowerCase();
    let j = eq + 1;
    while (s[j] === ' ') j++;
    let value = '';
    if (s[j] === '"' || s[j] === "'") {
      const q = s[j++];
      while (j < s.length) {
        if (s[j] === q && s[j + 1] === q) (value += q), (j += 2);
        else if (s[j] === q) break;
        else value += s[j++];
      }
      j = s.indexOf(';', j);
    } else {
      const end = s.indexOf(';', j);
      value = (end < 0 ? s.slice(j) : s.slice(j, end)).trim();
      j = end;
    }
    if (key) out[key] = value;
    if (j < 0) break;
    i = j + 1;
  }
  return out;
}

/**
 * A SQL Server connection string's parts: { host, port, database, user, password, auth }, the host
 * without "tcp:" and the port; null when it names no server (it isn't one).
 */
export function parseSqlConnectionString(text) {
  const p = pairs(text);
  const get = (k) => KEYS[k].map((n) => p[n]).find((v) => v != null && v !== '') ?? null;
  const server = get('server');
  if (!server) return null;
  const [host, port] = server.replace(/^tcp:/i, '').split(',').map((x) => x.trim());
  return { host: host.toLowerCase(), port: port ? Number(port) : null, database: get('database'), user: get('user'), password: get('password'), auth: get('auth') };
}

/** Whether a connection string's host is `server` (its address, or its short name). */
export function sameServer(host, server) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return h === server.fqdn.toLowerCase() || h === server.name.toLowerCase();
}

/** Signs in with Entra (Active Directory…), so needs no password. */
export const usesEntra = (parsed) => /active ?directory|entra/i.test(parsed.auth ?? '');

/**
 * The SQL login an app uses for `server` (and `database`, when one is given), from `sources`:
 * [{ target, setting, value }] (an app's or slot's connection strings and settings). A connection
 * string naming that database comes first, then one naming none; one with a user and password before
 * one signing in with Entra. Returns { target, setting, user, entra } (never the password), or null.
 */
export function findLogin(sources, server, database) {
  const db = database?.toLowerCase();
  const found = [];
  for (const src of sources) {
    const p = parseSqlConnectionString(src.value);
    if (!p || !sameServer(p.host, server)) continue;
    const pdb = p.database?.toLowerCase();
    if (db && pdb && pdb !== db) continue;
    const entra = usesEntra(p);
    if (!entra && !(p.user && p.password)) continue;
    found.push({ target: src.target, setting: src.setting, user: entra ? null : p.user, entra, rank: (db && pdb === db ? 0 : 2) + (entra ? 1 : 0) });
  }
  found.sort((a, b) => a.rank - b.rank);
  if (!found.length) return null;
  const { rank: _, ...best } = found[0];
  return best;
}

/** The name Trawl keeps the connection under: "<server>-<database>", or the server's alone. */
export const trawlName = (server, database) => (database ? `${server.name}-${database.name}` : server.name);

// An argument as Trawl's prompt reads it: in quotes only when it has a space (or a quote) in it.
const arg = (a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a));

/**
 * The slash command for Trawl's prompt that opens `database` on `server` (or the server alone):
 * `/azure-sql <fqdn> [<database>] --name <name> [--user <login> --password-from <rg>/<app>[/<slot>]
 * --subscription <id>] [--prod]`. `login` is findLogin's (a SQL login: Trawl reads its password from
 * that app through az); without one, Trawl signs in with Entra.
 */
export function trawlCommand({ server, database, login, subscription, prod }) {
  const parts = ['/azure-sql', server.fqdn];
  if (database) parts.push(database.name);
  parts.push('--name', trawlName(server, database));
  if (login && !login.entra) {
    const t = login.target;
    parts.push('--user', login.user, '--password-from', [t.resourceGroup, t.name, t.slot].filter(Boolean).join('/'), '--subscription', subscription);
  }
  if (prod) parts.push('--prod');
  return parts.map(arg).join(' ');
}

const ipNumber = (ip) => String(ip).split('.').reduce((n, part) => n * 256 + Number(part), 0);

/**
 * The firewall rule that lets `ip` in, or null. The "Allow Azure services" rule (0.0.0.0 to 0.0.0.0)
 * lets Azure's own services in, not a client, so it never counts.
 */
export function ruleCovering(ip, rules) {
  const n = ipNumber(ip);
  return rules.find((r) => !(r.start === '0.0.0.0' && r.end === '0.0.0.0') && ipNumber(r.start) <= n && n <= ipNumber(r.end)) ?? null;
}

/** The name of the rule Sonar adds for `ip`: sonar-198-51-100-7. */
export const ruleName = (ip) => `sonar-${ip.replace(/\./g, '-')}`;
