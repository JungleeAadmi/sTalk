/* app.js - Full STalk class (complete file)
   Replaces existing app.js; includes fixes:
   - Accessible close button + Escape-to-close
   - Focus management when opening overlays
   - Swipe-down to close on touch devices
   - Proper listener cleanup
*/

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

        // Zoom configuration
        this.mediaZoomConfig = {
            maxScale: 4,
            doubleTapScale: 2.2,
            animationDuration: 200 // ms
        };

        this.initializeApp();
        this.setupEventListeners();
        this.applyTheme(this.currentTheme);
    }

    /* ----------------- Initialization & existing methods unchanged ----------------- */

    async initializeApp() {
        this.showLoading();

        if (this.token) {
            const isValid = await this.validateToken();
            if (isValid) {
                await this.loadMainApp();
            } else {
                this.showLogin();
            }
        } else {
            this.showLogin();
        }

        this.hideLoading();
    }

    setupEventListeners() {
        // Login form
        document.getElementById('loginForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });

        // Settings modal
        document.getElementById('settingsBtn').addEventListener('click', () => {
            this.showSettings();
        });

        document.getElementById('closeSettings').addEventListener('click', () => {
            this.hideSettings();
        });

        // Theme toggle
        const themeToggle = document.getElementById('themeToggle');
        themeToggle.addEventListener('change', (e) => {
            this.toggleTheme();
        });

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
        document.getElementById('changePasswordBtn').addEventListener('click', () => {
            this.handleChangePassword();
        });

        document.getElementById('adminStatsBtn').addEventListener('click', () => {
            this.loadAdminStats();
        });

        document.getElementById('userManagementBtn').addEventListener('click', () => {
            this.showUserManagement();
        });

        document.getElementById('logoutBtn').addEventListener('click', () => {
            this.handleLogout();
        });

        // Quick dropdown actions
        document.getElementById('quickSettingsItem').addEventListener('click', () => {
            this.showSettings();
        });

        document.getElementById('quickLogoutItem').addEventListener('click', () => {
            this.handleLogout();
        });

        // Profile picture upload
        document.getElementById('profileImageUpload').addEventListener('change', (e) => {
            this.handleProfileImageUpload(e.target.files[0]);
        });

        document.getElementById('profileAvatarLarge').addEventListener('click', () => {
            document.getElementById('profileImageUpload').click();
        });

        // File upload
        document.getElementById('fileInput').addEventListener('change', (e) => {
            this.handleFileUpload(e.target.files);
        });

        document.getElementById('attachBtn').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });

        // Message input
        const messageInput = document.getElementById('messageInput');
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

        // Send button
        document.getElementById('sendBtn').addEventListener('click', () => {
            this.sendMessage();
        });

        // User menu
        document.getElementById('userAvatar').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleUserDropdown();
        });

        // User search
        document.getElementById('userSearch').addEventListener('input', (e) => {
            this.filterUsers(e.target.value);
        });

        // Back button
        document.getElementById('backBtn').addEventListener('click', () => {
            this.showChatList();
        });

        // Global click handlers
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.user-menu')) {
                document.getElementById('userDropdown').classList.remove('show');
            }
        });

        // Settings modal backdrop click
        document.getElementById('settingsModal').addEventListener('click', (e) => {
            if (e.target.id === 'settingsModal') {
                this.hideSettings();
            }
        });

        // Drag and drop for files
        this.setupDragDrop();

        // Window resize
        window.addEventListener('resize', () => {
            this.handleResize();
        });

        // Listen for messages from service worker (notification click deep-links)
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (ev) => {
                if (ev.data && ev.data.type === 'notification-click') {
                    // Data should contain { chatId, sender, url }
                    this.handleNotificationClick(ev.data.data || {});
                }
            });
        }

        // Visibility handling: attempt to keep socket healthy and re-sync on visibility change
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                // Reconnect or re-emit join in case iOS suspended the socket in background
                if (this.socket && this.socket.connected) {
                    this.socket.emit('join_user_room', this.currentUser?.id);
                } else {
                    // try to re-establish socket if it was lost
                    try {
                        if (!this.socket || !this.socket.connected) {
                            this.connectSocket();
                        }
                    } catch (e) { /* ignore */ }
                }
                // refresh messages for selected chat to avoid disappearing messages
                if (this.selectedUserId) {
                    this.loadMessages(this.selectedUserId).catch(()=>{});
                }
            } else {
                // When hidden, optionally mark last seen or let server handle presence
                // Do nothing else; rely on push for background notifications.
            }
        });
    }

    // Theme Management
    applyTheme(theme) {
        document.body.setAttribute('data-theme', theme);
        document.getElementById('themeToggle').checked = theme === 'dark';
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
        document.getElementById('settingsModal').classList.add('show');

        if (this.currentUser && this.currentUser.role === 'Admin') {
            document.getElementById('adminSection').style.display = 'block';
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
        if (this.currentUser) {
            if (this.currentUser.profileImage) {
                avatarLarge.style.backgroundImage = `url(${this.currentUser.profileImage})`;
                avatarLarge.textContent = '';
            } else {
                avatarLarge.style.backgroundImage = '';
                avatarLarge.textContent = this.currentUser.avatar || 'A';
            }
        }
    }

    hideSettings() {
        document.getElementById('settingsModal').classList.remove('show');
    }

    // Notification click handler (deep-link)
    async handleNotificationClick(data) {
        // data: { chatId, sender, url }
        // Prefer sender -> find user by username
        if (data.sender) {
            const found = Array.from(this.users.values()).find(u => u.username === data.sender);
            if (found) {
                // open chat with that user
                await this.selectUser(found.id);
                window.focus();
                return;
            }
        }

        // fallback: if chatId provided, try to deduce username from chatId
        if (data.chatId) {
            // chatId format created by server: userA_userB (alphabetical). Find other participant
            const parts = data.chatId.split('_');
            const other = parts.find(p => p !== this.currentUser.username);
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
    }

    // User Management - Same as before (unchanged)
    showUserManagement() {
        if (this.isProcessingUserManagement) return;
        this.isProcessingUserManagement = true;

        if (this.currentUser.role !== 'Admin') {
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

        const existingModal = document.getElementById('userManagementModal');
        if (existingModal) existingModal.remove();

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
                this.currentUser.profileImage = result.profileImage;
                this.updateUserInterface();
                this.showToast('✅ Profile image updated!', 'success');

                const avatarLarge = document.getElementById('profileAvatarLarge');
                avatarLarge.style.backgroundImage = `url(${result.profileImage})`;
                avatarLarge.textContent = '';
            } else {
                const error = await response.json();
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
                this.currentUser.avatar = value;
                this.currentUser.profileImage = null;
                this.updateUserInterface();

                const avatarLarge = document.getElementById('profileAvatarLarge');
                avatarLarge.style.backgroundImage = '';
                avatarLarge.textContent = value;

                this.showToast('✅ Avatar updated!', 'success');
            }
        } catch (error) {
            this.showToast('❌ Failed to update avatar', 'error');
        }
    }

    setupDragDrop() {
        const messageContainer = document.getElementById('messagesContainer');

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
        if (!files.length || !this.selectedUserId) {
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
                const error = await response.json();
                this.showToast(`❌ ${error.error || 'Upload failed'}`, 'error');
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showToast('❌ Upload failed. Please check your connection.', 'error');
        }

        document.getElementById('fileInput').value = '';
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
                    fileInfo: fileInfo
                })
            });

            if (response.ok) {
                const message = await response.json();
                this.addMessageToUI(message, true);
            }
        } catch (error) {
            console.error('File message send error:', error);
        }
    }

    // Authentication methods - Same as before (with push init on successful login)
    async handleLogin() {
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;

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

                await this.loadMainApp();
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
        if (this.currentUser.role !== 'Admin') {
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

        if (this.socket) {
            this.socket.disconnect();
        }

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
    }

    async loadMainApp() {
        const loginScreen = document.getElementById('loginScreen');
        const mainApp = document.getElementById('mainApp');
        const loadingScreen = document.getElementById('loadingScreen');

        if (loginScreen) loginScreen.classList.add('d-none');
        if (loadingScreen) loadingScreen.classList.add('d-none');
        if (mainApp) mainApp.classList.remove('d-none');

        this.updateUserInterface();
        this.connectSocket();
        await this.loadUsers();

        // initialize push registration UI + attempt (if previously enabled)
        await this.initPush();
    }

    updateUserInterface() {
        const userName = document.getElementById('userName');
        const userUsername = document.getElementById('userUsername');
        if (userName) userName.textContent = this.currentUser.fullName;
        if (userUsername) userUsername.textContent = `@${this.currentUser.username}`;

        const userAvatar = document.getElementById('userAvatar');
        if (userAvatar) {
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
        this.socket = io();

        this.socket.on('connect', () => {
            console.log('🔌 Connected to sTalk server');
            this.socket.emit('join_user_room', this.currentUser.id);
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
            this.socket.emit('join_user_room', this.currentUser.id);
        });

        this.socket.on('message_received', (message) => {
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
        });

        this.socket.on('user_typing', ({ userId, userName, isTyping }) => {
            if (userId !== this.currentUser.id && this.selectedUserId == userId) {
                this.showTypingIndicator(userName, isTyping);
            }
        });

        this.socket.on('user_status_changed', ({ userId, isOnline }) => {
            this.updateUserOnlineStatus(userId, isOnline);
        });
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
            return permission;
        } catch (error) {
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
                    // pushClient.init() already called above; now ensure subscription exists on server
                    const existing = await (window.pushClient.registration ? window.pushClient.registration.pushManager.getSubscription() : null);
                    // pushClient may not expose registration; fallback to navigator serviceWorker
                    if (!existing) {
                        const reg = await navigator.serviceWorker.getRegistration();
                        if (reg) {
                            const sub = await reg.pushManager.getSubscription();
                            if (sub && this.token) {
                                await window.pushClient.postSubscription ? window.pushClient.postSubscription(sub) : null;
                            }
                        }
                    } else {
                        // ensure server has it (push-client's postSubscription may run inside subscribe)
                        await window.pushClient.postSubscription ? window.pushClient.postSubscription(existing) : null;
                    }
                } else {
                    // attempt to get existing subscription and send to server manually
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
    }

    // Ensure service worker is registered (used by push-client)
    async ensureServiceWorkerRegistered() {
        if (!('serviceWorker' in navigator)) return;
        // register if not registered
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        if (!reg) {
            try {
                await navigator.serviceWorker.register('/sw.js');
                console.log('Service worker registered by app init');
            } catch (err) {
                console.warn('Service worker registration failed', err);
            }
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
            return;
        }

        // If permission is denied, reflect that (unchecked)
        if (Notification.permission === 'denied') {
            pushToggle.checked = false;
            pushToggle.disabled = false;
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
                    nameElement.classList.add('unread');
                    statusElement.textContent = `${count} unread messages`;
                } else {
                    userItem.classList.remove('has-unread');
                    nameElement.classList.remove('unread');
                    const user = this.users.get(userId);
                    statusElement.textContent = user?.isOnline ? '🟢 Online' : '⚪ Offline';
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

        if (messages.length === 0) {
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
            if (message.messageType === 'file' && (message.filePath || (message.fileInfo && message.fileInfo.path))) {
                // normalize file path/name/type - support both message.file* and message.fileInfo.*
                message._filePath = message.filePath || (message.fileInfo && filePathFromFileInfo(message.fileInfo)) || '';
                message._fileName = message.fileName || (message.fileInfo && (message.fileInfo.originalName || message.fileInfo.fileName)) || 'file';
                message._fileType = message.fileType || (message.fileInfo && (message.fileInfo.mimeType || message.fileInfo.fileType)) || '';
                // support thumbnailPath if provided by server
                message._thumbnailPath = message.thumbnailPath || (message.fileInfo && message.fileInfo.thumbnailPath) || '';
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

        // helper to avoid repeating code in the top map
        function filePathFromFileInfo(fi) {
            return fi.path || fi.filePath || '';
        }
    }

    // NEW: Enhanced media message rendering with previews
    renderEnhancedMediaMessage(message) {
        const fileName = message._fileName || message.fileName || message.fileInfo?.originalName || 'Unknown file';
        const fileSize = this.formatFileSize(message.fileSize || (message.fileInfo && message.fileInfo.size) || 0);
        const filePath = message._filePath || message.filePath || (message.fileInfo && filePathFromFileInfo(message.fileInfo)) || '';
        const mimeType = (message._fileType || message.fileType || (message.fileInfo && message.fileInfo.mimeType) || '').toLowerCase();
        const thumbnail = message._thumbnailPath || message.thumbnailPath || (message.fileInfo && message.fileInfo.thumbnailPath) || '';

        // Helper consistent across function
        function filePathFromFileInfo(fi) {
            return fi.path || fi.filePath || '';
        }

        // Image preview - use thumbnail for src if available, keep original in data-original-src
        if (mimeType.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(fileName)) {
            const thumbSrc = thumbnail || filePath;
            return `
                <div class="media-message image-message">
                    <img src="${thumbSrc}" alt="${this.escapeHtml(fileName)}" class="media-preview"
                         data-original-src="${filePath}"
                         data-original-name="${this.escapeHtml(fileName)}"
                         data-mime="${this.escapeHtml(mimeType)}"
                         onclick="app.openMediaFullscreenFromElement(this)">
                    <div class="media-info">
                        <div class="media-name">${this.escapeHtml(fileName)}</div>
                        <div class="media-size">${fileSize}</div>
                    </div>
                </div>
            `;
        }

        // Video preview with thumbnail/poster if available
        if (mimeType.startsWith('video/') || /\.(mp4|webm|mov|mkv|ogg|ogv)$/i.test(fileName)) {
            const posterAttr = thumbnail ? `poster="${thumbnail}"` : '';
            return `
                <div class="media-message video-message">
                    <div class="video-preview" onclick="app.playVideoFromElement(this)">
                        <video preload="metadata" class="video-thumbnail" ${posterAttr}
                            data-original-src="${filePath}"
                            data-original-name="${this.escapeHtml(fileName)}">
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
        if (mimeType.startsWith('audio/') || /\.(mp3|wav|ogg|m4a)$/i.test(fileName)) {
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
                <a href="${filePath}" download="${this.escapeHtml(fileName)}" class="file-download" title="Download ${this.escapeHtml(fileName)}" rel="noopener noreferrer" target="_blank">
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

    /* ------------------ NEW: Media interaction methods with zoom/download ------------------ */

    // Called from onclick attribute on images
    openMediaFullscreenFromElement(imgEl) {
        const src = imgEl.dataset.originalSrc || imgEl.src || imgEl.getAttribute('src');
        const title = imgEl.dataset.originalName || imgEl.alt || '';
        const mime = imgEl.dataset.mime || '';
        this.openMediaFullscreen(src, title, { mime, originalName: imgEl.dataset.originalName || '' });
    }

    // Called from onclick on .video-preview wrapper
    playVideoFromElement(wrapperEl) {
        // find video element
        const video = wrapperEl.querySelector('video');
        const src = video?.dataset.originalSrc || video?.querySelector('source')?.src || video?.src;
        const title = video?.dataset.originalName || (wrapperEl.dataset && wrapperEl.dataset.originalName) || '';
        const originalName = video?.dataset.originalName || this.extractFileNameFromUrl(src);
        this.playVideo(src, { title, originalName });
    }

    // core full-screen image viewer (image)
    openMediaFullscreen(src, title = '', opts = {}) {
        if (!src) return;

        // Build overlay elements
        const overlay = document.createElement('div');
        overlay.className = 'media-fullscreen-overlay';
        overlay.style.opacity = 0;
        overlay.style.transition = `opacity ${this.mediaZoomConfig.animationDuration}ms ease`;
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = 6000;
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.background = 'rgba(0,0,0,0.88)';
        overlay.style.padding = '20px';

        const wrapper = document.createElement('div');
        wrapper.className = 'media-fullscreen-content';
        wrapper.style.maxWidth = '98%';
        wrapper.style.maxHeight = '98%';
        wrapper.style.position = 'relative';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.justifyContent = 'center';
        wrapper.style.flexDirection = 'column';
        wrapper.style.gap = '8px';
        wrapper.tabIndex = -1;

        // container for image that will get transforms
        const imgContainer = document.createElement('div');
        imgContainer.style.position = 'relative';
        imgContainer.style.touchAction = 'none';
        imgContainer.style.maxWidth = '100%';
        imgContainer.style.maxHeight = '100%';
        imgContainer.style.display = 'flex';
        imgContainer.style.alignItems = 'center';
        imgContainer.style.justifyContent = 'center';
        imgContainer.style.overflow = 'hidden';

        const image = document.createElement('img');
        image.className = 'media-fullscreen-image';
        image.src = src;
        image.alt = title || '';
        image.style.transition = `transform ${this.mediaZoomConfig.animationDuration}ms ease`;
        image.style.transformOrigin = 'center center';
        image.style.maxWidth = '100%';
        image.style.maxHeight = '100%';
        image.style.userSelect = 'none';
        image.style.webkitUserDrag = 'none';
        image.style.display = 'block';

        imgContainer.appendChild(image);
        wrapper.appendChild(imgContainer);

        // title (below)
        if (title) {
            const titleEl = document.createElement('div');
            titleEl.className = 'media-fullscreen-title';
            titleEl.textContent = title;
            titleEl.style.color = '#fff';
            titleEl.style.opacity = '0.95';
            titleEl.style.fontSize = '0.95rem';
            titleEl.style.textAlign = 'center';
            titleEl.style.wordBreak = 'break-word';
            titleEl.style.maxWidth = '90%';
            wrapper.appendChild(titleEl);
        }

        // bottom action bar (option 2 - bottom bar)
        const actionBar = document.createElement('div');
        actionBar.style.position = 'absolute';
        actionBar.style.left = '0';
        actionBar.style.right = '0';
        actionBar.style.bottom = '0';
        actionBar.style.padding = '10px 12px';
        actionBar.style.display = 'flex';
        actionBar.style.justifyContent = 'space-between';
        actionBar.style.alignItems = 'center';
        actionBar.style.gap = '8px';
        actionBar.style.background = 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.45) 100%)';
        actionBar.style.zIndex = 20;

        // left: spacer / filename
        const leftInfo = document.createElement('div');
        leftInfo.style.color = '#fff';
        leftInfo.style.fontSize = '0.95rem';
        leftInfo.style.maxWidth = '70%';
        leftInfo.style.overflow = 'hidden';
        leftInfo.style.textOverflow = 'ellipsis';
        leftInfo.style.whiteSpace = 'nowrap';
        leftInfo.textContent = title || '';

        // center: download button
        const centerActions = document.createElement('div');
        centerActions.style.display = 'flex';
        centerActions.style.gap = '8px';

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'btn-secondary';
        downloadBtn.style.background = 'rgba(255,255,255,0.08)';
        downloadBtn.style.border = '1px solid rgba(255,255,255,0.12)';
        downloadBtn.style.color = '#fff';
        downloadBtn.style.padding = '8px 10px';
        downloadBtn.style.borderRadius = '10px';
        downloadBtn.style.fontSize = '0.95rem';
        downloadBtn.textContent = '⬇️ Download';
        downloadBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.attemptDownload(src, opts.originalName || title || this.extractFileNameFromUrl(src));
        });

        const openBtn = document.createElement('button');
        openBtn.className = 'btn-secondary';
        openBtn.style.background = 'rgba(255,255,255,0.08)';
        openBtn.style.border = '1px solid rgba(255,255,255,0.12)';
        openBtn.style.color = '#fff';
        openBtn.style.padding = '8px 10px';
        openBtn.style.borderRadius = '10px';
        openBtn.style.fontSize = '0.95rem';
        openBtn.textContent = '🔗 Open';
        openBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            window.open(src, '_blank', 'noopener');
        });

        centerActions.appendChild(downloadBtn);
        centerActions.appendChild(openBtn);

        // RIGHT: accessible close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'media-fullscreen-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close viewer');
        closeBtn.tabIndex = 0;
        closeBtn.innerHTML = '✕';
        closeBtn.style.background = 'rgba(0,0,0,0.6)';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#fff';
        closeBtn.style.padding = '10px 12px';
        closeBtn.style.borderRadius = '8px';
        closeBtn.style.fontSize = '18px';
        closeBtn.style.cursor = 'pointer';

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeOverlay();
        });
        closeBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                closeOverlay();
            }
        });

        actionBar.appendChild(leftInfo);
        actionBar.appendChild(centerActions);
        actionBar.appendChild(closeBtn);

        wrapper.appendChild(actionBar);

        overlay.appendChild(wrapper);
        document.body.appendChild(overlay);

        // animate in
        requestAnimationFrame(() => {
            overlay.style.opacity = 1;
        });

        // Setup zoom/pan handlers
        const gestureState = {
            scale: 1,
            lastScale: 1,
            startDist: 0,
            originX: 0,
            originY: 0,
            panX: 0,
            panY: 0,
            lastPanX: 0,
            lastPanY: 0,
            doubleTapLast: 0,
            startX: 0,
            startY: 0,
            isMouseDown: false
        };

        const maxScale = this.mediaZoomConfig.maxScale;
        const doubleTapScale = this.mediaZoomConfig.doubleTapScale;

        // Utilities to apply transform
        const applyTransform = () => {
            image.style.transform = `translate(${gestureState.panX}px, ${gestureState.panY}px) scale(${gestureState.scale})`;
        };

        // Clamp helper
        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

        // Touch helpers
        function getDistance(touches) {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx*dx + dy*dy);
        }

        // Convert a client point to image-space origin relative values (not perfect but good)
        function calculateOrigin(clientX, clientY) {
            const rect = image.getBoundingClientRect();
            const ox = (clientX - rect.left) / rect.width;
            const oy = (clientY - rect.top) / rect.height;
            return { ox, oy };
        }

        // Pointer / Touch event handlers
        const onTouchStart = (e) => {
            if (e.touches && e.touches.length === 2) {
                e.preventDefault();
                gestureState.startDist = getDistance(e.touches);
                gestureState.lastScale = gestureState.scale;
                // origin for scale
                const origin = calculateOrigin((e.touches[0].clientX + e.touches[1].clientX)/2, (e.touches[0].clientY + e.touches[1].clientY)/2);
                gestureState.originX = origin.ox;
                gestureState.originY = origin.oy;
            } else if (e.touches && e.touches.length === 1) {
                // single touch - pan start
                gestureState.lastPanX = gestureState.panX;
                gestureState.lastPanY = gestureState.panY;
                gestureState.startX = e.touches[0].clientX;
                gestureState.startY = e.touches[0].clientY;
            }
        };

        const onTouchMove = (e) => {
            if (e.touches && e.touches.length === 2) {
                e.preventDefault();
                const curDist = getDistance(e.touches);
                const scaleFactor = curDist / (gestureState.startDist || curDist);
                let newScale = gestureState.lastScale * scaleFactor;
                newScale = clamp(newScale, 1, maxScale);
                gestureState.scale = newScale;
                applyTransform();
            } else if (e.touches && e.touches.length === 1) {
                if (gestureState.scale > 1) {
                    e.preventDefault();
                    const dx = e.touches[0].clientX - gestureState.startX;
                    const dy = e.touches[0].clientY - gestureState.startY;
                    gestureState.panX = gestureState.lastPanX + dx;
                    gestureState.panY = gestureState.lastPanY + dy;
                    applyTransform();
                }
            }
        };

        const onTouchEnd = (e) => {
            // if ended and scale < 1 reset
            if (!e.touches || e.touches.length === 0) {
                gestureState.lastScale = gestureState.scale;
                gestureState.lastPanX = gestureState.panX;
                gestureState.lastPanY = gestureState.panY;

                if (gestureState.scale === 1) {
                    gestureState.panX = 0;
                    gestureState.panY = 0;
                    gestureState.lastPanX = 0;
                    gestureState.lastPanY = 0;
                    applyTransform();
                } else {
                    // clamp panning roughly so image doesn't slide too far
                    const rect = image.getBoundingClientRect();
                    const viewportW = window.innerWidth;
                    const viewportH = window.innerHeight;
                    const maxPanX = Math.max(0, (rect.width - viewportW)/2 + 20);
                    const maxPanY = Math.max(0, (rect.height - viewportH)/2 + 20);
                    gestureState.panX = clamp(gestureState.panX, -maxPanX, maxPanX);
                    gestureState.panY = clamp(gestureState.panY, -maxPanY, maxPanY);
                    gestureState.lastPanX = gestureState.panX;
                    gestureState.lastPanY = gestureState.panY;
                    applyTransform();
                }
            }
        };

        // Double-tap to zoom
        const onDoubleTap = (ev) => {
            const now = Date.now();
            if (now - gestureState.doubleTapLast < 300) {
                // double tap detected
                if (gestureState.scale > 1.05) {
                    // reset
                    gestureState.scale = 1;
                    gestureState.panX = 0;
                    gestureState.panY = 0;
                    gestureState.lastPanX = 0;
                    gestureState.lastPanY = 0;
                } else {
                    // zoom into doubleTapScale centered at tap location
                    const rect = image.getBoundingClientRect();
                    const clickX = ev.clientX || (ev.touches && ev.touches[0].clientX);
                    const clickY = ev.clientY || (ev.touches && ev.touches[0].clientY);
                    const offsetX = clickX - rect.left - rect.width/2;
                    const offsetY = clickY - rect.top - rect.height/2;
                    gestureState.scale = doubleTapScale;
                    // simple pan so clicked point moves towards center (approx)
                    gestureState.panX = -offsetX * (gestureState.scale - 1);
                    gestureState.panY = -offsetY * (gestureState.scale - 1);
                }
                applyTransform();
            }
            gestureState.doubleTapLast = now;
        };

        // Mouse wheel zoom for desktop
        const onWheel = (ev) => {
            if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return; // avoid interfering with browser zoom shortcuts
            ev.preventDefault();
            const delta = ev.deltaY;
            const scaleChange = delta > 0 ? 0.9 : 1.1;
            let newScale = gestureState.scale * scaleChange;
            newScale = clamp(newScale, 1, maxScale);
            gestureState.scale = newScale;
            applyTransform();
        };

        // Mouse drag panning for desktop
        const onMouseDown = (ev) => {
            if (ev.button !== 0) return;
            gestureState.isMouseDown = true;
            gestureState.startX = ev.clientX;
            gestureState.startY = ev.clientY;
            gestureState.lastPanX = gestureState.panX;
            gestureState.lastPanY = gestureState.panY;
            ev.preventDefault();
        };

        const onMouseMove = (ev) => {
            if (!gestureState.isMouseDown) return;
            if (gestureState.scale > 1) {
                const dx = ev.clientX - gestureState.startX;
                const dy = ev.clientY - gestureState.startY;
                gestureState.panX = gestureState.lastPanX + dx;
                gestureState.panY = gestureState.lastPanY + dy;
                applyTransform();
            }
        };

        const onMouseUp = (ev) => {
            if (gestureState.isMouseDown) {
                gestureState.isMouseDown = false;
                gestureState.lastPanX = gestureState.panX;
                gestureState.lastPanY = gestureState.panY;
            }
        };

        // Add listeners
        image.addEventListener('touchstart', onTouchStart, { passive: false });
        image.addEventListener('touchmove', onTouchMove, { passive: false });
        image.addEventListener('touchend', onTouchEnd, { passive: false });
        image.addEventListener('click', (ev) => {
            // single click should not close; close if clicked outside image container is handled below
            ev.stopPropagation();
        });

        // double-tap detection on container
        imgContainer.addEventListener('touchend', onDoubleTap, { passive: true });
        // mouse double click
        imgContainer.addEventListener('dblclick', (ev) => {
            onDoubleTap(ev);
        });

        // wheel zoom
        imgContainer.addEventListener('wheel', onWheel, { passive: false });

        // mouse drag
        imgContainer.addEventListener('mousedown', onMouseDown, { passive: false });
        window.addEventListener('mousemove', onMouseMove, { passive: false });
        window.addEventListener('mouseup', onMouseUp, { passive: false });

        // close overlay when clicking outside content
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) closeOverlay();
        });

        // cleanup function (with keyboard & touch closing)
        const onKey = (e) => {
            if (e.key === 'Escape') closeOverlay();
        };
        window.addEventListener('keydown', onKey);

        // swipe-down to close
        let touchStartY = null;
        const onSwipeStart = (ev) => {
            if (ev.touches && ev.touches.length === 1) touchStartY = ev.touches[0].clientY;
        };
        const onSwipeMove = (ev) => {
            if (!touchStartY) return;
            const curY = ev.touches[0].clientY;
            const delta = curY - touchStartY;
            if (delta > 80) {
                closeOverlay();
                touchStartY = null;
            }
        };
        imgContainer.addEventListener('touchstart', onSwipeStart, { passive: true });
        imgContainer.addEventListener('touchmove', onSwipeMove, { passive: true });

        // close btn action already wired above

        // close overlay function
        const closeOverlay = () => {
            overlay.style.opacity = 0;
            setTimeout(() => {
                // remove listeners & element
                try {
                    image.removeEventListener('touchstart', onTouchStart);
                    image.removeEventListener('touchmove', onTouchMove);
                    image.removeEventListener('touchend', onTouchEnd);
                    imgContainer.removeEventListener('touchend', onDoubleTap);
                    imgContainer.removeEventListener('dblclick', onDoubleTap);
                    imgContainer.removeEventListener('wheel', onWheel);
                    imgContainer.removeEventListener('mousedown', onMouseDown);
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                    window.removeEventListener('keydown', onKey);
                    imgContainer.removeEventListener('touchstart', onSwipeStart);
                    imgContainer.removeEventListener('touchmove', onSwipeMove);
                } catch (e) { /* ignore */ }
                overlay.remove();
            }, this.mediaZoomConfig.animationDuration + 20);
        };

        // ensure focus
        setTimeout(() => {
            image.focus && image.focus();
            // focus close button for accessibility
            closeBtn.focus && closeBtn.focus();
        }, 50);
    }

    // core full-screen video player (with same bottom actions)
    playVideo(src, opts = {}) {
        if (!src) return;

        const overlay = document.createElement('div');
        overlay.className = 'media-fullscreen-overlay';
        overlay.style.opacity = 0;
        overlay.style.transition = `opacity ${this.mediaZoomConfig.animationDuration}ms ease`;
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = 6000;
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.background = 'rgba(0,0,0,0.88)';
        overlay.style.padding = '20px';

        const wrapper = document.createElement('div');
        wrapper.className = 'media-fullscreen-content';
        wrapper.style.maxWidth = '98%';
        wrapper.style.maxHeight = '98%';
        wrapper.style.position = 'relative';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.justifyContent = 'center';
        wrapper.style.flexDirection = 'column';
        wrapper.style.gap = '8px';
        wrapper.tabIndex = -1;

        const video = document.createElement('video');
        video.className = 'media-fullscreen-video';
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.style.maxWidth = '100%';
        video.style.maxHeight = '100%';
        video.style.borderRadius = '8px';
        video.style.boxShadow = '0 8px 40px rgba(0,0,0,0.6)';
        video.style.background = '#000';

        const source = document.createElement('source');
        source.src = src;
        video.appendChild(source);

        wrapper.appendChild(video);

        if (opts.title) {
            const titleEl = document.createElement('div');
            titleEl.className = 'media-fullscreen-title';
            titleEl.textContent = opts.title;
            titleEl.style.color = '#fff';
            wrapper.appendChild(titleEl);
        }

        // bottom action bar same as image one
        const actionBar = document.createElement('div');
        actionBar.style.position = 'absolute';
        actionBar.style.left = '0';
        actionBar.style.right = '0';
        actionBar.style.bottom = '0';
        actionBar.style.padding = '10px 12px';
        actionBar.style.display = 'flex';
        actionBar.style.justifyContent = 'space-between';
        actionBar.style.alignItems = 'center';
        actionBar.style.gap = '8px';
        actionBar.style.background = 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.45) 100%)';
        actionBar.style.zIndex = 20;

        const leftInfo = document.createElement('div');
        leftInfo.style.color = '#fff';
        leftInfo.style.fontSize = '0.95rem';
        leftInfo.textContent = opts.title || '';

        const centerActions = document.createElement('div');
        centerActions.style.display = 'flex';
        centerActions.style.gap = '8px';

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'btn-secondary';
        downloadBtn.style.background = 'rgba(255,255,255,0.08)';
        downloadBtn.style.border = '1px solid rgba(255,255,255,0.12)';
        downloadBtn.style.color = '#fff';
        downloadBtn.style.padding = '8px 10px';
        downloadBtn.style.borderRadius = '10px';
        downloadBtn.style.fontSize = '0.95rem';
        downloadBtn.textContent = '⬇️ Download';
        downloadBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.attemptDownload(src, opts.originalName || this.extractFileNameFromUrl(src));
        });

        const openBtn = document.createElement('button');
        openBtn.className = 'btn-secondary';
        openBtn.style.background = 'rgba(255,255,255,0.08)';
        openBtn.style.border = '1px solid rgba(255,255,255,0.12)';
        openBtn.style.color = '#fff';
        openBtn.style.padding = '8px 10px';
        openBtn.style.borderRadius = '10px';
        openBtn.style.fontSize = '0.95rem';
        openBtn.textContent = '🔗 Open';
        openBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            window.open(src, '_blank', 'noopener');
        });

        centerActions.appendChild(downloadBtn);
        centerActions.appendChild(openBtn);

        // close btn (accessible)
        const closeBtn = document.createElement('button');
        closeBtn.className = 'media-fullscreen-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close video viewer');
        closeBtn.tabIndex = 0;
        closeBtn.innerHTML = '✕';
        closeBtn.style.background = 'rgba(0,0,0,0.6)';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#fff';
        closeBtn.style.padding = '10px 12px';
        closeBtn.style.borderRadius = '8px';
        closeBtn.style.fontSize = '18px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeOverlay(); });
        closeBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeOverlay(); }
        });

        actionBar.appendChild(leftInfo);
        actionBar.appendChild(centerActions);
        actionBar.appendChild(closeBtn);

        wrapper.appendChild(actionBar);

        overlay.appendChild(wrapper);
        document.body.appendChild(overlay);

        // animate in
        requestAnimationFrame(() => {
            overlay.style.opacity = 1;
        });

        // keyboard to close
        const onKey = (e) => { if (e.key === 'Escape') closeOverlay(); };
        window.addEventListener('keydown', onKey);

        // close on outside click
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) closeOverlay();
        });

        function closeOverlay() {
            overlay.style.opacity = 0;
            try { video.pause(); } catch (e) {}
            try {
                window.removeEventListener('keydown', onKey);
            } catch (e) {}
            setTimeout(() => {
                try { overlay.remove(); } catch (e) {}
            }, 250);
        }

        // ensure focusable & ready
        setTimeout(() => {
            closeBtn.focus && closeBtn.focus();
        }, 50);
    }

    // attempt to download file; falls back to open-in-new-tab if download rejected (CORS)
   // attempt to download/share a file; prefers native share sheet, falls back to anchor download or open-in-new-tab
async attemptDownload(url, originalName = '') {
    if (!url) return;
    const filename = this.generateDownloadFilename(originalName || this.extractFileNameFromUrl(url));

    // helper to open in new tab fallback
    const openInNewTab = (u) => {
        // open without download attribute (last resort)
        window.open(u, '_blank', 'noopener');
    };

    try {
        // Try to fetch the file as a blob first (CORS required)
        const resp = await fetch(url, { mode: 'cors' });
        if (!resp.ok) throw new Error('Fetch failed');

        const blob = await resp.blob();

        // If Web Share API with files supported, use it — shows native share sheet including "Save Image".
        try {
            const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    files: [file],
                    title: filename,
                    text: ''
                });
                return;
            }
        } catch (shareErr) {
            // share may throw on some browsers; we'll fall back to anchor download below
            console.warn('Web Share with files failed:', shareErr);
        }

        // Fallback: create object URL and trigger an anchor download (works in many browsers)
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        a.rel = 'noopener';
        // do NOT set target='_blank' for the download anchor; clicking should trigger save dialog
        document.body.appendChild(a);
        a.click();
        a.remove();

        // revoke object URL after a small delay
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 1000);
        return;
    } catch (errFetch) {
        console.warn('Fetch/download failed or blocked (CORS?)', errFetch);
        // If fetch failed (often due to CORS), fallback to opening direct URL in new tab/window
        openInNewTab(url);
    }
}


    // helper: generate filename with prefix to avoid duplicates
    generateDownloadFilename(originalName) {
        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const datePart = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const safeName = (originalName || 'file').replace(/[<>:"/\\|?*]+/g, '_');
        return `sTalk-${datePart}-${safeName}`;
    }

    extractFileNameFromUrl(url) {
        try {
            const u = new URL(url, window.location.origin);
            const pathname = u.pathname;
            const idx = pathname.lastIndexOf('/');
            return idx >= 0 ? pathname.slice(idx+1) : pathname || 'file';
        } catch (e) {
            // fallback
            const parts = url.split('/');
            return parts[parts.length-1] || 'file';
        }
    }

    getFileIcon(mimeType) {
        if (!mimeType) return '📎';
        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.startsWith('video/')) return '🎥';
        if (mimeType.includes('pdf')) return '📄';
        if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
        if (mimeType.includes('spreadsheet') or mimeType.includes('excel')) return '📊';
        if (mimeType.includes('zip') || mimeType.includes('rar')) return '🗜️';
        return '📎';
    }

    async sendMessage() {
        const input = document.getElementById('messageInput');
        const content = input.value.trim();

        if (!content || !this.selectedUserId) return;

        const sendBtn = document.getElementById('sendBtn');
        sendBtn.disabled = true;

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
            sendBtn.disabled = false;
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
        if (message.messageType === 'file' && (message.filePath || (message.fileInfo && message.fileInfo.path))) {
            // normalize for consistent rendering
            message._filePath = message.filePath || (message.fileInfo && filePathFromFileInfo(message.fileInfo)) || '';
            message._fileName = message.fileName || (message.fileInfo && (message.fileInfo.originalName || message.fileInfo.fileName)) || 'file';
            message._fileType = message.fileType || (message.fileInfo && (message.fileInfo.mimeType || message.fileInfo.fileType)) || '';
            message._thumbnailPath = message.thumbnailPath || (message.fileInfo && message.fileInfo.thumbnailPath) || '';
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

        function filePathFromFileInfo(fi) {
            return fi.path || fi.filePath || '';
        }
    }

    // Utility methods
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
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
        if (timestamp.includes('T')) {
            // Already in ISO format
            date = new Date(timestamp);
        } else {
            // SQLite format - add 'Z' to indicate UTC
            date = new Date(timestamp.replace(' ', 'T') + 'Z');
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
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    updateSendButton() {
        const input = document.getElementById('messageInput');
        const btn = document.getElementById('sendBtn');
        if (btn) btn.disabled = !input.value.trim();
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
            const indicator = userItem.querySelector('.online-indicator');
            const status = userItem.querySelector('.user-item-status');
            const unreadCount = this.unreadCounts.get(userId) || 0;

            if (isOnline) {
                if (!indicator) {
                    const newIndicator = document.createElement('div');
                    newIndicator.className = 'online-indicator';
                    userItem.querySelector('.user-item-avatar').appendChild(newIndicator);
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
        const term = searchTerm.toLowerCase();

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
            alertDiv.innerHTML = '';
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

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 sTalk - Enhanced with media previews, link previews, unread counters, and push/sound controls!');
    window.app = new STalk();
});

// Service Worker registration for PWA (if available)
// keep this lightweight; registration also happens inside initPush/ensureServiceWorkerRegistered
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => {
                console.log('🔧 Service Worker registered');
            })
            .catch(error => {
                console.log('🔧 Service Worker registration failed', error);
            });
    });
}
