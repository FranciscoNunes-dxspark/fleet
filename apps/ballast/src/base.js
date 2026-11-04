// What a build is compared with: "last" (the newest build of this project read before, at another
// commit or with other changes), or a git ref ("main") whose build was read before, kept in
// ~/.ballast by its commit. When a ref's build isn't kept, `canBuild` says the caller may build it
// in a worktree (the provider's buildRef), after asking.
import { lastRun, runAt } from './history.js';
import { safeRef } from './buildplan.js';

export const BASES = ['last', 'main'];

/**
 * { run, name, commit? } for `base`, or { missing (a sentence), name, commit?, canBuild? } when there is
 * no kept build of it. `key` is this build's run key, which "last" passes over.
 */
export async function savedBase(provider, root, { base = 'last', key = null, signal } = {}) {
  const runs = provider.runs(root);
  if (!base || base === 'last') {
    const run = lastRun(runs, key);
    return run ? { run, name: 'the last build' } : { name: 'the last build', missing: 'No earlier build of this project has been read: this one is kept, to compare the next with.' };
  }
  if (!safeRef(base)) return { name: base, missing: `${base} isn't a git ref Ballast will put in a command.` };
  const commit = await provider.resolveRef(root, base, { signal });
  if (!commit) return { name: base, missing: `There's no ${base} in this repository (or it isn't one).` };
  const run = runAt(runs, commit);
  if (run) return { run, name: base, commit };
  return { name: base, commit, canBuild: true, missing: `No build of ${base} (${commit.slice(0, 7)}) has been read yet.` };
}
