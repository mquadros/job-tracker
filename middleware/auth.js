const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');

// Explicit JWT_SECRET wins (useful for multi-instance setups sharing one secret, or anyone who
// wants a specific value). Otherwise generate one on first boot and persist it in the same data
// volume the SQLite DB already lives in, so it survives container recreation and every session
// doesn't get invalidated on every restart. This is what lets a self-hosted deployer skip
// thinking about JWT_SECRET entirely instead of needing to generate and paste one in up front,
// while still never falling back to a hardcoded, publicly-visible default (the old behavior,
// a real risk once this repo went public: anyone could forge a valid admin JWT against any
// deployment that forgot to set one).
function resolveSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretPath = path.join(db.DATA_DIR, '.jwt-secret');
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  console.log('[auth] Generated a new JWT_SECRET and saved it to the data volume.');
  return generated;
}
const SECRET = resolveSecret();

const JWT_ALGORITHM = 'HS256';

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    // Pin the algorithm explicitly rather than trusting whatever the token header claims,
    // defense in depth against algorithm-confusion attacks, even though jsonwebtoken's own
    // defaults already exclude `alg: none`.
    req.user = jwt.verify(token, SECRET, { algorithms: [JWT_ALGORITHM] });
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
// (see routes/jobs.js). routes/auth.js still uses plain requireAuth, so a leaked API token can
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

module.exports = { requireAuth, requireAdmin, requireAuthOrToken, hashApiToken, SECRET, JWT_ALGORITHM };
