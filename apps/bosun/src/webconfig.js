// The databases a .NET Framework project's web.config (or app.config) names in <connectionStrings>,
// as the family's projectAt names those of appsettings*.json and .env files: for pre-flight's
// database check and /family's lines for Trawl. Pure apart from reading the files.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { databaseOf } from '@fleet/kit/family.js';

const unescape = (s) => String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A config file's <connectionStrings> entries: [{ name, connectionString, provider }]. */
export function connectionStrings(xml) {
  const section = /<connectionStrings\b[^>]*>([\s\S]*?)<\/connectionStrings>/i.exec(String(xml ?? ''))?.[1] ?? '';
  const out = [];
  for (const [, attrs] of section.matchAll(/<add\b([^>]*?)\/?>/gi)) {
    const attr = (name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
      return m ? unescape(m[1] ?? m[2]) : null;
    };
    const name = attr('name');
    const connectionString = attr('connectionString');
    if (name && connectionString) out.push({ name, connectionString, provider: attr('providerName') });
  }
  return out;
}

/** The connection string itself, out of an Entity Framework one (metadata=…;provider connection string="…"). */
export const innerConnection = (s) => /provider connection string\s*=\s*"([^"]*)"/i.exec(s)?.[1] ?? s;

/**
 * The databases the web.config and app.config files in `folders` (from `dir`, each once) name: [{ name,
 * source, ...databaseOf }], the source the file from `dir`. An Entity Framework string's inner one is read.
 */
export function webConfigDatabases(dir, folders = ['.'], { read = (f) => readFileSync(f, 'utf8') } = {}) {
  const out = [];
  const seen = new Set();
  for (const folder of folders) {
    for (const file of ['web.config', 'Web.config', 'app.config', 'App.config']) {
      const path = resolve(dir, folder, file);
      // Web.config and web.config are one file on Windows, two names to try elsewhere.
      if (seen.has(path.toLowerCase())) continue;
      let xml;
      try {
        xml = read(path);
      } catch {
        continue;
      }
      seen.add(path.toLowerCase());
      const source = relative(dir, path).replace(/\\/g, '/') || file;
      for (const c of connectionStrings(xml)) {
        const db = databaseOf(innerConnection(c.connectionString));
        if (db) out.push({ name: c.name, source, ...db });
      }
    }
  }
  return out;
}

/** The folders a crew's web.configs are in: the project's, each process's own. */
export const crewFolders = (crew) => ['.', ...new Set((crew?.procs ?? []).map((p) => p.cwd ?? '.'))];
