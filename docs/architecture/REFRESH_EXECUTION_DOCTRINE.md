# Refresh Execution Doctrine

**Status:** shipped through DF-2D. Describes the *canonical refresh-execution authority* — the immutable ledger that answers, for any refresh, *what was attempted, what succeeded, failed, or skipped, whether freshness advanced, how it completed, and which provider operations it made* — without reconstructing that history from logs.

This document is authority, not aspiration: every section describes code in `main`. Deferred work is labelled as such.

---

## A. The historical problem

Before DF-2, refresh work started from four entrypoints — the manual refresh route, the daily cron, reconnect (token exchange), and the Plaid webhook — **each with its own orchestration and its own (or no) operational reporting.**

Different orchestration per path was, and remains, *legitimate*: a reconnect genuinely does more than a webhook; cron runs on a 60s budget that a manual refresh does not. The problem was **not** divergent work. The problem was the absence of one immutable authority that could answer, for a single refresh:

- why it began, which item it concerned, which stages it attempted;
- which stages succeeded, failed, or were skipped, and whether freshness advanced;
- how the overall execution completed, and how it related to a batch job;
- which external provider calls caused its operational cost or failure.

`JobRun` existed but is **batch-grained** — the nightly `sync-banks` writes one row for the whole run; per-item manual/webhook/reconnect syncs wrote none. The rich result objects the code already computed (`RefreshItemResult`, `SyncTransactionsResult`) were **returned and discarded**. DF-2 centralized the **execution lifecycle** — not all business orchestration — and persisted those facts at the per-item grain.

---

## B. The execution hierarchy

```
JobRun                          optional batch parent (scheduler-owned)
   └─ RefreshExecution          REQUIRED per-item execution authority
        └─ RefreshEndpointResult REQUIRED stage-level execution facts
             └─ ProviderCall     optional provider-operation attribution (DF-2D)
        └─ RefreshEndpointAccountCoverage   FUTURE per-account outcome evidence (DF-2E)
```

Conceptual hierarchy; the persistence links are chosen per-layer for immutability (below).

### Layer ownership

- **`JobRun`** (`prisma/schema.prisma`, writer `lib/jobs/run.ts`) — batch/scheduled-job facts: start/complete, aggregate outcome, trigger, `durationMs`, `summary`. **Optional** parent: request-triggered reconnect/webhook belong to no batch.
- **`RefreshExecution`** — one attempted item-level refresh lifecycle: `plaidItemId` (soft), `trigger`, `profile`, optional `parentJobRunId` (soft), `startedAt`/`completedAt`/`durationMs`, derived `overallStatus`, `runId`, `errorSummary`. Every canonical refresh attempt produces exactly one.
- **`RefreshEndpointResult`** — stage facts within one execution: `endpoint`, `stageKind`, `status`, `recordsRead/Written/Changed`, `durationMs`, `freshnessAdvanced`, `coveredAccountIds`, `skipReason`/`errorSummary`. **Not** a provider-request log, **not** a per-account outcome model.
- **`ProviderCall`** (DF-2D) — one actual external provider request *attempt*: `provider`, `operation`, `status`, `attempt`, timing, `providerRequestId`, `httpStatus`, `errorCode`/`errorCategory`. Explains the provider work inside a stage.
- **`RefreshEndpointAccountCoverage`** — **future**, DF-2E: per-account outcome (status/reason/reverse-lookup/aggregation). Introduced only when a real consumer needs it — never for relational aesthetics.

**Writer:** the ledger has one chokepoint — `runFullRefresh()` (`lib/plaid/refresh-execution.ts`), modelled on `runJob()`. All ledger writes are best-effort/non-throwing (a telemetry failure never breaks a refresh).

---

## C. The universal lifecycle

```
open execution → run caller-owned orchestration → record stage facts → derive overall result → close immutable execution
```

`runFullRefresh()` is the **lifecycle authority — not the manual refresh workflow.** The caller supplies a `trigger`, a `profile`, and a *runner* that drives the recorder through its own stages. A future caller adopts the ledger by supplying those three things; it never forks the lifecycle. Proven: `runFullRefresh` is generic over the runner's result and its recorder handles both throw-based (manual/cron) and never-throws (reconnect/webhook) callers.

**Current profiles:** MANUAL · CRON · RECONNECT · WEBHOOK.

---

## D. Trigger doctrine

> A refresh **trigger** identifies the initiating business event — **not** the stage sequence executed.

`MANUAL | CRON | RECONNECT | WEBHOOK` (stored as a String; `RefreshTrigger` TS union in `lib/plaid/refresh-execution-types.ts`). Trigger and stage are **orthogonal**: two executions with the same trigger may run different stages over time. Future triggers (`ADMIN`, `RECOVERY`, `IMPORT`, `MIGRATION`, `PROVIDER_RETRY`) are added only when they name a distinct initiating event. Never encode orchestration into a trigger name.

---

## E. Profile doctrine

The **profile** names the caller-owned workflow (`FULL_REFRESH | RECONNECT`). A profile may determine stages attempted, ordering, lock scope, timeout assumptions, retry policy, fail-fast vs best-effort, and never-throws vs exception propagation. **Profiles must not own execution persistence.** The shipped implementations prove one lifecycle supports materially different profiles without "manualizing" them (verified by a cross-trigger parity test: manual runs HOLDINGS; reconnect/webhook run HISTORY_BACKFILL; none cross).

---

## F. Stage doctrine

Stages (`RefreshEndpoint`) describe meaningful units of refresh work: `TRANSACTIONS · BALANCES · HOLDINGS · INVESTMENT_ACTIVITY · SNAPSHOT · RECONCILIATION · HISTORY_BACKFILL`. `stageKind` distinguishes `PROVIDER` (a live provider endpoint) from `DERIVED` (a projection). Add a stage when it is operationally distinct, would need a distinct diagnosis/action on failure, or would make telemetry misleading if merged.

**Why `HISTORY_BACKFILL` ≠ `SNAPSHOT`:** SNAPSHOT is today's single snapshot row regenerated from fresh balances. HISTORY_BACKFILL is the connect/webhook-only *historical* pipeline — position reconstruction, historical price backfill, MAX-window wealth-history rebuild, and historical snapshot backfill. Failure there needs different diagnosis (it does not affect current balances) and it is the reconnect/webhook-defining work. Do not overload a stage to avoid a new string value.

---

## G. Completion doctrine (derived, exact)

`overallStatus` is **derived** from child stage facts by `deriveOverallStatus()` — never assigned by a caller, and there is no second success boolean.

- **no attempted stage** (all SKIPPED / none) → **SKIPPED** — e.g. the item's sync lock was held elsewhere (`IN_FLIGHT`).
- **every attempted PROVIDER stage failed** → **FAILED**.
- **any stage failed** (a provider mix, or a DERIVED/projection stage) → **PARTIAL**.
- **otherwise** → **SUCCEEDED**.

Consequences, as implemented:
- **Lock contention** → the runner records `TRANSACTIONS` SKIPPED(IN_FLIGHT); nothing else attempted → SKIPPED.
- **Best-effort stage failure** (cron/deferred balance/snapshot) → recorded FAILED via `recorder.fail()` *without throwing*; the item still counts as synced, and the execution derives PARTIAL.
- **Fail-open** (never-throws deferred pipeline) → its internal catch calls `recorder.failOpen()` to finalize the open stage as FAILED; execution derives PARTIAL/FAILED without a thrown error.
- **Complete caller failure** (manual/cron transaction throw) → `runFullRefresh`'s catch calls `failOpen`, records FAILED, and **rethrows the original error** so route/cron error handling is unchanged.
- **A SKIPPED(NOT_APPLICABLE) stage never degrades success** — e.g. an item with no investment accounts.

---

## H. Coverage doctrine (`coveredAccountIds`)

> `coveredAccountIds` is a **coarse evidence set** of canonical `FinancialAccount` IDs **directly processed by, or materially used as inputs to**, an endpoint stage during one execution. The IDs are **point-in-time soft references**. The field is **not** a per-account freshness, success, completeness, change, or outcome authority.

```
empty   ≠ uncovered
present ≠ updated
present ≠ successful
present ≠ freshness advanced
```

Current behaviour: **HOLDINGS** reports the resolved investment accounts genuinely processed (from `syncInvestmentsForItem.processedAccountIds`). **TRANSACTIONS** stays empty — truthful account-grain evidence is not available without extra plumbing (do not fabricate it). **BALANCES/SNAPSHOT** carry the updated/input account ids. Per-account *current* freshness lives on `FinancialAccount.lastUpdated`, not here.

**Soft references, no FK:** account IDs must survive later merge/deletion/remapping/identity correction — a stored ID may stop resolving and remain historically valid.

**Normalization trigger →** introduce `RefreshEndpointAccountCoverage { financialAccountId String (soft, no FK), status, reason?, ... }` at the FIRST real need for (1) per-account status/reason, (2) account→execution reverse lookup as a primary product/HQ query, (3) aggregation grouped by account/institution/type, or (4) routinely large endpoint account populations. Until then the array stands.

---

## I. Parent-job doctrine

```
JobRun  ── optional ──▶  RefreshExecution
```

For **reconnect/webhook** (request-triggered via `after()`): `parentJobRunId = null` is **correct** — no batch job exists. For **cron**: a `JobRun` does exist, but its ID is not yet passed into item-level executions because `runJob`'s callback contract does not expose it. Recorded as a named follow-up — **DF-2B.1 — JobRun / RefreshExecution correlation** — not an ambiguity. Not every execution requires a parent.

---

## J. Reconnect fast-slice doctrine

The reconnect flow is `inline connection-establishment fast slice` **+** `deferred refresh execution`. The inline slice (account-spine persistence, immediate holdings, same-day snapshot, latency-sensitive establishment) runs synchronously in `performPlaidTokenExchange`.

> The inline reconnect fast slice belongs to **connection establishment** and does **not** partially participate in the refresh-execution ledger. The deferred synchronization pipeline creates the canonical `RefreshExecution` (trigger `RECONNECT`).

No half-ledger participation: we do not wrap a partial execution around fragments of token exchange. A future change must pick one coherent outcome — the whole inline slice becomes its own full execution authority, **or** it stays outside the ledger.

---

## K. Immutability & historical evidence

Execution facts represent what was known and attempted *at that time*. Later operational entity changes must not rewrite the ledger; soft references may stop resolving and remain historically valid; historical *absence* before a new child model exists is acceptable; additive telemetry models require **no** speculative backfill unless a real consumer needs it. Reconstructing history from `lastSyncedAt` / audit logs / JobRun summaries / SyncIssue timestamps is forbidden — those cannot recover exact per-stage or per-call facts.

---

## L. Consumer doctrine

The ledger is an **authority, not a presentation model.** Future consumers — customer connection diagnostics, Platform Operations, AI Operations, billing/usage reporting, freshness projections, incident investigation — derive **projections** from immutable execution facts. They must not mutate or overload execution rows for presentation convenience.

---

## M. ProviderCall (DF-2D) — shipped

**Attribution, not billing.** `ApiUsageCounter` remains the independent daily usage/billing authority (Option A). The Plaid client **Proxy** (`lib/plaid/client.ts`) is the single chokepoint: it still writes `ApiUsageCounter`, and additionally — **only when a refresh execution context is active** — records one `ProviderCall` per attempt via an `AsyncLocalStorage` correlation context (`lib/plaid/provider-call-context.ts`). Calls outside a refresh (link-token, token exchange, `itemRemove`, webhook-key) are unattributed by design.

**Correlation context.** `runFullRefresh` establishes one context per per-item refresh (`refreshExecutionId`, mutable `currentEndpoint`, per-operation `attempts` counter). ALS propagates it through the async stage pipeline and survives `after()` because it is set *inside* the refresh, not inherited from the request; each `runFullRefresh` gets its own store, so concurrent items never cross-attribute. The `StageRecorder` updates `currentEndpoint` as stages begin/end, so each `ProviderCall` names the stage that fired it.

**Writer / lifecycle** (`lib/plaid/provider-call.ts`, `instrumentProviderCall`): open (startedAt, attempt) → await the real call → record SUCCEEDED with `request_id`, or FAILED/RATE_LIMITED with Plaid's own `error_code`/`error_type`/HTTP status → **rethrow the original error unchanged**. Fire-and-forget, non-throwing, guarded so a throwing telemetry write can never be mistaken for a provider failure. `durationMs` is the provider round-trip only.

**Final `ProviderCall` fields:** `id · refreshExecutionId (FK→RefreshExecution, cascade) · endpoint? (stage string, no FK) · provider · operation · status(SUCCEEDED|FAILED|RATE_LIMITED) · attempt · startedAt · completedAt · durationMs · providerRequestId? · httpStatus? · errorCode? · errorCategory? · createdAt`. Indexes: `(refreshExecutionId)`, `(provider, operation)`, `(status, startedAt)`. **No** FK to `RefreshEndpointResult` (endpoint rows are persisted at execution close and don't exist during the call). **No** metadata dumping-ground; **no** token/secret/payload — data minimization is enforced by an allowlist of typed fields.

**Retry & pagination semantics.** Each external request re-enters the Proxy → a **distinct immutable row** (`attempt` increments per operation within the execution). A failed attempt is never overwritten by a later success: `HOLDINGS` retried via `withPlaidRetry` yields two `ProviderCall` rows (attempt 1 FAILED, attempt 2 SUCCEEDED) while the enclosing `HOLDINGS` stage may still SUCCEED. **`ProviderCall.status` ≠ `RefreshEndpointResult.status`.** Paginated `transactionsSync` yields one row per page (attempt counts pages — a documented consequence of Proxy-level counting; retry-vs-page is not distinguishable there).

**Initially attributed operations** (all Plaid calls that occur inside a refresh context): `transactionsSync` (TRANSACTIONS, paginated), `accountsGet` (BALANCES), `investmentsHoldingsGet` (HOLDINGS, retried), `investmentsTransactionsGet` (INVESTMENT_ACTIVITY / during HOLDINGS on the manual path). **Known uninstrumented** (outside any refresh, by design): `itemPublicTokenExchange`, `accountsGet` in the connect fast-slice, `linkTokenCreate`, `itemRemove`, `webhookVerificationKeyGet`. Cron's investment-event ingest runs **outside** the execution today, so its `investmentsTransactionsGet` is unattributed.

**Usage integration:** Option A (correlation only). `ApiUsageCounter` is untouched; billing reconciliation between per-attempt `ProviderCall` and daily aggregates is deferred (DF-2D+). **Telemetry-failure behaviour:** provider/application semantics stay authoritative; a `ProviderCall` write failure is logged and swallowed; no false provider result is ever recorded.

---

## Initiative history

| Slice | What shipped | Commit |
|---|---|---|
| **DF-2A** | Canonical execution authority (`RefreshExecution` + `RefreshEndpointResult`), manual refresh integrated | `5b7be94` |
| **DF-2B** | Cron cutover (behavior-preserving) | `dc348a8` |
| **DF-2C** | Reconnect + webhook adoption; `HISTORY_BACKFILL` stage; trigger doctrine | `5ad2193` |
| **DF-2D** | `ProviderCall` attribution via the Plaid Proxy + ALS context | *this slice* |

**Runtime-verification limitations:** all four adoptions and ProviderCall are verified by unit tests + typecheck + source-scan; a **real** production refresh writing rows was **not** runtime-observed (background `after()` + prod DB, out of scope). **Deferred:** DF-2B.1 (cron parent correlation), DF-2D+ (usage reconciliation), **DF-2E** (account-level coverage + freshness projection), **DF-2F** (customer/HQ consumers). Reconnect's inline fast-slice remains outside the ledger by doctrine (§J).

---

### The question, answered

> Can Fourth Meridian now explain which provider operations, attempts, failures, retries, duration, and usage facts produced a given refresh execution without reconstructing that history from logs?

**Yes, for provider calls made inside a refresh execution** — `ProviderCall` rows joined to their `RefreshExecution` give operation, attempt, status, duration, `request_id`, HTTP status, and Plaid error code per attempt, with retries and pages as distinct rows. **Unattributed surfaces**, stated precisely: connection-establishment calls (`itemPublicTokenExchange`, the connect fast-slice `accountsGet`), `linkTokenCreate`, `itemRemove`, `webhookVerificationKeyGet`, and cron's out-of-execution `investmentsTransactionsGet` — none occur inside a `runFullRefresh` context, so by design they carry no `ProviderCall`. Billable-dollar attribution is not answered here (usage stays in `ApiUsageCounter`; reconciliation deferred).
