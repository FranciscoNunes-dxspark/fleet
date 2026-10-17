// Claude connector: a Model Context Protocol server at /mcp, so people can ask
// Claude (Claude Desktop, Claude Code) to file work items, look them up, comment
// on them and read recent commits, without opening Azure DevOps or Keel.
//
// - Transport: Streamable HTTP without sessions. Claude POSTs JSON-RPC and gets
//   JSON back; there's no server-initiated stream, so GET answers 405.
// - Auth: `Authorization: Bearer keel_...`, a connection token the person made
//   in Settings → Claude (mcptokens.js). Claude then acts as that person: their
//   role in Keel, their Azure DevOps token, their tracked projects.
// - Bad tokens are rate limited per IP like sign-in.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { can } from './accounts.js';
import { createLimiter } from './auth.js';

// Newest first; we answer with the client's version when we know it.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const INSTRUCTIONS = [
  "Keel is the team's console for Azure DevOps. These tools act in Azure DevOps as the person who connected Claude, limited to the projects they track in Keel.",
  'To file a work item: call list_projects for the project, its work item types and teams; call search_work_items first so you don\'t file a duplicate; then call create_work_item.',
  'Before creating a work item or adding a comment, show the person what you are about to file (project, type, title, and a short description) and wait for them to agree, unless they already said exactly what to file.',
  'Write descriptions in Markdown: the problem or need, who it affects, and acceptance criteria as a checklist when there are any.',
].join('\n');

const toolError = (message) => Object.assign(new Error(message), { toolError: true });
const lower = (s) => String(s ?? '').trim().toLowerCase();
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));
const orgLabel = (p) => (p.org ? `${p.org}/${p.name}` : p.name);

/** A tracked project by id, name or "org/name"; a clear error when none or several match. */
export function resolveProject(projects, ref) {
  const needle = lower(ref);
  if (!needle) throw toolError(`Say which project. Tracked projects: ${projects.map(orgLabel).join(', ') || 'none (choose some in Keel → Settings)'}.`);
  const matches = projects.filter((p) => lower(p.id) === needle || lower(p.name) === needle || (p.org && lower(`${p.org}/${p.name}`) === needle));
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw toolError(`No tracked project called "${ref}". Tracked projects: ${projects.map(orgLabel).join(', ') || 'none'}.`);
  throw toolError(`"${ref}" matches several projects (${matches.map((p) => `${orgLabel(p)} = ${p.id}`).join('; ')}). Use the project id.`);
}

const sameText = (a, b) => lower(a) === lower(b);
const wiUrl = (w) => w.webUrl || null;
const brief = (w) => w && ({ id: w.id, type: w.type, title: w.title, state: w.state, ...(w.org ? { org: w.org } : {}) });

/** The tools Claude sees. `perm` is the Keel permission a call needs (see accounts.js). */
export const TOOLS = [
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'Lists the Azure DevOps projects tracked in Keel, with the work item types that can be created in each and its teams (with their current sprint). Call this before create_work_item to pick the project, type and team.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(ctx) {
      const projects = await ctx.service.newWorkItemOptions();
      return {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          ...(p.org ? { org: p.org } : {}),
          types: p.types,
          teams: p.teams.map((t) => ({ id: t.id, name: t.name, currentSprint: t.iteration?.name || null })),
        })),
      };
    },
  },
  {
    name: 'search_work_items',
    title: 'Search work items',
    description: 'Searches open (not closed) work items in the tracked projects by words in the title, tags or id. Use it to check for duplicates before filing, or to find a parent (Feature, Epic) for a new item.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for in the title or tags, or a work item number.' },
        project: { type: 'string', description: 'Only this project (name or id).' },
        type: { type: 'string', description: 'Only this work item type, e.g. "Bug", "User Story", "Feature".' },
        assigned_to: { type: 'string', description: '"me", or part of a person\'s name or email.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(ctx, args) {
      const { items, me } = await ctx.service.workItems();
      const words = lower(args.query).split(/\s+/).filter(Boolean);
      const project = lower(args.project);
      const who = lower(args.assigned_to);
      const mine = who === 'me' || who === 'myself';
      const found = items.filter((w) => (!project || lower(w.projectName) === project || lower(w.projectId) === project)
        && (!args.type || sameText(w.type, args.type))
        && (!who || (mine
          ? !!w.assignedTo && sameText(w.assignedTo.uniqueName, me?.uniqueName)
          : `${w.assignedTo?.displayName || ''} ${w.assignedTo?.uniqueName || ''}`.toLowerCase().includes(who)))
        && words.every((word) => `${w.id} ${w.title} ${(w.tags || []).join(' ')}`.toLowerCase().includes(word)));
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      const sorted = [...found].sort((a, b) => (Date.parse(b.changedAt) || 0) - (Date.parse(a.changedAt) || 0));
      return {
        total: found.length,
        items: sorted.slice(0, limit).map((w) => ({
          ...brief(w),
          project: w.projectName,
          assignedTo: w.assignedTo?.displayName || null,
          priority: w.priority,
          iteration: w.iterationPath,
          tags: w.tags,
          changedAt: w.changedAt,
          url: wiUrl(w),
        })),
      };
    },
  },
  {
    name: 'get_work_item',
    title: 'Get a work item',
    description: 'Reads one work item: its fields, description, acceptance criteria, parent, children and recent comments.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'The work item number.' },
        org: { type: 'string', description: 'Organization key, when Keel shows several organizations (from list_projects or search results).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(ctx, args) {
      const w = await ctx.service.workItem(positiveId(args.id), args.org || undefined);
      return {
        ...brief(w),
        project: w.projectName,
        areaPath: w.areaPath,
        iteration: w.iterationPath,
        assignedTo: w.assignedTo?.displayName || null,
        createdBy: w.createdBy?.displayName || null,
        priority: w.priority,
        tags: w.tags,
        createdAt: w.createdAt,
        changedAt: w.changedAt,
        description: clip(w.description, 8000),
        acceptanceCriteria: clip(w.acceptanceCriteria, 4000),
        parent: brief(w.parent),
        children: (w.children || []).map(brief),
        comments: (w.comments || []).slice(0, 10).map((c) => ({ author: c.author?.displayName || null, at: c.createdAt, text: clip(c.text, 2000) })),
        url: wiUrl(w),
      };
    },
  },
  {
    name: 'create_work_item',
    title: 'Create a work item',
    description: 'Files a new work item (ticket) in Azure DevOps as the connected person. The project and type must come from list_projects. It goes on the team\'s backlog unless current_sprint is true. Returns its number and link.',
    perm: 'workitems.write',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id (from list_projects).' },
        type: { type: 'string', description: 'Work item type, e.g. "Bug", "User Story", "Product Backlog Item", "Task", "Feature".' },
        title: { type: 'string', maxLength: 255, description: 'A short, specific title.' },
        description: { type: 'string', description: 'Markdown. For a bug: steps to reproduce, expected and actual result.' },
        team: { type: 'string', description: 'Team name or id (sets the area path). Defaults to the first team tracked in the project.' },
        priority: { type: 'integer', minimum: 1, maximum: 4, description: '1 (highest) to 4.' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        assigned_to: { type: 'string', description: 'Email of the person to assign it to. Leave out to leave it unassigned.' },
        parent_id: { type: 'integer', minimum: 1, description: 'Number of the parent work item (e.g. the Feature this story belongs to).' },
        current_sprint: { type: 'boolean', description: "Put it in the team's current sprint instead of the backlog.", default: false },
      },
      required: ['project', 'type', 'title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(ctx, args) {
      const p = resolveProject(await ctx.service.newWorkItemOptions(), args.project);
      const type = p.types.find((x) => sameText(x, args.type));
      if (!type) throw toolError(`"${args.type}" isn't a type you can create in ${p.name}. Choose one of: ${p.types.join(', ')}.`);
      let team = null;
      if (args.team) {
        team = p.teams.find((x) => x.id === args.team || sameText(x.name, args.team));
        if (!team) throw toolError(`No team "${args.team}" is tracked in ${p.name}. Teams: ${p.teams.map((x) => x.name).join(', ') || 'none'}.`);
      }
      team ||= p.teams[0] || null;
      const created = await ctx.service.createWorkItem({
        projectId: p.id,
        type,
        title: args.title,
        description: args.description || '',
        teamId: team?.id,
        priority: args.priority,
        tags: Array.isArray(args.tags) ? args.tags : [],
        assignedTo: args.assigned_to || null,
        parentId: args.parent_id,
        iteration: args.current_sprint ? 'sprint' : 'backlog',
      });
      return {
        id: created.id,
        ...(created.org ? { org: created.org } : {}),
        url: created.webUrl,
        project: p.name,
        type,
        title: String(args.title).trim(),
        team: team?.name || null,
        placedIn: args.current_sprint && team?.iteration ? team.iteration.name : 'backlog',
      };
    },
  },
  {
    name: 'add_work_item_comment',
    title: 'Comment on a work item',
    description: 'Adds a comment (Markdown) to a work item\'s discussion, as the connected person.',
    perm: 'workitems.write',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        text: { type: 'string', description: 'The comment, in Markdown.' },
        org: { type: 'string', description: 'Organization key, when Keel shows several organizations.' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(ctx, args) {
      const id = positiveId(args.id);
      if (!String(args.text || '').trim()) throw toolError('The comment is empty.');
      await ctx.service.workItemAction(id, { type: 'comment', text: String(args.text).slice(0, 20_000) }, args.org || undefined);
      return { ok: true, id };
    },
  },
  {
    name: 'recent_commits',
    title: 'Recent commits',
    description: "Lists recent commits on the default branch of the tracked repositories (or one repository and branch): who committed what and when, and the work items and pull requests each one mentions. Use it to answer \"what changed\" or \"what's been done on X\".",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only this project (name or id).' },
        repo: { type: 'string', description: 'Only this repository (name or id).' },
        branch: { type: 'string', description: "With repo: a branch other than the repository's default." },
        days: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
        author: { type: 'string', description: "Part of the author's name or email." },
        query: { type: 'string', description: 'Words to look for in the commit message, or a work item number.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(ctx, args) {
      const days = Math.min(90, Math.max(1, Number(args.days) || 7));
      let repo = null;
      if (args.repo) {
        const repos = (await ctx.service.repos()).filter((r) => !args.project || sameText(r.projectName, args.project) || r.projectId === args.project);
        const matches = repos.filter((r) => r.id === args.repo || sameText(r.name, args.repo));
        if (!matches.length) throw toolError(`No tracked repository "${args.repo}". Repositories: ${repos.map((r) => r.name).join(', ') || 'none'}.`);
        if (matches.length > 1) throw toolError(`"${args.repo}" is in several projects (${matches.map((r) => r.projectName).join(', ')}). Say which project.`);
        [repo] = matches;
      }
      const result = await ctx.service.commits(repo ? { projectId: repo.projectId, repoId: repo.id, branch: args.branch, days } : { days });
      const words = lower(args.query).split(/\s+/).filter(Boolean);
      const author = lower(args.author);
      const found = result.commits.filter((c) => (!args.project || repo || sameText(c.projectName, args.project) || c.projectId === args.project)
        && (!author || `${c.author?.name} ${c.author?.email}`.toLowerCase().includes(author))
        && words.every((word) => `${c.message} ${c.id}`.toLowerCase().includes(word.replace(/^#/, ''))));
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      return {
        days,
        branch: result.branch || 'default',
        total: found.length,
        commits: found.slice(0, limit).map((c) => ({
          id: c.id.slice(0, 8),
          repo: c.repoName,
          project: c.projectName,
          author: c.author?.name || null,
          date: c.author?.date || null,
          subject: c.subject,
          workItems: c.workItemIds,
          ...(c.prId ? { pullRequest: c.prId } : {}),
          url: c.webUrl,
        })),
        ...(result.failed?.length ? { couldNotRead: result.failed.map((f) => `${f.repoName}: ${f.error}`) } : {}),
      };
    },
  },
];

function positiveId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw toolError('Give a work item number.');
  return n;
}

const allowed = (session, tool) => !tool.perm || can(session.ctx.role || 'admin', tool.perm);
const describe = ({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/**
 * One JSON-RPC message from Claude → the response, or null for a notification.
 * `session` is { ctx: { service, role }, onTokenRejected? }.
 */
export async function handleMessage(msg, session) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid request');
  }
  const notification = !('id' in msg);
  const reply = (result) => (notification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'keel', title: 'Keel', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.filter((tool) => allowed(session, tool)).map(describe) });
    case 'tools/call': {
      const tool = TOOLS.find((x) => x.name === params.name);
      if (!tool) return notification ? null : rpcError(msg.id, -32602, `Unknown tool: ${params.name}`);
      if (!allowed(session, tool)) return reply(toolResult('Your role in Keel does not allow this.', true));
      try {
        const out = await tool.run(session.ctx, params.arguments && typeof params.arguments === 'object' ? params.arguments : {});
        return reply(toolResult(JSON.stringify(out, null, 2)));
      } catch (err) {
        if (err.code === 'token-rejected') session.onTokenRejected?.();
        if (!err.toolError && !(err.status >= 400 && err.status < 500)) console.error('[mcp]', err);
        return reply(toolResult(err.message || 'Something went wrong.', true));
      }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return notification ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const toolResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/**
 * The /mcp endpoint. `contextFor(entry)` turns a token's entry into
 * { ctx, onTokenRejected? } for its owner, or throws (status, message).
 */
export function mcpRouter({ tokens, contextFor }) {
  const r = express.Router();
  const limiter = createLimiter();

  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  r.post('/', express.json({ limit: '256kb' }), async (req, res) => {
    const wait = limiter.blockedFor(req.ip);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json(rpcError(null, -32001, 'Too many attempts with a wrong token. Try again later.'));
    }
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1];
    const entry = bearer ? tokens.resolve(bearer) : null;
    if (!entry) {
      if (bearer) limiter.fail(req.ip);
      res.set('WWW-Authenticate', 'Bearer realm="keel"');
      return res.status(401).json(rpcError(null, -32001, 'Missing or unknown Keel connection token. Create one in Keel → Settings → Claude.'));
    }
    let session;
    try {
      session = contextFor(entry);
    } catch (err) {
      return res.status(err.status && err.status >= 400 && err.status < 500 ? err.status : 403).json(rpcError(null, -32001, err.message));
    }
    const batch = Array.isArray(req.body);
    const messages = batch ? req.body : [req.body];
    if (!messages.length) return res.status(400).json(rpcError(null, -32600, 'Empty batch'));
    const out = (await Promise.all(messages.map((m) => handleMessage(m, session)))).filter(Boolean);
    if (!out.length) return res.status(202).end();
    return res.json(batch ? out : out[0]);
  });

  // No server-to-client stream and no sessions to end.
  r.all('/', (req, res) => res.status(405).set('Allow', 'POST').json(rpcError(null, -32000, 'Use POST')));

  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json(rpcError(null, -32700, 'Parse error'));
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[mcp]', err);
    return res.status(status).json(rpcError(null, -32603, err.message || 'Unexpected error'));
  });
  return r;
}
