// server.js (sTalk) - updated and cleaned version with improved VAPID & upload handling
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
const PROFILE_PATH = process.env.PROFILE_PATH || path.join(UPLOAD_PATH, 'profiles');
const NODE_ENV = process.env.NODE_ENV || 'development';

// VAPID / web-push config
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

// Prefer installer location for .vapid.json (installer writes /opt/sTalk/.vapid.json).
const DEFAULT_VAPID_LOCATIONS = [
  process.env.VAPID_FILE_PATH,
  '/opt/sTalk/.vapid.json',
  path.join(__dirname, '.vapid.json')
].filter(Boolean);
const VAPID_FILE_PATH = DEFAULT_VAPID_LOCATIONS[0];

// Helper: load VAPID keys from .vapid.json (if present)
function loadVapidFromFile() {
    for (const p of DEFAULT_VAPID_LOCATIONS) {
        try {
            if (p && fs.existsSync(p)) {
                const raw = fs.readFileSync(p, 'utf8');
                const json = JSON.parse(raw);
                if (json && json.publicKey && json.privateKey) {
                    VAPID_PUBLIC_KEY = json.publicKey;
                    VAPID_PRIVATE_KEY = json.privateKey;
                    console.log('🔑 Loaded VAPID keys from', p);
                    try {
                        webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
                        console.log('✅ web-push configured with VAPID keys');
                    } catch (e) {
                        console.warn('⚠️ Failed to set VAPID details on web-push:', e);
                    }
                    return true;
                }
            }
        } catch (err) {
            console.warn('⚠️ Error reading VAPID file', p, ':', err.message || err);
        }
    }
    return false;
}

// If VAPID env vars were present at startup, configure web-push immediately
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    try {
        webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
        console.log('✅ web-push configured from environment variables');
    } catch (e) {
        console.warn('⚠️ Failed to set VAPID details from env:', e);
    }
} else {
    const loaded = loadVapidFromFile();
    if (!loaded) {
        console.warn('⚠️ VAPID keys not configured. Push will be disabled until VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set (or .vapid.json is created).');
    }
}

// Ensure required directories exist
[
  path.dirname(DB_PATH),
  UPLOAD_PATH,
  path.join(UPLOAD_PATH, 'files'),
  path.join(UPLOAD_PATH, 'images'),
  path.join(UPLOAD_PATH, 'audio'),
  path.join(UPLOAD_PATH, 'documents'),
  PROFILE_PATH
].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // disabled to allow service-worker / inline assets as needed
    crossOriginEmbedderPolicy: false
}));

// Multer storage for general files: chooses folder by mimetype
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        let uploadDir = path.join(UPLOAD_PATH, 'files');

        if (file.mimetype && file.mimetype.startsWith('image/')) {
            uploadDir = path.join(UPLOAD_PATH, 'images');
        } else if (file.mimetype && file.mimetype.startsWith('audio/')) {
            uploadDir = path.join(UPLOAD_PATH, 'audio');
        } else if (file.mimetype && (file.mimetype.includes('pdf') || file.mimetype.includes('document') || file.mimetype.includes('msword'))) {
            uploadDir = path.join(UPLOAD_PATH, 'documents');
        }

        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || (mime.extension(file.mimetype) ? '.' + mime.extension(file.mimetype) : '');
        cb(null, `${uniqueSuffix}${ext}`);
    }
});

// Profile image storage (filename uses user id from authenticateToken middleware)
const profileStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, PROFILE_PATH);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || (mime.extension(file.mimetype) ? '.' + mime.extension(file.mimetype) : '');
        const uid = req.user && req.user.id ? req.user.id : 'anon';
        cb(null, `profile-${uid}-${uniqueSuffix}${ext}`);
    }
});

// Allowed types (prefix-based and a small set of specific MIME types)
const ALLOWED_PREFIXES = ['image/', 'audio/', 'video/', 'text/'];
const ALLOWED_EXACT = [
    'application/pdf',
    'application/zip',
    'application/x-7z-compressed',
    'application/x-rar-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/json'
];

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB
        files: 10
    },
    fileFilter: function (req, file, cb) {
        const mimetype = file.mimetype || '';
        const allowed = ALLOWED_PREFIXES.some(p => mimetype.startsWith(p)) || ALLOWED_EXACT.includes(mimetype);
        if (allowed) cb(null, true);
        else cb(new Error('File type not allowed'), false);
    }
});

const profileUpload = multer({
    storage: profileStorage,
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: function (req, file, cb) {
        if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed for profile pictures'), false);
    }
});

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: NODE_ENV === 'production' ? 200 : 1000,
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

const uploadLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 20,
    message: { error: 'Too many file uploads, please try again later.' }
});

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files
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

// Database init
let db;
const initDatabase = () => new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
            console.error('❌ Database connection failed:', err);
            return reject(err);
        }
        console.log('✅ Connected to SQLite database');
        initializeTables().then(resolve).catch(reject);
    });
});

function initializeTables() {
    return new Promise((resolve, reject) => {
        db.run('PRAGMA foreign_keys = ON');

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

        db.run(`CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT UNIQUE NOT NULL,
            participant1 TEXT NOT NULL,
            participant2 TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

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
            if (err) return reject(err);
            createDefaultUsers().then(resolve).catch(reject);
        });
    });
}

function createDefaultUsers() {
    return new Promise((resolve) => {
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
                        [username, hashedPassword, fullName, gender, role, avatar], () => {});
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

// Auth middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        db.run('UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?', [user.id], () => {});
        next();
    });
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'Admin') return res.status(403).json({ error: 'Admin access required' });
    next();
}

// Utility helpers
function generateChatId(user1, user2) {
    return [user1, user2].sort().join('_');
}

function getFileIcon(mimeType) {
    if (!mimeType) return '📎';
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

// Web-push helper
async function sendPushToUser(userId, payload) {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        const loaded = loadVapidFromFile();
        if (!loaded) {
            console.warn('VAPID keys missing, skipping push.');
            return;
        }
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
                    console.warn('⚠️ Push send error for endpoint:', r.endpoint, 'status:', status);
                    if (status === 410 || status === 404) {
                        db.run('DELETE FROM push_subscriptions WHERE id = ?', [r.id], () => {});
                    }
                }
            });

            try { await Promise.all(promises); } catch (e) {}
            resolve();
        });
    });
}

// Routes: Authentication
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });

        db.run('UPDATE users SET last_active = CURRENT_TIMESTAMP, is_online = 1 WHERE id = ?', [user.id]);

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });

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
    db.get('SELECT id, username, full_name, gender, role, avatar, profile_image, theme_preference FROM users WHERE id = ?', [req.user.id], (err, user) => {
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
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    if (newPassword.length < 4 || newPassword.length > 12) return res.status(400).json({ error: 'Password must be 4-12 characters' });

    db.get('SELECT password FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user || !bcrypt.compareSync(currentPassword, user.password)) return res.status(401).json({ error: 'Current password is incorrect' });

        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to update password' });
            res.json({ message: 'Password updated successfully' });
        });
    });
});

app.post('/api/auth/logout', authenticateToken, (req, res) => {
    db.run('UPDATE users SET is_online = 0 WHERE id = ?', [req.user.id], () => {});
    res.json({ message: 'Logged out successfully' });
});

// Profile image upload route
app.post('/api/profile/image', authenticateToken, uploadLimiter, profileUpload.single('profileImage'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const publicPath = `/uploads/profiles/${req.file.filename}`;

    // Delete old profile image if exists
    db.get('SELECT profile_image FROM users WHERE id = ?', [req.user.id], (err, user) => {
        if (user && user.profile_image) {
            const oldImagePath = path.join(PROFILE_PATH, path.basename(user.profile_image));
            try { if (fs.existsSync(oldImagePath)) fs.unlinkSync(oldImagePath); } catch (e) {}
        }

        // Update db with public path (store relative/accessible path)
        db.run('UPDATE users SET profile_image = ? WHERE id = ?', [publicPath, req.user.id], (err) => {
            if (err) return res.status(500).json({ error: 'Failed to update profile image' });

            res.json({
                message: 'Profile image updated successfully',
                profileImage: publicPath
            });
        });
    });
});

app.post('/api/profile/avatar', authenticateToken, (req, res) => {
    const { type, value } = req.body;
    if (!type || !value) return res.status(400).json({ error: 'Avatar type and value required' });

    db.run('UPDATE users SET avatar = ?, profile_image = NULL WHERE id = ?', [value, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to update avatar' });
        res.json({ message: 'Avatar updated successfully' });
    });
});

// File uploads endpoint
app.post('/api/upload', authenticateToken, uploadLimiter, upload.array('files', 10), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const uploadedFiles = [];
    const stmt = db.prepare(`INSERT INTO file_uploads (file_id, original_name, file_path, file_size, mime_type, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`);

    req.files.forEach(file => {
        const fileId = crypto.randomUUID();
        const relative = `/uploads/${path.relative(UPLOAD_PATH, file.path).replace(/\\/g, '/')}`;
        stmt.run([fileId, file.originalname, relative, file.size, file.mimetype, req.user.username], (err) => {
            if (err) console.warn('Failed to record file upload in DB:', err);
        });

        uploadedFiles.push({
            fileId,
            originalName: file.originalname,
            filename: file.filename,
            path: relative,
            size: file.size,
            mimeType: file.mimetype,
            icon: getFileIcon(file.mimetype)
        });
    });

    stmt.finalize();
    res.json({ files: uploadedFiles });
});

// Users
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
            profileImage: user.profile_image ? user.profile_image : null,
            isOnline: !!user.is_online,
            lastActive: user.last_active
        })));
    });
});

// Get chat messages
app.get('/api/chats/:otherUserId', authenticateToken, (req, res) => {
    const otherUserId = req.params.otherUserId;

    db.get('SELECT username FROM users WHERE id = ?', [otherUserId], (err, otherUser) => {
        if (err || !otherUser) return res.status(404).json({ error: 'User not found' });

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
                senderProfileImage: msg.profile_image ? msg.profile_image : null,
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

// Send message
app.post('/api/chats/:otherUserId/messages', authenticateToken, (req, res) => {
    const { content, messageType = 'text', fileInfo } = req.body;
    const otherUserId = req.params.otherUserId;

    if (!content && !fileInfo) return res.status(400).json({ error: 'Message content or file required' });

    db.get('SELECT username, id FROM users WHERE id = ?', [otherUserId], (err, otherUser) => {
        if (err || !otherUser) return res.status(404).json({ error: 'User not found' });

        const chatId = generateChatId(req.user.username, otherUser.username);

        db.run(`INSERT OR IGNORE INTO chats (chat_id, participant1, participant2) VALUES (?, ?, ?)`, [chatId, req.user.username, otherUser.username]);
        db.run('UPDATE chats SET updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?', [chatId]);

        const messageData = [
            chatId,
            req.user.username,
            content || null,
            messageType,
            fileInfo?.path || null,
            fileInfo?.originalName || null,
            fileInfo?.size || null,
            fileInfo?.mimeType || null
        ];

        db.run(`INSERT INTO messages (chat_id, sender, content, message_type, file_path, file_name, file_size, file_type) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, messageData, function(err) {
            if (err) return res.status(500).json({ error: 'Failed to send message' });

            const messageId = this.lastID;
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
                    senderProfileImage: message.profile_image ? message.profile_image : null,
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

                // Emit sockets
                io.to(`user_${req.user.id}`).emit('message_sent', responseData);
                io.to(`user_${otherUserId}`).emit('message_received', responseData);

                // Push notification payload
                const pushPayload = {
                    title: `${responseData.senderName} • sTalk`,
                    body: responseData.content ? responseData.content.substring(0, 120) : (responseData.fileName ? `Sent: ${responseData.fileName}` : 'New message'),
                    data: { chatId: responseData.chatId, sender: responseData.sender, url: `/chats/${responseData.chatId}` },
                    tag: `chat-${responseData.chatId}`
                };

                const recipientNumericId = parseInt(otherUserId, 10);
                if (!isNaN(recipientNumericId)) {
                    sendPushToUser(recipientNumericId, pushPayload).catch(() => {});
                }

                res.json(responseData);
            });
        });
    });
});

// Return VAPID public key
app.get('/api/push/key', (req, res) => {
    if (!VAPID_PUBLIC_KEY) {
        const loaded = loadVapidFromFile();
        if (!loaded) return res.json({ publicKey: '' });
    }
    res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

// Subscribe
app.post('/api/push/subscribe', authenticateToken, (req, res) => {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

    const endpoint = subscription.endpoint;
    const p256dh = subscription.keys ? subscription.keys.p256dh : null;
    const auth = subscription.keys ? subscription.keys.auth : null;
    const ua = req.headers['user-agent'] || null;

    db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [endpoint], (err, row) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (row) {
            db.run('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, ua = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
                [req.user.id, p256dh, auth, ua, row.id], (err) => {
                    if (err) return res.status(500).json({ error: 'Failed to update subscription' });
                    res.json({ message: 'Subscription updated' });
                });
        } else {
            db.run('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua) VALUES (?, ?, ?, ?, ?)',
                [req.user.id, endpoint, p256dh, auth, ua], function(err) {
                    if (err) return res.status(500).json({ error: 'Failed to save subscription' });
                    res.json({ message: 'Subscription saved' });
                });
        }
    });
});

// Unsubscribe
app.post('/api/push/unsubscribe', authenticateToken, (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Endpoint required' });
    db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.user.id], function(err) {
        if (err) return res.status(500).json({ error: 'Failed to remove subscription' });
        res.json({ message: 'Unsubscribed' });
    });
});

// Admin stats & user management (unchanged logic)
app.get('/api/admin/stats', authenticateToken, requireAdmin, (req, res) => {
    const stats = {};
    db.get('SELECT COUNT(*) as count FROM users', (err, result) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        stats.totalUsers = result?.count || 0;
        db.get('SELECT COUNT(*) as count FROM messages', (err, result) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            stats.totalMessages = result?.count || 0;
            db.get('SELECT COUNT(*) as count FROM file_uploads', (err, result) => {
                if (err) return res.status(500).json({ error: 'Database error' });
                stats.totalFiles = result?.count || 0;
                db.get('SELECT SUM(file_size) as size FROM file_uploads', (err, result) => {
                    if (err) return res.status(500).json({ error: 'Database error' });
                    stats.totalFileSize = result?.size || 0;
                    db.get('SELECT COUNT(DISTINCT chat_id) as count FROM messages WHERE sent_at > datetime("now", "-30 days")', (err, result) => {
                        if (err) return res.status(500).json({ error: 'Database error' });
                        stats.activeChats = result?.count || 0;
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

// Admin user management endpoints (same behavior)
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    db.all(`SELECT id, username, full_name, gender, role, avatar, profile_image, is_online, last_active, created_at FROM users ORDER BY created_at DESC`, (err, users) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(users.map(user => ({
            id: user.id,
            username: user.username,
            fullName: user.full_name,
            gender: user.gender,
            role: user.role,
            avatar: user.avatar,
            profileImage: user.profile_image ? user.profile_image : null,
            isOnline: !!user.is_online,
            lastActive: user.last_active,
            createdAt: user.created_at
        })));
    });
});

app.post('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
    const { username, fullName, password, role = 'User' } = req.body;
    if (!username || !fullName || !password) return res.status(400).json({ error: 'Username, full name, and password required' });
    if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'Username must be 3-20 characters' });
    if (password.length < 4 || password.length > 12) return res.status(400).json({ error: 'Password must be 4-12 characters' });

    const hashedPassword = bcrypt.hashSync(password, 10);
    const avatar = fullName.charAt(0).toUpperCase();

    db.run(`INSERT INTO users (username, password, full_name, gender, role, avatar) VALUES (?, ?, ?, ?, ?, ?)`,
        [username, hashedPassword, fullName, 'Other', role, avatar], function(err) {
            if (err) {
                if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists' });
                return res.status(500).json({ error: 'Failed to create user' });
            }
            res.json({ message: 'User created successfully', userId: this.lastID });
        });
});

app.put('/api/admin/users/:userId', authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.params;
    const { fullName } = req.body;
    if (!fullName) return res.status(400).json({ error: 'Full name required' });

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
        res.json({ message: 'Password reset successfully', tempPassword });
    });
});

app.delete('/api/admin/users/:userId', authenticateToken, requireAdmin, (req, res) => {
    const { userId } = req.params;
    if (parseInt(userId) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        db.get('SELECT username, profile_image FROM users WHERE id = ?', [userId], (err, user) => {
            if (err || !user) { db.run('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
            db.run('DELETE FROM messages WHERE sender = ?', [user.username], (err) => {
                if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Failed to delete user messages' }); }
                db.run('DELETE FROM file_uploads WHERE uploaded_by = ?', [user.username], (err) => {
                    if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Failed to delete user files' }); }
                    db.run('DELETE FROM chats WHERE participant1 = ? OR participant2 = ?', [user.username, user.username], (err) => {
                        if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Failed to delete user chats' }); }
                        db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
                            if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Failed to delete user' }); }
                            if (user.profile_image) {
                                const imagePath = path.join(PROFILE_PATH, path.basename(user.profile_image));
                                try { if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); } catch (e) {}
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
        if (users.length === 0) return res.json({ resetUsers: [] });

        users.forEach(user => {
            const tempPassword = generateTempPassword();
            const hashedPassword = bcrypt.hashSync(tempPassword, 10);
            db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id], (err) => {
                if (!err) resetUsers.push({ username: user.username, tempPassword });
                completed++;
                if (completed === users.length) res.json({ resetUsers });
            });
        });
    });
});

app.get('/api/admin/export', authenticateToken, requireAdmin, (req, res) => {
    const exportData = { users: [], messages: [], files: [], exportDate: new Date().toISOString() };
    db.all('SELECT * FROM users', (err, users) => {
        if (err) return res.status(500).json({ error: 'Failed to export users' });
        exportData.users = users.map(u => ({ id: u.id, username: u.username, fullName: u.full_name, role: u.role, createdAt: u.created_at }));
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
        db.run('DELETE FROM messages', (err) => {
            if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Failed to clear messages' }); }
            db.run('DELETE FROM chats', (err) => {
                if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Failed to clear chats' }); }
                db.run('DELETE FROM file_uploads', (err) => {
                    if (err) { db.run('ROLLBACK'); return res.status(500).json({ error: 'Failed to clear files' }); }
                    ['files', 'images', 'audio', 'documents'].forEach(dir => {
                        const dirPath = path.join(UPLOAD_PATH, dir);
                        if (fs.existsSync(dirPath)) {
                            fs.readdirSync(dirPath).forEach(file => {
                                try { fs.unlinkSync(path.join(dirPath, file)); } catch (e) {}
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

// Socket.IO handling
const connectedUsers = new Map();
io.on('connection', (socket) => {
    console.log('📱 User connected:', socket.id);

    socket.on('join_user_room', (userId) => {
        socket.join(`user_${userId}`);
        connectedUsers.set(socket.id, userId);
        db.run('UPDATE users SET is_online = 1 WHERE id = ?', [userId], () => {});
        socket.broadcast.emit('user_status_changed', { userId, isOnline: true });
    });

    socket.on('typing_start', ({ userId, userName }) => {
        socket.broadcast.emit('user_typing', { userId, userName, isTyping: true });
    });

    socket.on('typing_stop', ({ userId }) => {
        socket.broadcast.emit('user_typing', { userId, isTyping: false });
    });

    socket.on('disconnect', () => {
        const userId = connectedUsers.get(socket.id);
        if (userId) {
            db.run('UPDATE users SET is_online = 0, last_active = CURRENT_TIMESTAMP WHERE id = ?', [userId], () => {});
            connectedUsers.delete(socket.id);
            socket.broadcast.emit('user_status_changed', { userId, isOnline: false });
        }
    });
});

// Error handler (multer-aware)
app.use((err, req, res, next) => {
    console.error('💥 Error:', err && err.stack ? err.stack : err);
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
        if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Too many files. Maximum is 10 files per upload.' });
    }
    res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Fallback: serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
const gracefulShutdown = () => {
    console.log('\n🔄 Shutting down gracefully...');
    if (db) {
        db.run('UPDATE users SET is_online = 0', () => {
            db.close((err) => {
                if (err) console.error('❌ Database close error:', err);
                server.close(() => {
                    console.log('✅ Server closed');
                    process.exit(0);
                });
            });
        });
    } else {
        server.close(() => process.exit(0));
    }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Start app
async function startApp() {
    try {
        await initDatabase();
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`\n🚀 sTalk Server Started!`);
            console.log(`📱 Access: http://localhost:${PORT}`);
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
