#!/usr/bin/env node
'use strict';

// One-time migration: import existing users into Supabase Auth.
//
// Plaintext passwords can't be recovered, but Supabase Auth (GoTrue) stores
// passwords as bcrypt — the same scheme this app uses (bcryptjs) — so we import
// the existing bcrypt HASH and logins keep working with no user friction.
//
// Sources:
//   - applications: customer accounts (password_hash, email). @getbits.app
//     emails additionally get app_metadata.role='admin'.
//   - admin_users:  team logins not necessarily tied to an application; all get
//     the admin role.
//
// Idempotent: a listUsers() pass builds an email→id map up front, so re-runs
// (and emails present in BOTH tables) link to the existing Supabase user
// instead of erroring. Applications already carrying supabase_user_id are
// skipped.
//
// BEFORE the bulk run: import ONE user, then log in end-to-end with their real
// password to confirm the bcrypt hash imports cleanly. Only then run for all.
//
// Usage:  node scripts/import-users-to-supabase.js
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (+ DATABASE_URL).

const ADMIN_EMAIL_DOMAIN = 'getbits.app';

// Core, dependency-injected so tests can pass a mock Supabase admin client + db.
async function importUsers({ supabase, db, log = console.log }) {
  const summary = { created: 0, linked: 0, skipped: 0, failed: 0, adminsFlagged: 0 };

  // 1. Build email -> supabase user id map (idempotency + app/admin overlap).
  const byEmail = new Map();
  for (let page = 1; page <= 1000; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const u of data.users) if (u.email) byEmail.set(u.email.toLowerCase(), u.id);
    if (data.users.length < 1000) break;
  }

  // Creates the Supabase user if absent (importing the bcrypt hash), or returns
  // the existing id. Returns null on failure.
  const ensureUser = async (email, { passwordHash, admin }) => {
    const key = email.toLowerCase();
    if (byEmail.has(key)) {
      const id = byEmail.get(key);
      // Already in Supabase (e.g. an email present in both tables, or a re-run):
      // still backfill the admin claim, otherwise these accounts fail the
      // app_metadata.role==='admin' check after import.
      if (admin) {
        const { error } = await supabase.auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } });
        if (error) log(`  ! updateUserById (admin backfill) failed for ${email}: ${error.message}`);
      }
      return id;
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password_hash: passwordHash || undefined,
      email_confirm: true,
      app_metadata: admin ? { role: 'admin' } : {},
    });
    if (error || !data || !data.user) {
      log(`  ! createUser failed for ${email}: ${error ? error.message : 'no user returned'}`);
      return null;
    }
    byEmail.set(key, data.user.id);
    return data.user.id;
  };

  // 2. Applications (customer accounts).
  const apps = await db.getAllApplications();
  for (const app of apps) {
    if (app.supabase_user_id) { summary.skipped++; continue; }
    if (!app.email) { summary.failed++; continue; }
    const admin = app.email.toLowerCase().endsWith('@' + ADMIN_EMAIL_DOMAIN);
    const created = !byEmail.has(app.email.toLowerCase());
    const uid = await ensureUser(app.email, { passwordHash: app.password_hash, admin });
    if (!uid) { summary.failed++; continue; }
    await db.linkSupabaseUser(app.id, uid);
    if (created) summary.created++;
    summary.linked++;
    if (admin) summary.adminsFlagged++;
  }

  // 3. admin_users without an application row — ensure they exist + are admins.
  const admins = await db.getAllAdminUsers();
  for (const a of admins) {
    if (!a.email) { summary.failed++; continue; }
    const created = !byEmail.has(a.email.toLowerCase());
    const uid = await ensureUser(a.email, { passwordHash: a.password_hash, admin: true });
    if (!uid) { summary.failed++; continue; }
    if (created) { summary.created++; summary.adminsFlagged++; }
  }

  log(`Import complete: ${JSON.stringify(summary)}`);
  return summary;
}

async function main() {
  require('dotenv').config();
  const { createClient } = require('@supabase/supabase-js');
  const db = require('../db');
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await importUsers({ supabase, db });
  process.exit(0);
}

if (require.main === module) main();

module.exports = { importUsers };
