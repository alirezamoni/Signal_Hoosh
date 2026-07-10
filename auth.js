/**
 * auth.js — JWT middleware
 */

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = '7d';

function signToken(user) {
  return jwt.sign(
    { id: user.id, mobile: user.mobile, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ── Middleware: require any valid login ──────────────────
function requireAuth(req, res, next) {
  const token = extractToken(req);
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'لطفاً وارد شوید' });
  req.user = payload;
  next();
}

// ── Middleware: require superadmin ───────────────────────
function requireSuperAdmin(req, res, next) {
  const token = extractToken(req);
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'لطفاً وارد شوید' });
  if (payload.role !== 'superadmin') return res.status(403).json({ error: 'دسترسی ندارید' });
  req.user = payload;
  next();
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return req.cookies?.token || '';
}

module.exports = { signToken, verifyToken, requireAuth, requireSuperAdmin };
