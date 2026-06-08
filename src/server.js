require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { execSync } = require('child_process');
const prisma = require('./services/prismaClient');
const { addTicketToQueue } = require('./queue/agentQueue');
const { startRecoveryScheduler, retryFailedTicket, createRetryTicket } = require('./services/stuckTicketRecovery');
const { getStatus: getGroqStatus } = require('./services/groqService');
const encryptionService = require('./services/encryptionService');
const authService = require('./services/authService');
const sshService = require('./services/sshService');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3001;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'ticket-' + uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  // Accept only images
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
    files: 3 // Max 3 images per ticket
  },
  fileFilter: fileFilter
});

// Security Middleware
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:3001'];

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      'font-src': ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      'img-src': ["'self'", "data:", "blob:", "https:"],
      'connect-src': ["'self'", "https://api.groq.com", "https://cdnjs.cloudflare.com"],
      'worker-src': ["'self'", "blob:", "https://cdnjs.cloudflare.com"],
      'frame-src': ["'none'"],
      'object-src': ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'x-requested-with'],
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests — please slow down' });
  },
});

const ticketCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  validate: false,
  keyGenerator: (req) => req.user?.id || req.ip || '0.0.0.0',
  handler: (req, res) => {
    res.status(429).json({ error: 'Ticket creation limit reached — max 20 per hour' });
  },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  validate: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many webhook requests' });
  },
});

app.use('/api/', apiLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir)); // Serve uploaded images

// ============================================
// LOGIN RATE LIMITING
// ============================================
const loginAttempts = new Map(); // key: "ip:email" → { count, firstAttempt, lockedUntil }
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip, email) {
  const key = `${ip}:${email}`;
  const now = Date.now();
  const record = loginAttempts.get(key);

  if (!record) return { allowed: true };
  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, remainingSec };
  }
  // Reset if window expired
  if (now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.delete(key);
    return { allowed: true };
  }
  if (record.count >= RATE_LIMIT_MAX) {
    record.lockedUntil = now + RATE_LIMIT_WINDOW_MS;
    return { allowed: false, remainingSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
  }
  return { allowed: true };
}

function recordFailedLogin(ip, email) {
  const key = `${ip}:${email}`;
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record) {
    loginAttempts.set(key, { count: 1, firstAttempt: now, lockedUntil: null });
  } else {
    record.count++;
  }
}

function clearLoginAttempts(ip, email) {
  loginAttempts.delete(`${ip}:${email}`);
}

// Initialize Prisma (using shared client)

// ============================================
// AUDIT LOGGING
// ============================================
async function logAudit(req, action, resource = null, metadata = null) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: req.user?.id || null,
        vendorId: req.user?.vendorId || null,
        action,
        resource,
        metadata: metadata ? JSON.stringify(metadata) : null,
        ipAddress: req.ip || req.connection?.remoteAddress || '0.0.0.0',
        userAgent: req.headers['user-agent']?.substring(0, 500) || null,
      }
    });
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// ============================================
// ZOD VALIDATION SCHEMAS
// ============================================
const createTicketSchema = z.object({
  description: z.string().min(5).max(5000),
  title: z.string().max(200).optional(),
  category: z.enum(['BUG', 'FEATURE', 'ENHANCEMENT', 'OTHER']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  expectedBehavior: z.string().max(2000).optional(),
  actualBehavior: z.string().max(2000).optional(),
  stepsToReproduce: z.string().max(3000).optional(),
  filePath: z.string().max(500).optional(),
  targetRepoUrl: z.string().max(500).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(255),
});

const registerSchema = z.object({
  companyName: z.string().min(1).max(100),
  email: z.string().email().max(255),
  password: z.string().min(8).max(255),
  sshHost: z.string().min(1).max(255),
  sshUser: z.string().min(1).max(100),
  sshPassword: z.string().max(255).optional(),
  sshKey: z.string().max(10000).optional(),
  repoPath: z.string().min(1).max(500),
});

const approveTicketSchema = z.object({
  ticketId: z.string().uuid(),
});

// ============================================
// JWT AUTH MIDDLEWARE
// ============================================
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  // Also support legacy x-user-id for internal webhook calls
  const legacyUserId = req.headers['x-user-id'];
  const legacyEmail = req.headers['x-user-email'];

  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  // Support token in query param for SSE connections
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    // Legacy fallback: support x-user-id header for backward compat during migration
    if (legacyUserId) {
      try {
        let user = await prisma.user.findUnique({
          where: { id: legacyUserId },
          include: { vendor: { include: { config: true } } }
        });
        if (!user && legacyEmail) {
          user = await prisma.user.findUnique({
            where: { email: legacyEmail },
            include: { vendor: { include: { config: true } } }
          });
        }
        if (user) {
          req.user = user;
          return next();
        }
      } catch (e) {
        // fall through to 401
      }
    }
    return res.status(401).json({ error: 'No authentication token provided' });
  }

  try {
    const decoded = authService.verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { vendor: { include: { config: true } } }
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    if (!user.isActive) {
      return res.status(403).json({ error: 'Account has been deactivated' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired — please login again' });
    }
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
};

// Admin-only middleware
const adminOnly = (req, res, next) => {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Forbidden - Admin access required' });
  }
  next();
};

// ============================================
// AUTH ROUTES (Login / Register / Me)
// ============================================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.flatten() });
    }

    const { email, password } = validation.data;
    const clientIp = req.ip || req.connection?.remoteAddress || '0.0.0.0';
    const rateCheck = checkRateLimit(clientIp, email);
    if (!rateCheck.allowed) {
      await logAudit(req, 'LOGIN_RATE_LIMITED', null, { email, remainingSec: rateCheck.remainingSec });
      return res.status(429).json({
        error: `Too many login attempts. Try again in ${rateCheck.remainingSec} seconds.`
      });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { vendor: true }
    });

    if (!user) {
      recordFailedLogin(clientIp, email);
      await logAudit(req, 'LOGIN_FAILED', null, { email, reason: 'user_not_found' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.isActive) {
      await logAudit(req, 'LOGIN_FAILED', `user:${user.id}`, { email, reason: 'account_deactivated' });
      return res.status(403).json({ error: 'Account has been deactivated. Contact admin.' });
    }

    const passwordValid = await authService.comparePassword(password, user.passwordHash);
    if (!passwordValid) {
      recordFailedLogin(clientIp, email);
      await logAudit(req, 'LOGIN_FAILED', `user:${user.id}`, { email, reason: 'invalid_password' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Success — clear rate limit, update lastLoginAt
    clearLoginAttempts(clientIp, email);
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    const token = authService.generateToken(user);
    req.user = user;
    await logAudit(req, 'LOGIN_SUCCESS', `user:${user.id}`, { email, role: user.role });

    console.log(`🔐 Login: ${user.email} (${user.role}) from ${clientIp}`);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        vendorId: user.vendorId,
        vendorName: user.vendor?.name || null,
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Vendor Self-Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const validation = registerSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.flatten() });
    }

    const { companyName, email, password, sshHost, sshUser, sshPassword, sshKey, repoPath } = validation.data;

    // Check if email already registered
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Generate vendor slug
    let slug = authService.generateSlug(companyName);
    const slugExists = await prisma.vendor.findUnique({ where: { slug } });
    if (slugExists) {
      slug = slug + '-' + Date.now().toString(36);
    }

    // Create vendor
    const crypto = require('crypto');
    const vendor = await prisma.vendor.create({
      data: {
        id: crypto.randomUUID(),
        name: companyName.trim(),
        slug,
        isActive: true,
      }
    });

    // Create vendor config with SSH/repo details (encrypt sensitive fields)
    await prisma.vendorConfig.create({
      data: {
        id: crypto.randomUUID(),
        vendorId: vendor.id,
        repoPath: repoPath.trim(),
        sshHost: sshHost.trim(),
        sshUser: sshUser.trim(),
        sshPassword: sshPassword ? encryptionService.encrypt(sshPassword) : null,
        sshKey: sshKey ? encryptionService.encrypt(sshKey) : null,
      }
    });

    // Create user for this vendor
    const passwordHash = await authService.hashPassword(password);
    const user = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: email.toLowerCase().trim(),
        passwordHash,
        name: companyName.trim(),
        role: 'USER',
        vendorId: vendor.id,
        isActive: true,
      }
    });

    const token = authService.generateToken({ ...user, vendorId: vendor.id });
    req.user = user;
    await logAudit(req, 'VENDOR_REGISTERED', `vendor:${vendor.id}`, {
      vendorName: vendor.name,
      slug: vendor.slug,
      userEmail: user.email
    });

    console.log(`📋 New vendor registered: "${vendor.name}" (${vendor.slug}) by ${user.email}`);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        vendorId: vendor.id,
        vendorName: vendor.name,
      },
      vendor: {
        id: vendor.id,
        name: vendor.name,
        slug: vendor.slug,
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed: ' + error.message });
  }
});

// Get current user info
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    role: req.user.role,
    vendorId: req.user.vendorId,
    vendorName: req.user.vendor?.name || null,
  });
});

// ============================================
// NOTIFICATION SYSTEM
// ============================================

// In-memory notification storage (use Redis in production)
const notifications = new Map();
const adminConnections = new Set();

// Helper to broadcast JSON messages to all active admin SSE connections
function broadcastToAdmins(type, data) {
  const message = JSON.stringify({ type, data });
  const deadClients = [];
  adminConnections.forEach(client => {
    try {
      client.write(`data: ${message}\n\n`);
    } catch (e) {
      deadClients.push(client);
    }
  });
  deadClients.forEach(client => adminConnections.delete(client));
}

// Add notification for admins
async function notifyAdmins(ticket) {
  const notification = {
    id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    ticketId: ticket.id,
    description: ticket.description,
    status: ticket.status,
    clientId: ticket.clientId,
    createdAt: new Date().toISOString(),
    read: false
  };

  // Get user info for the notification
  try {
    const user = await prisma.user.findUnique({
      where: { id: ticket.clientId },
      select: { name: true, email: true }
    });
    notification.userName = user?.name || 'Unknown';
  } catch (e) {
    notification.userName = 'Unknown';
  }

  // Cache notification in memory
  notifications.set(notification.id, notification);

  // Keep map size reasonable (last 1000 items)
  if (notifications.size > 1000) {
    const oldestKey = notifications.keys().next().value;
    notifications.delete(oldestKey);
  }

  // Broadcast the new notification to all active connections
  broadcastToAdmins('NEW_TICKET', notification);

  console.log(`🔔 Admin notification sent for ticket ${ticket.id}`);
  return notification;
}

// SSE endpoint for admin notifications
app.get('/api/admin/notifications/stream', authMiddleware, adminOnly, (req, res) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

  // Send initial connection message
  res.write('data: {"type":"connected","message":"Notification stream connected"}\n\n');

  // Add client to connections
  adminConnections.add(res);

  // Send unread notification count
  const unreadCount = Array.from(notifications.values()).filter(n => !n.read).length;
  res.write(`data: {"type":"unread_count","count":${unreadCount}}\n\n`);

  // Send recent notifications (last 20)
  const recentNotifications = Array.from(notifications.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);
  res.write(`data: {"type":"initial","notifications":${JSON.stringify(recentNotifications)}}\n\n`);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write('data: {"type":"heartbeat"}\n\n');
    } catch (e) {
      clearInterval(heartbeat);
      adminConnections.delete(res);
    }
  }, 30000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    adminConnections.delete(res);
    console.log('Admin disconnected from notification stream');
  });
});

// Get notifications (paginated)
app.get('/api/admin/notifications', authMiddleware, adminOnly, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const unreadOnly = req.query.unread === 'true';

  let notifs = Array.from(notifications.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (unreadOnly) {
    notifs = notifs.filter(n => !n.read);
  }

  const total = notifs.length;
  const paginated = notifs.slice((page - 1) * limit, page * limit);

  res.json({
    notifications: paginated,
    total,
    unreadCount: Array.from(notifications.values()).filter(n => !n.read).length
  });
});

// Mark notification as read
app.patch('/api/admin/notifications/:id/read', authMiddleware, adminOnly, (req, res) => {
  const notification = notifications.get(req.params.id);
  if (notification) {
    notification.read = true;
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Notification not found' });
  }
});

// Mark all notifications as read
app.post('/api/admin/notifications/mark-all-read', authMiddleware, adminOnly, (req, res) => {
  notifications.forEach(n => n.read = true);
  res.json({ success: true, message: 'All notifications marked as read' });
});

// Reset failed ticket (Admin only)
// NOTE: This marks as FAILED and recommends creating NEW ticket
app.post('/api/admin/tickets/:id/reset', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await retryFailedTicket(req.params.id);
    if (result.success) {
      res.json({
        success: true,
        message: result.message,
        recommendation: 'Create NEW ticket to retry immediately',
        retryInstructions: result.retryInstructions
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error resetting ticket:', error);
    res.status(500).json({ error: 'Failed to reset ticket' });
  }
});

// Create retry ticket (Admin only - BEST OPTION)
// This creates a NEW ticket which triggers flow immediately
app.post('/api/admin/tickets/:id/retry', authMiddleware, adminOnly, async (req, res) => {
  try {
    const originalTicket = await prisma.ticket.findUnique({
      where: { id: req.params.id }
    });

    if (!originalTicket) {
      return res.status(404).json({ error: 'Original ticket not found' });
    }

    // Create retry ticket - this triggers flow immediately
    const result = await createRetryTicket(req.params.id, req.user.id);

    if (result.success) {
      // Add the new ticket to queue (this triggers the flow)
      await addTicketToQueue(result.ticketId, {
        issueDescription: `RETRY: ${originalTicket.description}`,
        targetRepoUrl: originalTicket.targetRepoUrl
      });

      // Notify admins about the retry ticket
      const retryTicket = await prisma.ticket.findUnique({
        where: { id: result.ticketId }
      });
      await notifyAdmins(retryTicket);

      res.json({
        success: true,
        message: 'Retry ticket created and flow triggered immediately',
        originalTicketId: req.params.id,
        newTicketId: result.ticketId,
        note: 'This is the BEST option - flow triggers right away'
      });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error creating retry ticket:', error);
    res.status(500).json({ error: 'Failed to create retry ticket' });
  }
});

// Get Groq AI status (Admin only)
app.get('/api/admin/groq-status', authMiddleware, adminOnly, (req, res) => {
  try {
    const status = getGroqStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting Groq status:', error);
    res.status(500).json({ error: 'Failed to get Groq status' });
  }
});

// ============================================
// USER ROUTES (Customer Side)
// ============================================

// Create a new ticket (User only) - supports image uploads
app.post('/api/tickets', authMiddleware, ticketCreateLimiter, upload.array('images', 3), async (req, res) => {
  try {
    const validation = createTicketSchema.safeParse(req.body);
    if (!validation.success) {
      if (req.files) req.files.forEach(file => fs.unlinkSync(file.path));
      return res.status(400).json({ error: 'Invalid input', details: validation.error.flatten() });
    }

    const { description, title, category, priority, expectedBehavior, actualBehavior, stepsToReproduce, filePath } = validation.data;

    // Collect and validate image paths
    let imagePaths = [];
    if (req.files && req.files.length > 0) {
      const fs = require('fs');
      const path = require('path');

      // Verify each uploaded file exists before storing reference
      imagePaths = req.files
        .filter(file => {
          const fullPath = path.join(uploadsDir, file.filename);
          const exists = fs.existsSync(fullPath);
          if (!exists) {
            console.warn(`⚠️ Uploaded file not found on disk: ${file.filename}`);
          }
          return exists;
        })
        .map(file => `/uploads/${file.filename}`);

      // Log validation results
      if (imagePaths.length !== req.files.length) {
        console.warn(`⚠️ Image validation: ${imagePaths.length}/${req.files.length} files verified`);
      }
    }

    // Resolve vendor's repo path
    const vendorRepoPath = req.user.vendor?.config?.repoPath || '/var/www/adelphos_frontend';

    // Build rich description from structured fields if available
    let richDescription = description.trim();
    if (expectedBehavior || actualBehavior || stepsToReproduce || filePath) {
      const parts = [description.trim()];
      if (expectedBehavior) parts.push(`Expected behavior: ${expectedBehavior}`);
      if (actualBehavior) parts.push(`Actual behavior: ${actualBehavior}`);
      if (stepsToReproduce) parts.push(`Steps to reproduce: ${stepsToReproduce}`);
      if (filePath) parts.push(`Target file: ${filePath}`);
      richDescription = parts.join('\n\n');
    }

    const ticket = await prisma.ticket.create({
      data: {
        clientId: req.user.id,
        vendorId: req.user.vendorId || null,
        title: title?.trim() || null,
        description: richDescription,
        category: category || 'BUG',
        priority: priority || 'MEDIUM',
        expectedBehavior: expectedBehavior?.trim() || null,
        actualBehavior: actualBehavior?.trim() || null,
        stepsToReproduce: stepsToReproduce?.trim() || null,
        filePath: filePath?.trim() || null,
        targetRepoUrl: vendorRepoPath,
        status: 'PENDING',
        imageReferences: imagePaths.length > 0 ? JSON.stringify(imagePaths) : null
      }
    });

    // Add to processing queue
    await addTicketToQueue(ticket.id, {
      issueDescription: ticket.description,
      targetRepoUrl: ticket.targetRepoUrl
    });

    // Notify admins in real-time
    await notifyAdmins(ticket);
    await logAudit(req, 'TICKET_CREATED', `ticket:${ticket.id}`, {
      description: ticket.description.substring(0, 200),
      imageCount: imagePaths.length,
      targetRepoUrl: ticket.targetRepoUrl
    });

    res.json({
      success: true,
      ticketId: ticket.id,
      message: 'Ticket created and queued for processing',
      imagesUploaded: imagePaths.length
    });
  } catch (error) {
    // Clean up uploaded files on error
    if (req.files) {
      req.files.forEach(file => {
        try { fs.unlinkSync(file.path); } catch (e) {}
      });
    }
    console.error('Error creating ticket:', error);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

// Get my tickets (User only — scoped to vendor)
app.get('/api/tickets/my', authMiddleware, async (req, res) => {
  try {
    const whereClause = { clientId: req.user.id };
    // Scope to vendor if user has one
    if (req.user.vendorId) {
      whereClause.vendorId = req.user.vendorId;
    }

    const tickets = await prisma.ticket.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        description: true,
        category: true,
        priority: true,
        expectedBehavior: true,
        actualBehavior: true,
        stepsToReproduce: true,
        filePath: true,
        status: true,
        progress: true,
        imageReferences: true,
        createdAt: true,
        updatedAt: true
      }
    });

    // Parse image references
    const ticketsWithImages = tickets.map(ticket => ({
      ...ticket,
      images: ticket.imageReferences ? JSON.parse(ticket.imageReferences) : []
    }));

    res.json({ tickets: ticketsWithImages });
  } catch (error) {
    console.error('Error fetching user tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Get ticket details (User - only their own)
app.get('/api/tickets/:id', authMiddleware, async (req, res) => {
  try {
    const ticket = await prisma.ticket.findFirst({
      where: {
        id: req.params.id,
        clientId: req.user.id
      },
      select: {
        id: true,
        title: true,
        description: true,
        category: true,
        priority: true,
        expectedBehavior: true,
        actualBehavior: true,
        stepsToReproduce: true,
        filePath: true,
        status: true,
        progress: true,
        imageReferences: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json({
      ...ticket,
      images: ticket.imageReferences ? JSON.parse(ticket.imageReferences) : []
    });
  } catch (error) {
    console.error('Error fetching ticket:', error);
    res.status(500).json({ error: 'Failed to fetch ticket' });
  }
});

// ============================================
// ADMIN ROUTES (Agency Side)
// ============================================

// Get all tickets with full details (Admin only)
app.get('/api/admin/tickets', authMiddleware, adminOnly, async (req, res) => {
  try {
    const whereClause = {};
    // Optional vendor filter
    if (req.query.vendorId) {
      whereClause.vendorId = req.query.vendorId;
    }

    const tickets = await prisma.ticket.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true
          }
        },
        vendor: {
          select: {
            id: true,
            name: true,
            slug: true
          }
        }
      }
    });

    // Parse image references
    const ticketsWithImages = tickets.map(ticket => ({
      ...ticket,
      images: ticket.imageReferences ? JSON.parse(ticket.imageReferences) : []
    }));

    res.json({ tickets: ticketsWithImages });
  } catch (error) {
    console.error('Error fetching all tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});

// Get ticket with full processing details (Admin only)
app.get('/api/admin/tickets/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: req.params.id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true
          }
        }
      }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Parse JSON fields
    const proposed = ticket.proposedChanges ? JSON.parse(ticket.proposedChanges) : null;
    if (proposed && proposed.changes) {
      if (!proposed.originals) {
        proposed.originals = {};
      }
      let repoPath = proposed.repoPath || '/var/www/adelphos_frontend';
      try {
        const repoPathCfg = await prisma.systemConfig.findUnique({ where: { key: 'repo_path' } });
        if (repoPathCfg && repoPathCfg.value) repoPath = repoPathCfg.value;
      } catch (e) {}

      const baseCommit = proposed.baseCommit;
      if (baseCommit) {
        for (const change of proposed.changes) {
          const file = change.filename;
          if (proposed.originals[file] === undefined || proposed.originals[file] === null) {
            try {
              const orig = await sshExec(`cd ${repoPath} && git show ${baseCommit}:${file} 2>/dev/null || echo "___FILE_NOT_FOUND___"`);
              proposed.originals[file] = orig === '___FILE_NOT_FOUND___' ? null : orig;
            } catch (e) {
              console.error(`Failed to fetch original for ${file}:`, e);
            }
          }
        }
      }
    }

    const response = {
      ...ticket,
      images: ticket.imageReferences ? JSON.parse(ticket.imageReferences) : [],
      validation: ticket.validationJson ? JSON.parse(ticket.validationJson) : null,
      execution: ticket.executionJson ? JSON.parse(ticket.executionJson) : null,
      proposed: proposed
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching ticket details:', error);
    res.status(500).json({ error: 'Failed to fetch ticket details' });
  }
});

// Internal secure endpoint for background queue worker ticket updates (strict security applied)
app.post('/api/internal/tickets/:id/update', async (req, res) => {
  const { id } = req.params;
  const key = req.headers['x-internal-key'];

  // 1. Localhost Loopback Constraint
  const clientIp = req.ip || req.connection.remoteAddress || '127.0.0.1';
  const isLocalhost = 
    clientIp === '127.0.0.1' || 
    clientIp === '::1' || 
    clientIp === '::ffff:127.0.0.1' || 
    clientIp.endsWith('127.0.0.1');

  if (!isLocalhost) {
    console.warn(`⚠️ SECURE WEBHOOK: Rejected non-localhost request from ${clientIp}`);
    return res.status(403).json({ error: 'Access forbidden: Localhost loopback connection required.' });
  }

  // 2. Cryptographic Token Authorization
  const expectedKey = process.env.INTERNAL_KEY || 'autobug-secret-key-123';
  if (!key || key !== expectedKey) {
    console.warn(`⚠️ SECURE WEBHOOK: Invalid authorization token from ${clientIp}`);
    return res.status(401).json({ error: 'Unauthorized: Invalid internal authentication key.' });
  }

  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, email: true, name: true }
        }
      }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    // Parse and dynamically resolve originals just like the detail API to keep data clean
    const proposed = ticket.proposedChanges ? JSON.parse(ticket.proposedChanges) : null;
    if (proposed && proposed.changes) {
      if (!proposed.originals) {
        proposed.originals = {};
      }
      let repoPath = proposed.repoPath || '/var/www/adelphos_frontend';
      try {
        const repoPathCfg = await prisma.systemConfig.findUnique({ where: { key: 'repo_path' } });
        if (repoPathCfg && repoPathCfg.value) repoPath = repoPathCfg.value;
      } catch (e) {}

      const baseCommit = proposed.baseCommit;
      if (baseCommit) {
        for (const change of proposed.changes) {
          const file = change.filename;
          if (proposed.originals[file] === undefined || proposed.originals[file] === null) {
            try {
              const orig = await sshExec(`cd ${repoPath} && git show ${baseCommit}:${file} 2>/dev/null || echo "___FILE_NOT_FOUND___"`);
              proposed.originals[file] = orig === '___FILE_NOT_FOUND___' ? null : orig;
            } catch (e) {
              console.error(`Failed to fetch original for ${file}:`, e);
            }
          }
        }
      }
    }

    const parsedTicket = {
      ...ticket,
      images: ticket.imageReferences ? JSON.parse(ticket.imageReferences) : [],
      validation: ticket.validationJson ? JSON.parse(ticket.validationJson) : null,
      execution: ticket.executionJson ? JSON.parse(ticket.executionJson) : null,
      proposed: proposed
    };

    // Broadcast update in real-time to all connected active SSE sessions
    broadcastToAdmins('TICKET_UPDATE', parsedTicket);

    res.json({ success: true, message: 'Ticket update broadcasted successfully.' });
  } catch (error) {
    console.error('Error handling internal ticket update:', error);
    res.status(500).json({ error: 'Failed to process ticket update.' });
  }
});

// Update ticket status (Admin only - for manual intervention)
app.patch('/api/admin/tickets/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, adminNotes, assignedTo } = req.body;

    const updateData = {};
    if (status) updateData.status = status;
    if (adminNotes) updateData.adminNotes = adminNotes;
    if (assignedTo) updateData.assignedTo = assignedTo;

    const ticket = await prisma.ticket.update({
      where: { id: req.params.id },
      data: updateData
    });

    res.json({
      success: true,
      ticket,
      message: 'Ticket updated successfully'
    });
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// Get dashboard stats (Admin only)
app.get('/api/admin/stats', authMiddleware, adminOnly, async (req, res) => {
  try {
    const filter = {};
    if (req.query.vendorId) {
      filter.vendorId = req.query.vendorId;
    }

    const [
      totalTickets,
      pendingTickets,
      processingTickets,
      reviewPendingTickets,
      completedTickets,
      failedTickets,
      waitingClaudeTickets
    ] = await Promise.all([
      prisma.ticket.count({ where: filter }),
      prisma.ticket.count({ where: { status: 'PENDING', ...filter } }),
      prisma.ticket.count({ where: { status: 'PROCESSING', ...filter } }),
      prisma.ticket.count({ where: { status: 'REVIEW_PENDING', ...filter } }),
      prisma.ticket.count({ where: { status: 'COMPLETED', ...filter } }),
      prisma.ticket.count({ where: { status: 'FAILED', ...filter } }),
      prisma.ticket.count({ where: { status: 'WAITING_CLAUDE', ...filter } })
    ]);

    res.json({
      total: totalTickets,
      pending: pendingTickets,
      processing: processingTickets,
      reviewPending: reviewPendingTickets,
      completed: completedTickets,
      failed: failedTickets,
      waitingClaude: waitingClaudeTickets
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================
// ADMIN VENDOR MANAGEMENT
// ============================================

// List all vendors with user count and ticket count
app.get('/api/admin/vendors', authMiddleware, adminOnly, async (req, res) => {
  try {
    const vendors = await prisma.vendor.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { users: true, tickets: true }
        },
        config: {
          select: {
            repoPath: true,
            sshHost: true,
            sshUser: true,
          }
        },
        users: {
          select: {
            id: true,
            email: true,
            name: true,
            isActive: true,
            lastLoginAt: true,
          }
        }
      }
    });
    res.json({ vendors });
  } catch (error) {
    console.error('Error fetching vendors:', error);
    res.status(500).json({ error: 'Failed to fetch vendors' });
  }
});

// Create vendor (Admin)
app.post('/api/admin/vendors', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, email, config } = req.body;
    const { repoPath, sshHost, sshUser, sshPassword, sshKey } = config || {};

    if (!name || !email) {
      return res.status(400).json({ error: 'Vendor name and user email are required' });
    }

    // Check if email already exists
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Generate slug
    const crypto = require('crypto');
    let slug = authService.generateSlug(name);
    const slugExists = await prisma.vendor.findUnique({ where: { slug } });
    if (slugExists) {
      slug = slug + '-' + Date.now().toString(36);
    }

    // Generate complex password for vendor user
    const plainPassword = authService.generateComplexPassword(16);
    const passwordHash = await authService.hashPassword(plainPassword);

    // Create vendor
    const vendor = await prisma.vendor.create({
      data: {
        id: crypto.randomUUID(),
        name: name.trim(),
        slug,
        isActive: true,
      }
    });

    // Create vendor config
    await prisma.vendorConfig.create({
      data: {
        id: crypto.randomUUID(),
        vendorId: vendor.id,
        repoPath: (repoPath || '/var/www/html').trim(),
        sshHost: sshHost ? sshHost.trim() : null,
        sshUser: sshUser ? sshUser.trim() : null,
        sshPassword: sshPassword ? encryptionService.encrypt(sshPassword) : null,
        sshKey: sshKey ? encryptionService.encrypt(sshKey) : null,
      }
    });

    // Create vendor user
    const user = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: email.toLowerCase().trim(),
        passwordHash,
        name: name.trim(),
        role: 'USER',
        vendorId: vendor.id,
        isActive: true,
      }
    });

    console.log(`📋 Admin created vendor: "${vendor.name}" (${vendor.slug}) with user ${user.email}`);

    res.status(201).json({
      success: true,
      vendor: {
        id: vendor.id,
        name: vendor.name,
        slug: vendor.slug,
      },
      user: {
        id: user.id,
        email: user.email,
        generatedPassword: plainPassword, // Only returned once at creation!
      },
      message: `Vendor created. Save the credentials securely — the password will not be shown again.`
    });
  } catch (error) {
    console.error('Error creating vendor:', error);
    res.status(500).json({ error: 'Failed to create vendor: ' + error.message });
  }
});

// Get vendor details (Admin)
app.get('/api/admin/vendors/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const vendor = await prisma.vendor.findUnique({
      where: { id: req.params.id },
      include: {
        config: true,
        users: {
          select: {
            id: true,
            email: true,
            name: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
          }
        },
        _count: {
          select: { tickets: true }
        }
      }
    });

    if (!vendor) {
      return res.status(404).json({ error: 'Vendor not found' });
    }

    // Mask sensitive config fields
    if (vendor.config) {
      const sensitiveFields = ['sshPassword', 'sshKey', 'gitPat', 'gitSshKey', 'gitSshPassphrase'];
      for (const field of sensitiveFields) {
        if (vendor.config[field]) {
          vendor.config[field] = '••••••••';
        }
      }
    }

    res.json({ vendor });
  } catch (error) {
    console.error('Error fetching vendor:', error);
    res.status(500).json({ error: 'Failed to fetch vendor' });
  }
});

// Update vendor (Admin)
app.put('/api/admin/vendors/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, isActive } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (isActive !== undefined) updateData.isActive = isActive;

    const vendor = await prisma.vendor.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({ success: true, vendor });
  } catch (error) {
    console.error('Error updating vendor:', error);
    res.status(500).json({ error: 'Failed to update vendor' });
  }
});

// Update vendor config (Admin)
app.put('/api/admin/vendors/:id/config', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { repoPath, sshHost, sshUser, sshPassword, sshKey, gitAuthUser, gitPat, gitSshKey, gitSshPassphrase, gitCommitName, gitCommitEmail } = req.body;

    const updateData = {};
    if (repoPath !== undefined) updateData.repoPath = repoPath.trim();
    if (sshHost !== undefined) updateData.sshHost = sshHost.trim();
    if (sshUser !== undefined) updateData.sshUser = sshUser.trim();
    if (sshPassword && sshPassword !== '••••••••') updateData.sshPassword = encryptionService.encrypt(sshPassword);
    if (sshKey && sshKey !== '••••••••') updateData.sshKey = encryptionService.encrypt(sshKey);
    if (gitAuthUser !== undefined) updateData.gitAuthUser = gitAuthUser;
    if (gitPat && gitPat !== '••••••••') updateData.gitPat = encryptionService.encrypt(gitPat);
    if (gitSshKey && gitSshKey !== '••••••••') updateData.gitSshKey = encryptionService.encrypt(gitSshKey);
    if (gitSshPassphrase && gitSshPassphrase !== '••••••••') updateData.gitSshPassphrase = encryptionService.encrypt(gitSshPassphrase);
    if (gitCommitName !== undefined) updateData.gitCommitName = gitCommitName;
    if (gitCommitEmail !== undefined) updateData.gitCommitEmail = gitCommitEmail;

    const config = await prisma.vendorConfig.update({
      where: { vendorId: req.params.id },
      data: updateData,
    });

    // Mask sensitive fields in response
    const sensitiveFields = ['sshPassword', 'sshKey', 'gitPat', 'gitSshKey', 'gitSshPassphrase'];
    const safeConfig = { ...config };
    for (const field of sensitiveFields) {
      if (safeConfig[field]) safeConfig[field] = '••••••••';
    }

    res.json({ success: true, config: safeConfig });
  } catch (error) {
    console.error('Error updating vendor config:', error);
    res.status(500).json({ error: 'Failed to update vendor config' });
  }
});

// Reset vendor user password (Admin)
app.post('/api/admin/users/:id/reset-password', authMiddleware, adminOnly, async (req, res) => {
  try {
    const plainPassword = authService.generateComplexPassword(16);
    const passwordHash = await authService.hashPassword(plainPassword);

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { passwordHash },
    });

    console.log(`🔑 Admin reset password for user: ${user.email}`);

    res.json({
      success: true,
      newPassword: plainPassword,
      message: 'Password reset. Save the new credentials securely — the password will not be shown again.'
    });
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Toggle user active status (Admin)
app.patch('/api/admin/users/:id/toggle-active', authMiddleware, adminOnly, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updated = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: !user.isActive },
    });

    res.json({ success: true, isActive: updated.isActive });
  } catch (error) {
    console.error('Error toggling user:', error);
    res.status(500).json({ error: 'Failed to toggle user status' });
  }
});

// ============================================
// ADMIN SETTINGS (Configurable repo path etc.)
// ============================================

// Helper: Get active repo path (DB config takes priority over .env)
async function getActiveRepoPath() {
  try {
    const config = await prisma.systemConfig.findUnique({ where: { key: 'target_repo_path' } });
    if (config && config.value) return config.value;
  } catch (e) { /* fallback to .env */ }
  return process.env.DEFAULT_REPO_PATH || '/var/www/adelphos_frontend';
}

// Get all admin settings
app.get('/api/admin/settings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const configs = await prisma.systemConfig.findMany();
    const settings = {};
    
    const sensitiveKeys = ['ssh_password', 'ssh_backend_password', 'git_pat', 'git_ssh_key', 'git_ssh_passphrase'];

    for (const c of configs) {
      if (sensitiveKeys.includes(c.key)) {
        settings[c.key] = { value: c.value ? '••••••••' : '', updatedAt: c.updatedAt, updatedBy: c.updatedBy };
      } else {
        settings[c.key] = { value: c.value, updatedAt: c.updatedAt, updatedBy: c.updatedBy };
      }
    }

    // Merge with defaults for any missing keys
    const defaults = {
      target_repo_path: process.env.DEFAULT_REPO_PATH || '/var/www/adelphos_frontend',
      ssh_host: process.env.SSH_HOST || '156.67.105.64',
      ssh_user: process.env.SSH_USER || 'root',
      ssh_password: process.env.SSH_PASSWORD ? '••••••••' : '',
      ssh_key_path: process.env.SSH_KEY_PATH || '',
      ssh_backend_host: process.env.SSH_BACKEND_HOST || '',
      ssh_backend_user: process.env.SSH_BACKEND_USER || '',
      ssh_backend_password: process.env.SSH_BACKEND_PASSWORD ? '••••••••' : '',
      ollama_model: process.env.OLLAMA_MODEL || 'kimi-k2.6',
      git_username: '',
      git_pat: '',
      git_ssh_key: '',
      git_ssh_passphrase: '',
      git_user_name: 'AutoBug',
      git_user_email: 'autobug@adelphostech.com'
    };

    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (!settings[key]) {
        settings[key] = { value: defaultValue, updatedAt: null, updatedBy: null, source: 'env-default' };
      }
    }

    res.json({ settings });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update a setting
app.put('/api/admin/settings/:key', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    const sensitiveKeys = ['ssh_password', 'ssh_backend_password', 'git_pat', 'git_ssh_key', 'git_ssh_passphrase'];

    // Whitelist of allowed config keys
    const allowedKeys = [
      'target_repo_path',
      'ssh_host',
      'ssh_user',
      'ssh_password',
      'ssh_backend_host',
      'ssh_backend_user',
      'ssh_backend_password',
      'ollama_model',
      'git_username',
      'git_pat',
      'git_ssh_key',
      'git_ssh_passphrase',
      'git_user_name',
      'git_user_email'
    ];
    if (!allowedKeys.includes(key)) {
      return res.status(400).json({ error: `Invalid setting key: ${key}. Allowed: ${allowedKeys.join(', ')}` });
    }

    // Ignore sensitive fields if submitted as placeholder or empty
    if (sensitiveKeys.includes(key) && (value === '••••••••' || !value || typeof value !== 'string' || value.trim().length === 0)) {
      return res.json({
        success: true,
        message: `Setting "${key}" was not changed (placeholder/empty ignored).`,
      });
    }

    if (!value || typeof value !== 'string' || value.trim().length === 0) {
      return res.status(400).json({ error: 'Value cannot be empty' });
    }

    // Basic validation per key
    if (key === 'target_repo_path') {
      if (!value.startsWith('/')) {
        return res.status(400).json({ error: 'Repo path must be an absolute path (start with /)' });
      }
    }

    // Encrypt sensitive keys before saving to database
    let dbValue = value;
    if (sensitiveKeys.includes(key)) {
      dbValue = encryptionService.encrypt(value);
    } else {
      dbValue = value.trim();
    }

    const config = await prisma.systemConfig.upsert({
      where: { key },
      update: { value: dbValue, updatedBy: req.user.email },
      create: { key, value: dbValue, updatedBy: req.user.email },
    });

    console.log(`⚙️  Setting updated by ${req.user.email}: ${key} = ${sensitiveKeys.includes(key) ? '••••••••' : dbValue}`);

    res.json({
      success: true,
      setting: { key: config.key, value: sensitiveKeys.includes(key) ? '••••••••' : config.value, updatedAt: config.updatedAt, updatedBy: config.updatedBy },
      message: `Setting "${key}" updated successfully`,
    });
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// Analyze credentials required for target repository
app.post('/api/admin/settings/analyze-repo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { target_repo_path } = req.body;
    if (!target_repo_path || typeof target_repo_path !== 'string' || !target_repo_path.startsWith('/')) {
      return res.status(400).json({ error: 'Repo path must be a valid absolute path starting with /' });
    }

    console.log(`🔍 Analyzing Git repository credentials for location: ${target_repo_path}`);

    // Check if target directory exists
    const checkDirResult = await sshExec(`[ -d "${target_repo_path}" ] && echo "exists" || echo "missing"`);
    if (checkDirResult !== 'exists') {
      return res.json({
        success: false,
        type: 'missing_directory',
        message: `The target directory "${target_repo_path}" does not exist on the remote server.`
      });
    }

    // Check if it is a Git repository
    const isGitResult = await sshExec(`cd ${target_repo_path} && git rev-parse --is-inside-work-tree 2>/dev/null || echo "not_git"`);
    if (isGitResult.trim() !== 'true') {
      return res.json({
        success: true,
        type: 'local_directory',
        message: 'Detected local folder path (Not a Git repository). No remote Git credentials are required.',
        requiredCredentials: []
      });
    }

    // Get origin remote URL
    const originUrl = await sshExec(`cd ${target_repo_path} && git remote get-url origin 2>/dev/null || echo "no_origin"`);
    const cleanUrl = originUrl.trim();

    if (cleanUrl === 'no_origin') {
      return res.json({
        success: true,
        type: 'local_git',
        message: 'Detected local Git repository (No remote origin configured). No remote Git credentials are required.',
        requiredCredentials: []
      });
    }

    // HTTPS protocol detection
    if (cleanUrl.startsWith('https://')) {
      return res.json({
        success: true,
        type: 'git_https',
        remoteUrl: cleanUrl,
        message: `Detected HTTPS Git repository (origin: ${cleanUrl}). Credentials needed: Git Username & Personal Access Token (PAT).`,
        requiredCredentials: ['git_username', 'git_pat']
      });
    }

    // SSH protocol detection (git@github.com:... or ssh://...)
    if (cleanUrl.startsWith('git@') || cleanUrl.startsWith('ssh://')) {
      return res.json({
        success: true,
        type: 'git_ssh',
        remoteUrl: cleanUrl,
        message: `Detected SSH Git repository (origin: ${cleanUrl}). Credentials needed: Git SSH Private Key & Passphrase (if encrypted).`,
        requiredCredentials: ['git_ssh_key', 'git_ssh_passphrase']
      });
    }

    // Default fallback
    return res.json({
      success: true,
      type: 'git_unknown',
      remoteUrl: cleanUrl,
      message: `Detected Git repository with custom origin: ${cleanUrl}. Suggesting Git Username & Personal Access Token (PAT).`,
      requiredCredentials: ['git_username', 'git_pat']
    });

  } catch (error) {
    console.error('Error analyzing repository:', error);
    res.status(500).json({ error: `Failed to analyze repository: ${error.message}` });
  }
});

// ============================================
// REVIEW & APPROVAL (Admin → Apply AI fix)
// ============================================

// SSH helper — delegates to centralized sshService (key-based auth preferred)
async function sshExec(command, connectionConfig = null, timeoutMs = 30000) {
  return sshService.writeAndExecute(command, connectionConfig, timeoutMs);
}

// Approve ticket — apply proposed changes to remote server + git commit
app.post('/api/admin/tickets/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: req.params.id },
      include: { vendor: { include: { config: true } } }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (ticket.status !== 'REVIEW_PENDING') {
      return res.status(400).json({
        error: `Cannot approve ticket with status: ${ticket.status}. Only REVIEW_PENDING tickets can be approved.`
      });
    }

    if (!ticket.proposedChanges) {
      return res.status(400).json({ error: 'No proposed changes found for this ticket' });
    }

    // Resolve connectionConfig based on vendorConfig
    let connectionConfig = null;
    if (ticket.vendor && ticket.vendor.config) {
      const vConfig = ticket.vendor.config;
      connectionConfig = {
        host: vConfig.sshHost,
        user: vConfig.sshUser,
        password: vConfig.sshPassword,
        sshKey: vConfig.sshKey
      };
    }

    const proposed = JSON.parse(ticket.proposedChanges);
    const activeRepoPath = await getActiveRepoPath();
    const repoPath = proposed.repoPath || activeRepoPath;
    const changes = proposed.changes || [];

    if (proposed.isGitCommitted) {
      console.log(`🟢 Admin ${req.user.email} approving ticket ${req.params.id} (already committed via Claude Code)`);
      await prisma.ticket.update({
        where: { id: req.params.id },
        data: {
          status: 'COMPLETED',
          adminNotes: `Approved by ${req.user.email}. Kept the automatic Git commit.`,
        }
      });
      return res.json({
        success: true,
        status: 'COMPLETED',
        appliedFiles: changes.map(c => c.filename),
        errors: [],
        message: `Approved successfully. Changes were already applied and committed by Claude Code.`
      });
    }

    if (changes.length === 0) {
      return res.status(400).json({ error: 'No file changes in proposed changes' });
    }

    await logAudit(req, 'TICKET_APPROVED', `ticket:${req.params.id}`, {
      adminEmail: req.user.email,
      changeCount: changes.length,
      repoPath
    });
    console.log(`🟢 Admin ${req.user.email} approving ticket ${req.params.id}`);
    console.log(`   Applying ${changes.length} file change(s)...`);

    const appliedFiles = [];
    const errors = [];

    for (const change of changes) {
      try {
        const remotePath = `${repoPath}/${change.filename}`;

        // ── SAFETY NET: Compare size before applying ──
        try {
          const currentSize = parseInt(await sshExec(`wc -c < ${remotePath} 2>/dev/null || echo "0"`, connectionConfig), 10);
          const newSize = Buffer.byteLength(change.content, 'utf8');

          if (currentSize > 200 && newSize < currentSize * 0.30) {
            const msg = `SAFETY BLOCK: New content for ${change.filename} is only ${((newSize/currentSize)*100).toFixed(0)}% ` +
              `the size of the current file (${newSize} vs ${currentSize} bytes). ` +
              `This looks like a destructive replacement — skipping this file.`;
            console.error(`   🚫 ${msg}`);
            errors.push({ file: change.filename, error: msg });
            continue;
          }
        } catch (sizeCheckErr) {
          console.log(`   ⚠️  Could not verify file size for ${change.filename} — proceeding`);
        }

        // Backup the file first
        await sshExec(`cp ${remotePath} ${remotePath}.autobug.bak 2>/dev/null || true`, connectionConfig);

        // Write the new content (full file replacement)
        const b64Content = Buffer.from(change.content).toString('base64');
        await sshExec(`echo '${b64Content}' | base64 -d > ${remotePath}`, connectionConfig);

        appliedFiles.push(change.filename);
        console.log(`   ✅ Applied: ${change.filename} (${change.content.length} chars)`);
      } catch (err) {
        console.error(`   ❌ Failed: ${change.filename} — ${err.message}`);
        errors.push({ file: change.filename, error: err.message });
      }
    }

    // Git commit the changes
    if (appliedFiles.length > 0) {
      try {
        const commitMsg = `fix: ${ticket.description.substring(0, 50)} [Autobug #${ticket.id.substring(0, 8)}]`;
        await sshExec(`cd ${repoPath} && git add -A && git commit -m "${commitMsg}" 2>/dev/null || true`, connectionConfig);
        console.log(`   ✅ Git committed`);
      } catch (e) {
        console.log(`   ⚠️  Git commit failed (non-fatal): ${e.message}`);
      }
    }

    // Update ticket status
    const finalStatus = appliedFiles.length > 0 ? 'COMPLETED' : 'FAILED';
    await prisma.ticket.update({
      where: { id: req.params.id },
      data: {
        status: finalStatus,
        adminNotes: `Approved by ${req.user.email}. Applied: ${appliedFiles.join(', ')}${errors.length > 0 ? '. Errors: ' + errors.map(e => e.file).join(', ') : ''}`,
      }
    });

    console.log(`   ✅ Ticket ${req.params.id} → ${finalStatus}`);

    res.json({
      success: true,
      status: finalStatus,
      appliedFiles,
      errors,
      message: `${appliedFiles.length} file(s) applied, ${errors.length} error(s)`,
    });

  } catch (error) {
    console.error('Error approving ticket:', error);
    res.status(500).json({ error: 'Failed to approve ticket: ' + error.message });
  }
});

// Reject ticket — admin decides not to apply the AI fix
app.post('/api/admin/tickets/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { reason } = req.body;

    const ticket = await prisma.ticket.findUnique({
      where: { id: req.params.id },
      include: { vendor: { include: { config: true } } }
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (ticket.status !== 'REVIEW_PENDING') {
      return res.status(400).json({
        error: `Cannot reject ticket with status: ${ticket.status}. Only REVIEW_PENDING tickets can be rejected.`
      });
    }

    let notes = `Rejected by ${req.user.email}${reason ? ': ' + reason : ''}.`;
    
    if (ticket.proposedChanges) {
      try {
        const proposed = JSON.parse(ticket.proposedChanges);
        if (proposed.isGitCommitted && proposed.baseCommit) {
          console.log(`🔴 Admin ${req.user.email} rejecting ticket ${req.params.id} (reverting to commit ${proposed.baseCommit})`);
          
          let connectionConfig = null;
          if (ticket.vendor && ticket.vendor.config) {
            const vConfig = ticket.vendor.config;
            connectionConfig = {
              host: vConfig.sshHost,
              user: vConfig.sshUser,
              password: vConfig.sshPassword,
              sshKey: vConfig.sshKey
            };
          }

          const activeRepoPath = await getActiveRepoPath();
          const repoPath = proposed.repoPath || activeRepoPath;
          await sshExec(`cd ${repoPath} && git reset --hard ${proposed.baseCommit}`, connectionConfig);
          console.log(`   ✅ Reverted repository to baseline`);
          notes += ` Changes reverted successfully.`;
        }
      } catch (e) {
        console.error(`   ⚠️  Revert failed (non-fatal): ${e.message}`);
        notes += ` Warning: failed to revert changes automatically.`;
      }
    }

    await prisma.ticket.update({
      where: { id: req.params.id },
      data: {
        status: 'FAILED',
        adminNotes: notes,
      }
    });

    await logAudit(req, 'TICKET_REJECTED', `ticket:${req.params.id}`, {
      adminEmail: req.user.email,
      reason: reason || null
    });
    console.log(`🔴 Admin ${req.user.email} rejected ticket ${req.params.id}`);

    res.json({
      success: true,
      status: 'FAILED',
      message: 'Ticket rejected and changes reverted successfully',
    });
  } catch (error) {
    console.error('Error rejecting ticket:', error);
    res.status(500).json({ error: 'Failed to reject ticket' });
  }
});

// Get current user info (legacy — use /api/auth/me instead)
app.get('/api/me', authMiddleware, async (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    role: req.user.role,
    vendorId: req.user.vendorId,
    vendorName: req.user.vendor?.name || null,
  });
});

// Health check with dependency verification
app.get('/api/health', async (req, res) => {
  const checks = { database: 'unknown', redis: 'unknown' };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch (e) {
    checks.database = 'error';
  }
  try {
    const Redis = require('ioredis');
    const redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      lazyConnect: true,
    });
    await redis.connect();
    checks.redis = 'ok';
    await redis.disconnect();
  } catch (e) {
    checks.redis = 'error';
  }
  const overall = Object.values(checks).every(c => c === 'ok') ? 'healthy' : 'degraded';
  res.status(overall === 'healthy' ? 200 : 503).json({
    status: overall,
    service: 'autobug-server',
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ============================================
// WEBHOOK (for external integrations)
// ============================================
app.post('/api/webhooks/chat-ticket', webhookLimiter, async (req, res) => {
  try {
    const webhookSchema = z.object({
      clientId: z.string().min(1).max(100),
      issueDescription: z.string().min(5).max(5000),
      targetRepoUrl: z.string().max(500).optional(),
    });

    const validation = webhookSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'Invalid input', details: validation.error.flatten() });
    }

    const { clientId, issueDescription, targetRepoUrl } = validation.data;

    // Ensure user exists
    let user = await prisma.user.findUnique({ where: { id: clientId } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          id: clientId,
          email: `user-${clientId}@temp.com`,
          name: 'External User'
        }
      });
    }

    const ticket = await prisma.ticket.create({
      data: {
        clientId,
        description: issueDescription,
        targetRepoUrl: targetRepoUrl || '/var/www/adelphos_frontend',
        status: 'PENDING'
      }
    });

    await addTicketToQueue(ticket.id, {
      issueDescription,
      targetRepoUrl
    });

    // Notify admins in real-time
    await notifyAdmins(ticket);
    await logAudit(req, 'TICKET_CREATED_WEBHOOK', `ticket:${ticket.id}`, {
      clientId,
      description: issueDescription.substring(0, 200),
      targetRepoUrl: ticket.targetRepoUrl
    });

    res.json({
      success: true,
      ticketId: ticket.id,
      message: 'Ticket received, AI agent is queueing.'
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve different UIs based on role
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`User UI: http://localhost:${port}`);
  console.log(`Admin UI: http://localhost:${port}/admin`);

  // Start stuck ticket recovery scheduler
  startRecoveryScheduler();
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received — shutting down gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed');
    try {
      await prisma.$disconnect();
      console.log('Database disconnected');
    } catch (e) {
      console.error('Error during shutdown:', e.message);
    }
    process.exit(0);
  });
  // Force exit after 15s if graceful shutdown hangs
  setTimeout(() => {
    console.error('Forced exit — graceful shutdown timed out');
    process.exit(1);
  }, 15000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
