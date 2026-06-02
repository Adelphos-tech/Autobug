const crypto = require('crypto');

const keyString = process.env.ENCRYPTION_KEY;
if (!keyString) {
  console.error('❌ FATAL: ENCRYPTION_KEY environment variable is required');
  process.exit(1);
}
const ENCRYPTION_KEY = crypto.createHash('sha256').update(keyString).digest(); // Deterministic 32-byte key
const IV_LENGTH = 16; // For AES, this is always 16

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  // Format: iv_hex:encrypted_hex
  return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
  if (!text) return '';
  
  // Backward compatibility: If the text is not in our encrypted format (does not contain ':'), return plain text
  if (!text.includes(':')) {
    return text;
  }
  
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    
    // Validate IV length
    if (iv.length !== IV_LENGTH) {
      return text; // fallback to plain text if iv is malformed
    }
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    // If decryption fails, it could be a legacy plain text password that just happened to contain a colon
    return text;
  }
}

module.exports = {
  encrypt,
  decrypt
};
