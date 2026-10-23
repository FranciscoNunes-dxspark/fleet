// .env files (bosun.json's "envFile"), in the dotenv format most tools read: KEY=value lines,
// comments, `export ` in front, quotes, \n in double quotes, ${VAR} from earlier lines or the
// environment. Pure: crew.js reads the files and hands their text here.

const KEY = /^[A-Za-z_][\w.-]*$/;
const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', $: '\u0000' };

/**
 * `text` with ${VAR}, ${VAR:-fallback}, ${VAR-fallback} and $VAR filled in by `lookup(name)`
 * (undefined when there's none). A \u0000 marks an escaped $, which stays a $.
 */
export function expand(text, lookup) {
  return text
    .replace(/\$\{([A-Za-z_]\w*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_]\w*)/g, (_, braced, op, fallback, bare) => {
      const v = lookup(braced ?? bare);
      if (op === ':-' && !v) return fallback;
      if (op === '-' && v === undefined) return fallback;
      return v ?? '';
    })
    .replace(/\u0000/g, '$');
}

/**
 * The settings in a .env file's `text`: { values, problems }. `env` is what ${VAR} reads when the
 * file hasn't set VAR above (the environment, and files read before this one). Single quotes and
 * backticks keep everything as it is; double quotes take \n, \t, \", \\ and \$ and may run over
 * several lines; unquoted values end at a # after a space.
 */
export function parseDotenv(text, env = {}) {
  const values = {};
  const problems = [];
  const lookup = (name) => (Object.hasOwn(values, name) ? values[name] : env[name]);
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*([\s\S]*)$/.exec(line);
    if (!m || !KEY.test(m[1])) {
      problems.push(`line ${i + 1}: ${line.length > 40 ? `${line.slice(0, 40)}…` : line} isn't NAME=value`);
      continue;
    }
    const [, key] = m;
    let rest = m[2];
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      // Up to the closing quote, which may be on a later line.
      let body = rest.slice(1);
      let end = closing(body, quote);
      const start = i;
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]}`;
        end = closing(body, quote);
      }
      if (end < 0) {
        problems.push(`line ${start + 1}: ${key}'s ${quote} is never closed`);
        continue;
      }
      body = body.slice(0, end);
      values[key] = quote === '"' ? expand(body.replace(/\\(.)/g, (all, c) => ESCAPES[c] ?? all), lookup) : body;
      continue;
    }
    rest = rest.replace(/\s+#.*$/, '').trim();
    values[key] = expand(rest.replace(/\\\$/g, '\u0000'), lookup);
  }
  return { values, problems };
}

/** Where `quote` closes in `text` (a backslash escapes it in double quotes), or -1. */
function closing(text, quote) {
  for (let i = 0; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}
