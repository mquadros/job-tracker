const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function hashApiToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const findUserByTokenHash = db.prepare('SELECT id, username, role FROM users WHERE api_token_hash = ?');

// Accepts either the normal session cookie/JWT, OR a personal API token (`Authorization: Bearer
// <token>`) generated from the Profile modal. Deliberately scoped to job-management routes only
// (see routes/jobs.js) — routes/auth.js still uses plain requireAuth — so a leaked API token can
// be used to read/write jobs but never to change the account password or manage users.
function requireAuthOrToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const bearer = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (bearer) {
    const user = findUserByTokenHash.get(hashApiToken(bearer));
    if (!user) return res.status(401).json({ error: 'Invalid API token' });
    req.user = user;
    return next();
  }

  return requireAuth(req, res, next);
}

module.exports = { requireAuth, requireAdmin, requireAuthOrToken, hashApiToken, SECRET };
