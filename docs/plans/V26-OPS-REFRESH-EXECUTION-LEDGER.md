# V26 Refresh Observability — Execution Ledger

**The one authoritative record for the OPS-REFRESH arc.** Updated at every slice stop.

Status vocabulary (a slice may hold several; the last one reached is its real status):
`investigated` → `planned` → `implemented` → `validated` → `committed` → `deployed` →
`production behavior verified`

> **An observability gap is never marked closed because the code that closes it exists.**
> Code is `committed`; the gap is closed only at `production behavior verified`.

---

## 0 · Arc status

**OPS-REFRESH-1 (investigation)** — complete, read-only.
`docs/plans/V26-INVESTIGATION-MANUAL-REFRESH-TRACEABILITY.md`. Five drifts found.

**OPS-REFRESH-1A** — **committed**. DRIFT-1 closed.

**DRIFT-2 · DRIFT-3 · DRIFT-4 · DRIFT-5 remain OPEN** and are disclosed in
`REFRESH_EXECUTION_DOCTRINE.md` §N rather than left implicit.

**Not approved, and not performed:** any live manual refresh, any production
query, any schema change, any migration, any data mutation.

---

## OPS-REFRESH-1 — Manual refresh execution traceability (investigation)

| | |
|---|---|
| **Status** | **investigated** — read-only; no code, schema, route, job, or ledger touched |
| **Artifact** | `docs/plans/V26-INVESTIGATION-MANUAL-REFRESH-TRACEABILITY.md` |
| **Presenting symptom** | One confirmed user-initiated manual refresh wrote 25 `Transaction`, 49 `PositionObservation` (incl. `origin: DERIVED` / `source: "reconstruction"`), 9 `InvestmentEvent`, 1 `SpaceSnapshot` — with **no** `RefreshExecution` and **no** `JobRun` |
| **Root cause** | `POST /api/plaid/refresh` forks on `body.plaidItemId`. The per-connection branch runs under `runFullRefresh` (DF-2A). The **no-body branch** — the global topbar Refresh button and sidebar "Refresh Data", via `components/plaid/useManualRefresh.ts` — calls `refreshAllActiveItemsForUser`, which called `refreshPlaidItem(id, { deferSnapshot: true })` with **no recorder, no runId, no envelope**. |
| **Verdict** | **Implementation drift**, not an intended exemption. Doctrine §C requires one execution per attempt; §J exempts only the reconnect *inline* fast slice, a different function in a different file. |
| **Why the ratchet missed it** | `execution-convergence.test.ts` grepped the **route file** for the token `runFullRefresh(`. Branch A supplied it. A lexical scan cannot see a second branch that bypasses the thing it scans for. |
| **Drifts found** | **1** all-items fan-out off the ledger · **2** reconstruction is not a declared stage · **3** execution identity never reaches a financial row (any path) · **4** post-envelope writes (cron wealth self-heal, cron event ingest, resume-sync wealth regen) rewrite historical snapshots unattributed · **5** the fan-out's post-loop snapshot regeneration is structurally item-less |
| **QUANTITY finding** | Reconstruction is **not** circular today — `gatherReconstructionInputs` anchors on `origin: OBSERVED` only. But that is one unguarded `where` clause, **6 of 8** other observation readers have no origin filter, and QUANTITY-1H proposes materialising replay output into the same DERIVED channel. Six-point contract stated for 1B/1C. **Does not block QUANTITY-1C** (pure core, no DB reach). |
| **Production mutation** | **none** |

---

## OPS-REFRESH-1A — Ledger the all-items manual refresh path

| | |
|---|---|
| **Status** | **committed** — DRIFT-1 closed; DRIFT-2..5 explicitly NOT addressed |
| **Commit** | `980657d` |
| **Schema / migration** | **none.** No new column, no FK, no migration. |
| **Objective** | Every per-item refresh inside the all-items manual fan-out executes through the canonical `runFullRefresh` envelope. |
| **Approved shape** | **Option 1 — the sync lock sits INSIDE the execution envelope.** The doctrine-conformant placement (§G) and the only one under which lock contention is observable. Matches cron, webhook, `/sync`, resume-sync and the operator resync. Branch A's lock-outside placement was **deliberately not aligned** in this slice → OPS-REFRESH-1D. |

### Files changed

| File | Change |
|---|---|
| `lib/plaid/refresh.ts` | **+2 exported units.** `runManualItemRefresh(itemId, deps)` — the per-item execution envelope (`trigger: MANUAL`, `profile: FULL_REFRESH`, lock inside the runner, `deferSnapshot: true` preserved, `TRANSACTIONS` SKIPPED(`IN_FLIGHT`) on contention). `RefreshAllDeps` — a six-function injection seam for the fan-out. Three private collaborators extracted verbatim (`listActiveItemsForUser`, `reportItemRefreshFailure`, plus the existing `hasActiveLinkedAccount` / `selfHealOrphanedPlaidItem` / `regenerateCompletedSpaces` wired as defaults). The loop's `withPlaidItemSyncLock(… refreshPlaidItem …)` call became `runItem(item.id)`. |
| `lib/plaid/refresh-fanout.test.ts` | **NEW** — 64 assertions across 7 groups. |
| `lib/plaid/execution-convergence.test.ts` | Census annotated with why it passed over a real gap; pointer to the behavioural guard. The token checks are retained, not trusted. |
| `docs/architecture/REFRESH_EXECUTION_DOCTRINE.md` | §A two-branch history · §C fan-out grain + lock placement + non-attempt populations · §M all-items footprint now attributed · **§N NEW — standing gaps** · initiative history · closing answer qualified. §J untouched. |
| `docs/plans/V26-INVESTIGATION-MANUAL-REFRESH-TRACEABILITY.md` | DRIFT-1 marked resolved with the commit. |

**Untouched:** `refresh-execution.ts` · `refresh-execution-types.ts` · `sync-lock.ts` · `syncTransactions.ts` · `sync-investments.ts` · `reconstruction-runner.ts` · snapshots · the route file · cron · webhook · reconnect · resume · operator resync · `prisma/schema.prisma`.

### The import-cycle constraint, and how it was resolved

`lib/plaid/refresh-execution.ts` statically imports `refreshPlaidItem` from `lib/plaid/refresh.ts`. A plain value import of `runFullRefresh` in the other direction would close a runtime cycle — the exact hazard `refresh-execution-types.ts` exists to avoid. Resolved with a **type-only** `typeof import(...)` reference (erased at compile, no runtime edge, and the *real* signature rather than a hand-copied approximation) plus a lazy `await import()` for the production default. `refreshAllActiveItemsForUser` deliberately **stayed in `refresh.ts`** so `sync-lock.test.ts`'s existing source scan keeps holding without amendment.

### Execution semantics after this slice

- **One `RefreshExecution` per item that reaches the lock attempt** — `trigger: MANUAL`, `profile: FULL_REFRESH`, `parentJobRunId: null`.
- **Not one per candidate.** Cooldown-excluded items never reach the service; orphaned items (zero active linked accounts) are self-healed before the envelope opens. Both correctly produce no row — nothing was attempted, no provider was called.
- **Stages per item:** BALANCES · HOLDINGS (or SKIPPED `NOT_APPLICABLE`) · TRANSACTIONS · RECONCILIATION (when there are cash/card targets) · SNAPSHOT SKIPPED(`BUDGET`). Derives **SUCCEEDED** — a SKIPPED stage never degrades.
- **Contention:** `TRANSACTIONS` SKIPPED(`IN_FLIGHT`), nothing else attempted, execution derives **SKIPPED**, `admissionReason` stays null (contention is not policy deferral — `deriveIngestionDeferral` already distinguishes them).
- **Failure:** the open stage is finalized FAILED by `failOpen`, the execution derives FAILED, and the **original error object** is rethrown so the caller's `classifyPlaidErrorForHealth` is byte-identical.
- **`ProviderCall` attribution** now covers the fan-out's `accountsGet`, `investmentsHoldingsGet`, `investmentsTransactionsGet` and every paginated `transactionsSync`. The loop is sequential, so each item owns its own ALS context — no cross-attribution.
- **`SyncIssue.detail.runId` becomes joinable.** Previously `syncTransactionsForItem` minted a fallback UUID that matched no execution, so `lib/platform/incidents/lifecycle.ts` resolved `resolvingExecutionId` to **null** for every incident touched by an all-items refresh. It now resolves.
- **Row volume** is bounded by the existing 20/hour per-user rate limit × the user's connection count — the same grain cron already writes nightly.

### Behavior preserved (asserted, not assumed)

`withPlaidItemSyncLock` · per-item `try/catch` · health classification + owner notification · `skipped: "in-flight"` result · original error identity · `deferSnapshot: true` · exactly one post-loop `regenerateCompletedSpaces` with the same succeeded/failed inputs · `RefreshSummary` shape, totals and `itemCount` · the route's response and audit row · branch A, cron, webhook, reconnect, resume and operator resync.

### Tests

| Group | What it proves |
|---|---|
| 1 · per-item envelope | **Behavioural.** Real `runManualItemRefresh` driving the **real** `runFullRefresh` over an in-memory `RefreshExecutionWriteClient`. One execution, MANUAL/FULL_REFRESH, no `parentJobRunId`; **negative controls** that `refreshPlaidItem` received a recorder and the execution's own `runId`; the recorder's stage records land **under** that execution (proving it is the live one, not a stub); `deferSnapshot` preserved; SNAPSHOT SKIPPED(BUDGET); coverage rows; provider-call context established; closes SUCCEEDED. |
| 2 · contention | Execution opened before the lock; `refreshPlaidItem` never called; TRANSACTIONS SKIPPED(IN_FLIGHT); derives SKIPPED; no invented `admissionReason`; caller still gets `{ok:false, reason:"in-flight"}`. |
| 3 · failure | Original error object rethrown (identity); open stage FAILED via `failOpen`; derives FAILED; `errorSummary` set; lock released. |
| 4 · fan-out | **Behavioural.** Real `refreshAllActiveItemsForUser` over injected collaborators, 5 items (ok / orphan / locked / throws / ok): one envelope per **eligible** item in order; orphan self-healed with no envelope; `itemCount` still 5; results 4; skip vs failure distinguished; totals aggregate only successes; `regenerateCompletedSpaces` runs **exactly once** with only succeeded accounts and the failed item id. |
| 5 · eligibility edges | Cooldown exclusions reach the candidate query and never reach the envelope; empty candidate set ⇒ no executions. |
| 6 · structural | Fan-out body never calls `refreshPlaidItem` or claims the lock itself; the injected default **is** `runManualItemRefresh`; the authority is entered **before** the lock; MANUAL/FULL_REFRESH declared; no route-local execution record; no `runJob`/`parentJobRunId`. |
| 7 · blast radius | Branch A still locks outside (unchanged); cron / webhook / resume-sync / `/sync` still reach the authority as before. |

**Ratchet verified by mutation.** The defect was temporarily reintroduced (recorder + runId dropped from the `refreshPlaidItem` call). `refresh-fanout.test.ts` failed with **10** assertions, led by both negative controls, then passed again on restore. A ratchet that has never been observed to fail is not known to be a ratchet.

### Validation

| Check | Result |
|---|---|
| `npm test` | **408/408** at validation (407 before + this file). A later run in the same working tree reads 409/409 — an unrelated work-in-progress test file (`lib/investments/quantity-replay.core.test.ts`) appeared during the session; it is **not** part of this commit. |
| `npx tsc --noEmit` | **0 errors** outside the gitignored `prototype/` tree (pre-existing there, untouched) |
| `npm run lint` | **0 errors**, 7 pre-existing warnings — none in changed files |
| Focused | `refresh-fanout` · `execution-convergence` · `refresh-execution` · `sync-lock` · `freshness-pipeline` · `producer-convergence` · `admission-boundary` — all PASS |
| Provider calls made | **none** (every collaborator injected) |
| Database writes | **none** |
| Production execution | **none — and none approved** |

### Read-only production verification plan (NOT executed; requires explicit approval)

1. `SELECT count(*) FROM "RefreshExecution" WHERE "plaidItemId" IN (…user's items…)` — baseline; note `max(startedAt)`.
2. Execute **one** topbar-equivalent manual refresh (no `plaidItemId` body).
3. `SELECT id, "runId", trigger, profile, "overallStatus", "plaidItemId", "parentJobRunId" FROM "RefreshExecution" WHERE "startedAt" > $baseline` — expect `trigger='MANUAL'`, `profile='FULL_REFRESH'`, `parentJobRunId IS NULL`.
4. Assert **one row per eligible item**: `ACTIVE`, not cooldown-excluded, ≥1 live `AccountConnection` to a non-deleted `FinancialAccount`. Cooldown/orphan items must have **no** row.
5. `SELECT endpoint, "stageKind", status, "skipReason" FROM "RefreshEndpointResult" WHERE "refreshExecutionId" = ANY(…)` — expect BALANCES/TRANSACTIONS present and **SNAPSHOT SKIPPED/BUDGET**; a locked item shows only TRANSACTIONS SKIPPED/IN_FLIGHT.
6. `SELECT operation, status, attempt FROM "ProviderCall" WHERE "refreshExecutionId" = ANY(…)` — expect `accountsGet`, and `investmentsHoldingsGet` / `investmentsTransactionsGet` for investment items, `transactionsSync` one row per page.
7. Join `SyncIssue.detail->>'runId'` to `RefreshExecution."runId"` for issues created in the window — expect matches where previously **null**.
8. `SELECT "spaceId", date, "createdAt" FROM "SpaceSnapshot" WHERE date = CURRENT_DATE` — one upserted row per affected Space, **and confirm it carries no execution attribution** (DRIFT-5 remains open; this step verifies the gap, it does not close it).
9. `SELECT count(*) FROM "JobRun" WHERE "startedAt" > $baseline` — expect **0**.

### Residual gaps after this slice

| Drift | Status | Owner slice |
|---|---|---|
| **DRIFT-1** — all-items fan-out off the ledger | **CLOSED** | this slice |
| **DRIFT-2** — reconstruction is not a declared stage; DERIVED rows rewritten from four frames down inside two best-effort catches | **OPEN** | OPS-REFRESH-1B |
| **DRIFT-3** — execution identity never reaches a financial row; *"which refresh changed this?"* still unanswerable on **every** path | **OPEN** | QUANTITY-1H prerequisite |
| **DRIFT-4** — cron wealth self-heal, cron event ingest and resume-sync wealth regen run post-envelope and rewrite historical snapshots unattributed | **OPEN** | OPS-REFRESH-1C (scope decision) |
| **DRIFT-5** — the fan-out's post-loop snapshot regeneration is item-less and unattributed; SNAPSHOT SKIPPED(BUDGET) **discloses** the deferral, it does not attribute the write | **OPEN** | OPS-REFRESH-1C |
| **NEW** — branch A claims its lock outside the envelope, so a 409 in-flight leaves no evidence; the two manual branches now differ in contention evidence | **OPEN** | OPS-REFRESH-1D |
| `HISTORY_BACKFILL` closes with no facts at all | **OPEN** | OPS-REFRESH-1B |
| Scripts unledgered | **OPEN** | unscheduled |

---

## Proposed next slices (NOT implemented, NOT approved)

### OPS-REFRESH-1B — Reconstruction as a declared stage

Give position reconstruction a stage on the profiles that actually run it, so a
rewrite of DERIVED position history is visible and a failure is diagnosable
instead of swallowed by two nested best-effort catches. Also fill
`HISTORY_BACKFILL`'s empty facts (rows written, window, accounts). No schema. The
open question is stage vocabulary: reuse `INVESTMENT_ACTIVITY` (already reserved,
already the name §M uses for `investmentsTransactionsGet`) or add a distinct
`RECONSTRUCTION` — the §F test is whether a reconstruction failure needs a
different diagnosis from an event-ingest failure. It does; that argues for a new
stage, and the string column needs no migration to gain one.

### OPS-REFRESH-1C — Fan-out ownership for aggregate snapshot regeneration

Decide what the post-loop `regenerateCompletedSpaces` write **belongs to**. The
honest candidate is a `JobRun` (trigger `"manual"` — the vocabulary already
exists on the model) covering the fan-out, with each item's `parentJobRunId`
pointing at it; that gives the aggregate write an owner and simultaneously
retires DF-2B.1's cron-parent gap by the same mechanism. Scope decision to settle
first: whether the same treatment extends to DRIFT-4's post-envelope cron and
resume-sync wealth regeneration, which is the larger and more consequential half.

### QUANTITY-1H prerequisite — Execution provenance and supersession for derived rows

The durable answer to *"which refresh changed this?"* and the structural
precondition for the six-point contract in the investigation's §7.2. Adopt the
`ImportBatch` pattern — a nullable soft reference on derived rows naming the run
that produced them — and **supersede instead of hard-delete** so a prior
reconstruction generation remains inspectable. This is a schema change and
belongs to QUANTITY-1H, not to the OPS-REFRESH arc. Sequencing note: every DERIVED
`"reconstruction"` row in the database today was written by a run that left no
record of itself, from an anchor overwritten on the next repair, replacing a
generation that was hard-deleted — so a QUANTITY-1C-vs-existing disagreement will
not be diagnosable to a cause until this lands.
