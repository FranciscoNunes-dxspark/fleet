// Tiny TTL cache with in-flight de-duplication, so ten widgets asking for the
// same PR list at once cost one Azure DevOps round trip.
export class Cache {
  constructor(defaultTtlMs = 60_000) {
    this.defaultTtlMs = defaultTtlMs;
    this.entries = new Map();
  }

  async get(key, loader, ttlMs = this.defaultTtlMs) {
    const hit = this.entries.get(key);
    if (hit && (hit.pending || hit.expires > Date.now())) return hit.pending ?? hit.value;

    const pending = Promise.resolve().then(loader);
    this.entries.set(key, { pending });
    try {
      const value = await pending;
      this.entries.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } catch (err) {
      this.entries.delete(key);
      throw err;
    }
  }

  invalidate(prefix = '') {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}
