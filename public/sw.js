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
    // if not JSON, fallback to text
    try {
      payload = { body: event.data ? event.data.text() : '' };
    } catch (e) {
      payload = { body: '' };
    }
  }

  const title = (payload && payload.title) ? payload.title : DEFAULT_TITLE;

  const options = {
    body: (payload && payload.body) || '',
    icon: (payload && payload.icon) || DEFAULT_ICON,
    badge: (payload && payload.badge) || DEFAULT_BADGE,
    data: (payload && payload.data) || { url: payload && payload.url ? payload.url : '/' },
    vibrate: payload && payload.vibrate ? payload.vibrate : [100, 50, 100],
    renotify: !!(payload && payload.renotify),
    tag: payload && payload.tag,
    requireInteraction: !!(payload && payload.requireInteraction),
    actions: payload && payload.actions ? payload.actions : []
  };

  event.waitUntil(
    (async () => {
      // show notification
      try {
        await self.registration.showNotification(title, options);
      } catch (e) {
        // swallow - some environments may block
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
      // Look for an open client to focus
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        // If same-origin app open, focus and post message
        try {
          const clientUrl = client.url || '';
          // Focus any client that belongs to this origin
          if (new URL(clientUrl).origin === self.location.origin) {
            // Focus the window
            if ('focus' in client) await client.focus();
            // Let the page handle deep-link with a message
            client.postMessage({ type: 'notification-click', data });
            // If a navigation URL is provided, try navigating the client (best-effort)
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
      const allClients = await clients.matchAll({ includeUncontrolled: true });
      for (const client of allClients) {
        client.postMessage({ type: 'pushsubscriptionchange' });
      }
    })()
  );
});
