// lib/auth.js — password hashing + login tokens, built only on Node's
// built-in crypto module (no bcrypt/jsonwebtoken packages needed).

const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-in-production';

// --- Passwords ---
// scrypt is a strong, built-in-to-Node password hashing function.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  // timingSafeEqual prevents timing attacks from leaking info about the hash
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(check));
}

// --- Tokens ---
// A minimal JWT-style token: base64(header).base64(payload).signature
// Signed with HMAC-SHA256 so it can't be forged without SECRET.
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload, expiresInSeconds = 60 * 60 * 24 * 7) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds }));
  const signature = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  const [header, body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  if (signature !== expected) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
  return payload;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
