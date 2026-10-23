> Runtime verification deliverable · HEAD cde8fa0 (v2.6) · 2026-10-21 · isolated throwaway stack (synthetic data, OpenAI mocked, Plaid Items set REVOKED, no Preview/Production access). Classifications: CONFIRMED / SUPPORTED / REFUTED / PARTIAL / UNVERIFIED. This is the verifying workstream's report; the coordinator independently reproduced SEC-001 and cross-checked every promoted claim (see 09-STATIC-RUNTIME-RECONCILIATION.md).

# Workstream DB (N=6) — Database acceptance / live RLS catalog

Repo HEAD under test: `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` (v2.6). Role: Database Reliability Engineer, PHASE 8.
Static audit reconciled: `docs/audits/pre-beta-2026-10/06-DATABASE-RELIABILITY.md`.
All work on disposable DBs only: the coordinator's throwaway `fintracker_rtv` (owner psql) and the acceptance suites' own `postgres:16-alpine` clones. localhost:5432, .env.local, supabase/vercel hosts never touched. No HTTP requests issued (pure DB workstream), so the X-Forwarded-For bucket rotation is N/A to me.

Scripts: `$S/rtv/db/census.sql`, `isolation.sql`, `isolation2.sql`, `conflicts.sql`; suite logs `$S/rtv/db/accept-*.log`.

Environment note (PG engine): `fintracker_rtv` and all acceptance clones run **PostgreSQL 16** (16.15 Debian; image `postgres:16-alpine`). Production is **Supabase PG 17.6**. RLS/policy semantics tested here are identical across 16/17; differences that remain unverified are the Supabase transaction pooler (`:6543`), the owner-bypasses-RLS behaviour of the Supabase table-owner principal (DB-003), and PITR/backup (DB-007) — none observable on a local disposable DB.

---

## Method caveat — how fm_app was exercised

The role URL fixture files (`$S/rtv/{app,auth,system}.url`) concatenate role+password with **no `:` separator** (libpq parses the whole authority as username `fm_apptv_app`, password absent), so a direct `fm_app` network login from psql was not possible and I did not alter the live role password (the running server uses it). Two valid substitutes were used instead:

1. **Owner session + `SET ROLE fm_app`** on `fintracker_rtv`. RLS policies apply to any non-owner `current_user`, so `SET ROLE fm_app` makes every `fm_app_*` policy active exactly as a real fm_app connection would (FORCE additionally covers the owner case, which I did not rely on). Identity is set with `SELECT set_config('app.user_id', <id>, false)` — the exact key read by `current_fm_user_id()` (`current_setting('app.user_id', true)`).
2. **The repo acceptance suites**, which create a *fresh* `fm_app` role with a known password on their own clone and connect over a real pooled SQL connection with no app code in the path. These are the authoritative live-role proof the static pass lacked.

---

## 1. RLS coverage census (read-only, `fintracker_rtv`)

Source: `pg_class.relrowsecurity/relforcerowsecurity`, `pg_policy`, `information_schema.role_table_grants`. Full per-table table in `$S/rtv/db/census.sql` output.

**Summary (CONFIRMS static + server db-authority exactly):**

| Metric | Static audit | Server db-authority | My live census |
|---|---|---|---|
| public base tables | 70 models | 70 | **71** (= 70 models + `_prisma_migrations`) |
| RLS ENABLE | 62 | 62 | **62** |
| RLS FORCE | 62 | 62 | **62** |
| total policies | — | 246 | **246** |
| fm_system policies that are `USING(true)` | "everywhere" | — | **62 / 62** (every fm_system policy is `USING(true)`) |

**The 8 models WITHOUT RLS** (matches the static "No RLS" row exactly): `Instrument, InstrumentAlias, PriceObservation, CorporateActionTerms, FxRate, Merchant, MerchantAlias, RateLimit`. First seven are shared reference/catalog data; `RateLimit` is the fleet-wide counter table.

**Policy-role structure spot-checks:**
- `AuditLog`: split confirmed — `fm_app_ins`(INSERT), `fm_app_sel`(SELECT), `fm_auth_ins`(INSERT), `fm_system_all`(ALL, USING true). → DB-010 confirmed: fm_system holds UPDATE/DELETE on the audit table.
- Revoked operational ledgers (`AiInvocation, ApiUsageCounter, JobRun, ProviderCall, RefreshExecution(+3), NotificationDelivery, PlaidWebhookEvent, MerchantMergeDecision, ProviderCapabilityObservation, SyncIssueOccurrence`): RLS enabled+forced, **1 policy each (fm_system only), fm_app grant = (none)** — REVOKE ALL confirmed.
- Read seams: `PlatformSetting` fm_app = SELECT only; `SyncIssue` fm_app = (none) with 2 policies; `BetaAccessRequest*` fm_app = INSERT only; `CustomerCohort/CustomerPolicyAssignment` fm_app = SELECT only. All match static.

### TEST-003 — "any table GRANTed to fm_app WITHOUT a policy (cross-tenant readable)?"

Live result (census section C): the tables granted to fm_app **with zero policies** are exactly the **8 no-RLS tables** — `CorporateActionTerms, FxRate, Instrument, InstrumentAlias, Merchant, MerchantAlias, PriceObservation, RateLimit`. **No tenant/user/space/account data table** is in this set: every tenant table is ENABLE+FORCE and carries 4–6 policies.

**Classification: TEST-003 REFUTED for tenant data.** The grant-without-policy pattern it feared exists, but only over (a) intentionally-global reference/catalog data (by design — shared across all tenants) and (b) `RateLimit` (IP/identifier-keyed counters, no customer financial PII) — the latter is exactly the known **DB-004** item, not a new cross-tenant leak of user data.

---

## 2. Tenant isolation at the DB layer

### 2a. Live spot-checks on `fintracker_rtv` as fm_app (`SET ROLE`)

Tenants: jane `cmviisb5q…` (owns 10 accts), john `cmviisb5u…` (owns 15 accts). Seed shares some Spaces between them.

| Probe | Expected | Actual | Verdict |
|---|---|---|---|
| No identity (`app.user_id=''`): FinancialAccount / Transaction / User | 0 / 0 / 0 | **0 / 0 / 0** | FAIL-CLOSED ✓ |
| Jane: own accounts | 10 | 10 | ✓ |
| Jane: John's **unshared** accounts (4 exist) — SELECT | 0 | **0** | ✓ |
| Jane: John's unshared accounts — UPDATE rows affected | 0 | **0** | ✓ |
| Jane: John's unshared accounts — DELETE rows affected | 0 | **0** | ✓ |
| Jane: User rows visible | self only (1) | **1** (cannot see John's User row) | ✓ |
| Alex (no grants): own User / own accounts owned | 1 / 0 | 1 / 0 (sees 11 shared-in accts, 97 shared txns via membership) | ✓ by design |
| fm_app SELECT `PlatformSetting` | allowed | 5 rows | ✓ (read seam) |
| fm_app INSERT `PlatformSetting` | denied | `permission denied` | ✓ |
| fm_app SELECT `JobRun` | denied | `permission denied` | ✓ (REVOKE ALL) |

**Design observation (not a leak):** jane and john *share* Spaces, so Jane legitimately sees 11 of John's 15 accounts and can UPDATE them (the `FinancialAccount` SELECT/UPDATE policies allow `fm_account_visible(id)` for shared-space members), but **DELETE is owner-only** (`fm_app_del` = `ownerUserId = current_fm_user_id()` only — returned 0). This is shared-space collaboration working as designed; the clean cross-tenant proof is the *unshared* 4 accounts (all 0). My first-pass probe used the shared pair and an autocommit UPDATE that set `displayName='HACKED'` on 11 shared rows — **detected and fully restored to NULL** (original value; all 25 accounts verified `displayName IS NULL`). Lesson recorded: all subsequent write probes wrapped in BEGIN/SAVEPOINT…ROLLBACK.

### 2b. Authoritative suite — `npm run rls:accept` (own clone, real fm_app over SQL)

**34/34 passed.** Directly covers the task's isolation requirements and more, e.g.: #24 missing `app.user_id` fails closed (0 rows, never all); #23 recycled session cannot inherit prior identity; #17 40 interleaved Alice/Bob requests on a **pool of one** never cross-contaminate; #21/#22 SET LOCAL identity cleared after COMMIT and after ROLLBACK; #19 a REMOVED member loses visibility immediately; #20 fm_app has no access to AiInvocation; #28/#29 fm_backup dump complete, fm_app dump refused/partial; #30 fm_auth cannot read any financial table; #32 fm_auth lacks BYPASSRLS.

**Classification: tenant isolation at the DB layer CONFIRMED** (static "real isolation" claim upheld live).

---

## 3. Constraints, indexes, rollback, concurrency (`fintracker_rtv`, bounded probes)

### 3a. Unique / partial-unique presence (pg_indexes) and ENFORCEMENT (insert-conflict, rolled back)

| Constraint | Present? | Enforcement probe | Result |
|---|---|---|---|
| `Transaction_plaidTransactionId_key` (plaidTransactionId @unique) | yes | dup insert | `unique_violation` ✓ |
| `ProviderAccountIdentity_plaid_external_account_unique` (provider,externalAccountId) **WHERE PLAID** | yes | same (PLAID,extAcctId) + **different** financialAccountId | `unique_violation` ✓ (PLAID exclusivity — d02b61b design proven live) |
| `ProviderAccountIdentity_provider_externalAccountId_financialAccountId_key` (full 3-col) | yes | exact-row dup | `unique_violation` ✓; control (changed extAcctId) inserted OK → partial scope correct |
| `SpaceAccountLink_one_home_per_account` (financialAccountId) **WHERE kind='HOME'** | yes | 2nd HOME for same account, different space | `unique_violation` ✓ |
| `Transaction_account_externalId_active_key` (financialAccountId,externalTransactionId) WHERE active | yes | — | present |

### 3b. FK enforcement & transaction rollback

- Insert `Transaction` with bogus `financialAccountId` → `Transaction_financialAccountId_fkey` violation ✓.
- Insert valid new txn inside tx: visible (1) before ROLLBACK, **0 after ROLLBACK**; 0 leftover after outer ROLLBACK ✓.

### 3c. 2-client concurrent write (DB-013 area)

`RateLimit` has unique `(key, windowStart)` — the upsert target exists. Two psql clients inserting the same `(key,windowStart)`: client B **blocked 2.05 s** on A's uncommitted row, then received `unique_violation` (= Prisma P2002) once A committed. Synthetic row deleted (0 remaining). → DB layer serializes correctly and guarantees one row; the DB-013 "fail-open" is purely the **application's** P2002 handling, not a DB gap.

### 3d. Index gap reconciliation (DB-009) — live catalog vs static claims

| Index claimed missing (DB-009) | Live catalog | Verdict |
|---|---|---|
| `PlaidItem.syncIncompleteAt` (scanned every 5 min by resume-stale-imports) | absent (only pkey, externalItemId, userId) | **CONFIRMED missing** |
| `SpaceGoal.deletedAt` | absent (has spaceId+category/goalType/status) | **CONFIRMED missing** |
| `SyncIssue (plaidItemId, resolved)` | **not** present, but `(financialAccountId, resolved)` and `(plaidItemId, kind)` **do** exist | **PARTIAL** — exact composite absent; related coverage present |
| `UserSession` "any reaper index" | `UserSession_userId_revokedAt_idx (userId, revokedAt)` **exists** | **PARTIAL/REFUTED** — a revocation-reaper index exists; no standalone global-expiry index |

---

## 4. Migration compatibility

Coordinator already ran `prisma migrate deploy` + seed on an empty DB (that is what produced `fintracker_rtv`). Confirmed via catalog: `_prisma_migrations` = **126 applied, 0 unfinished, 0 rolled_back** (latest `20261016000000_customer_ai_allowance_override`). The six acceptance suites each independently re-applied the **full committed migration history** onto a fresh `postgres:16-alpine` clone and then passed — i.e. the production migration path is exercised cleanly 7× total. **SUPPORTED** (on PG16; PG17.6/Supabase re-rehearsal remains the DB-008/DB-014 owner gate). Not re-run against a populated DB per instructions.

---

## 5. Acceptance suite results (authoritative RLS proof)

Run with `PATH=node@24`, `FM_DB_GUARD=clone-only`; each self-provisions and tears down its container with `docker rm -f -v`.

| Suite | Command | Result |
|---|---|---|
| Core adversarial tenant isolation | `npm run rls:accept` | **34/34 PASS** |
| Application adversarial | `npm run rls:accept:app` | **98/98 PASS** |
| AI-surface adversarial | `npm run rls:accept:ai` | **72/72 PASS** |
| Plaid operational ledger | `npm run rls:accept:plaid` | **20/20 PASS** |
| Foreground-path adversarial | `npm run rls:accept:foreground` | **67/67 PASS** |
| AI allowance reservation | `npm run rls:accept:allowance` | **15/15 PASS** |
| **Total** | | **306/306 PASS** |

(`Unique constraint failed …` / `injected authority failure` / `reservation unavailable; REFUSING` lines in the logs are expected negative-path assertions inside passing cases.) No test container or volume leaked by my runs (teardown uses `-v`). 22 pre-existing dangling volumes observed and **left untouched** per the ENOSPC memory rule (never blind-prune; only coordinator's `fm-rtv-1792611762` and exited `fintracker-db` remain).

---

## 6. Scores table — Part 5 items verified (static vs runtime)

| Part-5 item | Static score | Runtime verdict | Confidence (runtime) | Residual uncertainty |
|---|---|---|---|---|
| RLS coverage | 7 (high SQL / UNVERIFIED live) | **CONFIRMED live**: 62/62 ENABLE+FORCE, 246 policies, fm_system 62/62 USING(true) | high | Supabase owner-bypass (DB-003) & `db`-in-60-routes not testable on disposable DB |
| Tenant isolation (DB layer) | 7 | **CONFIRMED**: no-identity=0, unshared cross-tenant sel/upd/del=0, 306/306 suites | high | Production not yet on roles (DB-003/OPS-015, cutover gate) |
| Unique constraints | 8 | **CONFIRMED** present + enforced (plaidTxnId, PLAID partial, one-HOME, full 3-col) | high | — |
| Relationships / FKs | 8 | **CONFIRMED** FK rejects bogus ref | high | 102-relation census not exhaustively re-probed (spot-checked) |
| Transaction boundaries | 6 | **SUPPORTED**: rollback atomic; 2-client serialization correct | high | statement_timeout/pool-sizing (DB-005/006) not load-tested |
| Indexes | 6 | **PARTIAL**: PlaidItem.syncIncompleteAt & SpaceGoal.deletedAt confirmed missing; SyncIssue/UserSession claims partially refuted (related indexes exist) | high | query-plan impact not measured (no load) |
| Migration discipline | 6 | **SUPPORTED**: 126 applied cleanly, 0 failed; full history re-applied 7× on PG16 | high | PG17.6/Supabase rehearsal + pending-count (DB-008/014) outstanding |
| TEST-003 (cross-tenant readable via grant-without-policy) | — | **REFUTED for tenant data**; pattern exists only for reference tables + RateLimit (= DB-004, benign) | high | — |
| DB-004 (fm_system USING(true); RateLimit/ref no RLS) | P3 as-designed | **CONFIRMED** (62/62 USING(true); 8 no-RLS tables; RateLimit granted ALL to fm_app, no policy) | high | — |
| DB-009 (index gaps) | P3 | **CONFIRMED/PARTIAL** (see Indexes row) | high | — |
| DB-011 (shared-Space permanent-delete orphans Space-owned accounts) | P2 UNVERIFIED | **NOT re-tested** (permanent-delete route is app-layer; schema `ownerSpaceId` SetNull confirmed by static read) | n/a | reader behaviour still UNVERIFIED |
| DB-013 (RateLimit upsert race) | P3 UNVERIFIED | **DB layer sound** (unique (key,windowStart) serializes; P2002 on conflict); fail-open is app-only | high | app P2002 branch not driven here |

### Classification roll-up
- **CONFIRMED**: RLS census (62/62/246, fm_system USING(true)=DB-004), tenant isolation (DB layer), unique+partial-unique presence & enforcement, FK enforcement, transaction rollback, 2-client serialization, DB-009 PlaidItem/SpaceGoal gaps.
- **SUPPORTED**: migration compatibility (PG16), transaction boundaries.
- **PARTIAL**: DB-009 SyncIssue `(plaidItemId,resolved)` and UserSession reaper (related indexes exist, exact ones don't).
- **REFUTED**: TEST-003 for tenant data (no tenant table is grant-without-policy); UserSession "no reaper index at all".
- **UNVERIFIED (out of disposable-DB scope)**: DB-003 Supabase owner-bypass, DB-007 backup/PITR, DB-011 reader behaviour.

## 7. Remediations (unchanged from static, now evidence-backed)
- DB-009: add `PlaidItem(syncIncompleteAt)`, `SpaceGoal(deletedAt)`, and `SyncIssue(plaidItemId, resolved)` indexes (UserSession already has a usable revocation index).
- DB-004: add a user-keyed RLS policy on `RateLimit` (currently full CRUD to fm_app, no policy, no RLS).
- DB-013: ensure the RateLimit upsert relies on native `ON CONFLICT (key, windowStart)` and treats P2002 as "already counted", not fail-open.
- DB-003 / OPS-015: the live-role proof here is on PG16 clones; re-run the acceptance suites against a PG17.6 Supabase clone as the cutover gate, since the static pass could not and neither could this disposable-DB pass validate the Supabase table-owner bypass.
