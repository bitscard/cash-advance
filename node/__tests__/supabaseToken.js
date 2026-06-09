// Forges Supabase-like access tokens for tests. Verification is symmetric
// HS256, so signing with the same SUPABASE_JWT_SECRET the app verifies with
// produces tokens indistinguishable from real Supabase access tokens — no
// real Supabase project needed in CI.

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

function makeSupabaseToken({ sub, email, role } = {}) {
  const claims = {
    sub: sub || uuidv4(),
    email: email || `supa-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    aud: 'authenticated',
    app_metadata: role ? { role } : {},
  };
  return { token: jwt.sign(claims, process.env.SUPABASE_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' }), ...claims };
}

module.exports = { makeSupabaseToken };
