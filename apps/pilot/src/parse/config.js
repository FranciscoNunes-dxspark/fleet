// The build configs that say which file becomes which: BundlerMinifier's bundleconfig.json (inputs to
// an output), Web Compiler's compilerconfig.json (a .less or .scss to its .css), tsconfig.json (where
// TypeScript writes its .js: outDir, rootDir, outFile, baseUrl) and webpack.config.js (entries to
// output files, read loosely). Paths stay as written, relative to the config's folder.
import { stripComments } from '../text.js';

/** JSON as tools write it: comments and trailing commas allowed. Null when it still won't parse. */
export function looseJson(text) {
  try {
    return JSON.parse(stripComments(text.replace(/^﻿/, '')).replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

export function parseConfig(name, text) {
  const lower = name.toLowerCase();
  if (lower === 'bundleconfig.json') {
    const json = looseJson(text);
    if (!Array.isArray(json)) return { type: 'bundleconfig', bundles: [] };
    return {
      type: 'bundleconfig',
      bundles: json.filter((b) => b?.outputFileName).map((b) => ({ output: b.outputFileName, inputs: [].concat(b.inputFiles ?? []) })),
    };
  }
  if (lower === 'compilerconfig.json') {
    const json = looseJson(text);
    if (!Array.isArray(json)) return { type: 'compilerconfig', compile: [] };
    return { type: 'compilerconfig', compile: json.filter((c) => c?.inputFile && c?.outputFile).map((c) => ({ input: c.inputFile, output: c.outputFile })) };
  }
  if (lower === 'tsconfig.json') {
    const json = looseJson(text) ?? {};
    const o = json.compilerOptions ?? {};
    return { type: 'tsconfig', outDir: o.outDir ?? null, rootDir: o.rootDir ?? null, outFile: o.outFile ?? o.out ?? null, baseUrl: o.baseUrl ?? null, paths: o.paths ?? null, include: json.include ?? json.files ?? null };
  }
  if (lower === 'webpack.config.js') {
    const code = stripComments(text);
    const entries = {};
    const entry = /\bentry\s*:\s*(\{[\s\S]*?\}|\[[^\]]*\]|["'][^"']+["'])/.exec(code);
    if (entry) {
      const body = entry[1];
      if (body.startsWith('{')) {
        for (const m of body.matchAll(/["']?([\w$.-]+)["']?\s*:\s*(\[[^\]]*\]|["'][^"']+["'])/g)) entries[m[1]] = [...m[2].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
      } else entries.main = [...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    }
    const output = /\boutput\s*:\s*\{([\s\S]*?)\}/.exec(code)?.[1] ?? '';
    const filename = /\bfilename\s*:\s*["']([^"']+)["']/.exec(output)?.[1] ?? '[name].js';
    const pathCall = /\bpath\s*:\s*(path\.(?:resolve|join)\([^)]*\)|["'][^"']+["'])/.exec(output)?.[1] ?? '';
    const parts = [...pathCall.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    return { type: 'webpack', entries, filename, outDir: parts.length ? parts.join('/').replace(/\/+/g, '/') : 'dist' };
  }
  return { type: 'unknown' };
}
