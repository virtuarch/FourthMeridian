# FinTracker v2.0.1 — Cloud Staging Deployment Guide

**Branch:** `v2.0.1-cloud-staging`  
**Goal:** Stable HTTPS staging environment on Vercel + Supabase for real Plaid Production OAuth testing.

---

## Architecture

```
Browser
  ↓
Vercel (Next.js)
  ↓
Supabase (Postgres via Transaction Pooler)
  ↓
Plaid Production API
```

---

## Step 1 — Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Name it `fintracker-staging`
3. Choose a region close to you (US East or West)
4. Set a strong database password — **save it somewhere safe**
5. Wait for provisioning (~1 min)

### Get your connection strings

In your Supabase project → **Settings → Database → Connection string**:

You need two URLs:

**Transaction Pooler** (for `DATABASE_URL` in Vercel — port 6543):
```
postgresql://postgres.[project-ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
```

**Direct Connection** (for `DIRECT_URL` in Vercel and for running migrations — port 5432):
```
postgresql://postgres.[project-ref]:[password]@db.[project-ref].supabase.com:5432/postgres
```

> Supabase shows these under **Connect → ORMs → Prisma**. Copy both.

---

## Step 2 — Run Migrations Against Supabase

From your local machine, with the Supabase direct connection URL:

```bash
# Set DIRECT_URL temporarily for the migrate command
DIRECT_URL="postgresql://postgres.[ref]:[password]@db.[ref].supabase.com:5432/postgres" \
DATABASE_URL="postgresql://postgres.[ref]:[password]@db.[ref].supabase.com:5432/postgres" \
npx prisma migrate deploy
```

> **Never** run `prisma migrate dev` against Supabase. Only `migrate deploy`.  
> **Never** run `prisma db seed` against staging.

Verify the schema was applied:

```bash
# Open Prisma Studio pointed at Supabase to inspect
DATABASE_URL="postgresql://..." DIRECT_URL="postgresql://..." npx prisma studio
```

---

## Step 3 — Connect GitHub to Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import the `virtuarch/fintracker` GitHub repo
3. Framework preset: **Next.js** (auto-detected)
4. Build command: `prisma generate && next build` ← already set in `package.json`
5. Install command: `npm install` (default)
6. Output directory: `.next` (default)

Do **not** deploy yet — configure env vars first.

---

## Step 4 — Configure Environment Variables in Vercel

In **Vercel → Project → Settings → Environment Variables**, add all of the following.

Set scope to **Production** and **Preview** for all of them unless noted.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase Transaction Pooler URL (port 6543, `?pgbouncer=true&connection_limit=1`) |
| `DIRECT_URL` | Supabase Direct Connection URL (port 5432) |
| `NEXTAUTH_SECRET` | Run `openssl rand -base64 32` locally and paste the result |
| `NEXTAUTH_URL` | `https://<your-vercel-domain>.vercel.app` (fill in after first deploy) |
| `NEXT_PUBLIC_APP_URL` | `https://<your-vercel-domain>.vercel.app` |
| `ENCRYPTION_KEY` | Copy from your local `.env.local` (same 64-char hex value) |
| `PLAID_CLIENT_ID` | From Plaid Dashboard → Team Settings → Keys |
| `PLAID_SECRET` | **Production** secret from Plaid Dashboard (not sandbox) |
| `PLAID_ENV` | `production` |
| `PLAID_REDIRECT_URI` | `https://<your-vercel-domain>.vercel.app/plaid-oauth-return` (fill in after first deploy) |
| `DISABLE_SYSTEM_ADMIN` | `true` |

> **ENCRYPTION_KEY warning:** Use the exact same value as your local dev key if you plan to share a Supabase database between environments. If staging is a completely separate DB (recommended), generate a new key with `openssl rand -hex 32`.

---

## Step 5 — First Deploy

1. Trigger a deploy in Vercel (push to `v2.0.1-cloud-staging` branch, or click **Deploy** in the dashboard)
2. Watch the build log — confirm `prisma generate` and `next build` both succeed
3. Note your Vercel domain: `https://fintracker-abc123.vercel.app`

---

## Step 6 — Update NEXTAUTH_URL and PLAID_REDIRECT_URI

After the first deploy you'll have a stable Vercel URL. Go back to Vercel → Environment Variables and update:

- `NEXTAUTH_URL` → `https://fintracker-abc123.vercel.app`
- `NEXT_PUBLIC_APP_URL` → `https://fintracker-abc123.vercel.app`
- `PLAID_REDIRECT_URI` → `https://fintracker-abc123.vercel.app/plaid-oauth-return`

Then **redeploy** (Vercel → Deployments → Redeploy) so the new values take effect.

---

## Step 7 — Register Plaid Redirect URI

In the [Plaid Dashboard](https://dashboard.plaid.com):

1. Go to **Team → API → Allowed redirect URIs**
2. Click **Add URI**
3. Enter: `https://fintracker-abc123.vercel.app/plaid-oauth-return`
4. Save

This is required for OAuth institutions (Chase, Capital One, American Express, etc.) to redirect back to your app after bank authentication.

---

## Step 8 — Register a Staging User

The staging database is empty (no seed data). Register a real account:

1. Open `https://fintracker-abc123.vercel.app/register`
2. Create a user with your real email
3. Log in and confirm the dashboard loads

---

## Step 9 — Test Plaid Production

Test the following flow:

1. From the dashboard, click **Connect Account**
2. Select **Chase** (OAuth institution)
3. Confirm Plaid Link opens and redirects to Chase's login page
4. Complete Chase authentication
5. Confirm redirect back to `/plaid-oauth-return`
6. Confirm accounts import and appear on the dashboard

Test at least one non-OAuth institution as well (e.g. any institution that doesn't trigger a bank redirect).

---

## Acceptance Checklist

- [ ] Vercel build succeeds (`prisma generate && next build` passes)
- [ ] Supabase migrations applied cleanly (`prisma migrate deploy`)
- [ ] No seed data in staging database
- [ ] Registration works on the hosted URL
- [ ] Login and session work on the hosted URL
- [ ] Daily Brief loads
- [ ] Workspace switching works
- [ ] Plaid link token endpoint responds (`/api/plaid/link-token`)
- [ ] At least one real bank institution links successfully
- [ ] OAuth institution (Chase or Capital One) reaches the bank login page
- [ ] `/plaid-oauth-return` handles the OAuth callback correctly
- [ ] Accounts appear on the dashboard after linking
- [ ] Local development still works with Docker Postgres (unchanged)

---

## Local Dev — No Changes Required

Local development continues to use:

- `next dev --webpack` dev server
- Docker Compose Postgres (`localhost:5432`)
- `.env.local` for secrets
- `prisma migrate dev` for schema changes

The `DIRECT_URL` added to `.env.local` mirrors `DATABASE_URL` for local dev — no behavioral change.

---

## Env Variable Reference

| Variable | Local Dev | Staging (Vercel) |
|---|---|---|
| `DATABASE_URL` | Docker Postgres direct URL | Supabase Transaction Pooler (port 6543) |
| `DIRECT_URL` | Same as DATABASE_URL | Supabase Direct Connection (port 5432) |
| `NEXTAUTH_SECRET` | Any random string | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | Omit (auto-detected) | `https://<vercel-domain>` |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | `https://<vercel-domain>` |
| `ENCRYPTION_KEY` | 64-char hex | Same or new 64-char hex |
| `PLAID_CLIENT_ID` | Your Plaid client ID | Same |
| `PLAID_SECRET` | Production secret | Same |
| `PLAID_ENV` | `production` | `production` |
| `PLAID_REDIRECT_URI` | ngrok/tunnel URL (optional) | `https://<vercel-domain>/plaid-oauth-return` |
| `DISABLE_SYSTEM_ADMIN` | `false` | `true` |
| `DEV_ALLOWED_ORIGINS` | LAN IPs (optional) | Not used |
