// The project's own configuration, read from the folder Locker started in: .env files, appsettings*.json
// (flattened to Section:Key, as .NET reads them), .NET user secrets (secrets.json under the profile, for
// a .csproj with a UserSecretsId) and Hail's http-client env files, one source per environment. The
// parsers are pure; createLocal reads and writes the files, and demo.js's demoLocal has the same interface.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

/**
 * A .env file's settings, in order: [{ key, value, line }] (line counted from 1). `export`, quotes
 * ('…' as they are, "…" with \n \" \\ read), comments after an unquoted value, and blank and comment
 * lines are handled as dotenv does; a "…" value may run over several lines.
 */
export function parseDotenv(text) {
  const out = [];
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const at = i + 1;
    let rest = m[2];
    let value;
    if (rest.startsWith('"')) {
      // Up to the closing quote, which may be lines further down.
      let body = rest.slice(1);
      while (!/(^|[^\\])(\\\\)*"/.test(body) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      const end = /^((?:[^"\\]|\\.)*)"/s.exec(body);
      value = (end ? end[1] : body).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = end > 0 ? rest.slice(1, end) : rest.slice(1);
    } else if (rest.startsWith('`')) {
      const end = rest.indexOf('`', 1);
      value = end > 0 ? rest.slice(1, end) : rest.slice(1);
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    out.push({ key: m[1], value, line: at });
  }
  return out;
}

/** A value as a .env line writes it: bare when it can be, else in double quotes with \n, " and \ escaped. */
export function dotenvValue(value) {
  const s = String(value ?? '');
  if (/^[\w@%+=:,./~?&-]*$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/** `text` (a .env file) with `KEY=value` added at the end, on a line of its own. */
export function addToDotenv(text, key, value) {
  const s = String(text ?? '');
  const sep = s && !s.endsWith('\n') ? (s.includes('\r\n') ? '\r\n' : '\n') : '';
  const nl = s.includes('\r\n') ? '\r\n' : '\n';
  return `${s}${sep}${key}=${dotenvValue(value)}${nl}`;
}

/** A configuration key as a .env file names it: .NET's sections joined with __ (Db:Password → Db__Password). */
export const envKey = (key) => String(key).replace(/:/g, '__');

/**
 * A JSON document's settings as .NET's configuration reads them: [{ key, value }], nested objects
 * joined with ":" (ConnectionStrings:Default), arrays by index (Hosts:0), every value as text; null
 * is an empty value.
 */
export function flatten(obj, prefix = '') {
  const out = [];
  const walk = (v, key) => {
    if (v && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
      if (!entries.length && key) out.push({ key, value: '' });
      for (const [k, x] of entries) walk(x, key ? `${key}:${k}` : k);
    } else if (key) out.push({ key, value: v == null ? '' : String(v) });
  };
  walk(obj, prefix);
  return out;
}

/** A .csproj's UserSecretsId, or null. */
export const userSecretsId = (csproj) => /<UserSecretsId>\s*([^<\s]+)\s*<\/UserSecretsId>/i.exec(String(csproj ?? ''))?.[1] ?? null;

/** Where .NET keeps the user secrets of `id`: %APPDATA%\Microsoft\UserSecrets on Windows, ~/.microsoft/usersecrets elsewhere. */
export function userSecretsPath(id, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Microsoft', 'UserSecrets', id, 'secrets.json');
  return join(home, '.microsoft', 'usersecrets', id, 'secrets.json');
}

const read = (p) => {
  try {
    return readFileSync(p, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
};

const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
// A .env file that only says which keys a project expects: its values are placeholders, never compared.
export const isExample = (name) => /\.(example|sample|template|dist)$/i.test(String(name ?? ''));
const APPSETTINGS = /^appsettings(\.[\w-]+)?\.json$/i;
const HTTP_ENV = ['http-client.env.json', 'http-client.private.env.json'];

/** The .csproj files in `dir` and the folders right under it (src/Api/Api.csproj), skipping dependencies and dot folders. */
function projectFiles(dir) {
  const out = [];
  const look = (d, deeper) => {
    let names = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.isFile() && /\.csproj$/i.test(e.name)) out.push(join(d, e.name));
      else if (deeper && e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'bin', 'obj', 'dist'].includes(e.name)) look(join(d, e.name), deeper - 1);
    }
  };
  look(dir, 2);
  return out;
}

/**
 * Every source of settings in `dir`, each { id, kind, label, file, entries: [{ key, value, line? }], writable }:
 * kind 'env' (.env files; writable, so a key can be added), 'appsettings', 'usersecrets' or 'http'
 * (one per environment of Hail's env files, keys as they are there). .env.example and its kind are
 * sources too (`example`, not writable): they say which keys a project expects, and their values, only
 * examples, are never compared.
 */
export function readLocal(dir, opts = {}) {
  const root = resolve(dir);
  const sources = [];
  let names = [];
  try {
    names = readdirSync(root).sort();
  } catch {}
  for (const f of names.filter((n) => ENV_FILE.test(n))) {
    const text = read(join(root, f));
    if (text != null) sources.push({ id: `env:${f}`, kind: 'env', label: f, file: join(root, f), entries: parseDotenv(text), writable: !isExample(f), ...(isExample(f) ? { example: true } : {}) });
  }
  // appsettings.json first, then each environment's.
  const appsettings = names.filter((n) => APPSETTINGS.test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const f of appsettings) {
    try {
      sources.push({ id: `json:${f}`, kind: 'appsettings', label: f, file: join(root, f), entries: flatten(JSON.parse(read(join(root, f)) ?? 'null')), writable: false });
    } catch (e) {
      sources.push({ id: `json:${f}`, kind: 'appsettings', label: f, file: join(root, f), entries: [], writable: false, problem: `not JSON: ${e.message.split('\n')[0]}` });
    }
  }
  for (const csproj of projectFiles(root)) {
    const id = userSecretsId(read(csproj));
    if (!id) continue;
    const file = userSecretsPath(id, opts);
    const label = `user secrets (${basename(csproj, '.csproj')})`;
    if (!existsSync(file)) {
      sources.push({ id: `secrets:${id}`, kind: 'usersecrets', label, file, entries: [], writable: false, problem: 'none set yet (dotnet user-secrets set …)' });
      continue;
    }
    try {
      sources.push({ id: `secrets:${id}`, kind: 'usersecrets', label, file, entries: flatten(JSON.parse(read(file) ?? 'null')), writable: false, project: relative(root, csproj).replace(/\\/g, '/') });
    } catch (e) {
      sources.push({ id: `secrets:${id}`, kind: 'usersecrets', label, file, entries: [], writable: false, problem: `not JSON: ${e.message.split('\n')[0]}` });
    }
  }
  for (const f of HTTP_ENV.filter((n) => names.includes(n))) {
    let envs = {};
    try {
      envs = JSON.parse(read(join(root, f)) ?? 'null') ?? {};
    } catch {
      continue;
    }
    for (const [env, vars] of Object.entries(envs)) {
      if (!vars || typeof vars !== 'object' || Array.isArray(vars)) continue;
      const entries = Object.entries(vars)
        .filter(([, v]) => v == null || typeof v !== 'object')
        .map(([key, v]) => ({ key, value: v == null ? '' : String(v) }));
      sources.push({ id: `http:${f}:${env}`, kind: 'http', label: `${f.replace(/\.env\.json$/, '')}:${env}`, file: join(root, f), entries, writable: false });
    }
  }
  return sources;
}

/** The local side of the provider: the sources in `dir`, read afresh each time, and adding a key to a .env file. */
export function createLocal({ dir = process.cwd(), ...opts } = {}) {
  const root = resolve(dir);
  return {
    kind: 'local',
    dir: root,
    sources: async () => readLocal(root, opts),
    /** Adds `key=value` to the .env file `file` (a name in the folder), creating it when it isn't there. */
    async addToEnv(file, key, value) {
      const name = basename(file);
      if (!ENV_FILE.test(name)) throw new Error(`${name} isn't a .env file.`);
      const path = join(root, name);
      writeFileSync(path, addToDotenv(read(path) ?? '', key, value));
    },
  };
}
