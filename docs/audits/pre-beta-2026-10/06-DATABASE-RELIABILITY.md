# 06 — Database and Reliability

Pre-beta audit of Fourth Meridian · `v2.6` · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · 2026-10-21 · read-only. Finding IDs `DB-nnn` (Part 5) and `OPS-nnn` (Part 6).

**Measurement caveat.** The local Postgres was unreachable (connection refused; Docker daemon not running) and was not started. No row counts, EXPLAIN plans, index statistics or `pg_catalog` RLS checks were measured. RLS coverage is derived from migration SQL. Every scaling statement below is PREDICTED from code and documented pooler settings; the repository contains no load, soak or capacity test.

## 1. Verdict

The schema is mature and FK-complete (70 models, 102 relations, every one with an explicit `onDelete`), tenant isolation at the DB layer is real on the tenant-client paths, and the only hard-delete paths into financial history are the user purge and two guarded "permanent" routes. The gaps are operational: nine operational ledgers grow without bound and `purge-trash` is a stub; every tenant request is an interactive transaction that pins a pooled server connection, so fleet-wide tenant concurrency is bounded by the `fm_app` pool (about 12) regardless of lambda count; the bank sweep has no time budget inside a shared 300-second cron lambda and a killed slot is not retried for 24 hours; alerting runs inside the cron it is meant to watch with no external heartbeat; the two most important providers (OpenAI, Plaid) have no transport timeout; backups are plaintext local dumps, PITR is unverified and no restore has ever been rehearsed; and no scheduled job has ever run in a deployed environment. No P0. Weighted scores: database **6.0 / 10**, reliability **5.3 / 10**.

## 2. Schema and data model

### 2.1 Aggregates
| Aggregate | Root | Children | Note |
|---|---|---|---|
| Identity | `User` | `UserSession`, `RecoveryCode`, `PlatformGrant`, `CreditScore`, `Notification(+Preference)`, `PlaidItem`, `Connection`, `CustomerPolicyAssignment`, `CustomerCohort`, `SpaceMember`, `SpaceInvite`, `SpaceMemory`, `DailyBrief` | all Cascade from User |
| Tenant | `Space` | `SpaceMember`, `SpaceInvite`, `AiAgent`→`AiAdvice`, `SpaceGoal`→`GoalCheckIn`/`GoalContribution`, `SpaceDashboardSection`, `SpaceAccountLink`, `SpaceSnapshot`, `SnapshotAmendment`→`Day`, `SpaceMemory`, `DailyBrief`, `ImportMappingProfile` | all Cascade from Space |
| Financial ledger | `FinancialAccount` | `Transaction`→`TransactionEvent`/`TransactionObservation`, `Holding`, `PositionObservation`, `InvestmentEvent`, `PositionCoverage`, `PositionReconstruction`, `InvestmentEventCoverage`, `DebtProfile`, `ManualAssetProfile`, `AssetValuation`, `AccountConnection`, `ProviderAccountIdentity`, `ImportBatch`, `DuplicateAccountCandidate` | owner links `ownerUserId`/`ownerSpaceId` are **SetNull** (`schema.prisma:1222-1224`): deleting a User or Space does not cascade into accounts; the purge does it explicitly |
| Provider | `PlaidItem`, `Connection` | `InvestmentEventCoverage` (Cascade); `AccountConnection.plaidItemDbId` SetNull | token encrypted in row |
| Reference | `Instrument`→`InstrumentAlias`/`PriceObservation`/`CorporateActionTerms` (Restrict), `Merchant`→`MerchantAlias`/`MerchantRule`, `FxRate` | shared; no RLS |
| Operational ledgers (no FK) | `JobRun`, `RefreshExecution`→`RefreshEndpointResult`/`ProviderCall`/`RefreshEndpointAccountCoverage`, `AiInvocation`, `ApiUsageCounter`, `SyncIssue(+Occurrence)`, `PlaidWebhookEvent`, `ProviderCapabilityObservation`, `MerchantMergeDecision`, `BetaAccessRequest(+Event)`, `PlatformSetting`, `RateLimit` | 14 models with zero `@relation`; soft references by id |

### 2.2 Cascades (dangerous actions)
Distribution: 62 Cascade, 34 SetNull, 6 Restrict, 0 implicit.

| Delete of | Cascades into | Reachable from | Verdict |
|---|---|---|---|
| `FinancialAccount` | the entire transaction/event/observation/holding subtree | `lib/account-deletion/purge.ts:286` (user purge); `app/api/accounts/manual/[id]/permanent/route.ts:112` (fresh auth, already soft-deleted, owner check, tenant tx) | by design, guarded |
| `Space` | snapshots, goals, memory, briefs, links, amendments, agents, members, invites | `purge.ts:296` (PERSONAL only); `app/api/spaces/[id]/permanent/route.ts:146` (OWNER, already soft-deleted, personal refused) | guarded; **Space-owned accounts of a SHARED Space survive as orphans** (`ownerSpaceId` SetNull) — DB-011 / PRIV-001 |
| `User` | sessions, grants, Plaid Items (incl. the encrypted token row), memberships, `AccountConnection.connectedByUserId`, `SnapshotAmendment` requester | `purge.ts:333` only | co-owned Space accounts hand over their connection row explicitly (`purge.ts:233-258`) |
| `Instrument` | **Restrict** from observations/events/prices | — | correct |
| `ImportBatch` | SetNull on transactions/observations/events | — | correct (provenance detaches, rows survive) |

### 2.3 Soft deletes
Columns are consistent (`deletedAt`/`archivedAt`/`revokedAt`/`deactivatedAt`/`deletionRequestedAt`) across User, Space, FinancialAccount, AccountConnection, SpaceGoal, Transaction, PositionObservation, InvestmentEvent, SpaceMember, PlatformGrant, SpaceAccountLink, UserSession, Notification. Purge exists only for Users (`jobs/process-deletions.ts`, 7-day grace) and Notifications (`lib/notifications/cleanup.ts`). `jobs/purge-trash.ts:4-6` is a stub returning `{ purgedGoals: 0 }`. Status: PARTIALLY IMPLEMENTED.

### 2.4 RLS coverage (from migration SQL)
| Group | Models | RLS | fm_app policy | fm_system |
|---|---|---|---|---|
| Identity core | User, Space, SpaceMember, SpaceInvite | ENABLE+FORCE | row-scoped | `USING(true)` |
| User-scoped | PlaidItem, Connection, CreditScore, Notification(+Preference), RecoveryCode, UserSession, PlatformGrant | ENABLE+FORCE | `userId = me` | `USING(true)` |
| Space-scoped | AiAgent, SpaceGoal, SpaceDashboardSection, ImportMappingProfile, SpaceSnapshot, AiAdvice, SnapshotAmendment, SpaceAccountLink, SpaceMemory, DailyBrief | ENABLE+FORCE | visible-space function | `USING(true)` |
| Account subtree | FinancialAccount and 20 children | ENABLE+FORCE | `fm_account_visible(...)` | `USING(true)` |
| Platform ledgers | AiInvocation, ApiUsageCounter, PlatformSetting, SyncIssue(+Occurrence), JobRun, RefreshExecution(+3), NotificationDelivery, ProviderCapabilityObservation, MerchantMergeDecision | ENABLE+FORCE | REVOKE ALL (read seams on PlatformSetting, SyncIssue) | `USING(true)` |
| Audit | AuditLog | ENABLE+FORCE | SELECT (split policy) + INSERT; fm_auth INSERT | SEL/INS/**UPD/DEL** |
| Beta seam | BetaAccessRequest(+Event), PlaidWebhookEvent, CustomerPolicyAssignment, CustomerCohort | ENABLE+FORCE | insert-only / none | `USING(true)` |
| **No RLS** | Instrument, InstrumentAlias, PriceObservation, CorporateActionTerms, FxRate, Merchant, MerchantAlias, **RateLimit** | — | GRANT only | — |

62/70 models. The migration header itself (lines 15-28) states the table owner bypasses RLS on Supabase, so FORCE is a no-op against the migration principal; see DB-003.

## 3. Connections, pools and transactions
| Client | Env | Role | Pool | Fallback |
|---|---|---|---|---|
| `db` | `DATABASE_URL` | migration principal (table owner) | `connection_limit=3` forced by `lib/db/connection-url.ts:102,137` | — |
| `tenantDb` | `DATABASE_URL_APP` | `fm_app` | 3 | **falls back to `db`** when unset (`lib/db.ts:103`) |
| `authDb` | `DATABASE_URL_AUTH` | `fm_auth` | 3 | falls back to `db` |
| `systemDb` | `DATABASE_URL_SYSTEM` | `fm_system` | 3 | falls back to `db` |

- Runtime URL is the Supabase transaction pooler (`:6543?pgbouncer=true`); migrations use `DIRECT_URL`. Documented pooler facts (not measured): `max_connections` 60, Supavisor pool 15 per user+db with an owner decision to set 12, client cap 200.
- **Every tenant request is an interactive `$transaction`** (`lib/db/tenant-context.ts:34-40`, 220 call sites); only 4 pass a `timeout` (15-20 s); the rest take Prisma defaults (5 s timeout, 2 s maxWait). AI tool phases hold a transaction 5-20 s between model calls (the "no transaction may span a model call" doctrine in `lib/ai/tenant-phase.ts` is followed).
- No `statement_timeout` or `lock_timeout` anywhere in code or migrations; `idle_in_transaction_session_timeout=15s` is set per transaction via `set_config`; the role-level setting is a cutover-plan step, not a migration (PLANNED).
- Locks: one advisory lock (AI allowance, per user), one `FOR UPDATE SKIP LOCKED` throttle (`lib/auth/session-activity.ts:126`), the Plaid per-item CAS lease (`lib/plaid/sync-lock.ts`, 6-minute TTL, released in `finally`: correct). No job-level lock.

## 4. Jobs and scheduling
```
Vercel cron: */15 GET /api/jobs/dispatch (maxDuration 300) · */5 GET /api/jobs/resume-stale-imports (maxDuration 300)
dispatchDueJobs (lib/jobs/dispatch.ts:83-108): latest JobRun per job → cadence policy → IN_FLIGHT only if last run is 'running' and < 6 min old → run due jobs SERIALLY in one invocation
runJob (lib/jobs/run.ts:59-108): JobRun.create 'running' (via legacy db) → body → single completion write → Sentry on throw
Registry (13 jobs): sync-banks, fetch-fx-rates, fetch-security-prices, sync-crypto (+continuation), process-deletions, notification-cleanup, notification-retry, purge-trash (STUB), rate-limit-sweep, plaid-removal-retry, product-event-retention, evaluate-alerts
```
| Property | Mechanism | Status |
|---|---|---|
| Overlap of the same job | read-then-run on the last `JobRun`; no slot key, no advisory lock; 6-minute in-flight window | PARTIAL: a second dispatch (fallback route curl, duplicate delivery) runs the body again; Plaid lease and unique constraints make most bodies safe; `evaluate-alerts` can double-send |
| Lambda killed mid-job | no completion write ⇒ `status='running'` forever; dispatch stops treating it as in-flight after 6 min but `nextDueAt = lastStartedAt + cadence` ⇒ **not retried for 24 h** for `sync-banks` | GAP (OPS-001/006) |
| Work exceeding the lambda | `jobs/sync-banks.ts:82-154`: all ACTIVE Items, no `take`, no `orderBy`, serial; per Item: Plaid sync, balances, snapshot regen, 30-day wealth regen, investment-event ingest; **no time budget** (the crypto sweep has a 90 s budget + continuation) | GAP (OPS-001) |
| Crash recovery for imports | `resume-stale-imports` every 5 min, 5 Items per run, admission-gated | IMPLEMENTED (no index on `PlaidItem.syncIncompleteAt`) |
| Kill switch | `admitOperationalWork` reads `maintenance_mode` etc. | IMPLEMENTED |
| Ledger role | `runJob` and 7 of 13 bodies use the legacy `db` | cron runs as the table owner even under strict mode |
| Deployed evidence | 0 `JobRun` rows on Preview, ever; crons never reach Preview | **UNTESTED in any deployed environment** (OPS-013) |

## 5. Provider resilience
| Provider | Timeout | Retry / backoff | Circuit breaker | Failure mode | Fallback |
|---|---|---|---|---|---|
| OpenAI (`lib/ai/provider.ts:56`) | **none on the client** (SDK default 10 min); structured path 60 s abort | SDK default 2 retries (unconfigured) + app 429 retry ≤ 5; quota never retried | none (manual kill switch) | chat route `maxDuration 300` kills the lambda while the SDK may still be retrying | Brief reuses the cached row; chat none |
| Plaid (`lib/plaid/client.ts:56-65`) | **none** (axios default infinite) | 2 attempts, 1 s fixed, retryable errors only | none | per-Item try/catch; a hung call blocks the slot | — |
| CoinGecko, Tiingo | **none** (no `AbortSignal`) | none; 429 ⇒ THROTTLED | none | price run fails, caveat recorded | last stored observation |
| FX (Frankfurter / OXR) | 15 s | chain failover | none | FX job fails | last `FxRate` row |
| blockstream/Esplora | 10 s | 4× exponential on 429/503 | none | wallet marked failed, deferred | last observation |
| Alchemy / EVM / Solana RPC | 10 s | bounded on throttle (ETH); none (SOL) | none | coverage caveat | yes |
| Resend | none (SDK default) | `notification-retry` job, 3 attempts | none | returns `{status:"error"}` | — |
| Turnstile | 5 s | none | none | **fail-open** | — |

No circuit breaker exists anywhere. The prior audit's FM-AUDIT-026 (no OpenAI/Plaid/CoinGecko/Tiingo timeouts) is still open; ETH/SOL were fixed since.

## 6. Scalability scenarios (THEORETICAL; no tested capacity exists)
Inputs: fm_app server pool 12; one interactive transaction per tenant request; dispatch 300 s / 15 min; `sync-banks` serial and uncapped at 24 h cadence; `resume-stale-imports` 5 Items / 5 min; export and transaction list caps 5,000; wealth regen 30 days per synced Item; chat up to 6 model calls per turn.

| Scale | Database | Cron / Plaid | OpenAI | Growth tables | Verdict |
|---|---|---|---|---|---|
| 10 concurrent (beta) | ≤ 10 tenant transactions < 12 pool | ≤ ~20 Items ⇒ 1-3 min of a 300 s slot | ≤ 10 turns, per-user lock | fine | OK; only latent issues (retention, no restore drill) |
| 100 concurrent | 100 wanted vs **12 server connections** ⇒ Supavisor queueing; busy instances exhaust the 3-connection client pool ⇒ P2024 after 10 s (the 2026-07-25/26 incident class at a new threshold) | 100-200 Items ⇒ 5-27 min ≫ 300 s ⇒ **daily tail starvation** | 100 lambdas each holding a tenant transaction between model calls; tool phases serialise | ~1,000 rows/day across RefreshExecution + children | degraded; needs pool sizing and a bank-sweep budget first |
| 1,000 concurrent | needs ≥ 340 client connections vs the pooler's 200 cap; server pool 12 ⇒ p99 unbounded; the per-request interactive transaction is architectural | not viable on a single-lambda cron; needs fan-out or a queue | needs a global concurrency limiter | product-event retention (20 × 1,000/day) could fall behind | not supported by the current architecture |
| 10,000 registered (~2,000 Items, 5% DAU) | as the 100-row | 2,000 Items × 3-8 s = **1.7-4.4 h/day** vs 300 s ⇒ cron refreshes < 3% of Items; webhooks carry the rest; Plaid rate limits unmodelled | — | RefreshExecution ~3.6M rows/yr; `UserSession` +1 per login forever; `PlaidWebhookEvent` +1 per webhook | storage and dashboard latency degrade within months |

## 7. Findings

| ID | Finding | Sev | Status | Evidence | Impact | Remediation | Blocker | Conf. |
|---|---|---|---|---|---|---|---|---|
| **DB-001** | No retention for `RefreshExecution` (+3 children), `AiInvocation`, `JobRun`, `PlaidWebhookEvent`, `UserSession`, `ProviderCall`, `SyncIssue`, `ApiUsageCounter`, `BetaAccessRequestEvent`, `DailyBrief`; `purge-trash` is a stub; a `UserSession` row per login, never deleted | P2 | PARTIALLY IMPLEMENTED | grep of `deleteMany` per table; `jobs/purge-trash.ts:4-6`; `lib/auth.ts:507`; `lib/export/assemble.ts:253` | monotonic growth; real at 10k users; sessions export unbounded | one retention job per ledger; implement or delete `purge-trash` | No | high |
| **DB-002** | User purge is non-transactional (`purge.ts:228-333`, no `$transaction`) and retains PII-linked soft references (`AiInvocation.userId`, `BetaAccessRequest*` email, `MerchantMergeDecision.decidedByUserId`, `PlatformSetting.updatedById`) | P2 | PARTIALLY IMPLEMENTED | `lib/account-deletion/purge.ts` | crash between steps leaves a half-purged user (idempotent retry, duplicate audit row possible); pseudonymous ids survive deletion | one transaction for the final steps; explicit soft-ref scrub step; document what is retained | No (document) — see PRIV-001/002 for the P1 parts | high |
| **DB-003** | Legacy `db` (table owner, bypasses RLS) is the client for 60 API route files and all jobs; strict mode validates URLs but does not stop code from using `db`; the only guard is a source-scan test | P2 | PARTIALLY IMPLEMENTED | §3; `lib/rls-server-component-authority.test.ts:97-103` | tenant isolation at the DB layer is only as good as the per-file client choice | move jobs/ops to `systemDb`; make `db` non-callable at runtime in strict mode outside an allowlist | No | high |
| DB-004 | `fm_system` policy is `USING(true)` everywhere; `RateLimit` and reference tables have no RLS | P3 | as designed | migration lines 204-426, 213, 240 | any `systemDb` path is cross-tenant by construction | policy on `RateLimit` for user-keyed rows | No | high |
| **DB-005** | Fleet-wide tenant concurrency bounded by the fm_app server pool (~12) because every request is an interactive transaction | P2 (latent at beta; P1 at ≥ 100 concurrent) | IMPLEMENTED pattern | `tenant-context.ts:34-40`; `rls-preview-cutover.md:116`; `production-cutover-plan.md:147` | beyond ~12 simultaneous tenant transactions, requests queue with no server-side bound; P2024 on busy instances | measure; size the fm_app pool by tier; `statement_timeout` per role; keep transactions short | No at 5 users | medium |
| DB-006 | No statement/lock timeouts; role-level idle-in-transaction timeout exists only in the cutover plan | P2 | PLANNED | grep; `tenant-context.ts:36` | a runaway query holds a pooled connection until the lambda dies | `ALTER ROLE fm_app SET statement_timeout` as a migration | No | high |
| **DB-007** | Backups: plaintext local `pg_dump` files only (72 present locally incl. Preview dumps named with the project ref), no rotation, PITR "No record", `fm_backup` passwordless so the documented backup role cannot be used, **no restore ever rehearsed** | P1 | PARTIALLY IMPLEMENTED | `scripts/db-backup.ts:21,60-62`; `production-readiness.md:83`; cutover plan §3 | RPO/RTO unknown; unencrypted customer-grade data on a laptop | verify and record PITR; one rehearsed restore with timings; encrypt or delete local dumps; set the `fm_backup` password | **Yes** (cutover gate) | high |
| DB-008 | Migration discipline: forward-only (0 down), 15 date-only names breaking timestamp ordering, 7 migrations with inline data statements, 3 partial indexes in raw SQL invisible to `prisma migrate diff`, drift check is name-only, deploy does not migrate; `SpaceGoal.deletedAt` index dropped and never re-added | P2 | with gaps | `prisma/migrations/*`; `scripts/check-schema-drift.ts:29-62`; `package.json:10` | 35-39 pending migrations against Production; future same-day ordering ambiguous | enforce timestamp names; CI `migrate diff` with an allowlist; keep the clone rehearsal gate | No (rehearsal gated) | high |
| DB-009 | Index gaps: `PlaidItem` lacks `syncIncompleteAt` (scanned every 5 min), `SyncIssue` lacks `(plaidItemId, resolved)`, `SpaceGoal` lacks `deletedAt`, `UserSession` lacks any reaper index | P3 | PARTIALLY IMPLEMENTED | schema vs `resume-stale-imports.ts:131-142`, `lifecycle.ts:501` | small at beta | add the four indexes | No | high |
| DB-010 | `AuditLog` is not append-only at the DB level: fm_system holds UPDATE/DELETE; product events share the table and `product-event-retention.ts:80` deletes from it; no row hash | P3 | acknowledged deferred | migration line 592 | history rewritable from `systemDb`/`db` | separate product events; forbid UPDATE/DELETE on security actions | No | high |
| DB-011 | Shared-Space permanent delete orphans Space-owned `FinancialAccount` rows (`ownerSpaceId` SetNull; only PERSONAL accounts are purged) | P2 | UNVERIFIED reader behaviour | `schema.prisma:1224`; `permanent/route.ts:146`; `purge.ts:286` | invisible rows with full history, never purged | soft-delete or delete unlinked Space-owned accounts in the route; orphan audit | No (see PRIV-001) | medium |
| DB-012 | 14 FK-less ledgers reference ids softly with no orphan handling | P3 | by design | `schema.prisma:3921` etc. | dashboards must tolerate dangling ids (they appear to) | include in retention job | No | high |
| DB-013 | `RateLimit` upsert first-request race: general limits fail open on P2002 if Prisma does not emit native `ON CONFLICT` | P3 | UNVERIFIED | `lib/rate-limit.ts:32-38,59-64` | silent allow on the race | two-client test on a clone | No | low |
| DB-014 | Local Postgres 16 vs Production 17.6 | P3 | documented | `docker-compose.yml`; cutover plan | plan differences | rehearse on PG17 | No | high |
| **OPS-001** | `sync-banks` has no per-run cap, no time budget, no continuation; a killed slot leaves `JobRun='running'` and is not retried for 24 h; the tail of the Item list starves daily | P2 at 5 users; **P1 before ~50 Items** | IMPLEMENTED without bounds | `jobs/sync-banks.ts:83-151`; `lib/jobs/run.ts:89-107`; `cadence-policy.core.ts:116-122`; contrast `lib/crypto/wallet-refresh.ts:5,143-146` | at 40-100 Items the slot dies at the same point every day; items past the cut-off get no cron refresh; health notices after 2 h via a rule that runs in the same dispatcher | budget + `deferred` + continuation like the wallet sweep; order by `lastSuccessfulSyncAt ASC`; finalise stale runs at next dispatch and treat them as due | scale-triggered | high |
| **OPS-002** | Alerting cannot report a dead scheduler: `evaluate-alerts` runs inside the dispatch cron; `/api/health` is `SELECT 1`; no external heartbeat or uptime monitor | P1 | PARTIALLY IMPLEMENTED | `lib/jobs/registry.core.ts:32`; `lib/alerts/rules.ts:149`; `app/api/health/route.ts:12`; `production-readiness.md:82` | if cron stops (plan change, `CRON_SECRET` rotation ⇒ 401, broken route) nobody is emailed | deep health reporting `lastDispatchAt`/overdue jobs; external pinger alerting on "no JobRun in 45 min" | **Yes** (before cutover) | high |
| OPS-003 | `withApiHandler` swallows route errors before Sentry sees them (= ARCH-004) | P2 | gap | `lib/api.ts:124-133`; `instrumentation.ts` | every wrapped API 500 is invisible to Sentry | `captureException` in the catch | No | high |
| OPS-004 | OpenAI and Plaid transports have no timeout; CoinGecko/Tiingo fetches have no `AbortSignal`; no circuit breaker anywhere (= SEC-AI-003 for OpenAI) | P2 | PARTIALLY IMPLEMENTED | §5 | a hung provider holds a lambda to `maxDuration`, a tenant transaction to 5-30 s, and in cron the whole slot | client timeouts (OpenAI ~60-90 s, Plaid 30 s, prices 10 s); a simple per-provider trip flag in `PlatformSetting` | No (OpenAI half is SEC-AI-003, a blocker) | high |
| OPS-005 | Job overlap not prevented at the ledger (read-then-run; `executionId` unique but not a slot key; fallback routes call `runJob` directly) | P2 | PARTIALLY IMPLEMENTED | `dispatch.ts:86-98`; `run.ts:66` | duplicate provider calls; duplicate alert email in the same minute | `pg_try_advisory_xact_lock('job:'‖name)` in `runJob` or `@@unique([jobName, slotKey])` | No | high |
| OPS-006 | Stale `running` `JobRun` and RUNNING `RefreshExecution` rows are never finalised (prior FM-AUDIT-049 still open) | P2 | detected, not repaired | `lib/jobs/health.ts:14,95-100`; `lib/platform/refresh/projections.ts:152-156` | platform windows stay "indeterminate" forever after any kill | finalise rows older than their budget at dispatch start | No | high |
| OPS-007 | Memory-heavy paths bounded individually (5,000-row caps, 30-year forecast cap, 30-day regen) but unbounded in aggregate inside the cron lambda; CSV import has no row cap (prior FM-AUDIT-058 open) | P2 | with caps | `lib/export/select.ts:25`; `tools.ts:3876`; `regenerate-history.ts:1408` | cron memory is the sum over Items in a slot | cap CSV rows; move wealth regen to the continuation | No | medium |
| OPS-008 | Per-instance in-memory caches without cross-instance invalidation (30 s revocation cache, +120 s stale grace) | P3 | by design | `lib/session-cache.ts:21-25` | a revoked session honoured ≤ 30 s (≤ 150 s in a DB outage) on another instance | none at beta | No | high |
| OPS-009 | Rate limiting DB-backed in production, fail-open on non-auth paths; `/api/health` writes a row per hit | P3 | IMPLEMENTED | `lib/rate-limit.ts:20,45-89` | a DB blip disables limiting on data routes | exempt `/api/health` or use an edge limiter | No | high |
| OPS-010 | Failure isolation in the bank sweep is per-Item for errors but not for time; the 6-minute lease outlives the 5-minute lambda | P2 | PARTIALLY IMPLEMENTED | `sync-banks.ts:101-151`; `sync-lock.ts` | one hung institution blocks every later Item and every job queued behind it | Plaid timeout + per-Item deadline + budget | No | high |
| OPS-011 | No queue; all background work runs inline in cron lambdas (webhook work via `after()` still runs inside the webhook lambda) | P2 (architectural) | by design | `vercel.json`; `plaid/webhook/route.ts:21` | throughput ceiling = 300 s × jobs per 15 min + webhook lambdas; no backpressure, no dead-letter | fan-out per Item or adopt a queue beyond ~100 Items | No | high |
| OPS-012 | Incident response: levers exist (`maintenance_mode`, kill switch, fallback routes, `RATE_LIMIT_ENABLED`); `background-jobs.md` is stale (says 60 s maxDuration and "No alerting") | P3 | PARTIALLY IMPLEMENTED | `lib/platform/admission/facts.ts:28,53`; `background-jobs.md:71` | operators follow a wrong runbook | refresh the doc; add the heartbeat | No | high |
| **OPS-013** | The whole job/alert system has never run in a deployed environment under the role topology | P1 | unit-tested only | STATUS §7 item 2; `environment-separation.md:22` | first real execution of `sync-banks`/`evaluate-alerts`/`process-deletions` would be on Production | run each fallback route once on Preview with `CRON_SECRET` before cutover (already an owner gate) | **Yes** (cutover gate) | high |
| OPS-014 | `/api/health` is public, DB-backed, writes a rate-limit row per hit, and discloses the commit SHA | P3 | — | `health/route.ts:8-18` | minor | cache 10 s; drop `commit` for unauthenticated callers | No | high |
| **OPS-015** | Production currently serves `87e4df7` (July 2026, v2.5), 872 commits and 38 migrations behind the candidate, with no RLS roles, the shared session secret, two users and three live Plaid Items; the cutover plan is NO-GO on its own gates | P1 | documented | `production-cutover-plan.md` §1, §6, §8, §10; `gh` run history | the beta cannot run on Production as it stands; every finding in this audit assumes the v2.6 candidate | execute the cutover plan's gates 1-11 and issues 1-6 | **Yes** (master gate) | high |

## 8. Scores

### Part 5 — Database
| Item | Score | Weight | Evidence | Strengths | Weaknesses | Conf. | Beta impact | Improvement |
|---|---|---|---|---|---|---|---|---|
| Schema design | 7 | 3 | §2 | event/observation ledgers; provenance columns; economic-date split | 14 FK-less ledgers; mixed naming | high | low | — |
| Relationships / FKs | 8 | 3 | §2.2 | all actions explicit; Restrict on reference data | Space→account SetNull orphan | high | low | DB-011 |
| Unique constraints | 8 | 2 | schema + 3 raw partial uniques | PLAID exclusivity at the DB | raw SQL invisible to Prisma diff | high | low | drift allowlist |
| Indexes | 6 | 2 | DB-009 | hot read paths covered | four gaps | high (static) | low | DB-009 |
| Query performance | UNVERIFIED | 2 | no DB available; 34 unbounded `findMany` all account/event-scoped on inspection | readers 24 h-windowed; lists capped | no EXPLAIN evidence; CSV import uncapped | — | low now | measure on a clone |
| Transaction boundaries | 6 | 3 | §3 | AI phase doctrine | one tx per request pins a server connection; no statement_timeout | high | low | DB-005/006 |
| Connection pooling | 5 | 3 | §3 | pool size owned in code after an incident | fleet-wide ~12 ceiling | medium | low now, high at 100 | size by tier |
| RLS coverage | 7 | 3 | §2.4 | real isolation on tenant paths; FORCE everywhere; split AuditLog read | legacy `db` in 60 routes; `USING(true)` for fm_system; unverified live | high (SQL) / UNVERIFIED (live) | medium | DB-003 |
| Data retention | 3 | 2 | DB-001 | batched retention pattern exists | nine growing tables; stub job | high | low now | DB-001 |
| Soft deletes | 6 | 2 | §2.3 | guarded permanent routes | no purge for Space/Goal/AccountConnection trash | high | low | — |
| Cascading deletes | 7 | 3 | §2.2 | financial history hard-deleted only via purge/permanent | orphan path | high | low | DB-011 |
| Audit trails | 6 | 2 | DB-010 | structured actor/result/target; operator reasons | not append-only; shared with product events | high | low | DB-010 |
| Migration discipline | 6 | 3 | DB-008 | guard + backup before migrate | forward-only; raw-SQL drift; 15 non-timestamp names | high | medium | DB-008 |
| Backup strategy | 4 | 3 | DB-007 | backup-before-migrate enforced | plaintext local only; PITR unverified; backup role unusable | high | **high (cutover)** | DB-007 |
| Restore readiness | 3 | 3 | DB-007 | restore command documented | never rehearsed; no RTO/RPO | high | **high (cutover)** | DB-007 |
| Data export | 7 | 2 | `lib/export/*` | RLS-bound, fresh auth, rate-limited | sessions unbounded; whole zip in memory | high | low | cap sessions |
| Customer deletion | 6 | 3 | DB-002, PRIV-001/002 | two-phase, re-auth, Plaid revocation with retry | non-transactional; retained identifiers; orphaned shared Spaces | high | medium | DB-002 |
| Tenant isolation (DB layer) | 7 | 3 | §2.4, §3 | defence in depth once strict mode is on | Production not on roles; pins are tests | high | medium | cutover + DB-003 |

Weighted mean: **6.0 / 10**.

### Part 6 — Reliability
| Item | Score | Weight | Evidence | Strengths | Weaknesses | Conf. | Beta impact | Improvement |
|---|---|---|---|---|---|---|---|---|
| API resilience | 5 | 3 | §5 | per-Item isolation; typed provider errors | OpenAI/Plaid/CoinGecko/Tiingo no timeout | high | medium | OPS-004 |
| Retry policies / backoff | 6 | 2 | §5 | bounded where present | none for OpenAI (SDK default), FX, CoinGecko | high | low | — |
| Circuit breakers | 2 | 2 | §5 | manual kill switch | no automatic trip | high | low | OPS-004 |
| Timeouts | 5 | 3 | §5 | crypto 10 s, FX 15 s, maxDuration declared | no statement_timeout; no OpenAI/Plaid transport timeout | high | medium | OPS-004, DB-006 |
| Background job reliability | 5 | 3 | §4 | ledger, admission gate, health classifier, crypto continuation | bank sweep unbounded; killed slot not retried; never run deployed | high | medium → high at 50 Items | OPS-001 |
| Queue behaviour | 3 | 2 | OPS-011 | `after()` on webhooks | no queue, no backpressure, no dead-letter | high | low | fan-out |
| Scheduled job overlap / locking | 6 | 2 | OPS-005 | Plaid lease CAS; AI advisory lock | no job-level lock | high | low | OPS-005 |
| DB contention | 7 | 2 | §3 | throttled session writes | `RateLimit` upsert per request incl. health | high (static) | low | OPS-009 |
| Memory usage | 6 | 2 | OPS-007 | caps on exports, lists, forecast | CSV uncapped; cron aggregate | medium | low | OPS-007 |
| Serverless execution limits | 6 | 2 | 15 routes declare `maxDuration` | declared and documented | plan tier not in repo; 300 s shared by all jobs | high | low | — |
| Cache consistency | 7 | 1 | OPS-008 | small TTLs, caps | per-instance only | high | low | — |
| Rate limiting | 7 | 2 | OPS-009 | DB-backed; auth fail-closed; entitlement-driven AI limits | fail-open on data routes | high | low | — |
| Recovery after crashes | 5 | 3 | OPS-006 | import resume bounded | no stale-run finaliser; no bank-sweep retry | high | medium | OPS-006 |
| Failure isolation | 6 | 3 | OPS-010 | errors isolated per Item | time is not | high | medium | OPS-010 |
| Graceful degradation | 6 | 2 | §5 | admission DENY; stored-row fallbacks; cached Brief | chat has none beyond a generic failure | high | low | — |
| Monitoring | 4 | 3 | OPS-003, `10-OBSERVABILITY-SCORECARD.md` | job/auth/ledger failures captured | API 500s never reach Sentry; no tracing; no DB metrics | high | medium | OPS-003 |
| Alerting | 4 | 3 | OPS-002 | 8 real rules, email delivery, 20 h renotify | depends on the cron it watches; no external heartbeat | high | **high (cutover)** | OPS-002 |
| Incident response | 6 | 2 | OPS-012 | 555-line runbook; levers in code | stale job doc; no drill | high | low | OPS-012 |

Weighted mean: **5.3 / 10**. Confidence high on structure, UNVERIFIED on every live measurement.

## 9. Contradictions and open questions
- `docs/operations/background-jobs.md:71`: "60s maxDuration", "No alerting" — code has 300 s and 8 alert rules (stale).
- Pending migration count quoted as 31, 33, 35 and 38 in different places; must be re-derived on the clone rehearsal.
- `scripts/db-backup.ts:60-62` instructs backups as `fm_backup`, which has no password (cannot be followed today).
- `incident-response.md:161` names PITR as a prerequisite; `production-readiness.md:83` records "No record".
- Prior audit FM-AUDIT-026/048/049/058 re-verified still open at HEAD.
- Open for the owner: Vercel plan tier (whether `maxDuration 300` is honoured); Supabase compute tier and PITR status; whether an external uptime monitor exists outside the repo; intended retention for `AiInvocation` and `UserSession`; whether shared-Space permanent delete is meant to leave Space-owned accounts behind.
