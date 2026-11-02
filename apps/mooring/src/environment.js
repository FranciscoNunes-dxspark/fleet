// The project's environments (the kit's environments.js): /env, and the question asked before an
// upload, a delete, a rename or a sync up while a production one is chosen.
import { describeEnvironments, productionQuestion, setEnvironment } from '@fleet/kit/environments.js';

/**
 * Asks before a change: `req` (a confirm's { title, detail, danger, options }) as it is outside
 * production, and in production with the title saying so; with no `req`, only in production, about
 * `what`. Resolves the answer (true to go ahead, with no `req` and no production).
 */
export async function askFirst(ctx, req, what = req?.title.replace(/\?$/, '')) {
  const q = productionQuestion(ctx.env, what);
  if (!q) return req ? ctx.confirm(req) : true;
  return ctx.confirm(req ? { ...req, title: q.title, detail: [req.detail, q.detail].filter(Boolean).join(' '), danger: true } : q);
}

/** /env: which environment the project is on, or with a name, switch every app of the family to it (Mooring then opens its host). */
export function env(ctx, name) {
  if (!name) return ctx.note(describeEnvironments(ctx.cwd)) ?? true;
  const r = setEnvironment(ctx.cwd, name, { by: 'mooring' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  const own = r.env.settings.mooring ?? {};
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production: uploads, deletes and renames ask first)' : ''}${own.host ? `. Opening ${own.host}${own.folder ? ` at ${own.folder}` : ''}` : ''}.`);
  return true;
}
