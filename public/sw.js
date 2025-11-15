// public/sw.js
// Service Worker for sTalk - improved push handling, offline fallback, and safe fetch behavior.
// Place at site root (served as /sw.js) so scope covers the app.

'use strict';

const SW_VERSION = 'sTalk-v1';
const CACHE_NAME = `${SW_VERSION}-static-v1`;
const OFFLINE_URL = '/offline.html'; // optional friendly fallback you may create
const DEFAULT_TITLE = 'sTalk';
const DEFAULT_ICON = '/android-chrome-192x192.png';
const DEFAULT_BADGE = '/favicon-16x16.png';

// small list of assets to precache. Keep minimal to avoid large caches.
// Add any real static assets you ship in /public (manifest, icons, app shell)
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/android-chrome-192x192.png',
  '/apple-touch-icon.png',
  '/sw.js'
];

// Install - pre-cache core assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(PRECACHE_ASSETS.map(p => new Request(p, { cache: 'reload' })));
      } catch (e) {
        // ignore cache errors but log
        console.warn('SW: precache failed', e);
      }
    })()
  );
});

// Activate - cleanup old caches and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => {
          if (k !== CACHE_NAME) return caches.delete(k);
          return Promise.resolve();
        }));
      } catch (e) {
        // ignore
      }
      await self.clients.claim();
    })()
  );
});

// Network-first with cache fallback for navigation and GET resources
self.addEventListener('fetch', (event) => {
  // only handle GET requests and same-origin navigations (defensive)
  if (event.request.method !== 'GET') return;

  const req = event.request;
  const acceptHeader = req.headers.get('Accept') || '';

  // Network-first for navigation (HTML) so users see latest content, fallback to cache
  if (acceptHeader.includes('text/html')) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(req);
        // update cache in background
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, networkResponse.clone()).catch(()=>{});
        return networkResponse;
      } catch (err) {
        // network failed -> try cache -> fallback offline page or generic response
        const cached = await caches.match('/index.html');
        if (cached) return cached;
        const offline = await caches.match(OFFLINE_URL);
        if (offline) return offline;
        return new Response('<h1>Offline</h1><p>The application is offline.</p>', { headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // For other GET requests, try cache first, then network and populate cache
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const resp = await fetch(req);
      // only cache successful same-origin GETs with status 200
      if (resp && resp.status === 200 && req.url.startsWith(self.location.origin)) {
        cache.put(req, resp.clone()).catch(()=>{});
      }
      return resp;
    } catch (e) {
      // if fetch fails and we have fallback, return it
      const fallback = await cache.match('/index.html') || await cache.match(OFFLINE_URL);
      if (fallback) return fallback;
      throw e;
    }
  })());
});

// Handle push events
self.addEventListener('push', (event) => {
  let payload = null;

  // Parse payload safely (could be JSON or plain text)
  try {
    payload = event.data ? event.data.json() : null;
  } catch (err) {
    try {
      payload = { body: event.data ? event.data.text() : '' };
    } catch (e) {
      payload = { body: '' };
    }
  }

  const title = (payload && payload.title) ? payload.title : DEFAULT_TITLE;

  // Ensure data object always exists and contains a url fallback
  const data = (payload && typeof payload.data === 'object') ? payload.data : {};
  if (!data.url && payload && payload.url) data.url = payload.url;
  if (!data.url) data.url = '/';

  const options = {
    body: (payload && payload.body) || '',
    icon: (payload && payload.icon) || DEFAULT_ICON,
    badge: (payload && payload.badge) || DEFAULT_BADGE,
    data: data,
    vibrate: (payload && payload.vibrate) ? payload.vibrate : [100, 50, 100],
    renotify: !!(payload && payload.renotify),
    tag: (payload && payload.tag) || undefined,
    requireInteraction: !!(payload && payload.requireInteraction),
    actions: (payload && Array.isArray(payload.actions)) ? payload.actions : []
  };

  event.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(title, options);
      } catch (e) {
        // Some environments restrict notifications; log for debugging
        console.error('SW: showNotification error', e);
      }
    })()
  );
});

// Notification click - focus or open and postMessage to client
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const openUrl = data.url || '/';

  event.waitUntil(
    (async () => {
      try {
        const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of allClients) {
          // Only consider same-origin clients (defensive)
          try {
            const clientUrl = client.url || '';
            if (new URL(clientUrl).origin === self.location.origin) {
              if (client.focus) await client.focus();

              // Let the page handle deep-linking via postMessage
              try {
                client.postMessage({ type: 'notification-click', data });
              } catch (e) { /* ignore */ }

              // Best-effort navigate if supported
              if (openUrl && client.navigate) {
                try { await client.navigate(openUrl); } catch (e) { /* ignore */ }
              }
              return;
            }
          } catch (e) {
            // ignore malformed client.url
          }
        }

        // No matching client found — open a new window/tab
        if (clients.openWindow) {
          await clients.openWindow(openUrl);
        }
      } catch (e) {
        console.error('SW: notificationclick handler failed', e);
      }
    })()
  );
});

self.addEventListener('notificationclose', (event) => {
  // Could be used for analytics or clearing server-side "pending" state
  // We deliberately do nothing but leave hook here if you need to record closes
});

// Handle subscription change (browser may fire when a subscription expires)
// Best practice: notify clients so they can re-subscribe (need to do this from a visible page)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const allClients = await clients.matchAll({ includeUncontrolled: true });
        for (const client of allClients) {
          try {
            client.postMessage({ type: 'pushsubscriptionchange' });
          } catch (e) {
            // ignore
          }
        }
      } catch (e) {
        // ignore
      }
    })()
  );
});

// Optionally handle messages from client pages (e.g., to skipWaiting or clear caches)
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg && msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (msg && msg.type === 'CLEAR_OLD_CACHES') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => { if (k !== CACHE_NAME) return caches.delete(k); }));
    })());
  }
});

// Defensive: attempt to warm cache for navigation requests when online
// (optional and low priority)
self.addEventListener('periodicsync', (event) => {
  // not implemented - browsers support is limited; kept for possible future use
});
