const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAdmin, requireAuth, hashApiToken, SECRET } = require('../middleware/auth');

const router = express.Router();
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' }
});

// Prepared statements (compiled once, reused across requests)
const stmts = {
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserIdByUsername: db.prepare('SELECT id FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)'),
  listUsers: db.prepare('SELECT id, username, role, created_at FROM users'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getProfileById: db.prepare(`
    SELECT id, username, role, created_at, api_token_created_at,
           (api_token_hash IS NOT NULL) AS has_api_token
    FROM users WHERE id = ?
  `),
  updatePassword: db.prepare('UPDATE users SET password = ? WHERE id = ?'),
  setApiToken: db.prepare("UPDATE users SET api_token_hash = ?, api_token_created_at = datetime('now') WHERE id = ?"),
  clearApiToken: db.prepare('UPDATE users SET api_token_hash = NULL, api_token_created_at = NULL WHERE id = ?')
};

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  const user = stmts.getUserByUsername.get(username);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, { expiresIn: '7d' });
  res.cookie('token', token, COOKIE_OPTS);
  res.json({ username: user.username, role: user.role });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// POST /api/auth/users  (admin only — create new user)
router.post('/users', requireAdmin, async (req, res) => {
  const { username, password, role = 'user' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
  const existing = stmts.getUserIdByUsername.get(username);
  if (existing) return res.status(409).json({ error: 'Username already exists' });
  const hash = await bcrypt.hash(password, 12);
  const result = stmts.insertUser.run(username, hash, role);
  res.status(201).json({ id: result.lastInsertRowid, username, role });
});

// GET /api/auth/users  (admin only)
router.get('/users', requireAdmin, (req, res) => {
  const users = stmts.listUsers.all();
  res.json(users);
});

// DELETE /api/auth/users/:id  (admin only)
router.delete('/users/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  stmts.deleteUser.run(req.params.id);
  res.json({ ok: true });
});

// GET /api/auth/me  (current user's own profile)
router.get('/me', requireAuth, (req, res) => {
  const user = stmts.getProfileById.get(req.user.id);
  res.json(user);
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  const { current, next: newPass } = req.body;
  if (!current || !newPass) return res.status(400).json({ error: 'Missing fields' });
  const user = stmts.getUserById.get(req.user.id);
  const valid = await bcrypt.compare(current, user.password);
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
  const hash = await bcrypt.hash(newPass, 12);
  stmts.updatePassword.run(hash, req.user.id);
  res.json({ ok: true });
});

// POST /api/auth/api-token — generate (and replace) this user's API token, for scripted/agent
// access to the jobs API without sharing the account password. Only ever reachable via a
// session cookie, never via a bearer token (requireAuth here, not requireAuthOrToken) — that's
// deliberate, so a leaked token can't be used to mint itself a new one or touch any account
// setting. The raw token is only ever returned here, once; only its hash is stored.
router.post('/api-token', requireAuth, (req, res) => {
  const raw = 'jt_' + crypto.randomBytes(32).toString('hex');
  stmts.setApiToken.run(hashApiToken(raw), req.user.id);
  res.json({ token: raw });
});

// DELETE /api/auth/api-token — revoke
router.delete('/api-token', requireAuth, (req, res) => {
  stmts.clearApiToken.run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
