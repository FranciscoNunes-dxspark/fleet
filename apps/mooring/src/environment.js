// The project's environments (the kit's environments.js): /env. The kit's askFirst asks before
// an upload, a delete, a rename or a sync up while a production one is chosen.
import { describeEnvironments, setEnvironment } from '@fleet/kit/environments.js';

/** /env: which environment the project is on, or with a name, switch every app of the family to it (Mooring then opens its host). */
export function env(ctx, name) {
  if (!name) return ctx.note(describeEnvironments(ctx.cwd)) ?? true;
  const r = setEnvironment(ctx.cwd, name, { by: 'mooring' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  const own = r.env.settings.mooring ?? {};
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production: uploads, deletes and renames ask first)' : ''}${own.host ? `. Opening ${own.host}${own.folder ? ` at ${own.folder}` : ''}` : ''}.`);
  return true;
}
