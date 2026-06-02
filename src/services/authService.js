/**
 * Authentication Service — AutoBug Multi-Vendor SaaS
 * 
 * Provides JWT-based authentication, bcrypt password hashing,
 * and cryptographically secure password generation.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ─── Configuration ──────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'autobug_jwt_secret_change_in_production_2026';
const JWT_USER_EXPIRY = process.env.JWT_USER_EXPIRY || '24h';
const JWT_ADMIN_EXPIRY = process.env.JWT_ADMIN_EXPIRY || '8h';
const BCRYPT_ROUNDS = 12;

// ─── Password Hashing ──────────────────────────────────────────────────────

/**
 * Hash a plain-text password using bcrypt (12 rounds).
 * @param {string} plainPassword 
 * @returns {Promise<string>} bcrypt hash
 */
async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
}

/**
 * Compare a plain-text password against a bcrypt hash.
 * @param {string} plainPassword 
 * @param {string} hash 
 * @returns {Promise<boolean>}
 */
async function comparePassword(plainPassword, hash) {
  if (!hash || hash === '') return false;
  return bcrypt.compare(plainPassword, hash);
}

// ─── JWT Token Management ───────────────────────────────────────────────────

/**
 * Generate a signed JWT token for a user.
 * @param {object} user - Must include: id, email, role, vendorId
 * @returns {string} Signed JWT
 */
function generateToken(user) {
  const payload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    vendorId: user.vendorId || null,
  };

  const expiry = user.role === 'ADMIN' ? JWT_ADMIN_EXPIRY : JWT_USER_EXPIRY;

  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiry });
}

/**
 * Verify and decode a JWT token.
 * @param {string} token 
 * @returns {object} Decoded payload
 * @throws {Error} If token is invalid or expired
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ─── Complex Password Generator ─────────────────────────────────────────────

/**
 * Generate a cryptographically secure complex password.
 * Guarantees: at least 2 uppercase, 2 lowercase, 2 digits, 2 symbols.
 * @param {number} length - Minimum 12, default 16
 * @returns {string} Complex password
 */
function generateComplexPassword(length = 16) {
  if (length < 12) length = 12;

  const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';  // No I, O (avoid confusion)
  const lowercase = 'abcdefghjkmnpqrstuvwxyz';    // No i, l, o
  const digits = '23456789';                       // No 0, 1
  const symbols = '!@#$%&*?+-=';

  const allChars = uppercase + lowercase + digits + symbols;

  // Guarantee minimum character type diversity
  const guaranteed = [
    uppercase[crypto.randomInt(uppercase.length)],
    uppercase[crypto.randomInt(uppercase.length)],
    lowercase[crypto.randomInt(lowercase.length)],
    lowercase[crypto.randomInt(lowercase.length)],
    digits[crypto.randomInt(digits.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];

  // Fill remaining length with random chars
  const remaining = length - guaranteed.length;
  for (let i = 0; i < remaining; i++) {
    guaranteed.push(allChars[crypto.randomInt(allChars.length)]);
  }

  // Shuffle using Fisher-Yates
  for (let i = guaranteed.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [guaranteed[i], guaranteed[j]] = [guaranteed[j], guaranteed[i]];
  }

  return guaranteed.join('');
}

// ─── URL-Safe Slug Generator ────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a vendor name.
 * @param {string} name 
 * @returns {string} slug (e.g., "Acme Corp" → "acme-corp")
 */
function generateSlug(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  generateComplexPassword,
  generateSlug,
  JWT_SECRET,
};
