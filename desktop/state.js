// What Fleet Desktop remembers between runs, in its own folder (Electron's userData): the folder the
// fleet last ran in and the window's place and size. Reading never throws; a missing or broken file is
// an empty state.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function stateStore(dir) {
  const file = join(dir, 'state.json');
  return {
    read() {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        return s && typeof s === 'object' ? s : {};
      } catch {
        return {};
      }
    },
    write(patch) {
      const next = { ...this.read(), ...patch };
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(next, null, 2));
      } catch {
        // Not remembered this time; nothing else depends on it.
      }
      return next;
    },
  };
}

/** The badge count in the page's title, "(3) Fleet · …", or 0. */
export const badgeCount = (title) => Number(/^\((\d+)\)/.exec(String(title ?? ''))?.[1] ?? 0);
