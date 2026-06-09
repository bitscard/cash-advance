# Granting Admin Access

Admin access is gated on a **non-user-editable** Supabase claim: `app_metadata.role = 'admin'`,
restricted to `@getbits.app` emails. The backend trusts this because `app_metadata` can only be
written with the service-role key, never by the user (see `isAdminRequest` in `node/index.js`).

A user must **already have signed in once** (so a Supabase Auth user exists) before you can grant
them admin. After granting, they must **sign out and sign back in** — the role is baked into the
JWT at login, so an existing session won't see the change until it gets a fresh token.

There are three ways to do it. Pick one; they all set the same claim.

---

## Option A — Script (recommended)

```bash
node node/scripts/grant-admin.js you@getbits.app          # grant
node node/scripts/grant-admin.js you@getbits.app --revoke # revoke
```

Requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment (the script loads
`.env`). It refuses any email not ending in `@getbits.app`.

---

## Option B — Supabase dashboard

1. Open your Supabase project → **Authentication** → **Users**.
2. Click the user (e.g. `you@getbits.app`).
3. Find the **`app_metadata`** field (shown as "Raw App Meta Data" — a JSON editor).
4. Add the `role` key, keeping the existing contents:
   ```json
   { "provider": "google", "providers": ["google"], "role": "admin" }
   ```
5. Save.

> ⚠️ Edit **`app_metadata`** ("Raw App Meta Data"), **not** `user_metadata`. `user_metadata` is
> user-writable, and the backend deliberately ignores it for admin gating.

To revoke, remove the `"role": "admin"` key and save.

---

## Option C — SQL editor

```sql
-- grant
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
where email = 'you@getbits.app';

-- revoke
update auth.users
set raw_app_meta_data = raw_app_meta_data - 'role'
where email = 'you@getbits.app';
```

---

## After granting

1. **Sign out** of the admin panel and **sign back in** to get a fresh token.
2. Open the admin panel at `/bits-ops-7k3xp9q4z2`.

### Verifying

Decode your `access_token` (e.g. at jwt.io) and confirm it contains:

```json
"app_metadata": { ..., "role": "admin" }
```

The top-level `"role": "authenticated"` claim is Supabase's standard role — it is **not** the
admin signal. Only `app_metadata.role === 'admin'` (plus an `@getbits.app` email) grants access.
