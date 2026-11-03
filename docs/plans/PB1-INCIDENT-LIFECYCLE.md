# PB-1 — Platform Ops incident lifecycle reliability (design)

> **Owner:** Session 1 · **Status:** ACTIVE · **Updated:** 2026-11-03 · **PRs:** #222

*Formerly `PB1-INCIDENT-LIFECYCLE-DESIGN-2026-11-01.md` (cited by #222); first committed 2026-11-03. This is the tracked home of the Platform Space alertness / incident-lifecycle workstream.*

**Date:** 2026-11-01 · **Owner priority:** 1 · **Status:** DESIGN — no code, schema, data or deploy change made.
**Code basis:** develop cut `7be29f3` (read via `git show 7be29f3:<path>`; the main worktree was not trusted). Every `file:line` below is at `7be29f3`.

**The problem.** Platform Ops and Customer Success show sync incidents that stay "active" forever. Two live examples:

- a brokerage Plaid Item (Brokerage A) showing *Investment data persistence failed*, open since 2026-07-30, recurred 5×;
- a self-custody wallet showing *Reading the market price*, open since 2026-08-19, 1×.

**Owner rule.** Each incident must be correlated with the exact operation that failed. A connection that reads "Up to date" does not prove recovery.

**Verification legend.** **[V]** = read in code at 7be29f3. **[U]** = not verified (needs data access or runtime evidence). No Production or Preview database was queried for this document.

---

## 1. Inventory

### 1.1 Lifecycle authority (the only writer)

| What | Where |
|---|---|
| Detection: `recordIncidentObservation`. Builds the key, converges on the open episode, links recurrence, appends an occurrence. | `lib/platform/incidents/lifecycle.ts:243-440` [V] |
| Convergence guard: one open episode per `incidentKey` (partial unique `WHERE resolved=false AND incidentKey IS NOT NULL`) | `prisma/migrations/20260726_ops2d5a1_sync_incident_lifecycle/migration.sql` (tail) [V] |
| Recurrence never reopens a resolved row. It creates a new episode with `previousIncidentId`. | `lifecycle.ts:385-409` [V] |
| Events (`nature==="event"`) are stored as already closed (`resolved=true`, `resolvedAt=null`) and are never resolvable | `lifecycle.ts:343-363`, `lib/platform/incidents/invariant.ts` [V] |
| Write-path rule: only `lifecycle.ts` may write SyncIssue/Occurrence, and `"AUTOMATIC_RECOVERY is the only kind"` is pinned | `lib/platform/incidents/incident-boundary.test.ts:48,77,121` [V] |
| Facade used by every producer: `recordSyncIssue` (forwards `detail.runId` only) | `lib/plaid/syncIssues.ts:169-200` [V] |
| Ledger door: `ledger.recordIncident` stamps the envelope `runId`. `activeLedger()` is the ambient handle. | `lib/plaid/refresh-ledger.ts:615-631, 699-701` [V] |
| Identity: `v1::provider::scope::domain::operation`. A Plaid item is a bare id. Other scopes are `FINANCIAL_ACCOUNT:<id>` / `WALLET:<id>`. | `lib/platform/incidents/identity.ts` (`serializeScope`, `buildIncidentKey`) [V] |
| Operation registry `OPERATION_KEYS`. An unknown stage becomes `unregistered:<stage>`. | `lib/platform/incidents/operation-key.ts:55-136, 166-174` [V] |
| Operator wording `OPERATION_PHRASE` (`price` → "Reading the market price") | `lib/platform/sync-issue-semantics.ts:484-521` (map), `541-551` (`incidentOperationLabel`) [V] |
| Classifier: domain, severity, nature, `cursorBlocking` | `sync-issue-semantics.ts:182-298`; INVESTMENT_DATA_PERSISTENCE_FAILED `:218-223`, WALLET_SYNC_FAILED `:232-237` [V] |
| Derived state: `orphaned`/`superseded`/`evidence`/`recovered`/`active` | `sync-issue-semantics.ts:331-340` [V] |
| `incidentRecovery` (`automatic-available` only when `cursorBlocking`) | `sync-issue-semantics.ts:566-584` [V] |

### 1.2 Producers (who opens incidents)

| Operation key | Kind | Scope written | Producer | Carries `runId`? |
|---|---|---|---|---|
| `transaction-persist` (cursor held) | MISSING_ACCOUNT / TRANSACTION_PERSISTENCE_FAILED | plaidItemId | `lib/plaid/syncTransactions.ts:467-472, 1135-1144` | yes (`detail.runId`) [V] |
| `event-identity-persist` | UPSERT_ERROR | plaidItemId | `syncTransactions.ts:822-843` | [U] |
| `reparenting-refused` | UPSERT_ERROR, `cursorBlocking:false` | plaidItemId | `syncTransactions.ts:930` | [U] |
| `fingerprint-adoption-ambiguous` | UPSERT_ERROR, `cursorBlocking:false` | plaidItemId | `syncTransactions.ts:988-996` | [U] |
| `exchange-account-persist` | UPSERT_ERROR | plaidItemId (+plaidAccountId) | `lib/plaid/exchange-collision.ts:13-18` | no [V] |
| `investment-events-fetch` | INVESTMENT_DATA_PERSISTENCE_FAILED | plaidItemId | `lib/investments/investment-event-ingest.ts:300` | **no** [V] |
| `investment-events` (missing account) | MISSING_ACCOUNT | plaidItemId (+plaidAccountId) | `investment-event-ingest.ts:337` | **no** [V] |
| `reconstruction-repair` | INVESTMENT_DATA_PERSISTENCE_FAILED | plaidItemId (account only in `detail`) | `investment-event-ingest.ts:414` | **no** [V] |
| `investment-events-instrument` | INVESTMENT_DATA_PERSISTENCE_FAILED | plaidItemId (securityId only in `detail`) | `investment-event-ingest.ts:454` | **no** [V] |
| `investment-import-repair` | INVESTMENT_DATA_PERSISTENCE_FAILED | financialAccountId | `lib/investments/investment-import-commit.ts:384` | no [V] |
| `opening-position-repair` | INVESTMENT_DATA_PERSISTENCE_FAILED | financialAccountId | `lib/investments/opening-position.ts:275` | no [V] |
| `import-rollback-repair` | IMPORT_ROLLBACK_FAILED | financialAccountId | `app/api/imports/[id]/rollback/route.ts:290` | no [V] |
| `discovery` / `balance` / `price` / `capture` | WALLET_SYNC_FAILED, provider WALLET | financialAccountId | `lib/crypto/btc-sync.ts:200-223` (calls at 293, 305, 847, 894, **930 price**, 944, 1128) | **no** [V] |
| `transactions` (BTC ledger short) | WALLET_SYNC_FAILED | financialAccountId | `btc-sync.ts:1105` | no. **Stage not registered.** [V] |
| `address` / `config` / `balance` / `capture` (EVM) | WALLET_SYNC_FAILED | financialAccountId | `lib/crypto/evm-native.ts:195-209` (calls 239-299) | no [V] |
| same (SOL) | WALLET_SYNC_FAILED | financialAccountId | `lib/crypto/sol-sync.ts:158-177` (calls 205-275) | no [V] |
| events (not conditions): `import-weak-ambiguous`, `import-strong-conflict`, INSTRUMENT_IDENTITY_CONFLICT, REMOVED_TOMBSTONE, BALANCE_TX_MISMATCH | — | — | `lib/investments/instrument-resolver-import.ts:178,195`, `instrument-resolver.ts:197`, `syncTransactions.ts:1215`, `lib/plaid/refresh.ts:481` | n/a |

### 1.3 Resolver(s)

There is exactly one: `resolveByAutomaticRecovery` (`lifecycle.ts:485-567`). It takes `domain: "transactions"` only (`:452`) and filters `nature==="condition" && domain===scope.domain && cursorBlocking` (`:507-515`). It is reached through:

- the facade `resolveCursorBlockingIssues` (`syncIssues.ts:104-128`);
- the ledger door `resolveIncidentsByRecovery` (`refresh-ledger.ts:633-650`).

Its only call site is the end of a successful transactions sync (`syncTransactions.ts:1317-1319`). `RESOLUTION_KIND_AUTOMATIC` is the only resolution kind (`lifecycle.ts:61-62`). [V]

### 1.4 Readers and UI

| Reader | Where | Notes |
|---|---|---|
| Canonical projection: `getActiveIncidentPage` / `getHistoricalIncidents` / `getIncidentDetail` | `lib/platform/incidents/projections.ts:181-192, 195-202, 205-226` | scans 200 unresolved rows, then filters `state==="active"` [V] |
| Orphan check `referentExistence` | `projections.ts:99-117` | id existence only (see §2.2) [V] |
| CS preview (6 shown, 200 scanned) | `lib/platform/incidents/preview.ts:44-112`, `preview-core.ts:121-200` | [V] |
| CS route `GET /api/platform/customer-success/sync-issues` (CUSTOMER_SUCCESS READ) | `app/api/platform/customer-success/sync-issues/route.ts:43-49` | [V] |
| Widget `cs_sync_issues` → `CsSyncIssuesWidget` → `IncidentPreview` | `components/platform/widgets/CsSyncIssuesWidget.tsx`; registered `components/platform/PlatformSpaceDashboard.tsx:207`; workspace `lib/platform/workspaces.ts:380` (`platform-incidents`); policy `lib/platform/policy.ts:219` | active-only. **No history view in CS.** [V] |
| Platform Ops "Attention required" (D5 projection) | `lib/platform/ops/attention.ts:104-117`, `incidents/platform-projection.ts` | [V] |
| Alert fold `foldSyncIncidents` | `lib/alerts/sync-incidents.ts` | counts `state==="active"` [V] |
| Convergence participants | `lib/platform/convergence/convergence.ts:141-200` | own copy of the existence-only orphan check [V] |
| Customer profile (≤50 unresolved) | `lib/platform/customer/customer-detail.ts:132-136` | `resolved:false`, no subject filter [V] |
| 14-day trend | `lib/platform/customer/incidents-daily.ts:39-56` | [V] |
| Member activity feed (column grant: id, kind, resolved, createdAt, financialAccountId, plaidTransactionId) | `app/api/spaces/[id]/activity/route.ts:502-526`; grant `prisma/migrations/20261002000500_rls_app_sync_issue_read` | reads `resolved` [V] |
| Wallet sweep de-prioritisation | `lib/crypto/wallet-refresh.ts:204-209` | `groupBy` max `lastOccurredAt`, any state [V] |
| Background history gate `countBlockingIssues` | `lib/plaid/backgroundHistorySync.ts:543` | [V] |

### 1.5 Retention

`jobs/data-retention.ts:111-125` (`RETENTION_RULES`) runs inside the `purge-trash` job at 07:30 UTC (`lib/jobs/registry.core.ts:145`, `jobs/purge-trash.ts:39-40`). [V]

| Table | Retention | Notes |
|---|---|---|
| RefreshExecution | **60 days** | RefreshEndpointResult, ProviderCall and RefreshEndpointAccountCoverage go with it by cascade (`:118-119`) |
| ProviderCall | **60 days** | also pruned directly (`:120-121`) |
| JobRun | **90 days** | (`:116-117`) |
| PlaidWebhookEvent | **30 days** | (`:122-123`) |
| SyncIssue | resolved rows only, 90 days after `resolvedAt` (else after `updatedAt`) | occurrences cascade (`:124-125`). **Unresolved rows are never pruned.** |
| AuditLog | never deleted (`:57`) | operator actions outlive everything |
| InvestmentEventCoverage, PositionReconstruction, InstrumentAlias | **not in the schedule** | survive indefinitely (only an FK cascade from PlaidItem/FinancialAccount hard-delete removes them, and removal is soft — §2.2) |

---

## 2. Root-cause confirmation

### 2.1 "Only one automatic resolver, covering only `cursorBlocking`" — **CONFIRMED, and wider than stated**

- `AutomaticRecoveryScope.domain` is typed as the literal `"transactions"` (`lifecycle.ts:452`). The filter requires `cursorBlocking` (`:514`). INVESTMENT_DATA_PERSISTENCE_FAILED and WALLET_SYNC_FAILED are both hard-coded `cursorBlocking:false` (`sync-issue-semantics.ts:218-237`), so no code path can ever close them.
- `incidentRecovery` therefore reports `"none"` for them (`:583`). The code's own comment calls this deferred to "OPS-2D-5B-2" (`:556-560`).
- The same holds for IMPORT_ROLLBACK_FAILED, all three non-cursor UPSERT_ERROR stages, `exchange-account-persist`, and the investments MISSING_ACCOUNT. **None has a resolver.**
- **Owner rule confirmed in code.** `btc-sync.ts:926-931` records the `price` incident and the sync carries on: it writes the quantity, then `touchWalletConnectionStatus({ok:true})` and `markWalletAccountConnectionSynced` (`:1131-1132`). The wallet reads "Up to date" while the price incident stays open.
- **Investments path.** It is non-fatal (`lib/plaid/sync-investments.ts:210-215`), so the Plaid item stays ACTIVE and up to date. "Up to date" is structurally unrelated to these operations.

### 2.2 "Removed connections stay active — orphan check ignores REVOKED / deletedAt" — **CONFIRMED**

- `referentExistence` asks only whether the id exists (`projections.ts:102-104`: `findMany({ where: { id: { in } } })`). The same applies to `convergence.ts:162-168` and `customer-detail.ts:132-136`.
- Removal never hard-deletes:
  - `lib/accounts/disconnect.ts:150-161` sets `FinancialAccount.deletedAt` and `AccountConnection.deletedAt`;
  - `lib/plaid/disconnect.ts:127` sets `PlaidItem.status = REVOKED` and keeps the row;
  - `lib/account-deletion/purge.ts:305,388` does the same.
- So a removed subject's incident is never `orphaned`. It stays `active` with a live-looking subject label: `preview.ts:58-71` resolves the institution of a deleted account.
- The `orphaned` state today is reachable only for genuinely missing ids, for example test-leak rows (`sync-issue-semantics.ts:319-330`).
- **[U]** Whether wallet removal also sets `Connection.status=REVOKED`. `FinancialAccount.deletedAt` alone is enough for this design.

### 2.3 "No age window / staleness" — **CONFIRMED**

- Nothing reads `lastOccurredAt` against a window.
- The active scan orders by `lastOccurredAt desc` and keeps whatever is unresolved (`projections.ts:184-190`).
- Retention excludes unresolved rows (`data-retention.ts:125`).

### 2.4 "No operator acknowledge / resolve / reopen" — **CONFIRMED**

- The only CS incident route is a GET (`sync-issues/route.ts:43`). There is no lifecycle function for an operator transition.
- The boundary test pins the single resolution kind (`incident-boundary.test.ts:121`), so adding one is a deliberate test change.
- `OperatorTargetKind` has no incident kind (`lib/audit.ts:199-212`).

### 2.5 "Evidence expires (≈60/30 days) before the incident does" — **CONFIRMED, NUANCED**

- **Confirmed for the failure side.** RefreshExecution and its children expire at 60 days. `SyncIssueOccurrence.refreshExecutionId` is a soft reference (schema 3782-3786), so after 60 days it points at nothing, and the projection cannot tell "never correlated" from "expired" (`projections.ts:223` only checks null).
- **Nuance 1: it does not block recovery.** Proof of recovery has to be *newer* than `lastOccurredAt`. For an operation that is succeeding today, that proof is recent and still inside the 60-day window. Retention destroys the forensic context of the original failure, not the ability to resolve.
- **Nuance 2: for investment and wallet incidents there was never correlation evidence to lose.** Those producers pass no `runId`, so `refreshExecutionId` is null from birth (§2.6).

### 2.6 Additional findings

| ID | Finding | Evidence |
|---|---|---|
| **F1** | **Investment and wallet incidents are uncorrelated by construction.** None of the producers in §1.2 marked "no" put `runId` in `detail`, and `recordSyncIssue` reads only `detail.runId` (`syncIssues.ts:183-184`). Yet both run inside a refresh envelope: `runFullRefresh` establishes the provider-call context whenever its start write lands (`refresh-execution.ts:507`), and wallet syncs open one with `source {kind:"WALLET", ref: accountId}` (`wallet-sync-dispatch.ts:672-674`). The ambient `activeLedger()` exists and is unused by these producers. This violates the owner's correlation rule today. | [V] |
| **F2** | **`INVESTMENT_ACTIVITY` stage is declared but never recorded.** `refresh-execution-types.ts:131` declares it. `ingestInvestmentEvents` returns metrics (`failed`, `unresolvedInstrument`, `inserted`) that `sync-investments.ts:212` discards. The only durable per-attempt fact for investment events is `InvestmentEventCoverage` (`attemptId`, `outcome`, `attemptedAt`). | [V] |
| **F3** | **Item-level keys collapse account- and security-level failures.** `reconstruction-repair` (account) and `investment-events-instrument` (securityId) are keyed on the item. The episode's `detail` is the first observation only (`lifecycle.ts:303-314`). The full subject set lives only in occurrence `detail`. A resolver must prove every subject named across occurrences, not just the first. This may explain the Brokerage A "5×" (several accounts or securities, one episode). **[U]** for the live row. | [V] / [U] |
| **F4** | **The BTC `transactions` stage is unregistered.** It keys as `unregistered:transactions`, `incidentOperationLabel` returns null, and the operator sees no operation phrase. | `operation-key.ts:55-136` (absent); `btc-sync.ts:1105` [V] |
| **F5** | **Active scan budget is spent before filtering.** `getActiveIncidentPage` takes 200 unresolved rows, then drops orphaned/superseded ones (`projections.ts:184-190`). Once §2.2 is fixed, removed-subject rows would still eat the budget unless they are *persisted* closed. This argues for persisting SUBJECT_REMOVED rather than deriving it. | [V] |
| **F6** | **Legacy rows without a key cannot converge.** Pre-07-26 unresolved rows (`incidentKey` null) are exempt from the partial index. A new failure on the same subject opens a keyed episode beside them, giving two open rows for one problem. | migration comment + `lifecycle.ts:366` [V] |
| **F7** | **Operator transitions cannot use the incident client contract unchanged.** `IncidentClient` deliberately rejects transaction clients (`lifecycle.ts:95-144`). `recordOperatorAction` must be written in the same transaction as the change (`lib/audit.ts:395-401`). The operator path is the operation itself, not telemetry, so it needs its own lifecycle function that opens its own `$transaction` on the root client. | [V] |
| **F8** | **The wallet sweep's de-prioritisation reads `lastOccurredAt` of any WALLET_SYNC_FAILED episode, open or closed** (`wallet-refresh.ts:204-209`). This design does not change it, but a resolved episode keeps de-prioritising for up to 3 h. That is by design ("recent failure"). | [V] |

---

## 3. Proposed state machine

### 3.1 States

These apply to CONDITIONS only. Events stay closed evidence (existing invariant).

| State | Meaning | `resolved` (compat column) |
|---|---|---|
| **ACTIVE** | Failure observed. No proof of recovery. Subject live. | false |
| **ACKNOWLEDGED** | ACTIVE, and an operator has taken ownership. Still broken. | false |
| **RECOVERING** | At least one qualifying success fact newer than `lastOccurredAt`, but the confirmation rule (§4) is not met yet. | false |
| **STALE** | ACTIVE or ACKNOWLEDGED, no new occurrence within the operation's window, **and** no attempt evidence either way. "Unverified", not "fixed". | false |
| **RESOLVED** | Closed with a stated reason: `AUTOMATIC_RECOVERY` (evidence), `OPERATOR_RESOLVED`, or `SUBJECT_REMOVED`. | true |
| **REOPENED** | Display state for an ACTIVE episode with `previousIncidentId` set. It is a new episode in the chain, never a mutation of the resolved row (existing invariant `lifecycle.ts:385-409`). | false |

`resolved=false` for every non-RESOLVED state keeps the partial unique index meaning "one non-closed episode per key". A recurrence therefore **converges onto** an ACKNOWLEDGED, RECOVERING or STALE episode (same row) and moves it back to ACTIVE. Only RESOLVED rows spawn a new generation.

### 3.2 Transitions (exact triggers)

| From → To | Trigger | Actor |
|---|---|---|
| ∅ → ACTIVE | `recordIncidentObservation`, no open episode for the key. `openedBy='OBSERVATION'`. | system |
| RESOLVED → (new) ACTIVE, shown as REOPENED | Observation for a key whose latest episode is RESOLVED (existing). New row, `previousIncidentId` set, `openedBy='RECURRENCE'`. | system |
| ACTIVE → ACKNOWLEDGED | Operator `acknowledge`. Sets `acknowledgedAt`, `acknowledgedById`, `acknowledgedAuditId`. | operator |
| ACK / RECOVERING / STALE → ACTIVE | New occurrence on the open episode: `lastOccurredAt` moves, and `recoveringSince`/`staleSince` are cleared. **Acknowledgement is kept, with a "recurred since acknowledged" flag** (`lastOccurredAt > acknowledgedAt`), so ownership is not lost but the operator sees it recur. | system |
| ACTIVE / ACK / STALE → RECOVERING | The per-operation resolver (§4) finds a qualifying success fact for the same subject and operation, after `lastOccurredAt`, and confirmation is not met. Sets `recoveringSince` and `resolutionEvidence` (provisional), and increments `recoveryEvidenceCount`. | system |
| RECOVERING (or ACTIVE, for single-proof rules) → RESOLVED / AUTOMATIC_RECOVERY | Confirmation met. Default: **2 qualifying success facts from 2 distinct executions or attempts, both after `lastOccurredAt`, with no occurrence in between.** The existing cursor-blocking rule stays single-proof (no regression). `resolvingExecutionId` is set, plus the frozen `resolutionEvidence`. | system |
| any open → RESOLVED / SUBJECT_REMOVED | Subject removal. Inline from the removal path, with a read-time backstop (§5). | system |
| any open → RESOLVED / OPERATOR_RESOLVED | Operator `resolve`, reason required (§6). | operator |
| ACTIVE / ACK → STALE | **Derived at read time, not by a job** (§9): `now − lastOccurredAt > staleAfter(operation)` **and** no attempt evidence of that operation for that subject after `lastOccurredAt`. `staleSince` is written lazily by the next lifecycle write, or by the optional sweep. | system |
| RESOLVED (operator- or removal-closed) → (new) ACTIVE | Operator `reopen` with a reason (§6). Creates a new generation with `previousIncidentId` and `openedBy='OPERATOR_REOPEN'`. **Refused (409)** if an open episode for the key already exists; the response names it. | operator |

**Never a trigger:**

- `PlaidItem.status=ACTIVE`, `Connection.lastSyncedAt`, `FinancialAccount.syncStatus="synced"`, or "Up to date";
- the passage of time on its own (that gives STALE, never RESOLVED);
- a success of a *different* operation on the same subject.

### 3.3 Schema additions

All additive, all nullable or defaulted. No rewrite of existing rows. No column dropped. `resolved` stays the compatibility projection.

On **`SyncIssue`**:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `lifecycleState` | `TEXT` | NULL | `ACTIVE`/`ACKNOWLEDGED`/`RECOVERING`/`STALE`/`RESOLVED`. NULL on legacy rows, where readers derive it from `resolved`. |
| `openedBy` | `TEXT` | NULL | `OBSERVATION`/`RECURRENCE`/`OPERATOR_REOPEN` |
| `acknowledgedAt` | `TIMESTAMP(3)` | NULL | |
| `acknowledgedById` | `TEXT` | NULL | operator userId (soft ref) |
| `acknowledgedAuditId` | `TEXT` | NULL | AuditLog.id from `recordOperatorAction` |
| `recoveringSince` | `TIMESTAMP(3)` | NULL | |
| `recoveryEvidenceCount` | `INTEGER` | `0` NOT NULL DEFAULT | |
| `staleSince` | `TIMESTAMP(3)` | NULL | lazily persisted, for display |
| `lastEvidenceCheckedAt` | `TIMESTAMP(3)` | NULL | resolver bookkeeping |
| `resolvedById` | `TEXT` | NULL | operator, for OPERATOR_RESOLVED |
| `resolutionReasonCode` | `TEXT` | NULL | `OPERATOR_REASON_CODES` value or a resolver rule id |
| `resolutionAuditId` | `TEXT` | NULL | AuditLog.id |
| `resolutionEvidence` | `JSONB` | NULL | frozen proof summary (§8), size-capped |

On **`SyncIssueOccurrence`**:

| Column | Type | Default | Purpose |
|---|---|---|---|
| `evidenceSummary` | `JSONB` | NULL | frozen summary of the failing execution/stage at observation time (§8) |

Further changes:

- **Indexes:** `SyncIssue(lifecycleState, lastOccurredAt)` for the CS lists. The partial unique index is unchanged.
- **Resolution kinds.** `RESOLUTION_KIND_AUTOMATIC` stays. Add `OPERATOR_RESOLVED` and `SUBJECT_REMOVED` beside it in `lifecycle.ts`. Update `invariant.ts` so that `OPERATOR_RESOLVED` requires `resolvedById` and `resolutionAuditId`, and `SUBJECT_REMOVED` requires `resolutionEvidence.subject`. Update the boundary test pin `incident-boundary.test.ts:121` deliberately.
- **Enum additions (additive):**
  - `AuditAction`: `SYNC_INCIDENT_ACKNOWLEDGED`, `SYNC_INCIDENT_RESOLVED`, `SYNC_INCIDENT_REOPENED`;
  - `OperatorTargetKind`: `"SYNC_INCIDENT"` (TS union, `lib/audit.ts:199`).
- **RLS.** The new columns are **not** added to the fm_app column grant (`20261002000500_rls_app_sync_issue_read`); the member feed keeps reading `resolved` only. SyncIssue stays fm_system for all writes.
- **Migration.** Run through the guarded procedure (`db:migrate:safe`). Preview first, Production by owner. Per standing memory, never run `prisma migrate dev` non-interactively.

---

## 4. Per-condition evidence-based resolvers

### 4.1 General rule (all resolvers)

A resolver may close or advance an incident only when **all** of these hold:

1. The success fact names the **same subject**: item id, account id or wallet account id, matched exactly. Never by institution or user.
2. It names the **same operation**: a stage or endpoint that executes that operation key.
3. It is strictly after `lastOccurredAt`.
4. No occurrence of the same `incidentKey` was recorded within the same execution or attempt. This is the "clean attempt" test: the code path that would have recorded the failure ran and did not.

Resolvers are invoked **inline** at the end of the producing operation, inside the same envelope, through the ledger door — the same pattern as `syncTransactions.ts:1317`. A sweep (slice S7) is only a backstop.

### 4.2 Resolver table

| Operation key (kind) | Proof that the same operation succeeded for the same subject | Table / column | Confirmation |
|---|---|---|---|
| `transaction-persist` (cursorBlocking) | Completed `syncTransactionsForItem` for the item (cursor advanced only after every row persisted) | existing; `RefreshExecution.id` via `runId` | single proof (unchanged) |
| `investment-events-fetch` | A later fetch attempt for the item where the provider answered | `InvestmentEventCoverage(plaidItemId, outcome IN (COMPLETE, PARTIAL), attemptedAt > lastOccurredAt)`, grouped by `attemptId` | 2 distinct `attemptId`s. Brokerage A recurred 5×, so this is a flapping case. |
| `investment-events-instrument` | Every `securityId` named across the episode's occurrences now resolves: an `InstrumentAlias(provider=PLAID_PROVIDER, externalId=securityId)` exists, **and** a later clean ingest attempt for the item exists (coverage COMPLETE/PARTIAL after `lastOccurredAt`, with no new occurrence in that attempt) | `InstrumentAlias.provider/externalId` (`instrument-resolver.ts:153-154, 225-227`); `SyncIssueOccurrence.detail->>'securityId'`; `InvestmentEventCoverage` | all securities proven → RESOLVED; some → RECOVERING |
| `reconstruction-repair` | For every `financialAccountId` named across the episode's occurrences, a later reconstruction row exists | `PositionReconstruction(financialAccountId, runAt > lastOccurredAt, reconciliation <> FAILED)`; account ids from occurrence `detail` | all accounts → RESOLVED; partial → RECOVERING. **Caveat:** the repair is bounded to affected instruments, so a newer `runAt` on *some* instrument of the account is weaker than proof for *the* failed instruments. Ship as RECOVERING-only first, and promote to RESOLVED only after S1 adds the instrument set to occurrence detail. |
| `investments/MISSING_ACCOUNT` (`investment-events`) | Every `plaidAccountId` across the episode's occurrences now maps to a live account | `ProviderAccountIdentity(provider=PLAID, externalAccountId)` → `FinancialAccount.deletedAt IS NULL` | all mapped, plus a later clean ingest attempt |
| `investment-import-repair` | No durable per-import success fact | — | **No automatic resolution; operator action or STALE only.** |
| `opening-position-repair` | No durable per-assertion success fact | — | **No automatic resolution; operator action or STALE only.** |
| `import-rollback-repair` | Rollback committed (`ImportBatch.status=ROLLED_BACK` for `detail.importBatchId`), but the *failed part* is the post-rollback repair (`rollback/route.ts:270-290`). A later `PositionReconstruction.runAt` for the account is suggestive only. | `ImportBatch.status`, `PositionReconstruction.runAt` | **RECOVERING at most; RESOLVED by operator only.** |
| `price` (WALLET, BTC; ADAPTER_VALUED) | VALUATION stage SUCCEEDED for that wallet account | `RefreshEndpointResult(endpoint='VALUATION', status='SUCCEEDED', coveredAccountIds ∋ accountId, completedAt > lastOccurredAt)` joined `RefreshExecution(sourceKind='WALLET', sourceRef=accountId)` (`wallet-sync-dispatch.ts:476-479`) | 2 executions |
| `balance` / `address` / `config` / `capture` (WALLET, all chains) | WALLET_SYNC stage SUCCEEDED for the account. The adapter returns `ok:true` only past balance read, address/config checks and the spine capture (`btc-sync.ts:1024-1027`, `evm-native.ts:232-300`, `sol-sync.ts:199-280`). | `RefreshEndpointResult(endpoint='WALLET_SYNC', status='SUCCEEDED')` + `RefreshExecution(sourceRef=accountId)` | 2 executions |
| `discovery` (WALLET xpub) | WALLET_SYNC SUCCEEDED **and** no `discovery` occurrence in that execution. This is needed because `NO_USED_ADDRESSES` is recorded on an `ok:true` run (`btc-sync.ts:1127-1129`). | as above + clean-attempt test | 2 executions |
| `unregistered:transactions` (BTC ledger short) | TRANSACTIONS stage SUCCEEDED **and** the ledger reconciled. `ledgerComplete` is only reflected in `FinancialAccount.syncStatus='synced'`, which is not operation-scoped. | `RefreshEndpointResult(endpoint='TRANSACTIONS')` + clean-attempt test | Register the operation first (S1). Until then: **RECOVERING at most; operator resolve.** |
| `event-identity-persist`, `reparenting-refused`, `fingerprint-adoption-ambiguous` | Not cursor-blocking. The transaction committed and the cursor advanced, so Plaid never re-delivers it, and a later clean sync proves nothing about that row (`syncIssues.ts:91-99`). | — | **No automatic resolution; operator action or STALE only.** |
| `exchange-account-persist` | A later exchange or refresh where `ProviderAccountIdentity` for `plaidAccountId` maps to a live account | `ProviderAccountIdentity` | single proof + operator confirmation recommended. **[U]**: collision semantics need a closer read before automating. |
| legacy rows (`incidentKey` NULL) | Identity unknown | — | **No automatic resolution; operator action or STALE only** (F6) |

**Prerequisite for every row above (slice S1).** Producers must carry the correlator. The `recordSyncIssue` facade adopts the ambient `activeLedger()` when `detail.runId` is absent, so occurrences get `refreshExecutionId`. The investment producers also put `attemptId` (coverage) into `detail`. That is what makes the clean-attempt test (rule 4) decidable.

---

## 5. Removed-connection handling

- **Rule.** A subject is *removed* when any of these holds:
  - `FinancialAccount.deletedAt IS NOT NULL` (account- or wallet-scoped);
  - `PlaidItem.status = REVOKED` (item-scoped);
  - the row is genuinely missing.
- **Resolution.** The incident is closed `RESOLVED / SUBJECT_REMOVED` with `resolutionEvidence = {subject:{kind,id,state:'DELETED'|'REVOKED'|'MISSING', observedAt}}`. It is **never** `AUTOMATIC_RECOVERY`, and the UI says "Closed — connection removed", never "Recovered".
- **Inline closure.** Call `resolveBySubjectRemoval({plaidItemId?|financialAccountIds[]})` from:
  - `lib/accounts/disconnect.ts` after the soft delete (`:150-161`);
  - `lib/plaid/disconnect.ts` after `setHealth(REVOKED)` (`:127`);
  - `lib/account-deletion/purge.ts:305,388`.

  These are outside the caller's transaction, following the OPS-2D-TX-1 rule.
- **Backstop.**
  - `referentExistence` (`projections.ts:99-117`) and `convergence.ts:162-168` select `deletedAt` and `status`, and treat removed subjects as `orphaned` at read time.
  - The optional sweep (S7) persists the closure, so removed rows stop consuming the 200-row scan (F5).
  - `customer-detail.ts:132` uses the same filter.
- **Restore.** `app/api/accounts/[id]/restore/route.ts` brings an account back. This does **not** reopen the closed episode. The next failure opens a new generation linked by `previousIncidentId`. This is deliberate: a restore is not evidence the old failure persists.

---

## 6. Operator actions

All three run through **one new lifecycle function**, `applyOperatorTransition` in `lib/platform/incidents/lifecycle.ts`. The boundary rule stands: only this module writes SyncIssue.

- It opens its own `systemDb.$transaction` (F7).
- Inside that transaction it re-reads the row and checks the state precondition (compare-and-set on `lifecycleState` + `updatedAt`, which gives 409 on conflict), writes the transition, and calls `recordOperatorAction(tx, …)` (`lib/audit.ts:402`).
- It stores the returned AuditLog id on the row.

| Action | Route (new) | Permission | Reason | Precondition |
|---|---|---|---|---|
| acknowledge | `POST /api/platform/customer-success/sync-issues/[id]/acknowledge` | `requireFreshPlatformAccess("CUSTOMER_SUCCESS","WRITE")` (pattern: `customers/[userId]/access/route.ts:44`) | optional `{code, note?}` | ACTIVE / STALE / RECOVERING |
| resolve | `…/[id]/resolve` | same | **required**. Add to `REASON_REQUIRED_ACTIONS`. Codes: `INCIDENT`, `SUPPORT_REQUEST`, `TESTING`, `OTHER`. Note ≤280 chars, scrubbed by `assertOperatorNoteSafe` (`lib/audit.ts:333-341`). | any non-RESOLVED condition. Never an event. |
| reopen | `…/[id]/reopen` | same | **required** | RESOLVED with kind OPERATOR_RESOLVED or SUBJECT_REMOVED (an AUTOMATIC_RECOVERY reopen is allowed with a reason); no open episode for the key |

Per the owner's SoD ruling (2026-11-01), one System Admin may perform all three; no two-person rule.

**Audit envelope** (`OperatorActionInput`, `lib/audit.ts:310-323`):

- `actor = operatorActorFrom(auth)`;
- `target = {kind:"SYNC_INCIDENT", id: syncIssueId}`;
- `change = {before:{lifecycleState, resolved}, after:{…}}`;
- `execution = {refreshExecutionId: resolvingExecutionId|null}`;
- `detail = {incidentKeyOperation, kind, domain}`. These are ids and enums only: no `detail`, no customer data.

Add the three routes to the adoption ratchet `lib/platform/operator-action-adoption.test.ts`.

**Recurrence after operator action:**

- **After acknowledge**, a new occurrence converges onto the same row: state goes back to ACTIVE, the acknowledgement is kept, and "recurred since acknowledged" is set.
- **After operator resolve**, a new occurrence opens a new episode (`openedBy='RECURRENCE'`, `previousIncidentId` = the operator-resolved row). It shows as **REOPENED** with "previously resolved by an operator on <date>: <code>".

Automatic transitions write no AuditLog. They are system facts and are persisted on the row with their evidence. This matches the existing `AUTOMATIC_RECOVERY` behaviour.

---

## 7. UX — Customer Success incidents workspace

Use the existing workspace `platform-incidents` / section `cs_sync_issues` (`workspaces.ts:380`). Add **views** inside the section rather than new section keys. A new section key needs `platform:seed-spaces` on every environment (standing memory).

**Broken now** (default view):

- Includes: CONDITIONS with subject live and state ∈ {ACTIVE, REOPENED, ACKNOWLEDGED, RECOVERING}.
- Each row shows:
  - the operation phrase (`incidentOperationLabel`), never just the kind label;
  - the subject (minimised, `account-label.ts`);
  - first and last seen, and occurrence count;
  - **"Last attempt of this operation"**: *failed at T* / *succeeded at T (1 of 2 confirmations)* / *no attempt recorded since last failure*. This comes from the resolver's evidence, not from connection status;
  - the acknowledgement owner, if any.
- RECOVERING rows sort below ACTIVE.
- Severity counts and the alert fold (`lib/alerts/sync-incidents.ts`) cover ACTIVE + REOPENED + ACKNOWLEDGED. Whether alerts keep re-firing for ACKNOWLEDGED is an **owner decision (Q1)**.

**Needs verification:** STALE rows. They are not counted as broken and not alerting, with the explanation "No failure for N days, but the operation has not been proven to succeed". Actions: Resolve (with reason) or Acknowledge.

**History:** RESOLVED, grouped by kind:

- *Recovered (evidence)*, linking the frozen `resolutionEvidence`;
- *Resolved by operator* (code, operator, AuditLog link to the Security Ops operator-actions feed);
- *Closed — connection removed*;

plus *evidence* events and *superseded*. Backed by `getHistoricalIncidents` (`projections.ts:195`), paged by `lastOccurredAt`. The episode chain (`previousIncidentId`) is shown as "Recurrence of …".

**Detail drawer:** occurrences with execution links. A correlated-but-expired execution renders "Execution evidence expired (retained 60 days) — summary: …" from `evidenceSummary`, which is distinct from "not correlated".

**Platform Ops Attention** (`attention.ts`) and the customer profile (`customer-detail.ts:132`) read the same "broken now" predicate. There is one shared function, so no second classifier.

---

## 8. Retention — evidence that outlives the raw ledger

**`SyncIssue.resolutionEvidence`** is a frozen summary, written once at RESOLVED or provisionally at RECOVERING. Capped at about 2 KB and validated by a pure builder:

```json
{
  "rule": "wallet.price.valuation-succeeded.v1",
  "confirmations": 2,
  "facts": [
    { "source": "RefreshEndpointResult", "executionId": "…", "runId": "…",
      "endpoint": "VALUATION", "status": "SUCCEEDED", "completedAt": "…",
      "coveredAccountIds": ["…"], "recordsRead": null, "recordsChanged": null,
      "durationMs": 412, "deploymentSha": "…" }
  ],
  "subject": { "kind": "FINANCIAL_ACCOUNT", "id": "…" }
}
```

- Coverage-based rules record `{source:"InvestmentEventCoverage", attemptId, outcome, fetchedCount, pagesFetched, attemptedAt}`.
- Operator closures record `{auditId}` only; the reason lives in AuditLog, which is never deleted.

**`SyncIssueOccurrence.evidenceSummary`** is written at observation when a correlated execution exists:

```
{ executionId, runId, trigger, profile, overallStatus-at-write | "RUNNING",
  endpoint, deploymentSha, startedAt }
```

The occurrence is written mid-run, so `overallStatus` may be RUNNING. The resolver later back-fills the stage's final status when it runs in the same envelope.

**Rules:**

- **No raw-evidence retention change is proposed.** RefreshExecution stays at 60 days.
- **SyncIssue retention** (`data-retention.ts:124-125`) is unchanged: resolved rows go 90 days after `resolvedAt`, which still outlives the 60-day raw ledger. STALE and open rows are never auto-deleted. Rows STALE for more than 180 days appear in a "long-stale" filter for operator closure. No automatic deletion is proposed.
- **Projection change:** distinguish `refreshExecutionId IS NULL` (never correlated) from a dangling reference (expired).

---

## 9. Preview cron parity and testing

**Crons do not run on Preview.**

- `vercel.json` has two crons (`/api/jobs/dispatch` */15, `/api/jobs/resume-stale-imports` */5). Vercel runs crons on Production deployments only.
- The dispatch route says so explicitly: "Preview (no crons)" (`app/api/jobs/dispatch/route.ts:29-30`).
- The only targeted wake is `?only=` with the hard-coded allowlist `["comms-automations"]` (`lib/jobs/dispatch.ts:178`).
- This matches standing memory ("crons never run on Preview").

**Design consequence.** Nothing in the core lifecycle depends on a job:

- resolvers run inline at the end of the producing operation (manual Refresh on Preview exercises them);
- STALE and subject-removal backstops are derived at read time.

The optional sweep (S7) would be a registered job. If Preview needs it, extend `SINGLE_JOB_DISPATCH_ALLOWLIST` with `incident-lifecycle-sweep`. That is a routine change: inform, not ask.

**Test plan, per slice:**

1. **Pure unit tests** with fake clients, in the existing pattern (`lifecycle.test.ts`, `sync-issue-semantics.test.ts`): each resolver rule's positive and negative cases, covering:
   - wrong subject;
   - wrong operation;
   - proof older than `lastOccurredAt`;
   - occurrence inside the proving attempt;
   - partial multi-subject;
   - confirmation counting.
2. **Invariant tests:** new kinds in `invariant.ts`; event rows never transition.
3. **Boundary and adoption ratchets:**
   - `incident-boundary.test.ts`: only lifecycle writes, resolution-kind set updated;
   - `operator-action-adoption.test.ts`: three new routes.
4. **Disposable-PG harness**, extending `scripts/test-incident-transaction-safety.ts` / `scripts/test-incident-preview-path.ts`:
   - partial-index convergence onto ACK/RECOVERING/STALE rows;
   - concurrent operator resolve vs observation (CAS → 409);
   - operator reopen refused when an open episode exists.
5. **Preview acceptance** (after the guarded Preview migration):
   - manual Refresh of a Preview sandbox Plaid item, then confirm a seeded or real investments incident moves to RECOVERING with frozen evidence;
   - wallet Refresh (BTC) for the price rule;
   - disconnect a sandbox account → SUBJECT_REMOVED;
   - acknowledge / resolve / reopen through the CS UI, verified **on the server** (row + AuditLog). Standing memory says UI reports are unreliable, so verify server state.

---

## 10. Historical reconciliation — DRY RUN ONLY

> **Executing any transition on Production requires separate, explicit owner approval.** This section defines a read-only query and its expected output. It does not authorise writes. The Production read access path itself is an owner matter: `fm_diag_ro` was not created (standing memory). Run on Preview first.

**Execution envelope.** `psql -1 -v ON_ERROR_STOP=1`, with `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`. **Never** a session-level `SET` through the pooler (standing memory, 2026-10-25 incident).

```sql
BEGIN;
SET TRANSACTION READ ONLY;
WITH oi AS (
  SELECT si.id, si.kind::text AS kind, si.provider, si."plaidItemId", si."financialAccountId",
         si."incidentKey", split_part(si."incidentKey", '::', 5) AS operation,
         si."firstOccurredAt", si."lastOccurredAt",
         (SELECT count(*) FROM "SyncIssueOccurrence" o WHERE o."syncIssueId" = si.id) AS occurrences,
         (SELECT count(*) FROM "SyncIssueOccurrence" o WHERE o."syncIssueId" = si.id
                                                      AND o."refreshExecutionId" IS NOT NULL) AS correlated
  FROM "SyncIssue" si
  WHERE si.resolved = false
),
subj AS (
  SELECT oi.id,
    CASE
      WHEN oi."financialAccountId" IS NOT NULL AND fa.id IS NULL           THEN 'MISSING'
      WHEN fa."deletedAt" IS NOT NULL                                      THEN 'DELETED'
      WHEN oi."plaidItemId" IS NOT NULL AND pi.id IS NULL                  THEN 'MISSING'
      WHEN pi.status = 'REVOKED'                                           THEN 'REVOKED'
      WHEN oi."financialAccountId" IS NULL AND oi."plaidItemId" IS NULL    THEN 'UNSCOPED'
      ELSE 'LIVE' END AS subject_state
  FROM oi
  LEFT JOIN "FinancialAccount" fa ON fa.id = oi."financialAccountId"
  LEFT JOIN "PlaidItem"        pi ON pi.id = oi."plaidItemId"
),
wallet_proof AS (       -- §4: VALUATION for price, TRANSACTIONS for the ledger stage, WALLET_SYNC otherwise
  SELECT oi.id, count(DISTINCT e.id) AS proofs, max(r."completedAt") AS last_proof_at,
         (array_agg(e.id ORDER BY r."completedAt" DESC))[1] AS proof_execution_id
  FROM oi
  JOIN "RefreshExecution" e      ON e."sourceKind" = 'WALLET' AND e."sourceRef" = oi."financialAccountId"
  JOIN "RefreshEndpointResult" r ON r."refreshExecutionId" = e.id
  WHERE oi.kind = 'WALLET_SYNC_FAILED'
    AND r.status = 'SUCCEEDED'
    AND r."completedAt" > oi."lastOccurredAt"
    AND r.endpoint = CASE oi.operation WHEN 'price' THEN 'VALUATION'
                                       WHEN 'unregistered:transactions' THEN 'TRANSACTIONS'
                                       ELSE 'WALLET_SYNC' END
  GROUP BY oi.id
),
fetch_proof AS (
  SELECT oi.id, count(DISTINCT c."attemptId") AS proofs, max(c."attemptedAt") AS last_proof_at
  FROM oi JOIN "InvestmentEventCoverage" c ON c."plaidItemId" = oi."plaidItemId"
  WHERE oi.operation = 'investment-events-fetch'
    AND c.outcome IN ('COMPLETE','PARTIAL') AND c."attemptedAt" > oi."lastOccurredAt"
  GROUP BY oi.id
),
instrument_subjects AS (
  SELECT oi.id, o.detail->>'securityId' AS security_id,
         EXISTS (SELECT 1 FROM "InstrumentAlias" a
                 WHERE a.provider = 'plaid' AND a."externalId" = o.detail->>'securityId') AS resolved_now
  FROM oi JOIN "SyncIssueOccurrence" o ON o."syncIssueId" = oi.id
  WHERE oi.operation = 'investment-events-instrument' AND o.detail ? 'securityId'
),
recon_subjects AS (
  SELECT oi.id, o.detail->>'financialAccountId' AS account_id,
         EXISTS (SELECT 1 FROM "PositionReconstruction" pr
                 WHERE pr."financialAccountId" = o.detail->>'financialAccountId'
                   AND pr."runAt" > oi."lastOccurredAt" AND pr.reconciliation <> 'FAILED') AS rebuilt_since
  FROM oi JOIN "SyncIssueOccurrence" o ON o."syncIssueId" = oi.id
  WHERE oi.operation = 'reconstruction-repair'
)
SELECT oi.id, oi.kind, oi.provider, oi.operation, s.subject_state,
       oi."firstOccurredAt", oi."lastOccurredAt", oi.occurrences, oi.correlated,
       COALESCE(w.proofs, f.proofs, 0) AS proofs,
       COALESCE(w.last_proof_at, f.last_proof_at) AS last_proof_at,
       w.proof_execution_id,
       (SELECT count(*) FILTER (WHERE NOT resolved_now) FROM instrument_subjects i WHERE i.id = oi.id) AS unresolved_securities,
       (SELECT count(DISTINCT account_id) FILTER (WHERE NOT rebuilt_since) FROM recon_subjects rs WHERE rs.id = oi.id) AS unrebuilt_accounts,
       CASE
         WHEN s.subject_state IN ('DELETED','REVOKED','MISSING')                  THEN 'CLOSE_SUBJECT_REMOVED'
         WHEN oi."incidentKey" IS NULL                                            THEN 'LEGACY_OPERATOR_REVIEW'
         WHEN COALESCE(w.proofs, f.proofs, 0) >= 2                                THEN 'RESOLVE_WITH_EVIDENCE'
         WHEN COALESCE(w.proofs, f.proofs, 0) = 1                                 THEN 'RECOVERING'
         WHEN oi."lastOccurredAt" < now() - interval '14 days'                    THEN 'STALE'
         ELSE 'KEEP_ACTIVE' END AS proposed
FROM oi
JOIN subj s USING (id)
LEFT JOIN wallet_proof w USING (id)
LEFT JOIN fetch_proof  f USING (id)
ORDER BY proposed, oi."lastOccurredAt" DESC;
ROLLBACK;
```

**Expected output.**

- One row per open incident, plus a `GROUP BY proposed` count summary run as a separate statement in the same envelope.
- The `investment-events-instrument` / `reconstruction-repair` rows need `unresolved_securities = 0` / `unrebuilt_accounts = 0` to qualify as RESOLVE_WITH_EVIDENCE. The `proposed` CASE above deliberately leaves them at STALE/KEEP_ACTIVE; the reviewer applies §4 by hand.
- Schema caveats:
  - The `InstrumentAlias.provider` literal `'plaid'` is confirmed: `PLAID_PROVIDER = "plaid"` (`instrument-resolver.ts:32`).
  - `ReconstructionStatus` and `InvestmentCoverageOutcome` are Postgres enums, so the literal comparisons are valid. **[U]** the casts under the deployed column types.

**Predictions for the two named incidents** — **[U]** until run:

- *Brokerage A* (`INVESTMENT_DATA_PERSISTENCE_FAILED`, item scope, 5×): the `operation` column identifies which of fetch / instrument / reconstruction it is.
  - If fetch: coverage rows after the last occurrence ⇒ RESOLVE_WITH_EVIDENCE or RECOVERING.
  - If instrument / reconstruction: per-subject columns decide. F3 likely applies.
  - If the item is REVOKED ⇒ CLOSE_SUBJECT_REMOVED.
- *Wallet price* (08-19, 1×): if the wallet has been priced since, VALUATION SUCCEEDED rows within the last 60 days ⇒ RESOLVE_WITH_EVIDENCE. If the account was removed ⇒ CLOSE_SUBJECT_REMOVED. If the wallet is still unpriced ⇒ KEEP_ACTIVE (correct). If no executions exist at all ⇒ STALE.

**Applying the result** (after approval) uses the S7 sweep in `--apply` mode with the same rules. It writes `resolutionEvidence` with `rule: "historical-reconciliation.v1"` and is never a hand-written UPDATE.

---

## 11. Implementation slices

Each slice is independently reviewable and lands on `develop` through a PR.

| # | Slice | Contents | Tests |
|---|---|---|---|
| **S1** | Correlation + registry | `recordSyncIssue` adopts the ambient `activeLedger()` runId when `detail.runId` is absent (no recursion through `ledger.recordIncident`). Investment producers add `attemptId`; `reconstruction-repair` adds the instrument set. Register `transactions` in `OPERATION_KEYS` **via an alias to a new key `wallet-ledger-reconcile`**. That moves the identity of existing `unregistered:transactions` episodes, so it needs `OPERATION_KEY_ALIASES` plus a key-version note. ~~Without the new key, register `transactions` as-is to keep the key byte-identical; preferred.~~ **Corrected (S1 review):** registering `transactions` as-is is NOT byte-identical, because `resolveOperationKey` rewrites `unregistered:transactions` to `transactions`, which changes the key's last segment and splits open episodes. Moved to S2 with the rekey/alias work. Add an `OPERATION_PHRASE` entry. No schema change. | facade unit test (ambient vs explicit runId); `operation-key.test.ts`; phrase-map compile check |
| **S2** | Schema (additive) | §3.3 migration. Prisma fields. `invariant.ts` kinds. Boundary test pin updated. | migration dry-run on a disposable PG; invariant tests |
| **S3** | Subject removal | `resolveBySubjectRemoval` + calls from the 3 removal paths. `referentExistence`/convergence/customer-detail respect `deletedAt`/REVOKED. Projection label "connection removed". | unit + disposable PG; source-scan that every removal path calls it |
| **S4** | Evidence resolvers (wallet) | `price`, `balance`/`address`/`config`/`capture`, `discovery` rules via the dispatch envelope (`wallet-sync-dispatch.ts` after stages are recorded). RECOVERING → RESOLVED confirmation. Frozen `resolutionEvidence`. | per-rule positive/negative; same-execution-occurrence refusal |
| **S5** | Evidence resolvers (investments) | `investment-events-fetch` (coverage), `investment-events-instrument` (alias + clean attempt), `reconstruction-repair` (RECOVERING-only), investments MISSING_ACCOUNT. Invoked at the end of `sync-investments.ts` inside the envelope. Optionally record the `INVESTMENT_ACTIVITY` stage from the discarded metrics (F2). | per-rule; multi-subject partial |
| **S6** | Operator actions + UX | `applyOperatorTransition`, 3 routes, AuditAction/OperatorTargetKind additions, adoption ratchet. CS views: Broken now / Needs verification / History. Read-time STALE predicate (shared with attention + alerts). `evidenceSummary` writes and the "expired" rendering. | route tests (auth, reason, CAS 409); projection tests; Preview UI + server verification |
| **S7** | Sweep + historical reconciliation | Registered job `incident-lifecycle-sweep` (dry-run default; `--apply` needs owner approval per environment). Persists STALE/SUBJECT_REMOVED and re-runs resolvers for rows untouched by inline paths. Optional `?only=` allowlist entry for Preview. | job dry-run output pinned against §10 shape |

**Order:** S1 → S2 → S3 → S4/S5 (parallel) → S6 → S7. S3 is the cheapest visible win (removed subjects leave "broken now"), but it needs S2's resolution kinds. S1 has no schema change and can ship first.

### Risks

| ID | Risk | Mitigation |
|---|---|---|
| **R1** | **False recovery.** Matching a success of a different operation or subject would fabricate recovery, the exact failure this initiative forbids. | Each rule is keyed on (subject id, operation endpoint, `> lastOccurredAt`, clean attempt), with negative tests per rule. Multi-subject incidents require all subjects. |
| **R2** | **Identity drift.** Registering or renaming the `transactions` stage, or changing the key shape, orphans open episodes. | Alias table, no key-version bump unless deliberate (`operation-key.ts:140-147`). |
| **R3** | **Telemetry controlling the operation.** Resolver failures must never fail a sync. | Same never-throw + observer contract as `resolveByAutomaticRecovery`. Writes outside caller transactions (OPS-2D-TX-1). |
| **R4** | **Member surface change.** Closing incidents flips `resolved`, which the member activity feed reads. | Intended: removed or recovered issues leave the feed. STALE keeps `resolved=false` deliberately. |
| **R5** | **Alert behaviour.** Changing the alert fold to exclude STALE/RECOVERING reduces alerts. | Owner decision Q1 for ACKNOWLEDGED. |
| **R6** | **Flapping.** The 2-confirmation default delays closure by one cycle (≈6 h wallet, ≈24 h Plaid). | Acceptable versus false closure. Constant per rule. |
| **R7** | **Production reconciliation.** It is a bulk write to an operational ledger. | Dry-run first, owner approval, sweep code path only, evidence stamped per row, Preview rehearsal. |
| **R8** | **Scan truncation.** It persists until S3/S7 persist closures (F5). | Raise or paginate the scan in S6 if `truncated` is observed. |

### Owner questions

| Q | Question |
|---|---|
| **Q1** | Should ACKNOWLEDGED incidents keep re-firing alerts? |
| **Q2** | Staleness windows. Proposed: Plaid-item operations 14 d, wallet 7 d, user-triggered (import, opening position, rollback) 30 d. |
| **Q3** | Confirmation count. Proposed: 2. |
| **Q4** | Approval to run the §10 dry-run on Production, and through which read-only access path. |

---

## 12. Session 2 review (2026-11-01): APPROVED to start S1, with these corrections

These are binding before S2, S6, S7 and the §10 dry run.

**P1: the §10 dry run cannot run under `fm_diag_ro_inc` as granted.**
- The grant does not cover:
  - `SyncIssueOccurrence.detail` (used by `instrument_subjects` / `recon_subjects`);
  - `InvestmentEventCoverage` (used by `fetch_proof`);
  - `InstrumentAlias`;
  - `PositionReconstruction`.
- **Resolution:** a column-narrow amendment:
  - `InvestmentEventCoverage("plaidItemId","attemptId",outcome,"attemptedAt")`;
  - `InstrumentAlias(provider,"externalId")`;
  - `PositionReconstruction("financialAccountId","runAt",reconciliation)`.
- **Never grant `detail`.** It is free-form and may hold provider error text.
- The two detail-based CTEs run on Preview only, or after S1 moves securityId and accountId into structured fields.
- Any amendment needs Session 2's SQL re-review **and owner approval**.

**P2 corrections**
1. **STALE can hide skipped work.** "No attempt evidence" is also what an operation being *skipped* looks like (cost freeze, billable gate, PLAN_RESTRICTION, paused cron, disabled flag). Rule: only STALE when the operation was neither attempted **nor skipped** since `lastOccurredAt`, where skips come from `RefreshEndpointResult.skipReason`. Otherwise keep STALE visible as "N unverified" in Broken now, with lower-severity alerting. **Added to Q2 for the owner.**
2. **Item-scoped incidents with removed subjects.**
   - Per-subject rule: **proven OR removed (`deletedAt`)**.
   - The episode is AUTOMATIC_RECOVERY when at least one subject is proven and the rest are removed, and SUBJECT_REMOVED when all are removed.
   - Each subject's basis is recorded in `resolutionEvidence`.
3. **`fetch_proof` counts COMPLETE only for historical reconciliation.** PARTIAL is allowed only after S1, with the clean-attempt test (no occurrence carrying that `attemptId`).
4. **S1 ambient-ledger leak pins.**
   - A producer running after its envelope closes (fire-and-forget, `void`, `after()`) must not stamp a finished or foreign execution.
   - Concurrent wallet syncs each get their own envelope (dispatch per account).
   - Test the ambient value with two interleaved envelopes.

**P3 / notes**
- `lifecycleState` is TEXT with a CHECK constraint on the 5 values (or an enum).
- With 2 confirmations, wallet closure takes about 24 h at today's effective 12 h crypto cadence. The boundary-cadence fix (post-B9 P3) halves that.
- An operator resolve flips `resolved`, which the member activity feed reads, so operator actions become member-visible. **Called out in Q1/Q4.**
- Q3: the confirmation count (1 vs 2) is a per-rule constant.
- **Expected result:** the 2026-08-19 wallet `price` incident should come out **RESOLVE_WITH_EVIDENCE**. VALUATION is SUCCEEDED only when PRICED (`wallet-sync-dispatch.ts:477`), so a run that recorded the incident can never also prove recovery, and Production priced BTC at 08:14Z on 2026-11-01.

### 12.1 Session 2 review of S1 (#222, 2f59c67): APPROVED, with conditions

**Scheduled ingest gap.** `jobs/sync-banks.ts:414` calls `ingestInvestmentEvents(db, { accessToken, plaidItemId, now })` with no refresh envelope and no `coveredFinancialAccountIds`. Production runs this path daily (05:45Z: `2 event-ingest`). Its incidents get no run id. `recordCoverage` returns early without covered accounts, so the path also writes **no coverage rows**.

1. **Explicit S5 prerequisite, binding.** The scheduled ingest must pass the item's live investment accounts as `coveredFinancialAccountIds`, so it writes coverage rows. Wrapping it in a refresh envelope is preferred, but coverage rows are the minimum. Without them, incidents from this path (likely Brokerage A's) have **no evidence source** and can only go STALE or be operator-closed. This applies to §4's `investment-events-fetch` row: "a later fetch attempt where the provider answered" is only provable once the scheduled path writes coverage.
2. **§10 dry-run interpretation.** `fetch_proof` undercounts for items whose ingest runs only through sync-banks, because the manual-refresh path is the only coverage writer today. **A result of 0 proofs means "no evidence path", not "still failing".**
3. **Cost observability (post-B9 item, linked to S5; not a B-batch blocker).** The out-of-envelope `investmentsTransactionsGet` is a paid Plaid request with **no ProviderCall row**. It is invisible to per-execution cost attribution and to provider-health readers. During S5:
   - confirm it sits behind sync-banks' per-item billable gate (B4/5 showed no skips, so probably gated upstream);
   - confirm that bringing it into an envelope does not double-count against any per-item Plaid budget.
