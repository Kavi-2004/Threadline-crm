const crypto = require('node:crypto');
const db = require('../db');
const { hashPassword, verifyPassword, signToken } = require('../lib/auth');

async function signup(body) {
  const { businessName, email, password } = body;
  if (!businessName || !email || !password) {
    return { status: 400, json: { error: 'businessName, email and password are all required' } };
  }
  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return { status: 409, json: { error: 'An account with that email already exists' } };

  const businessId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.run('INSERT INTO businesses (id, name, created_at) VALUES (?, ?, ?)', [businessId, businessName, now]);
  await db.run('INSERT INTO users (id, business_id, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, businessId, email, hashPassword(password), now]);

  const token = signToken({ userId, businessId, email });
  return { status: 201, json: { token, businessId, businessName, email } };
}

async function login(body) {
  const { email, password } = body;
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { status: 401, json: { error: 'Invalid email or password' } };
  }
  const business = await db.get('SELECT * FROM businesses WHERE id = ?', [user.business_id]);
  const token = signToken({ userId: user.id, businessId: user.business_id, email: user.email });
  return { status: 200, json: { token, businessId: business.id, businessName: business.name, email: user.email } };
}

module.exports = { signup, login };
