# RLS — PREVIEW CUTOVER RUNBOOK

**Status:** prepared, **not executed**. Every step that touches Preview is an OWNER action. Nothing in this document has been run against Preview or Production.
**Revised:** 2026-10-06 (Preview preflight read; owner-verified Plaid provenance; pool decision). Previously 2026-10-04, RLS-PREP (strict-mode pooler identity, deployed authority verification, foreground owner-path conversion). Supersedes the RLS-5 version, whose migration counts, role-URL instructions and verification step were no longer true.
**Authority:** `docs/plans/POSTGRES-RLS-ARCHITECTURE-INVESTIGATION.md` · the ten migrations in §1 · `lib/db/strict-mode.ts` · `lib/platform/db-authority.ts`.

**No secret appears in this document, and none should ever be pasted into a chat, a commit, or an issue.** The flow is arranged so that the only place a role password exists is your terminal and the two systems that need it.

Two labels are used throughout:

- **VERIFIED (repo)** — established from the code, migrations or tests in this repository.
- **CHECK REQUIRED** — a provider-side fact (Supabase, Vercel, Plaid). The repository cannot prove it. Where a value from an earlier dashboard reading is quoted, it is dated and must be re-read before it is relied on.

---

## 0. What this cutover does, and what it does not

**It does:** install the RLS migrations on Preview, give the three runtime roles credentials, route the application through them, and prove — from the deployed process itself — that each connection is the role it claims.

**After it, on the tenant role (`fm_app`, NOBYPASSRLS, non-owner)** — VERIFIED (repo):

| Surface | Authority |
|---|---|
| Dashboard, accounts, transaction reads, Space CRUD, export, disconnect | `withTenantDb` |
| AI chat, tools, Memory, Daily Brief | `withTenantDb` per phase |
| Transaction correction; CSV import preview + commit; wallet add; FICO update | `withTenantDb` (RLS-PREP-C) |
| Investments workspace; Connections page; `/api/sync/status` | `withTenantDb` (RLS-PREP-C) |
| Plaid routes' own item lookups and audit writes (sync, refresh, resume-sync, link-token, investments-enable) | `withTenantDb` (RLS-PREP-C) |
| Wealth-timeline amendment: the gate and the amendment's own records | `withTenantDb`; the regeneration engine runs as `fm_system` |
| Investment import commit; opening-position assertion (RLS-PREP-2) | `withTenantDb`: one phase for the batch, one per row, one per superseded instrument, one to finalize, one for reconstruction repair. Instrument identity is resolved and minted as `fm_app` (global reference data it may already write). Operator incidents (`SyncIssue`) are recorded by `fm_system`, only after a tenant phase has admitted the account and ended; the writer holds no database client. |

**Still on the migration principal (`postgres`) after it** — VERIFIED (repo), and this is the honest boundary of the claim Preview can make:

| Surface | Why it is not converted | Containment |
|---|---|---|
| Wallet provider-spine bookkeeping (`alignWalletProviderSpine`) inside wallet add | Best-effort, swallows its own failures (which would abort a tenant transaction), and its identity write takes no client. | Runs after the tenant phase commits; recorded on the authority ratchet as an implicit owner call. |
| Provider ingestion started by a foreground request (Plaid sync/refresh, wallet sync, snapshot regeneration) | Interleaves provider HTTP with writes; a tenant phase must never span a network round trip. System authority, separate slice. | The item/account the work runs for is selected by a tenant-phase read. |
| Documented exceptions in `app/api/spaces/[id]/{route,permanent,snapshots,accounts/detail}` | Each is explained in its file header (public-Space read, cross-tenant ownership count, user-keyed PlaidItem state). | Reviewed in earlier RLS slices; unchanged here. |
| `getSpaceContext`, notifications, settings loaders, `/api/auth/*`, rate limiting | Non-financial identity/membership and pre-identity paths. | Out of scope for this slice. |
| Admin, Platform Ops, cron, the Plaid webhook, operator scripts | System / operator authority. Separate deployment concern. | Operator gates, `CRON_SECRET`, webhook signature. |

The exact residue is machine-readable: `scripts/lib/db-authority-baseline.json` (163 files importing the owner client, 49 owner-default sites, 64 implicit owner calls). `npm run audit:ci` fails if any of the three grows.

---

## 1. Migrations

**VERIFIED (repo):** 118 migration directories. The ten below are the RLS programme Preview received on 2026-10-06 (117 applied); `20261006000000_rls_function_execute_least_privilege` follows them (§2.1):

| Migration | What it does |
|---|---|
| `20261002000000_tenancy_integrity` | `Transaction` / `Holding` `financialAccountId` NOT NULL; `MerchantRule` scope CHECK. **Data-dependent.** |
| `20261002000100_rls_roles_and_policies` | Creates `fm_app`, `fm_auth`, `fm_system`, `fm_backup`; grants; enables and FORCES RLS; policies; revokes PostgREST roles. |
| `20261002000200_rls_auth_surface` | `fm_auth` grants/policies (User, UserSession, RecoveryCode, AuditLog insert, RateLimit). |
| `20261002000300_rls_app_platform_settings` | `fm_app` read of `PlatformSetting`. |
| `20261002000400_rls_membership_bootstrap` | `fm_may_join_space`; Space/SpaceMember bootstrap policies. |
| `20261002000500_rls_app_sync_issue_read` | Column-scoped `SyncIssue` read for `fm_app`. |
| `20261002000600_rls_beta_access_request_seam` | Pre-tenant intake seam. |
| `20261003000000_rls_account_subtree_owner_arm` | Owner arm on the 13 account-subtree tables. |
| `20261003000100_rls_duplicate_candidate_owner_arm` | Owner arm on `DuplicateAccountCandidate`. |
| `20261004000000_plaid_identity_global_exclusivity` | Partial unique index, `provider = 'PLAID'`. **Data-dependent.** |

Expected end state — VERIFIED (repo): 64 application tables, **56 with RLS enabled AND forced**, 8 without (global reference data and `RateLimit`).

**CHECK REQUIRED — how many are pending on Preview.** The last reading (investigation doc, before 2026-10-01) was **88 applied**, which would make **29 pending**: 19 non-RLS v2.6 migrations (all additive: nullable/defaulted columns, new tables, indexes) plus the ten above. Read the real number first:

```sql
select count(*) as applied, max(migration_name) as newest,
       count(*) filter (where finished_at is null) as unfinished
  from _prisma_migrations;
```

⚠️ `prisma migrate deploy` applies **all** pending migrations, i.e. it deploys v2.6's schema to Preview, not just RLS. If you want those separate, deploy the 19 first as their own act and confirm the app is healthy.

Vercel does **not** run `migrate deploy`. Migrations are applied by hand over `DIRECT_URL`.

---

## 2. Provider checks — do these BEFORE anything else

None of these can be established from the repository. Each is CHECK REQUIRED.

### 2.1 Supabase — Data API exposure (was a critical drift)

Last reading (investigation doc): on Preview, `anon` and `authenticated` held full DML on all 56 tables, all were exposed through the Data API, and "automatically expose new tables" was **ON**. Production had none of that.

- Confirm the current state in the dashboard (API settings → exposed schemas/tables; Security Advisor).
- Turn **off** "automatically expose new tables" and un-expose `public` before migrating. With it on, the 19 non-RLS migrations create tables that are granted to `anon` until `rls_roles_and_policies` revokes them later in the same deploy.
- After migrating, re-read with the queries in §5. VERIFIED (repo): the migration revokes **tables** and default privileges from `anon` / `authenticated` / `service_role`, but it did **not** revoke function `EXECUTE` from `PUBLIC` (confirmed on Preview 2026-10-06: all five `fm_*` functions PUBLIC-executable; `fm_may_join_space` is SECURITY DEFINER). `20261006000000_rls_function_execute_least_privilege` closes it: PUBLIC none, `fm_app` all five, `fm_auth` only `fm_beta_request_is_intake`, `fm_system`/`fm_backup` none — derived from which roles' policies evaluate each function (foreground acceptance 53–57). It does not revoke existing sequences.

### 2.2 Supabase — pooler, and the username form for a custom role

- Which pooler serves Preview's `DATABASE_URL` (shared Supavisor on `*.pooler.supabase.com`, or a dedicated pooler)?
- **How does that pooler expect a custom role to be named?** The existing owner URL uses `postgres.<project-ref>`. The documented convention for a custom role on the shared pooler is the same shape, `fm_app.<project-ref>`. **This has not been verified against Preview.** Test it once with `psql` before putting it in Vercel (§6).
- VERIFIED (repo): strict mode accepts exactly two spellings — the bare role (`fm_app`), or `fm_app.<ref>` when the host is a Supabase pooler host, `<ref>` is a 20-character project reference, and it is the **same** reference `DATABASE_URL` names. Anything else refuses to boot. Whichever spelling the pooler accepts, the deployed verifier (§8) asks the server `current_user`, which carries no suffix.

### 2.3 Supabase — connection capacity

VERIFIED (repo): each process now holds **four** Prisma pools (`db`, `fm_app`, `fm_auth`, `fm_system`), each capped at 5 connections in code (`lib/db/connection-url.ts`). The sizing note in that file assumed one pool.

CHECK REQUIRED:
- Pooler **pool size** (last reading on Production: 15 per user+database) and whether it is per user. Four users at 15 is 60.
- Postgres **`max_connections`** on Preview's compute (last reading on Production, Micro: 60) and how many Supabase's own services hold.
- Pooler **max client connections** (last reading: 200).

Four pools at the default size can equal `max_connections`. Decide the pool size so that four pools plus Supabase's reserved connections stay under it, and watch the connection graph during §9 row 24.

**Read 2026-10-06 and owner decision.** Preview (Nano): `max_connections` 60, `superuser_reserved_connections` 3, Supavisor pool size 15 per user+db, max client connections 200; at idle Supabase itself held 3 client connections. Supavisor (documented, Supavisor FAQ) keeps one pool per user + database + mode, opens server connections only on demand, and closes idle ones after 5 minutes — so 15 is a ceiling, not a reservation. The four pools can still reach 60 in theory, against roughly 50–54 actually available. **Decision: lower the pool size 15 → 12 immediately before §9 row 24, not before migrating** (4 × 12 = 48, and each role still covers two saturated instances at 5 each). Also watch Supavisor client connections in row 24: 20 per instance against a fixed 200.

### 2.4 Supabase — can `postgres` create a BYPASSRLS role?

`rls_roles_and_policies` runs `CREATE ROLE fm_backup … BYPASSRLS`. Supabase's `postgres` is not a true superuser. CI runs this as a superuser, so it has never been exercised as Supabase's `postgres`. If it fails, the migration fails as a whole and rolls back cleanly; it then needs `prisma migrate resolve` and a decision. `fm_backup` is not needed for Preview.

### 2.5 Vercel

- Which **branch** Preview builds. It must be `v2.6`: none of this work is on `main`.
- Whether Fluid Compute is on for Preview.
- `INVESTMENT_IMPORTS_ENABLED` is set (`true`) on Preview. Since RLS-PREP-2 (a138da7, gated green at e3d5e14) the writers behind it run as `fm_app` (§0), so the flag is not an RLS containment and the cutover does not change it.
- Whether `CRON_SECRET`, `RESEND_API_KEY`, `PLAID_ENV`, `PLAID_REDIRECT_URI`, `PLAID_WEBHOOK_URL` are set for Preview, and what Preview's database contains (§2.6).

### 2.6 What Preview holds

VERIFIED (repo): no job, cron route or email path consults `VERCEL_ENV`. Protection against Preview acting on real things is **configuration only**. Before the acceptance run, confirm:

- Does Preview's database hold real users or real Plaid Items? (`select count(*) from "User"; select "environment", count(*) from "PlaidItem" group by 1;`)
- Is Preview's `PLAID_ENV` production or sandbox?
- Is `RESEND_API_KEY` set on Preview? If it is, a job run there sends real mail.

**Read 2026-10-06 (read-only preflight; nothing mutated).** 4 users, no session since 2026-08-01. 10 `PlaidItem` rows: 2 `ACTIVE` (`…dkklx3` "Chase", `…kp9cks` "Wells Fargo", each with its accounts, `PLAID` identities and transactions), 8 `REVOKED`. Last sync 2026-07-27. `PLAID_ENV` on Preview is `production`; `RESEND_API_KEY` and `CRON_SECRET` are set.

**Plaid provenance — OWNER-VERIFIED, not database-provable.** The owner has verified through the Preview application that every existing Preview Plaid Item is **historical Plaid Sandbox test data**, and that the `…testing.com` user is not a real external user. The database cannot prove this itself: these rows predate `PlaidItem.environment`, which arrives in the pending migration `20260908224119_plaid_item_environment`, and the current `PLAID_ENV=production` does not say which environment issued the legacy tokens. Therefore:

- Both existing ACTIVE Items are **legacy sandbox test data**, not provider-acceptance candidates.
- **Never** refresh, sync, disconnect, or otherwise make a Plaid call with either of them while `PLAID_ENV=production` — including indirectly through `/api/jobs/dispatch` (see §9 row 20).
- Their **database** records (accounts, transactions, identities) MAY be used for authorization tests that make no provider call.
- Do not delete or rewrite them to make the test clean, and do not disconnect them unless the owner explicitly authorizes it.
- Provider acceptance (§9 rows 13–16) requires a **newly linked Item** in a Preview Plaid environment the owner has deliberately chosen. That choice — and any change to `PLAID_ENV`/`PLAID_SECRET` — is a separate owner decision taken **after** the cutover and **before** provider acceptance. It is not part of this runbook.

---

## 3. Preflight on Preview's own data (read-only)

Three statements in the pending set fail on existing rows. CI never meets real data, so run these against Preview first. All four must return `0`.

```sql
-- tenancy_integrity: refuses, by RAISE, if any of these exist
select count(*) from "Transaction" where "financialAccountId" is null;
select count(*) from "Holding"     where "financialAccountId" is null;

-- tenancy_integrity: MerchantRule_scope_key_ck (no preflight in the migration; fails raw)
select count(*) from "MerchantRule"
 where not ( (scope = 'USER'  and "ownerUserId" is not null and "spaceId"     is null)
          or (scope = 'SPACE' and "spaceId"     is not null and "ownerUserId" is null) );

-- plaid_identity_global_exclusivity: the unique index fails if any Plaid id is held twice
select count(*) from (
  select "externalAccountId" from "ProviderAccountIdentity"
   where provider = 'PLAID' group by 1 having count(*) > 1) d;
```

A non-zero result is a **stop**, not something to backfill around. The migrations say so themselves.

Then take a backup of Preview (`npm run db:backup` with Preview's URLs exported, or a dashboard backup) and note where it is.

---

## 4. Apply migrations to Preview

From a terminal with Preview's connection strings exported:

```sh
npx prisma migrate deploy
```

This creates the four `fm_*` roles **with LOGIN and no password**, so each is inert until §6. It enables and forces RLS and installs the policies. Because the application still connects as `postgres` (which owns the tables and carries BYPASSRLS), **nothing changes behaviourally at this point.** The policies go in cold.

If a migration fails it rolls back as one transaction and leaves a failed row; resolve it with `prisma migrate resolve` only after understanding why.

---

## 5. Verify what was installed

```sql
select rolname, rolcanlogin, rolsuper, rolbypassrls
  from pg_roles where rolname like 'fm\_%' order by 1;

select count(*) filter (where relrowsecurity)      as rls_on,
       count(*) filter (where relforcerowsecurity) as forced,
       count(*)                                    as tables
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relname <> '_prisma_migrations';

select count(*) from pg_policies where schemaname = 'public';

-- the PostgREST roles must hold nothing on application tables
select grantee, count(*) from information_schema.role_table_grants
 where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
 group by 1;
```

Expect: four `fm_*` roles, none superuser, only `fm_backup` with `rolbypassrls = t`; `rls_on = forced = 56` of 64 tables; a policy count in the hundreds; and **no rows** from the last query.

---

## 6. Give the three runtime roles a password

**Generate the secrets yourself. Do not send them to anyone, and do not store them anywhere but Supabase and Vercel.** These are Preview's own; Production gets different ones.

```sh
# run three times, once per role
openssl rand -base64 30 | tr -d '/+=' | head -c 40; echo
```

In the Preview project's SQL editor:

```sql
ALTER ROLE fm_app    WITH PASSWORD '<secret 1>';
ALTER ROLE fm_auth   WITH PASSWORD '<secret 2>';
ALTER ROLE fm_system WITH PASSWORD '<secret 3>';
```

`fm_backup` is not part of the Preview cutover.

**Now settle the username form (§2.2), from your own terminal, before Vercel is involved.** Take Preview's pooled connection string and change only the userinfo:

```sh
psql "postgresql://fm_app.<project-ref>:<secret 1>@<pooler host>:6543/postgres" -c "select current_user"
```

- Prints `fm_app` → the pooler form works. Use it for all three.
- Authentication or "tenant/user not found" error → try the bare `fm_app`, or the form the Supabase connection page shows for a custom role. Use whichever returns `current_user = fm_app`.

Do not guess past this step. The role URL that goes into Vercel must be one you have seen authenticate.

---

## 7. Set four Vercel environment variables (Preview scope only), in this order

Compose each role URL from Preview's existing pooled `DATABASE_URL`, changing **only the userinfo**: same host, port `6543`, `?pgbouncer=true`, database. Do not add `connection_limit`; the runtime owns it.

| Order | Variable | Value |
|---|---|---|
| 1 | `DATABASE_URL_APP` | the `fm_app` URL |
| 2 | `DATABASE_URL_AUTH` | the `fm_auth` URL |
| 3 | `DATABASE_URL_SYSTEM` | the `fm_system` URL |
| 4 | `FM_RLS_STRICT` | `true` |

Leave `DATABASE_URL` and `DIRECT_URL` exactly as they are. They remain the migration principal, and `db` still uses `DATABASE_URL` for the surfaces listed in §0.

**The three URLs first, then the flag.** With `FM_RLS_STRICT=true` the app refuses to boot if a role URL is missing, unparseable, names the migration principal, names the wrong role, is a look-alike (`fm_appx`, `fm_app.<not-a-ref>`), or routes to a different project than `DATABASE_URL`. Without the flag, a missing URL silently falls back to `postgres` and Preview would look protected while being exactly as exposed as before. In that order a typo costs a failed boot, not a false sense of isolation.

⚠️ Strict mode checks **spelling**. It cannot know whether the role behind a correctly spelled URL carries BYPASSRLS. That is what §8 is for.

Then redeploy: a Vercel variable change takes effect only on the next deployment.

---

## 8. Verify the DEPLOYED authority

VERIFIED (repo): `GET /api/platform/platform-ops/db-authority` reports, from inside the deployed process, what each role connection actually is. It is operator-only (`PLATFORM_OPS` READ with the live-revocation re-check; 401 without a session, 403 without the grant) and is not part of `/api/health`.

Sign in to Preview as an operator and open that URL. **HTTP 200 means isolated; 503 means not.** The body is the same either way and contains no connection string, password, host or project reference.

It must show, for each of `fm_app`, `fm_auth`, `fm_system`:

| Field | Required |
|---|---|
| `bound` | `true` (a distinct client exists; not the legacy fallback) |
| `verdict.actual` | the role's own name — what the **server** returned for `current_user` |
| `verdict.superuser` | `false` |
| `verdict.bypassRls` | `false` |
| `verdict.ownedTables` | `0` |
| `verdict.memberOf` | `[]` (it cannot `SET ROLE` elsewhere) |
| `problems` | `[]` |

and:

- `strict: true`, `configProblems: []`
- `tenantChannel.boundInsideTransaction: true`, `tenantChannel.residueObserved: 0` (no `app.user_id` left on a pooled connection after the transaction that set it)
- `rls.rlsEnabled == rls.rlsForced == 56`, `rls.policies` in the hundreds
- each `shape.pgbouncer: true`, `shape.port: "6543"`

Anything else is a stop. Roll back with §10 and read the `problems` array: it states the cause.

---

## 9. Integrated acceptance on Preview

Unit and CI suites prove the policies and the converted functions on a throwaway database over a direct connection. They do **not** prove the deployed app through the pooler. This run does. Use two scratch users (A and B), each with a personal Space, plus one Space they share.

| # | Action | Expected | Blocking |
|---|---|---|---|
| 1 | §8 authority report | 200, all fields as listed | Yes |
| 2 | Log in; inspect the session cookie | `__Host-` prefix, no Domain attribute | Yes |
| 3 | Log out; replay the old cookie | refused | Yes |
| 4 | Revoke all sessions from a second device | first device signed out within ~30 s | High |
| 5 | Open a deep link signed out, then log in | lands on the deep link | Medium |
| 6 | Dashboard, accounts, transactions, analyze, investments, connections | data renders; no empty panels where data exists | Yes |
| 7 | POST a write with a foreign `Origin` header | 403 | Yes |
| 8 | As A, request B's Space, account and transaction ids on every read route | 403/404, never data | Yes |
| 9 | As A, attempt writes on B's ids: correct a transaction, import a CSV into B's account, add a wallet with B's active Space id, amend B's Space | each refused; B's rows unchanged | Yes |
| 10 | Force a refused write (e.g. correct a transaction whose link was just revoked) | an error response, never a success | High |
| 11 | Shared Space: B reads A's linked account; A unlinks; B reads again | visible, then gone | Yes |
| 12 | Duplicate reconciliation (re-add an archived wallet) | folds; no partial state | High |
| 13 | Plaid Link, including an OAuth institution — **only with a NEW Item, in the owner-chosen Preview Plaid environment (§2.6)** | returns to `/plaid-oauth-return`; accounts appear | Yes, once that environment is decided |
| 14 | Manual refresh and history import — **the NEW Item only; never the two legacy sandbox Items** | rows written; `RefreshExecution` rows present | High |
| 15 | Disconnect an account — **the NEW Item only**; the legacy Items are disconnected only on explicit owner authorization | Plaid removal succeeds; every link revoked | High |
| 16 | Webhook delivery; then one with a bad signature. `PLAID_WEBHOOK_URL` is unset on Preview, so only the bad-signature half is testable until the Plaid environment decision | 200 and a sync; 401 | High |
| 17 | Generate the Daily Brief | one Brief for the active Space | High |
| 18 | AI financial question, a scenario tool, a Memory write | answers from own data; an `AiInvocation` row is written | High |
| 19 | Platform Ops pages; one control action | work behind the fresh-auth gate | Medium |
| 20 | Invoke `/api/jobs/dispatch` without the bearer (any time); with it **only inside a half-hour UTC slot that has no registered job** (e.g. 03:00–03:29). The dispatcher runs whatever the current slot holds, and the 06:00 slot's `sync-banks` would call Plaid with the legacy Items | 401; a no-op dispatch | High |
| 21 | Request access on the app's form | `BetaAccessRequest` row; CAPTCHA enforced | Medium |
| 22 | Public site: page source and network tab | no cookies, no API calls, no secrets | Yes |
| 23 | Site → app links and back | correct hosts | Medium |
| 24 | ~200 concurrent mixed requests as A and B for several minutes | no P2024; no pooler checkout timeouts; connection graph under the ceiling from §2.3 | Yes |
| 25 | Same run: every response checked against its user; then re-open §8 | zero cross-user rows; `residueObserved: 0` | Yes |

Rows 8–12 may use the legacy sandbox Items' **database** records (accounts, transactions, identities): those rows exercise authorization without any provider call. Scratch users and every other address that can receive mail must be owner-controlled; `RESEND_API_KEY` stays set.

Rows 8–10 are now a test of the **database boundary** for the surfaces in §0's first table. For the surfaces in §0's second table they still prove only the application's own checks.

---

## 10. Rollback

**Unset `FM_RLS_STRICT` and remove the three `DATABASE_URL_*` role variables, then redeploy.** The app returns to the shared client and behaves exactly as it does today, with the policies still installed but inert against `postgres`. No migration, and the security state is unchanged rather than removed.

Unsetting only the flag is **not** a rollback of routing: the role URLs are still used wherever they are set. It only removes the refusal to boot.

**Do not reach for `DISABLE ROW LEVEL SECURITY`.** It removes the boundary for every principal rather than restoring the previous routing, and it is the one action that turns an availability problem into a security one.

If a specific policy is wrong rather than the whole mode, the unit of rollback is that table's policy, reverted as a migration and reviewed.

Not reversible without hand-written SQL: the roles themselves (cluster-global), the two NOT NULL constraints, the `MerchantRule` CHECK, the PostgREST revokes, and the Plaid unique index (its `DROP INDEX` is documented in the migration and reopens the hole it closed). There are no down migrations.

---

## 11. Not part of this runbook

Domain moves, `NEXTAUTH_SECRET` rotation, Plaid webhook migration, `fm_backup` wiring, OpenAI project separation, and Production. `ENCRYPTION_KEY` is **preserved** throughout: there is no keyring, and rotating it makes stored Plaid tokens and TOTP secrets unreadable.
