// Keel's service worker: makes the app installable and quick to open, and
// shows push notifications (server/push.js) when Keel isn't open.
// Only the app itself is cached (the page and its hashed /assets files);
// Azure DevOps data from /api never is, so nothing private is stored here.
const CACHE = 'keel-shell-v4';
const SHELL = ['/', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // The page: the newest from the server, or the saved copy when offline (every route is the same page).
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put('/', res.clone()));
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // Built files have their content's hash in the name: a saved copy is always right.
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    })));
  }
});

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Keel', body: event.data ? event.data.text() : '' };
  }
  // Always shown (browsers require it). The tag is the console's own for the same event,
  // so an open Keel tab's desktop notification and this one replace each other.
  event.waitUntil(self.registration.showNotification(data.title || 'Keel', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: !!data.tag && !!data.urgent,
    icon: '/icons/icon-192.png',
    // Android draws the badge from its alpha channel only, so it must be a white glyph on
    // transparency: an opaque icon shows up as a solid white square.
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      // An open Keel goes there itself (App.jsx), without reloading.
      win.postMessage({ type: 'keel:open', path: url.pathname + url.search });
      await win.focus();
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});

// The browser replaced the subscription (keys rotated, or it expired): tell Keel the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  const key = event.oldSubscription?.options?.applicationServerKey;
  event.waitUntil((async () => {
    const sub = event.newSubscription || (key && await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    if (!sub) return;
    await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-keel': '1' },
      body: JSON.stringify({ subscription: sub.toJSON(), label: 'This device' }),
    }).catch(() => {});
  })());
});
