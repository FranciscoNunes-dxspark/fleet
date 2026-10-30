// The transfer queue: uploads and downloads waiting, running (`concurrency` at a time, over the
// session's one connection), finished or failed. Each item keeps its bytes and total as the session
// reports them, and can be cancelled, retried or removed. `onChange(items)` hears every change
// (progress at most every `interval` ms), with copies, so a view can keep them as state.
import { SessionError } from './errors.js';

/** Bytes per second since `item` started; 0 before it has. */
export function rateOf(item, now = Date.now()) {
  if (!item.startedAt || !item.bytes) return 0;
  const seconds = ((item.finishedAt ?? now) - item.startedAt) / 1000;
  return seconds > 0 ? item.bytes / seconds : 0;
}

/** Seconds left at the current rate, or null when it can't be told. */
export function etaOf(item, now = Date.now()) {
  const rate = rateOf(item, now);
  return item.status === 'running' && rate > 0 && item.total != null ? Math.max(0, (item.total - item.bytes) / rate) : null;
}

export function createQueue({ session, concurrency = 2, now = Date.now, onChange = () => {}, interval = 100 }) {
  const items = [];
  const controllers = new Map();
  const waiting = [];
  let nextId = 1;
  let lastEmit = 0;

  const emit = (force = true) => {
    const t = now();
    if (!force && t - lastEmit < interval) return;
    lastEmit = t;
    onChange(items.map((i) => ({ ...i })));
  };
  const running = () => items.filter((i) => i.status === 'running').length;
  const settle = () => {
    if (!items.some((i) => i.status === 'queued' || i.status === 'running')) for (const resolve of waiting.splice(0)) resolve();
  };

  async function start(item) {
    const controller = new AbortController();
    controllers.set(item.id, controller);
    item.status = 'running';
    item.startedAt = now();
    item.error = null;
    emit();
    const options = {
      recursive: item.recursive,
      signal: controller.signal,
      size: item.size,
      onProgress: ({ bytes, total }) => {
        item.bytes = bytes;
        item.total = total;
        emit(false);
      },
    };
    try {
      await (item.kind === 'upload' ? session.put(item.from, item.to, options) : session.get(item.from, item.to, options));
      item.status = 'done';
      if (item.total != null) item.bytes = item.total;
    } catch (e) {
      item.status = e?.cancelled ? 'cancelled' : 'failed';
      item.error = e?.cancelled ? null : e instanceof SessionError || e instanceof Error ? e.message : String(e);
    } finally {
      item.finishedAt = now();
      controllers.delete(item.id);
      emit();
      pump();
      settle();
    }
  }

  function pump() {
    while (running() < concurrency) {
      const next = items.find((i) => i.status === 'queued');
      if (!next) break;
      start(next);
    }
  }

  const find = (id) => items.find((i) => i.id === id);

  return {
    /** Queues a transfer: { kind: 'upload' | 'download', name, from, to, recursive?, size? }. Returns its id. */
    add(spec) {
      const item = { id: nextId++, recursive: false, size: null, total: spec.size ?? null, bytes: 0, status: 'queued', error: null, addedAt: now(), ...spec };
      items.push(item);
      emit();
      pump();
      return item.id;
    },
    items: () => items.map((i) => ({ ...i })),
    counts: () => ({
      queued: items.filter((i) => i.status === 'queued').length,
      running: running(),
      done: items.filter((i) => i.status === 'done').length,
      failed: items.filter((i) => i.status === 'failed').length,
      cancelled: items.filter((i) => i.status === 'cancelled').length,
    }),
    /** A queued item won't run; a running one is stopped by its signal. */
    cancel(id) {
      const item = find(id);
      if (!item) return;
      if (item.status === 'queued') {
        item.status = 'cancelled';
        emit();
        settle();
      } else if (item.status === 'running') controllers.get(id)?.abort();
    },
    cancelAll() {
      for (const item of items) this.cancel(item.id);
    },
    /** Puts a failed or cancelled item back to wait its turn. */
    retry(id) {
      const item = find(id);
      if (!item || (item.status !== 'failed' && item.status !== 'cancelled')) return;
      Object.assign(item, { status: 'queued', bytes: 0, total: item.size ?? null, error: null, startedAt: null, finishedAt: null });
      emit();
      pump();
    },
    /** Takes an item that isn't running off the list. */
    remove(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0 || items[i].status === 'running') return;
      items.splice(i, 1);
      emit();
      settle();
    },
    /** Takes the finished ones (done, by default; or the statuses given) off the list. */
    clear(statuses = ['done']) {
      for (let i = items.length - 1; i >= 0; i--) if (statuses.includes(items[i].status)) items.splice(i, 1);
      emit();
    },
    /** Resolves once nothing is queued or running. */
    idle() {
      return items.some((i) => i.status === 'queued' || i.status === 'running') ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
    },
  };
}
