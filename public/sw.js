// public/sw.js
// Service Worker for sTalk - handles push events and notification clicks.
// Place at site root (served as /sw.js) so scope covers the app.

'use strict';

const DEFAULT_TITLE = 'sTalk';
const DEFAULT_ICON = '/android-chrome-192x192.png';
const DEFAULT_BADGE = '/favicon-16x16.png';

// Install / activate (minimal - no forced precache here)
self.addEventListener('install', (event) => {
  // Activate immediately
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim clients immediately so page can communicate with worker
  event.waitUntil(self.clients.claim());
});

// Handle push events
self.addEventListener('push', (event) => {
  let payload = null;

  try {
    payload = event.data ? event.data.json() : null;
  } catch (err) {
    // if not JSON, fallback to plain text
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
        // Some environments may restrict notifications; log for debugging
        console.error('showNotification error', e);
      }
    })()
  );
});

// Notification click - focus or open and pass data to client
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
              } catch (e) {
                // ignore postMessage failures
              }

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
        // swallow to avoid unhandled promise rejections
        console.error('notificationclick handler failed', e);
      }
    })()
  );
});

// Optional: notificationclose
self.addEventListener('notificationclose', (event) => {
  // Could be used for analytics or clearing server-side "pending" state
});

// Handle subscription change (browser may fire when a subscription expires)
self.addEventListener('pushsubscriptionchange', (event) => {
  // Notify open clients so they can re-subscribe and update server-side subscription
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
