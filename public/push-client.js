// public/push-client.js
// Push client for sTalk - registers service worker, subscribes and posts subscription to server

(function () {
  'use strict';

  const API_KEY_ENDPOINT = '/api/push/key';
  const SUBSCRIBE_ENDPOINT = '/api/push/subscribe';
  const UNSUBSCRIBE_ENDPOINT = '/api/push/unsubscribe';
  const SW_PATH = '/sw.js';
  const REQ_SCOPE = '/';

  function urlBase64ToUint8Array(base64String) {
    // Standard helper for VAPID key conversion
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  const pushClient = {
    registration: null,
    applicationServerKey: null,
    subscription: null,

    async init() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.info('Push not supported in this browser');
        return;
      }

      try {
        // Register SW (if not already)
        this.registration = await navigator.serviceWorker.register(SW_PATH, { scope: REQ_SCOPE });
        console.info('Service Worker registered', this.registration.scope);

        // listen for SW messages
        navigator.serviceWorker.addEventListener('message', (ev) => {
          try {
            const { type, data } = ev.data || {};
            if (type === 'notification-click' && window.app) {
              window.app.showToast('🔔 Notification clicked', 'info');
              // let app handle deep link message
              if (data && data.url) {
                // app can implement custom handler on message
                window.app && window.app.handleNotificationClick && window.app.handleNotificationClick(data);
              }
            }
            if (type === 'pushsubscriptionchange') {
              console.info('Push subscription changed - re-subscribing');
              this.subscribe(true);
            }
          } catch (e) {}
        });

        // Get VAPID public key from server
        const r = await fetch(API_KEY_ENDPOINT, { credentials: 'same-origin' });
        if (r.ok) {
          const json = await r.json();
          if (json && json.publicKey) {
            this.applicationServerKey = urlBase64ToUint8Array(json.publicKey);
          } else {
            console.warn('No VAPID public key available from server');
          }
        } else {
          console.warn('Failed to fetch VAPID key from server');
        }

        // Check existing subscription
        this.subscription = await this.registration.pushManager.getSubscription();
        if (this.subscription) {
          console.info('Existing push subscription found');
          // Try to ensure server has it (optional)
          await this.postSubscription(this.subscription);
        }

      } catch (err) {
        console.error('Push init error', err);
      }
    },

    async requestPermission() {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;
      try {
        const permission = await Notification.requestPermission();
        return permission === 'granted';
      } catch (e) {
        return false;
      }
    },

    async subscribe(force = false) {
      if (!this.registration) {
        console.warn('Service Worker not registered');
        return;
      }
      if (!this.applicationServerKey) {
        console.warn('No applicationServerKey configured; cannot subscribe');
        return;
      }

      if (!force && Notification.permission !== 'granted') {
        const ok = await this.requestPermission();
        if (!ok) {
          console.warn('Notification permission denied');
          return;
        }
      }

      try {
        const existing = await this.registration.pushManager.getSubscription();
        if (existing && !force) {
          this.subscription = existing;
          await this.postSubscription(existing);
          return existing;
        }

        const sub = await this.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.applicationServerKey
        });

        this.subscription = sub;
        console.info('Push subscribed', sub);
        await this.postSubscription(sub);
        return sub;
      } catch (err) {
        console.error('Failed to subscribe to push', err);
        if (window.app && window.app.showToast) window.app.showToast('🔕 Push subscription failed', 'error');
      }
    },

    async unsubscribe() {
      try {
        const sub = await (this.registration ? this.registration.pushManager.getSubscription() : null);
        if (!sub) return true;
        await this.postUnsubscribe(sub);
        const ok = await sub.unsubscribe();
        if (ok) {
          this.subscription = null;
          console.info('Unsubscribed from push');
        }
        return ok;
      } catch (err) {
        console.error('Unsubscribe error', err);
        return false;
      }
    },

    async postSubscription(subscription) {
      try {
        const token = localStorage.getItem('sTalk_token');
        if (!token) {
          console.warn('No auth token to send subscription to server');
          return;
        }

        const response = await fetch(SUBSCRIBE_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ subscription })
        });

        if (!response.ok) {
          console.warn('Server did not accept subscription');
        } else {
          console.info('Subscription posted to server');
        }
      } catch (err) {
        console.error('postSubscription error', err);
      }
    },

    async postUnsubscribe(subscription) {
      try {
        const token = localStorage.getItem('sTalk_token');
        const endpoint = subscription && subscription.endpoint;
        if (!token || !endpoint) return;
        await fetch(UNSUBSCRIBE_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ endpoint })
        });
      } catch (err) {
        console.error('postUnsubscribe error', err);
      }
    }
  };

  // Expose globally
  window.pushClient = pushClient;

  // Auto-init if app already logged in
  document.addEventListener('DOMContentLoaded', () => {
    // Don't auto-run subscribe unless user is logged in
    (async () => {
      try {
        // init SW and get key
        await pushClient.init();
        // if user token present, attempt subscribe automatically
        if (localStorage.getItem('sTalk_token')) {
          // give app a small delay to finish validateToken
          setTimeout(() => { pushClient.subscribe().catch(()=>{}); }, 1200);
        }
      } catch (e) {
        console.warn('pushClient auto-init failed', e);
      }
    })();
  });

})();
