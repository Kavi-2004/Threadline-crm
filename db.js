// db.js — supports two backends behind one identical async API:
//
//   - SQLite (default): zero install, used for local development. This is
//     what's active if you just run `node server.js` with no setup.
//   - PostgreSQL (production): set DATABASE_URL and this switches
//     automatically. Needed for real production use — SQLite is a single
//     file with one writer at a time, which doesn't hold up under multiple
//     concurrent users/instances. Install with: npm install pg
//
// Every route file calls db.get(sql, params) / db.all(sql, params) /
// db.run(sql, params) — written ONCE, using `?` placeholders. The Postgres
// adapter rewrites `?` to `$1, $2...` automatically, so there's exactly one
// copy of every query to maintain, not two.

const path = require('node:path');
const USE_PG = !!process.env.DATABASE_URL;

let sqliteDb = null;
let pgPool = null;

if (USE_PG) {
  const { Pool } = require('pg'); // npm install pg — see README "Deploying with PostgreSQL"
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
  sqliteDb = new DatabaseSync(DB_PATH);
}

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function run(sql, params = []) {
  if (USE_PG) {
    await pgPool.query(toPgPlaceholders(sql), params);
  } else {
    sqliteDb.prepare(sql).run(...params);
  }
}

async function get(sql, params = []) {
  if (USE_PG) {
    const res = await pgPool.query(toPgPlaceholders(sql), params);
    return res.rows[0];
  }
  return sqliteDb.prepare(sql).get(...params);
}

async function all(sql, params = []) {
  if (USE_PG) {
    const res = await pgPool.query(toPgPlaceholders(sql), params);
    return res.rows;
  }
  return sqliteDb.prepare(sql).all(...params);
}

async function exec(sql) {
  if (USE_PG) {
    await pgPool.query(sql);
  } else {
    sqliteDb.exec(sql);
  }
}

function ensureSqliteColumn(table, column, definition) {
  const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Creates every table fresh, and safely adds any column that might be
// missing on a database created by an older version of this project.
// Must be awaited once before the server starts handling requests.
async function initSchema() {
  await exec(`
    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      reply_template TEXT DEFAULT 'Hi {{first_name}}! Thanks for reaching out — someone from our team will call you shortly.',
      followup_days INTEGER DEFAULT 3,
      staff_list TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'New',
      last_message TEXT,
      assigned_staff TEXT,
      email TEXT,
      notes TEXT,
      follow_up_count INTEGER DEFAULT 0,
      last_contacted_at TEXT,
      captured_at TEXT NOT NULL,
      next_followup_at TEXT
    );
    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      type TEXT NOT NULL,
      channel TEXT,
      label TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_accounts (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      account_id TEXT NOT NULL,
      UNIQUE(channel, account_id)
    );
    CREATE TABLE IF NOT EXISTS channel_tokens (
      channel_account_key TEXT PRIMARY KEY,
      access_token TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id);
    CREATE INDEX IF NOT EXISTS idx_history_lead ON history(lead_id);
  `);

  if (USE_PG) {
    // Postgres supports ADD COLUMN IF NOT EXISTS directly — no helper needed.
    await exec(`
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS followup_days INTEGER DEFAULT 3;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS staff_list TEXT DEFAULT '[]';
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_staff TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_count INTEGER DEFAULT 0;
      ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contacted_at TEXT;
    `);
  } else {
    ensureSqliteColumn('businesses', 'followup_days', 'INTEGER DEFAULT 3');
    ensureSqliteColumn('businesses', 'staff_list', "TEXT DEFAULT '[]'");
    ensureSqliteColumn('leads', 'assigned_staff', 'TEXT');
    ensureSqliteColumn('leads', 'email', 'TEXT');
    ensureSqliteColumn('leads', 'notes', 'TEXT');
    ensureSqliteColumn('leads', 'follow_up_count', 'INTEGER DEFAULT 0');
    ensureSqliteColumn('leads', 'last_contacted_at', 'TEXT');
  }
}

module.exports = { get, all, run, exec, initSchema, isPostgres: USE_PG };
