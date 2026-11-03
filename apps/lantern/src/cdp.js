// The Chrome DevTools protocol, by hand: JSON messages over a WebSocket (Node 22's and Bun's global
// WebSocket), with no Puppeteer or Playwright. `cdpClient` speaks it over anything shaped like a
// WebSocket (send, close, onmessage, onclose), so the tests hand it a fake browser.

/**
 * A client over `socket`: `send(method, params, sessionId)` resolves the result (rejects with the
 * browser's error), `on(method, fn, sessionId?)` listens to events (returns the function that stops),
 * `close()`. Every call still waiting is rejected when the socket closes.
 */
export function cdpClient(socket, { timeout = 30_000 } = {}) {
  let next = 1;
  const waiting = new Map();
  const listeners = new Set();
  let closed = null;
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(Object.assign(new Error(`${w.method}: ${msg.error.message ?? 'failed'}`), { cdp: msg.error }));
      else w.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) for (const l of [...listeners]) if (l.method === msg.method && (!l.sessionId || l.sessionId === msg.sessionId)) l.fn(msg.params ?? {}, msg.sessionId);
  };
  const fail = (why) => {
    closed = why;
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(`${w.method}: ${why}`));
    }
    waiting.clear();
  };
  socket.onclose = () => fail('the browser closed the connection');
  socket.onerror = () => {};
  return {
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error(`${method}: ${closed}`));
      const id = next++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`${method}: no answer within ${timeout / 1000} s`));
        }, timeout);
        waiting.set(id, { resolve, reject, method, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(method, fn, sessionId) {
      const l = { method, fn, sessionId };
      listeners.add(l);
      return () => listeners.delete(l);
    },
    close() {
      fail('closed');
      try {
        socket.close();
      } catch {
        // Already gone.
      }
    },
  };
}

/** Opens the browser's WebSocket at `url` and resolves a cdpClient over it. */
export function connectCdp(url, { WebSocketImpl = globalThis.WebSocket, timeout = 10_000 } = {}) {
  if (!WebSocketImpl) return Promise.reject(new Error('This runtime has no WebSocket client (Node 22 or later has one).'));
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Never opened.
      }
      reject(new Error(`Chrome's DevTools socket didn't open within ${timeout / 1000} s`));
    }, timeout);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(cdpClient(socket));
    };
    socket.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't open Chrome's DevTools socket: ${e?.message ?? 'refused'}`));
    };
  });
}
