// public/push-client.js
// Push client for sTalk - registers service worker, subscribes and posts subscription to server
// Enhanced with iOS instructions modal, settings wiring, safer permission flow, token-queueing.

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
    const padding = '='.repeat((4 - (base64String?.length || 0) % 4) % 4);
    const base64 = (base64String || '') + padding;
    const safe = base64.replace(/\-/g, '+').replace(/_/g, '/');
    try {
      const rawData = atob(safe);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }
      return outputArray;
    } catch (e) {
      throw new Error('Invalid base64 string for VAPID key');
    }
  }

  function isIOS() {
    return /iP(hone|od|ad)/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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
        try { localStorage.setItem(IOS_MODAL_KEY, '1'); } catch (e) {}
      }
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      closeBtn && closeBtn.removeEventListener('click', closeModal);
      openSafariBtn && openSafariBtn.removeEventListener('click', openSafari);
    }

    function openSafari() {
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
    try {
      if (localStorage.getItem(IOS_MODAL_KEY) === '1') return false;
    } catch (e) { /* ignore */ }
    return typeof Notification !== 'undefined' && Notification.permission !== 'granted';
  }

  // Helper to safely read token from common places
  function getAuthToken() {
    try {
      if (window.app && window.app.token) return window.app.token;
      if (window.authToken) return window.authToken;
      const t = localStorage.getItem('sTalk_token');
      if (t) return t;
    } catch (e) {
      // localStorage may throw in some contexts; ignore
    }
    return null;
  }

  const pushClient = {
    registration: null,
    applicationServerKey: null,
    subscription: null,
    serverPushAvailable: false,
    _initialized: false,

    // internal queued subscription if token missing when trying to post
    _queuedSubscription: null,
    // internal cached token (optional) if set via setAuthToken()
    _authToken: null,

    // Expose method to set token manually (call from app after login)
    setAuthToken(token) {
      try {
        this._authToken = token;
        // also set a global for compatibility
        try { window.authToken = token; } catch (e) {}
        // flush queued subscription if any
        if (this._queuedSubscription) {
          this._flushQueuedSubscription().catch((e) => console.warn('flushQueuedSubscription error', e));
        }
      } catch (e) {
        console.warn('setAuthToken error', e);
      }
    },

    async _flushQueuedSubscription() {
      if (!this._queuedSubscription) return;
      // attempt to post queued subscription now that token is available
      try {
        await this.postSubscription(this._queuedSubscription);
      } catch (e) {
        console.warn('Failed flushing queued subscription', e);
      } finally {
        this._queuedSubscription = null;
      }
    },

    // Prevent double-init
    async init() {
      if (this._initialized) return;
      this._initialized = true;

      this.setupUI();

      // Basic support checks
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
        console.info('Push not supported in this browser');
        this.updatePermissionUI();
        return;
      }

      // Register SW or find existing registration
      try {
        try {
          this.registration = await navigator.serviceWorker.register(SW_PATH, { scope: REQ_SCOPE });
          console.info('Service Worker registered', this.registration && this.registration.scope);
        } catch (regErr) {
          // fallback: try to locate any existing registration
          console.warn('SW register warning, attempting to locate existing registration:', regErr && regErr.message ? regErr.message : regErr);
          try {
            this.registration = await navigator.serviceWorker.getRegistration(REQ_SCOPE);
            if (!this.registration) {
              const allRegs = await navigator.serviceWorker.getRegistrations();
              this.registration = (allRegs && allRegs.length) ? allRegs[0] : null;
            }
            if (this.registration) console.info('Found existing Service Worker registration', this.registration.scope);
          } catch (e) {
            console.warn('Failed to find existing SW registration', e);
            this.registration = null;
          }
        }

        // Listen for SW messages safely
        try {
          if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
            navigator.serviceWorker.addEventListener('message', (ev) => {
              try {
                const payload = ev && ev.data ? ev.data : null;
                const type = payload && payload.type ? payload.type : null;
                const data = payload && payload.data ? payload.data : null;

                if (type === 'notification-click') {
                  if (window.app && typeof window.app.showToast === 'function') window.app.showToast('🔔 Notification clicked', 'info');
                  if (data && data.url && window.app && typeof window.app.handleNotificationClick === 'function') {
                    try { window.app.handleNotificationClick(data); } catch (e) { console.warn('handleNotificationClick error', e); }
                  }
                }

                if (type === 'pushsubscriptionchange') {
                  console.info('Push subscription changed message received from SW - attempting re-subscribe');
                  this.subscribe(true).catch(()=>{});
                }
              } catch (e) {
                console.warn('SW message handler error', e);
              }
            });
          }
        } catch (e) {
          console.warn('Failed to attach serviceWorker message listener', e);
        }

        // Fetch VAPID public key from server
        try {
          const r = await fetch(API_KEY_ENDPOINT, { credentials: 'same-origin' });
          let json = null;
          if (r.ok) {
            try { json = await r.json(); } catch (e) { json = null; }
          }

          if (r.ok && json && typeof json.publicKey === 'string' && json.publicKey.trim()) {
            try {
              this.applicationServerKey = urlBase64ToUint8Array(json.publicKey.trim());
              this.serverPushAvailable = true;
            } catch (e) {
              console.warn('Invalid publicKey from server - disabling server push', e);
              this.applicationServerKey = null;
              this.serverPushAvailable = false;
            }
          } else {
            this.applicationServerKey = null;
            this.serverPushAvailable = false;
            console.info('Push not enabled on server or publicKey missing');
          }
        } catch (err) {
          console.warn('Failed to fetch VAPID key from server', err);
          this.serverPushAvailable = false;
        }

        // Check existing subscription and post it if present
        try {
          if (this.registration && this.registration.pushManager) {
            const existing = await this.registration.pushManager.getSubscription();
            if (existing) {
              this.subscription = existing;
              // If there's a token now, post; otherwise queue
              await this.postSubscription(existing).catch(()=>{});
            }
          }
        } catch (e) {
          console.warn('Error checking existing subscription', e);
        }

        this.updatePermissionUI();

        if (shouldShowIOSInstructions()) {
          const showBtn = document.getElementById(SHOW_IOS_BTN_ID);
          if (showBtn) showBtn.style.display = 'inline-block';
        }

      } catch (err) {
        console.error('Push init unexpected error', err);
        this.updatePermissionUI();
      }

      // Start watching for token changes (storage event + same-tab poll)
      this._startTokenWatcher();
    },

    setupUI() {
      try {
        const enablePushToggle = document.getElementById(ENABLE_PUSH_TOGGLE_ID);
        const requestBtn = document.getElementById(REQUEST_BTN_ID);
        const showIOSBtn = document.getElementById(SHOW_IOS_BTN_ID);
        this.updatePermissionUI();

        if (enablePushToggle) {
          enablePushToggle.checked = (typeof Notification !== 'undefined' && Notification.permission === 'granted' && !!this.subscription && this.serverPushAvailable);
          enablePushToggle.addEventListener('change', async () => {
            try {
              if (enablePushToggle.checked) {
                const ok = await this.requestPermission();
                if (!ok) {
                  enablePushToggle.checked = false;
                  this.updatePermissionUI();
                  return;
                }
                if (!this.serverPushAvailable) {
                  alert('Push notifications are not enabled on the server.');
                  enablePushToggle.checked = false;
                  this.updatePermissionUI();
                  return;
                }
                await this.init();
                await this.subscribe(true);
              } else {
                await this.unsubscribe();
              }
            } catch (e) {
              console.warn('Push toggle handler error', e);
            } finally {
              this.updatePermissionUI();
            }
          });
        }

        if (requestBtn) {
          requestBtn.style.display = 'none';
          requestBtn.addEventListener('click', async () => {
            const ok = await this.requestPermission();
            this.updatePermissionUI();
            if (ok) {
              try {
                if (getAuthToken()) {
                  await this.init();
                  if (this.serverPushAvailable) await this.subscribe(true).catch(()=>{});
                } else {
                  // no token yet - ensure init runs and subscription queued until token available
                  await this.init();
                }
              } catch (e) {
                console.warn('requestBtn handler error', e);
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
            pushDesc.textContent = this.serverPushAvailable ? 'Permission granted — push enabled' : 'Permission granted — server push disabled';
            if (requestBtn) requestBtn.style.display = 'none';
            if (showIOSBtn) showIOSBtn.style.display = 'none';
            if (enablePushToggle) enablePushToggle.checked = !!(this.subscription && this.serverPushAvailable);
            if (enablePushToggle) enablePushToggle.disabled = !this.serverPushAvailable;
          } else if (state === 'denied') {
            pushDesc.textContent = 'Notifications blocked — open Settings to re-enable';
            if (requestBtn) requestBtn.style.display = 'none';
            if (showIOSBtn) {
              showIOSBtn.style.display = isIOS() ? 'inline-block' : 'none';
            }
            if (enablePushToggle) { enablePushToggle.checked = false; enablePushToggle.disabled = false; }
          } else if (state === 'default') {
            pushDesc.textContent = 'Permission not requested yet';
            if (requestBtn) requestBtn.style.display = 'inline-block';
            if (showIOSBtn) showIOSBtn.style.display = isIOS() ? 'inline-block' : 'none';
            if (enablePushToggle) { enablePushToggle.checked = false; enablePushToggle.disabled = false; }
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
        console.warn('Service Worker not registered - cannot subscribe');
        return null;
      }
      if (!this.applicationServerKey) {
        console.warn('No applicationServerKey configured; cannot subscribe');
        return null;
      }

      if (!force && Notification.permission !== 'granted') {
        const ok = await this.requestPermission();
        if (!ok) {
          console.warn('Notification permission denied');
          this.updatePermissionUI();
          return null;
        }
      }

      try {
        const existing = await this.registration.pushManager.getSubscription();
        if (existing && !force) {
          this.subscription = existing;
          await this.postSubscription(existing).catch(()=>{});
          this.updatePermissionUI();
          return existing;
        }

        const sub = await this.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.applicationServerKey
        });

        this.subscription = sub;
        console.info('Push subscribed', sub);
        await this.postSubscription(sub).catch(()=>{});
        this.updatePermissionUI();
        return sub;
      } catch (err) {
        console.error('Failed to subscribe to push', err);
        if (window.app && typeof window.app.showToast === 'function') window.app.showToast('🔕 Push subscription failed', 'error');
        this.updatePermissionUI();
        return null;
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
        await this.postUnsubscribe(sub).catch(()=>{});
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

    // Posts subscription to server, but queues it if no auth token present
    async postSubscription(subscription) {
      try {
        const token = this._authToken || getAuthToken();
        if (!token) {
          // queue for later when token becomes available
          console.info('No auth token available — queuing subscription to post when token available');
          this._queuedSubscription = subscription;
          return;
        }

        const body = { subscription };
        const resp = await fetch(SUBSCRIBE_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(body)
        });

        if (!resp.ok) {
          const txt = await resp.text().catch(()=>null);
          console.warn('Server did not accept subscription', resp.status, txt);
          if (resp.status === 403 || resp.status === 400 || resp.status === 503) {
            if (window.app && typeof window.app.showToast === 'function') window.app.showToast('🔕 Server rejected push subscription', 'error');
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
        const token = this._authToken || getAuthToken();
        const endpoint = subscription && (subscription.endpoint || (subscription.toJSON && subscription.toJSON().endpoint));
        if (!token || !endpoint) {
          // can't notify server if missing token or endpoint
          return;
        }
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
    },

    // Internal: watch for token changes (storage event + same-tab poll)
    _startTokenWatcher() {
      // storage event: cross-tab token updates
      try {
        window.addEventListener('storage', (ev) => {
          try {
            if (!ev) return;
            if (ev.key === 'sTalk_token') {
              const newToken = ev.newValue;
              if (newToken) {
                this.setAuthToken(newToken);
              }
            }
          } catch (e) {}
        });
      } catch (e) {}

      // same-tab writes to localStorage do not trigger storage event; poll for token changes (cheap)
      try {
        if (!window.__stalk_push_token_poll) {
          window.__stalk_push_token_poll = setInterval(() => {
            try {
              const tk = getAuthToken();
              if (tk) {
                // if we haven't cached it yet, set and flush queued
                if (!this._authToken) {
                  this.setAuthToken(tk);
                }
              }
            } catch (e) {}
          }, 400);
        }
      } catch (e) {}
    }
  };

  // expose
  window.pushClient = pushClient;

  // Auto-init after DOM ready (non-blocking)
  document.addEventListener('DOMContentLoaded', () => {
    (async () => {
      try {
        // If token already present, set internal token early so postSubscription can run immediately
        const tok = getAuthToken();
        if (tok) {
          pushClient.setAuthToken(tok);
        }

        await pushClient.init();

        // If user already logged in and permission granted, attempt subscribe shortly after init
        if (getAuthToken()) {
          setTimeout(async () => {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && pushClient.serverPushAvailable) {
              await pushClient.subscribe().catch(()=>{});
            } else {
              if (isIOS() && shouldShowIOSInstructions()) {
                const showBtn = document.getElementById(SHOW_IOS_BTN_ID);
                if (showBtn) showBtn.style.display = 'inline-block';
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
