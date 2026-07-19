# CONN-3 — Financial Freshness Pipeline: Investigation & Architecture Audit

**Status:** INVESTIGATION COMPLETE (gated deliverable). Implementation follows only after this architecture is confirmed.
**Date:** 2026-07-19.
**Layer:** L3 (current freshness) ONLY. CONN-3 owns "is today's financial state current?" — balances + today's `SpaceSnapshot`. It does NOT touch L1 acquisition semantics or L2 intelligence reconstruction. **No FlowType / DayFacts / transaction-semantics changes; no new snapshot engine; no new balance authority.**

---

## 0. Executive summary

- **Root cause (confirmed):** only the manual **Refresh** path calls Plaid `accountsGet` (refreshing `FinancialAccount.balance`) and regenerates today's `SpaceSnapshot`. Every routine background path — **webhook, cron, "Sync Now"** — runs `syncTransactionsForItem`, which writes cursor + transaction rows + `lastSyncedAt` only, and **never** touches balances or today's snapshot. So a posted payment updates transactions while the displayed balance/snapshot stay stale until a manual Refresh.
- **No migration needed.** All three freshness timestamps already exist: **data** = `PlaidItem.lastSyncedAt`; **intelligence** = `PLAID_HISTORY_SYNCED` audit (CONN-2 `lastReconstructedAt`); **balance** = `FinancialAccount.lastUpdated` (+ `balanceLastUpdatedAt` provenance), written today only by `refreshPlaidItem`'s accountsGet block.
- **No new engine.** The balance-refresh logic is inline in `refreshPlaidItem` (`refresh.ts:142-200`). Extract it into a reusable `refreshBalancesForItem`; call it + the existing `regenerateSnapshotsForAccounts` from the webhook + cron paths. This is one balance authority, reused — not duplicated.

---

## 1. Freshness matrix (verified)

| Trigger | `accountsGet`? | balance write? | today-snapshot regen? | historical wealth regen? | timestamps set |
|---|:--:|:--:|:--:|:--:|---|
| **Manual Refresh** (`refreshPlaidItem` / `refreshAllActiveItemsForUser`) | ✅ `refresh.ts:147` | ✅ `refresh.ts:173-185` | ✅ `refresh.ts:279` / `:360` | ❌ | `FinancialAccount.lastUpdated`+`balanceLastUpdatedAt`; `PlaidItem.lastSyncedAt`, `syncIncompleteAt=null`, cursor |
| **Webhook** (`syncPlaidItemFromWebhook`→`runDeferredHistorySync`) | ❌ | ❌ | ❌ | ✅ (gated) + new-space backfill | `lastSyncedAt`, cursor; `PLAID_HISTORY_SYNCED` |
| **Cron** (`jobs/sync-banks.ts` `syncBanks`) | ❌ | ❌ | ❌ | ✅ (gated) | `lastSyncedAt`, cursor |
| **"Sync Now"** (`/api/plaid/sync`) | ❌ | ❌ | ❌ | ❌ | `lastSyncedAt`, cursor |
| **Connect** (`exchange-token` → `runDeferredHistorySync`) | ✅ at import (exchange-token) | ✅ at import | ✅ at import (exchange-token) | ✅ (max window, CONN-2) | all |

`syncTransactionsForItem` (`syncTransactions.ts`): grep confirms **zero** `accountsGet` / `.balance` writes; final `setPlaidItemHealth` stamps `lastSyncedAt` + clears `syncIncompleteAt` + advances cursor only.

`regenerateSpaceSnapshot` reads the **stored** `FinancialAccount.balance` (via `getAccounts` → `r.balance`), so regenerating a snapshot without a prior balance refresh just re-stamps the stale balance — exactly what the deferred-snapshot-cron note warns about (`lib/jobs/registry.ts` S3: *"the daily sync refreshes transactions, not balances — a scheduled snapshot would stamp stale balances as fresh"*).

---

## 2. The three freshness states (all real — no schema change)

| State | Question | Field | Written by |
|---|---|---|---|
| **Data freshness** | "when did we last receive provider data?" | `PlaidItem.lastSyncedAt` | `syncTransactionsForItem` |
| **Intelligence freshness** | "when did we last build projections?" | `PLAID_HISTORY_SYNCED` / `CONNECTION_INTELLIGENCE_REBUILT` audit (CONN-2 `lastReconstructedAt`) | `recordSyncComplete` / recovery |
| **Balance freshness** | "when did we last confirm current balances?" | `FinancialAccount.lastUpdated` (per account; connection = MAX across its accounts) | `refreshPlaidItem` accountsGet block only |

Reading `FinancialAccount.lastUpdated` on the Connections surface is a **timestamp**, not a balance value — PCS-2-safe (no money exposed), and it is the L3 concern CONN-3 owns. The projection selects only the timestamp column, never `balance`.

---

## 3. Design — the canonical freshness pipeline (reuse only)

```
Provider event (webhook)  ──┐
Cron sweep (sync-banks)   ──┤
                            ▼
              syncTransactionsForItem   (L1 — unchanged)
                            ▼
     refreshBalancesForItem(itemId)      (extracted from refreshPlaidItem — ONE balance authority)
        accountsGet → write FinancialAccount.balance + lastUpdated + balanceLastUpdatedAt
                            ▼
     regenerateSnapshotsForAccounts(ids)  (existing snapshot authority — now stamps FRESH balances)
                            ▼
        FinancialAccount.lastUpdated + today's SpaceSnapshot are current
                            ▼
              user sees current balance / net worth / cash flow / charts
```

### 3.1 Extract the balance authority (behavior-preserving refactor)
`refresh.ts:142-200` → `export async function refreshBalancesForItem(plaidItemDbId): Promise<{ item, accessToken, plaidAccounts, itemData, accountsUpdated, updatedAccountIds, reconcileTargets }>`. `refreshPlaidItem` calls it and continues (holdings/tx/M2-reconcile/snapshot) from the returned context — **identical behavior**. The M2 reconcile capture rides along (returned), used only by `refreshPlaidItem`.

### 3.2 Wire into the background paths
- **Webhook + connect** — `runDeferredHistorySync` (`backgroundHistorySync.ts`): after `syncTransactionsForItem`, call `refreshBalancesForItem` then `regenerateSnapshotsForAccounts(updatedAccountIds)`. Best-effort/non-fatal (never fails the sync). At connect this is a harmless re-confirm (exchange-token already refreshed synchronously); on webhook it is the fix.
- **Cron** — `syncBanks` (`jobs/sync-banks.ts`): per item, under the existing `withPlaidItemSyncLock`, same two calls after `syncTransactionsForItem`. This **resolves the S3 blocker**: a snapshot is only ever written immediately after a balance refresh, so it can never stamp a stale balance.

"Sync Now" (`/api/plaid/sync`) stays transactions-only by design (it is the explicit lightweight tx-only trigger); the automatic freshness guarantee is delivered by webhook (real-time) + cron (fallback). Documented, not changed.

### 3.3 UX — three unambiguous freshness lines (CONN-3)
The card must not say the ambiguous "Synced". `ConnectionIntelligenceStatus` gains `balanceVerifiedAt` (MAX `FinancialAccount.lastUpdated` across the connection's accounts). The ready card + the CONN-2D timeline "Current freshness" render:
```
Transactions:     Updated <lastSyncedAt>
Financial profile: Built  <lastReconstructedAt>
Balance:          Verified <balanceVerifiedAt>
```
All relative, honest, null-safe.

---

## 4. Constraints honored / risks

- **No FlowType / DayFacts / transaction-semantics change** — `syncTransactionsForItem` is untouched; CONN-3 only adds a balance refresh + existing snapshot regen after it.
- **No new snapshot engine, no new balance authority** — `refreshBalancesForItem` is an *extraction* (one authority, reused); `regenerateSnapshotsForAccounts` is the existing snapshot authority.
- **No migration** — all timestamps exist; DB-safety protocol not triggered (if a dedicated `balanceVerifiedAt` column is ever wanted to disambiguate accountsGet from connect/manual writes, it would follow backup→safe-migrate, but it is NOT needed now — `lastUpdated` suffices for Plaid).
- **Cost:** an extra `accountsGet` per webhook/cron item. Acceptable (per-item, cheap; the manual path already does it). Best-effort so a balance-refresh failure never blocks transaction sync.
- **Regression guard:** initial-connect max-history build (CONN-2) is unaffected — the balance refresh is additive after the existing sync; the CONN-2 wealth-window logic is untouched.

---

## 5. Implementation order

1. Extract `refreshBalancesForItem` in `refresh.ts`; `refreshPlaidItem` delegates (behavior-preserving). Tests: refreshPlaidItem still refreshes balances + snapshot.
2. Wire `refreshBalancesForItem` + `regenerateSnapshotsForAccounts` into `runDeferredHistorySync` (webhook) and `syncBanks` (cron). Tests: source-scan that webhook+cron now refresh balances + snapshot; single balance authority (no duplicated accountsGet).
3. Add `balanceVerifiedAt` to the intelligence projection + loader (timestamp only). Card + timeline show the three freshness lines. Tests: `balanceVerifiedAt` derivation.
4. Browser-verify: the freshness lines render; (balance-staleness end-to-end needs a real posted-transaction webhook — verified structurally + via the manual path parity).

**Success criteria:** after CONN-3, a cleared credit-card payment is reflected in balance / debt / net worth / cash flow / charts within the provider sync window (webhook, else cron) with no manual refresh or reload.
