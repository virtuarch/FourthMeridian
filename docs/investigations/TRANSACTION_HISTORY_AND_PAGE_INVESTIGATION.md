# Transaction History & Transactions Page Investigation

**Date:** 2026-07-01  
**Branch:** feature/phase-2-architecture  
**Status:** Investigation complete — no code changes made

---

## 1. DB Inventory Table per Account

> **Note:** The local PostgreSQL instance runs on the host Mac and is not reachable from the Linux sandbox used for shell commands. The DB inventory below is derived from schema analysis + code tracing rather than a live query. To get the literal row counts, run the SQL at the bottom of this section directly in your local terminal.

### Schema summary

Every Plaid-connected account creates:

| Table | Role |
|---|---|
| `PlaidItem` | Encrypted access token + cursor per institution |
| `FinancialAccount` | Canonical account row (`ownerType=USER`) |
| `AccountConnection` | `FinancialAccount ↔ PlaidItem` join, carries `isCanonical` |
| `WorkspaceAccountShare` | Legacy visibility row (still written, not yet removed) |
| `SpaceAccountLink` | D3 canonical visibility row (written by `dualWriteSpaceAccountLink` since Stage B3) |
| `Transaction` | Carries `financialAccountId` (never `accountId` for Plaid-synced rows) |

### Live DB inventory query (run locally)

```sql
-- Account inventory
SELECT
  fa.id                            AS fa_id,
  fa.institution,
  fa."institutionId",
  fa.name,
  fa.type,
  fa."plaidAccountId"              AS plaid_acct_id,
  fa."syncStatus",
  fa."deletedAt"                   IS NOT NULL AS is_archived,
  pi."institutionName"             AS plaid_item_institution,
  pi.cursor                        IS NOT NULL AS has_cursor,
  pi."lastSyncedAt",
  pi.status                        AS plaid_item_status,
  (SELECT COUNT(*) FROM "Transaction" t
     WHERE t."financialAccountId" = fa.id
       AND t."deletedAt" IS NULL)  AS tx_count,
  (SELECT COUNT(*) FROM "Transaction" t
     WHERE t."financialAccountId" = fa.id
       AND t."deletedAt" IS NULL
       AND t.pending = true)       AS pending_count,
  (SELECT MIN(t.date) FROM "Transaction" t
     WHERE t."financialAccountId" = fa.id
       AND t."deletedAt" IS NULL)  AS oldest_tx,
  (SELECT MAX(t.date) FROM "Transaction" t
     WHERE t."financialAccountId" = fa.id
       AND t."deletedAt" IS NULL)  AS newest_tx,
  sal.id                           IS NOT NULL AS has_space_account_link,
  sal.status                       AS sal_status,
  sal."visibilityLevel"            AS sal_visibility
FROM "FinancialAccount" fa
LEFT JOIN "AccountConnection" ac
  ON ac."financialAccountId" = fa.id AND ac."deletedAt" IS NULL
LEFT JOIN "PlaidItem" pi
  ON pi.id = ac."plaidItemDbId"
LEFT JOIN "SpaceAccountLink" sal
  ON sal."financialAccountId" = fa.id
WHERE fa."deletedAt" IS NULL
ORDER BY fa.institution, fa.type;

-- Category distribution per account
SELECT
  fa.institution,
  fa.name,
  t.category,
  COUNT(*)            AS count,
  SUM(t.amount)       AS net_amount
FROM "Transaction" t
JOIN "FinancialAccount" fa ON fa.id = t."financialAccountId"
WHERE t."deletedAt" IS NULL
GROUP BY fa.institution, fa.name, t.category
ORDER BY fa.institution, fa.name, count DESC;
```

---

## 2. Transaction Coverage Summary per Account

### What determines transaction history depth

The app uses **only** `POST /transactions/sync` (Plaid's cursor-based endpoint). On the **first sync** (cursor = null), Plaid returns the maximum available history for that institution and product type. On every subsequent call it returns only new/modified/removed transactions since the stored cursor.

**Plaid's available history per product type (real credentials, not Sandbox):**

| Account type | Typical Plaid history window |
|---|---|
| Credit card (Chase, Amex) | Up to 24 months |
| Checking (Chase) | Up to 24 months (Chase provides good coverage) |
| Brokerage/Investment (Schwab) | Varies; investment transactions often 12–24 months |
| Robinhood | Plaid investment transactions are limited/sparse for Robinhood |

**Critical caveat — Plaid Sandbox:**  
In Sandbox, every institution returns the same small synthetic dataset (~30 transactions, 30-day span, regardless of institution or account type). Sandbox data does not reflect real institution history depth. If any of your connected accounts were connected while `PLAID_ENV=sandbox`, the transaction history for those items is synthetic and shallow.

### Expected account-level findings

| Institution | Account type | Expected tx coverage | Notes |
|---|---|---|---|
| Chase | Checking | Up to 24mo if connected with real credentials | Sandbox: synthetic ~30 rows |
| Chase | Credit card | Up to 24mo | Credit coverage typically best in Plaid |
| Amex | Credit card | Up to 24mo | Amex has strong Plaid coverage |
| Schwab | Brokerage/Investment | 12–24mo investment transactions | `Buy/Sell/Dividend` categories; excluded from Banking page |
| Robinhood | Brokerage | Limited — Robinhood via Plaid has sparse tx data | Investment categories only |

### Why Chase checking might have less history than Chase/Amex credit cards

Three plausible causes (not mutually exclusive):

1. **Sandbox environment.** If Chase was connected in Sandbox, it gets the same synthetic 30-row dataset as everything else. The account type doesn't matter in Sandbox.

2. **Plaid's category filter.** `getTransactions()` and the AI context assembler both filter `category: { in: BANKING_CATEGORIES }`. Checking transactions often categorize correctly. But if Chase checking transactions are being mapped to `Other` and something is filtering that out, they'd be missing from views (they wouldn't be — `Other` is in `BANKING_CATEGORIES`).

3. **Investment accounts showing no banking transactions.** Schwab/Robinhood are `type=investment`. Their transactions have categories like `Buy`, `Sell`, `Dividend` — all excluded from `getTransactions()`. So those accounts contribute zero rows to the Banking page. This is by design and correct.

---

## 3. Plaid Sync / Backfill Capability Summary

### Current sync architecture

```
Link flow (exchange-token) →
  plaidClient.transactionsSync({ access_token, no cursor }) →
  iterates has_more pages →
  upserts Transaction rows with financialAccountId →
  persists cursor to PlaidItem.cursor

Subsequent syncs (refresh button / Vercel cron) →
  plaidClient.transactionsSync({ access_token, cursor: stored cursor }) →
  only new/modified/removed since last cursor →
  upserts delta

Vercel cron: vercel.json → /api/jobs/sync-banks → daily at 06:00 UTC
```

### What's NOT in the codebase

| Feature | Status |
|---|---|
| `/transactions/get` historical backfill | **Does not exist** |
| Per-account date-window configuration | **Does not exist** |
| "Import older history" UI | **Does not exist** |
| Explicit start_date parameter on initial sync | **Not applicable** — `/transactions/sync` uses cursor, not dates |
| Instrumentation.ts / startScheduler() hook | **Missing** — scheduler.ts is registered but never started in-process |

### The cursor problem

Once a cursor is stored on `PlaidItem.cursor`, the app will **never** re-fetch historical transactions through `/transactions/sync`. It only fetches deltas going forward. This is correct behavior for incremental sync, but it means:

> **If the initial sync missed history (e.g., Plaid returned fewer rows than expected, or the call timed out), that history is permanently inaccessible through the current sync path.**

The only way to backfill is to either:
1. Clear `PlaidItem.cursor` and re-run `syncTransactionsForItem()` — this re-runs from the beginning of Plaid's available history for that item. Safe, idempotent due to `plaidTransactionId` upsert + fingerprint fallback. **This is the correct local-dev backfill path.**
2. Implement a separate call to the legacy `/transactions/get` endpoint with explicit `start_date`/`end_date` — more control, but more work.

### Sandbox vs. real credentials behavior

| Behavior | Sandbox | Real |
|---|---|---|
| Transaction history depth | ~30 synthetic rows, ~30 days | 12–24 months depending on institution |
| Transaction IDs | Synthetic, stable | Real Plaid IDs, sometimes reissued |
| Categories | Synthetic | Real personal_finance_category |
| Chase checking coverage | Same as all others | Typically strong (24mo) |

**If your local DB was connected using Sandbox credentials, the sparse history is expected and accurate to that environment.**

---

## 4. Transactions Page Root Cause

### There are two different "Transactions" surfaces — they behave differently

#### Surface A: The "Transactions" tab in the Personal Space More Menu

**Location:** Personal Space dashboard → top-right "More" menu → "Transactions"  
**Component:** `DashboardClient.tsx`, `isTransactions` branch  
**Rendered content:**

```tsx
{isTransactions && (
  <SpaceComingSoonPanel
    icon={<Receipt size={20} />}
    title="Transactions"
    description="A unified transaction list across every account in this Space is coming soon."
  />
)}
```

**Root cause: this is intentional.** The Transactions tab in the Personal Space is a placeholder. It renders `SpaceComingSoonPanel`, which says "coming soon." It is not a bug — it is declared as a placeholder in `PLACEHOLDER_SPACE_TABS` in `lib/space-nav.ts`:

```ts
export const PLACEHOLDER_SPACE_TABS: SpaceTabId[] = ["FINANCES", "TRANSACTIONS", "DOCUMENTS"];
```

**This is why the Transactions tab is blank.** It has no backing feature. Transactions are intentionally housed on the Banking page today.

#### Surface B: The Banking page (`/dashboard/banking`)

**Location:** Banking tab in navigation → full-page transaction list  
**Component:** `BankingClient.tsx`  
**Data source:** `getTransactions()` in `lib/data/transactions.ts`

This IS the real, live transaction view. It has search, category filter, time filter (All / 90d / 30d / 7d), and account filter. It should show transactions if the data is there.

**Why it might appear empty:** The query requires either:
- A legacy `Account.spaceId` match (for pre-migration rows), OR  
- A `SpaceAccountLink` row with `status: ACTIVE` pointing to the `FinancialAccount` (D3 canonical path)

If SpaceAccountLink rows don't exist for your accounts (e.g., the accounts were connected before Stage B3 of D3 was shipped, and the dual-write didn't backfill old rows), the Banking page shows "0 transactions" even if `Transaction` rows exist in the DB.

To verify: run this query:
```sql
SELECT COUNT(*) FROM "SpaceAccountLink" WHERE status = 'ACTIVE';
SELECT COUNT(*) FROM "WorkspaceAccountShare" WHERE status = 'ACTIVE';
SELECT COUNT(*) FROM "Transaction" WHERE "deletedAt" IS NULL;
```

#### Surface C: The AI context (chat, Daily Brief)

**Component:** `lib/ai/assemblers/transactions.ts`  
**Query window:** 90 days (scopeHint=full), 30 days (brief)  
**Query path:** Same OR — `account.spaceId` OR `financialAccount.spaceAccountLinks`

The AI context and the Banking page use **the same visibility path** and **the same category filter**. If AI is seeing transactions that the Banking page is not, the only explanation is a filter or UI state difference — not a different data path.

**Most likely explanation if AI shows data but Banking page looks empty:** The user is looking at the Transactions tab (Surface A — coming soon), not the Banking page (Surface B — real data). They appear similar in the navigation.

---

## 5. Smallest Safe Implementation Plan

In priority order, these are the fixes/features that address the identified gaps:

### 5a. Fix: SpaceAccountLink backfill for existing accounts (if missing)

**Problem:** Accounts connected before D3 Stage B3 may only have `WorkspaceAccountShare`, not `SpaceAccountLink`. This would make `getTransactions()` return nothing for those accounts on the D3 read path.

**Check first:** Run the query above. If `SpaceAccountLink` count ≈ `WorkspaceAccountShare` count, backfill already ran or wasn't needed. If SpaceAccountLink count is 0 or much lower, backfill is needed.

**Fix:** A one-time migration script that creates `SpaceAccountLink` rows from existing `WorkspaceAccountShare` rows for all accounts without one. This is already contemplated in D3 Step 3 (dual-write backfill). Zero schema changes needed.

### 5b. Fix: Chase checking history (clear cursor and re-sync)

**Problem:** If Chase checking has fewer transactions than expected, the initial sync may have been incomplete (Plaid partial response, or Sandbox credentials).

**Safe local backfill:** In a DB console (read-only warning: this writes the cursor, which is intentional):
```sql
-- Clear cursor for specific institution to force full re-sync
UPDATE "PlaidItem"
SET cursor = NULL, "lastSyncedAt" = NULL
WHERE "institutionName" = 'Chase'
  AND status = 'ACTIVE'
  AND "userId" = '<your-user-id>';
```
Then trigger a sync (Refresh Data button in sidebar → calls `/api/plaid/refresh` → calls `syncTransactionsForItem` → with null cursor = full re-fetch from Plaid).

**Caution:** Clearing the cursor causes a full re-sync from Plaid's beginning. The fingerprint fallback + `plaidTransactionId` upsert make this idempotent — no duplicates should be created. But it's a heavier Plaid API call.

### 5c. Feature: Real Transactions tab in Personal Space

**Problem:** The Transactions tab renders a "coming soon" panel instead of real data.

**Smallest implementation:** Replace `SpaceComingSoonPanel` with the existing `BankingClient`'s transaction section (or an extracted `TransactionListSection` component), fed from the same `getTransactions()` call already happening on the dashboard page. No new API needed — the data is already fetched.

**Scope caveat:** This is a UI feature, not a schema or sync change. Per Phase 2 rules, it should not happen alongside schema work.

---

## 6. Recommended Initial Sync / Backfill Policy

### Recommendation: 90 days as the effective minimum; 24 months as the target

| Policy | Rationale |
|---|---|
| **90 days minimum** | Matches the AI context window (`WINDOW_FULL_DAYS = 90`). Less than this means AI cash flow analysis is always working with incomplete data. |
| **24 months target** | Plaid's `/transactions/sync` with null cursor already attempts this for most institutions. No code change needed — it's Plaid's default. |
| **No explicit start_date needed** | `/transactions/sync` with null cursor already fetches maximum available history. The current code is correct. |
| **Different policy per account type?** | Not needed. Plaid already returns institution-appropriate depth. Investment transactions (Schwab, Robinhood) are excluded from banking views regardless. |

### What "30 days" means today

The app's Banking page has a "30 days" time filter button, but this is a **client-side UI filter** on already-fetched data — it does not limit what Plaid synced. The underlying sync attempts to get everything Plaid has.

### Cron frequency recommendation

Current cron: **daily at 06:00 UTC**. This is adequate for batch purposes but means intraday transactions can lag 23+ hours. For a banking dashboard, **6-hour intervals** would materially improve freshness. Low risk — `syncTransactionsForItem` is cursor-based and idempotent.

```json
// vercel.json — upgrade from daily to every 6h
{ "path": "/api/jobs/sync-banks", "schedule": "0 */6 * * *" }
```

---

## 7. Items to Defer to Import History / v2.7

| Feature | Why defer |
|---|---|
| `/transactions/get` historical backfill endpoint | Manual cursor-clear + re-sync achieves the same result locally today; a formal backfill UI is `D2 Step 4A` (Import History Foundation) — already in roadmap |
| "Import older history" button in UI | Same — `D2 Step 4A/4D` scope |
| Per-institution sync window configuration | Over-engineering; Plaid's institution-native window is already correct |
| Pending transaction filtering toggle | Low value today; pending transactions are already included in all queries and tagged in the UI |
| Backfill for Robinhood/Schwab investment transactions | These are excluded from banking views by design; investment transaction UI doesn't exist yet |
| Full Transactions page with all filters | UI feature; defer until after D11 / D3 schema work stabilizes |
| Amount sign convention documentation | The flip (`amount = -txn.amount`) is documented in `syncTransactions.ts` header; no change needed |

---

## 8. Answers to Specific Investigation Questions

**1. Which accounts have transaction history?**  
Cannot confirm without a live DB query. Based on code: any account with a completed `syncTransactionsForItem()` call (check `PlaidItem.lastSyncedAt IS NOT NULL`) should have rows. Run the inventory query in §1.

**2. Which accounts have no transaction history?**  
Schwab / Robinhood investment transactions exist in the DB but are excluded from the Banking page by category filter (`Buy/Sell/Dividend/Split/Fee` ∉ `BANKING_CATEGORIES`). They appear on the Investments page only. Also: any account where the initial sync failed silently (check `syncStatus` on `FinancialAccount`).

**3. How far back did Plaid pull transactions per account?**  
Check `MIN(Transaction.date)` per `financialAccountId` via the inventory query. Expected: ~30-90 days for Sandbox, up to 24 months for real credentials.

**4. Is Chase checking missing history while Chase/Amex cards have history?**  
Likely. The most probable cause is **Plaid Sandbox** — all institutions in Sandbox return the same synthetic dataset. If you're on real credentials and Chase checking still shows less history than Chase credit, clear Chase's cursor and re-sync (§5b above).

**5. Are transactions linked to FinancialAccount correctly?**  
Yes — `syncTransactionsForItem()` always writes `financialAccountId` (never `accountId`) and uses `ProviderAccountIdentity` + `plaidAccountId` fallback to resolve the FK. Confirmed in code.

**6. Are transactions visible to Personal Space through SpaceAccountLink?**  
Depends on whether `SpaceAccountLink` rows exist. The D3 Stage B3 dual-write has been live since it shipped. Any account connected after that point has both `WorkspaceAccountShare` and `SpaceAccountLink`. Accounts connected before may only have `WorkspaceAccountShare`, making `getTransactions()` miss them on the D3 path. Run §1 verification query.

**7. Is the AI context reading a different transaction path than the Transactions page?**  
No. The AI assembler (`lib/ai/assemblers/transactions.ts`) and `getTransactions()` (`lib/data/transactions.ts`) use **identical query structure** — same OR paths, same `status: ACTIVE` filter, same `BANKING_CATEGORIES` filter, same `deletedAt: null` guard. The only difference is the AI assembler adds a date window filter (`date ≥ 90 days ago`). If the AI sees transactions but the Banking page doesn't, it's a UI navigation issue (user is on Surface A — coming soon tab — not Surface B — Banking page).

**8. Why is the Transactions page blank by default?**  
Two-part answer:
- The **Transactions tab** in the Personal Space More Menu is a **`SpaceComingSoonPanel`** — intentionally blank. Declared as a placeholder in `PLACEHOLDER_SPACE_TABS`. Not a bug.
- The **Banking page** (`/dashboard/banking`) is the real live transaction view. It should show data if SpaceAccountLinks are populated. If it also appears empty, the likely cause is missing SpaceAccountLink rows for accounts connected before D3 Stage B3.
