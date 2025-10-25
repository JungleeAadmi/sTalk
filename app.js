// sTalk - Enhanced App with Media Previews, Link Previews & Unread Counters
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

        this.initializeApp();
        this.setupEventListeners();
        this.applyTheme(this.currentTheme);
    }

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
        document.getElementById('themeToggle').addEventListener('change', (e) => {
            this.toggleTheme();
        });

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

    // User Management - Same as before
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
            this.showToast('❌ Upload failed. Check connection.', 'error');
        }
    }

    selectAvatar(type, value) {
        document.querySelectorAll('.avatar-option').forEach(option => {
            option.classList.remove('selected');
        });

        event.target.classList.add('selected');
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

    // Authentication methods - Same as before
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

        mainApp.classList.add('d-none');
        loginScreen.classList.add('d-none');
        loadingScreen.classList.remove('d-none');
    }

    hideLoading() {
        const loadingScreen = document.getElementById('loadingScreen');
        loadingScreen.classList.add('d-none');
    }

    showLogin() {
        const loginScreen = document.getElementById('loginScreen');
        const mainApp = document.getElementById('mainApp');
        const loadingScreen = document.getElementById('loadingScreen');

        mainApp.classList.add('d-none');
        loadingScreen.classList.add('d-none');
        loginScreen.classList.remove('d-none');

        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
        document.getElementById('loginUsername').focus();
    }

    async loadMainApp() {
        const loginScreen = document.getElementById('loginScreen');
        const mainApp = document.getElementById('mainApp');
        const loadingScreen = document.getElementById('loadingScreen');

        loginScreen.classList.add('d-none');
        loadingScreen.classList.add('d-none');
        mainApp.classList.remove('d-none');

        this.updateUserInterface();
        this.connectSocket();
        await this.loadUsers();
    }

    updateUserInterface() {
        document.getElementById('userName').textContent = this.currentUser.fullName;
        document.getElementById('userUsername').textContent = `@${this.currentUser.username}`;

        const userAvatar = document.getElementById('userAvatar');
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

            // NO MORE TOAST NOTIFICATIONS ON MESSAGE RECEIVED
            this.playNotificationSound();
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
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.frequency.value = 800;
            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            oscillator.start();
            oscillator.stop(audioContext.currentTime + 0.1);
        } catch (error) {
            // Silent fail if audio not supported
        }
    }

    // Request notification permission
    async requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            try {
                const permission = await Notification.requestPermission();
                console.log('Notification permission:', permission);
            } catch (error) {
                console.log('Notification permission request failed:', error);
            }
        }
    }

    // Show browser notification
    showBrowserNotification(message) {
        // Only show notifications if page is not visible and permission is granted
        if ('Notification' in window && 
            Notification.permission === 'granted' && 
            document.hidden) {

            try {
                const notification = new Notification('New message from ' + message.senderName, {
                    body: message.content || 'File shared',
                    icon: '/favicon.ico', // You can customize this
                    tag: 'stalk-message', // Prevent multiple notifications
                    requireInteraction: false,
                    silent: false
                });

                // Auto-close notification after 5 seconds
                setTimeout(() => {
                    notification.close();
                }, 5000);

                // Handle notification click
                notification.onclick = () => {
                    window.focus();
                    notification.close();
                };
            } catch (error) {
                console.log('Failed to show notification:', error);
            }
        }
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
        document.querySelector(`[data-user-id="${userId}"]`).classList.add('active');

        // Update chat header - NO MORE DUPLICATE GREEN DOT
        document.getElementById('chatHeaderName').textContent = user.fullName;
        document.getElementById('chatHeaderStatus').textContent = 
            user.isOnline ? '🟢 Online' : '⚪ Offline';
        document.getElementById('chatHeader').style.display = 'flex';
        document.getElementById('messageInputContainer').style.display = 'flex';

        await this.loadMessages(userId);
        this.showChatDetail();

        setTimeout(() => {
            document.getElementById('messageInput').focus();
        }, 100);
    }

    async loadMessages(userId) {
        const container = document.getElementById('messagesContainer');
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
                renderedContent += this.generateLinkPreview(firstUrl);
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
                <button class="media-fullscreen-close" onclick="this.parentElement.parentElement.remove()">✕</button>
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
                <button class="media-fullscreen-close" onclick="this.parentElement.parentElement.remove()">✕</button>
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
        if (mimeType.startsWith('image/')) return '🖼️';
        if (mimeType.startsWith('audio/')) return '🎵';
        if (mimeType.startsWith('video/')) return '🎥';
        if (mimeType.includes('pdf')) return '📄';
        if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
        if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
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
        btn.disabled = !input.value.trim();
    }

    handleTyping() {
        if (!this.selectedUserId) return;

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
                if (unreadCount === 0) {
                    status.textContent = '🟢 Online';
                }
            } else {
                if (indicator) indicator.remove();
                if (unreadCount === 0) {
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
        container.scrollTop = container.scrollHeight;
    }

    showChatDetail() {
        if (window.innerWidth <= 768) {
            document.getElementById('chatListContainer').classList.add('hidden');
            document.getElementById('chatDetailContainer').classList.add('show');
        }
    }

    showChatList() {
        if (window.innerWidth <= 768) {
            document.getElementById('chatListContainer').classList.remove('hidden');
            document.getElementById('chatDetailContainer').classList.remove('show');
        }
    }

    handleResize() {
        if (window.innerWidth > 768) {
            document.getElementById('chatListContainer').classList.remove('hidden');
            document.getElementById('chatDetailContainer').classList.remove('show');
        }
    }

    filterUsers(searchTerm) {
        const userItems = document.querySelectorAll('.user-item');
        const term = searchTerm.toLowerCase();

        userItems.forEach(item => {
            const name = item.querySelector('.user-item-name').textContent.toLowerCase();
            const visible = name.includes(term);
            item.style.display = visible ? 'flex' : 'none';
        });
    }

    toggleUserDropdown() {
        document.getElementById('userDropdown').classList.toggle('show');
    }

    setLoginLoading(loading) {
        const btn = document.getElementById('loginBtn');
        const text = document.getElementById('loginBtnText');
        const spinner = document.getElementById('loginSpinner');

        if (loading) {
            btn.disabled = true;
            text.classList.add('d-none');
            spinner.classList.remove('d-none');
        } else {
            btn.disabled = false;
            text.classList.remove('d-none');
            spinner.classList.add('d-none');
        }
    }

    showAlert(message, type = 'error') {
        const alertDiv = document.getElementById('loginAlert');
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
    console.log('🚀 sTalk - Enhanced with media previews, link previews & unread counters!');
    window.app = new STalk();
});

// Service Worker registration for PWA (if available)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => {
                console.log('🔧 Service Worker registered');
            })
            .catch(error => {
                console.log('🔧 Service Worker registration failed');
            });
    });
}