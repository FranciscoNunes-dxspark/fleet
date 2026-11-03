// The project's environments (the kit's environments.js): /env. The kit's askFirst asks before
// anything is stopped, restarted, removed, deleted or undone while a production one is chosen.
import { describeEnvironments, setEnvironment } from '@fleet/kit/environments.js';

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
