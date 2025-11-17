// public/app.js
// sTalk - Enhanced App with Media Previews, Link Previews, Unread Counters + Push/Sound controls
// --- Defensive: ensure a global app object exists before class definition (non-destructive) ---
window.app = window.app || {};
// Provide minimal safe defaults so other scripts can call them before instantiation
if (typeof window.app.init !== 'function') window.app.init = () => Promise.resolve();
if (typeof window.app.showMain !== 'function') window.app.showMain = () => {};
if (typeof window.app.showLogin !== 'function') window.app.showLogin = () => {};
if (typeof window.app.connect !== 'function') window.app.connect = () => {};
if (typeof window.app.postLogin !== 'function') window.app.postLogin = (t) => Promise.resolve();

class STalk {
    constructor() {
        this.API_BASE = window.location.origin + '/api';
        this.token = localStorage.getItem('sTalk_token');
        this.currentUser = null;
        this.selectedUserId = null;
        this.socket = null;
        this.isTyping = false;
        this.typingTimeout = null;
        this.users = new Map();
        this.unreadCounts = new Map(); // Track unread messages per user
        this.currentTheme = localStorage.getItem('sTalk_theme') || 'light';
        this.isProcessingUserManagement = false;

        // lifecycle flags
        this.initialized = false;
        this.ready = false;

        // Push & sound settings
        this.pushEnabled = localStorage.getItem('sTalk_push_enabled') === 'true';
        // default sound enabled on desktop, disabled on small screens
        this.soundEnabled = localStorage.getItem('sTalk_sound_enabled');
        if (this.soundEnabled === null) {
            this.soundEnabled = (window.innerWidth > 768);
            localStorage.setItem('sTalk_sound_enabled', this.soundEnabled ? 'true' : 'false');
        } else {
            this.soundEnabled = this.soundEnabled === 'true';
        }

        // Expose a safe handle to receive SW messages (may be replaced later)
        window.app = window.app || {};
        window.app.handleServiceWorkerMessage = window.app.handleServiceWorkerMessage || ((d) => { if (d) console.debug('SW msg', d); });

        // Defer initialization until DOM ready (constructor may be called earlier)
        document.addEventListener('DOMContentLoaded', () => {
            // assign this instance as global app object (non-destructive)
            try {
                // If something else already set window.app to a full STalk instance, keep it.
                if (!(window.app instanceof STalk)) {
                    window.app = this;
                } else {
                    // merge properties into existing instance if needed
                    Object.assign(window.app, this);
                }
            } catch (e) { console.warn('assign global app failed', e); }

            // Bind lifecycle aliases so other scripts can call these names
            try {
                // Defensive binding: only bind if functions exist on the instance; otherwise keep fallback
                if (typeof this.initializeApp === 'function') {
                    window.app.init = this.initializeApp.bind(this);
                }
                if (typeof this.showMain === 'function') {
                    window.app.showMain = this.showMain.bind(this);
                } else if (typeof window.app.showMain !== 'function') {
                    window.app.showMain = () => {};
                }
                if (typeof this.showLogin === 'function') {
                    window.app.showLogin = this.showLogin.bind(this);
                }
                if (typeof this.connectSocket === 'function') {
                    window.app.connect = this.connectSocket.bind(this);
                }
                if (typeof this.postLogin === 'function') {
                    window.app.postLogin = this.postLogin.bind(this);
                }
                // flags
                window.app.ready = this.ready;
                window.app.initialized = this.initialized;
            } catch (e) { console.warn('binding aliases failed', e); }

            // call initialization methods (constructor internal initialization)
            // These methods are already defined in this class and safe to call here.
            try {
                this.initializeApp();
            } catch (e) { console.warn('initializeApp call failed', e); }
            try {
                this.setupEventListeners();
            } catch (e) { console.warn('setupEventListeners call failed', e); }
            try {
                this.applyTheme(this.currentTheme);
            } catch (e) { console.warn('applyTheme call failed', e); }

            // expose SW message handler for index.html forwarding and external calls
            window.app.handleServiceWorkerMessage = this.handleServiceWorkerMessage.bind(this);
        });
    }

    // Post-login helper used by external fallbacks
    async postLogin(token) {
        try {
            if (!token) token = localStorage.getItem('sTalk_token');
            if (!token) return Promise.reject(new Error('no-token'));

            this.token = token;
            localStorage.setItem('sTalk_token', token);

            // try to validate token and load app
            const valid = await this.validateToken();
            if (valid) {
                await this.loadMainApp();
                return Promise.resolve();
            } else {
                this.showLogin();
                return Promise.reject(new Error('invalid-token'));
            }
        } catch (e) {
            console.warn('postLogin error', e);
            this.showLogin();
            return Promise.reject(e);
        }
    }

    async initializeApp() {
        this.showLoading();
        // mark initialized early so other scripts know init started
        this.initialized = true;
        try {
            // Wire fallback listener for CustomEvent 'swmessage' (index.html uses this)
            window.addEventListener('swmessage', (ev) => {
                try {
                    this.handleServiceWorkerMessage(ev.detail);
                } catch (e) { /* ignore */ }
            });

            // If token exists when app loads, try to validate and load main app
            this.token = this.token || localStorage.getItem('sTalk_token');
            if (this.token) {
                const isValid = await this.validateToken();
                if (isValid) {
                    await this.loadMainApp();
                    this.ready = true;
                } else {
                    this.showLogin();
                    this.ready = false;
                }
            } else {
                this.showLogin();
                this.ready = false;
            }
        } catch (e) {
            console.error('initializeApp error', e);
            this.showLogin();
            this.ready = false;
        } finally {
            this.hideLoading();
            // reflect flags on global app object too
            try { window.app.ready = this.ready; window.app.initialized = this.initialized; } catch (e) {}
        }
    }

    setupEventListeners() {
        // Helper to safely attach listeners
        const on = (id, evt, cb) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(evt, cb);
            return el;
        };

        // Login form
        const loginForm = document.getElementById('loginForm');
        if (loginForm) {
            loginForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleLogin();
            });
        }

        // Settings modal
        on('settingsBtn', 'click', () => this.showSettings());
        on('closeSettings', 'click', () => this.hideSettings());

        // Theme toggle
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) {
            themeToggle.addEventListener('change', (e) => {
                this.toggleTheme();
            });
        }

        // Push toggle (settings UI element with id enablePushToggle is optional)
        const pushToggle = document.getElementById('enablePushToggle');
        if (pushToggle) {
            // initialize UI state (may be overwritten by initPush later)
            pushToggle.checked = !!this.pushEnabled;
            pushToggle.addEventListener('change', async (e) => {
                try {
                    if (e.target.checked) {
                        await this.enablePush();
                    } else {
                        await this.disablePush();
                    }
                    // refresh UI after attempt
                    await this.refreshPushToggleState();
                } catch (err) {
                    console.error('Push toggle error', err);
                    // revert UI change on error
                    e.target.checked = !e.target.checked;
                }
            });
        }

        // Request permission button (explicit request)
        const requestPermissionBtn = document.getElementById('requestPermissionBtn');
        if (requestPermissionBtn) {
            requestPermissionBtn.addEventListener('click', async () => {
                const perm = await this.requestNotificationPermission();
                await this.refreshPushToggleState();
                this.updatePushPermissionDescription();
                if (perm === 'granted') this.showToast('✅ Notifications allowed', 'success'); else if (perm === 'denied') this.showToast('❌ Notifications blocked', 'error');
            });
        }

        // Show iOS instructions button (opens the modal)
        const showIOSInstructionsBtn = document.getElementById('showIOSInstructionsBtn');
        if (showIOSInstructionsBtn) {
            showIOSInstructionsBtn.addEventListener('click', () => {
                const modal = document.getElementById('iosInstructionModal');
                if (modal) modal.classList.add('show');
            });
        }

        // iOS modal close & open safari
        const iosCloseBtn = document.getElementById('iosCloseBtn');
        if (iosCloseBtn) iosCloseBtn.addEventListener('click', () => {
            const modal = document.getElementById('iosInstructionModal');
            if (modal) modal.classList.remove('show');
        });
        const iosOpenSafariBtn = document.getElementById('iosOpenSafariBtn');
        if (iosOpenSafariBtn) iosOpenSafariBtn.addEventListener('click', () => {
            try { window.open(window.location.href, '_blank'); } catch (e) {}
        });
        const iosDontShowAgain = document.getElementById('iosDontShowAgain');
        if (iosDontShowAgain) {
            iosDontShowAgain.addEventListener('change', (e) => {
                if (e.target.checked) localStorage.setItem('sTalk_ios_instructions_dont_show', '1');
            });
        }

        // Sound toggle
        const soundToggle = document.getElementById('enableSoundToggle');
        if (soundToggle) {
            soundToggle.checked = !!this.soundEnabled;
            soundToggle.addEventListener('change', (e) => {
                this.soundEnabled = !!e.target.checked;
                localStorage.setItem('sTalk_sound_enabled', this.soundEnabled ? 'true' : 'false');
                this.showToast(this.soundEnabled ? '🔔 Sound enabled' : '🔕 Sound disabled', 'info');
            });
        }

        // Settings buttons
        on('changePasswordBtn', 'click', () => this.handleChangePassword());
        on('adminStatsBtn', 'click', () => this.loadAdminStats());
        on('userManagementBtn', 'click', () => this.showUserManagement());
        on('logoutBtn', 'click', () => this.handleLogout());

        // Quick dropdown actions
        on('quickSettingsItem', 'click', () => this.showSettings());
        on('quickLogoutItem', 'click', () => this.handleLogout());

        // Profile picture upload
        const profileImageUpload = document.getElementById('profileImageUpload');
        if (profileImageUpload) {
            profileImageUpload.addEventListener('change', (e) => {
                this.handleProfileImageUpload(e.target.files[0]);
            });
        }

        const profileAvatarLarge = document.getElementById('profileAvatarLarge');
        if (profileAvatarLarge) {
            profileAvatarLarge.addEventListener('click', () => {
                const input = document.getElementById('profileImageUpload');
                if (input) input.click();
            });
        }

        // File upload
        const fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                this.handleFileUpload(e.target.files);
            });
        }

        const attachBtn = document.getElementById('attachBtn');
        if (attachBtn) {
            attachBtn.addEventListener('click', () => {
                const fi = document.getElementById('fileInput');
                if (fi) fi.click();
            });
        }

        // Message input
        const messageInput = document.getElementById('messageInput');
        if (messageInput) {
            messageInput.addEventListener('input', (e) => {
                this.autoResizeTextarea(e.target);
                this.updateSendButton();
                this.handleTyping();
            });

            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage();
                }
            });
        }

        // Send button
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) {
            sendBtn.addEventListener('click', () => {
                this.sendMessage();
            });
        }

        // User menu
        const userAvatar = document.getElementById('userAvatar');
        if (userAvatar) {
            userAvatar.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleUserDropdown();
            });
        }

        // User search
        const userSearch = document.getElementById('userSearch');
        if (userSearch) {
            userSearch.addEventListener('input', (e) => {
                this.filterUsers(e.target.value);
            });
        }

        // Back button
        on('backBtn', 'click', () => this.showChatList());

        // Global click handlers
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.user-menu')) {
                const dd = document.getElementById('userDropdown');
                if (dd) dd.classList.remove('show');
            }
        });

        // Settings modal backdrop click
        const settingsModal = document.getElementById('settingsModal');
        if (settingsModal) {
            settingsModal.addEventListener('click', (e) => {
                if (e.target.id === 'settingsModal') {
                    this.hideSettings();
                }
            });
        }

        // Drag and drop for files
        this.setupDragDrop();

        // Window resize
        window.addEventListener('resize', () => {
            this.handleResize();
        });

        // Listen for messages from service worker (notification click deep-links)
        if ('serviceWorker' in navigator) {
            try {
                navigator.serviceWorker.addEventListener('message', (ev) => {
                    try {
                        if (ev && ev.data && ev.data.type === 'notification-click') {
                            // Data should contain { chatId, sender, url }
                            this.handleNotificationClick(ev.data.data || {});
                        }
                    } catch (e) { /* ignore */ }
                });
            } catch (e) {
                // Some environments may not support direct addEventListener on navigator.serviceWorker
                // fallback: nothing critical here
            }
        }
    }

    // Provide a SW message handler for index.html forwarding and other callers
    handleServiceWorkerMessage(data) {
        try {
            if (!data) return;
            // Common patterns: { type: 'notification-click', data: {...} } or custom types
            if (data.type === 'notification-click') {
                this.handleNotificationClick(data.data || {});
            } else if (data.type === 'pushsubscriptionchange') {
                // Re-sync push subscription if available
                this.refreshPushToggleState().catch(()=>{});
            } else if (data && data.chatId) {
                // Generic message with chatId
                this.handleNotificationClick(data);
            } else {
                // emit a DOM event so other parts of app (or index.html) can react
                const ev = new CustomEvent('app-sw-message', { detail: data });
                window.dispatchEvent(ev);
            }
        } catch (e) {
            console.warn('handleServiceWorkerMessage error', e);
        }
    }

    // Theme Management
    applyTheme(theme) {
        document.body.setAttribute('data-theme', theme);
        const themeToggle = document.getElementById('themeToggle');
        if (themeToggle) themeToggle.checked = theme === 'dark';
        localStorage.setItem('sTalk_theme', theme);
        this.currentTheme = theme;
    }

    toggleTheme() {
        const newTheme = this.currentTheme === 'light' ? 'dark' : 'light';
        this.applyTheme(newTheme);
        // Only show toast on desktop
        if (window.innerWidth > 768) {
            this.showToast(`🌙 Switched to ${newTheme} mode`, 'success');
        }
    }

    // Settings Modal Management
    showSettings() {
        const settingsModal = document.getElementById('settingsModal');
        if (settingsModal) settingsModal.classList.add('show');

        if (this.currentUser && this.currentUser.role === 'Admin') {
            const adminSection = document.getElementById('adminSection');
            if (adminSection) adminSection.style.display = 'block';
        }

        // ensure push/sound toggles reflect current state (if present)
        const pushToggle = document.getElementById('enablePushToggle');
        if (pushToggle) {
            // refresh actual state (permission + subscription)
            this.refreshPushToggleState().catch(()=>{});
        }
        const soundToggle = document.getElementById('enableSoundToggle');
        if (soundToggle) soundToggle.checked = !!this.soundEnabled;

        const avatarLarge = document.getElementById('profileAvatarLarge');
        if (this.currentUser && avatarLarge) {
            if (this.currentUser.profileImage) {
                avatarLarge.style.backgroundImage = `url(${this.currentUser.profileImage})`;
                avatarLarge.textContent = '';
            } else {
                avatarLarge.style.backgroundImage = '';
                avatarLarge.textContent = this.currentUser.avatar || 'A';
            }
        }

        // update push permission description text
        this.updatePushPermissionDescription();
    }

    hideSettings() {
        const settingsModal = document.getElementById('settingsModal');
        if (settingsModal) settingsModal.classList.remove('show');
    }

    updatePushPermissionDescription() {
        const el = document.getElementById('pushPermissionDescription');
        if (!el) return;
        if (!('Notification' in window)) {
            el.textContent = 'Push notifications not supported by this browser';
            return;
        }
        if (Notification.permission === 'granted') {
            el.textContent = 'Push notifications are enabled';
        } else if (Notification.permission === 'denied') {
            el.textContent = 'Notifications are blocked in browser settings';
        } else {
            el.textContent = 'Receive push notifications on this device';
        }
    }

    // Notification click handler (deep-link)
    async handleNotificationClick(data) {
        // data: { chatId, sender, url }
        // Prefer sender -> find user by username
        try {
            if (data.sender) {
                const found = Array.from(this.users.values()).find(u => u.username === data.sender);
                if (found) {
                    await this.selectUser(found.id);
                    window.focus();
                    return;
                }
            }

            // fallback: if chatId provided, try to deduce username from chatId
            if (data.chatId) {
                // chatId format created by server: userA_userB (alphabetical). Find other participant
                const parts = String(data.chatId).split('_');
                const other = parts.find(p => p !== this.currentUser?.username);
                if (other) {
                    const found = Array.from(this.users.values()).find(u => u.username === other);
                    if (found) {
                        await this.selectUser(found.id);
                        window.focus();
                        return;
                    }
                }
            }

            // fallback to open provided url or root
            if (data.url) {
                window.open(data.url, '_self');
            } else {
                window.open('/', '_self');
            }
        } catch (e) {
            console.warn('handleNotificationClick error', e);
        }
    }

    // User Management - Same as before (unchanged)
    showUserManagement() {
        if (this.isProcessingUserManagement) return;
        this.isProcessingUserManagement = true;

        if (!this.currentUser || this.currentUser.role !== 'Admin') {
            this.showToast('❌ Admin access required', 'error');
            this.isProcessingUserManagement = false;
            return;
        }

        this.loadUserManagementInterface();
    }

    async loadUserManagementInterface() {
        try {
            const response = await fetch(`${this.API_BASE}/admin/users`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const users = await response.json();
                this.showUserManagementModal(users);
            } else {
                this.showToast('❌ Failed to load user management', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        } finally {
            this.isProcessingUserManagement = false;
        }
    }

    showUserManagementModal(users) {
        const existingModal = document.getElementById('userManagementModal');
        if (existingModal) existingModal.remove();

        const modalHTML = `
            <div id="userManagementModal" class="settings-modal show">
                <div class="settings-content" style="max-width: 700px;">
                    <div class="settings-header">
                        <h2 class="settings-title">👥 User Management</h2>
                        <button class="close-btn" onclick="app.closeUserManagement()">×</button>
                    </div>

                    <div class="settings-section">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                            <h3 class="settings-section-title">Users (${users.length})</h3>
                            <button class="btn-secondary" onclick="app.showAddUserForm()" style="width: auto; margin: 0;">
                                ➕ Add User
                            </button>
                        </div>

                        <div class="user-management-list">
                            ${users.map(user => `
                                <div class="user-management-item" data-user-id="${user.id}">
                                    <div class="user-avatar-small" style="${user.profileImage ? `background-image: url(${user.profileImage});` : `background: #3b82f6; color: white;`}">
                                        ${!user.profileImage ? user.avatar : ''}
                                    </div>
                                    <div class="user-info">
                                        <div class="user-name">${user.fullName}</div>
                                        <div class="user-details">@${user.username} • ${user.role} • ${user.isOnline ? '🟢 Online' : '⚪ Offline'}</div>
                                    </div>
                                    <div class="user-actions">
                                        ${user.id !== this.currentUser.id ? `
                                            <button class="action-btn edit" onclick="app.editUser(${user.id})" title="Edit User">✏️</button>
                                            <button class="action-btn reset" onclick="app.resetUserPassword(${user.id})" title="Reset Password">🔑</button>
                                            <button class="action-btn delete" onclick="app.deleteUser(${user.id})" title="Delete User">🗑️</button>
                                        ` : `
                                            <span style="color: var(--text-secondary); font-size: 0.875rem;">Current User</span>
                                        `}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <div class="settings-section">
                        <h3 class="settings-section-title">Quick Actions</h3>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
                            <button class="btn-secondary" onclick="app.bulkResetPasswords()">
                                🔄 Reset All Passwords
                            </button>
                            <button class="btn-secondary" onclick="app.exportUserData()">
                                📊 Export User Data
                            </button>
                            <button class="btn-secondary" onclick="app.clearAllChats()" style="color: var(--error); border-color: var(--error);">
                                🧹 Clear All Chats
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // User Management Actions - Same as before
    async editUser(userId) {
        const user = Array.from(this.users.values()).find(u => u.id === userId);
        if (!user) return;

        const newName = prompt(`📝 Edit full name for @${user.username}:`, user.fullName);
        if (!newName || newName === user.fullName) return;

        try {
            const response = await fetch(`${this.API_BASE}/admin/users/${userId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ fullName: newName })
            });

            if (response.ok) {
                this.showToast(`✅ Updated ${user.username}`, 'success');
                this.loadUserManagementInterface();
            } else {
                this.showToast('❌ Failed to update user', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    async resetUserPassword(userId) {
        const user = Array.from(this.users.values()).find(u => u.id === userId);
        if (!user) return;

        if (!confirm(`🔑 Reset password for @${user.username}?\n\nA temporary password will be generated.`)) return;

        try {
            const response = await fetch(`${this.API_BASE}/admin/users/${userId}/reset-password`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const { tempPassword } = await response.json();
                alert(`🔑 Password Reset\n\nUser: @${user.username}\nTemporary Password: ${tempPassword}\n\nPlease share this securely with the user.`);
                this.showToast(`✅ Password reset for ${user.username}`, 'success');
            } else {
                this.showToast('❌ Failed to reset password', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    async deleteUser(userId) {
        const user = Array.from(this.users.values()).find(u => u.id === userId);
        if (!user) return;

        const confirmed = confirm(`⚠️ Delete User: @${user.username}\n\nThis will permanently delete:\n• User account\n• All their messages\n• All their files\n\nThis action cannot be undone!`);
        if (!confirmed) return;

        const doubleConfirm = prompt(`Type "DELETE ${user.username}" to confirm deletion:`);
        if (doubleConfirm !== `DELETE ${user.username}`) {
            this.showToast('❌ Deletion cancelled - confirmation text did not match', 'error');
            return;
        }

        try {
            const response = await fetch(`${this.API_BASE}/admin/users/${userId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                this.showToast(`✅ Deleted user ${user.username}`, 'success');
                this.loadUserManagementInterface();
                await this.loadUsers();
            } else {
                this.showToast('❌ Failed to delete user', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    showAddUserForm() {
        const username = prompt('👤 Enter username (3-20 characters):');
        if (!username || username.length < 3 || username.length > 20) {
            if (username) this.showToast('❌ Username must be 3-20 characters', 'error');
            return;
        }

        const fullName = prompt('📝 Enter full name:');
        if (!fullName) return;

        const password = prompt('🔐 Enter password (4-12 characters):');
        if (!password || password.length < 4 || password.length > 12) {
            if (password) this.showToast('❌ Password must be 4-12 characters', 'error');
            return;
        }

        const role = confirm('👑 Should this user be an Admin?\n\nClick OK for Admin, Cancel for regular User') ? 'Admin' : 'User';

        this.createUser({ username, fullName, password, role });
    }

    async createUser(userData) {
        try {
            const response = await fetch(`${this.API_BASE}/admin/users`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify(userData)
            });

            if (response.ok) {
                this.showToast(`✅ Created user @${userData.username}`, 'success');
                this.loadUserManagementInterface();
                await this.loadUsers();
            } else {
                const error = await response.json();
                this.showToast(`❌ ${error.error || 'Failed to create user'}`, 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    async bulkResetPasswords() {
        if (!confirm('🔄 Reset passwords for ALL users?\n\nTemporary passwords will be generated for all users except you.')) return;

        try {
            const response = await fetch(`${this.API_BASE}/admin/bulk-reset-passwords`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const { resetUsers } = await response.json();
                const resetList = resetUsers.map(u => `@${u.username}: ${u.tempPassword}`).join('\n');
                alert(`🔑 Bulk Password Reset Complete\n\n${resetList}\n\nPlease share these securely with users.`);
                this.showToast(`✅ Reset ${resetUsers.length} passwords`, 'success');
            } else {
                this.showToast('❌ Failed to reset passwords', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    async exportUserData() {
        try {
            const response = await fetch(`${this.API_BASE}/admin/export`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                const exportData = JSON.stringify(data, null, 2);
                const blob = new Blob([exportData], { type: 'application/json' });
                const url = URL.createObjectURL(blob);

                const a = document.createElement('a');
                a.href = url;
                a.download = `stalk-export-${new Date().toISOString().split('T')[0]}.json`;
                a.click();

                URL.revokeObjectURL(url);
                this.showToast('✅ User data exported', 'success');
            } else {
                this.showToast('❌ Failed to export data', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    async clearAllChats() {
        if (!confirm('🧹 Clear ALL chat messages?\n\nThis will permanently delete all messages and files from all users.\n\nThis action cannot be undone!')) return;

        const confirmation = prompt('Type "CLEAR ALL CHATS" to confirm:');
        if (confirmation !== 'CLEAR ALL CHATS') {
            this.showToast('❌ Action cancelled', 'error');
            return;
        }

        try {
            const response = await fetch(`${this.API_BASE}/admin/clear-chats`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                this.showToast('✅ All chats cleared', 'success');
                if (this.selectedUserId) {
                    await this.loadMessages(this.selectedUserId);
                }
            } else {
                this.showToast('❌ Failed to clear chats', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    closeUserManagement() {
        const modal = document.getElementById('userManagementModal');
        if (modal) modal.remove();
        this.isProcessingUserManagement = false;
    }

    // Profile Management
    async handleProfileImageUpload(file) {
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
            this.showToast('❌ Profile image must be under 5MB', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('profileImage', file);

        try {
            this.showToast('📷 Uploading profile image...', 'info');

            const response = await fetch(`${this.API_BASE}/profile/image`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                body: formData
            });

            if (response.ok) {
                const result = await response.json();
                if (this.currentUser) {
                    this.currentUser.profileImage = result.profileImage;
                    this.updateUserInterface();
                }
                this.showToast('✅ Profile image updated!', 'success');

                const avatarLarge = document.getElementById('profileAvatarLarge');
                if (avatarLarge) {
                    avatarLarge.style.backgroundImage = `url(${result.profileImage})`;
                    avatarLarge.textContent = '';
                }
            } else {
                const error = await response.json().catch(()=>({ error: 'Upload failed' }));
                this.showToast(`❌ ${error.error || 'Upload failed'}`, 'error');
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showToast('❌ Upload failed. Check connection.', 'error');
        }
    }

    // Avatar selection: safe implementation that doesn't rely on a passed event
    selectAvatar(type, value) {
        // mark matching option as selected (based on displayed value)
        document.querySelectorAll('.avatar-option').forEach(option => {
            option.classList.remove('selected');
            if ((option.textContent || '').trim() === (value || '').trim()) {
                option.classList.add('selected');
            }
        });

        this.updateAvatar(type, value);
    }

    async updateAvatar(type, value) {
        try {
            const response = await fetch(`${this.API_BASE}/profile/avatar`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ type, value })
            });

            if (response.ok) {
                if (this.currentUser) {
                    this.currentUser.avatar = value;
                    this.currentUser.profileImage = null;
                    this.updateUserInterface();
                }

                const avatarLarge = document.getElementById('profileAvatarLarge');
                if (avatarLarge) {
                    avatarLarge.style.backgroundImage = '';
                    avatarLarge.textContent = value;
                }

                this.showToast('✅ Avatar updated!', 'success');
            } else {
                this.showToast('❌ Failed to update avatar', 'error');
            }
        } catch (error) {
            this.showToast('❌ Failed to update avatar', 'error');
        }
    }

    setupDragDrop() {
        const messageContainer = document.getElementById('messagesContainer');
        if (!messageContainer) return;

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            messageContainer.addEventListener(eventName, this.preventDefaults, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            messageContainer.addEventListener(eventName, () => {
                messageContainer.classList.add('drag-over');
            }, false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            messageContainer.addEventListener(eventName, () => {
                messageContainer.classList.remove('drag-over');
            }, false);
        });

        messageContainer.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            this.handleFileUpload(files);
        }, false);
    }

    preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    async handleFileUpload(files) {
        if (!files || files.length === 0 || !this.selectedUserId) {
            if (!this.selectedUserId) {
                this.showToast('Please select a user to share files with', 'error');
            }
            return;
        }

        const maxFileSize = 50 * 1024 * 1024; // 50MB
        const maxFiles = 10;

        if (files.length > maxFiles) {
            this.showToast(`Maximum ${maxFiles} files allowed at once`, 'error');
            return;
        }

        const validFiles = Array.from(files).filter(file => {
            if (file.size > maxFileSize) {
                this.showToast(`${file.name} is too large (max 50MB)`, 'error');
                return false;
            }
            return true;
        });

        if (validFiles.length === 0) return;

        const formData = new FormData();
        validFiles.forEach(file => {
            formData.append('files', file);
        });

        try {
            this.showToast(`📤 Uploading ${validFiles.length} file(s)...`, 'info');

            const response = await fetch(`${this.API_BASE}/upload`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                body: formData
            });

            if (response.ok) {
                const { files: uploadedFiles } = await response.json();

                for (const file of uploadedFiles) {
                    await this.sendFileMessage(file);
                }

                this.showToast(`✅ ${uploadedFiles.length} file(s) shared successfully!`, 'success');
            } else {
                const error = await response.json().catch(()=>({ error: 'Upload failed' }));
                this.showToast(`❌ ${error.error || 'Upload failed'}`, 'error');
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showToast('❌ Upload failed. Please check your connection.', 'error');
        }

        const fileInput = document.getElementById('fileInput');
        if (fileInput) fileInput.value = '';
    }

    async sendFileMessage(fileInfo) {
        const fileContent = `📎 ${fileInfo.originalName}`;

        try {
            const response = await fetch(`${this.API_BASE}/chats/${this.selectedUserId}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    content: fileContent,
                    messageType: 'file',
                    fileInfo: {
                        path: fileInfo.path || fileInfo.filename || fileInfo.path,
                        originalName: fileInfo.originalName,
                        size: fileInfo.size,
                        mimeType: fileInfo.mimeType
                    }
                })
            });

            if (response.ok) {
                const message = await response.json();
                this.addMessageToUI(message, true);
            } else {
                console.warn('Failed to send file message');
            }
        } catch (error) {
            console.error('File message send error:', error);
        }
    }

    // Authentication methods - Same as before (with push init on successful login)
    async handleLogin() {
        const usernameEl = document.getElementById('loginUsername');
        const passwordEl = document.getElementById('loginPassword');

        const username = usernameEl ? usernameEl.value.trim() : '';
        const password = passwordEl ? passwordEl.value : '';

        if (!username || !password) {
            this.showAlert('Please enter both username and password', 'error');
            return;
        }

        this.setLoginLoading(true);

        try {
            const response = await fetch(`${this.API_BASE}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (response.ok) {
                this.token = data.token;
                this.currentUser = data.user;
                localStorage.setItem('sTalk_token', this.token);
                localStorage.setItem('sTalk_user', JSON.stringify(this.currentUser));

                // After login, call postLogin to centralize post-login behavior
                await this.postLogin(this.token);

                // Only show toast on desktop
                if (window.innerWidth > 768) {
                    this.showToast(`🎉 Welcome ${this.currentUser.fullName}!`, 'success');
                }
            } else {
                this.showAlert(data.error || 'Login failed', 'error');
            }
        } catch (error) {
            this.showAlert('Connection error. Please check your server.', 'error');
        } finally {
            this.setLoginLoading(false);
        }
    }

    async validateToken() {
        if (!this.token) return false;

        try {
            const response = await fetch(`${this.API_BASE}/auth/me`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                this.currentUser = await response.json();
                localStorage.setItem('sTalk_user', JSON.stringify(this.currentUser));
                return true;
            } else {
                localStorage.removeItem('sTalk_token');
                localStorage.removeItem('sTalk_user');
                this.token = null;
                return false;
            }
        } catch (error) {
            // Network errors - treat as invalid for now (allows user to re-login)
            return false;
        }
    }

    async handleChangePassword() {
        const currentPassword = prompt('🔑 Enter your current password:');
        if (!currentPassword) return;

        const newPassword = prompt('🔐 Enter new password (4-12 characters):');
        if (!newPassword) return;

        const confirmPassword = prompt('🔐 Confirm new password:');
        if (!confirmPassword) return;

        if (newPassword !== confirmPassword) {
            this.showToast('❌ Passwords do not match', 'error');
            return;
        }

        if (newPassword.length < 4 || newPassword.length > 12) {
            this.showToast('❌ Password must be 4-12 characters', 'error');
            return;
        }

        try {
            const response = await fetch(`${this.API_BASE}/auth/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({
                    currentPassword,
                    newPassword
                })
            });

            const data = await response.json();

            if (response.ok) {
                this.showToast('✅ Password changed successfully!', 'success');
            } else {
                this.showToast(`❌ ${data.error || 'Failed to change password'}`, 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    async loadAdminStats() {
        if (!this.currentUser || this.currentUser.role !== 'Admin') {
            this.showToast('❌ Admin access required', 'error');
            return;
        }

        try {
            const response = await fetch(`${this.API_BASE}/admin/stats`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const stats = await response.json();
                const statsText = `📊 System Statistics:\n\n` +
                    `👥 Total Users: ${stats.totalUsers || 0}\n` +
                    `💬 Total Messages: ${stats.totalMessages || 0}\n` +
                    `📁 Total Files: ${stats.totalFiles || 0}\n` +
                    `💾 Storage Used: ${this.formatFileSize(stats.totalFileSize || 0)}\n` +
                    `🔥 Active Chats: ${stats.activeChats || 0}\n` +
                    `🟢 Online Users: ${stats.onlineUsers || 0}`;

                alert(statsText);
            } else {
                this.showToast('❌ Failed to load stats', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error', 'error');
        }
    }

    async handleLogout() {
        try {
            await fetch(`${this.API_BASE}/auth/logout`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
        } catch (error) {
            // Ignore errors during logout
        }

        // If push subscription exists and we want to unsubscribe automatically, keep it manual for now.
        this.token = null;
        this.currentUser = null;
        this.selectedUserId = null;
        localStorage.removeItem('sTalk_token');
        localStorage.removeItem('sTalk_user');

        try {
            if (this.socket && this.socket.disconnect) {
                this.socket.disconnect();
            }
        } catch (e) {}

        this.hideSettings();
        this.closeUserManagement();
        this.showLogin();

        // Only show toast on desktop
        if (window.innerWidth > 768) {
            this.showToast('👋 Signed out successfully', 'info');
        }
    }

    // UI methods - FIXED LOADING SCREEN
    showLoading() {
        const loadingScreen = document.getElementById('loadingScreen');
        const mainApp = document.getElementById('mainApp');
        const loginScreen = document.getElementById('loginScreen');

        if (mainApp) mainApp.classList.add('d-none');
        if (loginScreen) loginScreen.classList.add('d-none');
        if (loadingScreen) loadingScreen.classList.remove('d-none');
    }

    hideLoading() {
        const loadingScreen = document.getElementById('loadingScreen');
        if (loadingScreen) loadingScreen.classList.add('d-none');
    }

    showLogin() {
        const loginScreen = document.getElementById('loginScreen');
        const mainApp = document.getElementById('mainApp');
        const loadingScreen = document.getElementById('loadingScreen');

        if (mainApp) mainApp.classList.add('d-none');
        if (loadingScreen) loadingScreen.classList.add('d-none');
        if (loginScreen) loginScreen.classList.remove('d-none');

        const loginUsername = document.getElementById('loginUsername');
        const loginPassword = document.getElementById('loginPassword');
        if (loginUsername) loginUsername.value = '';
        if (loginPassword) loginPassword.value = '';
        if (loginUsername) loginUsername.focus();

        // reflect flags
        this.ready = false;
        try { window.app.ready = this.ready; } catch (e) {}
    }

    async loadMainApp() {
        const loginScreen = document.getElementById('loginScreen');
        const mainApp = document.getElementById('mainApp');
        const loadingScreen = document.getElementById('loadingScreen');

        if (loginScreen) loginScreen.classList.add('d-none');
        if (loadingScreen) loadingScreen.classList.add('d-none');
        if (mainApp) mainApp.classList.remove('d-none');

        // load current user from local storage if not set
        try {
            if (!this.currentUser) {
                const saved = localStorage.getItem('sTalk_user');
                if (saved) this.currentUser = JSON.parse(saved);
            }
        } catch (e) {}

        this.updateUserInterface();

        // ensure socket connects with token if available
        this.connectSocket();

        await this.loadUsers();

        // initialize push registration UI + attempt (if previously enabled)
        await this.initPush();

        // mark ready
        this.ready = true;
        try { window.app.ready = true; } catch (e) {}
    }

    updateUserInterface() {
        const userName = document.getElementById('userName');
        const userUsername = document.getElementById('userUsername');
        if (userName && this.currentUser) userName.textContent = this.currentUser.fullName;
        if (userUsername && this.currentUser) userUsername.textContent = `@${this.currentUser.username}`;

        const userAvatar = document.getElementById('userAvatar');
        if (userAvatar && this.currentUser) {
            if (this.currentUser.profileImage) {
                userAvatar.style.backgroundImage = `url(${this.currentUser.profileImage})`;
                userAvatar.style.backgroundSize = 'cover';
                userAvatar.style.backgroundPosition = 'center';
                userAvatar.textContent = '';
            } else {
                userAvatar.style.backgroundImage = '';
                userAvatar.textContent = this.currentUser.avatar || 'A';
            }
        }
    }

    // Socket connection with unread message tracking
    connectSocket() {
        try {
            if (!window.io && !window.io === undefined) {
                // If socket.io client isn't loaded, warn and return.
                if (typeof io === 'undefined') {
                    console.warn('socket.io client not loaded (io missing)');
                    return;
                }
            }
            // Avoid reconnecting if socket already present and connected
            if (this.socket && this.socket.connected) {
                return this.socket;
            }

            // create socket - pass token if available
            const opts = {};
            if (this.token) {
                // many server configs accept auth token via 'auth' on client
                opts.auth = { token: this.token };
            }
            this.socket = (typeof io !== 'undefined') ? io(undefined, opts) : null;

            if (!this.socket) {
                console.warn('connectSocket: socket creation returned null');
                return;
            }

            this.socket.on('connect', () => {
                console.log('🔌 Connected to sTalk server');
                if (this.currentUser && this.currentUser.id) {
                    this.socket.emit('join_user_room', this.currentUser.id);
                }
            });

            this.socket.on('disconnect', () => {
                console.log('🔌 Disconnected from server');
                if (window.innerWidth > 768) {
                    this.showToast('📡 Connection lost - Reconnecting...', 'error');
                }
            });

            this.socket.on('reconnect', () => {
                console.log('🔌 Reconnected to server');
                if (window.innerWidth > 768) {
                    this.showToast('📡 Connection restored!', 'success');
                }
                if (this.currentUser && this.currentUser.id) {
                    this.socket.emit('join_user_room', this.currentUser.id);
                }
            });

            this.socket.on('message_received', (message) => {
                try {
                    console.log('📨 Message received:', message);

                    // Find sender user to get their ID
                    const senderUser = Array.from(this.users.values()).find(u => u.username === message.sender);
                    if (senderUser) {
                        // Increment unread count if not currently chatting with this user
                        if (!this.selectedUserId || this.selectedUserId != senderUser.id) {
                            const currentCount = this.unreadCounts.get(senderUser.id) || 0;
                            this.unreadCounts.set(senderUser.id, currentCount + 1);
                            this.updateUserListUnreadIndicators();
                        }

                        // Add to UI if chatting with sender
                        if (this.selectedUserId && senderUser.id == this.selectedUserId) {
                            this.addMessageToUI(message, true);
                        }
                    } else {
                        // If sender is unknown, attempt to reload users (non-blocking)
                        this.loadUsers().catch(()=>{});
                    }

                    // Show a local browser notification if page is hidden and permission is granted
                    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
                        try {
                            this.showBrowserNotification({
                                senderName: message.senderName || message.sender,
                                content: message.content || (message.fileName ? `Sent: ${message.fileName}` : 'New message')
                            });
                        } catch (e) { /* ignore */ }
                    }

                    // Play notification sound if enabled
                    if (this.soundEnabled) this.playNotificationSound();
                } catch (e) {
                    console.error('message_received handler error', e);
                }
            });

            this.socket.on('user_typing', ({ userId, userName, isTyping }) => {
                if (userId !== this.currentUser?.id && this.selectedUserId == userId) {
                    this.showTypingIndicator(userName, isTyping);
                }
            });

            this.socket.on('user_status_changed', ({ userId, isOnline }) => {
                this.updateUserOnlineStatus(userId, isOnline);
            });
        } catch (e) {
            console.error('connectSocket error', e);
        }
    }

    playNotificationSound() {
        if (!this.soundEnabled) return;
        try {
            // Use Web Audio API for short beep
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const audioContext = new AudioContext();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            oscillator.type = 'sine';
            oscillator.frequency.value = 1000;
            gainNode.gain.setValueAtTime(0.15, audioContext.currentTime);
            oscillator.start();
            setTimeout(() => {
                oscillator.stop();
                // close context to free resources
                if (audioContext.close) audioContext.close().catch(()=>{});
            }, 100);
        } catch (error) {
            // Silent fail if audio not supported
        }
    }

    // Request notification permission
    async requestNotificationPermission() {
        if (!('Notification' in window)) return 'unsupported';
        if (Notification.permission === 'granted') return 'granted';
        if (Notification.permission === 'denied') return 'denied';
        try {
            const permission = await Notification.requestPermission();
            this.updatePushPermissionDescription();
            return permission;
        } catch (error) {
            this.updatePushPermissionDescription();
            return 'error';
        }
    }

    // Show browser notification (fallback local notification)
    showBrowserNotification(message) {
        // Only show notifications if permission is granted and page hidden
        if (!('Notification' in window) || Notification.permission !== 'granted') return;

        try {
            const notification = new Notification(message.senderName || 'sTalk', {
                body: message.content || '',
                icon: '/android-chrome-192x192.png',
                badge: '/favicon-16x16.png',
                tag: message.tag || 'stalk-message',
                renotify: false,
                silent: !this.soundEnabled // let sound play separately if enabled
            });

            notification.onclick = () => {
                window.focus();
                notification.close();
            };

            setTimeout(() => notification.close(), 5000);
        } catch (error) {
            console.log('Failed to show notification:', error);
        }
    }

    // Initialize push: check support, set UI, try to auto-subscribe if previously enabled
    async initPush() {
        // if service worker / Push API not supported - reflect in UI and return
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.debug('Push not supported in this browser');
            // ensure UI toggle exists and displays false
            const pushToggle = document.getElementById('enablePushToggle');
            if (pushToggle) pushToggle.checked = false;
            this.updatePushPermissionDescription();
            return;
        }

        // Ensure pushClient is initialized if present
        try {
            if (window.pushClient) {
                await window.pushClient.init();
            } else {
                // Make sure SW is registered even if pushClient isn't included
                await this.ensureServiceWorkerRegistered();
            }
        } catch (e) {
            console.warn('Push client init error', e);
        }

        // If push was previously enabled by user, attempt to re-subscribe automatically
        if (this.pushEnabled && this.token) {
            try {
                // Try using pushClient API when available
                if (window.pushClient) {
                    const existing = await (window.pushClient.registration ? window.pushClient.registration.pushManager.getSubscription() : null);
                    if (!existing) {
                        const reg = await navigator.serviceWorker.getRegistration();
                        if (reg) {
                            const sub = await reg.pushManager.getSubscription();
                            if (sub && this.token) {
                                await window.pushClient.postSubscription ? window.pushClient.postSubscription(sub) : null;
                            }
                        }
                    } else {
                        await window.pushClient.postSubscription ? window.pushClient.postSubscription(existing) : null;
                    }
                } else {
                    const reg = await navigator.serviceWorker.getRegistration();
                    if (reg) {
                        const sub = await reg.pushManager.getSubscription();
                        if (sub && this.token) {
                            // send subscription to server
                            await fetch('/api/push/subscribe', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${this.token}`
                                },
                                body: JSON.stringify({ subscription: sub })
                            });
                        }
                    }
                }
            } catch (e) {
                console.warn('Auto push init failed', e);
            }
        }

        // ensure UI toggle exists and displays correct state (reflect actual subscription)
        await this.refreshPushToggleState().catch(()=>{});
        this.updatePushPermissionDescription();
    }

    // Ensure service worker is registered (used by push-client)
    async ensureServiceWorkerRegistered() {
        if (!('serviceWorker' in navigator)) return;
        // register if not registered
        try {
            const reg = await navigator.serviceWorker.getRegistration('/sw.js');
            if (!reg) {
                await navigator.serviceWorker.register('/sw.js');
                console.log('Service worker registered by app init');
            }
        } catch (err) {
            console.warn('Service worker registration failed', err);
        }
    }

    // Refresh push toggle UI to represent actual permission / subscription state
    async refreshPushToggleState() {
        const pushToggle = document.getElementById('enablePushToggle');
        if (!pushToggle) return;

        // Default unchecked
        pushToggle.checked = false;

        // If notifications unsupported, disable toggle
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
            pushToggle.checked = false;
            pushToggle.disabled = true;
            this.updatePushPermissionDescription();
            return;
        }

        // If permission is denied, reflect that (unchecked)
        if (Notification.permission === 'denied') {
            pushToggle.checked = false;
            pushToggle.disabled = false;
            this.updatePushPermissionDescription();
            return;
        }

        // Check subscription existence
        try {
            // prefer pushClient registration if exposed
            let sub = null;
            if (window.pushClient && window.pushClient.registration) {
                sub = await window.pushClient.registration.pushManager.getSubscription();
            } else {
                const reg = await navigator.serviceWorker.getRegistration();
                if (reg) sub = await reg.pushManager.getSubscription();
            }

            if (sub) {
                pushToggle.checked = true;
                this.pushEnabled = true;
                localStorage.setItem('sTalk_push_enabled', 'true');
            } else {
                pushToggle.checked = false;
                this.pushEnabled = false;
                localStorage.setItem('sTalk_push_enabled', 'false');
            }
        } catch (e) {
            console.warn('Failed to determine push subscription state', e);
            pushToggle.checked = !!this.pushEnabled;
        }
        this.updatePushPermissionDescription();
    }

    // Enable push: request permission, register SW, then subscribe and send to server
    async enablePush() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
            alert('Push notifications are not supported by this browser.');
            return;
        }

        const permission = await this.requestNotificationPermission();
        if (permission !== 'granted') {
            alert('Notifications permission not granted. Please enable in browser settings.');
            // reflect UI
            const pushToggle = document.getElementById('enablePushToggle');
            if (pushToggle) pushToggle.checked = false;
            return;
        }

        try {
            // register service worker if needed
            await this.ensureServiceWorkerRegistered();

            // If push-client helper exists, prefer it (it handles posting subscription to server)
            if (window.pushClient) {
                try {
                    // ensure pushClient initialized
                    await window.pushClient.init();
                } catch(e){/* continue */}
                const sub = await window.pushClient.subscribe();
                // pushClient.subscribe() will post subscription to server itself
                if (!sub) throw new Error('Subscription failed');
            } else {
                // fallback: use raw PushManager subscribe then send to our subscribe endpoint
                const resp = await fetch(`${this.API_BASE}/push/key`);
                if (!resp.ok) throw new Error('Failed to fetch push key from server');
                const { publicKey } = await resp.json();
                if (!publicKey) throw new Error('Server did not provide a VAPID public key');

                const reg = await navigator.serviceWorker.getRegistration();
                if (!reg) throw new Error('Service worker registration missing');
                const sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: this.urlBase64ToUint8Array(publicKey)
                });

                // send subscription to server
                await fetch('/api/push/subscribe', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({ subscription: sub })
                });
            }

            this.pushEnabled = true;
            localStorage.setItem('sTalk_push_enabled', 'true');
            this.showToast('✅ Push notifications enabled', 'success');
            // update UI toggle state
            await this.refreshPushToggleState();
        } catch (err) {
            console.error('Enable push failed', err);
            this.pushEnabled = false;
            localStorage.setItem('sTalk_push_enabled', 'false');
            this.showToast('❌ Failed to enable push', 'error');
            throw err;
        }
    }

    // Disable push: attempt to unsubscribe and notify server
    async disablePush() {
        try {
            // Prefer pushClient when available
            if (window.pushClient) {
                try {
                    await window.pushClient.unsubscribe();
                } catch (e) {
                    console.warn('pushClient.unsubscribe failed', e);
                }
            } else {
                const reg = await navigator.serviceWorker.getRegistration();
                if (reg) {
                    const sub = await reg.pushManager.getSubscription();
                    if (sub && this.token) {
                        // notify server to remove subscription
                        await fetch('/api/push/unsubscribe', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${this.token}`
                            },
                            body: JSON.stringify({ endpoint: sub.endpoint })
                        });
                        await sub.unsubscribe();
                    }
                }
            }

            this.pushEnabled = false;
            localStorage.setItem('sTalk_push_enabled', 'false');
            this.showToast('✅ Push disabled', 'success');
            await this.refreshPushToggleState();
        } catch (err) {
            console.warn('Disable push failed', err);
            this.showToast('❌ Failed to disable push', 'error');
            throw err;
        }
    }

    // small utility used by fallback subscribe code
    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    // Enhanced user list with unread counters
    async loadUsers() {
        const loadingElement = document.getElementById('userListLoading');
        if (loadingElement) loadingElement.style.display = 'flex';

        try {
            const response = await fetch(`${this.API_BASE}/users`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const users = await response.json();
                this.renderUserList(users);
            } else {
                this.showToast('❌ Failed to load users', 'error');
            }
        } catch (error) {
            this.showToast('❌ Connection error - Check your server', 'error');
        } finally {
            if (loadingElement) loadingElement.style.display = 'none';
        }
    }

    renderUserList(users) {
        const userList = document.getElementById('userList');

        if (!userList) return;

        if (users.length === 0) {
            userList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">👥</div>
                    <div class="empty-state-title">No Users Available</div>
                    <p>Contact your admin to add more users to the system.</p>
                </div>
            `;
            this.users = new Map();
            return;
        }

        // Enhanced user list with unread indicators
        const usersHTML = users.map(user => {
            const unreadCount = this.unreadCounts.get(user.id) || 0;
            const hasUnread = unreadCount > 0;

            return `
                <div class="user-item ${hasUnread ? 'has-unread' : ''}" data-user-id="${user.id}" onclick="app.selectUser(${user.id})">
                    <div class="user-item-avatar" style="${user.profileImage ? `background-image: url(${user.profileImage}); background-size: cover; background-position: center;` : ''}">
                        ${!user.profileImage ? user.avatar : ''}
                        ${user.isOnline ? '<div class="online-indicator"></div>' : ''}
                    </div>
                    <div class="user-item-info">
                        <div class="user-item-name ${hasUnread ? 'unread' : ''}">${user.fullName}</div>
                        <div class="user-item-status">
                            ${hasUnread ? `${unreadCount} unread messages` : (user.isOnline ? '🟢 Online' : '⚪ Offline')}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        userList.innerHTML = usersHTML;
        this.users = new Map(users.map(user => [user.id, user]));
    }

    updateUserListUnreadIndicators() {
        this.unreadCounts.forEach((count, userId) => {
            const userItem = document.querySelector(`[data-user-id="${userId}"]`);
            if (userItem) {
                const nameElement = userItem.querySelector('.user-item-name');
                const statusElement = userItem.querySelector('.user-item-status');

                if (count > 0) {
                    userItem.classList.add('has-unread');
                    if (nameElement) nameElement.classList.add('unread');
                    if (statusElement) statusElement.textContent = `${count} unread messages`;
                } else {
                    userItem.classList.remove('has-unread');
                    if (nameElement) nameElement.classList.remove('unread');
                    const user = this.users.get(userId);
                    if (statusElement) statusElement.textContent = user?.isOnline ? '🟢 Online' : '⚪ Offline';
                }
            }
        });
    }

    async selectUser(userId) {
        this.selectedUserId = userId;
        const user = this.users.get(userId);

        if (!user) return;

        // Clear unread count for this user
        this.unreadCounts.set(userId, 0);
        this.updateUserListUnreadIndicators();

        // Update UI
        document.querySelectorAll('.user-item').forEach(item => {
            item.classList.remove('active');
        });
        const el = document.querySelector(`[data-user-id="${userId}"]`);
        if (el) el.classList.add('active');

        // Update chat header - NO MORE DUPLICATE GREEN DOT
        const chatHeaderName = document.getElementById('chatHeaderName');
        const chatHeaderStatus = document.getElementById('chatHeaderStatus');
        if (chatHeaderName) chatHeaderName.textContent = user.fullName;
        if (chatHeaderStatus) chatHeaderStatus.textContent = user.isOnline ? '🟢 Online' : '⚪ Offline';
        const chatHeader = document.getElementById('chatHeader');
        if (chatHeader) chatHeader.style.display = 'flex';
        const messageInputContainer = document.getElementById('messageInputContainer');
        if (messageInputContainer) messageInputContainer.style.display = 'flex';

        await this.loadMessages(userId);
        this.showChatDetail();

        setTimeout(() => {
            const mi = document.getElementById('messageInput');
            if (mi) mi.focus();
        }, 100);
    }

    async loadMessages(userId) {
        const container = document.getElementById('messagesContainer');
        if (!container) return;
        container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

        try {
            const response = await fetch(`${this.API_BASE}/chats/${userId}`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const messages = await response.json();
                this.renderMessages(messages);
            } else {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">❌</div>
                        <div class="empty-state-title">Failed to load messages</div>
                        <p>Please try again or check your connection.</p>
                    </div>
                `;
            }
        } catch (error) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📡</div>
                    <div class="empty-state-title">Connection Error</div>
                    <p>Unable to load messages. Please check your server.</p>
                </div>
            `;
        }
    }

    // NEW: Enhanced message rendering with media previews and link previews
    renderMessages(messages) {
        const container = document.getElementById('messagesContainer');
        if (!container) return;

        if (!messages || messages.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">💬</div>
                    <div class="empty-state-title">Start the conversation</div>
                    <p>Send a message or share a file to begin chatting!</p>
                </div>
            `;
            return;
        }

        const messagesHTML = messages.map(message => {
            const isSent = message.sender === this.currentUser.username;

            let messageContent = '';
            if (message.messageType === 'file' && message.filePath) {
                messageContent = this.renderEnhancedMediaMessage(message);
            } else {
                messageContent = this.renderEnhancedTextMessage(message.content || '');
            }

            return `
                <div class="message ${isSent ? 'sent' : 'received'}">
                    <div class="message-bubble">
                        ${messageContent}
                        <div class="message-time">${this.formatTime(message.sentAt)}</div>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = messagesHTML;
        this.scrollToBottom();
    }

    // NEW: Enhanced media message rendering with previews
    renderEnhancedMediaMessage(message) {
        const fileName = message.fileName || 'Unknown file';
        const fileSize = this.formatFileSize(message.fileSize || 0);
        const filePath = message.filePath;
        const mimeType = message.fileType || '';

        // Image preview (auto-download and display)
        if (mimeType.startsWith('image/')) {
            return `
                <div class="media-message image-message">
                    <img src="${filePath}" alt="${fileName}" class="media-preview" onclick="app.openMediaFullscreen('${filePath}', '${fileName}')">
                    <div class="media-info">
                        <div class="media-name">${this.escapeHtml(fileName)}</div>
                        <div class="media-size">${fileSize}</div>
                    </div>
                </div>
            `;
        }

        // Video preview with thumbnail and play button
        if (mimeType.startsWith('video/')) {
            return `
                <div class="media-message video-message">
                    <div class="video-preview" onclick="app.playVideo('${filePath}')">
                        <video preload="metadata" class="video-thumbnail">
                            <source src="${filePath}" type="${mimeType}">
                        </video>
                        <div class="play-button">▶️</div>
                    </div>
                    <div class="media-info">
                        <div class="media-name">${this.escapeHtml(fileName)}</div>
                        <div class="media-size">${fileSize}</div>
                    </div>
                </div>
            `;
        }

        // Audio preview
        if (mimeType.startsWith('audio/')) {
            return `
                <div class="media-message audio-message">
                    <div class="audio-controls">
                        <div class="audio-icon">🎵</div>
                        <audio controls class="audio-player">
                            <source src="${filePath}" type="${mimeType}">
                        </audio>
                    </div>
                    <div class="media-info">
                        <div class="media-name">${this.escapeHtml(fileName)}</div>
                        <div class="media-size">${fileSize}</div>
                    </div>
                </div>
            `;
        }

        // Other files - show with download link
        const fileIcon = this.getFileIcon(mimeType);
        return `
            <div class="file-message">
                <div class="file-icon">${fileIcon}</div>
                <div class="file-info">
                    <div class="file-name">${this.escapeHtml(fileName)}</div>
                    <div class="file-size">${fileSize}</div>
                </div>
                <a href="${filePath}" download="${fileName}" class="file-download" title="Download ${fileName}">
                    ⬇️
                </a>
            </div>
        `;
    }

    // NEW: Enhanced text message rendering with link previews
    renderEnhancedTextMessage(content) {
        if (!content) return '';

        // Detect URLs in the message
        const urlRegex = /(https?:\/\/[^\s]+)/gi;
        const urls = content.match(urlRegex);

        let renderedContent = this.escapeHtml(content);

        // Convert URLs to clickable links
        if (urls) {
            urls.forEach(url => {
                const cleanUrl = url.replace(/[.,!?;]$/, ''); // Remove trailing punctuation
                renderedContent = renderedContent.replace(
                    this.escapeHtml(url),
                    `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="message-link">${this.escapeHtml(cleanUrl)}</a>`
                );
            });

            // Add link preview for the first URL
            if (urls.length > 0) {
                const firstUrl = urls[0].replace(/[.,!?;]$/, '');
                try {
                    renderedContent += this.generateLinkPreview(firstUrl);
                } catch (e) { /* ignore invalid URLs */ }
            }
        }

        return renderedContent;
    }

    // NEW: Generate link preview
    generateLinkPreview(url) {
        // Simple preview - in a real app, you'd fetch metadata from the server
        const domain = new URL(url).hostname;

        return `
            <div class="link-preview" onclick="window.open('${url}', '_blank')">
                <div class="link-preview-favicon">🌐</div>
                <div class="link-preview-info">
                    <div class="link-preview-title">${this.escapeHtml(domain)}</div>
                    <div class="link-preview-url">${this.escapeHtml(url)}</div>
                </div>
                <div class="link-preview-arrow">→</div>
            </div>
        `;
    }

    // NEW: Media interaction methods
    openMediaFullscreen(src, title) {
        // Create fullscreen overlay
        const overlay = document.createElement('div');
        overlay.className = 'media-fullscreen-overlay';
        overlay.innerHTML = `
            <div class="media-fullscreen-content">
                <button class="media-fullscreen-close" onclick="this.closest('.media-fullscreen-overlay').remove()">✕</button>
                <img src="${src}" alt="${title}" class="media-fullscreen-image">
                <div class="media-fullscreen-title">${this.escapeHtml(title)}</div>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        document.body.appendChild(overlay);
    }

    playVideo(src) {
        // Create video player overlay
        const overlay = document.createElement('div');
        overlay.className = 'media-fullscreen-overlay';
        overlay.innerHTML = `
            <div class="media-fullscreen-content">
                <button class="media-fullscreen-close" onclick="this.closest('.media-fullscreen-overlay').remove()">✕</button>
                <video controls autoplay class="media-fullscreen-video">
                    <source src="${src}">
                </video>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });

        document.body.appendChild(overlay);
    }

    getFileIcon(mimeType) {
        if (mimeType && mimeType.startsWith('image/')) return '🖼️';
        if (mimeType && mimeType.startsWith('audio/')) return '🎵';
        if (mimeType && mimeType.startsWith('video/')) return '🎥';
        if (mimeType && mimeType.includes('pdf')) return '📄';
        if (mimeType && (mimeType.includes('document') || mimeType.includes('word'))) return '📝';
        if (mimeType && (mimeType.includes('spreadsheet') || mimeType.includes('excel'))) return '📊';
        if (mimeType && (mimeType.includes('zip') || mimeType.includes('rar'))) return '🗜️';
        return '📎';
    }

    async sendMessage() {
        const input = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');

        if (!input || !this.selectedUserId) return;
        const content = input.value.trim();

        if (!content) return;

        if (sendBtn) sendBtn.disabled = true;

        // Optimistic local UI: clear input immediately and restore on failure
        input.value = '';
        this.autoResizeTextarea(input);
        this.updateSendButton();

        try {
            const response = await fetch(`${this.API_BASE}/chats/${this.selectedUserId}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ content })
            });

            if (response.ok) {
                const message = await response.json();
                this.addMessageToUI(message, true);
            } else {
                // restore input on failure
                input.value = content;
                this.autoResizeTextarea(input);
                this.updateSendButton();
                this.showToast('❌ Failed to send message', 'error');
            }
        } catch (error) {
            input.value = content;
            this.autoResizeTextarea(input);
            this.updateSendButton();
            this.showToast('❌ Connection error', 'error');
        } finally {
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    addMessageToUI(message, scroll = false) {
        const container = document.getElementById('messagesContainer');
        if (!container) return;
        const emptyState = container.querySelector('.empty-state');

        if (emptyState) {
            container.innerHTML = '';
        }

        const isSent = message.sender === this.currentUser.username;
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isSent ? 'sent' : 'received'}`;

        let messageContent = '';
        if (message.messageType === 'file' && message.filePath) {
            messageContent = this.renderEnhancedMediaMessage(message);
        } else {
            messageContent = this.renderEnhancedTextMessage(message.content || '');
        }

        messageDiv.innerHTML = `
            <div class="message-bubble">
                ${messageContent}
                <div class="message-time">${this.formatTime(message.sentAt)}</div>
            </div>
        `;

        container.appendChild(messageDiv);

        if (scroll) {
            this.scrollToBottom();
        }
    }

    // Utility methods
    formatFileSize(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    formatTime(timestamp) {
        if (!timestamp) return '';

        // SQLite timestamps are in UTC format "YYYY-MM-DD HH:MM:SS"
        // We need to explicitly treat them as UTC, then convert to local time
        let date;
        try {
            if (String(timestamp).includes('T')) {
                // Already in ISO format
                date = new Date(timestamp);
            } else {
                // SQLite format - add 'Z' to indicate UTC
                date = new Date(String(timestamp).replace(' ', 'T') + 'Z');
            }
        } catch (e) {
            return '';
        }

        const day = date.getDate();
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const month = monthNames[date.getMonth()];
        const year = String(date.getFullYear()).slice(-2);
        let hours = date.getHours();
        const minutes = date.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        if (hours === 0) hours = 12;
        const minutesStr = minutes < 10 ? '0' + minutes : String(minutes);
        const hoursStr = hours < 10 ? '0' + hours : String(hours);
        return `${day}-${month}-${year} ${hoursStr}:${minutesStr}${ampm}`;
    }

    autoResizeTextarea(textarea) {
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    updateSendButton() {
        const input = document.getElementById('messageInput');
        const btn = document.getElementById('sendBtn');
        if (!btn) return;
        btn.disabled = !input || !input.value.trim();
    }

    handleTyping() {
        if (!this.selectedUserId) return;
        if (!this.socket) return;

        if (!this.isTyping) {
            this.isTyping = true;
            this.socket.emit('typing_start', {
                userId: this.currentUser.id,
                userName: this.currentUser.fullName
            });
        }

        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => {
            this.isTyping = false;
            this.socket.emit('typing_stop', {
                userId: this.currentUser.id
            });
        }, 1000);
    }

    showTypingIndicator(userName, isTyping) {
        const status = document.getElementById('chatHeaderStatus');
        if (!status) return;
        if (isTyping) {
            status.textContent = `${userName} is typing...`;
            status.style.fontStyle = 'italic';
            status.style.color = 'var(--primary-color)';
        } else if (this.selectedUserId) {
            const user = this.users.get(this.selectedUserId);
            status.textContent = user?.isOnline ? '🟢 Online' : '⚪ Offline';
            status.style.fontStyle = 'normal';
            status.style.color = 'var(--text-secondary)';
        }
    }

    updateUserOnlineStatus(userId, isOnline) {
        const userItem = document.querySelector(`[data-user-id="${userId}"]`);
        if (userItem) {
            const avatarEl = userItem.querySelector('.user-item-avatar');
            const indicator = avatarEl ? avatarEl.querySelector('.online-indicator') : null;
            const status = userItem.querySelector('.user-item-status');
            const unreadCount = this.unreadCounts.get(userId) || 0;

            if (isOnline) {
                if (!indicator && avatarEl) {
                    const newIndicator = document.createElement('div');
                    newIndicator.className = 'online-indicator';
                    avatarEl.appendChild(newIndicator);
                }
                if (unreadCount === 0 && status) {
                    status.textContent = '🟢 Online';
                }
            } else {
                if (indicator) indicator.remove();
                if (unreadCount === 0 && status) {
                    status.textContent = '⚪ Offline';
                }
            }

            const user = this.users.get(userId);
            if (user) {
                user.isOnline = isOnline;
                this.users.set(userId, user);
            }
        }

        if (this.selectedUserId == userId) {
            const headerStatus = document.getElementById('chatHeaderStatus');
            if (headerStatus && !headerStatus.textContent.includes('typing')) {
                headerStatus.textContent = isOnline ? '🟢 Online' : '⚪ Offline';
            }
        }
    }

    scrollToBottom() {
        const container = document.getElementById('messagesContainer');
        if (!container) return;
        container.scrollTop = container.scrollHeight;
    }

    showChatDetail() {
        if (window.innerWidth <= 768) {
            const list = document.getElementById('chatListContainer');
            const detail = document.getElementById('chatDetailContainer');
            if (list) list.classList.add('hidden');
            if (detail) detail.classList.add('show');
        }
    }

    showChatList() {
        if (window.innerWidth <= 768) {
            const list = document.getElementById('chatListContainer');
            const detail = document.getElementById('chatDetailContainer');
            if (list) list.classList.remove('hidden');
            if (detail) detail.classList.remove('show');
        }
    }

    handleResize() {
        if (window.innerWidth > 768) {
            const list = document.getElementById('chatListContainer');
            const detail = document.getElementById('chatDetailContainer');
            if (list) list.classList.remove('hidden');
            if (detail) detail.classList.remove('show');
        }
    }

    filterUsers(searchTerm) {
        const userItems = document.querySelectorAll('.user-item');
        const term = (searchTerm || '').toLowerCase();

        userItems.forEach(item => {
            const name = (item.querySelector('.user-item-name')?.textContent || '').toLowerCase();
            const visible = name.includes(term);
            item.style.display = visible ? 'flex' : 'none';
        });
    }

    toggleUserDropdown() {
        const dd = document.getElementById('userDropdown');
        if (dd) dd.classList.toggle('show');
    }

    setLoginLoading(loading) {
        const btn = document.getElementById('loginBtn');
        const text = document.getElementById('loginBtnText');
        const spinner = document.getElementById('loginSpinner');

        if (loading) {
            if (btn) btn.disabled = true;
            if (text) text.classList.add('d-none');
            if (spinner) spinner.classList.remove('d-none');
        } else {
            if (btn) btn.disabled = false;
            if (text) text.classList.remove('d-none');
            if (spinner) spinner.classList.add('d-none');
        }
    }

    showAlert(message, type = 'error') {
        const alertDiv = document.getElementById('loginAlert');
        if (!alertDiv) return;
        alertDiv.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
        setTimeout(() => {
            if (alertDiv) alertDiv.innerHTML = '';
        }, 5000);
    }

    // FIXED: Only show toast notifications on desktop (width > 768px)
    showToast(message, type = 'success') {
        // Only show toasts on desktop to avoid mobile overlay issues
        if (window.innerWidth <= 768) return;

        const container = document.getElementById('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
        toast.innerHTML = `${icon} ${message}`;

        container.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 4000);
    }

    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// ---------------------------
// Safe, defensive app initialization (REPLACED - fixes .bind() crash)
// ---------------------------

// When DOM is loaded, create and wire a STalk instance if window.app isn't already a STalk instance.
// This version is defensive: it only binds lifecycle aliases if the underlying methods exist,
// and merges non-function properties from any pre-existing window.app object.
document.addEventListener('DOMContentLoaded', () => {
    (async () => {
        try {
            if (!(window.app instanceof STalk)) {
                console.log('🚀 sTalk - Enhanced with media previews, link previews, unread counters, and push/sound controls!');
                const instance = new STalk();

                // If window.app existed as a plain object (fallbacks from other code), merge plain properties
                try {
                    if (window.app && typeof window.app === 'object' && !(window.app instanceof STalk)) {
                        Object.keys(window.app).forEach((k) => {
                            try {
                                // copy only non-function fields that don't exist on the instance
                                if (typeof window.app[k] !== 'function' && typeof instance[k] === 'undefined') {
                                    instance[k] = window.app[k];
                                }
                            } catch (e) { /* ignore */ }
                        });
                    }
                } catch (e) { console.warn('merge existing app object failed', e); }

                // Expose the created instance as the global app
                try {
                    window.app = instance;
                } catch (e) {
                    console.warn('error assigning global app instance', e);
                }

                // Defensive binder helper
                const bindIfFunction = (alias, methodName) => {
                    try {
                        if (typeof instance[methodName] === 'function') {
                            window.app[alias] = instance[methodName].bind(instance);
                        } else if (typeof window.app[alias] !== 'function') {
                            // leave any pre-existing fallback on window.app intact; if none, set a noop
                            window.app[alias] = () => {};
                        }
                    } catch (e) {
                        window.app[alias] = () => {};
                    }
                };

                bindIfFunction('init', 'initializeApp');
                bindIfFunction('showMain', 'showMain');
                bindIfFunction('showLogin', 'showLogin');
                bindIfFunction('connect', 'connectSocket');
                bindIfFunction('postLogin', 'postLogin');

                // reflect lifecycle flags (safe)
                try { window.app.ready = !!instance.ready; window.app.initialized = !!instance.initialized; } catch (e) {}

            } else {
                // already a proper instance - ensure SW handler exists
                window.app.handleServiceWorkerMessage = window.app.handleServiceWorkerMessage || (() => {});
            }
        } catch (e) {
            console.warn('Initialization wrapper error', e);
        }
    })();
});

// Service Worker registration for PWA (if available)
// keep this lightweight; registration also happens inside initPush/ensureServiceWorkerRegistered
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // make registration defensive to avoid double-register issues
        navigator.serviceWorker.getRegistration('/sw.js').then(reg => {
            if (reg) {
                console.log('🔧 Service Worker already registered');
                return reg;
            }
            return navigator.serviceWorker.register('/sw.js').then(registration => {
                console.log('🔧 Service Worker registered');
                return registration;
            }).catch(error => {
                console.log('🔧 Service Worker registration failed', error);
            });
        }).catch(err => {
            // fallback: try registering directly
            navigator.serviceWorker.register('/sw.js').then(() => {
                console.log('🔧 Service Worker registered (fallback)');
            }).catch(error => {
                console.log('🔧 Service Worker registration failed (fallback)', error);
            });
        });
    });
}
