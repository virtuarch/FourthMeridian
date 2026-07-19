# CONN-2 — Financial Intelligence Reconstruction: Implementation Audit

**Status:** INVESTIGATION COMPLETE. Gated deliverable for the CONN-2 implementation (amendments A–H). Implementation of each item follows only after the architecture below is confirmed; the multi-account rebuild trigger (CONN-2B) is **blocked on one decision** (§6).
**Date:** 2026-07-19.
**Layer:** L2 (financial-intelligence reconstruction) ONLY. Do NOT touch L3 freshness (balance refresh, today's-snapshot authority, `FinancialAccount.balance` writes, current-value pipelines) — even where the bugs are related. CONN-2 answers *"Is Fourth Meridian's intelligence built?"*; CONN-3 answers *"Is today's state current?"*

---

## 1. Reconstruction engine map (verified)

| Engine | Fn / file | Trigger | Persisted output | Progress signal |
|---|---|---|---|---|
| Live snapshot (L3-adjacent) | `regenerateSpaceSnapshot` / `…ForAccounts` (`lib/snapshots/regenerate.ts`) | refresh, connect, account mutations, events | today's `SpaceSnapshot` | none (sync upsert) |
| **Historical wealth timeline (L2 core)** | `regenerateWealthHistory` / **`regenerateWealthHistoryForAccounts(faIds, window)`** (`lib/snapshots/regenerate-history.ts:551`) | connect pipeline, crons, per-account `[id]/sync`, wealth-amend | historical `SpaceSnapshot` rows (`isEstimated`) | none of its own |
| Cash-flow history | `cash-flow-projection.ts` / `cash-flow-space-data.ts` (PURE) | **read-time only** | **nothing — no table** | none — derived from `Transaction` at read |
| Connect full-history | `runDeferredHistorySync` (`lib/plaid/backgroundHistorySync.ts:275`) | connect `after()` + webhook | clears `syncIncompleteAt`, then `PLAID_HISTORY_SYNCED` audit | `syncIncompleteAt` (importing→ready) **then** `PLAID_HISTORY_SYNCED` |
| Refresh (already-ready) | `refreshPlaidItem` / `refreshAllActiveItemsForUser` (`lib/plaid/refresh.ts`) | manual/bulk refresh | today's snapshot; `PLAID_REFRESH` audit | **NONE the poller reads** ⚠️ |
| Wealth amend | `applyAmendment` (`lib/snapshots/snapshot-amendment.ts:169`) | `RebuildHistoryButton` (personal, consented) | rewrites historical `SpaceSnapshot`; `SnapshotAmendment[Day]`; `SNAPSHOT_AMENDMENT_APPLIED` | audit/amendment rows only; no poller signal |

**Key derivations confirmed:** cash-flow "history" has no engine — it is a read-time projection over `Transaction`, so the only thing it needs reconstructed is the transactions themselves. Per-account availability = `MIN(non-deleted Transaction.date)` grouped by `financialAccountId` (`app/api/spaces/[id]/accounts/route.ts:84-110`) — the SAME definition the wealth regen floor uses. A transaction **count** is PCS-2-consistent (carries no money, like account count) but net-new to the connections contract.

---

## 2. The RECONSTRUCTING window — the signal CONN-2 is built on

`runDeferredHistorySync` order (`backgroundHistorySync.ts:275-291`):
```
syncTransactionsForItem(itemId)   → clears syncIncompleteAt = null  (syncTransactions.ts:551)
backfillHistoryForItem(itemId)    → snapshot backfill + A9 wealth-history reconstruction
recordSyncComplete(itemId)        → writes PLAID_HISTORY_SYNCED audit row
```
`sync/status.ts` flips the connection to `"ready"` the moment `syncIncompleteAt` is null — it does **not** wait for reconstruction. **Therefore a real, derivable interval exists where `state === "ready"` (transactions done) but `PLAID_HISTORY_SYNCED` has not been written (intelligence still building).** This is the `RECONSTRUCTING` phase — and the exact reason CONN-2G is needed: "provider sync complete" ≠ "financial profile ready."

---

## 3. CONN-2A + 2E — the derived projection (no new authority)

Two views of ONE pure derivation over existing truth. **No persisted state, no second sync authority.**

### `ConnectionIntelligenceStatus` (CONN-2A)
```
transactionHistory: READY | IMPORTING | UNKNOWN     // from SyncConnection.state
intelligence:       READY | REBUILDING | NOT_READY  // see rules
availableHistory:   { years, months, days } | null  // today − earliestTxDate
earliestTransactionDate: string | null              // MIN(non-deleted Transaction.date)
lastReconstructedAt:     string | null              // latest PLAID_HISTORY_SYNCED.createdAt
```
Rules (Plaid): `intelligence = READY` iff a `PLAID_HISTORY_SYNCED` row exists for the item; `REBUILDING` iff `state === "ready"` but no such row (the §2 window); else `NOT_READY`. `transactionHistory`: importing→IMPORTING, ready→READY, error/needs_reauth→UNKNOWN.
Wallet: no `PLAID_HISTORY_SYNCED` — `syncBtcWallet` runs `regenerateWealthHistoryForAccounts` inline before setting `Connection.lastSyncedAt`, so `intelligence = READY` iff `state === "ready"`; `lastReconstructedAt = Connection.lastSyncedAt` (best-effort proxy, documented).

### `ConnectionLifecycleProjection` (CONN-2E) — derived UI phase
`IMPORTING | RECONSTRUCTING | READY | ACTION_REQUIRED | RETRYING | REMOVING`, derived (never persisted; provider truth stays boring `ACTIVE/NEEDS_REAUTH/ERROR/REVOKED`):
- `ACTION_REQUIRED` ← state needs_reauth/error
- `IMPORTING` ← state importing
- `RECONSTRUCTING` ← state ready AND intelligence REBUILDING
- `READY` ← state ready AND intelligence READY
- `RETRYING` — **client-augmented only** (the resume-attempt bookkeeping already in `ConnectionsList`); not server-derivable, surfaced as a client refinement of IMPORTING.
- `REMOVING` — **forward slot**; no disconnect-in-progress signal exists yet (deferred, §7). NOT fabricated.

Only the four data-backed phases render now; RETRYING/REMOVING are documented slots, honoring "only show data-backed stages."

---

## 4. CONN-2C/2G — lifecycle UI + completion semantics

The card gains an explicit **RECONSTRUCTING** content between IMPORTING and READY:
```
Building your financial intelligence
✓ Transactions available
✓ Accounts mapped
⟳ Rebuilding timeline
○ Updating charts
○ Refreshing insights
You can leave this page.
```
No percentages — stages map to derived truth (transactions/accounts = done facts; timeline/charts/insights = the reconstruction in flight, anchored by `PLAID_HISTORY_SYNCED`). **CONN-2G:** the card says "You're ready / Financial profile ready" ONLY at `READY` (intelligence READY), never at the `ready`-state-but-REBUILDING window.

**Polling implication:** the `ConnectionsList` poller currently stops when `status.building` clears (all `syncIncompleteAt` null) — which is BEFORE reconstruction finishes. CONN-2 extends the keep-polling condition to `building || anyRebuilding`, and the poll payload (`/api/sync/status`) carries the intelligence map so the card advances RECONSTRUCTING→READY live. Completion still derives SOLELY from persisted state (the `PLAID_HISTORY_SYNCED` row), never a notification.

---

## 5. Data threading

`ConnectionsSpaceData` and `loadConnectionsSyncStatus` (the poll) both gain `intelligenceByConnectionId: Record<string, ConnectionIntelligenceStatus>`, assembled from: PlaidItem/Connection state (already read) + a single `PLAID_HISTORY_SYNCED` AuditLog read for the user (indexed `(userId, createdAt)`, grouped by `metadata.plaidItemId` in JS — low volume) + a `Transaction` min-date (+ optional count) `groupBy`. **Pure derivation, PCS-2-safe** (status/dates/counts, no balances/valuations). The per-account availability (`earliestTxDate`) extends `accountsByConnectionId`.

---

## 6. ⚠️ CONN-2B decision — which engine does "Rebuild Financial History" trigger?

The CONN-2 spec says reuse `refreshAllActiveItemsForUser({ includeItemIds })`. Investigation shows that engine is the **wrong** tool for rebuilding *intelligence*:
- `refreshPlaidItem` re-fetches balances via `accountsGet` (**L3 balance writes** — the boundary CONN-2 must not cross) and re-syncs transactions (L1), then regenerates **today's** snapshot — but it does **NOT** call `regenerateWealthHistoryForAccounts`, so it does **not rebuild the historical timeline** at all.
- The actual L2 reconstruction authority is **`regenerateWealthHistoryForAccounts(faIds, window)`** — rebuilds historical wealth timeline from *existing* transactions, no Plaid fetch, no balance writes. It is already multi-account.

**Options for the multi-account "Rebuild selected timelines" trigger:**
- **(A) `regenerateWealthHistoryForAccounts`** — pure L2; rebuilds the timeline from existing data; no balance/L3 touch; already multi-account. *(Recommended — matches the L2 doctrine and the no-freshness constraint. Reuses an existing authority; no new engine.)*
- **(B) `refreshAllActiveItemsForUser` + `includeItemIds`** (as originally specced) — re-syncs transactions + refreshes balances (L3) + today's snapshot, but does NOT rebuild the historical timeline. Crosses the L3 boundary and doesn't achieve the L2 goal.
- **(C) `applyAmendment`** (wealth-amend) — the existing *user-facing* reconstruction; pure recompute from existing data; but space-wide + PERSONAL-only + consent/preview flow + writes `SnapshotAmendment` rows.

This blocks only CONN-2B. The `includeItemIds` filter is still worth adding (additive, tested) if (B) or a hybrid is chosen; if (A), the multi-account trigger is `regenerateWealthHistoryForAccounts` over the selected connections' accounts and `includeItemIds` on the refresh path is unnecessary. **Awaiting the decision before building the rebuild trigger.**

*(Implementation note for `includeItemIds` if chosen: `excludeItemIds` applies as `id: { notIn }` at `refresh.ts:445`. To compose with `includeItemIds` (`id: { in }`) both must be merged into ONE `id` filter object — two separate `id:` spreads would overwrite. Prisma ANDs `{ in, notIn }` within a single field filter.)*

---

## 7. Implementation order (aligned to the CONN-2 priority list)

| # | Item | Blocked? | Risk |
|---|---|---|---|
| 1 | ✅ Frozen second-account spinner | done (7f521de) | — |
| 2 | **CONN-2A** readiness projection (`ConnectionIntelligenceStatus` + `ConnectionLifecycleProjection`) + tests | no | none (pure derivation) |
| 3 | **CONN-2C/2G** reconstruction lifecycle UI + completion semantics + poller keep-alive for RECONSTRUCTING | no | low (presentation + poll payload) |
| 4 | **CONN-2H** empty-state transformation copy | no | none |
| 5 | **CONN-2B (engine)** `includeItemIds` filter | **§6 decision** | low (additive) |
| 6 | **CONN-2B (UI)** multi-account rebuild control | **§6 decision** | low-med |
| 7 | **CONN-2D** customer Connection Truth Timeline (per-connection 4-layer diagnostics) | no | low |
| 8 | **CONN-2F** operator diagnostics panel (Platform Ops / CS) | no | low |
| 9 | Disconnect lifecycle (`REMOVING`) — CONN-2/CONN-3 boundary | — | deferred (boundary decision) |

Items 2–4 and 7–8 are pure derivation + presentation and land first as tested sub-slices. Items 5–6 wait on §6. Item 9 is documented and deferred.

---

## 8. Documented gaps (not invented away)

1. **Refresh re-reconstruction is invisible** (`refresh.ts`): a refresh of an already-ready connection sets no `syncIncompleteAt`, writes no new `PLAID_HISTORY_SYNCED`, and doesn't run the historical wealth regen — so re-reconstruction has no poller-visible progress. Any user-triggered rebuild (CONN-2B) must emit its own progress signal (or the UI must poll a rebuild-specific marker) rather than assume the existing poller shows it. Design the CONN-2B trigger to surface progress explicitly; do not claim the existing poller covers it.
2. **Cash-flow / charts have no reconstruction progress** because they are read-time projections — the "Updating charts / Refreshing insights" stages track the *snapshot/wealth* reconstruction (the only persisted rebuild), not separate engines. The stage labels are honest about readiness, not backend jobs.
3. **Wallet `lastReconstructedAt`** has no dedicated audit anchor; it proxies `Connection.lastSyncedAt` (reconstruction runs inline before it's set). Documented, not fabricated.

**Constraints honored:** no new sync engine · no second sync state machine · provider truth unchanged · no DayFacts/FlowType/valuation/balance-refresh changes · completion derives from persisted state · reconstruction reuses existing `regenerate*` authorities.
