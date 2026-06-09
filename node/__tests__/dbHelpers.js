// DB lifecycle helpers for integration tests. Each test file should:
//   beforeAll  → applyMigrations()  (idempotent — uses CREATE IF NOT EXISTS)
//   beforeEach → truncateAll()
//   afterAll   → closePool()
//
// Reads DATABASE_URL from process.env (set by __tests__/jest.setup.js).

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// One pool per test process. db.js has its own pool — we reuse the same
// DATABASE_URL so it talks to the same Postgres. Closing both at teardown.
let testPool;

function getPool() {
  if (!testPool) {
    testPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return testPool;
}

async function applyMigrations() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await getPool().query(schema);
}

async function truncateAll() {
  // Order matters because of FK from messages.application_id. Use CASCADE
  // to handle any other future child tables.
  await getPool().query(`
    TRUNCATE TABLE messages, income_sources, applications, admin_users RESTART IDENTITY CASCADE
  `).catch(async (err) => {
    // income_sources may not exist on a fresh schema; fall back to a per-
    // table truncate that gracefully skips missing tables.
    if (/does not exist/.test(err.message)) {
      await getPool().query('TRUNCATE TABLE messages RESTART IDENTITY CASCADE').catch(() => {});
      await getPool().query('TRUNCATE TABLE applications RESTART IDENTITY CASCADE').catch(() => {});
    } else {
      throw err;
    }
  });
}

async function closePool() {
  if (testPool) {
    await testPool.end();
    testPool = null;
  }
  // Also close db.js's pool so the test process can exit cleanly.
  const db = require('../db');
  if (db.pool && typeof db.pool.end === 'function') {
    await db.pool.end().catch(() => {});
  }
}

module.exports = { getPool, applyMigrations, truncateAll, closePool };
