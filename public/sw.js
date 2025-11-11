// public/sw.js
// Service Worker for sTalk - handles push events and notification clicks.

self.addEventListener('push', (event) => {
  let payload = { title: 'sTalk', body: 'New message', data: {} };
  try {
    if (event.data) payload = event.data.json();
  } catch (e) { /* ignore parse error */ }

  const title = payload.title || 'sTalk';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/android-chrome-192x192.png',
    badge: payload.badge || '/favicon-16x16.png',
    data: payload.data || {},
    renotify: !!payload.renotify,
    tag: payload.tag || undefined
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const openUrl = data.url || ('/?openChat=' + (data.chatId || ''));

  // Focus an open client or open a new window
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        // If client already open to the app, focus and navigate if necessary
        if (client.url.includes('/') && 'focus' in client) {
          client.focus();
          // try to navigate by messaging the client
          client.postMessage({ type: 'notification-click', data });
          return client.navigate ? client.navigate(openUrl) : Promise.resolve();
        }
      }
      // otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(openUrl);
      }
    })
  );
});
