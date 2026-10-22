# 22 — Production migration preflight (88 → 135)

**Date:** 2026-10-23. **Method:** read-only. Sources were the 47 `prisma/migrations/<name>/migration.sql` files on `origin/v2.6` (`27c3ca2`), the first 88 migrations concatenated and `prisma/schema.prisma` at `87e4df7` (55 models + `_prisma_migrations` = 56 tables), and old-app code read with `git show 9ea5881:<path>`. `9ea5881` differs from `87e4df7` only in `package.json` / `package-lock.json` (`git diff --stat`), so the old-app reading applies to both. No database, Vercel, Supabase or network connection was made. No build or test was run. The combined SQL below has **not been executed anywhere**. Its syntax was checked by reading only, so run it once in the SQL editor before relying on it.

**Inputs taken as given (from the brief):** Production runs Supabase PG 17.6. It has applied exactly the first 88 migrations (newest `20260727_v26pre_b4_btc_identity_backstop`). `postgres` is non-superuser with BYPASSRLS and CREATEROLE. There are no `fm_*` roles, and RLS is enabled nowhere. The pending list is `/Users/chrstn/fm-rehearsal-private/prod-pending-migrations.txt` (47 names, identical to directories 89–135).

## 0. Verdict in one paragraph

None of the 47 migrations drops, renames or retypes a column or table that holds data. None adds a NOT NULL column without a default to a table the old app writes. Only one runs DML against existing rows: `20261022000200_job_run_one_running_per_job` (`UPDATE "JobRun"`). Four can fail on Production data or environment:
- `20261002000000_tenancy_integrity`: RAISE / SET NOT NULL / CHECK.
- `20261002000100_rls_roles_and_policies`: CREATE ROLE … BYPASSRLS, ENABLE/FORCE RLS on tables it must own, and no pre-existing policies or roles.
- `20261004000000_plaid_identity_global_exclusivity`: partial UNIQUE index over existing rows.
- `20261006010000_platform_area_merchant_ops`: the migrator must own the enum type.

One more can silently half-apply: `20261022000700_db006_role_statement_timeouts` (NOTICE fallback). Every RLS/FORCE migration is inert for the old app **if and only if** the old app's runtime role has BYPASSRLS (or is superuser). That is the single load-bearing environmental fact, and the SQL checks it (`env.client_roles_bypassrls`). Under that condition no pending migration breaks the old app (`87e4df7`/`9ea5881`). **Migrate-then-deploy is viable without a maintenance window.** Deploy-then-migrate is **not** viable: the candidate needs the new schema and the `fm_*` role URLs (strict mode), and those exist only after the migrations. Section 4 lists the conditions.

**Risk count: H = 1, M = 6, L = 40** (47).

## 1. All 47 migrations

Legend: **Data?** = outcome depends on existing rows. **Env?** = depends on roles, ownership, privileges or the version. **Old app?** = the old app (`9ea5881`, connecting as BYPASSRLS `postgres`) keeps working if this is applied before the new code deploys. "Cond." means compatible under the stated condition.

| # | Migration | Effect | Data? | Env? | Old app? | Risk |
|---|---|---|---|---|---|---|
| 1 | `20260801_v26_investments_history_snapshot_completeness` | 3 nullable columns on `SpaceSnapshot` | no | no | yes | L |
| 2 | `20260801_v26_quantity_1e_investment_event_coverage` | enum `InvestmentCoverageOutcome` + new table `InvestmentEventCoverage` (FKs to `PlaidItem`, `FinancialAccount` CASCADE) | no | no | yes | L |
| 3 | `20260801_v26_quantity_1h_coverage_history_floor` | 3 columns on the new (empty) `InvestmentEventCoverage`, one `NOT NULL DEFAULT false` | no | no | yes | L |
| 4 | `20260803_v26_crypto_valuation_status` | nullable `SpaceSnapshot.cryptoValuationStatus` | no | no | yes | L |
| 5 | `20260803_v26_provider_capability_observation` | new table + index (name truncated to 63 chars; renamed by #47) | no | no | yes | L |
| 6 | `20260804_v26_historical_stage_split` | 7 nullable columns on `RefreshEndpointResult` | no | no | yes | L |
| 7 | `20260804_v26_s1_corporate_action_terms` | new table, UNIQUE index on the empty table, FK → `Instrument` ON DELETE RESTRICT | no | no | yes (RESTRICT only bites when rows exist, and the old app writes none) | L |
| 8 | `20260805_l8_event_identity` | enum + nullable `Transaction.transactionEventId` (+index, FK SET NULL) + new `TransactionEvent` / `TransactionObservation` (UNIQUE indexes on empty tables) | no | no | yes. `CREATE INDEX` on `Transaction` (~5k rows) briefly blocks writes | L |
| 9 | `20260805_l8a_economic_date_column` | nullable `Transaction.economicDate` + 2 indexes | no (backfill is a separate script) | no | yes. The old app never reads it | L |
| 10 | `20260805_l8b1_event_current_projection` | FK `TransactionEvent.currentTransactionId → Transaction` | no (`TransactionEvent` is empty when it runs) | no | yes | L |
| 11 | `20260806_v26_own1_flow_authority` | enum `FlowAuthority` + nullable `Transaction.flowAuthority` (no default, no backfill) | no | no | yes | L |
| 12 | `20260818_w1_observation_link_evidence` | 2 nullable columns on `TransactionObservation` | no | no | yes | L |
| 13 | `20260826232626_position_coverage_licence` | new table `PositionCoverage` (UNIQUE on the empty table, FK → `Instrument` RESTRICT) | no | no | yes | L |
| 14 | `20260907234638_space_memory_user_owned` | 2 enums + new `SpaceMemory` (FKs CASCADE to `Space` / `User`) | no | no | yes | L |
| 15 | `20260908222415_ai_invocation` | new table `AiInvocation` | no | no | yes | L |
| 16 | `20260908224119_plaid_item_environment` | nullable `PlaidItem.environment` | no | no | yes | L |
| 17 | `20260913114002_daily_brief` | new table `DailyBrief` | no | no | yes | L |
| 18 | `20260915180000_refresh_execution_source` | `RefreshExecution.plaidItemId` DROP NOT NULL; `sourceKind TEXT NOT NULL DEFAULT 'PLAID_ITEM'` + 5 nullable columns; 2 indexes | no (a constant default is metadata-only on PG11+) | no | yes. Old INSERTs omit `sourceKind` and get the default; relaxing NOT NULL cannot break a writer | L |
| 19 | `20261001120000_connection_facet_freshness` | 2 nullable columns on `Connection` | no | no | yes | L |
| 20 | `20261002000000_tenancy_integrity` | DO-block **RAISE** if any `Transaction` / `Holding.financialAccountId IS NULL`; then `SET NOT NULL` on both; `CHECK MerchantRule_scope_key_ck` | **YES** | no | yes. Every old writer supplies `financialAccountId` (cutover plan §2 row 20). The only old `MerchantRule` creator writes `scope:"USER", ownerUserId` (`lib/transactions/merchant-corrections.ts:209-210`), and the merge path only repoints `merchantId` (`lib/transactions/merchant-merge.ts:317`) | **M** |
| 21 | `20261002000100_rls_roles_and_policies` | CREATE/ALTER ROLE `fm_app`, `fm_auth`, `fm_system` (NOBYPASSRLS) and `fm_backup` (**BYPASSRLS**), LOGIN, no password. Creates 3 `fm_*` functions (one SECURITY DEFINER). GRANT USAGE on `public`, sequences, `SELECT ALL TABLES` + DEFAULT PRIVILEGES to `fm_backup`. **ENABLE + FORCE RLS on 56 tables** (48 existing + 8 created earlier in this batch). 220 `CREATE POLICY`. The 7 existing tables left without RLS are `RateLimit` (handled by #45), `Instrument`, `InstrumentAlias`, `PriceObservation`, `FxRate`, `Merchant` and `MerchantAlias`. REVOKEs from `anon` / `authenticated` / `service_role` (conditional). All in one transaction | no | **YES**: CREATEROLE; BYPASSRLS on the migrator to mint a BYPASSRLS role (PG ≥16 rule); ownership of every table (ENABLE RLS, CREATE POLICY); USAGE WITH GRANT OPTION on `public`; no pre-existing `fm_*` policies (CREATE POLICY has no IF NOT EXISTS); pre-existing `fm_*` roles would need ADMIN for ALTER ROLE | **Cond.**: inert only because the old runtime role is BYPASSRLS (BYPASSRLS beats FORCE). If the old app connected as any non-BYPASSRLS role, every table read would return 0 rows. The ACCESS EXCLUSIVE locks on 48 live tables are held until COMMIT, so old requests stall for the duration | **H** |
| 22 | `20261002000200_rls_auth_surface` | grants + policies for `fm_auth` on `AuditLog`, `PlatformSetting`, `RecoveryCode`, `RateLimit` | no | yes (roles from #21) | yes | L |
| 23 | `20261002000300_rls_app_platform_settings` | `fm_app` SELECT + policy on `PlatformSetting` | no | yes (#21) | yes | L |
| 24 | `20261002000400_rls_membership_bootstrap` | SECURITY DEFINER `fm_may_join_space`; replaces the `SpaceMember` INSERT/UPDATE and `Space` SELECT policies; `Space` DELETE grant + policy | no | yes (#21; reads `Space.isPublic`, `platformArea`, `SpaceInvite`) | yes | L |
| 25 | `20261002000500_rls_app_sync_issue_read` | column-level SELECT on 6 `SyncIssue` columns + tenant policy | no | yes (#21; the columns must exist) | yes | L |
| 26 | `20261002000600_rls_beta_access_request_seam` | IMMUTABLE `fm_beta_request_is_intake("BetaAccessRequestStatus", …)`; `BetaAccessRequest` policies; `fm_auth` column grants | no | yes (#21; enum + columns) | yes | L |
| 27 | `20261003000000_rls_account_subtree_owner_arm` | ALTER POLICY ×4 on 13 subtree tables (written-out owner arm) | no | yes (policies from #21) | yes | L |
| 28 | `20261003000100_rls_duplicate_candidate_owner_arm` | ALTER POLICY ×3 on `DuplicateAccountCandidate` | no | yes (#21) | yes | L |
| 29 | `20261004000000_plaid_identity_global_exclusivity` | partial `CREATE UNIQUE INDEX … (provider, externalAccountId) WHERE provider='PLAID'` | **YES** | no | yes. A later old-code duplicate now raises 23505, but the only old PLAID writer `dualWriteProviderAccountIdentity` catches and logs it (`lib/accounts/provider-identity.ts:66-110`, "Never throws") | **M** |
| 30 | `20261006000000_rls_function_execute_least_privilege` | REVOKE EXECUTE from PUBLIC / `fm_auth` / `fm_system`; GRANT to `fm_app` (and `fm_auth` for intake); conditional API-role revoke | no | yes (#21, #24, #26 objects) | yes | L |
| 31 | `20261006010000_platform_area_merchant_ops` | `ALTER TYPE "PlatformArea" ADD VALUE IF NOT EXISTS 'MERCHANT_OPS'` | no | **YES** (the migrator must own the type) | **Cond.**: the old Prisma client throws on an unknown enum value when it reads one. Safe while no `Space` / `PlatformGrant` row uses it, so seed Merchant Ops only **after** promotion | **M** |
| 32 | `20261006020000_plaid_item_sync_origin_cursor` | nullable `PlaidItem.syncOriginCursor` | no | no | yes | L |
| 33 | `20261007000000_financial_account_provider_subtype` | nullable `FinancialAccount.providerSubtype` | no | no | yes | L |
| 34 | `20261007100000_operationalization_p0_facts` | 7 columns on `AiInvocation` (`outcome NOT NULL DEFAULT 'RETURNED'`), 3 indexes; new RLS-forced `PlaidWebhookEvent` and `BetaAccessRequestEvent` with grants to `fm_*` | no | yes (roles from #21 are referenced unconditionally) | yes. The old app touches none of these | L |
| 35 | `20261008000000_p1_customer_policy_cohort` | new `CustomerPolicyAssignment` / `CustomerCohort` (RLS, grants); 2 nullable `Connection` columns | no | yes (#21 roles) | yes | L |
| 36 | `20261015100000_plaid_item_environment` | nullable `PlaidItem.plaidEnvironment` | no | no | yes | L |
| 37 | `20261015120000_rls_asset_valuations` | new `ManualAssetProfile` / `AssetValuation` (CHECK `value >= 0` on the empty table), RLS + policies | no | yes (#21 roles) | yes | L |
| 38 | `20261016000000_customer_ai_allowance_override` | nullable integer on `CustomerPolicyAssignment` | no | no | yes | L |
| 39 | `20261022000000_user_purge_claim` | nullable `User.purgeStartedAt` | no | no | yes | L |
| 40 | `20261022000100_import_batch_file_sha256` | nullable `ImportBatch.fileSha256` + partial UNIQUE `(financialAccountId, fileSha256) WHERE fileSha256 IS NOT NULL AND status IN (…)` | no (the column is new, so every row is NULL and outside the predicate; it cannot fail) | needs the 4 `ImportBatchStatus` labels (present since migration 88) | yes. The old app never writes `fileSha256` | L |
| 41 | `20261022000200_job_run_one_running_per_job` | **DML**: `UPDATE "JobRun"` marks `running` rows older than 6 min, then all but the newest `running` row per job, as `failed` / `stale`; then partial `UNIQUE (jobName) WHERE status='running'` | **YES** (it rewrites rows; it cannot fail, because step 2 guarantees ≤1 `running` row per job) | no | **Cond. / degraded**: a run legitimately in flight for >6 min is relabelled `failed` (its own completion write later overwrites that by id). In the old app the start write is best-effort (`lib/jobs/run.ts:131-141`), so a duplicate `running` claim raises P2002, gets caught, and the **job still runs, just without a ledger row**. The old app has no stale-run finaliser, so one crashed old-code run leaves that job's later runs unrecorded until the new code deploys | **M** |
| 42 | `20261022000300_plaid_item_resume_backoff` | `PlaidItem.syncResumeAttempts INTEGER NOT NULL DEFAULT 0` + nullable `syncResumeNextAt` | no | no | yes (old INSERTs get the default) | L |
| 43 | `20261022000400_db009_operational_indexes` | 4 indexes on `PlaidItem`, `SpaceGoal`, `SyncIssue`, `UserSession` | no (fails only if the name already exists; covered by the drift check) | no | yes | L |
| 44 | `20261022000500_sec014_platform_grant_read_only` | REVOKE INSERT/UPDATE/DELETE on `PlatformGrant` from `fm_app` (conditional); DROP 3 policies IF EXISTS | no | yes (#21) | yes. Old admin routes write as `postgres` | L |
| 45 | `20261022000600_db004_rate_limit_rls` | **ENABLE + FORCE RLS on `RateLimit`** + 3 role policies (conditional on the roles) | no | **YES**: same BYPASSRLS precondition as #21 | **Cond.**: the old limiter writes `RateLimit` on every request as `postgres`. The old login limiter fails closed, so a non-BYPASSRLS runtime role here means **every login fails** | **M** |
| 46 | `20261022000700_db006_role_statement_timeouts` | `ALTER ROLE fm_app/fm_auth/fm_system SET statement_timeout` (15s / 5s / 60s). On `insufficient_privilege` it only RAISEs a NOTICE | no | **YES**: needs ADMIN on the `fm_*` roles. In PG16+ a CREATEROLE creator gets it implicitly when it creates them in #21; Preview held ADMIN and emitted no NOTICE (doc 18 §3) | yes (`postgres` untouched) | **M** (it can silently skip) |
| 47 | `20261022001000_db008_provider_capability_index_name` | `ALTER INDEX IF EXISTS … RENAME` on the #5 index | no | no | yes | L |

**H (1):** #21. **M (6):** #20, #29, #31, #41, #45, #46. **L (40):** the rest.

**Data-dependent (3):** #20 and #29 can fail; #41 always succeeds but rewrites rows. **Environment-dependent (beyond "the roles exist because #21 ran"):** #21, #31, #45, #46. Every migration after #21 that names `fm_app` / `fm_auth` / `fm_system` / `fm_backup` unconditionally depends on #21 having committed: #22–#28, #30, #34, #35, #37. #44–#46 guard with `IF EXISTS (pg_roles …)`.

**Atomicity:** each migration runs as one transaction. `20261004000000` states that "Prisma's migration runner wraps each migration in a transaction". A failure leaves Production at the previous migration and records the failed row in `_prisma_migrations`, which blocks later deploys (P3009) until `prisma migrate resolve --rolled-back <name>`.

## 2. Read-only preflight SQL

How to use it:
- Paste it into the Production SQL editor (it runs as `postgres`).
- Run it once now. Run it again **within one hour before** `prisma migrate deploy`, in the dispatch-free window (08:00–11:59 UTC).

What it is:
- One `WITH … SELECT` statement with no DDL and no DML. The only functions it calls are catalog and inspection functions: `to_regclass`, `to_regtype`, `has_schema_privilege`, `pg_get_userbyid`, `pg_database_size`, `pg_backend_pid`, `current_setting`.
- It reads only tables that exist at migration 88. Pending objects are probed **by name** through catalogs, never selected from.
- It returns one JSON value.
- Every aggregate is a `count`, a `coalesce(json_agg …)` or a `min`/`max`, so empty tables return 0, `[]` or `null` and never an error.
- `json_build_object` is nested by section to stay under PostgreSQL's 100-argument limit.

```sql
-- FourthMeridian Production migration preflight (read-only). Pure SELECT.
-- References only objects that exist at migration 88; pending objects are
-- probed by NAME (to_regclass / to_regtype / catalogs), never selected from.
WITH
req_tables(t) AS (VALUES
  ('AccountConnection'),('AiAdvice'),('AiAgent'),('ApiUsageCounter'),('AuditLog'),
  ('BetaAccessRequest'),('Connection'),('CreditScore'),('DebtProfile'),
  ('DuplicateAccountCandidate'),('FinancialAccount'),('FxRate'),('GoalCheckIn'),
  ('GoalContribution'),('Holding'),('ImportBatch'),('ImportMappingProfile'),
  ('Instrument'),('InstrumentAlias'),('InvestmentEvent'),('JobRun'),('Merchant'),
  ('MerchantAlias'),('MerchantMergeDecision'),('MerchantRule'),('Notification'),
  ('NotificationDelivery'),('NotificationPreference'),('PlaidItem'),
  ('PlatformGrant'),('PlatformSetting'),('PositionObservation'),
  ('PositionReconstruction'),('PriceObservation'),('ProviderAccountIdentity'),
  ('ProviderCall'),('RateLimit'),('RecoveryCode'),('RefreshEndpointAccountCoverage'),
  ('RefreshEndpointResult'),('RefreshExecution'),('SnapshotAmendment'),
  ('SnapshotAmendmentDay'),('Space'),('SpaceAccountLink'),('SpaceDashboardSection'),
  ('SpaceGoal'),('SpaceInvite'),('SpaceMember'),('SpaceSnapshot'),('SyncIssue'),
  ('SyncIssueOccurrence'),('Transaction'),('User'),('UserSession'),
  ('_prisma_migrations')),
req_cols(t, c) AS (VALUES
  ('Transaction','financialAccountId'),('Holding','financialAccountId'),
  ('MerchantRule','scope'),('MerchantRule','ownerUserId'),('MerchantRule','spaceId'),
  ('ProviderAccountIdentity','provider'),('ProviderAccountIdentity','externalAccountId'),
  ('ProviderAccountIdentity','financialAccountId'),
  ('JobRun','id'),('JobRun','jobName'),('JobRun','status'),('JobRun','startedAt'),
  ('JobRun','completedAt'),('JobRun','errorSummary'),
  ('ImportBatch','financialAccountId'),('ImportBatch','status'),
  ('SyncIssue','id'),('SyncIssue','kind'),('SyncIssue','resolved'),('SyncIssue','createdAt'),
  ('SyncIssue','financialAccountId'),('SyncIssue','plaidTransactionId'),('SyncIssue','plaidItemId'),
  ('PlaidItem','syncIncompleteAt'),('PlaidItem','userId'),
  ('SpaceGoal','deletedAt'),('SpaceGoal','spaceId'),
  ('UserSession','revokedAt'),('UserSession','userId'),
  ('Space','id'),('Space','isPublic'),('Space','platformArea'),
  ('PlatformGrant','userId'),('PlatformGrant','status'),('PlatformGrant','area'),
  ('SpaceInvite','invitedUserId'),('SpaceInvite','status'),('SpaceInvite','spaceId'),
  ('SpaceMember','userId'),('SpaceMember','spaceId'),('SpaceMember','status'),
  ('SpaceAccountLink','financialAccountId'),('SpaceAccountLink','status'),('SpaceAccountLink','spaceId'),
  ('FinancialAccount','id'),('FinancialAccount','ownerUserId'),
  ('BetaAccessRequest','status'),('BetaAccessRequest','inviteTokenHash'),
  ('BetaAccessRequest','inviteExpiresAt'),('BetaAccessRequest','invitedAt'),
  ('BetaAccessRequest','decidedAt'),('BetaAccessRequest','decidedById'),
  ('BetaAccessRequest','redeemedAt'),('BetaAccessRequest','redeemedUserId'),
  ('RateLimit','key'),
  ('DuplicateAccountCandidate','accountAId'),('DuplicateAccountCandidate','accountBId'),
  ('GoalContribution','goalId'),('GoalContribution','financialAccountId'),
  ('GoalCheckIn','goalId'),('SnapshotAmendmentDay','amendmentId'),
  ('SnapshotAmendment','id'),('SnapshotAmendment','spaceId'),
  ('AuditLog','userId'),('AuditLog','spaceId'),
  ('Notification','userId'),('CreditScore','userId'),('NotificationPreference','userId'),
  ('RecoveryCode','userId'),('Connection','userId'),('User','id'),
  ('AiAgent','spaceId'),('SpaceDashboardSection','spaceId'),('ImportMappingProfile','spaceId'),
  ('SpaceSnapshot','spaceId'),('AiAdvice','spaceId'),
  ('PositionObservation','financialAccountId'),('InvestmentEvent','financialAccountId'),
  ('PositionReconstruction','financialAccountId'),('DebtProfile','financialAccountId'),
  ('AccountConnection','financialAccountId'),
  ('RefreshExecution','plaidItemId'),('RefreshExecution','startedAt'),('Instrument','id')),
new_tables(t) AS (VALUES
  ('InvestmentEventCoverage'),('ProviderCapabilityObservation'),('CorporateActionTerms'),
  ('TransactionEvent'),('TransactionObservation'),('PositionCoverage'),('SpaceMemory'),
  ('AiInvocation'),('DailyBrief'),('PlaidWebhookEvent'),('BetaAccessRequestEvent'),
  ('CustomerPolicyAssignment'),('CustomerCohort'),('ManualAssetProfile'),('AssetValuation')),
new_types(t) AS (VALUES
  ('InvestmentCoverageOutcome'),('TransactionEventLifecycle'),('FlowAuthority'),
  ('MemoryKind'),('MemoryStatus')),
new_cols(t, c) AS (VALUES
  ('SpaceSnapshot','completenessTier'),('SpaceSnapshot','contributingComponentCount'),
  ('SpaceSnapshot','totalComponentCount'),('SpaceSnapshot','cryptoValuationStatus'),
  ('RefreshEndpointResult','attempt'),('RefreshEndpointResult','windowFromISO'),
  ('RefreshEndpointResult','windowToISO'),('RefreshEndpointResult','plannerMode'),
  ('RefreshEndpointResult','errorCode'),('RefreshEndpointResult','retryable'),
  ('RefreshEndpointResult','resultSummary'),
  ('Transaction','transactionEventId'),('Transaction','economicDate'),('Transaction','flowAuthority'),
  ('PlaidItem','environment'),('PlaidItem','syncOriginCursor'),('PlaidItem','plaidEnvironment'),
  ('PlaidItem','syncResumeAttempts'),('PlaidItem','syncResumeNextAt'),
  ('RefreshExecution','sourceKind'),('RefreshExecution','sourceRef'),('RefreshExecution','network'),
  ('RefreshExecution','failureStage'),('RefreshExecution','failureCategory'),('RefreshExecution','outcome'),
  ('Connection','transactionsSyncedAt'),('Connection','historyRebuiltAt'),
  ('Connection','syncLockedAt'),('Connection','lastManualRefreshAt'),
  ('FinancialAccount','providerSubtype'),('User','purgeStartedAt'),('ImportBatch','fileSha256')),
new_indexes(t) AS (VALUES
  ('Transaction_transactionEventId_idx'),('Transaction_financialAccountId_economicDate_idx'),
  ('Transaction_economicDate_idx'),('RefreshExecution_sourceKind_startedAt_idx'),
  ('RefreshExecution_sourceRef_startedAt_idx'),('ProviderAccountIdentity_plaid_external_account_unique'),
  ('ImportBatch_account_file_live_key'),('JobRun_one_running_per_job'),
  ('PlaidItem_syncIncompleteAt_idx'),('SpaceGoal_deletedAt_idx'),
  ('SyncIssue_plaidItemId_resolved_idx'),('UserSession_revokedAt_idx'),
  ('ProviderCapabilityObservation_provider_capabilityKey_observ_idx'))
SELECT json_build_object(

  'env', json_build_object(
    'pg_version',                     current_setting('server_version'),
    'current_user',                   current_user,
    'current_user_superuser',         (SELECT rolsuper      FROM pg_roles WHERE rolname = current_user),
    'current_user_createrole',        (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user),
    'current_user_bypassrls',         (SELECT rolbypassrls  FROM pg_roles WHERE rolname = current_user),
    'postgres_bypassrls',             (SELECT rolbypassrls  FROM pg_roles WHERE rolname = 'postgres'),
    'postgres_role_settings',         (SELECT rolconfig     FROM pg_roles WHERE rolname = 'postgres'),
    'fm_roles_present',               (SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]'::json)
                                         FROM pg_roles WHERE rolname LIKE 'fm\_%'),
    'supabase_api_roles_present',     (SELECT count(*) FROM pg_roles
                                        WHERE rolname IN ('anon','authenticated','service_role')),
    'client_roles_bypassrls',         (SELECT coalesce(json_object_agg(u.usename, u.bypass), '{}'::json)
                                         FROM (SELECT DISTINCT a.usename::text AS usename,
                                                      (r.rolbypassrls OR r.rolsuper) AS bypass
                                                 FROM pg_stat_activity a
                                                 JOIN pg_roles r ON r.rolname = a.usename
                                                WHERE a.datname = current_database()
                                                  AND a.backend_type = 'client backend'
                                                  AND a.pid <> pg_backend_pid()) u),
    'public_tables_not_owned_by_current_user',
                                      (SELECT coalesce(json_agg(c.relname ORDER BY c.relname), '[]'::json)
                                         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                        WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
                                          AND pg_get_userbyid(c.relowner) <> current_user),
    'public_enum_types_not_owned_by_current_user',
                                      (SELECT coalesce(json_agg(t.typname ORDER BY t.typname), '[]'::json)
                                         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                                        WHERE n.nspname = 'public' AND t.typtype = 'e'
                                          AND pg_get_userbyid(t.typowner) <> current_user),
    'public_schema_create',           has_schema_privilege('public', 'CREATE'),
    'public_schema_usage_grantable',  has_schema_privilege('public', 'USAGE WITH GRANT OPTION'),
    'public_tables_rls_enabled',      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                        WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity),
    'public_tables_rls_forced',       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                        WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relforcerowsecurity),
    'public_policies',                (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
    'public_tables_total',            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                        WHERE n.nspname = 'public' AND c.relkind IN ('r','p')),
    'fm_functions_present',           (SELECT coalesce(json_agg(p.proname ORDER BY p.proname), '[]'::json)
                                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                        WHERE n.nspname = 'public'
                                          AND p.proname IN ('current_fm_user_id','fm_visible_space_ids',
                                                            'fm_account_visible','fm_may_join_space',
                                                            'fm_beta_request_is_intake')),
    'password_encryption',            current_setting('password_encryption')
  ),

  'ledger', json_build_object(
    'applied_finished',               (SELECT count(*) FROM _prisma_migrations
                                        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
    'unfinished_not_rolled_back',     (SELECT count(*) FROM _prisma_migrations
                                        WHERE finished_at IS NULL AND rolled_back_at IS NULL),
    'rolled_back_rows',               (SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL),
    'newest_applied',                 (SELECT max(migration_name) FROM _prisma_migrations
                                        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
    'rows_after_baseline',            (SELECT count(*) FROM _prisma_migrations
                                        WHERE migration_name > '20260727_v26pre_b4_btc_identity_backstop')
  ),

  'drift', json_build_object(
    'required_tables_missing',        (SELECT coalesce(json_agg(t ORDER BY t), '[]'::json) FROM req_tables
                                        WHERE to_regclass(format('public.%I', t)) IS NULL),
    'required_columns_missing',       (SELECT coalesce(json_agg(r.t || '.' || r.c ORDER BY r.t, r.c), '[]'::json)
                                         FROM req_cols r
                                        WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
                                                           WHERE ic.table_schema = 'public'
                                                             AND ic.table_name = r.t AND ic.column_name = r.c)),
    'pending_tables_already_present', (SELECT coalesce(json_agg(t ORDER BY t), '[]'::json) FROM new_tables
                                        WHERE to_regclass(format('public.%I', t)) IS NOT NULL),
    'pending_types_already_present',  (SELECT coalesce(json_agg(t ORDER BY t), '[]'::json) FROM new_types
                                        WHERE to_regtype(format('public.%I', t)) IS NOT NULL),
    'pending_columns_already_present',(SELECT coalesce(json_agg(r.t || '.' || r.c ORDER BY r.t, r.c), '[]'::json)
                                         FROM new_cols r
                                        WHERE EXISTS (SELECT 1 FROM information_schema.columns ic
                                                       WHERE ic.table_schema = 'public'
                                                         AND ic.table_name = r.t AND ic.column_name = r.c)),
    'pending_indexes_already_present',(SELECT coalesce(json_agg(t ORDER BY t), '[]'::json) FROM new_indexes
                                        WHERE to_regclass(format('public.%I', t)) IS NOT NULL),
    'pending_constraints_already_present',
                                      (SELECT coalesce(json_agg(conname ORDER BY conname), '[]'::json)
                                         FROM pg_constraint
                                        WHERE conname IN ('MerchantRule_scope_key_ck',
                                                          'Transaction_transactionEventId_fkey',
                                                          'TransactionEvent_currentTransactionId_fkey',
                                                          'AssetValuation_value_nonnegative')),
    'platformarea_has_merchant_ops',  EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                                               WHERE t.typname = 'PlatformArea' AND e.enumlabel = 'MERCHANT_OPS'),
    'importbatchstatus_labels_needed',(SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                                        WHERE t.typname = 'ImportBatchStatus'
                                          AND e.enumlabel IN ('PENDING','PROCESSING','COMPLETED','COMPLETED_WITH_ERRORS')),
    'betaaccessrequeststatus_labels_needed',
                                      (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                                        WHERE t.typname = 'BetaAccessRequestStatus'
                                          AND e.enumlabel IN ('PENDING','APPROVED','REDEEMED')),
    'merchantrulescope_labels_needed',(SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                                        WHERE t.typname = 'MerchantRuleScope' AND e.enumlabel IN ('USER','SPACE')),
    'providertype_has_plaid',         EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                                               WHERE t.typname = 'ProviderType' AND e.enumlabel = 'PLAID')
  ),

  '20261002000000_tenancy_integrity', json_build_object(
    'transaction_null_financialAccountId', (SELECT count(*) FROM "Transaction" WHERE "financialAccountId" IS NULL),
    'holding_null_financialAccountId',     (SELECT count(*) FROM "Holding" WHERE "financialAccountId" IS NULL),
    'merchantrule_scope_check_violations', (SELECT count(*) FROM "MerchantRule"
                                             WHERE ((scope = 'USER'  AND "ownerUserId" IS NOT NULL AND "spaceId" IS NULL)
                                                 OR (scope = 'SPACE' AND "spaceId" IS NOT NULL AND "ownerUserId" IS NULL)) IS NOT TRUE)
  ),

  '20261004000000_plaid_identity_global_exclusivity', json_build_object(
    'duplicate_plaid_external_ids', (SELECT count(*) FROM (
                                        SELECT 1 FROM "ProviderAccountIdentity"
                                         WHERE provider = 'PLAID' AND "externalAccountId" IS NOT NULL
                                         GROUP BY provider, "externalAccountId" HAVING count(*) > 1) d),
    'plaid_identity_rows',          (SELECT count(*) FROM "ProviderAccountIdentity" WHERE provider = 'PLAID')
  ),

  '20261022000200_job_run_one_running_per_job', json_build_object(
    'running_total',                (SELECT count(*) FROM "JobRun" WHERE status = 'running'),
    'running_older_than_6m',        (SELECT count(*) FROM "JobRun"
                                      WHERE status = 'running' AND "startedAt" < now() - interval '6 minutes'),
    'running_in_flight_lt_6m',      (SELECT count(*) FROM "JobRun"
                                      WHERE status = 'running' AND "startedAt" >= now() - interval '6 minutes'),
    'jobs_with_multiple_running',   (SELECT count(*) FROM (SELECT 1 FROM "JobRun" WHERE status = 'running'
                                                            GROUP BY "jobName" HAVING count(*) > 1) d),
    'oldest_running_startedAt',     (SELECT min("startedAt") FROM "JobRun" WHERE status = 'running')
  ),

  'info', json_build_object(
    'now_utc',                      now() AT TIME ZONE 'UTC',
    'db_size_bytes',                pg_database_size(current_database()),
    'users',                        (SELECT count(*) FROM "User"),
    'transactions',                 (SELECT count(*) FROM "Transaction"),
    'import_batches',               (SELECT count(*) FROM "ImportBatch"),
    'jobrun_rows',                  (SELECT count(*) FROM "JobRun"),
    'merchantrule_rows',            (SELECT count(*) FROM "MerchantRule"),
    'platform_spaces',              (SELECT count(*) FROM "Space" WHERE "platformArea" IS NOT NULL)
  )
) AS preflight;
```

## 3. Expected-safe values

Read each row as "the value the check must return for the migration named in the key to apply cleanly".

| Key | Expected | Blocks / why |
|---|---|---|
| `env.pg_version` | `17.6` (any ≥ 16) | #21: PG ≥16 lets a CREATEROLE + BYPASSRLS non-superuser create the BYPASSRLS `fm_backup`, and gives the creator implicit ADMIN that #46 needs |
| `env.current_user` | `postgres` | Must be the same principal that runs `prisma migrate deploy` |
| `env.current_user_superuser` | `false` | Informational (Supabase) |
| `env.current_user_createrole` | `true` | #21: CREATE ROLE |
| `env.current_user_bypassrls` | `true` | #21: `CREATE ROLE fm_backup … BYPASSRLS` |
| `env.postgres_bypassrls` | `true` | #21, #34, #35, #37, #45: what keeps the old app unaffected by FORCE RLS |
| `env.postgres_role_settings` | `null` (measured 2026-10-06), or settings with no small `statement_timeout` / `lock_timeout` | #21 is one long transaction. A role-level statement timeout could abort it |
| `env.fm_roles_present` | `[]` | #21 is idempotent for roles, but a pre-existing `fm_*` role it lacks ADMIN on makes `ALTER ROLE` fail. Pre-existing roles also mean someone ran DDL out of band, so stop |
| `env.supabase_api_roles_present` | `3` | Informational: the conditional REVOKE branches in #21 and #30 will run, and they are harmless |
| `env.client_roles_bypassrls` | every role the **app** connects as maps to `true` (expected `{"postgres": true, …}`). Supabase-internal roles such as `authenticator` or `pgbouncer` may be `false` | **#21 / #45 old-app compatibility.** If the app's role is `false`, applying #21 makes every RLS table invisible to the old app, and #45 breaks login (the limiter fails closed). This is a snapshot of connected sessions only, so if the app is idle the owner must also confirm the Production `DATABASE_URL` username is `postgres` / `postgres.<ref>` |
| `env.public_tables_not_owned_by_current_user` | `[]` | #21, #45: `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` and `CREATE POLICY` require ownership |
| `env.public_enum_types_not_owned_by_current_user` | `[]` | #31: `ALTER TYPE … ADD VALUE` requires owning `PlatformArea` |
| `env.public_schema_create` | `true` | #2 onward: CREATE TABLE / TYPE / FUNCTION |
| `env.public_schema_usage_grantable` | `true` | #21: `GRANT USAGE ON SCHEMA public TO fm_*`. Without the grant option PostgreSQL only WARNs, and the roles end up unable to reach anything |
| `env.public_tables_rls_enabled` | `0` | Pre-existing RLS means drift. Stop |
| `env.public_tables_rls_forced` | `0` | same |
| `env.public_policies` | `0` | #21: `CREATE POLICY` has no IF NOT EXISTS, so any same-named policy fails it |
| `env.public_tables_total` | `56` | Matches 55 models + `_prisma_migrations` |
| `env.fm_functions_present` | `[]` | #21, #24, #26 use CREATE OR REPLACE. A same-named function owned by someone else would fail them |
| `env.password_encryption` | `scram-sha-256` | Needed for the owner's post-#21 `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'` |
| `ledger.applied_finished` | `88` | baseline |
| `ledger.unfinished_not_rolled_back` | `0` | Otherwise `migrate deploy` refuses (P3009) |
| `ledger.rolled_back_rows` | `0` (measured 2026-10-06) | Informational. If nonzero, read which ones |
| `ledger.newest_applied` | `20260727_v26pre_b4_btc_identity_backstop` | baseline |
| `ledger.rows_after_baseline` | `0` | None of the 47 has been attempted |
| `drift.required_tables_missing` | `[]` | #21 names all 55 existing tables. A missing one aborts it |
| `drift.required_columns_missing` | `[]` | Columns named by policies, indexes and DML in #20, #21, #24–#29, #40, #41, #43 |
| `drift.pending_tables_already_present` | `[]` | CREATE TABLE without IF NOT EXISTS in #2, #5, #7, #8, #13–#15, #17, #34, #35, #37 |
| `drift.pending_types_already_present` | `[]` | CREATE TYPE in #2, #8, #11, #14 |
| `drift.pending_columns_already_present` | `[]` | ADD COLUMN without IF NOT EXISTS in #1, #4, #6, #8, #9, #11, #16, #18, #19, #32, #33, #35, #36, #39, #40, #42 |
| `drift.pending_indexes_already_present` | `[]` | CREATE INDEX without IF NOT EXISTS in #8, #9, #18, #29, #40, #41, #43 |
| `drift.pending_constraints_already_present` | `[]` | #20 CHECK, #8 / #10 FKs, #37 CHECK |
| `drift.platformarea_has_merchant_ops` | `false` (`true` is tolerated by IF NOT EXISTS, but it means drift) | #31 |
| `drift.importbatchstatus_labels_needed` | `4` | #40's index predicate casts these literals to the enum. A missing label errors |
| `drift.betaaccessrequeststatus_labels_needed` | `3` | #26 function body and policies |
| `drift.merchantrulescope_labels_needed` | `2` | #20 CHECK |
| `drift.providertype_has_plaid` | `true` | #29 predicate |
| `20261002000000_tenancy_integrity.transaction_null_financialAccountId` | `0` | #20 RAISEs on > 0 |
| `20261002000000_tenancy_integrity.holding_null_financialAccountId` | `0` | #20 RAISEs on > 0 |
| `20261002000000_tenancy_integrity.merchantrule_scope_check_violations` | `0` | #20 `ADD CONSTRAINT … CHECK` fails on > 0 |
| `20261004000000_plaid_identity_global_exclusivity.duplicate_plaid_external_ids` | `0` | #29 `CREATE UNIQUE INDEX` fails on > 0. Do not pick a winner; classify first (file header) |
| `20261004000000_plaid_identity_global_exclusivity.plaid_identity_rows` | any | Informational |
| `20261022000200_job_run_one_running_per_job.running_in_flight_lt_6m` | `0` **at the moment of `migrate deploy`** | #41 does not fail on > 0. But if a job is in flight, a second `running` row from an overlapping start would be relabelled `failed`, so wait until it is 0 (the dispatch-free window normally gives 0; `resume-stale-imports` runs every 5 min and is short) |
| `20261022000200_job_run_one_running_per_job.running_older_than_6m` | any (expected `0`) | Informational: these rows **will be rewritten** to `failed` / `stale`. Nonzero means crashed runs, which is acceptable |
| `20261022000200_job_run_one_running_per_job.jobs_with_multiple_running` | any | Informational: #41 step 2 resolves these, so it never blocks |
| `20261022000200_job_run_one_running_per_job.oldest_running_startedAt` | `null` or recent | Informational |
| `info.*` | — | Sizing for lock duration. `transactions` was about 4,909 on 2026-10-06; `platform_spaces` was 4 and must still be 4 (no `MERCHANT_OPS` Space before promotion) |

## 4. Old-app compatibility (migrate-then-deploy)

**No pending migration is backward-incompatible with `9ea5881` / `87e4df7` unconditionally.** None drops, renames or retypes a column. None adds a NOT NULL column without a default to an old-written table. None changes a grant held by `postgres`.

Migrations that are compatible **only under a condition**. These decide the cutover shape:

| Migration | Condition | If violated |
|---|---|---|
| `20261002000100_rls_roles_and_policies` (and every later RLS migration: #22–#28, #34, #35, #37) | The old app's runtime role is BYPASSRLS or superuser (`env.client_roles_bypassrls`, plus the owner confirming `DATABASE_URL`'s username) | The old app sees 0 rows on 56 tables: total outage |
| `20261022000600_db004_rate_limit_rls` | same | Old login limiter fails closed, so no one can log in |
| `20261006010000_platform_area_merchant_ops` | No row uses `MERCHANT_OPS` while the old app serves, so run `scripts/seed-platform-spaces.ts` only after promotion | Old Prisma client throws on reading `Space` / `PlatformGrant` |
| `20261022000200_job_run_one_running_per_job` | Short gap between migrate and promote | Old-code runs that collide or follow a crashed run are not recorded in `JobRun`. The jobs still execute (`lib/jobs/run.ts:131-141` start write is non-fatal). Ledger and health views go stale; this is not an outage |
| `20261004000000_plaid_identity_global_exclusivity` | none needed | A contested PLAID identity write by old code now fails, but `dualWriteProviderAccountIdentity` swallows it |
| `20261002000000_tenancy_integrity` | none needed | Old writers already comply (cutover plan §2 row 20; re-checked for `MerchantRule` above) |

**Consequences for the cutover:**
- **Migrate-then-deploy: viable.** No maintenance window is required. Run it in the dispatch-free window, because #21 holds ACCESS EXCLUSIVE locks on 48 live tables until it commits, and old requests queue behind it for seconds.
- **Deploy-then-migrate: impossible.** The candidate reads the new columns and tables, and strict mode refuses to boot in Production without `DATABASE_URL_APP` / `AUTH` / `SYSTEM`. Those roles exist only after #21, and their passwords only after the owner sets them.
- **Maintenance window: not needed** under the conditions above. Keep the migrate → promote gap short, because of #41's ledger degradation and the `economicDate` backfill re-run.

## 5. Manual / owner actions at cutover

Nothing in the 47 requires superuser. Everything runs as Supabase `postgres` (CREATEROLE + BYPASSRLS, owner of the schema objects), as it did on Preview (doc 18: all nine `20261022*` applied with no NOTICE, ADMIN held on all four roles).

**Owner or manual steps the migrations do not do:**
1. **Before.** Take a logical dump with sha256 (checklist C3). Read the Production backups and PITR state (C1). Run §2, compare it with §3, and confirm the Production `DATABASE_URL` username is `postgres[.<ref>]`.
2. **Role passwords (after #21).** `fm_app`, `fm_auth` and `fm_system` are created `LOGIN` with **no password**, so they cannot authenticate yet. The owner sets them in the SQL editor as `ALTER ROLE fm_x WITH PASSWORD 'SCRAM-SHA-256$…'`, with verifiers computed locally from the `tmp/rls-preview-cutover/set-role-passwords.sql` template. `postgres` can do this because it holds ADMIN on roles it created (PG16+).
   - **Owner decision needed on `fm_backup`.** Cutover plan §3 leaves it passwordless (inert). Doc 20 §1 / checklist C2 says to set a password and verify `t,f,f,f,t`. The two documents disagree.
3. **Verify #46 applied.** `20261022000700_db006_role_statement_timeouts` downgrades a privilege failure to a NOTICE, and `prisma migrate deploy` does not surface NOTICEs as failures.
   - Check: `SELECT rolname, rolconfig FROM pg_roles WHERE rolname LIKE 'fm\_%'` must show `statement_timeout=15s` / `5s` / `60s` for `fm_app` / `fm_auth` / `fm_system`.
   - If not, apply by hand: `ALTER ROLE fm_app SET statement_timeout='15s'` (and 5s / 60s).
4. **Role safety settings, which are not in any migration** (cutover plan §3): `ALTER ROLE fm_app|fm_auth|fm_system SET idle_in_transaction_session_timeout='15s'` and `ALTER ROLE postgres SET idle_in_transaction_session_timeout='30s'`. Supavisor pool size 15 → 12 (dashboard).
5. **Vercel Production env before promoting the candidate:** `DATABASE_URL_APP`, `DATABASE_URL_AUTH`, `DATABASE_URL_SYSTEM` (username `<role>.<ref>`, transaction pooler `:6543`), `FM_RLS_STRICT=true`, `PLATFORM_ALERTS_EMAIL`. Re-prove each role URL with `select current_user`.
6. **Data steps outside migrations:**
   - `scripts/backfill-economic-date.ts`: after migrating, and again after promotion.
   - `scripts/seed-platform-spaces.ts`: **only after promotion** (#31).
   - Optional, owner decision D6: `scripts/backfill-flowtype.ts` / flow-authority backfill.
   - G6: `scripts/scrub-audit-emails.ts`.
7. **If a migration fails.** Prisma records it as failed and stops (P3009). Read the error, fix the cause (for example, classify a duplicate PLAID identity), then run `prisma migrate resolve --rolled-back <name>` and re-run. Never `DISABLE ROW LEVEL SECURITY`; fix forward.

**Steps that would need more than `postgres` (none expected):**
- `CREATE ROLE … BYPASSRLS` (#21) would need superuser on PG ≤15. On PG 17.6 it needs only that the creator holds BYPASSRLS (`env.current_user_bypassrls`).
- `ALTER ROLE … SET` (#46) and `ALTER ROLE … PASSWORD` (step 2) need ADMIN on the target role. That holds only if `postgres` itself created the roles (`env.fm_roles_present = []`).
