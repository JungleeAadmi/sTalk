// server.js (sTalk) - full with Web Push support integrated
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    maxHttpBufferSize: 50e6 // 50MB for file uploads
});

// Configuration
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stalk-secret-key-change-me';
const DB_PATH = process.env.DB_PATH || './database/stalk.db';
const UPLOAD_PATH = process.env.UPLOAD_PATH || './uploads';
const PROFILE_PATH = process.env.PROFILE_PATH || './uploads/profiles';
const NODE_ENV = process.env.NODE_ENV || 'development';

// VAPID / web-push config
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    console.warn('⚠️ VAPID keys not configured. Push will be disabled until VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set.');
}

// Ensure required directories exist
[path.dirname(DB_PATH), UPLOAD_PATH, path.join(UPLOAD_PATH, 'files'), 
 path.join(UPLOAD_PATH, 'images'), path.join(UPLOAD_PATH, 'audio'),
 path.join(UPLOAD_PATH, 'documents'), PROFILE_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Enhanced security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP to allow file uploads/service-worker etc.
    crossOriginEmbedderPolicy: false
}));

// File upload configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        let uploadDir = path.join(UPLOAD_PATH, 'files');

        if (file.mimetype.startsWith('image/')) {
            uploadDir = path.join(UPLOAD_PATH, 'images');
        } else if (file.mimetype.startsWith('audio/')) {
            uploadDir = path.join(UPLOAD_PATH, 'audio');
        } else if (file.mimetype.includes('pdf') || file.mimetype.includes('document')) {
            uploadDir = path.join(UPLOAD_PATH, 'documents');
        }

        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${ext}`);
    }
});

// Profile image storage
const profileStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, PROFILE_PATH);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `profile-${req.user.id}-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
        files: 10 // Max 10 files per upload
    },
    fileFilter: function (req, file, cb) {
        const allowedTypes = [
            'image/', 'audio/', 'video/', 'application/pdf',
            'application/msword', 'application/vnd.openxmlformats-officedocument',
            'text/', 'application/json', 'application/zip',
            'application/x-rar-compressed', 'application/x-7z-compressed'
        ];

        const isAllowed = allowedTypes.some(type => file.mimetype.startsWith(type));
        if (isAllowed) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed'), false);
        }
    }
});

const profileUpload = multer({
    storage: profileStorage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit for profile images
        files: 1
    },
    fileFilter: function (req, file, cb) {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed for profile pictures'), false);
        }
    }
});

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: NODE_ENV === 'production' ? 200 : 1000,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

const uploadLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20,
    message: { error: 'Too many file uploads, please try again later.' }
});

// Middleware
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use('/uploads', express.static(UPLOAD_PATH));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: NODE_ENV,
        features: ['file-upload', 'real-time-chat', 'profile-management', 'dark-theme', 'user-management', 'push-notifications']
    });
});

// Database initialization with profile support
let db;
const initDatabase = () => {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('❌ Database connection failed:', err);
                reject(err);
            } else {
                console.log('✅ Connected to SQLite database');
                initializeTables()
                    .then(() => resolve())
                    .catch(reject);
            }
        });
    });
};

function initializeTables() {
    return new Promise((resolve, reject) => {
        db.run('PRAGMA foreign_keys = ON');

        // Enhanced users table with profile support
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            full_name TEXT NOT NULL,
            gender TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'User',
            avatar TEXT NOT NULL,
            profile_image TEXT NULL,
            theme_preference TEXT DEFAULT 'light',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_online BOOLEAN DEFAULT 0
        )`);

        // Chats table
        db.run(`CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT UNIQUE NOT NULL,
            participant1 TEXT NOT NULL,
            participant2 TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Enhanced messages table with file support
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            sender TEXT NOT NULL,
            content TEXT,
            message_type TEXT DEFAULT 'text',
            file_path TEXT,
            file_name TEXT,
            file_size INTEGER,
            file_type TEXT,
            thumbnail_path TEXT,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            read_at DATETIME NULL,
            FOREIGN KEY (chat_id) REFERENCES chats (chat_id)
        )`);

        // File uploads table for tracking
        db.run(`CREATE TABLE IF NOT EXISTS file_uploads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id TEXT UNIQUE NOT NULL,
            original_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            mime_type TEXT NOT NULL,
            uploaded_by TEXT NOT NULL,
            upload_date DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Push subscriptions table (web-push)
        db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT,
            auth TEXT,
            ua TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`, (err) => {
            if (err) reject(err);
            else {
                createDefaultUsers()
                    .then(() => resolve())
                    .catch(reject);
            }
        });
    });
}

function createDefaultUsers() {
    return new Promise((resolve) => {
        // Only create admin user, no default test users
        const users = [
            ['admin', 'admin', 'Admin User', 'Other', 'Admin', 'A']
        ];

        let created = 0;
        users.forEach(([username, password, fullName, gender, role, avatar]) => {
            const hashedPassword = bcrypt.hashSync(password, 10);
            db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
                if (!user) {
                    db.run(`INSERT INTO users (username, password, full_name, gender, role, avatar) 
                            VALUES (?, ?, ?, ?, ?, ?)`, 
                           [username, hashedPassword, fullName, gender, role, avatar]);
                }
                created++;
                if (created === users.length) {
                    console.log('✅ Default admin user created/verified');
                    resolve();
                }
            });
        });
    });
}

// Authentication middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        db.run('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
        next();
    });
}

// Admin middleware
function requireAdmin(req, res, next) {
    if (req.user.role !== 'Admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// Utility functions
function generateChatId(user1, user2) {
    return [user1, user2].sort().join('_');
}

function getFileIcon(mimeType) {
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('audio/')) return '🎵';
    if (mimeType.startsWith('video/')) return '🎥';
    if (mimeType.includes('pdf')) return '📄';
    if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
    if (mimeType.includes('zip') || mimeType.includes('rar')) return '🗜️';
    return '📎';
}

function generateTempPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

// Web-push helper: sends push notifications to a given user id (numeric)
async function sendPushToUser(userId, payload) {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.warn('VAPID keys missing, skipping push.');
        return;
    }

    return new Promise((resolve) => {
        db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId], async (err, rows) => {
            if (err || !rows || rows.length === 0) return resolve();
            const promises = rows.map(async (r) => {
                const sub = {
                    endpoint: r.endpoint,
                    keys: { p256dh: r.p256dh, auth: r.auth }
                };
                try {
                    await webpush.sendNotification(sub, JSON.stringify(payload));
                } catch (e) {
                    const status = e && e.statusCode ? e.statusCode : null;
                    // Remove stale subscriptions (410 Gone or 404 Not Found)
                    if (status === 410 || status === 404) {
                        db.run('DELETE FROM push_subscriptions WHERE id = ?', [r.id]);
                    }
                }
            });

            try { await Promise.all(promises); } catch (e) {}
            resolve();
        });
    });
}

// Authentication routes
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }

        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        db.run('UPDATE users SET last_active = CURRENT_TIMESTAMP, is_online = 1 WHERE id = ?', [user.id]);

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                fullName: user.full_name,
                gender: user.gender,
                role: user.role,
                avatar: user.avatar,
                profileImage: user.profile_image ? `/uploads/profiles/${path.basename(user.profile_image)}` : null,
                themePreference: user.theme_preference
            }
        });
    });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
    db.get('SELECT id, username, full_name, gender, role, avatar, profile_image, theme_preference FROM users WHERE id = ?', 
           [req.user.id], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            gender: user.gender,
            role: user.role,
            avatar: user.avatar,
            profileImage: user.profile_image ? `/uploads/profiles/${path.basename(user.profile_image)}` : null,
            themePreference: user.theme_preference
        });
    });
});

app.post('/api/auth/change-password', authenticateToken, (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current and new password required' });
    }

    if (newPassword.length < 4 || newPassword.length > 12) {
        return res.status(400).json({ error: 'Password must be 4-12 characters' });
    }

    db.get('SELECT password FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        if (!bcrypt.compareSync(currentPassword, user.password)) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to update password' });
            res.json({ message: 'Password updated successfully' });
        });
    });
});

app.post('/api/auth/logout', authenticateToken, (req, res) => {
    db.run('UPDATE users SET is_online = 0 WHERE id = ?', [req.user.id]);
    res.json({ message: 'Logged out successfully' });
});

// Profile management routes
app.post('/api/profile/image', authenticateToken, uploadLimiter, profileUpload.single('profileImage'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded' });
    }

    const profileImagePath = `/uploads/profiles/${req.file.filename}`;

    // Delete old profile image if exists
    db.get('SELECT profile_image FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (user && user.profile_image) {
            const oldImagePath = path.join(__dirname, 'uploads', 'profiles', path.basename(user.profile_image));
            if (fs.existsSync(oldImagePath)) {
                fs.unlinkSync(oldImagePath);
            }
        }

        // Update database with new image
        db.run('UPDATE users SET profile_image = ? WHERE id = ?', [req.file.path, req.user.id], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to update profile image' });

            res.json({
                message: 'Profile image updated successfully',
                profileImage: profileImagePath
            });
        });
    });
});

app.post('/api/profile/avatar', authenticateToken, (req, res) => {
    const { type, value } = req.body;

    if (!type || !value) {
        return res.status(400).json({ error: 'Avatar type and value required' });
    }

    // Clear profile image when setting text avatar
    db.run('UPDATE users SET avatar = ?, profile_image = NULL WHERE id = ?', [value, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to update avatar' });
        res.json({ message: 'Avatar updated successfully' });
    });
});

// File upload routes
app.post('/api/upload', authenticateToken, uploadLimiter, upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedFiles = req.files.map(file => {
        const fileId = crypto.randomUUID();

        // Store in database
        db.run(`INSERT INTO file_uploads (file_id, original_name, file_path, file_size, mime_type, uploaded_by)
                VALUES (?, ?, ?, ?, ?, ?)`,
               [fileId, file.originalname, file.path, file.size, file.mimetype, req.user.username]);

        return {
            fileId,
            originalName: file.originalname,
            filename: file.filename,
            path: `/uploads/${path.relative(UPLOAD_PATH, file.path)}`,
            size: file.size,
            mimeType: file.mimetype,
            icon: getFileIcon(file.mimetype)
        };
    });

    res.json({ files: uploadedFiles });
});

// Get users
app.get('/api/users', authenticateToken, (req, res) => {
    const search = req.query.search || '';
    const searchPattern = `%${search}%`;

    db.all(`SELECT id, username, full_name, gender, role, avatar, profile_image, is_online, last_active 
            FROM users 
            WHERE id != ? AND (username LIKE ? OR full_name LIKE ?)
            ORDER BY is_online DESC, full_name ASC`, 
           [req.user.id, searchPattern, searchPattern], (err, users) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        res.json(users.map(user => ({
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            gender: user.gender,
            role: user.role,
            avatar: user.avatar,
            profileImage: user.profile_image ? `/uploads/profiles/${path.basename(user.profile_image)}` : null,
            isOnline: !!user.is_online,
            lastActive: user.last_active
        })));
    });
});

// Get chat messages
app.get('/api/chats/:otherUserId', authenticateToken, (req, res) => {
    const otherUserId = req.params.otherUserId;

    db.get('SELECT username FROM users WHERE id = ?', [otherUserId], (err, otherUser) => {
        if (err || !otherUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        const chatId = generateChatId(req.user.username, otherUser.username);

        db.all(`SELECT m.*, u.full_name, u.avatar, u.profile_image 
                FROM messages m
                JOIN users u ON m.sender = u.username
                WHERE m.chat_id = ?
                ORDER BY m.sent_at ASC`, [chatId], (err, messages) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            res.json(messages.map(msg => ({
                id: msg.id,
                sender: msg.sender,
                senderName: msg.full_name,
                senderAvatar: msg.avatar,
                senderProfileImage: msg.profile_image ? `/uploads/profiles/${path.basename(msg.profile_image)}` : null,
                content: msg.content,
                messageType: msg.message_type,
                filePath: msg.file_path,
                fileName: msg.file_name,
                fileSize: msg.file_size,
                fileType: msg.file_type,
                fileIcon: msg.file_type ? getFileIcon(msg.file_type) : null,
                thumbnailPath: msg.thumbnail_path,
                sentAt: msg.sent_at,
                readAt: msg.read_at
            })));
        });
    });
});

// Send message (text or file)
app.post('/api/chats/:otherUserId/messages', authenticateToken, (req, res) => {
    const { content, messageType = 'text', fileInfo } = req.body;
    const otherUserId = req.params.otherUserId;

    if (!content && !fileInfo) {
        return res.status(400).json({ error: 'Message content or file required' });
    }

    db.get('SELECT username, id FROM users WHERE id = ?', [otherUserId], (err, otherUser) => {
        if (err || !otherUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        const chatId = generateChatId(req.user.username, otherUser.username);

        // Create or update chat
        db.run(`INSERT OR IGNORE INTO chats (chat_id, participant1, participant2) 
                VALUES (?, ?, ?)`, [chatId, req.user.username, otherUser.username]);
        db.run('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?', [chatId]);

        // Prepare message data
        const messageData = {
            chat_id: chatId,
            sender: req.user.username,
            content: content || null,
            message_type: messageType,
            file_path: fileInfo?.path || null,
            file_name: fileInfo?.originalName || null,
            file_size: fileInfo?.size || null,
            file_type: fileInfo?.mimeType || null
        };

        db.run(`INSERT INTO messages (chat_id, sender, content, message_type, file_path, file_name, file_size, file_type) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
               Object.values(messageData), function(err) {
            if (err) return res.status(500).json({ error: 'Failed to send message' });

            const messageId = this.lastID;

            // Get the inserted message with user info
            db.get(`SELECT m.*, u.full_name, u.avatar, u.profile_image 
                    FROM messages m
                    JOIN users u ON m.sender = u.username
                    WHERE m.id = ?`, [messageId], (err, message) => {
                if (err) return res.status(500).json({ error: 'Database error' });

                const responseData = {
                    id: message.id,
                    sender: message.sender,
                    senderName: message.full_name,
                    senderAvatar: message.avatar,
                    senderProfileImage: message.profile_image ? `/uploads/profiles/${path.basename(message.profile_image)}` : null,
                    content: message.content,
                    messageType: message.message_type,
                    filePath: message.file_path,
                    fileName: message.file_name,
                    fileSize: message.file_size,
                    fileType: message.file_type,
                    fileIcon: message.file_type ? getFileIcon(message.file_type) : null,
                    sentAt: message.sent_at,
                    chatId: chatId,
                    recipientId: otherUserId
                };

                // Emit to socket rooms
                io.to(`user_${req.user.id}`).emit('message_sent', responseData);
                io.to(`user_${otherUserId}`).emit('message_received', responseData);

                // Build push payload and send to recipient
                const pushPayload = {
                  title: `${responseData.senderName} • sTalk`,
                  body: responseData.content ? responseData.content.substring(0, 120) : (responseData.fileName ? `Sent: ${responseData.fileName}` : 'New message'),
                  data: { chatId: responseData.chatId, sender: responseData.sender, url: `/chats/${responseData.chatId}` },
                  tag: `chat-${responseData.chatId}`
                };

                // recipientId from route parameter (ensure numeric)
                const recipientNumericId = parseInt(otherUserId, 10);
                if (!isNaN(recipientNumericId)) {
                  sendPushToUser(recipientNumericId, pushPayload).catch(()=>{});
                }

                res.json(responseData);
            });
        });
    });
});

// Return VAPID public key to clients
app.get('/api/push/key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

// Subscribe (save subscription for logged in user)
app.post('/api/push/subscribe', authenticateToken, (req, res) => {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ error: 'Invalid subscription' });
    }
    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys ? subscription.keys.p256dh : null;
    const auth = subscription.keys ? subscription.keys.auth : null;
    const ua = req.headers['user-agent'] || null;

    db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [endpoint], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (row) {
            db.run('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, ua = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
                   [req.user.id, p256dh, auth, ua, row.id]);
            return res.json({ message: 'Subscription updated' });
        } else {
            db.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua) VALUES (?, ?, ?, ?, ?)',
                   [req.user.id, endpoint, p256dh, auth, ua], function(err) {
                if (err) return res.status(500).json({ error: 'Failed to save subscription' });
                return res.json({ message: 'Subscription saved' });
            });
        }
    });
});

// Unsubscribe (remove subscription)
app.post('/api/push/unsubscribe', authenticateToken, (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Endpoint required' });
    db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to remove subscription' });
        res.json({ message: 'Unsubscribed' });
    });
});

// FIXED: Admin stats API endpoint
app.get('/api/admin/stats', authenticateToken, requireAdmin, (req, res) => {
    const stats = {};

    // Get total users
    db.get('SELECT COUNT(*) as count FROM users', (err, result) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        stats.totalUsers = result?.count || 0;

        // Get total messages
        db.get('SELECT COUNT(*) as count FROM messages', (err, result) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            stats.totalMessages = result?.count || 0;

            // Get total files
            db.get('SELECT COUNT(*) as count FROM file_uploads', (err, result) => {
                if (err) return res.status(500).json({ error: 'Database error' });
                stats.totalFiles = result?.count || 0;

                // Get total file size
                db.get('SELECT SUM(file_size) as size FROM file_uploads', (err, result) => {
                    if (err) return res.status(500).json({ error: 'Database error' });
                    stats.totalFileSize = result?.size || 0;

                    // Get active chats (last 30 days)
                    db.get('SELECT COUNT(DISTINCT chat_id) as count FROM messages WHERE sent_at > datetime("now", "-30 days")', (err, result) => {
                        if (err) return res.status(500).json({ error: 'Database error' });
                        stats.activeChats = result?.count || 0;

                        // Get online users
                        db.get('SELECT COUNT(*) as count FROM users WHERE is_online = 1', (err, result) => {
                            if (err) return res.status(500).json({ error: 'Database error' });
                            stats.onlineUsers = result?.count || 0;

                            res.json(stats);
                        });
                    });
                });
            });
        });
    });
});

// NEW: Admin User Management Routes
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    db.all(`SELECT id, username, full_name, gender, role, avatar, profile_image, is_online, last_active, created_at
            FROM users 
            ORDER BY created_at DESC`, (err, users) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        res.json(users.map(user => ({
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            gender: user.gender,
            role: user.role,
            avatar: user.avatar,
            profileImage: user.profile_image ? `/uploads/profiles/${path.basename(user.profile_image)}` : null,
            isOnline: !!user.is_online,
            lastActive: user.last_active,
            createdAt: user.created_at
        })));
    });
});

app.post('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    const { username, fullName, password, role = 'User' } = req.body;

    if (!username || !fullName || !password) {
        return res.status(400).json({ error: 'Username, full name, and password required' });
    }

    if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }

    if (password.length < 4 || password.length > 12) {
        return res.status(400).json({ error: 'Password must be 4-12 characters' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const avatar = fullName.charAt(0).toUpperCase();

    db.run(`INSERT INTO users (username, password, full_name, gender, role, avatar)
            VALUES (?, ?, ?, ?, ?, ?)`,
           [username, hashedPassword, fullName, 'Other', role, avatar], function(err) {
        if (err) {
            if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                return res.status(409).json({ error: 'Username already exists' });
            }
            return res.status(500).json({ error: 'Failed to create user' });
        }

        res.json({
            message: 'User created successfully',
            userId: this.lastID
        });
    });
});

app.put('/api/admin/users/:userId', authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { fullName } = req.body;

    if (!fullName) {
        return res.status(400).json({ error: 'Full name required' });
    }

    db.run('UPDATE users SET full_name = ? WHERE id = ?', [fullName, userId], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to update user' });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });

        res.json({ message: 'User updated successfully' });
    });
});

app.post('/api/admin/users/:userId/reset-password', authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.params;
    const tempPassword = generateTempPassword();
    const hashedPassword = bcrypt.hashSync(tempPassword, 10);

    db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to reset password' });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });

        res.json({
            message: 'Password reset successfully',
            tempPassword: tempPassword
        });
    });
});

app.delete('/api/admin/users/:userId', authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.params;

    if (parseInt(userId) === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // Start transaction to delete user and all related data
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Get user info for cleanup
        db.get('SELECT username, profile_image FROM users WHERE id = ?', [userId], (err, user) => {
            if (err || !user) {
                db.run('ROLLBACK');
                return res.status(404).json({ error: 'User not found' });
            }

            // Delete user's messages
            db.run('DELETE FROM messages WHERE sender = ?', [user.username], (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Failed to delete user messages' });
                }

                // Delete user's file uploads
                db.run('DELETE FROM file_uploads WHERE uploaded_by = ?', [user.username], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: 'Failed to delete user files' });
                    }

                    // Delete chats involving this user
                    db.run('DELETE FROM chats WHERE participant1 = ? OR participant2 = ?', [user.username, user.username], (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            return res.status(500).json({ error: 'Failed to delete user chats' });
                        }

                        // Delete the user
                        db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                return res.status(500).json({ error: 'Failed to delete user' });
                            }

                            // Delete profile image if exists
                            if (user.profile_image) {
                                const imagePath = path.join(__dirname, 'uploads', 'profiles', path.basename(user.profile_image));
                                if (fs.existsSync(imagePath)) {
                                    fs.unlinkSync(imagePath);
                                }
                            }

                            db.run('COMMIT');
                            res.json({ message: 'User and all associated data deleted successfully' });
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/admin/bulk-reset-passwords', authenticateToken, requireAdmin, (req, res) => {
    db.all('SELECT id, username FROM users WHERE id != ?', [req.user.id], (err, users) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        const resetUsers = [];
        let completed = 0;

        if (users.length === 0) {
            return res.json({ resetUsers: [] });
        }

        users.forEach(user => {
            const tempPassword = generateTempPassword();
            const hashedPassword = bcrypt.hashSync(tempPassword, 10);

            db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id], (err) => {
                if (!err) {
                    resetUsers.push({
                        username: user.username,
                        tempPassword: tempPassword
                    });
                }

                completed++;
                if (completed === users.length) {
                    res.json({ resetUsers });
                }
            });
        });
    });
});

app.get('/api/admin/export', authenticateToken, requireAdmin, (req, res) => {
    const exportData = {
        users: [],
        messages: [],
        files: [],
        exportDate: new Date().toISOString()
    };

    db.all('SELECT * FROM users', (err, users) => {
        if (err) return res.status(500).json({ error: 'Failed to export users' });

        exportData.users = users.map(user => ({
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            role: user.role,
            createdAt: user.created_at
        }));

        db.all('SELECT COUNT(*) as count FROM messages GROUP BY sender', (err, messageStats) => {
            if (err) return res.status(500).json({ error: 'Failed to export message stats' });
            exportData.messageStats = messageStats;

            db.all('SELECT COUNT(*) as count, SUM(file_size) as totalSize FROM file_uploads GROUP BY uploaded_by', (err, fileStats) => {
                if (err) return res.status(500).json({ error: 'Failed to export file stats' });
                exportData.fileStats = fileStats;

                res.json(exportData);
            });
        });
    });
});

app.delete('/api/admin/clear-chats', authenticateToken, requireAdmin, (req, res) => {
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Delete all messages
        db.run('DELETE FROM messages', (err) => {
            if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Failed to clear messages' });
            }

            // Delete all chats
            db.run('DELETE FROM chats', (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: 'Failed to clear chats' });
                }

                // Delete all file uploads
                db.run('DELETE FROM file_uploads', (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        return res.status(500).json({ error: 'Failed to clear files' });
                    }

                    // Clean up upload directories (except profiles)
                    ['files', 'images', 'audio', 'documents'].forEach(dir => {
                        const dirPath = path.join(UPLOAD_PATH, dir);
                        if (fs.existsSync(dirPath)) {
                            fs.readdirSync(dirPath).forEach(file => {
                                fs.unlinkSync(path.join(dirPath, file));
                            });
                        }
                    });

                    db.run('COMMIT');
                    res.json({ message: 'All chats and files cleared successfully' });
                });
            });
        });
    });
});

// Socket.IO handling with profile support
const connectedUsers = new Map();

io.on('connection', (socket) => {
    console.log('📱 User connected:', socket.id);

    socket.on('join_user_room', (userId) => {
        socket.join(`user_${userId}`);
        connectedUsers.set(socket.id, userId);
        console.log(`👤 User ${userId} joined room`);

        db.run('UPDATE users SET is_online = 1 WHERE id = ?', [userId]);

        // Broadcast user online status
        socket.broadcast.emit('user_status_changed', { userId, isOnline: true });
    });

    socket.on('typing_start', ({ userId, userName }) => {
        socket.broadcast.emit('user_typing', { userId, userName, isTyping: true });
    });

    socket.on('typing_stop', ({ userId }) => {
        socket.broadcast.emit('user_typing', { userId, isTyping: false });
    });

    socket.on('disconnect', () => {
        console.log('📱 User disconnected:', socket.id);

        const userId = connectedUsers.get(socket.id);
        if (userId) {
            db.run('UPDATE users SET is_online = 0, last_active = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
            connectedUsers.delete(socket.id);

            // Broadcast user offline status
            socket.broadcast.emit('user_status_changed', { userId, isOnline: false });
        }
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error('💥 Error:', err.stack);
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: 'Too many files. Maximum is 10 files per upload.' });
        }
    }
    res.status(500).json({ error: 'Something went wrong!' });
});

// Serve main app
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
const gracefulShutdown = () => {
    console.log('\n🔄 Shutting down gracefully...');

    if (db) {
        db.run('UPDATE users SET is_online = 0');
        db.close((err) => {
            if (err) console.error('❌ Database close error:', err);
            else console.log('✅ Database closed');

            server.close(() => {
                console.log('✅ Server closed');
                process.exit(0);
            });
        });
    }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start the application
async function startApp() {
    try {
        await initDatabase();

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`\n🚀 sTalk Server Started!`);
            console.log(`📱 Access: http://localhost:${PORT}`);
            console.log(`🔑 Admin: admin/admin`);
            console.log(`💾 Database: ${DB_PATH}`);
            console.log(`📁 Uploads: ${UPLOAD_PATH}`);
            console.log(`🖼️  Profiles: ${PROFILE_PATH}`);
            console.log(`🌍 Environment: ${NODE_ENV}`);
            console.log(`✨ Features: Dark Theme, File Upload, Profile Management, Admin User Management, Push Notifications`);
            console.log(`\n✅ Production ready with full admin controls!`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startApp();
