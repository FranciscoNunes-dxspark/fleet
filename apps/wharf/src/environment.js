// The project's environments (the kit's environments.js): /env, and the question asked before
// anything is stopped, restarted, removed, deleted or undone while a production one is chosen.
import { describeEnvironments, productionQuestion, setEnvironment } from '@fleet/kit/environments.js';

/**
 * Asks before a change: `req` (a confirm's { title, detail, danger }) as it is outside production, and
 * in production with the title saying so; with no `req`, only in production, about `what`. Resolves
 * true to go ahead.
 */
export async function askFirst(ctx, req, what = req?.title.replace(/\?$/, '')) {
  const q = productionQuestion(ctx.env, what);
  if (!q) return req ? ctx.confirm(req) : true;
  return ctx.confirm(req ? { ...req, title: q.title, detail: [req.detail, q.detail].filter(Boolean).join(' '), danger: true } : q);
}

/** /env: which environment the project is on, or with a name, switch every app of the family to it. */
export function env(ctx, name) {
  if (!name) return ctx.note(describeEnvironments(ctx.cwd)) ?? true;
  const r = setEnvironment(ctx.cwd, name, { by: 'wharf' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  const own = r.env.settings.wharf ?? {};
  const where = [own.context && `context ${own.context}`, own.namespace && `namespace ${own.namespace}`].filter(Boolean).join(', ');
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production: changes ask first)' : ''}${where ? `. kubectl goes to ${where}` : ''}.`);
  return true;
}
