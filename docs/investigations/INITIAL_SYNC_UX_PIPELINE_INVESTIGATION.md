> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# Initial Sync UX Pipeline — Investigation Report

**Date:** 2026-07-03
**Branch:** feature/v2.5-spaces-completion
**Status:** Investigation complete. No code, schema, migration, route, or UI modified.
**Related:** `PLAID_TRANSACTION_HISTORY_DEPTH_INVESTIGATION.md`, `INITIAL_DAILYSNAPSHOT_BACKFILL_INVESTIGATION.md`

---

## 0. TL;DR

- The first-connection flow already does the right *work* synchronously inside one request: exchange → accounts/balances → holdings → initial `/transactions/sync` → snapshot regen → one `router.refresh()`.
- The "sync → wait → manual refresh" feeling is **not** a depth-config bug. `days_requested: 730` is already set (the depth investigation's fix shipped). The problem is **availability latency**: at Link time Plaid has only prepared a recent slice of transactions; the full ~2-year history lands **asynchronously** at Plaid and needs a **later** sync to be pulled in.
- That later sync has **no low-latency trigger today.** There is **no Plaid webhook endpoint** (`SYNC_UPDATES_AVAILABLE`), the in-process scheduler (`startScheduler`) is **dormant**, and the only production catch-up is a **once-daily Vercel cron** (`/api/jobs/sync-banks`, 06:00 UTC). So the user's fastest path to deep history is the **manual Refresh button** — exactly what we want to remove.
- Almost all the primitives already exist and are idempotent: `syncTransactionsForItem` (cursor + unique `plaidTransactionId` + fingerprint fallback), the cron target, `PlaidItem` status/cursor/timestamp fields, `ImportBatch` as a staged-job precedent, and the snapshot-regen function.
- Recommended: a **staged, best-effort background continuation** after exchange, a **pollable status surface**, and a **webhook** as the eventual event-driven upgrade — introduced in additive phases, most of which need **no schema change**.

---

## 1. Current initial sync flow (end-to-end)

| Stage | Location | Notes |
|---|---|---|
| Link open + `onSuccess` | `context/PlaidContext.tsx` | Single `usePlaidLink`. `onSuccess` sets `importing`, POSTs the public_token, then `router.refresh()` once. |
| Link exchange | `app/api/plaid/exchange-token/route.ts` → `lib/plaid/exchangeToken.ts` `performPlaidTokenExchange` | Session context resolved in the route; all import work delegated to the lib. |
| Credential persist | `exchangeToken.ts` steps 2–5 | Exchange public→access token, encrypt, upsert `PlaidItem`, dual-write `Connection` (D2). |
| Accounts/balances import | steps 6–7 | `accountsGet`; per account resolve/create `FinancialAccount` + `AccountConnection` + `SpaceAccountLink` (atomic per KD-4). |
| Holdings sync | step 8 | Consent-gated `investmentsHoldingsGet`; delete-then-recreate; `computeCashResidual` synthetic CASH row. |
| Initial transaction sync | step 9 → `lib/plaid/syncTransactions.ts` `syncTransactionsForItem` | Null cursor → pulls **whatever history Plaid has prepared so far**, looping `has_more`. Best-effort / non-fatal. |
| Snapshot regen | step 9b → `lib/snapshots/regenerate.ts` | `regenerateSnapshotsForAccounts` writes **today's** `SpaceSnapshot` for every space the accounts are shared into. |
| UI refresh | `PlaidContext.onSuccess` | Awaits the whole request, then a single `router.refresh()`. No polling, no progress states. |

**Key structural fact:** everything above runs **inside the one exchange request**, and the request returns only counts (`imported`, `holdingsImported`, `transactionsSynced`). There is no continuation after the response.

---

## 2. Historical transaction depth

- **`transactions.days_requested` IS configured** — `app/api/plaid/link-token/route.ts` sets `transactions: { days_requested: 730 }` for every new Item (the D4 fix recommended by `PLAID_TRANSACTION_HISTORY_DEPTH_INVESTIGATION.md`). 730 days is the max useful depth; no per-institution tuning needed.
- **Depth requested ≠ depth available at Link time.** Plaid initializes an Item's transactions asynchronously; the first `/transactions/sync` returns only the ready slice, and Plaid emits `SYNC_UPDATES_AVAILABLE` (historically `INITIAL_UPDATE` / `HISTORICAL_UPDATE`) when the deeper window is ready. **This latency, not the config, is the current UX problem.**
- **Immutability caveat (from the depth investigation):** `days_requested` is fixed once Transactions is initialized on an Item. Items linked *before* the 730 fix are capped at 90 days and can only be expanded by `/item/remove` + relink — a separate, deferred workflow. The pipeline here concerns **new** connections, which are correctly initialized at 730.
- **Relationship to the prior investigation:** that one answered "are we *requesting* enough?" (now: yes). This one answers "how do we *ingest and surface* what we requested without a manual refresh?"

---

## 3. Background job design — smallest safe pipeline

Proposed ordered stages, each idempotent and independently retryable:

1. **Connect** — exchange token, persist `PlaidItem`/`Connection` *(exists)*.
2. **Import current accounts/balances** — `accountsGet` + account link writes *(exists)*. **This is the fast path the user should see first.**
3. **Initial transaction sync** — `syncTransactionsForItem` on the ready slice *(exists)*.
4. **Background historical transaction sync** — re-run `syncTransactionsForItem` (same cursor-based function) after Plaid finishes preparing history, driven by webhook or a short post-link poll/continuation. **This is the missing piece.**
5. **Classification / categorization** — already inline in `mapPlaidCategory` during sync; no separate stage needed unless/until richer enrichment is added.
6. **Snapshot backfill** — once enough history exists, run the 30-day `SpaceSnapshot` backfill (see §8 and the backfill investigation).
7. **AI / indexing** — deferred; runs after the data pipeline settles.

**Design stance:** reuse `syncTransactionsForItem` unchanged as the pipeline's transaction engine (it is already webhook/cron/manual-safe). The pipeline is an *orchestration + status* layer on top, not new sync logic.

**Existing infra to reuse:** `jobs/sync-banks.ts` (batch sync of active items), `app/api/jobs/sync-banks/route.ts` (Vercel cron target, `vercel.json` → 06:00 UTC daily), `jobs/scheduler.ts` (dormant in-process scheduler), `jobs/take-snapshot.ts`, `lib/plaid/refreshCooldown.ts`.

---

## 4. UX states (user-facing status vocabulary)

Map each requested state to a real completion signal so the UI never lies:

| UX state | Backed by |
|---|---|
| **Accounts connected** | `PlaidItem` created + `FinancialAccount` rows written (step 7). |
| **Current balances ready** | Same — balances are current at import. This is the first "done" the user sees. |
| **Importing history** | Background historical sync (stage 4) in progress. |
| **Categorizing transactions** | Inline during sync; can be folded into "Importing history" unless separated later. |
| **Building 30-day chart** | Snapshot backfill running (stage 6). |
| **Historical insights ready** | Backfill complete + (later) AI indexing done. |

Precedent for honest, badged progressive states: `ChartFirstDayPlaceholder` ("Started tracking today…") and `lib/timeline-placeholder.ts` `isPreview` badging. States should be **derived from data/job status**, not timed guesses.

---

## 5. Removing the need for a manual refresh

Options, in preference order:

1. **Server-side job continuation (recommended first move).** After the exchange request returns the fast path (accounts + balances + ready-slice tx + today snapshot), continue the historical sync in the background. On Vercel/serverless the correct primitive is Next.js `after()` / `waitUntil` (work that outlives the response) **or** enqueuing a job the cron/worker picks up — *not* a detached promise, which serverless may kill after the response. Best-effort / non-fatal.
2. **Polling a lightweight status endpoint.** UI polls e.g. `GET /api/plaid/sync-status` reading `PlaidItem` (cursor/`lastSyncedAt`/status) or a job row, advancing the §4 states and re-fetching data when a stage completes. Replaces the single `router.refresh()`.
3. **Webhook (event-driven end state).** A `POST /api/plaid/webhook` handler for `SYNC_UPDATES_AVAILABLE` calls `syncTransactionsForItem` the moment Plaid has more — the lowest-latency, least-wasteful trigger. Requires signature verification, a public endpoint, and its own retry handling (explicitly out of scope of the existing sync lib, which is "exactly what it would call").
4. **Optimistic UI.** Show "Importing history…" immediately on connect; reconcile as real stages complete. Pairs with polling.
5. **Cron continuation (already exists, as backstop).** The daily `sync-banks` cron eventually pulls the rest even if webhook/poll misses — keep it as the safety net.

**Minimum viable "no refresh":** (1) + (2) — background continuation plus polling — removes the manual button without needing a public webhook. (3) is the eventual upgrade.

---

## 6. Idempotency and safety

- **Duplicate transactions:** `syncTransactionsForItem` upserts on unique `plaidTransactionId` with a fingerprint fallback (`financialAccountId + date + amount + merchant + pending`) — safe to run repeatedly and to overlap with the cron/manual sync.
- **Retry behavior:** cursor is persisted **only after** a full `has_more` loop completes, so a mid-loop failure retries from the last *persisted* cursor without skipping pages. `withPlaidRetry` wraps the Plaid calls.
- **Partial failures:** each stage is already best-effort/non-fatal (holdings, tx sync, snapshot regen, audit each in their own `try/catch`). One institution's failure never blocks others (`sync-banks` wraps per item).
- **Provider limits:** respect `lib/plaid/refreshCooldown.ts`; the pipeline's background sync should not compete with manual refresh (cooldown already models this). Batch/stagger per item.
- **Webhook/cron compatibility:** the same `syncTransactionsForItem` is the intended target for manual, cron, and webhook — no logic fork.
- **Not blocking Link success:** the fast path (accounts + balances) must commit and the request must return **before** the historical continuation; the continuation's failure must never surface as a Link failure. Current code already treats stages 8–9b as non-fatal.

---

## 7. Data model impact

**None strictly required for an MVP.** `PlaidItem` already carries partial job state: `cursor`, `lastSyncedAt`, `lastManualRefreshAt`, `status`, `errorCode`. Stages 1–3 + the snapshot can be surfaced from existing rows, and a status endpoint can infer "history still importing" from cursor/timestamps.

**If richer progress is wanted (additive only):**

- Minimal, on `PlaidItem`: nullable `initialSyncStage` (enum/string), `historicalSyncCompletedAt DateTime?`, `lastHistoricalSyncAt DateTime?`. Defaulted/nullable → existing rows unaffected.
- Fuller: a dedicated **`SyncJob` / `SyncStage`** table (per `PlaidItem`/`Connection`) with `status`, `stage`, progress counters (`addedCount`…), `lastError`/`errorSummary Json?`, timestamps. **Precedent already exists:** `ImportBatch` (status enum, `rowCount`/`importedCount`/`matchedCount`/`failedCount`, `errorSummary Json?`) is the file-import analogue and a good shape reference — but it is FK'd to a single `FinancialAccount` and file-import-shaped, so a Plaid `SyncJob` should be its own additive table rather than a reuse.
- **Error storage:** reuse the `errorSummary Json?` pattern from `ImportBatch`; `PlaidItem.errorCode` already stores the last Plaid error code.

Recommendation: **start with no schema change** (infer status from `PlaidItem`); add `SyncJob` only if the UX needs true per-stage progress counters.

---

## 8. Relationship to the 30-day snapshot backfill

Per `INITIAL_DAILYSNAPSHOT_BACKFILL_INVESTIGATION.md`, the backfill reconstructs cash from daily transaction sums and holds non-reconstructable components flat — so it is **only meaningful once the historical transaction window has actually landed**. Therefore backfill must be a **downstream stage of this pipeline**, not fired at exchange time:

- Trigger the backfill from **stage 6**, *after* the background historical sync (stage 4) reports the item's history is complete (webhook `SYNC_UPDATES_AVAILABLE` with no `has_more`, or cursor stabilized), and only for **new Spaces** (≤1 existing snapshot).
- This resolves the backfill investigation's "data-starved" risk: running it after deep history arrives means the 30-day cash reconstruction has real transactions to walk back through, rather than the shallow ready-slice available at Link time.
- The "Building 30-day chart" UX state (§4) is exactly this stage completing.

---

## 9. Phased implementation plan (smallest safe)

Each phase is independently shippable, independently revertible, best-effort/non-fatal, and preserves the current Plaid flow.

**Phase 0 — this document.** Investigation only.

**Phase 1 — Split the fast path (no schema).** Ensure the exchange request commits + returns after accounts/balances (+ ready-slice tx + today snapshot) so "Current balances ready" is immediate. Behavior-preserving reordering only.

**Phase 2 — Dark background continuation (no schema).** Add a background historical-sync runner that re-invokes `syncTransactionsForItem` for the new item via `after()`/`waitUntil` or an enqueued job. Not yet wired to UI; verify it lands deep history without a manual refresh. Idempotent by construction.

**Phase 3 — Status surface + polling (no schema).** Add `GET /api/plaid/sync-status` inferring §4 states from `PlaidItem` (cursor/`lastSyncedAt`/status). Replace `PlaidContext`'s single `router.refresh()` with poll-until-complete + progressive states. Removes the manual-refresh need for most users.

**Phase 4 — Snapshot backfill trigger.** Wire stage 6: after Phase 2 reports history complete, run the 30-day backfill for new Spaces (see §8). Depends on the backfill investigation's Phases 1–2.

**Phase 5 — Additive job model (only if needed).** Introduce `SyncJob`/`SyncStage` (or the `PlaidItem` nullable fields) for true per-stage progress counters + error storage. Defaulted/nullable; migrate nothing.

**Phase 6 — Webhook (event-driven upgrade).** `POST /api/plaid/webhook` for `SYNC_UPDATES_AVAILABLE` with signature verification + retry, calling the same runner. Keep the daily cron as backstop.

**Phase 7 — Background retry hardening.** Cooldown-aware retry/backoff for transient failures, reusing `refreshCooldown` and `withPlaidRetry`.

**Validation each phase:** `npx prisma generate` (+ `migrate dev` only if Phase 5), `npx tsc --noEmit`, `npm run lint`, targeted Link-flow run in dev.

**Rollback:** Phases 1–4/6–7 are code-only and revert by removing the added route/runner/handler; the cron backstop and manual Refresh remain functional throughout. Phase 5's fields/table are additive and default-inert.

---

## 10. Risks

- **Serverless continuation:** a detached promise after `res.json()` may be killed on Vercel — must use `after()`/`waitUntil` or an enqueued job, or the "background" sync silently never runs.
- **Depth availability variance:** some institutions/sandbox return history quickly, others slowly; polling must tolerate minutes, and the daily cron must remain the guaranteed backstop.
- **Pre-730 Items:** existing Items capped at 90 days won't deepen via this pipeline (needs relink — deferred).
- **Snapshot/visibility anachronism:** backfill trigger must honor the new-Space gating and link-createdAt floors from the backfill investigation.
- **Cost/limits:** background + cron + (later) webhook could triple-trigger the same item; cooldown + cursor idempotency contain this, but the orchestration must not fan out redundant full syncs.

---

## 11. Open questions for approval

1. Background continuation via Next.js `after()`/`waitUntil`, or via an enqueued job the existing cron/worker drains?
2. Ship "no manual refresh" on **polling only** (Phases 2–3), deferring the webhook (Phase 6) — acceptable given the daily cron backstop?
3. Start schema-free (infer status from `PlaidItem`), or introduce `SyncJob` up front for real progress counters?
4. Should the snapshot backfill (Phase 4) block the "Historical insights ready" state, or run fully in the background?
