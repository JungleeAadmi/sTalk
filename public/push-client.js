// public/push-client.js
// Client helper for push registration and subscription.
// Usage: window.pushClient.subscribeForPush(vapidPublicKey, jwtToken)
//        window.pushClient.unregister(jwtToken)
// Listens for notification-click messages from the SW and re-dispatches as a CustomEvent.

(function () {
  'use strict';

  function urlBase64ToUint8Array(base64String) {
    // base64url -> Uint8Array
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service Worker not supported in this browser.');
    }
    // register at root so scope covers the app
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      // ensure active
      if (reg.waiting) await reg.waiting;
      return reg;
    } catch (err) {
      throw new Error('Service Worker registration failed: ' + (err && err.message ? err.message : err));
    }
  }

  async function subscribeForPush(vapidPublicKey, jwtToken) {
    if (!('Notification' in window) || !('PushManager' in window)) {
      throw new Error('Push notifications are not supported in this browser.');
    }

    if (!vapidPublicKey || typeof vapidPublicKey !== 'string') {
      throw new Error('VAPID public key is required (pass it to subscribeForPush).');
    }

    // ask permission
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      throw new Error('Notification permission not granted.');
    }

    const reg = await registerServiceWorker();
    if (!reg) throw new Error('Service Worker registration not available.');

    // try to reuse existing subscription
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      // ensure server knows about it (best-effort)
      try {
        await sendSubscriptionToServer(existing, jwtToken);
      } catch (e) {
        console.warn('Failed to send existing subscription to server:', e);
      }
      return existing;
    }

    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);

    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });

    // send to server
    await sendSubscriptionToServer(subscription, jwtToken);

    return subscription;
  }

  async function sendSubscriptionToServer(subscription, jwtToken) {
    // Keep endpoint consistent with your server routes. Current server expects authenticated endpoints.
    // You can change '/api/push/subscribe' if your server uses a different path.
    const url = '/api/push/subscribe';
    const headers = { 'Content-Type': 'application/json' };
    if (jwtToken) headers['Authorization'] = 'Bearer ' + jwtToken;

    const body = JSON.stringify({ subscription });

    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('Failed to register subscription on server: ' + (text || res.status));
    }
    return res.json().catch(() => ({}));
  }

  async function unregister(jwtToken) {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;

    // notify server (best-effort)
    try {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(jwtToken ? { 'Authorization': 'Bearer ' + jwtToken } : {})
        },
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
    } catch (e) {
      console.warn('Failed to notify server of unsubscribe:', e);
    }

    try {
      await sub.unsubscribe();
    } catch (e) {
      console.warn('Error during unsubscribe:', e);
    }
  }

  async function getSubscription() {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  // Expose API
  window.pushClient = {
    registerServiceWorker,
    subscribeForPush,
    unregister,
    getSubscription
  };

  // Relay messages from SW to the app: "stalk:notification-click"
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      const data = ev.data || {};
      if (data && data.type === 'notification-click') {
        window.dispatchEvent(new CustomEvent('stalk:notification-click', { detail: data.data }));
      }
      if (data && data.type === 'pushsubscriptionchange') {
        // notify app to re-subscribe if desired
        window.dispatchEvent(new Event('stalk:pushsubscriptionchange'));
      }
    });
  }
})();
