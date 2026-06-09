#!/usr/bin/env node
'use strict';

// Grants (or revokes) admin privilege to a Supabase user by setting
// app_metadata.role = 'admin'. app_metadata is only writable with the
// service-role key, so it is a trustworthy claim the backend can gate on
// (see isAdminRequest in index.js). Admins must be @getbits.app.
//
// Usage:
//   node scripts/grant-admin.js you@getbits.app          # grant
//   node scripts/grant-admin.js you@getbits.app --revoke # revoke
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAIL_DOMAIN = 'getbits.app';

async function main() {
  const email = (process.argv[2] || '').toLowerCase().trim();
  const revoke = process.argv.includes('--revoke');

  if (!email) {
    console.error('Usage: node scripts/grant-admin.js <email> [--revoke]');
    process.exit(1);
  }
  if (!email.endsWith('@' + ADMIN_EMAIL_DOMAIN)) {
    console.error(`Refusing: admin email must end with @${ADMIN_EMAIL_DOMAIN}`);
    process.exit(1);
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find the user by email. listUsers is paginated; scan until found.
  let user = null;
  for (let page = 1; page <= 50 && !user; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) { console.error('listUsers failed:', error.message); process.exit(1); }
    user = data.users.find((u) => (u.email || '').toLowerCase() === email);
    if (data.users.length < 1000) break; // last page
  }
  if (!user) {
    console.error(`No Supabase user found for ${email}. They must sign up first.`);
    process.exit(1);
  }

  const app_metadata = { ...(user.app_metadata || {}) };
  if (revoke) delete app_metadata.role;
  else app_metadata.role = 'admin';

  const { error } = await supabase.auth.admin.updateUserById(user.id, { app_metadata });
  if (error) { console.error('updateUserById failed:', error.message); process.exit(1); }

  console.log(`${revoke ? 'Revoked admin from' : 'Granted admin to'} ${email} (${user.id}).`);
  console.log('They must sign out and back in for the new token claim to take effect.');
}

main();
