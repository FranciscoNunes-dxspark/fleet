// Following log files into a process's log (bosun.json's "logs", and an IIS site's own): each pattern
// is a file, or a folder and a glob for the file's name (`logs/stdout_*.log`), whose newest file is
// followed. A file there when following starts is read from its end; one that appears later (a new
// day's, a new process's) from its start. A W3C request log (IIS's) becomes structured lines.
// Polls, as fs.watch hears another process's appends late or not at all on Windows.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { globRegex } from './watch.js';
import { expandEnv, w3cFields, w3cJson } from './iis.js';

const GLOB = /[*?[{]/;
// The most read from one file at a look, so a huge log found late doesn't stall Bosun.
const MOST = 1024 * 1024;

/** A pattern as { dir, file } (a plain path) or { dir, match } (a glob for the name), %VAR% and ${VAR} put in. */
export function logPattern(pattern, { cwd = '.', env = process.env } = {}) {
  const expanded = expandEnv(pattern, env).replace(/\$\{(\w+)\}/g, (m, name) => env[name] ?? m);
  const abs = resolve(cwd, expanded);
  const name = basename(abs);
  if (!GLOB.test(name)) return { dir: dirname(abs), file: name, match: null };
  const re = globRegex(name);
  return { dir: dirname(abs), file: null, match: new RegExp(re.source, process.platform === 'win32' ? 'i' : '') };
}

/** The newest of `entries` ([{ name, mtime }]) whose name `match` takes (the last name first on a tie), or null. */
export function newest(entries, match) {
  let best = null;
  for (const e of entries) if (match.test(e.name) && (!best || e.mtime > best.mtime || (e.mtime === best.mtime && e.name > best.name))) best = e;
  return best?.name ?? null;
}

/** `rest` and `chunk` as complete lines and what's left of the last one. */
export function cutLines(rest, chunk) {
  const lines = `${rest}${chunk}`.split(/\r?\n/);
  return { lines: lines.slice(0, -1), rest: lines.at(-1) };
}

/**
 * Follows `patterns` from `cwd`, calling `onLine(text, file)` for each new line, every `every` ms;
 * `fs` is injectable. Returns { close, files } (files: what each pattern follows now).
 */
export function tailLogs(patterns, { cwd = '.', env = process.env, onLine, every = 1000, fs = { readdirSync, statSync, openSync, readSync, closeSync } } = {}) {
  const followed = patterns.map((p) => ({ ...logPattern(p, { cwd, env }), path: null, offset: 0, rest: '', fields: null, decoder: null }));
  const size = (path) => {
    try {
      return fs.statSync(path).size;
    } catch {
      return null;
    }
  };
  const pick = (f) => {
    if (f.file) return join(f.dir, f.file);
    try {
      const entries = fs.readdirSync(f.dir).map((name) => {
        try {
          return { name, mtime: fs.statSync(join(f.dir, name)).mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      });
      const name = newest(entries, f.match);
      return name ? join(f.dir, name) : null;
    } catch {
      return null;
    }
  };
  const line = (f, text) => {
    const t = text.replace(/^﻿/, '');
    const fields = w3cFields(t);
    if (fields) return void (f.fields = fields);
    // A W3C log's other directives (#Software, #Version, #Date), at its top and after each restart.
    if (/^#(Software|Version|Date|Remark|Start-Date|End-Date):/i.test(t)) return;
    if (!t.trim()) return;
    onLine(f.fields ? (w3cJson(f.fields, t) ?? t) : t, f.path);
  };
  const look = (f, first) => {
    const path = pick(f);
    if (!path) return;
    if (path !== f.path) {
      // The first look starts at the end; a file that came later is read whole.
      Object.assign(f, { path, offset: first ? (size(path) ?? 0) : 0, rest: '', fields: null, decoder: new StringDecoder('utf8') });
      // A W3C log says its columns at its top: read them even when starting at its end.
      if (first && f.offset) f.fields = headerFields(fs, path);
    }
    const now = size(path);
    if (now == null) return;
    if (now < f.offset) Object.assign(f, { offset: 0, rest: '', fields: null });
    if (now === f.offset) return;
    const length = Math.min(MOST, now - f.offset);
    const buf = Buffer.alloc(length);
    let fd;
    try {
      fd = fs.openSync(path, 'r');
      const got = fs.readSync(fd, buf, 0, length, f.offset);
      f.offset += got;
      const { lines, rest } = cutLines(f.rest, f.decoder.write(buf.subarray(0, got)));
      f.rest = rest;
      for (const l of lines) line(f, l);
    } catch {
      // Locked for a moment, or gone: the next look tries again.
    } finally {
      if (fd != null) fs.closeSync(fd);
    }
  };
  for (const f of followed) look(f, true);
  const timer = setInterval(() => followed.forEach((f) => look(f, false)), every);
  timer.unref?.();
  return {
    close: () => clearInterval(timer),
    files: () => followed.map((f) => f.path),
    /** Looks now, as the timer would (tests). */
    look: () => followed.forEach((f) => look(f, false)),
  };
}

/** The `#Fields:` of the W3C log at `path`, from its first lines, or null. */
function headerFields(fs, path) {
  let fd;
  try {
    fd = fs.openSync(path, 'r');
    const buf = Buffer.alloc(4096);
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    let fields = null;
    for (const l of buf.subarray(0, got).toString('utf8').split(/\r?\n/)) fields = w3cFields(l.replace(/^﻿/, '')) ?? fields;
    return fields;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}
