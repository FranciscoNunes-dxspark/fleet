// What a build gives away to everyone who loads it, in the kit's findings.js shape for `ballast
// security`, --sarif and Fleet's security overview: source maps shipped in the output folder (with the
// original source in them, or just its layout), and secrets in the bundled code, found with the kit's
// codescan.js secret rules run over the built files. Pure; disk.js walks the folders.
//
// bilge-ignore-file: the tests' made-up secrets come through here as text.
import { RULES, scanText } from '@fleet/kit/codescan.js';
import { toSarif } from '@fleet/kit/findings.js';

export const SECRET_RULES = RULES.filter((r) => r.kind === 'secret');

// codescan reads lines up to 2000 characters; a minified bundle is one line of megabytes. Cut such a
// line into pieces at a ; , } or space near this length (a token holds none of them), overlapping a
// little where a piece has to be cut blind, and read each piece as a line of its own.
const PIECE = 1800;
const OVERLAP = 120;

/** `line` in pieces codescan reads whole. */
export function pieces(line) {
  if (line.length <= PIECE) return [line];
  const out = [];
  let at = 0;
  while (at < line.length) {
    if (line.length - at <= PIECE) {
      out.push(line.slice(at));
      break;
    }
    const window = line.slice(at, at + PIECE);
    const cut = Math.max(window.lastIndexOf(';'), window.lastIndexOf(','), window.lastIndexOf('}'), window.lastIndexOf(' '));
    if (cut > PIECE / 2) {
      out.push(window.slice(0, cut + 1));
      at += cut + 1;
    } else {
      out.push(window);
      at += PIECE - OVERLAP;
    }
  }
  return out;
}

/**
 * The secrets in one built file's text (`path` relative to the project), each with the line it is on
 * and its excerpt redacted as codescan does: findings.js's shape plus `kind: 'secret'`. One finding a
 * rule a line, however many pieces it was read in.
 */
export function bundleSecrets(path, text) {
  const lines = String(text).split(/\r?\n/);
  const flat = [];
  const lineOf = [];
  lines.forEach((l, i) => {
    for (const p of pieces(l)) {
      flat.push(p);
      lineOf.push(i + 1);
    }
  });
  const seen = new Set();
  const out = [];
  for (const f of scanText(path, flat.join('\n'), { rules: SECRET_RULES })) {
    const line = lineOf[f.line - 1] ?? f.line;
    const key = `${f.rule}:${path}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      rule: f.rule,
      severity: f.severity,
      title: `${f.title} in the bundle`,
      where: path,
      line,
      why: `${f.why} In a built file it is sent to everyone who loads the page.`,
      fix: `${f.fix} Then find where the build takes it in (an environment variable the bundler inlines, a config file imported by the client code) and keep it on the server.`,
      excerpt: f.excerpt,
      kind: 'secret',
    });
  }
  return out;
}

/**
 * The finding for an output folder's source maps: `maps` [{ path, sources: bool }], `sources` when the
 * map holds the original code (sourcesContent). Medium with the code in them, low with only its layout.
 */
export function mapFinding(folder, maps) {
  if (!maps.length) return null;
  const withCode = maps.filter((m) => m.sources);
  const list = maps.map((m) => m.path);
  return {
    rule: 'source-map',
    severity: withCode.length ? 'medium' : 'low',
    title: `Source map${maps.length === 1 ? '' : 's'} shipped in ${folder} (${maps.length})`,
    where: maps.length === 1 ? maps[0].path : folder,
    why: withCode.length
      ? `${withCode.length === maps.length ? 'They hold' : `${withCode.length} of them hold`} the original source (sourcesContent): comments, internal names and paths, the code before minifying, for anyone to download.`
      : 'They show the original files\' names and layout, and map the minified code back to it.',
    fix: 'Build without them for production (build.sourcemap: false in Vite, devtool: false or hidden-source-map in webpack, no --sourcemap for esbuild), or upload them to the error tracker and leave them out of what is deployed.',
    excerpt: list.slice(0, 3).join(', ') + (list.length > 3 ? `, … ${list.length - 3} more` : ''),
    kind: 'config',
  };
}

/** SARIF for code scanning, from findings in the shared shape. */
export const sarifOf = (findings, version) => toSarif({ tool: 'Ballast', version, uri: 'https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/ballast', findings });
