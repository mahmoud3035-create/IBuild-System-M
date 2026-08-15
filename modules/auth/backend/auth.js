const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../../database/db');

function getSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be configured and at least 32 characters long');
  }
  return secret;
}

async function login(username, password) {
  const cleanUsername = String(username || '').trim();

  if (!cleanUsername || !password) {
    return { success: false, message: 'اسم المستخدم وكلمة المرور مطلوبان' };
  }

  const [rows] = await db.query(
    `SELECT id, full_name, username, password_hash, role, is_active, created_at
     FROM users
     WHERE username = ?
     LIMIT 1`,
    [cleanUsername]
  );

  if (!rows.length || !rows[0].is_active) {
    return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
  }

  const user = rows[0];
  const valid = await bcrypt.compare(String(password), user.password_hash);

  if (!valid) {
    return { success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحة' };
  }

  const safeUser = {
    id: user.id,
    full_name: user.full_name,
    username: user.username,
    role: user.role,
    is_active: !!user.is_active,
    created_at: user.created_at
  };

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    getSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  // The server needs the token to place it in the HttpOnly cookie, but it must
  // never be serialized into the JSON response where browser JavaScript can read it.
  const result = { success: true, message: 'تم تسجيل الدخول بنجاح', user: safeUser };
  Object.defineProperty(result, 'token', {
    value: token,
    enumerable: false,
    writable: false,
    configurable: false
  });
  return result;
}

async function getUserById(id) {
  const [rows] = await db.query(
    `SELECT id, full_name, username, role, is_active, created_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [Number(id)]
  );

  if (!rows.length) {
    return { success: false, message: 'المستخدم غير موجود' };
  }

  return { success: true, user: rows[0] };
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { login, getUserById, verifyToken };
