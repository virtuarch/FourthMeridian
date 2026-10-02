# POSTGRES / SUPABASE ROW LEVEL SECURITY — ARCHITECTURE INVESTIGATION

**Status:** INVESTIGATION ONLY — nothing implemented, nothing committed, no database mutated.
**Date:** 2026-10-01
**Scope:** `fourth-meridian-preview` + `fourth-meridian-production` (Supabase, VirtuArch org), and the `v2.6` repository.

**FINAL VERDICT: NOT READY.** See §40. The headline is not "RLS would be hard" — it is that **RLS enabled today would be a silent no-op in both environments**, and that the investigation found **one live P0 misconfiguration on preview that is unrelated to RLS and should be fixed on its own schedule** (§2.6, §36).

---

## 1. REPO BASELINE / HEAD / STATUS

| Item | Value |
|---|---|
| Branch | `v2.6` |
| HEAD at investigation start | `e750055` — *"S1-9a — DOGFOOD FIXES…"*, 2026-09-22 (matches the briefed baseline) |
| HEAD when the code was audited | **`6fbb601`** — docs-only commit on top of `e750055`, so **the audited code is byte-identical to `e750055`** |
| HEAD when this report was written | **`ef043cb`** — *"CRYPTO-LATCH-1/2 — THE PRICE ARCHIVE IS A PREREQUISITE OF VALUATION…"* |
| Worktrees | **One.** `/Users/chrstn/dev/FourthMeridian` only. No stale agent worktrees. |
| Remote | `origin` → `github.com/virtuarch/FourthMeridian`; `v2.6` was in sync with `origin/v2.6` at `e750055` |

### 1.1 ⚠️ A concurrent session is working in this tree

`ListAgents` shows a peer interactive session (`fourthmeridian-1b`, started ~47 min before this report) operating in the **same working directory**. During this investigation it:

- created commit `6fbb601` (docs-only: `docs/plans/CRYPTO-REFRESH-INCIDENT-2026-10-01.md`), and
- left these **uncommitted implementation changes** in the working tree:

```
 M lib/crypto/btc-sync.ts
 M lib/crypto/crypto-price-window.ts
 M lib/crypto/wallet-sync-dispatch.ts
 M lib/plaid/refresh-execution-types.ts
?? lib/crypto/crypto-close-coverage.ts
```

By the time this report was written the same session had advanced to `ef043cb` and the working tree held a further, different set of changes:

```
 M components/connections/ConnectionCard.tsx
 M components/dashboard/SyncWalletButton.tsx
 M lib/accounts/wallet-connection.ts
 M lib/connections/intelligence.ts
 M lib/connections/space-data.ts
 M lib/crypto/wallet-sync-dispatch.ts
 M prisma/schema.prisma                                      ← ⚠️ the schema is being edited
?? prisma/migrations/20261001120000_connection_facet_freshness/   ← ⚠️ a new migration
```

**None of this is mine.** This investigation created, modified, staged, committed, stashed and deleted **nothing**; the only file it writes is this document (untracked, uncommitted). The five untracked `docs/audits/status-drift/STATUS-DRIFT-AUDIT-2026-09-*.md` files were untouched, as instructed.

**Two consequences for this report:**

1. The code audited is `6fbb601` ≡ `e750055`, the briefed baseline. Everything in §5, §13–§17 and §28 is measured against that tree.
2. ⚠️ **`prisma/schema.prisma` is being modified and a new migration added by the concurrent session.** The model inventory in §15 (64 models) and the migration count in §1.2 (106 directories) are therefore **a snapshot, not a current count**. The *structural* conclusions are unaffected — ownership classes, the `SpaceAccountLink` many-to-many finding, and every Supabase fact are independent of a new facet-freshness table — but **the policy inventory must be regenerated against the final schema before any migration is authored**.

**Before any RLS work begins, that peer session's changes must land or be reverted.** An RLS rollout must not be interleaved with an unrelated in-flight repair, and §39 Slice 1 assumes a clean tree.

### 1.2 Migration state vs deployed

| Where | Migrations |
|---|---|
| `prisma/migrations/` on `v2.6` | **106** directories; newest `20260915180000_refresh_execution_source` |
| Preview DB | **88** applied, 0 unfinished, 0 rolled back; newest `20260727_v26pre_b4_btc_identity_backstop` |
| Production DB | **88** applied, 0 unfinished, 0 rolled back; newest `20260727_v26pre_b4_btc_identity_backstop` |

**18 `v2.6` migrations are undeployed in both environments** — expected, since `main` carries the v2.5.0 release and `v2.6` is in development. This matters for RLS: the deployed schema has **56** tables while the repo defines **64 models (65 local tables)**. Any policy migration authored against the repo schema will touch ~8 tables that do not yet exist in either hosted environment.

---

## 2. PREVIEW SUPABASE PROJECT CONFIGURATION

Project `fourth-meridian-preview` · ref `lqagrryecvhbaqvczjgc` · org VirtuArch (Pro) · region `ap-southeast-1` · compute **NANO**.
All facts below were read via the dashboard and **read-only** `SELECT` against system catalogs. Nothing was altered.

| Property | Value |
|---|---|
| PostgreSQL | **17.6** (aarch64-linux) |
| Schemas | `auth`, `extensions`, `graphql`, `graphql_public`, `public`, `realtime`, `storage`, `vault` |
| `public` tables | **56** |
| Table owner | **`postgres`** — all 56, uniformly |
| `relrowsecurity` | **false** — all 56 |
| `relforcerowsecurity` | **false** — all 56 |
| Policies (`pg_policy`, whole database) | **0** |
| Prisma migrations | 88 applied / 0 unfinished |
| Table-name-list MD5 | `12df0ef0295c97cae30d6235413742e1` |

### 2.1 Roles (15 non-`pg_*`)

| Role | super | **BYPASSRLS** | login | createrole |
|---|---|---|---|---|
| `anon` | f | f | f | f |
| `authenticated` | f | f | f | f |
| `authenticator` | f | f | **t** | f |
| `dashboard_user` | f | f | f | t |
| `pgbouncer` | f | f | **t** | f |
| **`postgres`** | f | **TRUE** | **t** | t |
| `service_role` | f | **TRUE** | f | f |
| `supabase_admin` | **t** | **TRUE** | **t** | t |
| `supabase_auth_admin` | f | f | t | t |
| `supabase_etl_admin` | f | **TRUE** | t | f |
| `supabase_privileged_role` | f | f | f | f |
| *(+ 4 further `supabase_*` service roles)* | | | | |

Role configs: `anon statement_timeout=3s`; `authenticated statement_timeout=8s`; `authenticator session_preload_libraries=supautils,safeupdate, statement_timeout=8s, lock_timeout=8s`; `postgres search_path="$user", public, extensions`.

### 2.2 Grants on `public` — **the preview finding**

```
anon          -> DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE  on 56 tables
authenticated -> DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE  on 56 tables
postgres      -> DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE  on 56 tables
service_role  -> DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE  on 56 tables
```

### 2.3 Data API exposure — preview

| Setting | Value |
|---|---|
| Data API | **Enabled** (integration installed, Primary Database) |
| Exposed schemas | **2 of 2 — `public`, `extensions`** |
| Exposed tables | **56 of 56** |
| "Automatically expose new tables" | **ON** |
| Max rows | 1000 |

### 2.4 Security Advisor — preview

**56 errors, 0 warnings, 0 info.** One error per `public` table — the signature of splinter's `rls_disabled_in_public` rule, which fires only for tables reachable through the Data API.

### 2.5 Supabase Auth

Not used by the application (see §13). The `auth` schema exists because Supabase provisions it.

### 2.6 🔴 P0 — Preview exposes every financial table to the `anon` role

The four facts above compose into a single live exposure:

1. All 56 tables are exposed through the Data API (PostgREST).
2. `anon` and `authenticated` hold **full DML** — `SELECT, INSERT, UPDATE, DELETE, TRUNCATE` — on all 56.
3. **RLS is disabled on every table and there are zero policies**, so nothing constrains those grants.
4. The database is reachable from **all IP addresses** (no network restrictions).

Anyone holding the preview project's **anon key** — a key Supabase treats as publishable and which is designed to be shipped to browsers — can read and write every row of preview's financial data over HTTPS, bypassing the Next.js application, NextAuth, every `requireSpaceRole` check, and every `where` clause in the codebase.

**Blast radius, measured:**

| Table | Rows |
|---|---|
| `User` | 4 — domains `gmail.com`, `fourthmeridian.com`, `na.com`, `testing.com` |
| `Space` | 12 |
| `FinancialAccount` | 35 |
| `Transaction` | 442 |
| **`PlaidItem`** | **10** — each carries `encryptedToken` (AES-256-GCM Plaid access tokens) |
| `SpaceSnapshot` | 86 |

This is **not** purely synthetic: one of the four accounts is a real `gmail.com` address, and 10 real Plaid credential rows are present. Ciphertext is not plaintext — `ENCRYPTION_KEY` is not in the database — but exfiltrating ciphertext plus `User.passwordHash`, `totpSecret`, `dateOfBirthEncrypted` and 442 real transactions is a material breach, and `TRUNCATE`/`DELETE` grants make it a destruction risk too.

**Root cause:** "Automatically expose new tables" is ON in preview. Supabase's `ALTER DEFAULT PRIVILEGES` then grants every newly-created table to `anon`/`authenticated` as migrations run. Production has the same toggle **OFF**, which is why it is clean.

**This is independent of the RLS programme and should not wait for it.** Remediation is a dashboard action plus a `REVOKE`; see §36 and §39 Slice 0.

---

## 3. PRODUCTION SUPABASE PROJECT CONFIGURATION

Project `fourth-meridian-production` · ref `qirfzvvaeddukjiphims` · org VirtuArch (Pro) · region `ap-southeast-1` · compute **MICRO**.

| Property | Value |
|---|---|
| PostgreSQL | **17.6** — identical to preview |
| Schemas | identical 8 |
| `public` tables | **56** |
| Table owner | **`postgres`** — all 56 |
| `relrowsecurity` / `relforcerowsecurity` | **false / false** — all 56 |
| Policies (whole database) | **0** |
| Prisma migrations | 88 applied / 0 unfinished / 0 rolled back |
| Table-name-list MD5 | `12df0ef0295c97cae30d6235413742e1` — **byte-identical to preview** |
| `auth.users` | **0** |
| `storage.objects` | **0** |
| App data | `User` 2 · `Transaction` 4,864 · `PlaidItem` 7 |

### 3.1 Roles (14 non-`pg_*`)

Same shape as preview except **`pgbouncer` is absent**. Critically:

| Role | super | **BYPASSRLS** | login |
|---|---|---|---|
| **`postgres`** | f | **TRUE** | **t** |
| `service_role` | f | **TRUE** | f |
| `supabase_admin` | **t** | **TRUE** | t |
| `supabase_etl_admin` | f | **TRUE** | t |
| `supabase_read_only_user` | f | **TRUE** | t |
| `anon`, `authenticated`, `authenticator`, `dashboard_user`, `supabase_auth_admin`, `supabase_privileged_role` | f | f | — |

### 3.2 Grants on `public` — production

```
postgres -> DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE  on 56 tables
```

**That is the complete list.** `anon`, `authenticated` and `service_role` hold **no privileges at all** on any application table.

### 3.3 Data API exposure — production

| Setting | Value |
|---|---|
| Data API | Enabled |
| Exposed schemas | 2 of 2 — `public`, `extensions` |
| Exposed tables | **0 of 56** |
| "Automatically expose new tables" | **OFF** |
| Max rows | 1000 |

### 3.4 Security Advisor — production

**0 errors, 0 warnings, 0 info.**

### 3.5 Connection pooling & network — production

| Setting | Value |
|---|---|
| Pooler | Shared (Supavisor); Dedicated available |
| Pool size | default **15** per user+db (Micro) |
| Max client connections | **200**, fixed at Micro |
| **Network restrictions** | **None — "Your database can be accessed by all IP addresses"** |
| SSL | "Enforce SSL on incoming connections" toggle present; certificate downloadable |

---

## 4. PREVIEW vs PRODUCTION DRIFT

| Dimension | Preview | Production | Drift? |
|---|---|---|---|
| PostgreSQL version | 17.6 | 17.6 | — |
| Region | ap-southeast-1 | ap-southeast-1 | — |
| Compute | NANO | MICRO | ⚠️ capacity only |
| Schemas exposed to API | public, extensions | public, extensions | — |
| `public` table count | 56 | 56 | — |
| Table-list MD5 | `12df0ef0…42e1` | `12df0ef0…42e1` | — **zero schema drift** |
| Table owner | `postgres` (all) | `postgres` (all) | — |
| RLS enabled | 0 tables | 0 tables | — |
| FORCE RLS | 0 tables | 0 tables | — |
| Policies | 0 | 0 | — |
| Migrations applied | 88 / 0 failed | 88 / 0 failed | — |
| `postgres` has BYPASSRLS | **yes** | **yes** | — |
| **Grants to `anon`/`authenticated`** | **FULL DML on 56 tables** | **none** | 🔴 **CRITICAL** |
| **Data API tables exposed** | **56 of 56** | **0 of 56** | 🔴 **CRITICAL** |
| **Auto-expose new tables** | **ON** | **OFF** | 🔴 **CRITICAL** |
| Security Advisor errors | **56** | **0** | 🔴 consequence of the above |
| Roles present | 15 (incl. `pgbouncer`) | 14 | ⚠️ cosmetic |
| Network restrictions | *(not separately read)* | none | ⚠️ |
| `auth.users` | *(unused)* | **0** | — |

**Drift that affects the proposed security boundary:** exactly one cluster — Data API exposure and the `anon`/`authenticated` grants that accompany it. **Everything the RLS design depends on (ownership, RLS flags, policies, roles, schema) is already identical**, which is the single most encouraging result in this investigation: the same policy migration will behave the same way in both environments.

**But the drift is also a trap for the rollout.** Preview's auto-expose toggle means that **a migration creating a new table grants it to `anon` in preview and not in production**. Any RLS rollout validated on preview is being validated against a *more* exposed configuration than production — which is the safe direction for testing, but means preview's "it works" does not prove production's grant posture, and vice versa. Fix the drift **before** using preview as the RLS proving ground (§39 Slice 0).

---

## 5. DATABASE CONNECTION MATRIX

`NEEDS PRIVILEGED ACCESS?` = would require an RLS bypass (separate role, `SECURITY DEFINER`, or `BYPASSRLS`) under the proposed architecture.

| CALLER / SURFACE | CONNECTION | ENV VAR | POOLED/DIRECT | ROLE TODAY | PURPOSE | CROSS-TENANT? | NEEDS PRIVILEGE? |
|---|---|---|---|---|---|---|---|
| **Web app runtime** — 168 API routes, 7 server pages, 279 modules importing `@/lib/db` | ONE module-global `PrismaClient` (`lib/db.ts:29-36`) | `DATABASE_URL` via `runtimeDatasourceUrl()` | **POOLED** — Supavisor `:6543 ?pgbouncer=true` | `postgres.<ref>` → `postgres` | all authenticated reads/writes | structurally yes (one client, all users) | **No — this is the surface that must run UNDER RLS** |
| Vercel cron → `/api/jobs/dispatch` | same singleton | `DATABASE_URL` | POOLED | `postgres` | scheduler fan-out | **yes** | **yes** — no user identity exists |
| Vercel cron → `/api/jobs/resume-stale-imports` (`*/5`) | same singleton | `DATABASE_URL` | POOLED | `postgres` | resume stalled Plaid imports | **yes** (self-documented unscoped fan-out) | **yes** |
| 5 fallback job routes (`sync-banks`, `fetch-fx-rates`, `fetch-security-prices`, `process-deletions`, …) | same singleton | `DATABASE_URL` | POOLED | `postgres` | per-job cron targets | **yes** | **yes** |
| Plaid webhook `/api/plaid/webhook` | same singleton | `DATABASE_URL` | POOLED | `postgres` | provider callback | **one global unique-index lookup**, then single-user | **yes, narrowly** |
| Admin `/api/admin/**` (15 files) | same singleton | `DATABASE_URL` | POOLED | `postgres` | operator console | **yes by design** | **yes** |
| Platform Ops `/api/platform/**` (49 files, 52 handlers) | same singleton | `DATABASE_URL` | POOLED | `postgres` | operator consoles | **yes by design** | **yes** |
| `/api/health` | singleton, `$queryRaw SELECT 1` | `DATABASE_URL` | POOLED | `postgres` | liveness | n/a | no |
| **60 `scripts/*.ts`** via `@/lib/db` | the singleton in a `tsx` process | `--env-file` / `dotenv -e` / **ambient shell** | pooled URL used directly | `postgres` | audits, repairs, backfills, harnesses | ~35 are cross-tenant | **yes** for those |
| **7 scripts with their own `new PrismaClient`** | own client | inherited `DATABASE_URL` | direct | `postgres` | `audit-ciphertext-versions`, `backfill-ai-agents`, `backfill-personal-sections`, `diagnose-invalid-plaid-tokens`, `run-reconstruction`, `db-guard`, `copy-fx-rates` | yes | **yes** — and they bypass `lib/db`'s guard, the pool normalisation, and any future `$extends` |
| `prisma/seed.ts` | own `new PrismaClient()` | `DATABASE_URL` | direct | `postgres` | CI + local seed (wipes first) | **yes — deletes all users** | **yes** |
| **`prisma migrate dev` / `deploy` / `reset`** | Migrate engine | **`DIRECT_URL`** | **DIRECT, session mode** | `postgres.<ref>` → `postgres` | DDL | n/a | **yes — owner/DDL** |
| `prisma studio` | Studio | `DATABASE_URL` | pooled | `postgres` | ad-hoc full table browse | **total** | **yes** — *no guard, no `--env-file`* |
| `prisma db seed` | seed's own client | `DATABASE_URL` | direct | `postgres` | seed | yes | **yes** — not fronted by `db-guard` |
| **`scripts/db-backup.ts`** | **`pg_dump` subprocess** | **`DIRECT_URL ?? DATABASE_URL`** | DIRECT | `postgres` | `.sql` into `backups/` | whole DB | **yes — see §27** |
| **`scripts/db-wipe.ts`** | **`psql` subprocess** | prefers **`DIRECT_URL`** | DIRECT | `postgres` | `DROP SCHEMA public CASCADE` | whole DB | **yes — DDL** |
| `npm run ci` throwaway Postgres | `docker run postgres:16`, random loopback port | synthesises **both** URLs | direct | container superuser | CI both jobs | n/a | container superuser |
| GitHub CI `architecture` job | `postgres:16` service container | both URLs → `localhost:5432/fintracker_ci` | direct | superuser | `migrate deploy` → `db seed` → `audit:ci` | n/a | superuser |
| GitHub CI `test` job | **none** | none | — | — | unit/typecheck/lint | n/a | no |
| `proxy.ts` (Next 16 middleware) | **none** | — | — | — | JWT page gate; matcher excludes `/api/*` | n/a | no |

### 5.1 The decisive connection facts

- **`DATABASE_URL` and `DIRECT_URL` differ only in host/port/pooling. The username is `postgres.<ref>` in BOTH.** There is no runtime/migration role split to build on; creating one is net-new work.
- `lib/db/connection-url.ts` forces `connection_limit=5` **in code**, deliberately, because production once ran at `connection_limit=1` and produced P2024 incidents under Vercel Fluid Compute. `pool_timeout` remains Prisma's default **10 s**, deliberately untuned.
- **No `node-postgres`.** Non-Prisma Postgres access is subprocess-only (`pg_dump`, `psql`, `pg_isready`).

---

## 6. ACTUAL ROLES AND PRIVILEGES

See §2.1 and §3.1. Summary of the three ways RLS is defeated today, which **stack**:

1. **`BYPASSRLS` attribute.** `postgres` (the application's role) has it in both environments. Unconditional exemption.
2. **Table ownership.** `postgres` owns all 56 tables. Owners are exempt from their own tables' policies *unless* `FORCE ROW LEVEL SECURITY` is set.
3. **Superuser.** `supabase_admin` is a superuser; exempt from everything.

Locally the same shape is worse: the dev role `fintracker` is `rolsuper = t` **and** `rolbypassrls = t` **and** owns all 65 tables — it is the container bootstrap superuser created by `docker-compose.yml`.

---

## 7. TABLE OWNERSHIP

**Uniform and simple: `postgres` owns all 56 `public` tables in both preview and production.** A single `GROUP BY owner, relrowsecurity, relforcerowsecurity` returns exactly one row in each environment. There are no mixed-ownership surprises, no tables owned by `supabase_admin`, and no per-table exceptions.

This is good news for the rollout: **one ownership change, applied uniformly, is sufficient** — there is no per-table archaeology to do first.

---

## 8. BYPASSRLS / SUPERUSER FINDINGS

| Environment | Role the app connects as | `rolsuper` | `rolbypassrls` | Owns the tables |
|---|---|---|---|---|
| Production | `postgres` (via `postgres.<ref>`) | false | **TRUE** | **yes** |
| Preview | `postgres` (via `postgres.<ref>`) | false | **TRUE** | **yes** |
| Local dev | `fintracker` | **TRUE** | **TRUE** | **yes** |

Other `BYPASSRLS` holders (both hosted environments): `service_role`, `supabase_admin` (also superuser), `supabase_etl_admin`, `supabase_read_only_user`.

**Conclusion:** `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY`, applied today, would be **completely inert** in all three environments — three independent bypasses, each sufficient on its own.

---

## 9. CURRENT RLS STATE

**Zero, everywhere.**

- `relrowsecurity = true`: **0 tables** (preview, production, local).
- `relforcerowsecurity = true`: **0 tables**.
- Grep of all 106 migration SQL files for `ENABLE ROW LEVEL`, `FORCE ROW`, `CREATE POLICY`, `CREATE ROLE`, `GRANT`, `REVOKE`, `current_setting`, `SET ROLE`: **no DDL hits**. The only matches are prose comments.

---

## 10. EXISTING POLICIES

**`pg_policy` is empty in both hosted databases — 0 rows across the entire database**, not merely in `public`. Supabase's own `storage` and `realtime` schemas also carry none (consistent with Storage and Realtime being unused: `storage.objects` = 0).

---

## 11. CURRENT GRANTS

See §2.2 and §3.2. Restated as the drift that matters:

| Grantee | Preview | Production |
|---|---|---|
| `postgres` | ALL on 56 | ALL on 56 |
| `anon` | **ALL on 56** | **none** |
| `authenticated` | **ALL on 56** | **none** |
| `service_role` | **ALL on 56** | **none** |

Note that even production's posture is not least-privilege for an RLS design: the single role `postgres` holds `TRUNCATE` and `REFERENCES` on every table and also owns them. The target architecture (§20) separates the owner from the runtime grantee.

---

## 12. DATA API EXPOSURE

| | Preview | Production |
|---|---|---|
| Data API enabled | yes | yes |
| Schemas exposed | `public`, `extensions` | `public`, `extensions` |
| Tables exposed | **56 / 56** | **0 / 56** |
| Auto-expose new tables | **ON** | **OFF** |
| Max rows | 1000 | 1000 |
| "Harden Data API" offered | yes | yes |

**Does Fourth Meridian need the Data API at all? No.** Nothing in the codebase imports `@supabase/supabase-js` or any Supabase client; the only occurrences of the word "Supabase" in source are two latency comments and the `schema.prisma` datasource note. All database access is server-side Prisma. The Data API is pure attack surface.

**Recommendation (independent of RLS):** disable the Data API on both projects, or — if the dashboard requires it to stay installed — set exposed schemas to none / use "Harden Data API" to move exposure to an empty custom schema, and `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated` plus `ALTER DEFAULT PRIVILEGES … REVOKE`. This removes an entire bypass class **before** RLS is designed, and makes `anon`/`authenticated` irrelevant to the policy model.

---

## 13. CURRENT AUTHENTICATION ARCHITECTURE

| Property | Finding |
|---|---|
| Framework | **NextAuth v4**, App Router catch-all (`app/api/auth/[...nextauth]/route.ts:25`) |
| Providers | **Exactly one** — `CredentialsProvider` (email/username + password + optional TOTP/recovery code), `lib/auth.ts:128-134` |
| Session strategy | **JWT, no database sessions** (`lib/auth.ts:681-684`), signed with `NEXTAUTH_SECRET` |
| **Supabase Auth** | **NOT USED.** No `@supabase/*` dependency; **`auth.users` = 0 rows in production**. Supabase is hosted Postgres only. |
| JWT claims | `id`, `email`, `name`, `username`, `role`, plus `sessionToken`, `requireTotpSetup`, `revocationIndeterminate` |
| **Space in the token** | **No.** The JWT carries no `spaceId` and no space role. Tenancy is resolved per request from a cookie + DB. |
| Revocation | Every `getServerSession` re-checks `UserSession.revokedAt` with a 30 s cache; three-valued, indeterminate ⇒ **503** |
| TOTP | Mandatory for `SYSTEM_ADMIN`; optional for users behind `REQUIRE_TOTP_ALL_USERS`; un-enrolled sessions denied by every API guard |
| `proxy.ts` | Redirects **page** navigations only; matcher is `/dashboard/*` + `/admin/*`, so **it never runs on `/api/*`** and is explicitly not the authorization boundary |

**Implication for RLS: Option A (`auth.uid()`) is unavailable.** `auth.uid()` reads a Supabase-issued JWT from a PostgREST request header. Fourth Meridian issues its own NextAuth JWT, never sends it to Postgres, and has zero rows in `auth.users`. Adopting `auth.uid()` would mean migrating the entire identity system to Supabase Auth — a far larger change than the RLS programme itself, and one that would not even help, because the connection is Prisma, not PostgREST.

---

## 14. CURRENT APPLICATION AUTHORIZATION ARCHITECTURE

```
request → NextAuth JWT → UserSession revocation check → user identity
        → requested Space (path param, or the non-HttpOnly `fintracker_space` cookie)
        → SpaceMember lookup (spaceId_userId, status=ACTIVE)
        → derived permissions / policy `can(action, ctx)`
        → Prisma query with a hand-written tenant predicate
```

### 14.1 Space resolution

`getSpaceContext()` (`lib/space.ts:154`, request-memoized) → cookie or `User.preferredSpaceId` → `resolveSpaceContext()` (`:168`), which validates against `SpaceMember` and, **on failure, falls back to the caller's PERSONAL Space by design** (`lib/space.ts:158-167`, `:192-202`, `:213-243`).

The fallback never returns another tenant's Space — but it **never reports that it substituted one**. Three callers close that by refusing a named-Space mismatch with 403 (`app/api/ai/chat/route.ts:117-119`; `app/api/ai/memory/handlers.ts:93`; `lib/ai/brief/view.ts:72`). The other 16 `getSpaceContext()` callers — **including import and transaction-correction write paths** — accept the substitution silently. Membership is enforced; *intent* is not.

### 14.2 Eight parallel authorization implementations

`requireSpaceRole` · `requireSpaceAction` + `can()` · `resolveSpaceContext` (falls back instead of denying) · `resolveImportableFinancialAccount` · `requireMerchantOpsMember` · `requirePlatformAccess` · inline per-route membership reads (5 routes) · **data-layer derived predicates** (the real read boundary).

**There is no Prisma middleware and no client extension** — `grep '$use(\|$extends' lib app` returns zero hits. Nothing enforces tenancy below the call site. `withApiHandler` is a try/catch 500 wrapper only.

### 14.3 The derived read predicate — the only thing scoping transactions

`bankingTransactionWhere(spaceId)` — `lib/data/banking-population.ts:165-190`:

```ts
financialAccount: {
  deletedAt: null,
  spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE,
                               visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } },
},
deletedAt: null,
```

Siblings: `transactionDetailWhere`, `resolveVisibleAccountIds`, `resolveFullVisibleAccountIds`, `getAccountsWithVisibility`.

### 14.4 Two orthogonal authorities

- **`SpaceMember`** (`spaceId` × `userId` × role × status) — customer tenancy. Roles `VIEWER < MEMBER < ADMIN < OWNER`; status `ACTIVE | REMOVED | LEFT` (rows are never deleted, so **every policy must filter `status='ACTIVE'`**).
- **`PlatformGrant`** (`userId` × `PlatformArea` × `READ < WRITE < CONTROL`) — operator access, **deliberately not Space-scoped**, plus a `SYSTEM_ADMIN` break-glass that performs no DB query and writes no audit row for the bypass itself.

---

## 15. COMPLETE TABLE OWNERSHIP CLASSIFICATION

64 models in `prisma/schema.prisma` (65 local tables incl. `_prisma_migrations`; 56 deployed). **`@@map` is extinct — model name == table name**, so every policy can be written against the quoted PascalCase identifier.

| Class | Count | Models |
|---|---|---|
| **A — SPACE-SCOPED (direct `spaceId`)** | 9 | `Space`, `AiAgent`, `SpaceMemory`, `SpaceGoal`, `SpaceDashboardSection`, `ImportMappingProfile`, `SpaceSnapshot`, `AiAdvice`, `SnapshotAmendment` |
| **A — SPACE-SCOPED (transitive)** | 14 | `FinancialAccount`, `DebtProfile`, `AccountConnection`, `ProviderAccountIdentity`, `Holding`, `PositionObservation`, `InvestmentEvent`, `InvestmentEventCoverage`, `Transaction`, `TransactionEvent`, `TransactionObservation`, `ImportBatch`, `GoalCheckIn`, `SnapshotAmendmentDay` |
| **B — USER-SCOPED** | 5 | `PlaidItem`, `Connection`, `CreditScore`, `Notification`, `NotificationPreference` |
| **C — SHARED / RELATIONAL** | 4 | `SpaceMember`, `PlatformGrant`, `SpaceInvite`, **`SpaceAccountLink`** |
| **D — GLOBAL REFERENCE** | 7 | `Instrument`, `InstrumentAlias`, `PriceObservation`, `CorporateActionTerms`, `FxRate`, `Merchant`, `MerchantAlias` |
| **E — SYSTEM / OPERATIONAL** | 15 | `AuditLog`, `AiInvocation`, `ApiUsageCounter`, `PlatformSetting`, `RateLimit`, `SyncIssue`, `SyncIssueOccurrence`, `JobRun`, `RefreshExecution`, `RefreshEndpointAccountCoverage`, `ProviderCall`, `RefreshEndpointResult`, `MerchantMergeDecision`, `ProviderCapabilityObservation`, `NotificationDelivery` |
| **F — SECURITY / AUTH** | 4 | `User`, `RecoveryCode`, `UserSession`, `BetaAccessRequest` |
| **G — DERIVED / CACHE** | 3 | `DailyBrief`, `PositionReconstruction`, `PositionCoverage` |
| **H — NEEDS REVIEW** | 3 | `DuplicateAccountCandidate`, `GoalContribution`, `MerchantRule` |

**38 of 64 models carry tenant data. 26 are tenant-less** — of which several nevertheless *contain* tenant content (§15.3).

**There are NO NextAuth tables.** `Account`, `Session`, `VerificationToken` do not exist. The nearest analogue is `UserSession`; reset/verification tokens are **columns on `User`**.

### 15.1 Per-table detail — the tables that decide the design

| MODEL | CLASS | DIRECT OWNER KEY | TRANSITIVE PATH | NULLABLE TENANT KEY? | VOLUME | INDEX ON OWNER KEY? |
|---|---|---|---|---|---|---|
| **`SpaceAccountLink`** | C — **the account↔Space authority** | `spaceId` + `financialAccountId`, both NOT NULL | — | no (provenance cols only) | 65 | ✅ unique `(spaceId,financialAccountId)`, `(spaceId,status)`, `(financialAccountId,status)` |
| `SpaceMember` | C | `spaceId` + `userId`, both NOT NULL | — | no | 16 | ✅ 5 indexes |
| **`FinancialAccount`** | A (transitive) | ⚠️ `ownerType` + `ownerUserId?` + `ownerSpaceId?` + `createdByUserId?` — **all nullable** | `id → SAL.financialAccountId → spaceId` (1 join) | **YES — all three** | 37 | ✅ |
| **`Transaction`** | A (transitive) | none | ⚠️ `financialAccountId?` → SAL → Space (2 joins) | **YES — the tenant FK is nullable** | **4,929 → 4,864 prod, unbounded** | ✅ 4 leading indexes (15 total, 101% of heap) |
| `TransactionEvent` | A (transitive) | none | `financialAccountId` (NOT NULL) → SAL | no | 4,723 | ✅ |
| `TransactionObservation` | A (transitive) | none | `eventId` → TE → FA → SAL (**3 joins**) *or* denormalized `financialAccountId` (NOT NULL, **no FK**) → SAL (1 join) | no, but unenforced | 4,833 | ✅ both paths |
| **`PositionObservation`** | A (transitive) | none | `financialAccountId` (NOT NULL) → SAL | no | **6,622** | ✅ 3 leading indexes |
| `Holding` | A (transitive) | none | ⚠️ `financialAccountId?` | **YES** | 40 | ✅ |
| **`SpaceSnapshot`** | A (direct) | **`spaceId` NOT NULL** | — | no | 1,742 | ✅ unique `(spaceId,date)` — **best-shaped table for RLS** |
| `SpaceMemory` | A + B | **`spaceId` AND `ownerUserId`, both REQUIRED** | — | no | 0 | ✅ composite — **the model RLS shape** |
| `DailyBrief` | G | `spaceId` + `ownerUserId`, both NOT NULL | — | no | 5 | ⚠️ only the composite unique |
| `PlaidItem` | B | `userId` NOT NULL | — | no | 13 / 7 prod | ✅ |
| **`AuditLog`** | E | ⚠️ `userId?` **and** `spaceId?`, both `SetNull` | — | **YES — measured 209/371 rows `spaceId IS NULL`; 3 rows have neither** | 371 | ✅ both leading |
| **`RefreshExecution`** | E | ⚠️ `plaidItemId?` and `sourceRef?` — **both nullable, both soft (no FK)** | — | **YES — 29/115 WALLET rows have `plaidItemId` NULL** | 115 | ⚠️ indexed but NULL for wallets |
| `RefreshEndpointResult` | E | none — `coveredAccountIds text[]`, no FK | `refreshExecutionId` → … | n/a | 418 | ❌ **no GIN index exists anywhere in the DB** |
| `ProviderCall` | E | none | `refreshExecutionId` → RE → nullable soft ref (3–4 joins) | n/a | 221 | ✅ for the hop only |
| `SyncIssue` | E | ⚠️ `plaidItemId?`, `financialAccountId?` — both soft | — | **YES — 29/45 rows NULL** | 45 | ✅ |
| `Notification` | B | `userId` NOT NULL; ⚠️ `spaceId?` | — | `spaceId` yes — 5/11 NULL | 11 | ✅ on `userId`; ❌ none leading `spaceId` |
| **`AiInvocation`** | E | **none, BY DESIGN** | **deliberately unreachable** | n/a | 396 | ❌ no tenancy column at all |
| `RateLimit` | E | **none** — the subject is embedded in `key` as text (`"user:ai-chat:<userId>"`) | unjoinable | n/a | high churn | ❌ unpolicyable without a schema change |
| `PriceObservation` | D | **none** — global | unreachable | n/a | **10,426 — largest table** | n/a |
| `Merchant` / `MerchantAlias` | D | **none** — global, globally-unique keys | unreachable | n/a | 1,316 each | n/a |
| `BetaAccessRequest` | F | **none** — `email` is the identity, subject has no `User` row yet | **no predicate can exist** | n/a | 0 | admin-only, protect by role |

### 15.2 🔴 The decisive structural fact — an account belongs to a SET of Spaces

Measured on the live dev database:

| ACTIVE Spaces per account | Accounts |
|---|---|
| 1 | 16 |
| 2 | **15** |
| 3 | **5** |
| 4 | **1** |

**21 of 37 accounts (57%) are ACTIVE-linked into two or more Spaces.** Per-Space transaction totals sum to 5,524 against 4,929 actual rows — 12% fan-out.

Further: `FinancialAccount.ownerSpaceId` is **vestigial — 0 of 37 rows populated**; `ownerType` is `USER` on 37/37. **The authoritative Space path is `SpaceAccountLink` where `status='ACTIVE'` and `FinancialAccount.deletedAt IS NULL`.**

**Therefore a denormalized `Transaction.spaceId` is not a shortcut — it is a cardinality error.** A single-valued column cannot represent a row that legitimately belongs to four tenants. Writing one would either duplicate rows or silently invent a primary Space. **Do not denormalize `spaceId` onto the account subtree.** (If a denormalization is ever wanted there, the correct column is `ownerUserId`, single-valued today — but §28 shows the measurements do not justify it.)

### 15.3 Tenant content sitting in tenant-less tables

RLS protects rows, not JSON interiors. These leak even with correct per-table policies:

| Table | Content |
|---|---|
| `SyncIssue.detail`, `SyncIssueOccurrence.detail` | `{ merchant, amount, date, balanceDelta, … }` — real merchant strings and amounts, on rows where **64% have no tenant key** |
| `MerchantAlias.sample` | one **raw bank descriptor** captured from some tenant's transaction, in a deployment-global table |
| `Merchant` (row set) | merchant *existence* is the union across all tenants → cross-tenant inference |
| `InvestmentEvent.importedRaw` | *"the complete original imported row"* as JSON |
| `ImportBatch.errorSummary` / `userDecisions` | raw uploaded-file content |
| `Notification.title` / `body` | tenant content behind a trust boundary **enforced by convention only** |
| `JobRun.summary` | doctrine says counts/IDs only — convention, not constraint |
| `AuditLog.metadata` | free-form JSON on rows where 56% have no `spaceId` |

### 15.4 Models needing review (class H)

- **`DuplicateAccountCandidate`** — `spaceId?` nullable **with no FK**; `accountAId`/`accountBId` point at two possibly-disjoint tenants. Open question: policy as `spaceId` equality (hides null rows from everyone), disjunction (discloses cross-tenant existence), or **conjunction** (safe; hides straddling pairs from both). Nothing reads this table today, so choose (iii) before a reader lands.
- **`GoalContribution`** — two independent non-nullable paths (`goalId → SpaceGoal.spaceId`, and `financialAccountId → SAL → Space`) that **can disagree**. A Space-A goal may contribute a Space-B-only account, and `SpaceGoal.currentAmount` is a denormalized sum — silently exporting a balance. Needs a write-time `CHECK`/trigger, not a read-time arbitration.
- **`MerchantRule`** — `ownerUserId?` **and** `spaceId?`, **neither with an FK**, with a third column `scope` declaring which should be set and nothing enforcing it. A tenant-less rule can reclassify another tenant's transactions via `Transaction.categoryRuleId`. Needs a `CHECK` + real FKs before any writer lands.

---

## 16. TRANSITIVE SPACE OWNERSHIP GRAPH

```
User ──┬── SpaceMember(status=ACTIVE) ──→ Space
       ├── PlatformGrant(area, status=ACTIVE) ──→ Space(platformArea)   [orthogonal authority]
       ├── PlaidItem        (credential — USER-owned, never Space-owned)
       └── Connection       (credential — USER-owned)

Space ──→ SpaceAccountLink(status=ACTIVE, visibilityLevel) ──→ FinancialAccount(deletedAt IS NULL)
                                                                  │   ⚠️ MANY-TO-MANY: 57% of accounts in 2–4 Spaces
                                                                  ├── Transaction ──→ TransactionEvent ──→ TransactionObservation
                                                                  ├── Holding / PositionObservation / InvestmentEvent
                                                                  ├── DebtProfile / AccountConnection / ProviderAccountIdentity
                                                                  └── ImportBatch / PositionCoverage / PositionReconstruction

Space ──→ SpaceSnapshot · SpaceGoal → GoalCheckIn · SpaceMemory(+ownerUserId) · DailyBrief(+ownerUserId)
          · AiAgent → AiAdvice · SpaceDashboardSection · ImportMappingProfile · SnapshotAmendment → SnapshotAmendmentDay
```

**Canonical predicate for the account subtree** (the single most important expression in this document):

```sql
EXISTS (
  SELECT 1
  FROM   "SpaceAccountLink" sal
  JOIN   "SpaceMember"      sm ON sm."spaceId" = sal."spaceId"
  WHERE  sal."financialAccountId" = <row>."financialAccountId"
    AND  sal.status  = 'ACTIVE'
    AND  sm."userId" = current_fm_user_id()
    AND  sm.status   = 'ACTIVE'
)
```

Hop counts to `Space` (add 1 more to reach the user): most account-descended tables = **2 joins** (`X.financialAccountId → SAL → Space`; the `FinancialAccount` hop is skippable except for the `deletedAt` filter). Worst cases at **3–4 joins**: `TransactionObservation` via `eventId` (mitigated by its denormalized `financialAccountId`), `ProviderCall`, `RefreshEndpointResult`, `SyncIssueOccurrence`.

**Four platform Spaces** (`Space.platformArea` non-null) have **zero `SpaceMember` rows** and are reachable only via `PlatformGrant`. A membership-only policy hides them from everyone — the policy set must include a `PlatformGrant` arm.

---

## 17. CURRENT SECURITY BOUNDARY

**Entirely application-level. The database contributes nothing.**

What prevents User A reading User B's Space: four mechanisms in series — NextAuth JWT + live `UserSession`; a `SpaceMember` lookup; `SpaceAccountLink` with sufficient `visibilityLevel`; and the hand-written derived row predicate.

What prevents User A *writing* into User B's Space: the first two, then one of **five mutually-irreconcilable write-authority shapes** (space role / account ownership compared after a bare-id fetch / the import composite guard / **visibility alone** / link-adder identity).

### 17.1 Where security rests on an application predicate alone

1. **🚩 `GET /api/users/search` — the predicate is simply absent.** `app/api/users/search/route.ts:21,30-33` runs `spaceMember.findMany({ where: { spaceId, status: ACTIVE } })` for a `spaceId` taken straight from `searchParams.get("exclude")`, under `requireUser()` only, with **no check that the caller is a member**. The roster is not returned directly but is a differential oracle: query with and without `&exclude=<victimSpaceId>` and a disappearing hit proves membership. **This is a real, present IDOR-shaped defect, and it is exactly what RLS on `SpaceMember` would close with no code change.**
2. **Every row of `Transaction`, `Holding`, `PositionObservation`, `InvestmentEvent`, `DebtProfile`, `ImportBatch`** — no tenant column; scoped only by the two-hop fragment composed correctly at ~20 call sites.
3. **81 exported library functions accept `spaceId` (or `spaceIds[]`) as authority and none verifies membership.** Sharpest: `getSpaceNetWorthSummaries(spaceIds)` → `db.space.findMany({ where: { id: { in: spaceIds } } })` — **no tenant predicate at all**. The security property is "the caller built the array right."
4. **Fourteen routes fetch by bare id and compare afterwards.** All correctly guarded today; all place the row in process memory before authorization. `app/api/spaces/[id]/route.ts:37-46` is the starkest — it loads other members' **email addresses** before the membership check at `:65`, then strips them in JS.
5. **Three check-then-act mutations by bare id** (TOCTOU, not IDOR).
6. **The tenant of a write is a non-HttpOnly cookie, and an unreachable one is substituted rather than refused.**
7. **Two write-authority shapes have already drifted** from the authority they claim to mirror (`imports/[id]/rollback` omits the FULL-tier gate; `transactions/[id]/correct` authorizes a durable write on visibility alone).
8. **Destructive primitives with no guard of their own** — `lib/accounts/disconnect.ts:40-70` re-verifies nothing.
9. **Raw SQL that is tenant-blind by construction** — `lib/investments/holding-ownership.ts`, `lib/prices/ownership-window.ts` interpolate `Prisma.join(accountIds)` with no owner predicate inside the statement; `lib/ai/brief/watermark.ts:117-135` deliberately widens **past** the Space.
10. **`CRON_SECRET` is a bearer credential for unrestricted cross-tenant mutation**, compared with `!==` rather than `timingSafeEqual` (it does fail closed when unset, which is correct).

**No test pins tenancy.** `lib/security-surface.test.ts` covers rate limiting, boot behaviour and `/api/health` only. There is no test that would fail if a tenant predicate were removed from a route whose bare-id fetch is covered only by a following `if`.

---

## 18. PROPOSED IDENTITY PROPAGATION ARCHITECTURE

### 18.1 Options assessed against the actual stack

| Option | Verdict | Why |
|---|---|---|
| **A — Supabase Auth / `auth.uid()`** | ❌ **Rejected** | Auth is NextAuth with its own JWT; `auth.users` = 0 rows in production; no `@supabase/*` dependency; the connection is Prisma, not PostgREST, so no JWT ever reaches Postgres. Adopting it means replacing the entire identity system and still would not work over Prisma. |
| **C — Database roles per tenant** | ❌ **Rejected** | Would require a Postgres role per user, `SET ROLE` per request, and role management on signup. Supavisor transaction pooling makes `SET ROLE` as unsafe as any other session state, and the role count is unbounded. |
| **D — Separate connection per tenant** | ❌ **Rejected** | Max client connections is **fixed at 200** on Micro; the app already runs one pooled client at `connection_limit=5` under Fluid Compute. |
| **B — Trusted PostgreSQL session context via `SET LOCAL`** | ✅ **The only viable option** | Application-controlled GUC (`app.user_id`), set transaction-locally, read by policies through a `STABLE` helper function. |

### 18.2 The design — and the hazard it must prove it avoids

**The failure to avoid:** request A sets `app.user_id = A`; the connection returns to the pool; request B inherits A's identity.

**Why `SET LOCAL` is sound and plain `SET` is not.** Production `DATABASE_URL` is the Supabase **Transaction Pooler** (`:6543`, `pgbouncer=true`). In transaction pooling mode the server connection is handed back **after every transaction**. A session-level `SET app.user_id` therefore survives into whichever tenant borrows the connection next — a cross-tenant disclosure, not merely a bug. `SET LOCAL` is scoped to the enclosing transaction and is discarded at `COMMIT` **and at `ROLLBACK`**, which also answers the "failed transaction leaks context" case (test 18 in §29).

**The required shape:**

```sql
BEGIN;
  SET LOCAL app.user_id = '<userId>';
  -- the tenant-scoped statements
COMMIT;
```

**Therefore every tenant-scoped database access must run inside an interactive Prisma transaction.** This is the architecture's central cost, and the codebase is not shaped for it today:

| Fact | Count |
|---|---|
| Interactive `$transaction(async (tx) => …)` call sites — **RLS-compatible** | **40** |
| **Batch-array `$transaction([…])` call sites — cannot carry `SET LOCAL`** | **19** (16 in product paths; 11 of those are auth / 2FA / session / admin-grant surfaces) |
| `$extends` anywhere in the repo | **0** |
| `$use` in any product module | **0** (one query spy in a check harness) |
| Plain `findMany`/`findUnique` outside any transaction | the overwhelming majority of all reads |

**Measured cost of the wrapper** (200 statements, loopback — a floor, not a ceiling):

| Pattern | 200 statements | Per statement |
|---|---|---|
| Plain autocommit `SELECT 1` | 0.537 s | 2.7 ms |
| `BEGIN; SET LOCAL app.user_id=…; SELECT 1; COMMIT;` | 1.015 s | **5.1 ms** |

**+2.4 ms per query on loopback for 3 extra round trips. Over the Supabase pooler (1–5 ms RTT) expect +5–15 ms per query.**

### 18.3 The interception point that must be built

A `$extends({ query: { $allOperations } })` client extension on `lib/db.ts:31` is the only single place a per-request `SET LOCAL` could live. It does not exist and is greenfield.

**A hard constraint against "wrap everything in a transaction":** `lib/platform/incidents/lifecycle.ts:77-138` names `$transaction` in its client type **precisely so a `Prisma.TransactionClient` cannot be substituted**, and refuses at runtime when the client lacks it. **Five tests assert the incident lifecycle must not open transactions.** The extension must therefore be opt-out-able, and the incident path must run on a non-tenant connection.

**Secondary risks of universal transaction-wrapping:**
- Connections are held for the whole transaction rather than per statement, against `connection_limit=5` and an untuned 10 s `pool_timeout` — reopening the exact P2024 exposure `lib/db/connection-url.ts` exists to close.
- Long read transactions hold snapshots and inhibit vacuum.

### 18.4 The helper function

```sql
CREATE FUNCTION current_fm_user_id() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('app.user_id', true) $$;
```

`STABLE` matters: PostgreSQL then treats the value as constant within a statement, which is what lets it hash/materialize the membership set once per query (§28).

**Fail-closed requirement:** `current_setting(..., true)` returns NULL when unset, and `NULL = anything` is NULL, so a policy comparing against it **denies by default**. That is the correct direction — but it means a missing context variable produces **silent empty result sets**, indistinguishable from "no data" anywhere in this codebase. §32 addresses this.

---

## 19. PRISMA / POOLING SAFETY ANALYSIS

| Question | Finding |
|---|---|
| Pooling mode | Supabase Supavisor, **transaction mode**, port 6543, `pgbouncer=true` (production `DATABASE_URL`) |
| Pool size | **15** server connections per user+db (Micro default); **200** max client connections, fixed |
| Prisma client | **One** module-global singleton, cached on `globalThis` outside production |
| `connection_limit` | forced to **5** in code (`lib/db/connection-url.ts:79`), replacing any URL value |
| `pool_timeout` | **never set** — Prisma default 10 s, deliberately untuned |
| Serverless concurrency | Vercel **Fluid Compute is enabled** — many concurrent requests share one Node process and therefore one Prisma pool |
| Prepared statements | `pgbouncer=true` tells Prisma to disable prepared statements; no code depends on them |
| Nested transactions | none found; no `isolationLevel` or `maxWait` is set anywhere; only 5 harness sites pass any options (`timeout`) |
| Background workers | all run through the same singleton; cron has **no user identity at all** |

**Is `SET LOCAL` compatible? Yes — but only inside an interactive transaction, and only if every tenant path is converted.** The 19 batch-array sites must be rewritten as interactive callbacks or routed to a non-tenant connection first.

**How to prove isolation (not assume it) — see §29 tests 16–18.** The proof must be empirical: concurrent Alice/Bob load against a pool deliberately smaller than the concurrency, asserting no cross-contamination, plus a test that a `ROLLBACK` leaves no residue on the recycled connection.

---

## 20. PROPOSED ROLE ARCHITECTURE

Derived from actual system needs, not convention.

| Role | Attributes | Owns tables? | Used by | Subject to RLS? |
|---|---|---|---|---|
| **`fm_owner`** (migration/DDL) | `NOBYPASSRLS`, no superuser; owns the schema | **yes** | `prisma migrate deploy` via **`DIRECT_URL`** only | exempt **only if `FORCE RLS` is off** — so **`FORCE RLS` must be ON** (§25) |
| **`fm_app`** (runtime) | `NOBYPASSRLS`, **not** an owner, `LOGIN`, least grants (`SELECT, INSERT, UPDATE, DELETE` on protected tables; no `TRUNCATE`, no `REFERENCES`) | no | the web app via **`DATABASE_URL`** (pooler) | **YES — the whole point** |
| **`fm_system`** (background) | `NOBYPASSRLS`, not an owner; **additional policies** keyed on a `app.system = 'on'` GUC, or a small set of `SECURITY DEFINER` functions | no | cron jobs, Plaid webhook item lookup, price ingestion, notification sweeps | **yes, but with system-arm policies** — *not* `BYPASSRLS` |
| **`fm_operator`** (Platform Ops / admin) | `NOBYPASSRLS`, not an owner; policies with a `PlatformGrant`-derived arm, or `BYPASSRLS` **only if §26 proves the policy arm infeasible** | no | the 65 operator routes, on a **second Prisma client** | yes, via operator-arm policies |
| **`fm_backup`** | **`BYPASSRLS`** — unavoidable (§27) | no | `pg_dump` only, never from application code | no — enumerated bypass |

**Minimum viable split is three roles** (`fm_owner`, `fm_app`, `fm_system`); `fm_operator` can start as `fm_system` and be separated later; `fm_backup` is mandatory from day one or backups break.

**Two consequences to design around:**

1. **`DATABASE_URL` and `DIRECT_URL` would no longer authenticate as the same principal.** `lib/db/target-identity.ts` keys database identity on host/port/project-ref/database and **ignores the username**, so `mutationAuthority`'s `SAME` verdict still holds — but its stated premise ("the same database") should be re-examined and the comment updated. **Do not weaken this guard** to accommodate the change.
2. **Supabase's `postgres` role cannot be the runtime role** and cannot be stripped of `BYPASSRLS` (it is platform-managed). The new roles must be created by migration and the Vercel `DATABASE_URL` re-pointed at `fm_app`.

---

## 21–24. PROPOSED POLICY SEMANTICS

`USING` controls which existing rows are visible/eligible. `WITH CHECK` controls rows being written or the post-image of an update. **Both are required** — cross-Space *writes* are as important as cross-Space reads, and a `USING`-only policy permits inserting rows you then cannot see.

Define once:

```sql
-- the set of Spaces the current identity may act in
CREATE FUNCTION fm_visible_space_ids() RETURNS SETOF text LANGUAGE sql STABLE AS $$
  SELECT "spaceId" FROM "SpaceMember"
   WHERE "userId" = current_fm_user_id() AND status = 'ACTIVE'
$$;
```

### 21. SELECT

| Class | `USING` |
|---|---|
| **A direct** (`spaceId`) | `"spaceId" IN (SELECT fm_visible_space_ids())` |
| **A direct + owner** (`SpaceMemory`, `DailyBrief`) | `"spaceId" IN (…) AND "ownerUserId" = current_fm_user_id()` — ⚠️ **`spaceId` alone is insufficient: a shared household Space holds two people's private rows** |
| **A transitive** (account subtree) | the canonical `EXISTS` of §16 — **correlated, not flattened** (§28) |
| **B user-scoped** | `"userId" = current_fm_user_id()` |
| **C `SpaceMember`** | `"spaceId" IN (…)` — closes the `/api/users/search` oracle |
| **C `SpaceInvite`** | `"spaceId" IN (…) **OR** "invitedUserId" = current_fm_user_id()` — the invitee is **not yet a member**, so a membership-only policy breaks invites |
| **D global reference** | permissive `USING (true)`, or leave RLS off — a predicate here is pure cost on the largest table in the database (`PriceObservation`, 10,426 rows, no tenant) |
| **E system / F auth / G derived** | per §26 — mostly **revoked from `fm_app` entirely**, not policied |
| **`AuditLog`** | `("userId" = current_fm_user_id() OR "spaceId" IN (…))` **plus an operator arm** — 56% of rows have no `spaceId` and 3 have neither key, so a `spaceId`-only policy makes the majority of the forensic log unreachable by everyone |
| **Platform Spaces** | add `OR EXISTS (SELECT 1 FROM "PlatformGrant" g WHERE g."userId" = current_fm_user_id() AND g.status='ACTIVE' AND g.area = s."platformArea")` — otherwise the 4 member-less platform Spaces vanish |

### 22. INSERT

`WITH CHECK` only (no `USING`). **This is what stops a cross-Space write.**

- **A direct:** `WITH CHECK ("spaceId" IN (SELECT fm_visible_space_ids()))` — and for write-gated resources, require role ≥ the action's minimum by joining `SpaceMember.role`.
- **A transitive:** `WITH CHECK (<the canonical EXISTS on the NEW row's financialAccountId>)` — this is what makes "Alice inserts a transaction into Bob's account" fail (test 5).
- **B:** `WITH CHECK ("userId" = current_fm_user_id())`.
- ⚠️ **`Transaction.financialAccountId` and `Holding.financialAccountId` are NULLABLE.** A NULL makes the `EXISTS` evaluate FALSE, so a `WITH CHECK` would reject the insert. 0 NULL rows exist today — **add a `NOT NULL` constraint (or a `CHECK`) before enabling, or the policy changes behaviour for a shape the schema still permits.**
- `BetaAccessRequest` needs an explicit anonymous-insert policy or exemption — `POST /api/access-request` is unauthenticated and has no tenant.
- `AuditLog` needs a **permissive INSERT** policy: 90 independent writers, and `buildAuditData` has **no `spaceId` parameter at all**.

### 23. UPDATE

**Both clauses, and they must differ.**

- `USING` = the SELECT predicate (you may only update rows you can see).
- `WITH CHECK` = the INSERT predicate evaluated on the **post-image**.

**This asymmetry is precisely what prevents a row being moved across an ownership boundary** (test 6): Alice can see her own transaction (`USING` passes) but repointing its `financialAccountId` at Bob's account fails `WITH CHECK`. A `USING`-only policy would permit the move.

Same treatment for `SpaceAccountLink.spaceId`, `SpaceMemory.ownerUserId`, `Notification.userId` and every other tenant key: **a tenant key must never be updatable to a value outside the caller's visible set.** Consider additionally making tenant keys immutable by trigger — defence in depth, and cheaper to reason about.

### 24. DELETE

- `USING` = the SELECT predicate, **narrowed by role**: deletes on Space-scoped resources should require `SpaceMember.role >= ADMIN` (mirroring `lib/spaces/policy.ts`), not mere visibility.
- Most product deletes are **soft** (`deletedAt`), i.e. UPDATEs — so the UPDATE policy governs them. Genuine hard deletes are rare and concentrated in purge/admin paths that belong to `fm_system`/`fm_operator`.
- `SpaceMember` and `SpaceAccountLink` rows are **never deleted** (status flips), so DELETE on those can be denied to `fm_app` outright.

### 24.1 What RLS does NOT subsume

`SpaceAccountLink.visibilityLevel` (`PRIVATE | BALANCE_ONLY | SUMMARY_ONLY | SHARED | FULL`) is a **column-level redaction tier**. RLS is row-level all-or-nothing. A policy that returned the right *rows* would still not be the privacy boundary — `lib/account-privacy.ts` and the five privacy tests remain authoritative.

**Decision required (§38 Q1): should the policies include `visibilityLevel` or only tenancy?** Recommendation: **tenancy only.** A policy that reproduces product semantics creates two authorities for one question and will drift. RLS should answer "is this row in a Space I belong to", and the application continues to answer "how much of it may I see".

---

## 25. FORCE ROW LEVEL SECURITY — RECOMMENDATION

**Yes. `FORCE ROW LEVEL SECURITY` on every protected table, without exception.**

Reasoning: under §20 the schema owner is `fm_owner`, and **a table owner is exempt from its own table's policies unless `FORCE` is set**. Migrations run as `fm_owner` — so without `FORCE`, any `prisma migrate deploy` or a mistakenly-pointed script running on `DIRECT_URL` operates with no policies at all. `FORCE` closes that.

`ENABLE` alone is insufficient; `ENABLE` + `FORCE` + a non-owner, non-`BYPASSRLS` runtime role is the minimum combination that makes a policy mean anything.

### 25.1 Complete bypass enumeration — *"if we cannot enumerate them, the design is not ready"*

Under the proposed architecture, the exhaustive list of principals that can read a protected row without satisfying a policy:

| # | Bypass | Why it exists | Containment |
|---|---|---|---|
| 1 | `supabase_admin` (superuser) | Supabase platform-managed; cannot be removed | Dashboard/SQL-editor access only; governed by Supabase account access + MFA |
| 2 | `postgres` (`BYPASSRLS`, platform-managed) | Supabase provisions it; cannot be stripped | **Must stop being the application role.** Reserve for break-glass; its credential is the Supabase DB password |
| 3 | `service_role` (`BYPASSRLS`) | Supabase default | **Revoke all grants on `public`** (already true in production); never issue the key |
| 4 | `supabase_etl_admin`, `supabase_read_only_user` (`BYPASSRLS`) | platform-managed | Not used by the app; covered by Supabase account access |
| 5 | **`fm_backup`** (`BYPASSRLS`) | `pg_dump` must see every row (§27) | Credential used **only** by the backup script; never in Vercel env |
| 6 | `fm_owner` during migrations | owner | **Closed by `FORCE RLS`** |
| 7 | `fm_system` / `fm_operator` system-arm policies | legitimate cross-tenant work (§26) | **Policy arms, not `BYPASSRLS`** — auditable in `pg_policies` |
| 8 | `SECURITY DEFINER` functions, if used | narrow privileged lookups | Each one enumerated, `search_path` pinned, reviewed |
| 9 | **`DROP SCHEMA public CASCADE`** (`scripts/db-wipe.ts:307`) | destroys policies, ownership and grants, leaving a schema with RLS *disabled* | Already behind 5 gates; must additionally re-create the role/grant/policy setup |
| 10 | **A restore from `backups/`** | `pg_dump --no-owner --no-privileges` carries neither ownership nor grants (§27) | Must be fixed before relying on RLS |

That is ten paths, all named. Items 5, 9 and 10 are the ones that make the design *not yet ready*.

---

## 26. CONTROLLED SYSTEM / BACKGROUND BYPASS DESIGN

Principle: **do not give the web application `BYPASSRLS` because one worker needs cross-tenant reach.** Classify each operation A (run under a tenant context) / B (controlled privileged role) / C (bypass) / D (redesign).

### 26.1 Genuinely essential cross-tenancy — six sites only

| Site | Why it cannot be per-tenant | Disposition |
|---|---|---|
| **`app/api/plaid/webhook/route.ts:83`** | A webhook carries a Plaid `item_id` and nothing else. Resolving it to a tenant **is** the global unique-index lookup. Everything after is single-user. | **B** — a single `SECURITY DEFINER` function `fm_resolve_plaid_item(text) RETURNS text`, then `SET LOCAL app.user_id` for the rest. **The cleanest "bypass exactly one lookup" case in the system.** |
| **`jobs/fetch-security-prices.ts:61`** | Work list = union of all tenants' `PositionObservation`; one vendor call per instrument serves every holder; `PriceObservation`'s unique key has no tenant dimension. | **B** — `fm_system` reads `PositionObservation` via a system-arm policy; `PriceObservation`/`Instrument` are class D (no policy) |
| **`lib/prices/capability-reconciliation.ts:71`** | "Which accounts does a widened entitlement deepen?" is platform-wide by definition | **B** |
| **`lib/crypto/wallet-snapshot-scope.ts:25`** | A re-quote must find every holder of the asset | **B** |
| **`lib/transactions/merchant-write.ts:87` + `merchant-merge.ts:292-341`** | `canonicalKey`/`aliasKey` are **globally unique**; a merge rewrites `Transaction.merchantId` and deletes `MerchantRule` across all tenants | **D — redesign.** A Space-`MEMBER` authorization producing a deployment-wide effect is an authorization defect independent of RLS |
| **The 65 operator console routes** | Cross-tenant visibility *is* the product; authorization is by `PlatformGrant` area, never Space membership | **B** — `fm_operator` on a **second Prisma client**, with the grant decision lifted into the session (`SET LOCAL app.platform_area`) so it is visible to policy |

### 26.2 Incidental cross-tenancy — convert to per-tenant loops (A)

All four big sweeps **already contain a clean sequential per-item loop**; a per-iteration `SET LOCAL` drops in without restructuring:

| Sweep | Unscoped query | Loop boundary | Per-iteration tenant |
|---|---|---|---|
| wallet refresh | `lib/crypto/wallet-refresh.ts:146` | `:221` | one `FinancialAccount` |
| bank sync | `jobs/sync-banks.ts:164` | `:203` | one `PlaidItem` → one User |
| stale imports | `jobs/resume-stale-imports.ts:138` | `:195` | one `PlaidItem` → one User |
| snapshot regen | `regenerate.ts:305` / `regenerate-history.ts:1405` | `:320+` / `:1406` | one Space |

Plus `backfill-flowtype`, `backfill-merchant-intelligence`, `backfill-economic-date`, `run-reconstruction` — all mechanically scopeable (`run-reconstruction` already has `--account`).

**The only semantic loss** is global ordering fairness (oldest-success-first, `WALLET_SWEEP_BUDGET_MS`) and the once-per-dispatch `admitOperationalWork` calls. Those three queries can stay on `fm_system`.

`jobs/resume-stale-imports.ts:78-89` records a **real cross-tenant accident**: an unscoped run overwrote two unrelated connections' Plaid cursors. That is exactly the harm this work prevents.

### 26.3 Cannot be per-tenant without O(users) queries — keep on `fm_system` (B)

`jobs/retry-notifications.ts:143`, `lib/notifications/cleanup.ts:96`, `jobs/sweep-rate-limits.ts:37`, `lib/security/anomaly-alerts.ts:132-176`, `jobs/process-deletions.ts:26-29`.

Note `lib/account-deletion/purge.ts` legitimately touches **other** tenants' rows (SAL revocation, canonical-connection re-election) — a strict single-tenant context would break it.

### 26.4 Tables to REVOKE from `fm_app` rather than policy

The `RefreshExecution` family (`RefreshExecution`, `RefreshEndpointResult`, `RefreshEndpointAccountCoverage`, `ProviderCall`) and the `SyncIssue` family are **operator-facing forensic ledgers with deliberate soft, nullable references so they survive deletion of what they observed**. A tenant-keyed policy breaks exactly when the parent is gone — the case the soft ref exists to handle. Add `AiInvocation` (deliberately un-tenanted as a **privacy decision**), `JobRun`, `PlatformSetting`, `ApiUsageCounter`, `RateLimit` (tenancy lives inside an opaque `key` string).

**Revoking these from the runtime role is stronger and simpler than retrofitting tenancy onto them.**

---

## 27. MIGRATION / BACKUP / ADMIN BEHAVIOUR

### 27.1 Migrations

- **Vercel does not run `prisma migrate deploy`.** The build command is `prisma generate && next build`. Production migrations are applied **by hand from a developer machine** with both URLs exported. A deploy and its migration can land in either order, minutes or days apart.
- **For an RLS rollout this is a correctness hazard, not merely an inconvenience.** If the policy migration lands before the code that sets `app.user_id`, every protected table returns **zero rows silently** — and this codebase has **no "RLS denied" signal anywhere**; empty is indistinguishable from "no data".
- CI applies migrations correctly (`migrate deploy` against a throwaway `postgres:16`) — but **as the container superuser, so CI would never exercise a policy** even after RLS lands. This must be fixed or the 22 REQUIRED audits become a false green.
- `db-guard` / `target-identity` / `live-guard` must be **preserved unchanged**. The only adjustment is the comment noting that the two URLs now differ in principal (§20).

### 27.2 🔴 Backups — the second blocker

`scripts/db-backup.ts:47` runs:

```
pg_dump --no-owner --no-privileges -f <out> <url>
```

Three problems, each sufficient to break recovery:

1. **`pg_dump` is an ordinary client and RLS applies to it.** Today the role is superuser so the dump is complete. Under `FORCE RLS` with a non-`BYPASSRLS` role, `pg_dump` either **fails** ("query would be affected by row-level security policy") or, with `--enable-row-security`, **silently produces a partial dump**.
2. **The only completeness check is `> 100 bytes`** — which a partial dump passes.
3. **`--no-owner --no-privileges` discards exactly the state RLS depends on.** A restore would recreate tables owned by the restoring role with no grants and (depending on the dump) no policies — i.e. **a restored database with tenant isolation silently absent**.

Already-recorded pitfalls that compound this: **pg_dump 18 → PG 16** emits `SET transaction_timeout = 0;` which PG16 rejects (documented workaround: filter that line), and **no restore drill has ever been performed on this project** — the dump is the only recovery path that exists.

**Prerequisite: the backup must move to the `fm_backup` role (`BYPASSRLS`), drop `--no-owner --no-privileges` or pair the dump with an explicit role/grant/policy bootstrap, add a real completeness assertion (per-table row counts, not a byte floor), and a restore drill must actually be run.** This is non-negotiable before RLS is enabled in production.

### 27.3 Admin / destructive tooling

- `prisma studio` and `prisma db seed` are **unguarded** and run as the owner — under RLS they would bypass policies via ownership unless `FORCE` is set (it will be).
- `scripts/db-wipe.ts` does `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` — destroying policies, ownership and grants and leaving a schema with RLS *disabled*. The script must be extended to re-apply the security bootstrap, or it becomes a silent isolation-removal tool.
- **The 7 own-client scripts** (`backfill-ai-agents`, `backfill-personal-sections`, `run-reconstruction`, `diagnose-invalid-plaid-tokens`, `audit-ciphertext-versions`, `db-guard`, `copy-fx-rates`) plus `prisma/seed.ts` and two test harnesses **skip `lib/db`'s guard, the pool normalisation, and any future `$extends` context setter**. `lib/db-safety.test.ts` keeps the set closed, but its globs are one level deep (`scripts/ai-baseline/**` and `lib/*/**` are outside the check). **Widen those globs as part of the programme.**
- **Env-handling risk is inverted relative to write risk:** every read-only `audit:*` script passes `--env-file=.env.local`, while **every write-heavy cross-tenant backfill runs bare**, taking whatever `DATABASE_URL` is ambient.

---

## 28. PERFORMANCE / INDEX ANALYSIS

Measured on the local dev DB (PG 16.14) with `EXPLAIN (ANALYZE, BUFFERS)`, read-only, no `ANALYZE` run. Absolute timings are not predictive at this scale; **plan shapes and buffer ratios are.**

### 28.1 Row counts (largest first)

| Table | Rows | Notes |
|---|---|---|
| `PriceObservation` | **10,426** | **no tenant** — must be exempt |
| `PositionObservation` | 6,622 | `financialAccountId` |
| **`Transaction`** | 4,929 | **15 indexes, 101% of heap** |
| `TransactionObservation` | 4,833 | |
| `TransactionEvent` | 4,723 | |
| `SpaceSnapshot` | 1,742 | direct `spaceId` |
| `Merchant` / `MerchantAlias` | 1,316 each | global |
| `RefreshEndpointResult` | 418 | `text[]`, no GIN index |
| `AiInvocation` | 396 | no tenant |
| `AuditLog` | 371 | 56% `spaceId` NULL |
| `SpaceMember` | **16** | 8 kB heap — the membership table is tiny |

### 28.2 Does every high-volume table have the index the predicate needs? **Yes.**

Every one of the top six has a **leading index on its tenancy-path column** (`financialAccountId` or `spaceId`). `Transaction` has four such indexes. This is the single most encouraging result in Part 2.

Exceptions: `AiInvocation` (no tenancy column, by design), `RefreshEndpointResult` (`coveredAccountIds text[]` — **there are zero GIN indexes in the entire database**, so an `&&` predicate would seq-scan), `RefreshExecution` (`plaidItemId` indexed but **NULL for all 29 WALLET rows**), `Notification` (no index leading `spaceId` — use `userId`).

### 28.3 Measured plan deltas

| Query | Baseline | + simulated RLS | Delta |
|---|---|---|---|
| **Q1** Transaction page, authorized user (`ORDER BY date DESC LIMIT 50`) | cost 199, 1.291 ms, 23 buffers | cost 317, **0.785 ms**, 22 buffers | cost +59%, **time and buffers unchanged**; the `SpaceAccountLink × SpaceMember` subplan was **`never executed`** |
| **Q2** `GROUP BY category, SUM(amount)` over 180 d | cost 304, 2.087 ms, 130 buffers | cost 328, **1.477 ms**, 429 buffers | cost +8%, **faster** — the predicate flipped the plan to a nested loop over the 13 visible accounts |
| **Q4** `PositionObservation` (6,622 rows) | cost 267, 18.489 ms, 93 buffers | cost 325, **6.231 ms**, 105 buffers | **12 buffers to tenancy-check 6,622 rows**; Memoize **99.91%** hit rate |
| **Q5** `SpaceSnapshot` (direct `spaceId`) | cost 65, 1.044 ms, 153 buffers | cost 70, **0.298 ms**, 154 buffers | cost +8.7%, **+1 buffer**; membership `Materialize`d once and rescanned 400× |
| **Q8** `TransactionEvent` | — | Memoize 98.2%, 47 buffers for the check | — |
| **Q9** `AuditLog` | — | planner **inverted the join**, driving from `SpaceMember` (7 rows) into `AuditLog_spaceId_createdAt_idx` | ideal shape — but needs a `Sort`, so "newest N across all my Spaces" is no longer one ordered scan |

### 28.4 The three findings that shape the design

**(1) PostgreSQL hoists the membership lookup — confirmed three ways.** `hashed SubPlan` (the `SpaceAccountLink × SpaceMember` set hashed **once per query**, 3 buffers); `Materialize` once (`loops=400` / `loops=1000000` wrapping a scan at `actual rows=1 loops=1`); `Memoize` on the correlated `FinancialAccount` probe (**98–99.9%** hit rates). This works because `current_setting(text, bool)` is **STABLE**. **Measured per-query tenancy cost: 3–12 shared buffers, independent of result-set size.**

**At 1,000,000 synthetic rows the entire tenancy evaluation collapsed to a single 157 ms `Materialize` computed once, then rescanned a million times.** The predicate is **O(visible accounts), not O(rows)** — confirmed three orders of magnitude above the real data.

**(2) 🔴 The one real hazard: scan amplification ≈ 1 / visibility_fraction on `ORDER BY … LIMIT`.** When the tenancy predicate *rejects* rows, `LIMIT` can no longer short-circuit:

| Visible fraction | Index rows scanned to fill LIMIT 50 | Buffers |
|---|---|---|
| 92.9% | 50 | 13 → 22 |
| 7.1% | **527 (10.5×)** | **13 → 335 (25.8×)** |
| 2.0% | ~50× | — |
| 0.0% | full scan | — |

**Conclusion: RLS must be a backstop *behind* the application's existing account/Space filters, never a replacement for them.** The existing `where` clauses stay.

**(3) Prefer the correlated `EXISTS`; flattening is 4× slower.** Rewriting the policy as `financialAccountId IN (owned ∪ shared)` **defeated** `Transaction_date_idx`'s ordered scan and forced a top-N sort over 930 rows — 3.345 ms vs 0.785 ms.

### 28.5 Which tables need a denormalized tenancy column?

**Not the account subtree.** The 16 tables reached via `financialAccountId` are **fine as-is**: they already have the index, the measured cost is +8% to +59% estimated with 0–12 extra buffers, and — decisively — **a `spaceId` column there would be WRONG, not merely redundant**, because 57% of accounts live in 2–4 Spaces (§15.2).

**Genuinely problematic (6 tables):** `RefreshExecution`, `RefreshEndpointResult`, `ProviderCall`, `SyncIssueOccurrence`, `SnapshotAmendmentDay`, `NotificationDelivery`. **Recommended disposition: revoke from `fm_app` (§26.4), not denormalize.**

---

## 29. EXACT ADVERSARIAL RLS TEST MATRIX

The suite must test the **database security boundary**, not application middleware — i.e. it must issue SQL as `fm_app` with a `SET LOCAL app.user_id`, bypassing every route handler.

**Fixtures:** Alice, Bob, Carol. Alice Space (A), Bob Space (B), Shared Space (S) with Alice as `OWNER` and Bob as `VIEWER`. An account `ACCT_SHARED` ACTIVE-linked into both A and S (exercising the 57% multi-Space case). A platform Space P with no members and a `PlatformGrant` to Carol. Transactions, holdings, snapshots, memories and audit rows in each.

| # | Case | Expected |
|---|---|---|
| 1 | Alice reads an Alice transaction | **allowed** |
| 2 | Alice reads a Bob transaction | **0 rows** (invisible, not an error) |
| 3 | **Alice issues `SELECT * FROM "Transaction"` with NO predicate at all** | returns **only** Alice-visible rows; Bob's count = 0 |
| 4 | Alice supplies Bob's known transaction id by primary key | **0 rows** — no existence oracle |
| 5 | Alice `INSERT`s a transaction with `financialAccountId` = a Bob account | **rejected by `WITH CHECK`** |
| 6 | Alice `UPDATE`s her own row, repointing `financialAccountId` at a Bob account | **rejected by `WITH CHECK`** (while `USING` passes — proves the asymmetry) |
| 7 | Alice `UPDATE`s a Bob row | **0 rows affected** |
| 8 | Alice `DELETE`s a Bob row | **0 rows affected** |
| 9 | Bob reads Alice's `SpaceMemory` **in the shared Space S** | **0 rows** — proves `spaceId` alone is insufficient; `ownerUserId` must be in the policy |
| 10 | User-private records (`PlaidItem`, `Connection`, `CreditScore`, `RecoveryCode`, `UserSession`, `NotificationPreference`) cross-user | **0 rows** |
| 11 | Shared Space S: Bob (`VIEWER`) reads S resources | **allowed**; Bob attempts an ADMIN-gated write in S → **rejected** |
| 11b | `ACCT_SHARED` is visible from **both** A and S to the right members and from neither to Bob-in-B | **passes** — the multi-Space case |
| 11c | A `SpaceMember` row flipped to `status='REMOVED'` immediately loses visibility | **0 rows** — proves the `status='ACTIVE'` filter |
| 12 | Global reference (`PriceObservation`, `Instrument`, `FxRate`, `Merchant`) readable by all | **allowed, intentionally** |
| 13 | `fm_system` performs the Plaid webhook item lookup, the price work-list read, the notification sweep | **allowed**; the same role reading an unrelated tenant's `Transaction` → **denied** |
| 14 | `fm_owner` applies a migration; **`FORCE RLS` means it is still subject to policy** on DML | **passes** |
| 15 | **`SELECT rolbypassrls FROM pg_roles WHERE rolname='fm_app'` is `false`**, and `fm_app` is not the owner of any protected table | **asserted in CI** |
| 16 | **Pool identity cannot bleed.** N≫pool_size concurrent Alice/Bob transactions on one Prisma client; every result set is asserted against the issuing identity | **zero contamination** |
| 17 | Concurrent Alice/Bob requests through the real route handlers remain isolated | **passes** |
| 18 | **A transaction that `ROLLBACK`s leaves no `app.user_id` residue** — next transaction on the same connection with no `SET LOCAL` sees **0 rows**, not the previous tenant's | **passes (fail-closed)** |
| 19 | Direct `psql` as `fm_app` (no application code) still respects RLS | **passes** |
| 20 | **An application query with its tenant predicate deliberately deleted** (e.g. `bankingTransactionWhere` stubbed to `{}`) returns only the caller's rows | **passes — the headline acceptance test** |
| 21 | `GET /api/users/search?exclude=<Bob space>` as Alice no longer discloses membership | **the existing IDOR closes with no route change** |
| 22 | A row with `financialAccountId IS NULL` (if the column stays nullable) | **documented behaviour** — currently invisible to everyone |
| 23 | `AuditLog` rows with `spaceId IS NULL` remain readable by their `userId` and by `fm_operator` | **passes** |
| 24 | Platform Space P is visible to Carol via `PlatformGrant` and to nobody else | **passes** |
| 25 | **`pg_dump` as `fm_backup` produces a dump whose per-table row counts equal the live counts** | **passes — guards §27.2** |

Tests 3, 16, 18, 20 and 25 are the ones that distinguish a real boundary from a checkbox. **Test 20 is the acceptance criterion named in the brief.**

---

## 30. PREVIEW ROLLOUT PLAN

Nothing here is executed now.

0. **Fix the preview Data API exposure first** (§36 P0). Validating RLS against a database that is simultaneously wide open to `anon` proves nothing.
1. Land the peer session's crypto work or revert it; start from a clean tree.
2. Commit the role + policy architecture **as Prisma migrations containing hand-written SQL**. Policies must be in source control; **preview and production must never depend on separately hand-created dashboard policies.**
3. Build the identity channel: the `$extends` context setter, convert the 19 batch-array `$transaction` sites, and route the incident lifecycle and operator consoles to non-tenant clients.
4. Create `fm_owner` / `fm_app` / `fm_system` / `fm_backup` in preview by migration; re-point preview's Vercel `DATABASE_URL` at `fm_app`, leave `DIRECT_URL` on the owner.
5. Enable `ENABLE` + `FORCE` RLS and the policies on a **small first slice** (§39 Slice 3), not all 56 tables.
6. Run the §29 acceptance suite against preview.
7. Run the full `npm run ci` — **after** fixing CI to run as a non-bypass role, or the 22 REQUIRED audits are a false green (§27.1).
8. Exercise the real preview application end to end; exercise ingestion and every scheduled job.
9. Inspect policy failures and `EXPLAIN` the top queries for the amplification of §28.4(2).
10. **Prove the bypass list of §25.1 empirically**, one test per row.
11. Run a **restore drill** from an `fm_backup` dump into a scratch database and verify row counts and policy presence.
12. Widen to the remaining slices, repeating 6–11.

## 31. PRODUCTION ROLLOUT PLAN

13. Production preflight: confirm preview/production drift is zero on roles, ownership, grants, RLS flags and policies (the §4 table, re-run).
14. **Back up production** with the fixed backup path, and verify the dump by row count.
15. Apply the **exact reviewed migration** — same file, same order. Remember **Vercel does not run `migrate deploy`**; sequence the manual migration and the deploy deliberately, **migration last** if the code tolerates policies-absent, or **migration first** only after confirming the code sets `app.user_id` in the already-deployed build.
16. Re-point production `DATABASE_URL` to `fm_app` (Vercel env change → redeploy).
17. Production smoke tests; watch for empty-result-set symptoms (§32).
18. Adversarial isolation tests using **safe fixtures** (two scratch users, scratch Space, scratch transactions, torn down after) — never against the two real users.
19. Monitor: query latency, P2024 rate, Supavisor client connections, error rates, and a new "policy denied / empty where rows expected" signal.

## 32. ROLLBACK / FAILURE PLAN

**Fail-closed vs fail-open.** A broken policy that denies legitimate access is **operationally bad but safe**. A rollback that removes tenant isolation is **security-critical**. The two must not share a lever.

**The specific danger:** `current_setting('app.user_id', true)` returns NULL when unset, so a missing context makes every policy deny — producing **silent empty result sets** that this codebase cannot distinguish from "no data" anywhere. The app would appear to work and show nothing.

**Mitigations, in order of preference:**

1. **A loud failure instead of a quiet one.** Make the helper `current_fm_user_id()` **raise** when the GUC is unset on a connection that is supposed to be tenant-scoped, rather than returning NULL. A 500 is better than a plausible-looking empty dashboard.
2. **A kill switch that is not `DISABLE ROW LEVEL SECURITY`.** Ship a `PlatformSetting`-style flag that routes the runtime connection back to the owner URL (`DIRECT_URL`/`fm_owner`) **for a bounded window**, logged and alerted. This restores availability in one action without dropping policies, and leaves the policies in place and auditable.
3. **Per-slice rollback.** Because the rollout is sliced (§39), the rollback unit is one slice's `ALTER TABLE … DISABLE ROW LEVEL SECURITY` on a handful of named tables — reviewed and committed **in advance** as a migration, not typed into a dashboard at 3am.
4. **Never `DISABLE ROW LEVEL SECURITY` across the board.** If that is ever the only option, it is an incident requiring the application to be taken offline, not a routine recovery.
5. **Monitoring that distinguishes the two failure modes:** alert on a rise in zero-row responses from endpoints that historically return rows, separately from error-rate alerts.

---

## 33. EXPECTED APPLICATION CHANGES

| Change | Scale |
|---|---|
| `$extends({ query: { $allOperations } })` context setter on `lib/db.ts` | new, ~1 file |
| A request-scoped identity carrier (`AsyncLocalStorage`) feeding it | new, ~1 file |
| Convert **19** batch-array `$transaction` sites to interactive callbacks | 19 sites, 11 of them auth/2FA/session/admin |
| A **second Prisma client** for `fm_system` (jobs, webhook) and a **third** for `fm_operator` | new |
| Route the incident lifecycle off the tenant client (it must not open transactions — 5 tests pin this) | targeted |
| Convert 4 unscoped sweeps to per-tenant loops with per-iteration `SET LOCAL` | 4 loops, already shaped for it |
| Add `--space`/`--account` to ~8 cross-tenant scripts | mechanical |
| Widen `lib/db-safety.test.ts` globs to cover `scripts/ai-baseline/**` and `lib/*/**` | 1 test |
| Fix `GET /api/users/search` (do not rely on RLS alone) | 1 route |
| Redesign `merchant-ops/decide` authorization (Space-MEMBER → deployment-wide effect) | 1 route + engine |
| Add a "policy denied / unexpected empty" observability signal | cross-cutting |

## 34. EXPECTED MIGRATION CHANGES

Hand-written SQL inside Prisma migrations (Prisma cannot express policies; there is no `relationMode`/`previewFeatures` in play):

1. `CREATE ROLE fm_owner / fm_app / fm_system / fm_operator / fm_backup` with explicit `NOBYPASSRLS` where required.
2. `ALTER TABLE … OWNER TO fm_owner` for all protected tables; `REASSIGN OWNED`.
3. `GRANT`/`REVOKE` least privilege per role; `ALTER DEFAULT PRIVILEGES` so future tables inherit correctly.
4. `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role` + matching `ALTER DEFAULT PRIVILEGES … REVOKE` (fixes the preview drift permanently and in source control).
5. `CREATE FUNCTION current_fm_user_id()` (STABLE) and `fm_visible_space_ids()`.
6. Constraint hardening **before** policies: `Transaction.financialAccountId` and `Holding.financialAccountId` NOT NULL (or CHECK); `MerchantRule` scope/key `CHECK` + FKs; `GoalContribution` same-Space `CHECK`.
7. `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + **`FORCE ROW LEVEL SECURITY`**, per slice.
8. `CREATE POLICY` per table per command (SELECT / INSERT / UPDATE / DELETE), per §21–24.
9. Any `SECURITY DEFINER` helpers (e.g. `fm_resolve_plaid_item`) with pinned `search_path`.
10. A reviewed, committed **down-migration per slice**.

## 35. EXPECTED SUPABASE CONFIGURATION CHANGES

| Change | Preview | Production |
|---|---|---|
| Turn **OFF** "Automatically expose new tables" | **required (P0)** | already off |
| Set exposed tables to 0 / disable the Data API / "Harden Data API" | **required (P0)** | recommended |
| `REVOKE` `anon`/`authenticated`/`service_role` grants (also done in migration) | **required (P0)** | already clean |
| Add `DATABASE_URL` pointing at `fm_app` (Vercel env) | required | required |
| Keep `DIRECT_URL` on the owner | required | required |
| Add network restrictions (allowlist Vercel egress) | recommended | **recommended — currently all IPs** |
| Verify "Enforce SSL on incoming connections" is ON | verify | verify |
| Consider raising pool size from 15 if transaction-wrapping increases hold time | monitor | monitor |

---

## 36. RISKS RANKED

### P0

| # | Risk | Evidence |
|---|---|---|
| **P0-1** | **Preview exposes all 56 tables (incl. 10 Plaid credential rows, 442 transactions, a real user) to the `anon` role with full DML, RLS disabled, 0 policies, and no IP restrictions.** Anyone with the preview anon key owns that database. | §2.6 |
| **P0-2** | **The application's database role has `BYPASSRLS` and owns every table in both environments.** Any RLS enabled today is a silent no-op — a checkbox that creates false assurance. | §8 |
| **P0-3** | **Backups break or silently truncate under RLS**, `--no-owner --no-privileges` discards the security state, the completeness check is "> 100 bytes", and **no restore drill has ever been run**. | §27.2 |
| **P0-4** | **A missing `app.user_id` yields silent empty result sets**, indistinguishable from "no data" anywhere in the codebase. A half-deployed rollout looks healthy and shows nothing. | §32 |

### P1

| # | Risk |
|---|---|
| P1-1 | **No identity channel exists**: no `$extends`/`$use`, 19 batch-array transactions, and most reads are outside any transaction. This is the largest piece of net-new work. |
| P1-2 | **Migrations are applied by hand, out of band from the deploy** — the policy migration and the code that sets the context can land in either order. |
| P1-3 | **CI runs as a container superuser**, so the 22 REQUIRED audits would never exercise a policy — a false green after RLS lands. |
| P1-4 | **`GET /api/users/search` is a live Space-membership oracle** today (independent of RLS). |
| P1-5 | **Scan amplification ≈ 1/visibility** on `ORDER BY … LIMIT` if RLS is ever treated as a replacement for the application's filters (measured 25.8× buffers at 7% visibility). |
| P1-6 | **`merchant-ops/decide`**: Space-`MEMBER` authorization producing deployment-wide `Transaction` rewrites and other users' `MerchantRule` deletions. No RLS predicate can fix this; it needs an authorization redesign. |
| P1-7 | **`Transaction.financialAccountId` and `Holding.financialAccountId` are nullable** — a NULL row becomes invisible to everyone and un-insertable under `WITH CHECK`. |
| P1-8 | **Transaction-wrapping every read** reopens the P2024 exposure that `connection_limit=5` exists to close, against an untuned 10 s `pool_timeout`. |
| P1-9 | **Production has no network restrictions** (all IPs) and the DB password is the only barrier on the direct port. |

### P2

| # | Risk |
|---|---|
| P2-1 | `AuditLog` — 56% of rows have no `spaceId`, 3 have neither key; a naive policy hides the majority of the forensic log from everyone. |
| P2-2 | `RefreshExecution` family and `SyncIssue` family carry deliberate soft, nullable refs; 29/115 wallet rows have no tenant path at all. |
| P2-3 | `RefreshEndpointResult.coveredAccountIds text[]` with **zero GIN indexes in the database**. |
| P2-4 | `RateLimit` encodes the subject inside an opaque `key` string — unpolicyable without a schema change. |
| P2-5 | `AiInvocation` is deliberately un-tenanted as a **privacy decision**; adding a tenant column to satisfy RLS would reverse it. |
| P2-6 | Tenant content inside tenant-less tables (`SyncIssue.detail`, `MerchantAlias.sample`, `JobRun.summary`) — RLS protects rows, not JSON interiors. |
| P2-7 | `db-wipe.ts`'s `DROP SCHEMA public CASCADE` silently removes the entire security bootstrap. |
| P2-8 | 7 own-client scripts + seed + 2 harnesses bypass `lib/db` and any future context setter; the safety test's globs are one level deep. |
| P2-9 | Class-H ambiguity (`DuplicateAccountCandidate`, `GoalContribution`, `MerchantRule`) must be resolved before policies are written. |
| P2-10 | `visibilityLevel` is a column-level tier RLS cannot express — two authorities for one question if conflated. |

---

## 37. BLOCKERS

Each of these must be cleared before RLS can be *enabled*, not merely designed:

1. **The runtime role bypasses RLS and owns the tables.** → `fm_app` + `FORCE RLS` (§20, §25).
2. **No identity propagation mechanism exists**, and the transaction shape to carry one is absent from most of the codebase (§18.2, §18.3).
3. **Backups and restore are incompatible with RLS as configured, and have never been drilled** (§27.2).
4. **CI cannot exercise policies** because it runs as a superuser (§27.1).
5. **Preview's Data API exposure** makes preview useless as a security proving ground until fixed (§2.6).
6. **A concurrent session holds uncommitted implementation changes in this working tree** (§1.1).

---

## 38. OPEN DESIGN QUESTIONS

1. **Should policies encode `visibilityLevel`, or tenancy only?** Recommendation: **tenancy only** (§24.1).
2. **Operator access: `BYPASSRLS` role, or policy arms keyed on a `PlatformGrant` GUC?** The latter is auditable in `pg_policies` and preferable; it requires lifting the grant decision into the session.
3. **`AuditLog`:** who may read the 56% of rows with no `spaceId`? Operator-only, or the `userId` arm plus operator?
4. **`DuplicateAccountCandidate`:** conjunction (safe), disjunction (discloses), or `spaceId` equality (hides null rows)? Recommendation: conjunction, decided before a reader lands.
5. **`GoalContribution`:** is the authoritative tenant the goal's Space or the account's Space set? And should a write-time `CHECK` close the divergence instead?
6. **`MerchantRule`:** two models, or one with a `CHECK` + real FKs?
7. **Should `fm_app` be denied the `RefreshExecution`/`SyncIssue`/`AiInvocation` families outright** (recommended, §26.4) rather than policied?
8. **Transaction-wrapping scope:** every tenant read, or only writes plus sensitive reads? The latter halves the latency cost but leaves reads unprotected — which defeats the purpose. Likely: all tenant access, with the pool resized.
9. **Should `current_fm_user_id()` raise or return NULL when unset?** Recommendation: **raise** on the tenant connection (§32).
10. **Do we also want tenant keys immutable by trigger**, beyond the `WITH CHECK` asymmetry?
11. **Should the Data API be disabled outright** on both projects, given nothing uses it (§12)?

---

## 39. IMPLEMENTATION SLICES

| Slice | Content | Gate |
|---|---|---|
| **0 — Preview exposure (do first, independent of RLS)** | Turn off auto-expose; unexpose 56 tables; `REVOKE` from `anon`/`authenticated`/`service_role`; same as a committed migration; confirm Security Advisor 56 → 0 errors. Consider disabling the Data API on both projects. Add network restrictions. | Advisor clean; app unaffected |
| **1 — Hygiene prerequisites** | Fix `/api/users/search`; `NOT NULL` on the two nullable tenant FKs; `CHECK`s + FKs for `MerchantRule`/`GoalContribution`; resolve the class-H questions; widen `lib/db-safety.test.ts` globs. | `npm run ci` green |
| **2 — Identity channel (no RLS yet)** | `AsyncLocalStorage` carrier + `$extends` setting `SET LOCAL app.user_id`; convert the 19 batch-array transactions; second/third Prisma clients for system and operator; route the incident lifecycle off the tenant client. **Ship with RLS still off** and measure the latency and pool impact in preview. | No regression; P2024 rate flat; latency within budget |
| **3 — Roles + FORCE RLS on ONE slice** | `fm_owner`/`fm_app`/`fm_system`/`fm_backup`; re-point preview `DATABASE_URL`; enable + FORCE + policies on the **direct-`spaceId` class A tables only** (`SpaceSnapshot`, `SpaceGoal`, `SpaceDashboardSection`, `AiAgent`, `AiAdvice`, `ImportMappingProfile`, `SnapshotAmendment`) — the cheapest, best-indexed, least entangled set. | §29 tests 1–12, 15, 18, 19, 20 pass on that slice |
| **4 — Backup + CI correctness** | `fm_backup` for `pg_dump`; drop `--no-owner --no-privileges` or pair with a bootstrap; per-table row-count completeness assertion; **run a real restore drill**; make CI run audits as a non-bypass role. | Restore drill recorded; test 25 passes; CI exercises policies |
| **5 — Membership + user-scoped tables** | `SpaceMember`, `SpaceAccountLink`, `SpaceInvite`, `PlatformGrant`, `SpaceMemory`, `DailyBrief`, and class B. | Tests 9, 10, 11, 11b, 11c, 21, 24 pass |
| **6 — The account subtree** | `FinancialAccount` + the 16 transitively-owned tables, with the correlated `EXISTS` form. The performance-sensitive slice. | Tests 2–8, 22; `EXPLAIN` review; amplification within budget |
| **7 — System / operational disposition** | Revoke the `RefreshExecution`/`SyncIssue`/`AiInvocation`/`JobRun`/`PlatformSetting`/`RateLimit` families from `fm_app`; `AuditLog` split INSERT/SELECT policies; operator arm. | Tests 13, 14, 23; all jobs and 65 operator routes exercised |
| **8 — Per-tenant conversion of the sweeps** | 4 loops + ~8 scripts take a tenant argument. | Jobs run green under `fm_system` |
| **9 — Production** | §31. | Smoke + adversarial fixtures + monitoring |

---

## 40. FINAL VERDICT

# **NOT READY**

**Not because RLS is wrong for Fourth Meridian — it is right, and the data model is more amenable than expected** (every high-volume table already carries the index the ownership predicate needs; PostgreSQL hoists the membership lookup to once-per-query; the predicate is O(visible accounts), not O(rows), confirmed at 1M rows; and preview and production are schema-identical, so one migration will behave the same in both).

**But four of the six preconditions do not exist yet**: the runtime role bypasses RLS and owns every table; there is no mechanism to tell Postgres who is asking; backups would break or silently truncate and have never been drilled; and CI could not exercise a policy if one existed. Add one live P0 unrelated to RLS (preview's Data API exposure) and one process hazard (manual, out-of-band migrations).

**The path to READY WITH PREREQUISITES is Slices 0–2 plus Slice 4.** Once the preview exposure is closed, the hygiene constraints are in place, the identity channel is shipped and measured with RLS still off, and the backup/CI story is correct, the remaining work is ordinary engineering against a design this document has specified. **Re-assess at that point.**

**What must not happen in the meantime:** enabling RLS on the financial tables "to be safe". With `BYPASSRLS` on the application role it would change nothing except the belief that the system is protected — and a false backstop is worse than a known-absent one, because it erodes the `where`-clause discipline that is currently the entire boundary.

---

## FINAL QUESTIONS — EXPLICIT ANSWERS

**A. If RLS were simply enabled on every financial table TODAY, would Fourth Meridian actually become safer?**
**No. Not at all.** It would be a **silent no-op**. The application connects as `postgres` (via `postgres.<ref>`) in both environments; that role has `rolbypassrls = true` **and** owns all 56 tables. Either attribute alone defeats every policy. Locally it is worse — `fintracker` is additionally a superuser. The system would be **less** safe in practice, because the belief that a database backstop exists would relax the `where`-clause discipline that is currently the entire boundary.

**B. Does the current Prisma runtime database role bypass RLS?**
**Yes.** Production and preview: `postgres`, `rolbypassrls = TRUE`, and owner of all 56 `public` tables. Local dev: `fintracker`, `rolsuper = TRUE`, `rolbypassrls = TRUE`, owner of all 65 tables. Measured directly from `pg_roles` and `pg_class` in all three.

**C. Can that role access another Space's rows if application code omits the predicate?**
**Yes, completely and today.** There is no database-level constraint of any kind: 0 tables with RLS, 0 policies, 0 `CREATE POLICY`/`GRANT`/`REVOKE` statements in 106 migrations. A query with its tenant predicate omitted returns every tenant's rows. This is demonstrated, not hypothetical: `GET /api/users/search` omits the predicate and leaks Space membership today, and `jobs/resume-stale-imports.ts:78-89` records a past cross-tenant accident in which an unscoped run overwrote two unrelated connections' Plaid cursors.

**D. What exact database identity should ordinary Fourth Meridian web requests use?**
A **new `fm_app` role**: `LOGIN`, **`NOBYPASSRLS`**, **not the owner** of any protected table, granted only `SELECT, INSERT, UPDATE, DELETE` on protected tables (no `TRUNCATE`, no `REFERENCES`, no DDL). Vercel's `DATABASE_URL` points at it through the Supavisor transaction pooler. `DIRECT_URL` stays on `fm_owner` for migrations only. Background work and operator consoles use **separate roles on separate Prisma clients** — never `fm_app`, and never `BYPASSRLS` for the web application.

**E. How should Fourth Meridian communicate authenticated user/Space identity to PostgreSQL?**
**Option B — a trusted, application-controlled PostgreSQL session variable, set transaction-locally.** `SET LOCAL app.user_id = '<userId>'` as the first statement inside an interactive transaction, read by policies through a `STABLE` helper `current_fm_user_id()`. Space scope is **derived in the policy** from `SpaceMember` (and `PlatformGrant` for platform Spaces) rather than passed in, so a compromised or stale cookie cannot widen it. Options A (`auth.uid()`), C (per-tenant roles) and D (per-tenant connections) are all ruled out (§18.1) — decisively for A, since `auth.users` is empty, there is no `@supabase/*` dependency, and the connection is Prisma rather than PostgREST.

**F. How do we prove pooled connections cannot leak identity between requests?**
By construction **and** by test. By construction: `SET LOCAL` is transaction-scoped and discarded at both `COMMIT` and `ROLLBACK`, so it cannot survive the connection being returned to the Supavisor transaction pool — which plain `SET` would not. By test, three in §29: **test 16** drives N≫`connection_limit` concurrent Alice/Bob transactions through the single Prisma client and asserts every result set matches its issuing identity; **test 17** does the same through real route handlers; **test 18** asserts that after a deliberately failed/rolled-back transaction, the next transaction on the recycled connection with **no** `SET LOCAL` sees **zero rows** rather than the previous tenant's. A design that asserted this without running those tests would not be acceptable, and this document does not.

**G. Which exact operations legitimately require cross-Space privilege?**
**Six, and only six** (§26.1): (1) the Plaid webhook's `PlaidItem.externalItemId` lookup — a global unique-index read that *is* the tenant resolution; (2) `jobs/fetch-security-prices.ts:61`, whose work list is the union of all tenants' positions; (3) `lib/prices/capability-reconciliation.ts:71`; (4) `lib/crypto/wallet-snapshot-scope.ts:25`; (5) the global merchant catalog write path — which is also an authorization defect needing redesign, not a bypass; and (6) the 65 Platform Ops / admin console routes, where cross-tenant visibility is the product. Additionally, five time-based sweeps cannot be per-tenant without O(users) queries (§26.3). **Everything else that looks cross-tenant is incidental** — the four big sweeps already contain a per-item loop that a per-iteration `SET LOCAL` drops straight into.

**H. Can those operations receive privilege without giving the normal web application `BYPASSRLS`?**
**Yes.** The webhook lookup becomes one narrow `SECURITY DEFINER` function. The jobs and operator consoles run on **separate roles with separate Prisma clients**, carrying **additional policy arms** (keyed on `app.system` / a `PlatformGrant`-derived GUC) rather than `BYPASSRLS` — which keeps every grant of cross-tenant reach visible in `pg_policies` and reviewable in source control. The only unavoidable `BYPASSRLS` in the application's own control is `fm_backup`, used exclusively by `pg_dump` and never present in Vercel's environment.

**I. Should protected tables use FORCE ROW LEVEL SECURITY?**
**Yes, on every protected table, without exception.** Under the proposed split the schema owner is `fm_owner`, and **owners are exempt from their own tables' policies unless `FORCE` is set** — so without it, every `prisma migrate deploy` and every script mistakenly pointed at `DIRECT_URL` would operate with no policies. `ENABLE` alone is not a security boundary; `ENABLE` + `FORCE` + a non-owner, non-`BYPASSRLS` runtime role is the minimum that makes a policy mean anything.

**J. Should Fourth Meridian application tables remain exposed through Supabase's Data API?**
**No.** Nothing in the codebase uses it — no `@supabase/*` dependency, no client, no PostgREST call. It is pure attack surface, and on preview it is currently a live P0 (56 of 56 tables exposed to `anon` with full DML and no RLS). Production is already at 0 of 56 exposed with no `anon` grants; **preview must be brought to match immediately**, the auto-expose toggle turned off in both, and the `REVOKE` committed as a migration so configuration drift cannot silently reintroduce it. Disabling the Data API outright on both projects is the cleanest end state (§38 Q11).

**K. Can preview and production receive the exact same policy migrations?**
**Yes — and this is the strongest result of the investigation.** Preview and production are **schema-identical**: same PostgreSQL 17.6, same 8 schemas, same 56 tables with an identical table-name MD5 (`12df0ef0295c97cae30d6235413742e1`), same uniform `postgres` ownership, same RLS/FORCE flags (all false), same zero policies, and the same 88/0 migration state. One reviewed migration file will produce the same result in both. **Policies must live in source control; preview and production must never depend on separately hand-created dashboard policies.**

**L. What configuration must differ between preview and production?**
**Only credentials and capacity — nothing structural.** Different `DATABASE_URL`/`DIRECT_URL` values (different project refs, different passwords, pointing at the same role *names*); compute NANO vs MICRO and therefore pool size (15 on Micro) and the fixed 200-client ceiling; `NEXTAUTH_URL`/`NEXT_PUBLIC_APP_URL`; Plaid sandbox vs production. **The security configuration — roles, ownership, grants, RLS flags, policies, Data API exposure — must be byte-identical**, and the current `anon`-grant/Data-API drift is precisely the thing to eliminate before using preview as the proving ground.

**M. How do we prove a missing application-level `spaceId` filter cannot expose another user's financial data?**
**Test 20 of §29, which is the brief's own acceptance criterion:** take a real application query path, **delete its tenant predicate** (stub `bankingTransactionWhere` to `{}`), run it as Alice through the `fm_app` role with `SET LOCAL app.user_id = alice`, and assert the result contains **zero Bob rows**. Reinforced by **test 3** (raw `SELECT * FROM "Transaction"` with no `WHERE` at all) and **test 19** (the same via `psql`, with no application code in the path at all). These test the database boundary, not middleware — which is the stated requirement.

**N. How do we prove cross-Space INSERT/UPDATE attacks fail?**
Through `WITH CHECK`, which is evaluated on the **post-image**, and tests 5–8: Alice inserting a transaction against a Bob account is rejected; Alice updating her own row to repoint `financialAccountId` at a Bob account is rejected **while `USING` passes** — which is exactly what proves the `USING`/`WITH CHECK` asymmetry is doing the work and that rows cannot be *moved* across the boundary; Alice updating or deleting a Bob row affects **0 rows**. The same `WITH CHECK` treatment applies to every tenant key (`spaceId`, `ownerUserId`, `userId`, `SpaceAccountLink.spaceId`), optionally reinforced by immutability triggers.

**O. What breaks first if we deploy the proposed RLS architecture incorrectly?**
**The application goes silently empty, and backups stop being complete.** Because `current_setting('app.user_id', true)` returns NULL when unset and `NULL = anything` is NULL, a missing context makes every policy deny — and this codebase has **no "RLS denied" signal anywhere**, so a dashboard with zero rows is indistinguishable from a user with no data. The most likely trigger is the ordering hazard of §27.1: migrations are applied **by hand, out of band from the Vercel deploy**, so the policy migration can land before the code that sets the variable. Close behind: `pg_dump` failing or **silently truncating** under `FORCE RLS` while its only completeness check is "> 100 bytes" (§27.2); the 22 REQUIRED CI audits going quietly empty; and connection-pool pressure from transaction-wrapping reads against `connection_limit=5` and an untuned 10 s `pool_timeout`, reopening the P2024 incidents of July 2026.

**P. What is the safest implementation order?**
**Slice 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9** (§39). The three ordering principles: **(i)** fix preview's live exposure *first*, because a proving ground that is itself wide open proves nothing; **(ii)** ship the identity channel with **RLS still off**, so the latency, pool and transaction-shape risks are measured in isolation from the security change and can be reverted independently; **(iii)** enable RLS first on the **direct-`spaceId` class A tables** — the cheapest, best-indexed, least entangled set — and reach the account subtree only after the backup and CI stories are correct. Never enable all 56 tables in one step, and never let the rollback lever be `DISABLE ROW LEVEL SECURITY` across the board (§32).

---

## APPENDIX — METHOD AND LIMITS

- **Nothing was mutated.** No RLS enabled, no policy, role, grant, migration, Supabase setting, environment variable, application file or test was created or changed. No commit, no push, no stash, no reset. The only file written is this document, uncommitted.
- **Browser use was read-only.** Dashboard pages were read; the only clicks were navigation and focusing the SQL editor. No toggle, save, or destructive control was activated. Three times a Supabase "unsaved changes" dialog was discarded to navigate away — this discarded throwaway SQL editor text only and touched no database state.
- **SQL was `SELECT`-only**, against system catalogs (`pg_roles`, `pg_class`, `pg_policy`, `pg_namespace`, `information_schema.role_table_grants`) and `COUNT(*)`/`split_part` over application tables, on both preview and production. No DDL, no DML, no `ANALYZE`.
- **No credential, password, key, token or connection string appears in this document.** Connection targets are rendered as host/port/database or project ref only. Project refs are identifiers, not secrets.
- **Measurement scale caveat:** performance figures come from the local dev database (5 users, 4,929 transactions). Absolute timings are not predictive of production. The transferable results are the **plan shapes** (hashed SubPlan, Materialize-once, Memoize) and the **buffer ratios**, which were additionally validated against a 1,000,000-row synthetic run.
- **Not covered:** preview's network-restriction setting and SSL-enforcement toggle states were not separately read; the exact rowcount of the 3 unlisted roles in each project was not enumerated beyond the visible set; Supabase PITR/backup retention settings were not inspected.
