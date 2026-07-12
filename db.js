const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tracker.db');
const UPLOADS_DIR = path.join(path.dirname(DB_PATH), 'uploads');

// ensure data dir exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(DB_PATH);

// enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT    NOT NULL UNIQUE,
    password  TEXT    NOT NULL,
    role      TEXT    NOT NULL DEFAULT 'user',
    api_token_hash TEXT,
    api_token_created_at TEXT,
    created_at TEXT   NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    company       TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    location      TEXT    NOT NULL DEFAULT '',
    location_type TEXT    NOT NULL DEFAULT 'remote',
    fit           TEXT    NOT NULL DEFAULT 'good',
    fit_label     TEXT    NOT NULL DEFAULT 'Good',
    gap           TEXT    NOT NULL DEFAULT '',
    resume_file   TEXT    NOT NULL DEFAULT '',
    cover_letter_file TEXT NOT NULL DEFAULT '',
    applied_date  TEXT    NOT NULL DEFAULT '',
    stage         TEXT    NOT NULL DEFAULT 'Not applied',
    outcome       TEXT    NOT NULL DEFAULT '',
    job_url       TEXT    NOT NULL DEFAULT '',
    has_referral  INTEGER NOT NULL DEFAULT 0,
    recruiter_contact INTEGER NOT NULL DEFAULT 0,
    notes         TEXT    NOT NULL DEFAULT '',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id);
`);

// --- Migrate existing databases created before cover_letter_file / applied_date / stage+outcome existed ---
const jobColumns = db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name);
if (!jobColumns.includes('cover_letter_file')) {
  db.exec("ALTER TABLE jobs ADD COLUMN cover_letter_file TEXT NOT NULL DEFAULT ''");
}
if (!jobColumns.includes('applied_date')) {
  db.exec("ALTER TABLE jobs ADD COLUMN applied_date TEXT NOT NULL DEFAULT ''");
}

const needsStageMigration = !jobColumns.includes('stage');
if (needsStageMigration) {
  db.exec("ALTER TABLE jobs ADD COLUMN stage TEXT NOT NULL DEFAULT 'Not applied'");
}
if (!jobColumns.includes('outcome')) {
  db.exec("ALTER TABLE jobs ADD COLUMN outcome TEXT NOT NULL DEFAULT ''");
}
if (!jobColumns.includes('job_url')) {
  db.exec("ALTER TABLE jobs ADD COLUMN job_url TEXT NOT NULL DEFAULT ''");
}
if (!jobColumns.includes('has_referral')) {
  db.exec("ALTER TABLE jobs ADD COLUMN has_referral INTEGER NOT NULL DEFAULT 0");
}
if (!jobColumns.includes('recruiter_contact')) {
  db.exec("ALTER TABLE jobs ADD COLUMN recruiter_contact INTEGER NOT NULL DEFAULT 0");
}

const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userColumns.includes('api_token_hash')) {
  db.exec("ALTER TABLE users ADD COLUMN api_token_hash TEXT");
}
if (!userColumns.includes('api_token_created_at')) {
  db.exec("ALTER TABLE users ADD COLUMN api_token_created_at TEXT");
}

// One-time backfill: the old single `status` field mixed pipeline stage (Applied,
// Recruiter screen, Interview, Final round) with terminal outcome (Offer, Rejected,
// Withdrawn). Split existing rows into the new stage/outcome columns. Best-effort for
// Rejected/Withdrawn since we don't know which stage they were at when that happened —
// defaults to 'Applied', correctable by hand afterward.
if (needsStageMigration && jobColumns.includes('status')) {
  const STATUS_TO_STAGE_OUTCOME = {
    'Not applied':      ['Not applied', ''],
    'Applied':          ['Applied', ''],
    'Recruiter screen': ['Recruiter screen', ''],
    'Interview':        ['Interview', ''],
    'Final round':      ['Final round', ''],
    'Offer':            ['Final round', 'Offer'],
    'Rejected':         ['Applied', 'Rejected'],
    'Withdrawn':        ['Applied', 'Withdrawn']
  };
  const rows = db.prepare('SELECT id, status FROM jobs').all();
  const setStageOutcome = db.prepare('UPDATE jobs SET stage = ?, outcome = ? WHERE id = ?');
  const migrate = db.transaction(() => {
    for (const row of rows) {
      const [stage, outcome] = STATUS_TO_STAGE_OUTCOME[row.status] || ['Not applied', ''];
      setStageOutcome.run(stage, outcome, row.id);
    }
  });
  migrate();
  if (rows.length) console.log(`[db] Migrated ${rows.length} job(s) from status to stage/outcome`);
}

// --- Seed admin user from env if not exists ---
async function seedAdmin() {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'changeme';
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUser);
  if (!existing) {
    const hash = await bcrypt.hash(adminPass, 12);
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(adminUser, hash, 'admin');
    console.log(`[db] Created admin user: ${adminUser}`);
  }
}

seedAdmin();

module.exports = db;
module.exports.UPLOADS_DIR = UPLOADS_DIR;
