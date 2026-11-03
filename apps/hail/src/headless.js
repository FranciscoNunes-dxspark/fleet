// `hail test api.http [--env dev]`: every request in the file, top to bottom, without the UI, as
// /send all does it: the report goes to stdout, and the exit code says whether it all went well (0),
// something failed (1: a test, a handler, a request not sent or not answered), or it couldn't run (2).
// For CI. Nothing is kept in the history.
import { resolve } from 'node:path';
import { historyFile, readHistory } from './history.js';
import { DEFAULT_PORT, routesFor, startMock } from './mock.js';
import { azToken as azCli } from './azure.js';
import { loadConfig } from './config.js';
import { createJar } from './cookies.js';
import { defaultEnvironment } from './environments.js';
import { findHttpFiles, loadHttpFile } from './files.js';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseHttpFile } from './http-file.js';
import { checkContract, loadContract } from './contract.js';
import { exchange, inRun, reportLines, runFailed } from './runner.js';
import { prepare } from './send.js';
import { createTokens, fillAuthConfig, readAuthConfig, refreshName } from './oauth.js';
import { failingFindings, findingsText, parseFailOn, securityJson, toSarif } from '@fleet/kit/findings.js';
import { SCAN_CAP, authCandidates, runScan, sameHost, scanEstimate, scanUrl } from './scan.js';
import { productionFor } from './project.js';
import { VERSION } from './app.js';

export const TEST_USAGE = `hail test [file.http] [--env <name>] [--contract <openapi file or URL>] [--contract-strict]

Sends every request in the file, top to bottom, runs their response handlers
(> {% client.test(...) %}), prints a report, and exits with 1 if a test failed,
a handler broke, or a request wasn't sent or got no answer (2 if it couldn't run).

Responses are checked against the contract /contract set for the file in Hail
(or --contract's); drifting from it counts as failing only with --contract-strict.`;

/** `hail test`'s arguments: { file, env, help } or { problem }. */
export function testArgs(args) {
  const out = { file: null, env: null, help: false, contract: null, strict: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--env' || a === '-e') {
      out.env = args[++i] ?? null;
      if (!out.env) return { problem: '--env needs the name of an environment' };
    } else if (a.startsWith('--env=')) out.env = a.slice(6);
    else if (a === '--contract') {
      out.contract = args[++i] ?? null;
      if (!out.contract) return { problem: '--contract needs an OpenAPI file or URL' };
    } else if (a.startsWith('--contract=')) out.contract = a.slice(11);
    else if (a === '--contract-strict') out.strict = true;
    else if (a.startsWith('-')) return { problem: `${a} isn't an option of hail test` };
    else if (out.file) return { problem: `One file at a time: ${out.file} or ${a}?` };
    else out.file = a;
  }
  return out;
}

const ANSI = { add: 32, del: 31, dim: 2, warn: 33 };
const statusTone = (s) => (s < 300 ? 'add' : s < 400 ? null : s < 500 ? 'warn' : 'del');

/** The report's lines as text, coloured with ANSI codes when `color`. */
export function plainReport(lines, { color = false } = {}) {
  const paint = (seg) => {
    const tone = seg.status ? statusTone(seg.status) : seg.tone;
    const codes = [seg.bold ? 1 : null, ANSI[tone]].filter(Boolean);
    return color && codes.length ? `\x1b[${codes.join(';')}m${seg.text}\x1b[0m` : seg.text;
  };
  return lines.map((segs) => segs.map(paint).join('')).join('\n');
}

/**
 * Runs `args` (what follows `hail test`); `print` and `printError` take a line each. Resolves with the
 * exit code. `credentials` answers {{$secret}} (a missing one leaves the request unsent), `azToken`
 * {{$azToken}}, `fetch` is the network (tests stub nothing: they run a server).
 */
export async function runTests(args, { print = console.log, printError = console.error, credentials, azToken = azCli, config = loadConfig(), color = false, cwd = process.cwd() } = {}) {
  const a = testArgs(args);
  if (a.problem) {
    printError(`${a.problem}\n\n${TEST_USAGE}`);
    return 2;
  }
  if (a.help) {
    print(TEST_USAGE);
    return 0;
  }
  const path = a.file ? resolve(cwd, a.file) : findHttpFiles(cwd).map((f) => resolve(cwd, f))[0];
  if (!path) {
    printError('No .http file here: name one, hail test api.http');
    return 2;
  }
  let data;
  try {
    data = await loadHttpFile(path);
  } catch (e) {
    printError(`Couldn't read ${path}: ${e.message.split('\n')[0]}`);
    return 2;
  }
  const names = data.environments.names;
  if (a.env && !names.includes(a.env)) {
    printError(names.length ? `There's no environment called ${a.env}. There are: ${names.join(', ')}` : `There are no environments beside ${data.name} (http-client.env.json).`);
    return 2;
  }
  const env = a.env ?? defaultEnvironment(data, config.environments?.[data.path]);
  // The contract: --contract's, else the one /contract set for this file.
  const source = a.contract ?? config.contracts?.[data.path] ?? null;
  let contract = null;
  if (source) {
    try {
      contract = await loadContract(source, { dir: a.contract ? cwd : data.dir });
    } catch (e) {
      printError(`The contract: ${e.message}`);
      if (a.contract || a.strict) return 2;
    }
  }
  const sockets = data.requests.length - data.requests.filter(inRun).length;
  print(`${data.name}${env ? ` · ${env}` : ''} · ${data.requests.length} request${data.requests.length === 1 ? '' : 's'}${sockets ? ` (${sockets} WebSocket${sockets === 1 ? '' : 's'} left out)` : ''}${contract ? ` · contract ${source}` : ''}\n`);
  const secret = async (name) => {
    try {
      return (await credentials?.get(name)) ?? null;
    } catch {
      return null;
    }
  };
  // {{$auth.token("id")}}: Client Credentials and Password sign in here; the others need a refresh token
  // kept by a sign-in in Hail itself (in the same store), as there's no one to sign in.
  const tokens = createTokens({ credentials, onNote: printError });
  const auth = async (kind, id) => {
    const raw = data.environments.auth(env)[id];
    if (!raw) throw new Error(`There's no auth called ${id} in ${env ? `the ${env} environment` : 'the environments'}`);
    const filled = await fillAuthConfig(raw, { globals, environment: data.environments.vars(env), file: data.variables, responses, env: { azToken, secret } });
    if (filled.missing.length) throw new Error(`The auth ${id} uses ${filled.missing.map((m) => `{{${m}}}`).join(', ')}, which nothing gives a value`);
    return tokens.get({ key: id, store: refreshName(data.path, env, id), cfg: readAuthConfig(id, filled.raw), kind });
  };
  const responses = {};
  const jar = createJar();
  let globals = {};
  const results = [];
  let stopped = false;
  const requests = data.requests.filter(inRun);
  for (const request of requests) {
    const scope = { globals, environment: data.environments.vars(env), file: data.variables, responses, env: { azToken, secret, auth } };
    let req;
    try {
      req = await prepare(request, scope, { dir: data.dir });
    } catch (e) {
      results.push({ request, skipped: e.message });
      continue;
    }
    if (req.missing.length) {
      results.push({ request, skipped: `nothing gives ${req.missing.map((m) => `{{${m}}}`).join(', ')} a value` });
      continue;
    }
    try {
      const out = await exchange(req, { globals, jar, insecure: data.environments.options(env).insecure });
      globals = out.globals;
      if (request.name) responses[request.name] = out.response;
      const drift = contract ? checkContract(contract.spec, req, out.response) : undefined;
      results.push({ request, response: out.response, checks: out.checks, saved: out.saved, contract: drift });
    } catch (e) {
      results.push({ request, error: e.message });
      stopped = true;
      break;
    }
  }
  print(plainReport(reportLines(results, { left: requests.slice(results.length), stopped, strict: a.strict }), { color }));
  return runFailed(results, { strict: a.strict }) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------
// `hail mock api.http [--port 4010] [--env dev]`: the file's kept responses served on this machine, as
// /mock does inside Hail, until it's stopped (ctrl+c). Something Bosun can run as a process.

export const MOCK_USAGE = `hail mock [file.http] [--port <port>] [--env <name>]

Serves the latest response kept in Hail's history for each request in the file,
at its method and path ({{variables}} in a path match any segment), on
http://127.0.0.1:<port> (${DEFAULT_PORT} unless given); where the file has none, the examples
of the contract /contract set for it. Anything else gets a 404 listing what's
served. The history is read again as it changes. ctrl+c stops it.`;

/** `hail mock`'s arguments: { file, env, port, help } or { problem }. */
export function mockArgs(args) {
  const out = { file: null, env: null, port: DEFAULT_PORT, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--env' || a === '-e') {
      out.env = args[++i] ?? null;
      if (!out.env) return { problem: '--env needs the name of an environment' };
    } else if (a.startsWith('--env=')) out.env = a.slice(6);
    else if (a === '--port' || a === '-p' || a.startsWith('--port=')) {
      const v = a.startsWith('--port=') ? a.slice(7) : args[++i];
      if (!/^\d+$/.test(v ?? '') || Number(v) > 65535) return { problem: '--port needs a port number' };
      out.port = Number(v);
    } else if (a.startsWith('-')) return { problem: `${a} isn't an option of hail mock` };
    else if (out.file) return { problem: `One file at a time: ${out.file} or ${a}?` };
    else out.file = a;
  }
  return out;
}

/** Something read again only when its file's modified time or size changes. */
function whenChanged(path, read) {
  let at = null;
  let value;
  return () => {
    let m = '';
    try {
      const st = statSync(path);
      m = `${st.mtimeMs}:${st.size}`;
    } catch {}
    if (m !== at) {
      at = m;
      value = read();
    }
    return value;
  };
}

/**
 * Runs `args` (what follows `hail mock`). Resolves with { code } when it can't start (or for --help), else
 * with the running mock: { code: null, port, close() }. Each hit is printed.
 */
export async function runMock(args, { print = console.log, printError = console.error, config = loadConfig(), cwd = process.cwd(), onStart } = {}) {
  const a = mockArgs(args);
  if (a.problem) {
    printError(`${a.problem}\n\n${MOCK_USAGE}`);
    return { code: 2 };
  }
  if (a.help) {
    print(MOCK_USAGE);
    return { code: 0 };
  }
  const path = a.file ? resolve(cwd, a.file) : findHttpFiles(cwd).map((f) => resolve(cwd, f))[0];
  if (!path) {
    printError('No .http file here: name one, hail mock api.http');
    return { code: 2 };
  }
  let data;
  try {
    data = await loadHttpFile(path);
  } catch (e) {
    printError(`Couldn't read ${path}: ${e.message.split('\n')[0]}`);
    return { code: 2 };
  }
  const names = data.environments.names;
  if (a.env && !names.includes(a.env)) {
    printError(names.length ? `There's no environment called ${a.env}. There are: ${names.join(', ')}` : `There are no environments beside ${data.name} (http-client.env.json).`);
    return { code: 2 };
  }
  const env = a.env ?? defaultEnvironment(data, config.environments?.[data.path]);
  let spec = null;
  const source = config.contracts?.[data.path];
  if (source) {
    try {
      spec = (await loadContract(source, { dir: data.dir })).spec;
    } catch (e) {
      printError(`The contract (left out): ${e.message}`);
    }
  }
  const file = whenChanged(path, () => {
    try {
      return { ...data, ...parseHttpFile(readFileSync(path, 'utf8')) };
    } catch {
      return data;
    }
  });
  const history = whenChanged(historyFile(data.path), () => readHistory(historyFile(data.path)));
  const routes = () => {
    const d = file();
    return routesFor({ requests: d.requests, entries: history(), vars: { ...d.variables, ...data.environments.vars(env) }, spec });
  };
  let mock;
  try {
    mock = await startMock({ port: a.port, routes, onHit: (h) => print(`${h.method} ${h.path} → ${h.status}${h.label ? `  ${h.label}` : ''}`) });
  } catch (e) {
    printError(`Couldn't start the mock: ${e.message}`);
    return { code: 2 };
  }
  const list = routes();
  print(`Mock of ${data.name}${env ? ` · ${env}` : ''} on http://127.0.0.1:${mock.port} · ${list.length} route${list.length === 1 ? '' : 's'}${list.length ? '' : ' (send the requests in Hail first: their responses are kept)'}`);
  for (const r of list) print(`  ${r.method.padEnd(6)} ${r.template}  ${r.label}${r.source === 'contract' ? ' (contract)' : ''}`);
  onStart?.(mock);
  return { code: null, ...mock };
}

// ---------------------------------------------------------------------------------------------------
// `hail security <url|file.http> [--env dev] [--json] [--sarif [file]] [--fail-on high]`: /scan without
// the UI, for CI: a web app you own (or may test) looked at from the outside, the findings printed as
// text, the family's JSON or SARIF, and the exit code 1 when any is as bad as --fail-on (2: it couldn't run).

export const SECURITY_USAGE = `hail security <url | file.http> [--env <name>] [--json] [--sarif [file]] [--fail-on <level>] [--production]

Scans a web app you own or are authorised to test, as /scan does in Hail: TLS and
its certificate, security headers, cookies' flags, CORS, files that shouldn't be
served (.git, .env, backups…), TRACE, verbose errors, and, given a .http file, its
GET requests that carry credentials sent again without them. Only GET, HEAD,
OPTIONS and one TRACE are sent, about ${scanEstimate()} requests (at most ${SCAN_CAP}).

Given a .http file, the target is the origin of its first request in the
environment (--env, else the one Hail last used for the file).

--json        the findings as JSON (the family's shape, as Fleet reads it)
--sarif [f]   SARIF 2.1.0 for code scanning, to the file f (a .sarif or .json) or stdout
--fail-on     critical, high (the default), medium, low or none: exit 1 at that or worse
--production  scan even though the project (.fleet/project.json) calls the environment production`;

/** `hail security`'s arguments: { target, env, json, sarif, sarifFile, failOn, production, help } or { problem }. */
export function securityArgs(args) {
  const out = { target: null, env: null, json: false, sarif: false, sarifFile: null, failOn: 'high', production: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--env' || a === '-e') {
      out.env = args[++i] ?? null;
      if (!out.env) return { problem: '--env needs the name of an environment' };
    } else if (a.startsWith('--env=')) out.env = a.slice(6);
    else if (a === '--json') out.json = true;
    else if (a === '--sarif') {
      out.sarif = true;
      if (/\.(sarif|json)$/i.test(args[i + 1] ?? '')) out.sarifFile = args[++i];
    } else if (a.startsWith('--sarif=')) {
      out.sarif = true;
      out.sarifFile = a.slice(8) || null;
    } else if (a === '--fail-on' || a.startsWith('--fail-on=')) {
      const v = a.startsWith('--fail-on=') ? a.slice(10) : args[++i];
      out.failOn = parseFailOn(v);
      if (!out.failOn) return { problem: '--fail-on takes critical, high, medium, low or none' };
    } else if (a === '--production') out.production = true;
    else if (a.startsWith('-')) return { problem: `${a} isn't an option of hail security` };
    else if (out.target) return { problem: `One target at a time: ${out.target} or ${a}?` };
    else out.target = a;
  }
  if (out.json && out.sarif && !out.sarifFile) return { problem: '--json and --sarif both want stdout: give --sarif a file (results.sarif)' };
  return out;
}

/**
 * Runs `args` (what follows `hail security`). Resolves with the exit code. `scan` is runScan (tests
 * leave it: they run servers); `write` saves the SARIF file.
 */
export async function runSecurity(args, { print = console.log, printError = console.error, credentials, azToken = azCli, config = loadConfig(), cwd = process.cwd(), scan = runScan, write = (p, text) => writeFileSync(p, text), now = new Date() } = {}) {
  const a = securityArgs(args);
  if (a.problem) {
    printError(`${a.problem}\n\n${SECURITY_USAGE}`);
    return 2;
  }
  if (a.help) {
    print(SECURITY_USAGE);
    return 0;
  }
  if (!a.target) {
    printError(`Name what to scan: a URL, or a .http file.\n\n${SECURITY_USAGE}`);
    return 2;
  }
  let target = null;
  const auth = [];
  let env = null;
  let insecure = false;
  let dir = cwd;
  const asFile = resolve(cwd, a.target);
  if (/\.(http|rest)$/i.test(a.target) || (!/^[a-z][\w+.-]*:\/\//i.test(a.target) && existsSync(asFile))) {
    let data;
    try {
      data = await loadHttpFile(asFile);
    } catch (e) {
      printError(`Couldn't read ${asFile}: ${e.message.split('\n')[0]}`);
      return 2;
    }
    dir = data.dir;
    const names = data.environments.names;
    if (a.env && !names.includes(a.env)) {
      printError(names.length ? `There's no environment called ${a.env}. There are: ${names.join(', ')}` : `There are no environments beside ${data.name} (http-client.env.json).`);
      return 2;
    }
    env = a.env ?? defaultEnvironment(data, config.environments?.[data.path]);
    insecure = Boolean(data.environments.options(env).insecure);
    const secret = async (name) => {
      try {
        return (await credentials?.get(name)) ?? null;
      } catch {
        return null;
      }
    };
    const scope = { globals: {}, environment: data.environments.vars(env), file: data.variables, responses: {}, env: { azToken, secret } };
    const fillIn = async (request) => {
      try {
        const req = await prepare(request, scope, { dir: data.dir });
        return req.missing.length ? null : req;
      } catch {
        return null;
      }
    };
    const first = data.requests.find(inRun);
    const firstReq = first ? await fillIn(first) : null;
    target = firstReq ? scanUrl(`${originOf(firstReq.url)}/`) : null;
    if (!target) {
      printError(first ? `${first.label}'s URL couldn't be filled in${env ? ` in ${env}` : ''}: name the URL to scan instead.` : `${data.name} has no requests to take the target from: name the URL to scan instead.`);
      return 2;
    }
    // Only the ones that only read: there's no one here to ask about the others.
    for (const c of authCandidates(data.requests).filter((x) => x.safe)) {
      const req = await fillIn(c.request);
      if (req && sameHost(req.url, target)) auth.push({ label: c.request.label, req });
    }
  } else {
    target = scanUrl(a.target);
    if (!target) {
      printError(`${a.target} isn't an http(s) URL or a .http file.`);
      return 2;
    }
  }
  const prod = env ? productionFor(dir, env) : null;
  if (prod && !a.production) {
    printError(`${prod.name} is production (.fleet/project.json): the scan sends a TRACE too. Add --production to scan it anyway.`);
    return 2;
  }
  // Said on stderr, so --json and --sarif keep stdout to themselves.
  printError(`Scanning ${target}${env ? ` (${env})` : ''}: about ${scanEstimate({ auth: auth.length })} requests${auth.length ? `, ${auth.length} of the file's sent again without credentials` : ''}. Only for an app you own or may test.`);
  let result;
  try {
    result = await scan({ target, auth, insecure });
  } catch (e) {
    printError(`The scan failed: ${e.message.split('\n')[0]}`);
    return 2;
  }
  if (result.error) {
    printError(result.error);
    return 2;
  }
  const findings = result.findings;
  if (a.sarif) {
    const sarif = JSON.stringify(toSarif({ tool: 'Hail', version: VERSION, uri: 'https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/hail', findings }), null, 2);
    if (a.sarifFile) {
      try {
        write(resolve(cwd, a.sarifFile), `${sarif}\n`);
      } catch (e) {
        printError(`Couldn't write ${a.sarifFile}: ${e.message}`);
        return 2;
      }
    } else print(sarif);
  }
  const tls = result.tls && !result.tls.error ? { protocol: result.tls.protocol, validTo: result.tls.validTo, issuer: result.tls.issuer } : undefined;
  if (a.json) print(JSON.stringify(securityJson({ app: 'hail', check: 'web', target, findings, now, extra: { environment: env, sent: result.sent, capped: result.capped, notes: result.notes, ...(tls ? { tls } : {}) } }), null, 2));
  else if (!a.sarif || a.sarifFile) {
    print(findingsText(findings, { failOn: a.failOn, header: `Security scan of ${target}${env ? ` · ${env}` : ''} · ${result.sent} requests\n` }).trimEnd());
    for (const n of result.notes) print(n);
  }
  return failingFindings(findings, a.failOn).length ? 1 : 0;
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
