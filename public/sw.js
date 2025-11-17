// public/sw.js
// Service Worker for sTalk - handles push events and notification clicks.
// Place at site root (served as /sw.js) so scope covers the app.

'use strict';

const DEFAULT_TITLE = 'sTalk';
const DEFAULT_ICON = '/android-chrome-192x192.png';
const DEFAULT_BADGE = '/favicon-16x16.png';

self.addEventListener('install', (event) => {
  // Activate immediately so the new SW takes control sooner
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of uncontrolled clients as soon as activated
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = null;

  // Try parse structured JSON first, fallback to text
  try {
    payload = event.data ? event.data.json() : null;
  } catch (err) {
    try {
      const text = event.data ? event.data.text() : '';
      payload = { body: text || '' };
    } catch (e) {
      payload = { body: '' };
    }
  }

  const title = (payload && payload.title) ? payload.title : DEFAULT_TITLE;

  // Normalize data object (ensure url fallback)
  const data = (payload && typeof payload.data === 'object') ? Object.assign({}, payload.data) : {};
  if (!data.url && payload && payload.url) data.url = payload.url;
  if (!data.url) data.url = '/';

  const options = {
    body: (payload && payload.body) || '',
    icon: (payload && payload.icon) || DEFAULT_ICON,
    badge: (payload && payload.badge) || DEFAULT_BADGE,
    data: data, // attach useful data (chatId, sender, url, etc.)
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
        // Log but don't throw (some environments block notifications)
        console.error('showNotification error', e);
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  // Close notification early; we'll navigate/focus after
  try { event.notification.close(); } catch (e) {}

  // Data attached by push payload (should include url / chatId / sender normally)
  const data = event.notification && event.notification.data ? event.notification.data : {};
  const openUrl = data.url || '/';
  const action = event.action || null; // action button id (if any)

  // We'll attempt to focus an existing client in the same origin, post a message to it, and navigate it.
  event.waitUntil(
    (async () => {
      try {
        const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });

        // Try to find an existing client from same origin to focus + message
        for (const client of allClients) {
          try {
            // Skip cross-origin clients (guard in case of odd URLs)
            if (new URL(client.url).origin !== self.location.origin) continue;

            // Focus the client if possible
            if (client.focus) {
              try { await client.focus(); } catch (e) { /* ignore */ }
            }

            // Post a consistent message shape that app.js expects
            try {
              client.postMessage({
                type: 'notification-click',
                data: Object.assign({}, data, { action: action, url: openUrl })
              });
            } catch (e) { /* ignore postMessage errors */ }

            // If client supports navigate, attempt to navigate to the URL (some browsers support client.navigate)
            if (openUrl && client.navigate) {
              try { await client.navigate(openUrl); } catch (e) { /* ignore navigation failure */ }
            } else {
              // fallback: opening window (will create new tab if needed)
              if (clients.openWindow) await clients.openWindow(openUrl);
            }

            // We handled it for one client so stop
            return;
          } catch (e) {
            // ignore malformed client.url or other client-specific errors and continue
            continue;
          }
        }

        // If no suitable client found, open a new window/tab
        if (clients.openWindow) {
          await clients.openWindow(openUrl);
        }
      } catch (e) {
        console.error('notificationclick handler failed', e);
      }
    })()
  );
});

self.addEventListener('notificationclose', (event) => {
  // Optional analytics or cleanup could go here.
  // We intentionally keep this light — the page can handle analytics if needed.
});

// When the subscription changes (browser refreshed keys), notify clients so page can re-subscribe
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const allClients = await clients.matchAll({ includeUncontrolled: true });
        for (const client of allClients) {
          try {
            client.postMessage({ type: 'pushsubscriptionchange' });
          } catch (e) { /* ignore per-client errors */ }
        }
      } catch (e) {
        // silent
      }
    })()
  );
});
