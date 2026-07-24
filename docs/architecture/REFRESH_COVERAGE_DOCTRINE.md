# Refresh Coverage & Freshness Doctrine

**Status:** shipped (DF-2E). The canonical authority describing **which accounts a refresh execution evaluated, which endpoint touched each, which were intentionally skipped, and whether their freshness advanced.** A companion to `REFRESH_EXECUTION_DOCTRINE.md` — that document owns the execution *lifecycle*; this one owns *per-account coverage and execution freshness*.

**This authority owns no UI, diagnostics, dashboards, or Platform Operations.** Those belong to OPS-2, which consumes it.

---

## A. Historical problem — completion ≠ freshness

An execution completing `SUCCEEDED` does **not** mean every account under the item is fresh. A refresh may write balances for four accounts and skip a fifth (soft-deleted); the balances endpoint may succeed while the holdings endpoint is not run at all; a stage may fail for the whole item, leaving *every* account stale, while another stage succeeded.

Before DF-2E, the ledger recorded execution- and stage-level outcomes plus a **coarse** `RefreshEndpointResult.coveredAccountIds` string array — enough to say "these accounts were processed," but not:

- which accounts were **intentionally skipped**, and why (vs. failed);
- whether a specific account's **freshness advanced** this execution;
- which **execution most recently refreshed** a given account (reverse lookup).

Current per-account freshness (`FinancialAccount.lastUpdated` / `balanceLastUpdatedAt` / `syncStatus`) is **current-only** — overwritten each refresh, no history, no per-endpoint grain, no skip/fail reason. Observed-freshness derivation (`lib/platform/resource-freshness.ts`) answers "is the data stale *now*" from observation tables, but has no per-account, per-execution coverage history. **DF-2E fills exactly that gap** — one immutable row per (execution, endpoint, account) the execution evaluated.

---

## B. Coverage hierarchy

```
JobRun                              optional batch parent
   └─ RefreshExecution              per-item execution authority
        └─ RefreshEndpointResult    stage-level facts
             └─ ProviderCall        provider-operation attribution (DF-2D)
        └─ RefreshEndpointAccountCoverage   per-account coverage & execution freshness (DF-2E)
```

`RefreshEndpointAccountCoverage` hangs off `RefreshExecution` (its ledger root), not off `RefreshEndpointResult`: endpoint-result rows are persisted at execution **close**, so a coverage row cannot FK to one that does not exist during the run. The owning stage is the `endpoint` **string**, exactly as `ProviderCall`.

**Layer ownership.** `JobRun` — batch facts (optional). `RefreshExecution` — one item-level lifecycle. `RefreshEndpointResult` — stage facts (status, counts, coarse `coveredAccountIds`). `ProviderCall` — external provider attempts. **`RefreshEndpointAccountCoverage`** — *for one execution*, per (endpoint, account): the coverage `status`, the `reason` when skipped, and whether `freshnessAdvanced`. Soft `financialAccountId` (no FK — survives account merge/deletion/identity-correction); FK-cascade to `RefreshExecution` only.

---

## C. Coverage doctrine

> **Coverage means:** *this execution attempted to evaluate this account for this endpoint.*

Coverage does **not** mean provider success, new data, account changed, or account healthy. Those are separate facts:

- `status = COVERED` — the account was freshly evaluated (and written/observed) for this endpoint. Whether data *changed* is `freshnessAdvanced` + the endpoint's `recordsChanged`, not coverage itself.
- `status = SKIPPED` — the account was present but **intentionally not evaluated** (`reason`), and is **distinguishable from a failure**: a failed stage records **no** per-account row here and a `FAILED` `RefreshEndpointResult` instead.
- `status = FAILED` — reserved for a per-account provider/processing failure. Whole-stage provider failures (e.g. `accountsGet` throws) iterate no accounts and therefore produce **no** per-account rows — that reason lives on the endpoint result. Not produced yet.

**Absence ≠ uncovered, and absence ≠ fresh.** An account with no coverage row for an endpoint was simply not evaluated per-account by that execution.

---

## D. Freshness doctrine — four distinct kinds

| Freshness | Question | Authority |
|---|---|---|
| **Observed** | Is the data fresh *right now*? | `lib/platform/resource-freshness.ts` — derived from observation tables (PositionObservation, snapshots) vs a threshold. Pre-existing. |
| **Execution** (DF-2E) | Did *this execution* freshly observe/write this account for this endpoint? | `RefreshEndpointAccountCoverage.freshnessAdvanced`. |
| **Provider** | When did the *institution* last update? | `FinancialAccount.balanceLastUpdatedAt` (Plaid's own timestamp). |
| **Unknown** | (no observation) | — |

DF-2E owns **execution freshness only**; it does **not** re-derive observed freshness. **UNKNOWN must never become "now":** absence of a `COVERED` row is not freshness — we never assert a fresh observation we did not make.

---

## E. Staleness doctrine

Staleness is **derived** (an account is stale when its most recent `COVERED` coverage for an endpoint is older than that endpoint's cadence, or absent). DF-2E provides the *facts*; the staleness *projection* is OPS-2. Canonical reasons and where each is sourced:

| Reason | Meaning | Source |
|---|---|---|
| `NEVER_REFRESHED` | no `COVERED` coverage has ever existed for this account+endpoint | absence in this table |
| `ACCOUNT_DISCONNECTED` | soft-deleted account under an active item | **DF-2E** `SKIPPED` row (balances) |
| `NO_HOLDINGS` | investment account returned no holdings | **DF-2E** `SKIPPED` row (holdings) |
| `NOT_APPLICABLE` | endpoint does not apply to the account | reserved (DF-2E vocabulary) |
| `PROVIDER_FAILURE` | the endpoint failed for the item this execution | `RefreshEndpointResult.status = FAILED` + `errorSummary` |
| `EXECUTION_SKIPPED` | the item's sync was lock-held / skipped | `RefreshExecution.overallStatus = SKIPPED` |

Per-account-divergent staleness (one account skipped while siblings covered) is answered **here**; item-wide staleness (whole stage failed/skipped) is answered by the **execution/endpoint** status — together they explain *why any account is stale* without provider logs.

---

## F. Consumer doctrine

Coverage is an **authority, not a presentation model.** Consumers — Platform Operations, customer connection diagnostics, AI explanations, future freshness dashboards — derive **projections** from these immutable facts (joined with observed/provider freshness where relevant). **Coverage owns no UI.** This slice ships the authority; OPS-2 ships the consumers.

---

## G. Immutability doctrine

Coverage rows are historical facts: one row per (execution, endpoint, account), **created once, never updated.** A later account merge/deletion/identity-correction must not rewrite or cascade-erase them — hence the **soft** `financialAccountId` (no FK). No speculative backfill: history before DF-2E is simply absent, which is acceptable.

---

## Architecture (shipped)

`model RefreshEndpointAccountCoverage { id · refreshExecutionId (FK→RefreshExecution cascade) · endpoint · financialAccountId (soft, no FK) · status · reason? · freshnessAdvanced · createdAt }`. Indexes: `(refreshExecutionId)`, `(financialAccountId, endpoint, createdAt)` — reverse "executions that covered account X for endpoint EP, newest first", and `(financialAccountId, createdAt)` — "which execution most recently refreshed this account". No dumping-ground JSON; allowlisted typed fields only.

## Lifecycle (Part IV) — automatic, one interception, no new ALS

Coverage is recorded **automatically** through the existing recorder seam — **no endpoint-specific writers, no duplicated instrumentation.** Stages that iterate accounts report per-account outcomes via `RefreshStageFacts.accounts` on `recorder.succeed(...)`; the `StageRecorder` collects them; **`closeExecution` persists all coverage rows in one best-effort `createMany`** (the single canonical interception, alongside endpoint-result persistence).

**Why not AsyncLocalStorage** (as DF-2D uses for provider calls): coverage is known at the **stage boundary**, where the account list is already in hand and reported synchronously to the recorder — there is no deep call stack to thread through. ALS is required only for the Proxy-level provider-call interception, which fires far below the stage that owns it. Reusing the recorder keeps coverage in lockstep with the endpoint result it belongs to.

Populated truthfully today: **BALANCES** (`COVERED` per written account; `SKIPPED/ACCOUNT_DISCONNECTED` per soft-deleted account) and **HOLDINGS** (`COVERED` per synced account; `SKIPPED/NO_HOLDINGS` per empty account). `TRANSACTIONS` is item-level (cursor) — no per-account coverage. Derived stages (SNAPSHOT/RECONCILIATION/HISTORY_BACKFILL) carry none.

## Freshness semantics (Part V) — when execution freshness advances

| Provider outcome | Coverage | `freshnessAdvanced` |
|---|---|---|
| Successful response (incl. **empty / no-change** — "no new transactions", "empty holdings") | `COVERED` | **true** — a fresh observation of "nothing changed" is still fresh |
| Account present but intentionally not evaluated (disconnected / no holdings) | `SKIPPED` | **false** |
| Whole-stage provider **failure / timeout** | *no row* (accounts not iterated) | — (never asserted) |
| Cached client-side response | n/a (not used here) | — |

The rule: `freshnessAdvanced = true` **iff** a successful provider response freshly observed/wrote the account for that endpoint. Uncertainty never becomes "now."

## Adoption by trigger

`freshnessAdvanced` per account is populated wherever the owning stage runs: **BALANCES** on manual / cron / reconnect / webhook (all run `refreshBalancesForItem`); **HOLDINGS** on manual only (cron/reconnect/webhook do not run holdings — consistent with the execution doctrine). Reconnect's inline fast-slice is outside the ledger (execution-doctrine §J), so its inline holdings are not covered here.

---

## Known limitations / deferred

- **TRANSACTIONS** produces no per-account coverage (item-level cursor); a future slice would need per-account transaction plumbing.
- **Whole-stage provider failures** produce no per-account rows (the item's accounts were never iterated); staleness reason for those accounts comes from the endpoint/execution status.
- **HOLDINGS coverage is manual-path only** (cron/reconnect/webhook do not run holdings).
- **The staleness projection** ("which accounts are stale *now*, and why") is **OPS-2** — DF-2E ships the raw facts + the reason vocabulary, not the query or UI.

---

### Success criteria — answered

> Can Fourth Meridian now explain, for every refresh execution, exactly which accounts were evaluated, which endpoints covered them, whether their freshness advanced, why any account remains stale, and expose those facts through one canonical authority without reconstructing provider history or logs?

**Yes, at the account-iterating stages (BALANCES, HOLDINGS)** — `RefreshEndpointAccountCoverage` records, per execution, each evaluated account with its endpoint, `COVERED`/`SKIPPED` status, canonical skip reason, and `freshnessAdvanced`; reverse indexes give "which execution most recently refreshed this account". Combined with `RefreshEndpointResult`/`RefreshExecution` status, it explains *why any account is stale* — all from the ledger, no provider logs.

**Remaining architectural gap (stated, not implied):** TRANSACTIONS has **no per-account coverage** (item-level cursor), so "was account X covered for transactions this execution" is not answerable per-account — only per-item. Closing it requires per-account transaction attribution, a distinct future slice. Whole-stage provider failures likewise record item-level (not per-account) reasons. Everything else — evaluation, skip/fail distinction, execution freshness, reverse lookup — is answered by this one authority.

### The independent facts (never collapsed)
`execution succeeded` · `endpoint succeeded` · `provider succeeded` · `account covered` · `account freshness advanced` · `account remained stale` are six separate facts, each with its own home: `RefreshExecution.overallStatus`, `RefreshEndpointResult.status`, `ProviderCall.status`, `RefreshEndpointAccountCoverage.status`, `RefreshEndpointAccountCoverage.freshnessAdvanced`, and (derived) the absence/age of a `COVERED` row.
