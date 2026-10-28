// Hail's side: the project's .http files as Hail reads them (requests with their {{variables}} left
// as written, never filled in) and the responses Hail kept (history.js, which already leaves out the
// secrets a request used and the headers that carry credentials; masked again here all the same).
import { readFileSync } from 'node:fs';
import { maskValue } from '@fleet/kit/family.js';
import { ToolError } from '@fleet/kit/mcp.js';
import { clip, count, line, stamp } from './bound.js';

const hail = () =>
  Promise.all([import('../../../hail/src/files.js'), import('../../../hail/src/http-file.js'), import('../../../hail/src/history.js'), import('../../../hail/src/environments.js')]).then((all) =>
    Object.assign({}, ...all),
  );

/** The .http file Claude named (relative to the project, or absolute), or the project's files. */
async function filesOf(ctx, file) {
  const { findHttpFiles } = await hail();
  if (file) return [ctx.resolve(file)];
  const found = findHttpFiles(ctx.project).map((f) => ctx.resolve(f));
  if (!found.length) throw new ToolError(`No .http or .rest files in ${ctx.project} or the two folders below it.`);
  return found;
}

function readHttp(path, parseHttpFile) {
  try {
    return parseHttpFile(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ToolError(`Couldn't read ${path}: ${e.message}`);
  }
}

const headerLines = (list = []) => list.map(([k, v]) => `  ${k}: ${line(maskValue(k, v), 300)}`);

export const hailTools = [
  {
    name: 'hail_requests',
    description:
      "The requests in the project's .http files (as Hail and VS Code's REST Client read them): each one's name, method and URL with its {{variables}} unresolved, and its line in the file; the file's variables (secret-looking values masked) and the environments beside it (names only).",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'One .http file (default: every one in the project, two folders deep)' },
        headers: { type: 'boolean', description: "Also each request's headers (default false)" },
      },
    },
    async run({ file, headers }, ctx) {
      const { parseHttpFile, loadEnvironments } = await hail();
      const out = [];
      for (const path of await filesOf(ctx, file)) {
        const { requests, variables } = readHttp(path, parseHttpFile);
        out.push(`${ctx.relative(path)} (${requests.length} request${requests.length === 1 ? '' : 's'})`);
        const vars = Object.entries(variables);
        if (vars.length) out.push(`  variables: ${vars.map(([k, v]) => `${k} = ${line(maskValue(k, v), 120)}`).join('; ')}`);
        try {
          const names = loadEnvironments(ctx.dirOf(path)).names ?? [];
          if (names.length) out.push(`  environments: ${names.join(', ')}`);
        } catch (e) {
          out.push(`  environments: ${e.message}`);
        }
        for (const r of requests) {
          out.push(`  ${r.index + 1}. ${r.name ? `${r.name}: ` : ''}${r.method} ${line(r.url, 300)}  (line ${r.line})`);
          if (headers) out.push(...headerLines(r.headers).map((h) => `    ${h.trim()}`));
        }
        out.push('');
      }
      return out.join('\n');
    },
  },
  {
    name: 'hail_history',
    description:
      "The responses Hail kept for an .http file's requests, newest last: when, which request, the method and URL sent, the status, time and size, and its checks. With `request`, that request's latest response in full (headers, and the body cut at `max_chars`). Credentials and the secrets a request used were never kept.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The .http file (default: the only one in the project)' },
        request: { type: 'string', description: "A request's name or label (or its number from hail_requests) to show its latest response whole" },
        limit: { type: 'integer', description: 'How many of the newest entries to list (default 20, at most 300)' },
        max_chars: { type: 'integer', description: 'With `request`: cut the body at this many characters (default 8000, at most 30000)' },
      },
    },
    async run({ file, request, limit, max_chars }, ctx) {
      const { historyFile, readHistory, parseHttpFile } = await hail();
      const files = await filesOf(ctx, file);
      if (files.length > 1) throw new ToolError(`Which file? The project has ${files.map((f) => ctx.relative(f)).join(', ')}.`);
      const path = files[0];
      const entries = readHistory(historyFile(path));
      if (!entries.length) return `Hail has kept no responses for ${ctx.relative(path)} (none sent from Hail yet, or its history was cleared).`;
      if (request != null && request !== '') {
        const want = String(request).toLowerCase();
        let label = null;
        if (/^\d+$/.test(want)) label = readHttp(path, parseHttpFile).requests[Number(want) - 1]?.label ?? null;
        const e = entries.findLast((x) => (label ? x.label === label : String(x.label).toLowerCase() === want || String(x.name ?? '').toLowerCase() === want));
        if (!e) throw new ToolError(`No kept response for "${request}". Kept: ${[...new Set(entries.map((x) => x.label))].join(', ')}.`);
        const res = e.response;
        return [
          `${e.label} at ${stamp(e.at)}`,
          `${e.request.method} ${e.request.url}`,
          ...headerLines(e.request.headers),
          ...(e.request.body ? ['', clip(e.request.body, 4000), ''] : []),
          `→ ${res.status} ${res.statusText ?? ''} in ${res.ms ?? '?'} ms, ${res.size ?? '?'} bytes${res.url && res.url !== e.request.url ? ` from ${res.url}` : ''}`,
          ...headerLines(res.headers),
          '',
          clip(res.body ?? '', count(max_chars, 8000, 30_000)) + (res.truncated ? '\n(Hail kept only the start of this body)' : ''),
          ...(e.checks ? ['', 'Checks:', ...e.checks.tests.map((t) => `  ${t.passed ? '✓' : '✗'} ${t.name}${t.message ? `: ${line(t.message)}` : ''}`), ...(e.checks.error ? [`  error: ${line(e.checks.error)}`] : [])] : []),
        ].join('\n');
      }
      const max = count(limit, 20, 300);
      return [
        `${ctx.relative(path)}: ${entries.length} kept response${entries.length === 1 ? '' : 's'}${entries.length > max ? `, the newest ${max}` : ''}`,
        ...entries.slice(-max).map((e) => {
          const t = e.checks?.tests ?? [];
          const failed = t.filter((x) => !x.passed).length;
          return `${stamp(e.at)}  ${line(e.label, 60)}  ${e.request.method} ${line(e.request.url, 200)}  → ${e.response.status} in ${e.response.ms ?? '?'} ms${t.length ? `, checks ${t.length - failed}/${t.length} passed` : ''}`;
        }),
      ].join('\n');
    },
  },
];
