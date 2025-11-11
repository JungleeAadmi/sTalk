// public/push-client.js
// Client helper for push registration and subscription.

(async function () {
  // helpers: convert VAPID key
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  window.pushClient = {
    async registerServiceWorker() {
      if (!('serviceWorker' in navigator)) throw new Error('Service Worker not supported');
      const reg = await navigator.serviceWorker.register('/sw.js');
      return reg;
    },

    async subscribeForPush(vapidPublicKey, jwtToken) {
      if (!('Notification' in window) || !('PushManager' in window)) {
        throw new Error('Push notifications not supported in this browser');
      }

      // request notification permission
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notification permission not granted');

      const reg = await this.registerServiceWorker();

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });

      // Send subscription to server (authenticated)
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + jwtToken
        },
        body: JSON.stringify({ subscription: sub })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error('Subscribe failed: ' + text);
      }
      return await res.json();
    },

    async unsubscribe(jwtToken) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + jwtToken
        },
        body: JSON.stringify({ endpoint: sub.endpoint })
      });
      await sub.unsubscribe();
    }
  };

  // listen for notification-click messages from service worker so app can deep-link
  navigator.serviceWorker?.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'notification-click') {
      // app-level handler: you can hook this in your app.js to open the chat
      window.dispatchEvent(new CustomEvent('stalk:notification-click', { detail: ev.data.data }));
    }
  });
})();
