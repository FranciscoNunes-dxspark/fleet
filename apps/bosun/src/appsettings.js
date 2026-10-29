// A .NET Framework site's settings from Bosun's env (bosun.json's "env" and its env files): ASP.NET
// reads ConfigurationManager.AppSettings, never the environment, but its web.config's
// `<appSettings file="…">` names a file whose entries override the web.config's own. Bosun writes
// that file from the process's settings before each start and restart, so profiles and .env files
// reach the site. It writes only a file that isn't there or that it wrote itself (it says so in its
// first line): one of yours is left alone. Pure apart from `writeAppSettings`, which takes its reads
// and writes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MARK = '<!-- Written by Bosun from bosun.json\'s "env" and env files; it rewrites it on each start. -->';

/** The file a web.config's `<appSettings file="…">` names, or null. */
export function appSettingsFile(xml) {
  const tag = /<appSettings\b([^>]*)>/i.exec(String(xml ?? ''))?.[1];
  return tag ? (/\bfile\s*=\s*"([^"]+)"/i.exec(tag)?.[1] ?? null) : null;
}

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '&#xA;');

/** The file's text for `settings` ({ key: value }), in key order. */
export function appSettingsXml(settings) {
  const keys = Object.keys(settings).sort();
  return `<?xml version="1.0" encoding="utf-8"?>\n${MARK}\n<appSettings>\n${keys.map((k) => `  <add key="${escape(k)}" value="${escape(settings[k])}" />\n`).join('')}</appSettings>\n`;
}

/**
 * Writes the appSettings file the web.config in `folder` names, from `settings`. Resolves to null
 * when there's nothing to do (no web.config, or it names no file, or no settings and no file of
 * Bosun's to empty), else { file, written: true, changed, count } or { file, written: false, reason }.
 */
export function writeAppSettings(folder, settings, { read = (f) => readFileSync(f, 'utf8'), write = (f, t) => writeFileSync(f, t), exists = existsSync } = {}) {
  let config;
  try {
    config = read(join(folder, 'web.config'));
  } catch {
    return null;
  }
  const name = appSettingsFile(config);
  if (!name) return null;
  const file = resolve(folder, name.replace(/\\/g, '/'));
  const there = exists(file);
  let ours = !there;
  if (there) {
    try {
      ours = read(file).includes(MARK);
    } catch {
      ours = false;
    }
  }
  const count = Object.keys(settings).length;
  // Nothing to give it, and nothing of Bosun's to empty.
  if (!count && (!there || !ours)) return null;
  if (!ours) return { file: name, written: false, reason: `${name} is there and isn't Bosun's: it's left as it is` };
  const text = appSettingsXml(settings);
  let changed = false;
  try {
    changed = !there || read(file) !== text;
    if (changed) write(file, text);
  } catch (e) {
    return { file: name, written: false, reason: `couldn't write ${name}: ${e.message}` };
  }
  return { file: name, written: true, changed, count };
}

/** What the log says about it. */
export const appSettingsNote = (r) => (r.written ? `── ${r.count} setting${r.count === 1 ? '' : 's'} written to ${r.file} (the web.config's appSettings file)` : `── appSettings: ${r.reason}`);
