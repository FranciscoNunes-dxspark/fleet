// Polls Azure DevOps while at least one browser tab is open, and pushes two
// kinds of Server-Sent Events to every tab:
//   changed — something the UI shows is different: refetch
//   notify  — specific events worth telling the lead about
// Nobody watching means no polling, so an idle console costs no API quota.
import { diffSnapshots, fingerprint } from './domain/changes.js';

export const MIN_INTERVAL = 15;
export const MAX_INTERVAL = 600;
const clamp = (n) => Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Number(n) || 60));

export function createWatcher(service) {
  const clients = new Set();
  let timer = null;
  let prev = null;
  let prevFp = null;
  let busy = false;
  let lastPollAt = null;
  let lastError = null;
  let intervalSeconds = 60;
  let version = 0;

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data) => {
    for (const c of clients) send(c, event, data);
  };
  const status = () => ({ ok: !lastError, error: lastError, lastPollAt, intervalSeconds, version });

  async function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!clients.size) return;
    intervalSeconds = clamp((await service.settingsStore.load()).refreshSeconds);
    timer = setTimeout(tick, intervalSeconds * 1000);
    timer.unref?.();
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      // Drop the live data so this poll really asks Azure DevOps.
      for (const prefix of ['prs:active', 'pr:', 'wi:', 'builds']) service.invalidate(prefix);
      const snap = await service.snapshot();
      const fp = fingerprint(snap);
      const notes = diffSnapshots(prev, snap);
      prev = snap;
      lastPollAt = new Date().toISOString();
      lastError = null;
      if (prevFp !== null && fp !== prevFp) {
        version++;
        broadcast('changed', { version, at: lastPollAt });
      }
      prevFp = fp;
      if (notes.length) broadcast('notify', { items: notes.slice(0, 20) });
    } catch (err) {
      lastError = err.message;
      console.warn(`[watcher] poll failed: ${err.message}`);
    } finally {
      busy = false;
      await schedule();
      broadcast('status', status());
    }
  }

  return {
    /** GET /api/events */
    async attach(req, res) {
      intervalSeconds = clamp((await service.settingsStore.load()).refreshSeconds);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\n\n');
      const wasIdle = clients.size === 0;
      clients.add(res);
      send(res, 'status', status());
      if (wasIdle) {
        // Coming back after nobody was watching: start a fresh baseline instead
        // of announcing everything that happened while the console was closed.
        const stale = !lastPollAt || Date.now() - Date.parse(lastPollAt) > intervalSeconds * 2000;
        if (stale) {
          prev = null;
          prevFp = null;
          tick();
        } else {
          schedule();
        }
      }
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
        if (!clients.size) {
          clearTimeout(timer);
          timer = null;
        }
      });
    },
    /** Settings changed (e.g. the interval): apply it now. */
    reschedule: () => schedule(),
    /** Poll right away (after the Refresh button). */
    pollNow: () => tick(),
    status,
    /** Open browser tabs for this user. */
    clientCount: () => clients.size,
    /** Sign-out: close this user's live connections and stop polling. */
    close() {
      clearTimeout(timer);
      timer = null;
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}
