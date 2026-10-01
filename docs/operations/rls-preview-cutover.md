# RLS — PREVIEW CUTOVER RUNBOOK

**Status:** prepared, not executed. Every step below is an OWNER action.
**Authority:** `docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md` · migrations `20261002000000_tenancy_integrity`, `20261002000100_rls_roles_and_policies`.

**No secret appears in this document, and none should ever be pasted into a chat, a commit, or an issue.** The flow below is arranged so that the only place a role password exists is your terminal and the two systems that need it.

---

## 0. What you are turning on

| | |
|---|---|
| Preview project | `fourth-meridian-preview` · `lqagrryecvhbaqvczjgc` · ap-southeast-1 · NANO |
| Migrations applied there today | **88** |
| Migrations in the repo | **109** |
| **Pending** | **21** — and **only 2 of those are RLS.** The other 19 are the rest of v2.6. |

⚠️ **Step 1 is bigger than this programme.** `prisma migrate deploy` against preview applies all 21, i.e. it deploys v2.6's schema to preview, not just RLS. That is a reasonable thing to do — preview exists for it — but it is a v2.6 decision, not an RLS one. If you would rather keep them separate, deploy v2.6 to preview first as its own act, confirm the app is healthy, and then come back to step 2.

---

## 1. Apply migrations to preview

Vercel does **not** run `migrate deploy`; migrations are applied by hand. From a terminal with preview's connection strings exported (the same way you apply any migration today):

```sh
npx prisma migrate deploy
```

This creates `fm_app`, `fm_auth`, `fm_system`, `fm_backup` — **with LOGIN and no password**, so each is inert until step 2. It also enables and forces RLS and installs the policies. Because the application still connects as `postgres` (which owns the tables and carries BYPASSRLS), **nothing changes behaviourally at this point.** That is intended: the policies go in cold.

Verify:

```sql
select rolname, rolcanlogin, rolbypassrls from pg_roles where rolname like 'fm\_%' order by 1;
select count(*) filter (where relrowsecurity) as rls_on,
       count(*) filter (where relforcerowsecurity) as forced,
       count(*) as total
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r';
select count(*) from pg_policies where schemaname = 'public';
```

Expect four `fm_*` roles (only `fm_backup` with `rolbypassrls = t`), ~41 tables with RLS on **and** forced, and a non-zero policy count.

---

## 2. Give the three runtime roles a password

**Generate the secrets yourself. Do not send them to me, and do not store them anywhere but Supabase and Vercel.**

```sh
# run three times, once per role; keep each value in your clipboard only as long as needed
openssl rand -base64 30 | tr -d '/+=' | head -c 40; echo
```

Then, in the preview project's SQL editor, for each role:

```sql
ALTER ROLE fm_app    WITH PASSWORD '<secret 1>';
ALTER ROLE fm_auth   WITH PASSWORD '<secret 2>';
ALTER ROLE fm_system WITH PASSWORD '<secret 3>';
```

`fm_backup` is **not** needed for the preview cutover. It matters when you move backups onto a non-owner role; preview backups are not part of this gate.

---

## 3. Compose the three role URLs

Take preview's existing `DATABASE_URL` and change **only the userinfo**. Everything else — host, port `6543`, `pgbouncer=true`, database — stays exactly as it is. Do not add `connection_limit`; the runtime owns that value in code.

```
postgresql://fm_app:<secret 1>@<same host>:6543/postgres?pgbouncer=true
postgresql://fm_auth:<secret 2>@<same host>:6543/postgres?pgbouncer=true
postgresql://fm_system:<secret 3>@<same host>:6543/postgres?pgbouncer=true
```

⚠️ Preview's `DATABASE_URL` is marked Sensitive in Vercel and cannot be read back. If you no longer have the host, it is on the Supabase project's connection page — the **Transaction Pooler** string, not the direct one.

---

## 4. Set four Vercel environment variables (Preview scope only)

| Variable | Value |
|---|---|
| `DATABASE_URL_APP` | the `fm_app` URL |
| `DATABASE_URL_AUTH` | the `fm_auth` URL |
| `DATABASE_URL_SYSTEM` | the `fm_system` URL |
| `FM_RLS_STRICT` | `true` |

Leave `DATABASE_URL` and `DIRECT_URL` exactly as they are — they remain the migration principal and are still what `prisma migrate deploy` uses.

**`FM_RLS_STRICT=true` is the point of no quiet failure.** With it set, the app refuses to boot if any of the three role URLs is missing, unparseable, or names `postgres`/`postgres.<ref>`/`supabase_admin`. Without it, a missing URL silently falls back to the migration principal and preview would *look* protected while being exactly as exposed as before. Set the three URLs **first**, then the flag, then redeploy — in that order, a typo costs you a failed boot rather than a false sense of isolation.

---

## 5. Redeploy preview

A Vercel environment-variable change does not take effect until the next deployment. Redeploy the current preview build.

---

## 6. Tell me, and I will verify

Once preview is up I will, read-only:

- call `verifyDbAuthorities()` against the three connections and confirm each reports `current_user` = its own role, `rolsuper = false`, `rolbypassrls = false`, and **zero owned tables**;
- run the adversarial suite against preview with safe scratch fixtures, torn down afterwards;
- confirm `fm_auth` cannot read `Transaction`, `PositionObservation`, `PlaidItem`, `SpaceMemory` or `DailyBrief`;
- exercise normal product flows and report latency and pool behaviour.

That completes the original Slice 8 proof.

---

## Rollback

**Unset `FM_RLS_STRICT` and redeploy.** The app returns to the shared client and behaves exactly as it does today, with the policies still installed but inert against `postgres`. One variable, one redeploy, no migration, and the security state is unchanged rather than removed.

**Do not reach for `DISABLE ROW LEVEL SECURITY`.** It is not the rollback lever — it removes the boundary for every principal rather than restoring the previous routing, and it is the one action that turns an availability problem into a security one.

If a specific policy is wrong rather than the whole mode, the unit of rollback is that table's policy, reverted as a migration and reviewed, not a blanket disable.
