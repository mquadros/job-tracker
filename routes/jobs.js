const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const { requireAuthOrToken } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuthOrToken);

const VALID_STAGE = ['Not applied','Applied','Recruiter screen','Interview','Final round'];
const VALID_OUTCOME = ['','Offer','Rejected','Withdrawn'];
const VALID_FIT = ['strong','good','stretch'];
const VALID_LOC = ['remote','hybrid','onsite'];
const VALID_FILE_TYPES = ['resume','cover-letter'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\//i;

const MAX_LEN = {
  company: 200,
  title: 200,
  location: 200,
  fit_label: 50,
  gap: 2000,
  resume_file: 255,
  cover_letter_file: 255,
  job_url: 1000,
  notes: 10000
};

// Validates whichever of these keys are present in `fields` — used by both
// POST (all keys always present via defaults) and PATCH (partial updates).
function validateJobFields(fields) {
  if ('fit' in fields && !VALID_FIT.includes(fields.fit)) return 'Invalid fit value';
  if ('location_type' in fields && !VALID_LOC.includes(fields.location_type)) return 'Invalid location_type';
  if ('stage' in fields && !VALID_STAGE.includes(fields.stage)) return 'Invalid stage';
  if ('outcome' in fields && !VALID_OUTCOME.includes(fields.outcome)) return 'Invalid outcome';
  if ('applied_date' in fields && fields.applied_date && !DATE_RE.test(fields.applied_date)) {
    return 'applied_date must be in YYYY-MM-DD format';
  }
  // Only allow http(s) — this gets rendered as an <a href>, so anything else (e.g. a
  // javascript: URL) would be a stored-XSS vector.
  if ('job_url' in fields && fields.job_url && !URL_RE.test(fields.job_url)) {
    return 'job_url must start with http:// or https://';
  }
  for (const [key, max] of Object.entries(MAX_LEN)) {
    if (key in fields && typeof fields[key] === 'string' && fields[key].length > max) {
      return `${key} exceeds maximum length of ${max}`;
    }
  }
  return null;
}

// Prepared statements (compiled once, reused across requests)
const stmts = {
  listByUser: db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at ASC'),
  insert: db.prepare(`
    INSERT INTO jobs (user_id, company, title, location, location_type, fit, fit_label, gap, resume_file, cover_letter_file, applied_date, stage, outcome, job_url, has_referral, recruiter_contact, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getById: db.prepare('SELECT * FROM jobs WHERE id = ?'),
  getByIdForUser: db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?'),
  getIdForUser: db.prepare('SELECT id FROM jobs WHERE id = ? AND user_id = ?'),
  deleteById: db.prepare('DELETE FROM jobs WHERE id = ?'),
  setResumeFile: db.prepare("UPDATE jobs SET resume_file = ?, updated_at = datetime('now') WHERE id = ?"),
  setCoverLetterFile: db.prepare("UPDATE jobs SET cover_letter_file = ?, updated_at = datetime('now') WHERE id = ?")
};

// GET /api/jobs
router.get('/', (req, res) => {
  const jobs = stmts.listByUser.all(req.user.id);
  res.json(jobs);
});

// POST /api/jobs
router.post('/', (req, res) => {
  const {
    company, title, location = '', location_type = 'remote', fit = 'good', fit_label = 'Good',
    gap = '', resume_file = '', cover_letter_file = '', applied_date = '', stage = 'Not applied', outcome = '',
    job_url = '', has_referral = false, recruiter_contact = false, notes = ''
  } = req.body;
  if (!company || !title) return res.status(400).json({ error: 'company and title are required' });

  const fields = { company, title, location, location_type, fit, fit_label, gap, resume_file, cover_letter_file, applied_date, stage, outcome, job_url, notes };
  const err = validateJobFields(fields);
  if (err) return res.status(400).json({ error: err });

  const result = stmts.insert.run(
    req.user.id, company, title, location, location_type, fit, fit_label, gap, resume_file, cover_letter_file,
    applied_date, stage, outcome, job_url, has_referral ? 1 : 0, recruiter_contact ? 1 : 0, notes
  );

  const job = stmts.getById.get(result.lastInsertRowid);
  res.status(201).json(job);
});

// PATCH /api/jobs/:id
router.patch('/:id', (req, res) => {
  const job = stmts.getByIdForUser.get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Not found' });

  const allowed = ['company','title','location','location_type','fit','fit_label','gap','resume_file','cover_letter_file','applied_date','stage','outcome','job_url','has_referral','recruiter_contact','notes'];
  const boolFields = ['has_referral', 'recruiter_contact'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });

  const updates = {};
  fields.forEach(f => { updates[f] = req.body[f]; });
  const err = validateJobFields(updates);
  if (err) return res.status(400).json({ error: err });

  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => boolFields.includes(f) ? (req.body[f] ? 1 : 0) : req.body[f]);
  db.prepare(`UPDATE jobs SET ${setClause}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`).run(...values, req.params.id, req.user.id);

  const updated = stmts.getById.get(req.params.id);
  res.json(updated);
});

// DELETE /api/jobs/:id
router.delete('/:id', (req, res) => {
  const job = stmts.getIdForUser.get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  stmts.deleteById.run(req.params.id);
  for (const type of VALID_FILE_TYPES) {
    fs.rmSync(storedFilePath(req.user.id, req.params.id, type), { force: true });
  }
  res.json({ ok: true });
});

// ---- Resume / cover letter file upload & download ----

const ALLOWED_MIME = {
  'application/pdf': true,
  'application/msword': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true
};

// multer's fileFilter only sees the client-asserted Content-Type, which is trivial to spoof —
// e.g. uploading an .exe with Content-Type: application/pdf would sail through. This checks
// the actual file signature (magic bytes) on disk after upload, so what we accept matches what
// the file actually is. DOCX and legacy DOC share different container formats (DOCX is a zip,
// DOC is an OLE compound file) so both get their own signature.
const FILE_SIGNATURES = [
  Buffer.from([0x25, 0x50, 0x44, 0x46]),       // %PDF
  Buffer.from([0xD0, 0xCF, 0x11, 0xE0]),       // legacy .doc (OLE compound file)
  Buffer.from([0x50, 0x4B, 0x03, 0x04])        // .docx (zip container)
];

function hasValidFileSignature(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(4);
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  return FILE_SIGNATURES.some(sig => header.subarray(0, sig.length).equals(sig));
}

function storedFilePath(userId, jobId, type) {
  return path.join(db.UPLOADS_DIR, `${userId}_${jobId}_${type}`);
}

function loadOwnedJob(req, res, next) {
  const job = stmts.getByIdForUser.get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  req.job = job;
  next();
}

function validateFileType(req, res, next) {
  if (!VALID_FILE_TYPES.includes(req.params.type)) return res.status(400).json({ error: 'Invalid file type' });
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, db.UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${req.user.id}_${req.params.id}_${req.params.type}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME[file.mimetype]) return cb(new Error('Only PDF, DOC, or DOCX files are allowed'));
    cb(null, true);
  }
});

// POST /api/jobs/:id/files/:type  (type = resume | cover-letter)
router.post('/:id/files/:type', loadOwnedJob, validateFileType, (req, res) => {
  upload.single('file')(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    if (!hasValidFileSignature(req.file.path)) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: 'File content does not match a supported PDF/DOC/DOCX format' });
    }

    const originalName = req.file.originalname.slice(0, 255);
    if (req.params.type === 'resume') {
      stmts.setResumeFile.run(originalName, req.job.id);
    } else {
      stmts.setCoverLetterFile.run(originalName, req.job.id);
    }
    res.json({ ok: true, filename: originalName });
  });
});

// GET /api/jobs/:id/files/:type — download
router.get('/:id/files/:type', loadOwnedJob, validateFileType, (req, res) => {
  const column = req.params.type === 'resume' ? 'resume_file' : 'cover_letter_file';
  const originalName = req.job[column];
  if (!originalName) return res.status(404).json({ error: 'No file uploaded' });

  const storedPath = storedFilePath(req.user.id, req.job.id, req.params.type);
  if (!fs.existsSync(storedPath)) return res.status(404).json({ error: 'File missing on server' });
  res.download(storedPath, originalName);
});

// DELETE /api/jobs/:id/files/:type — remove an uploaded file
router.delete('/:id/files/:type', loadOwnedJob, validateFileType, (req, res) => {
  fs.rmSync(storedFilePath(req.user.id, req.job.id, req.params.type), { force: true });
  if (req.params.type === 'resume') {
    stmts.setResumeFile.run('', req.job.id);
  } else {
    stmts.setCoverLetterFile.run('', req.job.id);
  }
  res.json({ ok: true });
});

module.exports = router;
// Reused by routes/mcp.js so the MCP tool layer and the REST API share exactly the same
// validation rules and SQL rather than risking two copies drifting apart.
module.exports.validateJobFields = validateJobFields;
module.exports.stmts = stmts;
module.exports.storedFilePath = storedFilePath;
module.exports.VALID_STAGE = VALID_STAGE;
module.exports.VALID_OUTCOME = VALID_OUTCOME;
module.exports.VALID_FIT = VALID_FIT;
module.exports.VALID_LOC = VALID_LOC;
module.exports.VALID_FILE_TYPES = VALID_FILE_TYPES;
