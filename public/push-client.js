// public/push-client.js
// Push client for sTalk - registers service worker, subscribes and posts subscription to server
// Enhanced with iOS instructions modal, settings wiring, and safer permission flow.

(function () {
  'use strict';

  const API_KEY_ENDPOINT = '/api/push/key';
  const SUBSCRIBE_ENDPOINT = '/api/push/subscribe';
  const UNSUBSCRIBE_ENDPOINT = '/api/push/unsubscribe';
  const SW_PATH = '/sw.js';
  const REQ_SCOPE = '/';

  const IOS_MODAL_KEY = 'sTalk_ios_instructions_dont_show';
  const IOS_MODAL_ID = 'iosInstructionModal';
  const IOS_DONT_SHOW_ID = 'iosDontShowAgain';
  const REQUEST_BTN_ID = 'requestPermissionBtn';
  const SHOW_IOS_BTN_ID = 'showIOSInstructionsBtn';
  const ENABLE_PUSH_TOGGLE_ID = 'enablePushToggle';
  const PUSH_DESC_ID = 'pushPermissionDescription';

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

  function isIOS() {
    return /iP(hone|od|ad)/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isInStandaloneMode() {
    return ('standalone' in navigator && navigator.standalone) || window.matchMedia('(display-mode: standalone)').matches;
  }

  function showIOSModal() {
    const modal = document.getElementById(IOS_MODAL_ID);
    if (!modal) return;
    const dontShow = document.getElementById(IOS_DONT_SHOW_ID);
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');

    const closeBtn = document.getElementById('iosCloseBtn');
    const openSafariBtn = document.getElementById('iosOpenSafariBtn');

    function closeModal() {
      if (dontShow && dontShow.checked) {
        localStorage.setItem(IOS_MODAL_KEY, '1');
      }
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      closeBtn && closeBtn.removeEventListener('click', closeModal);
      openSafariBtn && openSafariBtn.removeEventListener('click', openSafari);
    }

    function openSafari() {
      // Suggest opening Safari -- try to open the site's URL in a new tab
      try {
        window.open(window.location.href, '_blank');
      } catch (e) {}
      closeModal();
    }

    closeBtn && closeBtn.addEventListener('click', closeModal);
    openSafariBtn && openSafariBtn.addEventListener('click', openSafari);
  }

  function shouldShowIOSInstructions() {
    if (!isIOS()) return false;
    if (localStorage.getItem(IOS_MODAL_KEY) === '1') return false;
    // If not in standalone and permission is default (user hasn't allowed) show.
    return Notification.permission !== 'granted';
  }

  const pushClient = {
    registration: null,
    applicationServerKey: null,
    subscription: null,

    async init() {
      // Setup UI controls wiring
      this.setupUI();

      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.info('Push not supported in this browser');
        this.updatePermissionUI();
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
              if (data && data.url) {
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

        // update UI permission states
        this.updatePermissionUI();

        // Show iOS modal if appropriate and not shown
        if (shouldShowIOSInstructions()) {
          // If the UA is iOS and notifications not granted, show the instructions in Settings.
          // But do not automatically interrupt — show a small CTA in Settings
          const showBtn = document.getElementById(SHOW_IOS_BTN_ID);
          if (showBtn) showBtn.style.display = 'inline-block';
          // If user is in standalone or explicitly allowed, we might try subscription.
          if (Notification.permission === 'granted') {
            // ensure subscription present
            if (!this.subscription && this.applicationServerKey) {
              await this.subscribe();
            }
          }
        }

      } catch (err) {
        console.error('Push init error', err);
        this.updatePermissionUI();
      }
    },

    setupUI() {
      // Hook up Settings toggles and buttons if present
      try {
        const enablePushToggle = document.getElementById(ENABLE_PUSH_TOGGLE_ID);
        const requestBtn = document.getElementById(REQUEST_BTN_ID);
        const showIOSBtn = document.getElementById(SHOW_IOS_BTN_ID);
        const pushDesc = document.getElementById(PUSH_DESC_ID);

        // Update UI text depending on permission
        this.updatePermissionUI();

        if (enablePushToggle) {
          // initialize checkbox based on current subscription / permission
          enablePushToggle.checked = (Notification && Notification.permission === 'granted' && !!this.subscription);
          enablePushToggle.addEventListener('change', async (ev) => {
            if (enablePushToggle.checked) {
              // request permission and subscribe
              const ok = await this.requestPermission();
              if (!ok) {
                enablePushToggle.checked = false;
                this.updatePermissionUI();
                return;
              }
              await this.init(); // ensure registration exists and key fetched
              await this.subscribe(true);
            } else {
              await this.unsubscribe();
            }
            this.updatePermissionUI();
          });
        }

        if (requestBtn) {
          requestBtn.style.display = 'none';
          requestBtn.addEventListener('click', async () => {
            const ok = await this.requestPermission();
            this.updatePermissionUI();
            if (ok) {
              // subscribe if logged in
              if (localStorage.getItem('sTalk_token')) {
                await this.init();
                await this.subscribe(true);
              }
            }
          });
        }

        if (showIOSBtn) {
          showIOSBtn.style.display = 'none';
          showIOSBtn.addEventListener('click', () => {
            showIOSModal();
          });
        }
      } catch (e) {
        console.warn('setupUI error', e);
      }
    },

    updatePermissionUI() {
      try {
        const pushDesc = document.getElementById(PUSH_DESC_ID);
        const requestBtn = document.getElementById(REQUEST_BTN_ID);
        const showIOSBtn = document.getElementById(SHOW_IOS_BTN_ID);
        const enablePushToggle = document.getElementById(ENABLE_PUSH_TOGGLE_ID);

        const state = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
        if (pushDesc) {
          if (state === 'granted') {
            pushDesc.textContent = 'Permission granted — push enabled';
            if (requestBtn) requestBtn.style.display = 'none';
            if (showIOSBtn) showIOSBtn.style.display = 'none';
            if (enablePushToggle) enablePushToggle.checked = !!this.subscription;
          } else if (state === 'denied') {
            pushDesc.textContent = 'Notifications blocked — open Settings to re-enable';
            if (requestBtn) requestBtn.style.display = 'none';
            // suggest iOS instructions if on ios
            if (showIOSBtn) {
              showIOSBtn.style.display = isIOS() ? 'inline-block' : 'none';
            }
            if (enablePushToggle) enablePushToggle.checked = false;
          } else if (state === 'default') {
            pushDesc.textContent = 'Permission not requested yet';
            if (requestBtn) requestBtn.style.display = 'inline-block';
            if (showIOSBtn) showIOSBtn.style.display = isIOS() ? 'inline-block' : 'none';
            if (enablePushToggle) enablePushToggle.checked = false;
          } else {
            pushDesc.textContent = 'Notifications not supported in this browser';
            if (requestBtn) requestBtn.style.display = 'none';
            if (showIOSBtn) showIOSBtn.style.display = 'none';
            if (enablePushToggle) enablePushToggle.disabled = true;
          }
        }
      } catch (e) {
        console.warn('updatePermissionUI error', e);
      }
    },

    async requestPermission() {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;

      // On iOS, the native permission prompt can be confusing; prefer user-initiated flow
      try {
        const permission = await Notification.requestPermission();
        this.updatePermissionUI();
        return permission === 'granted';
      } catch (e) {
        this.updatePermissionUI();
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

      // If permission is denied, don't try
      if (!force && Notification.permission !== 'granted') {
        const ok = await this.requestPermission();
        if (!ok) {
          console.warn('Notification permission denied');
          this.updatePermissionUI();
          return;
        }
      }

      try {
        const existing = await this.registration.pushManager.getSubscription();
        if (existing && !force) {
          this.subscription = existing;
          await this.postSubscription(existing);
          this.updatePermissionUI();
          return existing;
        }

        const sub = await this.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.applicationServerKey
        });

        this.subscription = sub;
        console.info('Push subscribed', sub);
        await this.postSubscription(sub);
        this.updatePermissionUI();
        return sub;
      } catch (err) {
        console.error('Failed to subscribe to push', err);
        if (window.app && window.app.showToast) window.app.showToast('🔕 Push subscription failed', 'error');
        this.updatePermissionUI();
      }
    },

    async unsubscribe() {
      try {
        const sub = await (this.registration ? this.registration.pushManager.getSubscription() : null);
        if (!sub) {
          this.subscription = null;
          this.updatePermissionUI();
          return true;
        }
        await this.postUnsubscribe(sub);
        const ok = await sub.unsubscribe();
        if (ok) {
          this.subscription = null;
          console.info('Unsubscribed from push');
        }
        this.updatePermissionUI();
        return ok;
      } catch (err) {
        console.error('Unsubscribe error', err);
        this.updatePermissionUI();
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
          // if server returns 403 or other, we surface it
          if (response.status === 403 || response.status === 400) {
            console.warn('Server rejected push subscription; check server VAPID keys or push endpoint.');
          }
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
    (async () => {
      try {
        // init SW and get key (will also setup UI wiring)
        await pushClient.init();

        // if user token present, attempt subscribe automatically but only if permission already granted
        if (localStorage.getItem('sTalk_token')) {
          // give app a small delay to finish validateToken
          setTimeout(async () => {
            if (Notification.permission === 'granted') {
              await pushClient.subscribe().catch(()=>{});
            } else {
              // If default and on iOS, show a CTA in settings instead of auto-requesting
              if (isIOS() && shouldShowIOSInstructions()) {
                const showBtn = document.getElementById(SHOW_IOS_BTN_ID);
                if (showBtn) showBtn.style.display = 'inline-block';
                // Optionally show modal immediately if user not in browser: don't auto show to avoid surprise
              } else {
                // For non-iOS or where permissions can be requested, we can try to request once
                // but prefer user action. So only request if push toggle is checked (handled by UI)
              }
            }
          }, 1200);
        }
      } catch (e) {
        console.warn('pushClient auto-init failed', e);
      }
    })();
  });

})();
