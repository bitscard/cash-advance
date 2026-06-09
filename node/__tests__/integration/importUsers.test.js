// Phase 7 — the Supabase user-import script. Runs the core importUsers()
// against the test DB with an in-memory mock of the Supabase admin API
// (listUsers + createUser), asserting correct linkage, admin-role flagging,
// and idempotency on re-run.

const { importUsers } = require('../../scripts/import-users-to-supabase');
const db = require('../../db');
const { applyMigrations, truncateAll, closePool } = require('../dbHelpers');
const { makeApplication } = require('../factories');
const { v4: uuidv4 } = require('uuid');

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await closePool();
});

// In-memory Supabase admin mock. listUsers reflects everything createUser made,
// so re-runs see existing users (real idempotency).
function makeSupabaseMock() {
  const users = [];
  const createUser = jest.fn(async ({ email, app_metadata }) => {
    const user = { id: uuidv4(), email, app_metadata: app_metadata || {} };
    users.push(user);
    return { data: { user }, error: null };
  });
  const listUsers = jest.fn(async ({ page }) => ({
    data: { users: page === 1 ? users.slice() : [] },
    error: null,
  }));
  return { auth: { admin: { listUsers, createUser } }, _users: users, createUser, listUsers };
}

describe('importUsers', () => {
  test('creates + links Supabase users and flags @getbits.app as admin', async () => {
    const regular = await db.createApplication(makeApplication({ email: 'cust@example.com' }));
    const staff = await db.createApplication(makeApplication({ email: 'boss@getbits.app' }));
    const supabase = makeSupabaseMock();

    const summary = await importUsers({ supabase, db, log: () => {} });

    expect(summary.created).toBe(2);
    expect(summary.linked).toBe(2);
    expect(summary.adminsFlagged).toBe(1);

    const r = await db.getApplicationById(regular.id);
    const s = await db.getApplicationById(staff.id);
    expect(r.supabase_user_id).toBeTruthy();
    expect(s.supabase_user_id).toBeTruthy();

    // The @getbits user was created with the admin role; the other was not.
    const staffCall = supabase.createUser.mock.calls.find(c => c[0].email === 'boss@getbits.app');
    const custCall = supabase.createUser.mock.calls.find(c => c[0].email === 'cust@example.com');
    expect(staffCall[0].app_metadata).toEqual({ role: 'admin' });
    expect(custCall[0].app_metadata).toEqual({});
    // bcrypt hash is forwarded for import.
    expect(custCall[0].password_hash).toBe(r.password_hash);
  });

  test('is idempotent — a second run creates nothing new', async () => {
    await db.createApplication(makeApplication({ email: 'a@example.com' }));
    await db.createApplication(makeApplication({ email: 'b@getbits.app' }));
    const supabase = makeSupabaseMock();

    await importUsers({ supabase, db, log: () => {} });
    const firstCount = supabase.createUser.mock.calls.length;
    expect(firstCount).toBe(2);

    const summary2 = await importUsers({ supabase, db, log: () => {} });
    expect(supabase.createUser.mock.calls.length).toBe(firstCount); // no new creates
    expect(summary2.created).toBe(0);
    expect(summary2.skipped).toBe(2); // both apps already linked
  });

  test('admin_users without an application row are created as admins', async () => {
    await db.createAdminUser('solo@getbits.app', 'hash', 'Solo');
    const supabase = makeSupabaseMock();

    const summary = await importUsers({ supabase, db, log: () => {} });
    expect(summary.adminsFlagged).toBeGreaterThanOrEqual(1);
    const call = supabase.createUser.mock.calls.find(c => c[0].email === 'solo@getbits.app');
    expect(call[0].app_metadata).toEqual({ role: 'admin' });
  });
});
