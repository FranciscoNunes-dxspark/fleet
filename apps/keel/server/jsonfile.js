// JSON files that several server processes may share. Some hosts (Hostinger's
// Node.js hosting among them) run more than one copy of the app, so a value
// cached at startup goes stale when another copy writes the file. get()
// rereads the file whenever it changed on disk; save() writes at once.
import fs from 'node:fs';
import path from 'node:path';

const stampOf = (file) => {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
};

export function sharedJson(file, fallback) {
  let value;
  let stamp = null;

  return {
    file,
    /** The current contents (reread only when the file changed). */
    get() {
      const now = stampOf(file);
      if (now !== stamp) {
        stamp = now;
        try {
          value = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
          if (err.code !== 'ENOENT') console.warn(`[data] could not read ${file}: ${err.message}`);
          value = fallback();
        }
      }
      return value;
    },
    /** Write now. Callers get() fresh contents, change them, then save. */
    save(next = value) {
      value = next;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = JSON.stringify(value, null, 1);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        // Write then rename, so another process never reads half a file.
        fs.writeFileSync(tmp, text, { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch {
        fs.rmSync(tmp, { force: true });
        fs.writeFileSync(file, text, { mode: 0o600 });
      }
      stamp = stampOf(file);
    },
    /** Read fresh, change, save: for updates that must not lose another process's write. */
    update(fn) {
      const current = this.get();
      const result = fn(current);
      this.save(current);
      return result;
    },
  };
}

/**
 * One server process at a time runs a background job (production checks,
 * channel posts). isRunner() claims the lock file, or refreshes our claim;
 * another process takes over once the claim is `staleMs` old.
 */
export function runnerLock(file, staleMs, instance = `${process.pid}:${Math.random().toString(36).slice(2)}`) {
  const lock = sharedJson(file, () => ({}));
  return {
    isRunner() {
      const claim = lock.get();
      if (claim.id && claim.id !== instance && Date.now() - (claim.beat || 0) < staleMs) return false;
      lock.save({ id: instance, beat: Date.now() });
      return true;
    },
  };
}
