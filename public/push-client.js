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

  // --- Small DOM helper for the notification banner & modal ---
  const ui = {
    idBanner: 'stalk-push-banner',
    idModal: 'stalk-push-modal',
    createStyles() {
      if (document.getElementById('stalk-push-client-styles')) return;
      const css = `
#${this.idBanner} {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: 18px;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: rgba(22,22,22,0.95);
  color: #fff;
  padding: 10px 12px;
  border-radius: 10px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.45);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
  font-size: 14px;
}
#${this.idBanner} .stalk-msg { flex: 1; margin-right: 8px; }
#${this.idBanner} .stalk-actions { display:flex; gap:8px; align-items:center; }
#${this.idBanner} .stalk-btn {
  background: linear-gradient(180deg, #1f7ae0, #1665d6);
  border: none;
  color: #fff;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  box-shadow: 0 2px 6px rgba(0,0,0,0.25);
}
#${this.idBanner} .stalk-btn.tertiary {
  background: transparent;
  border: 1px solid rgba(255,255,255,0.12);
  padding: 8px 10px;
}
#${this.idModal} {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: 80px;
  z-index: 99999;
  background: rgba(250,250,250,0.98);
  color: #111;
  padding: 12px;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.35);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
  font-size: 14px;
}
#${this.idModal} .stalk-modal-title { font-weight: 700; margin-bottom: 8px; }
#${this.idModal} .stalk-modal-close { float: right; cursor: pointer; color: #444; }
`;
      const s = document.createElement('style');
      s.id = 'stalk-push-client-styles';
      s.appendChild(document.createTextNode(css));
      document.head.appendChild(s);
    },

    showBanner({ mode = 'default' } = {}) {
      // mode: 'default' | 'denied'
      try {
        this.createStyles();
        if (document.getElementById(this.idBanner)) return;
        const banner = document.createElement('div');
        banner.id = this.idBanner;

        const msg = document.createElement('div');
        msg.className = 'stalk-msg';

        const actions = document.createElement('div');
        actions.className = 'stalk-actions';

        if (mode === 'default') {
          msg.innerText = 'Enable push notifications for message alerts.';
          const btnEnable = document.createElement('button');
          btnEnable.className = 'stalk-btn';
          btnEnable.innerText = 'Enable Notifications';
          btnEnable.addEventListener('click', (e) => {
            // User gesture -> trigger permission flow passed to caller
            document.body.removeChild(banner);
            if (typeof window.pushClient !== 'undefined') {
              // call subscribe with force=false; requestPermission will run inside subscribe flow
              window.pushClient.subscribe().catch(()=>{});
            }
          });
          const btnLater = document.createElement('button');
          btnLater.className = 'stalk-btn tertiary';
          btnLater.innerText = 'Later';
          btnLater.addEventListener('click', () => {
            if (document.getElementById(this.idBanner)) {
              document.body.removeChild(banner);
            }
          });
          actions.appendChild(btnLater);
          actions.appendChild(btnEnable);
        } else if (mode === 'denied') {
          msg.innerText = 'Notifications are blocked for this site — open Settings to allow.';
          const btnHelp = document.createElement('button');
          btnHelp.className = 'stalk-btn';
          btnHelp.innerText = 'How to enable';
          btnHelp.addEventListener('click', () => {
            this.showModal();
            if (document.getElementById(this.idBanner)) document.body.removeChild(banner);
          });
          const btnDismiss = document.createElement('button');
          btnDismiss.className = 'stalk-btn tertiary';
          btnDismiss.innerText = 'Dismiss';
          btnDismiss.addEventListener('click', () => {
            if (document.getElementById(this.idBanner)) document.body.removeChild(banner);
          });
          actions.appendChild(btnDismiss);
          actions.appendChild(btnHelp);
        }

        banner.appendChild(msg);
        banner.appendChild(actions);
        document.body.appendChild(banner);
      } catch (e) {
        // ignore UI errors
        console.warn('push-client UI banner error', e);
      }
    },

    hideBanner() {
      const el = document.getElementById(this.idBanner);
      if (el) el.remove();
    },

    showModal() {
      try {
        if (document.getElementById(this.idModal)) return;
        const modal = document.createElement('div');
        modal.id = this.idModal;

        const close = document.createElement('span');
        close.className = 'stalk-modal-close';
        close.innerText = '✕';
        close.addEventListener('click', () => modal.remove());

        const title = document.createElement('div');
        title.className = 'stalk-modal-title';
        title.innerText = 'Enable Notifications (iOS / Safari)';

        const content = document.createElement('div');
        content.innerHTML = `
          <p>If you previously denied notifications, Safari will not show the prompt again. To re-enable:</p>
          <ol>
            <li>Open <strong>Settings</strong> &rarr; <strong>Safari</strong> &rarr; <strong>Notifications</strong> and ensure notifications are allowed for the site — <em>or</em></li>
            <li>Open the <strong>Settings</strong> app, choose <strong>Safari</strong>, then Website Settings &rarr; Notifications &rarr; find this site and enable notifications.</li>
            <li>Alternatively delete the saved PWA from Home Screen and re-add it, then open the site and tap <strong>Enable Notifications</strong> when asked.</li>
          </ol>
          <p>Note: iOS requires that the permission prompt is triggered from a user gesture (a button tap). Use the "Enable Notifications" button in the app when you see it.</p>
        `;
        modal.appendChild(close);
        modal.appendChild(title);
        modal.appendChild(content);

        document.body.appendChild(modal);
      } catch (e) {
        console.warn('push-client UI modal error', e);
      }
    }
  };

  const pushClient = {
    registration: null,
    applicationServerKey: null,
    subscription: null,

    async init() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        console.info('Push not supported in this browser');
        return;
      }

      try {
        // Register SW (if not already)
        // sw scope & path are configurable at top
        this.registration = await navigator.serviceWorker.register(SW_PATH, { scope: REQ_SCOPE });
        console.info('Service Worker registered', this.registration.scope);

        // listen for SW messages
        navigator.serviceWorker.addEventListener('message', (ev) => {
          try {
            const { type, data } = ev.data || {};
            if (type === 'notification-click' && window.app) {
              window.app.showToast && window.app.showToast('🔔 Notification clicked', 'info');
              if (data && data.url) {
                window.app && window.app.handleNotificationClick && window.app.handleNotificationClick(data);
              }
            }
            if (type === 'pushsubscriptionchange') {
              console.info('Push subscription changed - re-subscribing');
              this.subscribe(true);
            }
          } catch (e) { /* ignore */ }
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
          await this.postSubscription(this.subscription);
          ui.hideBanner();
          return;
        }

        // If no subscription, show banner depending on permission state
        // Do not auto-call requestPermission here; must be user gesture on some browsers (esp iOS)
        if (Notification.permission === 'granted') {
          // attempt to subscribe automatically if token exists
          try { await this.subscribe(); } catch (e) { /* ignore */ }
        } else if (Notification.permission === 'default') {
          // show "Enable Notifications" banner — user gesture will call subscribe
          ui.showBanner({ mode: 'default' });
        } else if (Notification.permission === 'denied') {
          // show "How to enable" instructions
          ui.showBanner({ mode: 'denied' });
        }

      } catch (err) {
        console.error('Push init error', err);
      }
    },

    async requestPermission() {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;
      try {
        // This must be called inside a user gesture to work on iOS/Safari
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

      // If the browser disallows notifications entirely, bail out
      if (!('Notification' in window)) {
        console.warn('Notifications not supported');
        return;
      }

      // If permission not granted, request permission (must happen from user gesture ideally)
      if (!force && Notification.permission !== 'granted') {
        // requestPermission should be called inside a user gesture to succeed on iOS Safari
        const ok = await this.requestPermission();
        if (!ok) {
          console.warn('Notification permission denied or not granted');
          // show denied instructions if explicitly denied
          if (Notification.permission === 'denied') ui.showBanner({ mode: 'denied' });
          return;
        }
      }

      try {
        const existing = await this.registration.pushManager.getSubscription();
        if (existing && !force) {
          this.subscription = existing;
          await this.postSubscription(existing);
          ui.hideBanner();
          return existing;
        }

        const sub = await this.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.applicationServerKey
        });

        this.subscription = sub;
        console.info('Push subscribed', sub);
        await this.postSubscription(sub);
        ui.hideBanner();
        // let the app show a success toast if available
        window.app && window.app.showToast && window.app.showToast('🔔 Notifications enabled', 'success');
        return sub;
      } catch (err) {
        console.error('Failed to subscribe to push', err);
        if (window.app && window.app.showToast) window.app.showToast('🔕 Push subscription failed', 'error');
        // If subscription attempt failed and permission is still default, show banner again
        if (Notification.permission === 'default') ui.showBanner({ mode: 'default' });
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

        // server expects subscription JSON; pass as-is
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
        // if user token present, attempt subscribe automatically (only if permission granted)
        if (localStorage.getItem('sTalk_token') && Notification.permission === 'granted') {
          // give app a small delay to finish validateToken
          setTimeout(() => { pushClient.subscribe().catch(()=>{}); }, 1200);
        }
      } catch (e) {
        console.warn('pushClient auto-init failed', e);
      }
    })();
  });

})();
