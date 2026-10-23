# Production cutover plan: v2.6 + RLS authority + `NEXTAUTH_SECRET` / `CRON_SECRET` rotation

**Status: PLAN ONLY.** Nothing in this document has been executed against Production. Prepared 2026-10-06 from read-only measurement of Production (§1). Every Production step in §5 needs the owner's explicit authorisation (§9.11).

**Builds on:**
- `docs/operations/rls-preview-cutover.md`, the proven Preview topology. Reused here, not reinvented.
- `docs/operations/environment-separation.md`
- `lib/db/strict-mode.ts`
- `lib/platform/db-authority.ts`

> **Addendum, 2026-10-06 ~19:30Z (Preview Plaid Sandbox lane).** It supersedes the counts below where they differ.
>
> - **Pending migrations are now 34** (88 → 122): `20261007100000_operationalization_p0_facts` (OPERATIONALIZATION P0) adds nullable attribution/outcome columns to `AiInvocation` (`userId`, `spaceId`, `conversationId`, `subSurface`, `outcome` default `'RETURNED'`, `errorCode`, `providerRequestId`) and two operator-only append-only tables (`PlaidWebhookEvent`, `BetaAccessRequestEvent`) with RLS enabled+forced and the §4 grant posture. Additive, compatible with the old app, no backfill.
> - **Pending migrations were 33** (88 → 121). `20261007000000_financial_account_provider_subtype` adds the nullable `FinancialAccount.providerSubtype` (Plaid's account subtype, kept for liquidity access: HSA / retirement / brokerage). It is additive, compatible with the old app (the old client never selects it), and needs no backfill. **Cutover consequence:** until each Production Plaid Item's first v2.6 refresh writes it (≤ 24 h at BANK cadence), investment accounts read "Access unverified" (not "within days") and HSAs stay unrestricted cash. That is the conservative direction, and it self-corrects. Never backfill from account names.
> - Previously 32 (88 → 120): `20261006020000_plaid_item_sync_origin_cursor` adds the nullable `PlaidItem.syncOriginCursor`. It is additive, compatible with the old app, and needs no backfill.
> - **Candidate must include `1988067`**: the fix for the pagination-mutation restart. A fresh Sandbox OAuth Item was stranded at "100 imported" and recovered on the fix. The defect also exists on `main`/Production.
> - ✅ **RESOLVED by `ea48807` (2026-10-07), so the candidate must include it.** The original finding follows.
>   **FIX BEFORE CUTOVER (security):** `lib/plaid/webhook-verify.ts` calls Plaid `webhookVerificationKeyGet` for an **unauthenticated, attacker-chosen `kid`** before verifying anything. Failures are not cached, and the route has no rate limit. Production's webhook is public, so anyone can make the server issue Plaid calls. The same code is on `main` today.
> - **Candidate must also include `fc86771`** (Connections truth). The card claimed work that was not running: "importing… 100 imported" for a stopped import, and "building your timeline — finishes in the background" with nothing building it.
>   - State now requires ledger evidence. New states are `import_paused` and `INTELLIGENCE_NOT_BUILT`.
>   - The browser resume now runs the shared full pipeline, anchor included.
>   - This also resolves the UX defect above: a paused import is no longer "importing", so its ⋯ menu (Refresh) is available and the poller resumes it immediately.
> - **…and the Investments-consent truth fix** (the commit after `fc86771`). `PRODUCTS_NOT_SUPPORTED` is now recorded as `UNSUPPORTED`, so the card stops claiming "Investments synced" and the failing call stops repeating. Production's 3 ACTIVE Items will reconcile on their next refresh.
> - **UX defect (resolved by `fc86771`):** the ⋯ menu was hidden while a connection was "importing", so a stranded import had no manual recovery.
> - Section 8 issue 1 (Plaid paths never exercised) is now covered for the per-Item pipeline. The outer `sync-banks` all-Items loop is still not end-to-end tested. See the Plaid Sandbox lane report.

**No secret appears here.** Values are generated locally and piped straight into the system that needs them. Credential files live only under `tmp/prod-cutover/` (gitignored), mode 600, and are never printed.

---

## 1. Production as measured (read-only, 2026-10-06 ~17:30Z)

### Application

| Fact | Value | How measured |
|---|---|---|
| Serving deployment | `dpl_JcZ52DcQdMgCbZvS9zRGSSxhzKxp` (`fintracker1-32omlyc5y`), created 2026-07-27 19:33Z | `vercel inspect https://fourthmeridian.com` |
| Deployed SHA | `87e4df7`, which is `origin/main` HEAD | GitHub deployment 5628710178 → that URL |
| Aliases | `fourthmeridian.com`, `fintracker1-virtuarchs-projects.vercel.app`, `fintracker1-git-main-…` | inspect |
| Production branch | `main`. A push to `main` builds Production **and auto-aliases it** | git-main alias on the prod deployment |
| `main` vs `v2.6` | `main` has exactly **one** commit not on `v2.6` (`87e4df7`). Its content is identical to `v2.6`'s `146a0dd` (cherry-pick). `git merge-tree origin/v2.6 87e4df7` gives **exactly the v2.6 tree** (`dff2152b…`) | git |
| Domain stage | Apex served by the app (`fintracker1`). `www`/`app.` not configured. `v2.6` still serves the landing page at `/`. Write-origin derives "self" from the request host, with no env dependency | inspect, curl, code |
| Session model | Pre-P1: a JWT signed with the **shared** `NEXTAUTH_SECRET` is accepted without a session-row proof (`environment-separation.md` §6). Cookie `__Secure-next-auth.session-token` | code at `87e4df7` |

### Database

Project `fourth-meridian-production`, ref `qirfzvvaeddukjiphims`, Micro, ap-southeast-1.

| Fact | Value | How measured |
|---|---|---|
| Postgres | 17.6. `max_connections` 60, `superuser_reserved_connections` 3 | SQL (read-only SELECT) |
| Pooler | Shared Supavisor. Pool size **15** per user+db (default for Micro). Max clients **200** (fixed) | dashboard → Database settings |
| Migrations | **88 applied**, 0 unfinished, 0 rolled back, newest `20260727_v26pre_b4_btc_identity_backstop`. The name set equals `main`'s 88 exactly (fingerprint `d4c9f9e607814261` on both sides) ⇒ **31 pending** = the 31 `v2.6` adds | SQL + git |
| Roles | No `fm_*` roles. `postgres`: `bypassrls=t`, `createrole=t`, no role settings. Cluster `idle_in_transaction_session_timeout` = 0 | SQL |
| RLS | 0 of 55 tables enabled/forced, 0 policies, no `fm_*` functions | SQL |
| Data API | Enabled, but **0 of 56 tables exposed**, auto-expose **off**, `anon`/`authenticated`/`service_role` hold **0** table grants | dashboard + SQL |
| Activity at read time | Idle (2 authenticator, 2 pgbouncer, 1 postgres idle, internal services) | SQL |

### Data

| Fact | Value | How measured |
|---|---|---|
| Users | **2** (1 `SYSTEM_ADMIN`). **Both TOTP-enrolled** (TOTP secrets `v2:`). 0 deactivated | SQL |
| Sessions | 12 un-revoked rows; **1** active in the last 30 days (last activity 2026-10-03) | SQL |
| Plaid | 3 ACTIVE, 1 NEEDS_REAUTH, 3 REVOKED Items. All 7 tokens and all 4 PLAID `Connection.credential` are `v2:`. 4 PLAID + 1 WALLET connections ACTIVE | SQL (status/format counts only) |
| Crons | Healthy. 0 failures in 7 days:<br>• `resume-stale-imports` every 5 min (2,016 runs / 7 d)<br>• `sync-banks` 06:00 daily (Plaid)<br>• `sync-crypto` 4×/day<br>• fx/prices 06:30; deletions 07:00; housekeeping 07:30 | `JobRun` |
| Data preflight | Null `Transaction.financialAccountId` **0**, null `Holding.financialAccountId` **0**, bad `MerchantRule` scope **0**, duplicate PLAID identities **0** | SQL |
| Sizes | 4,909 transactions, 9 holdings, 637 audit rows, 6 Spaces (4 platform), 4 `PlatformGrant` (WRITE, ACTIVE) | SQL |

### Vercel Production environment (names and record metadata only)

- **Present:**
  - `DATABASE_URL`, `DIRECT_URL`
  - `NEXTAUTH_SECRET` and `ENCRYPTION_KEY` (**one shared Production+Preview record each**, 2026-06-16)
  - `CRON_SECRET` (own record), `PLAID_CLIENT_ID` (shared), `PLAID_SECRET`, `PLAID_ENV`
  - `OPENAI_API_KEY`, `RESEND_API_KEY`, market keys
  - `NEXT_PUBLIC_SENTRY_DSN`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`
  - `DISABLE_SYSTEM_ADMIN`, `RATE_LIMIT_ENABLED`, feature flags
- **Absent:** `DATABASE_URL_APP`, `DATABASE_URL_AUTH`, `DATABASE_URL_SYSTEM`, `FM_RLS_STRICT`.
- **Absent, and REQUIRED by the candidate (2026-10-07, OPERATIONALIZATION P0):** `PLATFORM_ALERTS_EMAIL` — it joined `PROD_REQUIRED_KEYS`, so a Production deploy of the candidate will not boot until it is set to a monitored mailbox. `BETA_REQUESTS_EMAIL` is also absent but stays optional.
- The newest Production-targeted record update was 2026-09-01.

### Cron callers

`vercel.json` (identical on `main` and `v2.6`) schedules only:
- `/api/jobs/dispatch` at `0,30 0,6,7,12,18 * * *`;
- `/api/jobs/resume-stale-imports` every 5 min.

No operator script or external service calls `/api/jobs/*` (split doc §17.6). The per-job fallback routes are unscheduled.

The `v2.6` dispatcher adds one job, `sync-crypto-continuation` (wallets, :30 past 00/06/12/18). It adds no Plaid, AI or Brief job.

**Dispatch-free window: 08:00–11:59 UTC.**

### Encryption

- `lib/plaid/encryption.ts` changed `87e4df7 → v2.6` by **additions only** (+47/−0: a new purpose, `AI_RUNTIME_STATE`, plus `seal`/`openWithPurpose`).
- Every existing purpose label, the HKDF derivation and `v2` decrypt are byte-identical.
- All Production ciphertext is `v2:`.

## 2. The 31 pending migrations

**Old app on the new schema:** the old app connects as `postgres`, which holds `BYPASSRLS` on Production (measured). BYPASSRLS overrides even FORCE RLS, so every RLS migration is **inert** for the old app until traffic moves.

| # | Migration | Class | Old app (`87e4df7`) after it? | v2.6 | Rollback note |
|---|---|---|---|---|---|
| 1–19 | `20260801_*` … `20261001120000_connection_facet_freshness` (investment coverage, crypto valuation, capability observation, stage split, corporate actions, L8 event identity, `economicDate` column, event projection, flow authority, observation link evidence, position coverage, Space Memory, `AiInvocation`, `PlaidItem.environment`, `DailyBrief`, refresh-execution source, connection facet freshness) | Schema-only, additive: new tables; nullable or defaulted columns; indexes on new or small tables. New unique indexes are on **new** tables only | **Compatible.** The old Prisma client never selects unknown columns. `RefreshExecution.sourceKind` is `NOT NULL DEFAULT 'PLAID_ITEM'`; `plaidItemId` DROP NOT NULL only relaxes | Required | No down migrations. Harmless to leave |
| 20 | `20261002000000_tenancy_integrity` | Constraint. `Transaction`/`Holding.financialAccountId` SET NOT NULL; `MerchantRule` scope CHECK. Data-dependent, RAISEs on violation | **Compatible.** Preflight 0/0/0. Every old-code writer supplies `financialAccountId` (`syncTransactions` skips unmapped rows; import, BTC sync, holdings sync set it). The old `MerchantRule` writer uses `scope:"USER"` + `ownerUserId`, which satisfies the CHECK | Required | Irreversible without hand SQL |
| 21–28 | `20261002000100` … `20261003000100` (roles + policies, auth surface, app platform settings, membership bootstrap, sync-issue read, beta seam, two owner-arm migrations) | **RLS/policy + role/grant.** Creates `fm_app`/`fm_auth`/`fm_system` (NOBYPASSRLS) and `fm_backup` (BYPASSRLS), LOGIN with **no password**. ENABLE+FORCE RLS on 56 tables; policies; revokes PostgREST roles; `fm_*` SECURITY DEFINER functions | **Compatible** (`postgres` BYPASSRLS). PostgREST revokes change nothing: 0 grants today, no supabase-js in the app | Required | Roles are cluster-global. Never `DISABLE ROW LEVEL SECURITY` |
| 29 | `20261004000000_plaid_identity_global_exclusivity` | Partial unique index (`provider='PLAID'`). Data-dependent | Compatible (0 dupes). An old-code duplicate PLAID identity would now **error** instead of duplicating, which is the intended block | Required | `DROP INDEX` documented in the file; it reopens the hole |
| 30 | `20261006000000_rls_function_execute_least_privilege` | Grant: PUBLIC none; `fm_app` all five; `fm_auth` only `fm_beta_request_is_intake` | Compatible | Required | Re-GRANT reverses |
| 31 | `20261006010000_platform_area_merchant_ops` | Enum ADD VALUE `MERCHANT_OPS` | **Compatible only while no row uses the value.** The old client throws on an unknown enum value. ⇒ seed the Merchant Operations Space **after** promotion (§5 step 10), never before | Required | Enum values are not removable in practice |

- **No migration drops, renames, or backfills data.**
- **Locking:** every table is small (largest: 4,909 transactions). Each ALTER takes a brief ACCESS EXCLUSIVE lock, and migration 21 runs as one transaction across many tables. Expect seconds of lock waits for the old app, in the dispatch-free window.
- **Verdict:** migrations may be applied **while the old app serves traffic**. No maintenance boundary is needed. No pending migration breaks the old app, as long as the `MERCHANT_OPS` Space is seeded after the switch.

**Data step outside migrations.** `scripts/backfill-economic-date.ts` (L8-A):
- dry-run by default; fills `Transaction.economicDate` only where null or disagreeing;
- idempotent, and skips event-linked rows;
- Preview needed it (442 rows); Production expects about 4,909.

The old app never reads the column, so run it after the migrations and **again after promotion**, to catch rows the old app wrote in between. v2.6 writers set the column themselves.

## 3. Production role / RLS design (same as Preview)

**Roles.**
- `fm_app`, `fm_auth`, `fm_system`: NOBYPASSRLS, created by migration 21.
- `fm_backup`: BYPASSRLS, **left without a password**, so it cannot authenticate and is never a runtime authority. Strict mode also refuses any role URL whose user is not the expected role.

**Credentials.**
- Generate three passwords locally.
- Compute SCRAM-SHA-256 verifiers locally, as on Preview: `tmp/rls-preview-cutover/set-role-passwords.sql` is the template.
- Apply `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'` in the Production SQL editor, so no cleartext password transits the dashboard.
- Role URLs live only in `tmp/prod-cutover/roles.env` and Vercel.

**URLs.**
- Runtime: shared transaction pooler `aws-1-ap-southeast-1.pooler.supabase.com:6543`, `?pgbouncer=true`, username **`<role>.qirfzvvaeddukjiphims`**. This spelling is proven on Preview's identical pooler. **Re-prove it per role with `psql … -c "select current_user"` before Vercel.**
- Migrations and backup: session pooler `:5432` (no local IPv6), as on Preview.
- **CHECK REQUIRED (owner):** Production `DATABASE_URL`'s username form. Strict mode holds the `.ref` suffix against `DATABASE_URL` only when that is itself `postgres.<ref>`. Either way the staged boot (§5 step 7) fails closed if it disagrees.

**Grants, policies and functions:** exactly what migrations 21–30 install. Verify against Preview's live counts (§5 step 3).

**Safety settings (from Preview evidence, §9b of the Preview runbook):**
- `ALTER ROLE fm_app|fm_auth|fm_system SET idle_in_transaction_session_timeout = '15s'`.
- `ALTER ROLE postgres SET … = '30s'`. Safe for the old app too: its transactions are ≤5 s, and it bounds stranded owner transactions.
- Supavisor pool size **15 → 12**: four users × 12 = 48 against 57 usable.

**Data API:** already closed (0 exposed, auto-expose off). The migration's revokes are belt and braces. Re-read after migrating.

**Production adversarial acceptance.** The CI suites refuse live databases by design (`lib/db/live-guard.ts`), so the Production equivalent has two halves:
1. **Clone rehearsal (before execution day).**
   - `pg_dump` Production (read-only) and restore into a throwaway PG17 database named `fintracker_rls_prodclone`.
   - Run `prisma migrate deploy` (31), then the backfill dry-run and apply, then `npm run audit:economic-date`.
   - Run `RLS_TARGET_URL=<clone> npm run rls:accept`.

   This proves the migrations and the backfill on **Production's real rows**.
2. **Live probes (execution day), as the real roles over the real pooler.** Writes only inside `BEGIN … ROLLBACK`:
   - `fm_app` with the owner's id cannot read or modify the other user's accounts or transactions;
   - no identity ⇒ 0 rows;
   - `fm_auth` `INSERT … RETURNING` into `AuditLog` denied, and `SELECT AuditLog` denied (the case-66 control);
   - plus the deployed `db-authority` report.

## 4. Secret rotation mechanics

### `NEXTAUTH_SECRET`

The current Production value is the **shared** record, so it cannot be edited in place without changing Preview's generic value too.
1. Owner, in the dashboard: edit the shared record and **untick Production** (it stays Preview-only, the old value).
2. Then add a Production-only record: `openssl rand -base64 32 | vercel env add NEXTAUTH_SECRET production --sensitive`.

Preview `v2.6` keeps its own branch override, so no Preview deployment ever receives the new value. Between steps 1 and 2 Production has no value. Any accidental Production build in that gap fails boot (`REQUIRED_KEYS`): fail-closed.

**Effect:** at promotion, **every Production session ends**: the old cookies are undecryptable, and the cookie name also changes to `__Host-`. Both users sign in again with TOTP.

**Login gate before declaring auth green:**
- fresh login writes `UserSession` + `LOGIN` audit together;
- one wrong password writes `LOGIN_FAILED(invalid_password)`;
- logout revokes the row + `LOGOUT` audit;
- session revocation from a second browser takes effect within about 30 s;
- `fm_auth` cannot SELECT `AuditLog` (§3 probe);
- case 67 is CI.
- Recovery code: **optional**, because it consumes one of the owner's real codes; only with consent.

### `CRON_SECRET`

- **Callers:** Vercel Cron only (two schedules). No external caller.
- **Mechanism:** set a new Production value with `vercel env update CRON_SECRET production --sensitive` from `openssl rand -hex 32`, **before** the staged build, so the staged build carries it.
- **Unknown:** whether Vercel's cron bearer is read from the serving deployment's env or the project's current env. The plan tolerates both. Do the env change, build and promotion inside the dispatch-free window. The only possible casualty is a few `resume-stale-imports` ticks returning 401 before promotion: harmless, the next tick catches up. The logs will show which behaviour applies.
- **Verify:**
  - no header and a random bearer get 401 on the apex;
  - the **next scheduled** `resume-stale-imports` writes a `JobRun` stamped `deploymentSha = <candidate>` (proof that the legitimate caller holds the new value);
  - **no manual job invocation**, so nothing financial runs just for testing.

### `ENCRYPTION_KEY`: no rotation, no replacement, no re-encryption

Proof it remains available to the candidate:
1. The shared record's metadata is unchanged (`updatedAt` 2026-06-16, targets include production), checked after every env edit.
2. The staged deployment boots (`validateEnv` requires it).
3. **The owner's TOTP login on the staged deployment decrypts a real Production `v2:` TOTP secret** (both users are enrolled). This is a non-destructive, end-to-end proof with no plaintext exposed.
4. Plaid tokens are covered by construction: same record, unchanged decrypt code and purpose label. No Plaid call is made to "test" them.

## 5. Ordered runbook (execution day, 08:00–11:30 UTC; pushes to `main`/`v2.6` frozen)

**Vercel facts this relies on:**
- An env change creates **no** build and does not touch a running deployment: every deployment keeps the env it was built with.
- `vercel deploy --prod --skip-domain` builds with Production env and **does not alias**.
- `vercel promote <url>` swaps the alias atomically, with no rebuild.
- Production cron only ever invokes the aliased deployment.

So the old app keeps serving with its old env until step 9. The only place the new code meets Production configuration before traffic is the unaliased staged deployment.

| Step | Action | Who | Mutates | Verify / stop condition |
|---|---|---|---|---|
| 0 | Preconditions (§6) all green | — | — | Any red ⇒ no-go |
| A1 | `pg_dump` Production over the session pooler to `backups/production-qirf…-pre-v26-<ts>.sql`; record sha256. Note the newest Supabase daily backup | Claude (owner-provided `tmp/prod-cutover/prod.env`) | Nothing | Dump restores in the clone (rehearsed). Sha recorded |
| A2 | Re-run `scratchpad/prod-preflight.sql` | Claude | Nothing | Must still show 88/0/0, preflight zeros, no `fm_*` |
| B | `npx prisma migrate deploy` (31) over the session pooler | Claude | **Schema** | 119 applied / 0 unfinished. Old app smoke still 200 (logged-out pages; owner page if signed in) |
| B′ | §5 checks of the Preview runbook | Claude | — | 4 `fm_*` roles, only `fm_backup` bypass. RLS on = forced = 56. Policy count = Preview's. PostgREST 0. Function ACLs = Preview's |
| B″ | `backfill-economic-date.ts` dry-run, then `--apply`; `audit:economic-date` | Claude | **Data (one column)** | Dry-run count ≈ 4,909 (minus event-linked); audit PASS |
| C | SCRAM role passwords; role timeouts (15 s × 3, `postgres` 30 s); pool size 15 → 12 | Owner pastes verifier SQL, or Claude via dashboard | **Roles / settings** | `psql select current_user` per role over `:6543`. Fresh backends show the timeouts |
| D | Vercel Production: `DATABASE_URL_APP/AUTH/SYSTEM`, then `FM_RLS_STRICT=true` | Claude (`vercel env add … production --sensitive`, piped from `roles.env`) | **Prod env** | Metadata only. Nothing rebuilds |
| E | `NEXTAUTH_SECRET`: owner unticks Production on the shared record; Claude adds the Production-only value | Owner + Claude | **Prod env** | Metadata: shared record now `preview` only. New record `production`. Preview `v2.6` override intact. **`ENCRYPTION_KEY` record unchanged** |
| F | `CRON_SECRET`: `vercel env update … production` | Claude | **Prod env** | Metadata. Watch for `resume-stale-imports` 401s (informational) |
| G | Clean `git worktree` at the candidate SHA (+ `.vercel/` link); `vercel deploy --prod --skip-domain` | Claude | New **unaliased** Production deployment S | Build OK. If boot refuses (strict/env), **no traffic impact**: fix env, rebuild S |
| G′ | Pre-traffic acceptance on S (its own URL; Vercel SSO). Owner signs in **with TOTP**. Then: `db-authority` 200 (all three roles, strict, no bypass, residue 0, 56/56); login gate (§4); live probes (§3.2); page smoke; DB health | Owner + Claude | Real login rows only | Any red ⇒ **stop**. Old app is still serving; S is discarded |
| H | `vercel promote S` | Claude | **Alias → S** | Apex serves S (`vercel inspect`) |
| I | Post-cutover acceptance (§7). Seed platform Spaces (`scripts/seed-platform-spaces.ts`; fingerprint: only platform rows change). Re-run the backfill (idempotent). Wait for the first `resume-stale-imports` `JobRun` on S | Claude + owner login | Platform Space row; `economicDate` | All §7 checks green |
| J | Watch the first dispatch slot on new code (12:00 `sync-crypto`), then 18:00, then **06:00 `sync-banks` (first Plaid calls by v2.6)** | Claude | — | `JobRun` succeeded; no 5xx; no lock waits |
| K | After acceptance: `git push origin <candidate>:main` (fast-forward; same SHA) | Claude | Production rebuild of the same SHA + env, auto-aliased | Re-run `db-authority` + smoke on the new alias target |

**Forbidden intermediate states, and why each cannot serve users:**
- **New code + owner DB:** the only new-code deployment before H is S, which is unaliased. In S, strict mode refuses to boot without valid role URLs.
- **New code + wrong secret set:** S is built after D–F, and is checked in G′ before H.
- **Old code + incompatible schema:** §2 shows none, provided the Merchant Ops seeding waits for step I.
- **Old code + new env:** the old deployment never re-reads env. An accidental `main` push is prevented by the freeze.

## 6. Preflight gates (all required before execution is authorised)

1. Candidate SHA fixed. Recommended: a **no-content merge of `origin/main` into `v2.6`** (tree must equal `dff2152b…`). That makes `main` fast-forwardable to exactly the tested SHA.
2. Exact-SHA GitHub CI green; clean-copy `npm run ci` green (**commit first**: it gates committed HEAD only).
3. Candidate deployed to Preview; signed-in smoke green.
4. **Plaid Sandbox provider acceptance on Preview, on the candidate** (§8 issue 1).
5. **Every scheduled job body exercised once on Preview** under the role topology (§8 issue 2). `sync-banks` only after (4).
6. **Clone rehearsal** green (§3.2): migrate 31, backfill, audits, `rls:accept` on Production's own rows.
7. **Staged-URL login rehearsed** on a Preview deployment URL (not the alias): the session lands on that host and does not bounce to `NEXTAUTH_URL`.
8. Owner confirms Production `DATABASE_URL` username form/host; role URLs composed in `tmp/prod-cutover/roles.env` and authenticated with `psql`.
9. Backup procedure rehearsed (the dump restores in the clone).
10. Strict-mode positive and negative controls: CI (`lib/db/strict-mode.test.ts`, 22 Production cases) plus the staged boot itself.
11. Re-run the Production preflight within an hour of B: no drift, no unexplained anomaly.

## 7. Post-cutover acceptance (pass/fail)

**AUTH**
- An old Production cookie gets refused (any pre-cutover browser lands on `/login`).
- Fresh login with TOTP: session + `LOGIN` audit.
- Wrong password: `LOGIN_FAILED(invalid_password)`.
- Logout: row revoked + `LOGOUT`.
- Revoke-all from a second browser: the first is signed out within about 30 s.
- `fm_auth` SELECT on `AuditLog` is denied.

**DATABASE AUTHORITY**
- `db-authority` 200: `fm_app`/`fm_auth`/`fm_system` each `actual` = self, `bypassRls` false, `ownedTables` 0, `memberOf` [], strict, `configProblems` [], `residueObserved` 0, RLS 56/56.
- `fm_backup` has no password (`rolpassword` null) and appears in no Vercel variable.
- Function ACLs match the migration.

**TENANT ISOLATION** (live probes, `BEGIN … ROLLBACK`)
- Owner cannot read or modify the other user's accounts or transactions.
- No identity ⇒ 0 rows.
- Platform Spaces are visible only via grants.
- Ordinary membership grants no `MERCHANT_OPS`.

**APPLICATION**
- Dashboard (overview / accounts / transactions tabs), Spaces, Connections (page load only, **no refresh**), settings and preferences: all 200 and rendering data.
- Logged-out `/` landing and `/login` as before.
- AI and Brief pages **not** exercised; no model calls.

**OPERATIONS**
- 0 `fm_*` idle-in-transaction sessions, 0 lock waits, 0 transactions older than 30 s.
- 5xx rate at or below the prior baseline.
- First `resume-stale-imports` `JobRun` on the candidate SHA.
- No manual job invocation.
- No Plaid call during the window (no `ProviderCall` rows timestamped inside it, until the scheduled 06:00).
- TOTP login (step G′) proves `ENCRYPTION_KEY`.

**MERCHANT OPS**
- `MERCHANT_OPS` enum present; the Merchant Operations Space is seeded with 0 members.
- The owner (no `MERCHANT_OPS` grant): `/merchant-ops` redirects; decide gets 403.
- No real merge is performed.

## 8. Issues found, classified

| # | Issue | Class |
|---|---|---|
| 1 | **v2.6's Plaid paths have never touched Plaid.** Preview provider acceptance is deferred, and Preview crons never ran. After promotion, Production runs v2.6 against **3 ACTIVE real Items**: webhook-triggered syncs at any time, and `sync-banks` at 06:00 | **BLOCKS CUTOVER** (recommended). The owner may downgrade it to an explicitly accepted risk. Fix: Preview → Plaid Sandbox, then link/sync/refresh/webhook/disconnect on the candidate |
| 2 | **No scheduled job has ever run in a deployed v2.6 environment** (0 `JobRun` rows on Preview, ever) | **FIX BEFORE CUTOVER.** Owner runs each non-Plaid job route once on Preview from a signed-in console with the Preview cron secret |
| 3 | `main` ≠ `v2.6` by one content-identical commit | **FIX BEFORE CUTOVER**: the no-content merge (§6.1) |
| 4 | Migrations and backfill never run on Production's real rows | **FIX BEFORE CUTOVER**: clone rehearsal |
| 5 | Staged-URL login (NextAuth with `NEXTAUTH_URL` = apex) is unproven | **FIX BEFORE CUTOVER**: rehearse on a Preview deployment URL |
| 6 | Production `DATABASE_URL` username form unknown (value is Sensitive) | **FIX BEFORE CUTOVER**: owner check; staged boot is the backstop |
| 7 | Vercel cron bearer source (deployment env vs project env) unknown | **SAFE TO DEFER**: the plan tolerates both; observe in step F |
| 8 | `ENCRYPTION_KEY` still shared with Preview | **SAFE TO DEFER** (launch debt; `environment-separation.md`). Not touched here |
| 9 | `OPENAI_API_KEY` shared project | **SAFE TO DEFER** |
| 10 | Merchant Ops Space must not be seeded while the old app serves | **FIX IN SEQUENCE**: step I only |
| 11 | `DISABLE_SYSTEM_ADMIN` value unknown; the admin account may be locked out | **SAFE TO DEFER**: the owner operates as `USER` with four WRITE grants |

## 9. Rollback and forward recovery

| After step | App rollback safe? | Schema rollback? | Recommendation |
|---|---|---|---|
| B (migrated, old app serving) | Nothing to roll back; the old app is unaffected (§2) | **No down migrations.** Do not hand-revert, and never `DISABLE ROW LEVEL SECURITY` | Fix forward. If something is wrong, restore A1 only for data corruption, which this set cannot cause |
| B″ (backfill) | n/a | One column, idempotent, derived. Restore from A1 only if the audit fails | Fix forward |
| C (passwords / settings) | n/a | Rotate role passwords at will. Settings via `ALTER ROLE … RESET` | Reversible |
| D–F (env) | The serving deployment is unaffected | n/a | Re-edit records. Re-tick Production on the shared `NEXTAUTH_SECRET` **only if aborting before H** |
| G/G′ (staged) | Discard S; nothing served it | n/a | Stop and diagnose; old Production continues |
| H (promoted) | **Technically** `vercel promote dpl_JcZ52…` restores the old app, and the old app does work on the new schema | n/a | **Avoid.** The old deployment carries the **old shared `NEXTAUTH_SECRET` baked in**, so it re-validates every pre-cutover cookie and reopens the forgeable-session defect (pre-P1). If Vercel's cron bearer comes from project env, its crons would 401. Use only for a **total outage**, and fix forward immediately |
| I/J (accepted) | As H | n/a | **Fix forward only.** For a role/RLS fault in a specific policy, the unit of fix is that policy, as a reviewed migration. For a strict/config fault, correct the env and redeploy |

**Emergency availability lever that keeps the security fixes.** Unset `FM_RLS_STRICT` and remove the three role URLs, then redeploy the **candidate**. The app returns to the `postgres` client while keeping P1, the new `NEXTAUTH_SECRET` and the new `CRON_SECRET`.

But on Production the candidate **refuses to boot without strict mode** (`dc3755f`), so this lever does not exist there. That is deliberate. The real levers are: fix the env, or (worst case) promote the old deployment for availability while a fix is prepared.

## 10. Owner decision sheet

1. **Candidate SHA:** the no-content merge of `origin/main` into `v2.6` (tree `dff2152b…`, equal to `d2869a2`'s). To be created and CI-gated. Fallback: `d2869a2` itself, with `main` reconciled afterwards.
2. **Pending migrations:** **31** (88 → 119).
3. **Expected downtime:** none planned. The alias switch is atomic; migrations cause seconds of lock waits for the old app.
4. **User-visible impact:**
   - every Production user is signed out once and signs in again with TOTP (2 users; 1 active in the last 30 days);
   - session cookie renamed to `__Host-`;
   - Merchant Ops appears as a platform area (no grants);
   - otherwise v2.6's product changes since 07-27.
5. **Every Production mutation:**
   - `pg_dump` (read; produces a local file);
   - 31 migrations;
   - `economicDate` backfill ×2;
   - three role passwords;
   - four role timeout settings;
   - pool size 15 → 12;
   - four new Production env records (three role URLs, `FM_RLS_STRICT`);
   - `NEXTAUTH_SECRET` split + new value;
   - `CRON_SECRET` new value;
   - one staged deployment;
   - one promote;
   - Merchant Operations Space seed;
   - later, a `main` fast-forward (Production rebuild).
6. **Irreversible or hard to reverse:**
   - the 31 migrations (roles, RLS, the NOT NULLs, the CHECK, the unique index, the enum value);
   - the forced sign-out;
   - `NEXTAUTH_SECRET` rotation (reverting would mean reusing a compromised-class value).
7. **Strategy:** staged-then-promote with pre-traffic acceptance. After promotion, **fix forward**. Re-promoting the old deployment is an availability-only last resort that reopens the session defect (§9).
8. **Plaid impact: NONE caused by the cutover.**
   - No env, secret, webhook or Item change.
   - No manual sync, refresh or dispatch.
   - The window avoids every scheduled Plaid slot.
   - The scheduled 06:00 `sync-banks` and inbound Plaid webhooks then run on v2.6 code. That is why §8 issue 1 is a blocker.
9. **`ENCRYPTION_KEY` impact: NONE.** The shared record is untouched; proven by a staged TOTP login.
10. **Go / No-Go: NO-GO today.** **GO once §6 gates 1–11 are green**, including §8 issues 1–6. Issue 1 can be downgraded by explicit owner risk acceptance.
11. **Authorisation needed, verbatim scope.** "Execute `docs/operations/production-cutover-plan.md` §5 steps A1–K on Production, in the 08:00–11:30 UTC window on `<date>`, with candidate `<SHA>`. Including:
    - migrations;
    - the `economicDate` backfill;
    - role passwords, role timeouts and pool size 12;
    - the four new env records;
    - the `NEXTAUTH_SECRET` split + rotation and the `CRON_SECRET` rotation;
    - the staged deploy, promote and Merchant Ops seed;
    - the `main` fast-forward.

    I will untick Production on the shared `NEXTAUTH_SECRET` record and provide `tmp/prod-cutover/prod.env`. No Plaid change, no `ENCRYPTION_KEY` change, no domain change."
