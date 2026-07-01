# Historical Relink Investigation — Expand Plaid Transaction History

**Date:** 2026-07-01  
**Branch:** feature/phase-2-architecture  
**Status:** Investigation complete. No code modified.  
**Scope:** Chase, American Express, Charles Schwab, Robinhood — all current real Plaid Items.

---

## Executive Summary

All existing Plaid Items were linked before `transactions.days_requested: 730` was set. Their transaction history ceiling is permanently locked at 90 days (Plaid's default). The only path to deeper history is: `/item/remove` the old Item → relink as a new Item → match new Plaid accounts back to existing `FinancialAccount` rows → import deeper transaction history → dedupe overlapping range.

The good news: Fourth Meridian already has every building block needed for this flow. `resolveAccountByFingerprint`, `mergeArchivedDuplicateIntoCanonical`, `disconnectPlaidItemIfOrphaned`, and `syncTransactionsForItem` are all in place. The relink workflow composes them in a new order rather than inventing new logic.

The critical constraint: investment transaction history (buys, sells, dividends) for Schwab and Robinhood is **not currently synced at all**. `syncTransactionsForItem` calls `/transactions/sync` only, which returns **banking-type transactions** only. Investment activity (`Buy`/`Sell`/`Dividend`/`Split`/`Fee` categories) requires a separate `/investments/transactions/get` call that does not exist in the codebase. Holdings (current positions) are synced; historical activity is not.

---

## 1. Current Architecture Fit

### 1.1 Models and Their Role in Relink

| Model | Role in Relink |
|---|---|
| `PlaidItem` | Old: REVOKED after new Item verified. New: created by standard exchange-token flow. |
| `Connection` | Keyed on `(userId, provider=PLAID, institutionId)` — survives PlaidItem rotation. A relink updates the same `Connection` row rather than creating a second one. Already implemented. |
| `AccountConnection` | Links `FinancialAccount ↔ PlaidItem`. Old Item's connections are soft-deleted when old Item is orphaned. New Item creates new `AccountConnection` rows pointing at the **existing** `FinancialAccount` rows. |
| `ProviderAccountIdentity` | Keyed on `(provider, externalAccountId, financialAccountId)`. Plaid reissues `account_id` on every relink — the relink flow updates this row to the new `account_id`, which is exactly what `dualWriteProviderAccountIdentity()` already does on every exchange-token. |
| `FinancialAccount` | Must be **preserved** — never deleted or archived. Its `plaidAccountId` gets updated to the new Plaid `account_id` on fingerprint-resolution (this already happens in exchange-token for the fingerprint branch). |
| `Transaction` | Old rows: remain untouched, scoped to existing `financialAccountId`. New rows (older history): written by `syncTransactionsForItem` on the new Item; fingerprint fallback dedupes the overlapping window. |
| `SpaceAccountLink` | Scoped to `FinancialAccount.id` — survives relink transparently because the `FinancialAccount` row is preserved. No migration needed. |
| `DebtProfile` | Scoped to `FinancialAccount.id` — survives relink transparently. |
| `ImportBatch` | Not relevant for Plaid relink. Relevant for the CSV import convergence path (see §7). |

### 1.2 What Already Works

The current `exchange-token` flow already handles the case where a user relinks an institution they previously had connected. Specifically:

1. **Exact match path**: `ProviderAccountIdentity` lookup finds `financialAccountId` for the new Plaid `account_id`. If Plaid reissues the same `account_id`, this hits immediately.
2. **Fingerprint match path**: `resolveAccountByFingerprint(institutionId + mask + type + name)` finds an archived or active `FinancialAccount` and updates its `plaidAccountId` to the new one. Multiple stale archived rows get consolidated into one canonical via `mergeArchivedDuplicateIntoCanonical`.
3. **Transaction deduplication**: `syncTransactionsForItem` upserts on `plaidTransactionId` and falls back to `findByFingerprint` (financialAccountId + date + amount + merchant + pending). Overlapping history from the old and new Items is deduplicated before writing.
4. **Old Item retirement**: `disconnectPlaidItemIfOrphaned` calls Plaid `/item/remove` and sets `PlaidItem.status = REVOKED` when zero live `AccountConnection` rows remain on that item.

**The relink workflow is therefore almost entirely already built.** The gap is:
- No UI affordance (user has no "Expand history" button).
- No admin/dev script to orchestrate the flow without going through the full Link UI.
- No investment transaction sync for Schwab/Robinhood.

---

## 2. Per-Institution Analysis

### 2.1 Chase (Checking, Savings, Credit Card)

**Account types:** `checking`, `savings`, `debt` (credit card)  
**Plaid products needed:** `Transactions` (already initialized)  
**`days_requested: 730` benefit:** Yes — banking and credit card transactions up to 2 years.  
**Current coverage:** Jun 5–Jun 29 (checking), Apr 9–Jun 15 (savings), Mar 22–Jun 29 (credit).  
**Relink applies?** Yes — straightforward. All three accounts are banking/credit. `syncTransactionsForItem` handles all three via `/transactions/sync`.  
**Expected new depth:** Up to 730 days, bounded by what Chase has available in Plaid's system (~18–24 months typical for credit, potentially less for checking/savings).

**Account matching strategy:**
- Chase rarely reissues `account_id` for established accounts, but fingerprint fallback is available as a safety net.
- `mask` (last 4 digits) + `institutionId` (ins_3) + `type` + `officialName` is sufficient to uniquely identify each Chase account.

---

### 2.2 American Express (Credit Card)

**Account types:** `debt` (credit card)  
**Plaid products needed:** `Transactions`  
**`days_requested: 730` benefit:** Yes — credit card spending history up to 2 years.  
**Relink applies?** Yes — identical to Chase credit card path.

**Special note from link-token route comment:**
> "Investments intentionally omitted: AmEx and other credit-only institutions reject link tokens that include the investments product."

This comment is already in the codebase. For AmEx, `products: [Products.Transactions]` is correct and sufficient. The relink link token must NOT include `Products.Investments` — the current link-token route is correct as-is.

**Account matching:** AmEx `account_id` is generally stable on relink. `mask` + `institutionId` + type=`debt` + `debtSubtype=credit_card` uniquely identifies the card.

---

### 2.3 Charles Schwab (Brokerage / Investment)

**Account types:** `investment`  
**Plaid products needed:** `Transactions` (for cash sweeps, dividends paid to cash), `Investments` (for holdings snapshot — already initialized).  
**`days_requested: 730` benefit:** **Limited.** For Schwab, `/transactions/sync` returns only cash-account-style transactions (deposits, withdrawals, interest, transfers into/out of the brokerage account). It does **not** return buy/sell/dividend trade activity.  

**Critical finding: Investment transaction history is not currently synced.**

The current sync path for Schwab:
- `investmentsHoldingsGet` → current positions/holdings snapshot. ✅ Implemented in `exchange-token` and `refresh.ts`.
- `/transactions/sync` → banking-layer transactions only (cash transfers, ACH deposits, wire transfers). ✅ Syncs these.
- `/investments/transactions/get` → historical buy/sell/dividend activity. ❌ **NOT called anywhere in the codebase.**

There is no call to `plaidClient.investmentsTransactionsGet` in any file. The `Buy`/`Sell`/`Dividend`/`Split`/`Fee` `TransactionCategory` enum values exist in the schema and are mapped in `getInvestmentTransactions()` in `lib/data/transactions.ts`, but they can only be populated via **CSV import** or **manual entry** today — not via Plaid sync.

**Relink applies (limited):** A relink of Schwab with `days_requested: 730` will expand cash-level transaction history (ACH transfers in/out, interest payments to cash) but will not backfill historical trade activity. For a user who wants to see their Schwab trade history (when they bought AAPL, dividend reinvestments, etc.), this is a separate Plaid product (`investments`) with a separate API call.

---

### 2.4 Robinhood (Crypto / Investment)

**Account types:** `investment` or `crypto` (depending on subtype — Plaid returns `investment` for Robinhood brokerage, `crypto exchange` maps to `AccountType.crypto`)  
**Plaid products needed:** `Transactions`, potentially `Investments`.

**Historical context from `reconcile.ts` comment:**
> "Robinhood account over time, same institution/mask/officialName/type, three different plaidAccountId values."

Plaid **routinely reissues `account_id` for Robinhood** accounts. This is a confirmed, observed behavior. The fingerprint fallback in `resolveAccountByFingerprint` was built partly because of this.

**Current sync path for Robinhood:**
- Same as Schwab above. Holdings sync: ✅. Cash transactions via `/transactions/sync`: ✅. Investment trade history via `/investments/transactions/get`: ❌ not synced.
- Robinhood crypto activity (BTC/ETH purchases, sells, transfers): Not synced at all currently. Plaid's `transactions` product for Robinhood may return limited crypto purchase transactions as regular transactions; this is institution-specific behavior.

**Relink applies (limited):** Same constraint as Schwab. Cash-layer transaction history expands; trade/investment history does not.

**Account matching risk:** Because Plaid reissues Robinhood `account_id` frequently, exact-match via `ProviderAccountIdentity` will likely miss. The fingerprint fallback (`mask + institutionId + type + officialName`) should succeed, but:
- Robinhood sometimes does not provide `mask` for accounts.
- If `mask` is null, `resolveAccountByFingerprint` returns `[]` (the function short-circuits on null mask).
- If both exact-match and fingerprint-match miss, exchange-token creates a **new** `FinancialAccount` row, which is the wrong behavior for a "Expand history" relink.

This is a known risk that needs explicit handling in the relink flow.

---

## 3. Account Matching Strategy

### 3.1 Current Matching Layers (in exchange-token)

```
1. ProviderAccountIdentity.findFirst(provider=PLAID, externalAccountId=account_id)
   → if found: exact match, update balance, proceed
   ↓ miss
2. FinancialAccount.findUnique(plaidAccountId=account_id)
   → legacy fallback for accounts predating identity table
   ↓ miss  
3. resolveAccountByFingerprint(institutionId + mask + type + officialName/plaidName/name)
   → for Plaid account_id reissue (Robinhood, occasional Chase)
   ↓ miss
4. Create new FinancialAccount row
```

### 3.2 Relink-Specific Matching Problem

During a standard relink (user uses Plaid update mode / reconnect), the old `access_token` is refreshed but the `account_id` values are preserved. Exchange-token's existing logic handles this correctly via path 1 or 2 above.

During a **historical relink** (new Item, new `access_token`, new `account_id`):
- Path 1 will miss because `account_id` changed.
- Path 2 will miss for the same reason.
- Path 3 (fingerprint) is the load-bearing fallback — it must succeed.
- If path 3 also misses (Robinhood no-mask case), a new `FinancialAccount` is created. This is wrong for a relink.

### 3.3 Recommended Matching Additions for Historical Relink

For the relink flow specifically, before falling through to create a new row:

**Layer 3b — Institution+User scope match (no mask required):**
When `mask` is null, match on: `(ownerUserId, institutionId, type, subtype, balance ±5%)`. This is looser but avoids creating duplicates for maskless accounts (Robinhood, some crypto). Only applies when mask is null and exactly one candidate exists. Log prominently and do not auto-merge — surface for user confirmation.

**Layer 3c — Prior PlaidItem connection:**
Query `AccountConnection` for rows with `plaidItemDbId` pointing at the old PlaidItem being superseded. If that old Item connected exactly one `FinancialAccount` of matching type, treat it as the canonical match. This is the most reliable relink-specific signal: "the account that was connected via this institution before."

### 3.4 Matching Rules by Institution

| Institution | Primary match | Fallback | Notes |
|---|---|---|---|
| Chase | ProviderAccountIdentity | mask + institutionId + type | account_id generally stable |
| American Express | ProviderAccountIdentity | mask + institutionId + type=debt | account_id generally stable |
| Schwab | ProviderAccountIdentity | mask + institutionId + type=investment | account_id generally stable |
| Robinhood | ProviderAccountIdentity | institutionId + type (no mask) | account_id frequently reissued; often no mask |

---

## 4. Transaction Merge / Deduplication

### 4.1 What Already Works

`syncTransactionsForItem` already implements a two-pass dedup on each transaction:

1. **Exact match by `plaidTransactionId`**: same Plaid transaction ID → update existing row.
2. **Fingerprint fallback** (`findByFingerprint`): `(financialAccountId, date, amount, merchant, pending)` → update existing row, replace `plaidTransactionId`.

When the new Item syncs, it returns the full 730-day history. For the overlap window (the 90 days the old Item already imported), `plaidTransactionId` values from the new Item are different from the old Item's values (different Item → different transaction IDs), so exact-match will miss. The fingerprint fallback then fires and correctly identifies existing rows.

**The fingerprint fallback is the dedup mechanism for historical relink.** It was specifically built for this case (documented in `syncTransactions.ts` module header: "Plaid's transaction_id is NOT always stable for the same real-world posted transaction across separate sync runs").

### 4.2 Known Fingerprint Gaps

The fingerprint is `(financialAccountId, date, amount, merchant, pending)`. This is a **heuristic**, not a guarantee:

- **Pending → posted transitions**: A pending transaction has one `date`/`amount`/`merchant` triple; the posted version may have a different date (settlement date vs. authorization date) or slightly different merchant name. The fingerprint will miss this match, resulting in two rows (one pending from the old Item, one posted from the new Item). The existing sync already handles the `pending → posted` transition within a single Item (via the Plaid `removed` + `added` cycle), but across Items there is no removal signal — both rows persist.

  **Mitigation**: After historical relink sync completes, run a cleanup pass: for each `FinancialAccount` in the new Item, find `Transaction` rows with `pending=true` and `plaidTransactionId` from the **old** Item (distinguishable because old-Item transactions will have no `plaidTransactionId` matching any new-Item transaction_id) whose `(date±3 days, amount, merchant)` matches a `pending=false` row from the new Item. Soft-delete (`deletedAt`) the old pending row.

- **Genuinely repeated transactions**: Same merchant, same amount, same date, twice in one month (e.g., two Netflix charges in a billing month edge case) — fingerprint correctly identifies these as separate rows. No false merges.

- **Merchant name normalization**: `normalizeMerchantKey` only trims/collapses whitespace/uppercases. Two transactions that differ only by trailing whitespace or casing will match. Genuinely distinct transactions with different merchants never collide.

### 4.3 Investment Transaction Dedup (Future)

When `/investments/transactions/get` is eventually implemented:
- Plaid provides `investment_transaction_id` — a stable unique key per investment transaction. Use this as the dedup key, same role as `plaidTransactionId`.
- No fingerprint fallback needed for investment transactions: Plaid's investment transaction IDs are documented as stable across sync runs (unlike regular transaction IDs).

---

## 5. Old PlaidItem Retirement

### 5.1 Recommended Sequence

```
1. User completes new Link flow → new public_token → exchange-token runs
2. Exchange-token creates new PlaidItem (new externalItemId)
3. Exchange-token matches all accounts to existing FinancialAccounts (path 1–3c above)
4. Exchange-token creates new AccountConnection rows for new PlaidItem pointing at existing FinancialAccounts
5. Exchange-token runs syncTransactionsForItem → backfills up to 730 days, dedupes overlap
6. VERIFY: new Item has correct accounts, sync succeeded, cursor set
7. Soft-delete old AccountConnection rows (deletedAt = now)
8. Call disconnectPlaidItemIfOrphaned(oldPlaidItemId)
   → checks remaining live AccountConnections = 0
   → calls plaidClient.itemRemove(old access_token)
   → sets old PlaidItem.status = REVOKED
```

**Step 6 (verify before retire)** is the critical safety gate. Do not retire the old Item until the new Item's sync has completed successfully and the new PlaidItem has a non-null cursor.

### 5.2 What NOT to Do

- **Do not retire the old Item before new Item sync succeeds.** If new Item sync fails (Plaid error, network timeout), the user would lose their credential entirely. Old Item stays ACTIVE until the new one is confirmed healthy.
- **Do not delete old PlaidItem row.** Set `status = REVOKED`. The row is an audit record; `disconnectPlaidItemIfOrphaned` already handles this correctly.
- **Do not delete old AccountConnection rows.** Set `deletedAt` only. Transaction history belongs to `FinancialAccount`, not `AccountConnection`, so soft-deleting connections preserves all history.
- **Do not set `cursor = null` on an existing PlaidItem** as a "reset" trick to get more history. This was confirmed not to work — cursor reset replays within the 90-day initialization cap, not deeper.

### 5.3 Old Access Token

The old encrypted `PlaidItem.encryptedToken` can remain in the DB after REVOKED status is set. The token is revoked at Plaid (via `/item/remove`) so it's no longer usable. The DB row is kept as-is, per the existing REVOKED pattern (PlaidItemStatus.REVOKED is already defined and handled throughout the codebase).

---

## 6. Can the Same Relink Workflow Apply to All Four Institutions?

| Institution | Relink workflow applies? | Banking tx depth? | Investment tx depth? |
|---|---|---|---|
| Chase | ✅ Yes | ✅ Up to 730 days via `/transactions/sync` | N/A (no investment accounts) |
| American Express | ✅ Yes | ✅ Up to 730 days via `/transactions/sync` | N/A (credit-only institution) |
| Charles Schwab | ✅ Yes (partial) | ✅ Cash transfers, interest — up to 730 days | ❌ Trade history requires `/investments/transactions/get` (not implemented) |
| Robinhood | ✅ Yes (partial, higher matching risk) | ✅ Cash deposits/withdrawals — up to 730 days | ❌ Trade history requires `/investments/transactions/get` (not implemented) |

**Answer:** The same workflow applies to all four, but the depth of what's recovered differs. For Chase and AmEx, it's complete. For Schwab and Robinhood, cash-layer history expands but trade/investment activity history requires a separate, not-yet-implemented investment transaction sync.

---

## 7. Products Required Per Institution

### 7.1 Current link-token products

```typescript
products: [Products.Transactions]
```

### 7.2 What `days_requested: 730` Covers

`transactions.days_requested` controls the depth of data returned by `/transactions/sync`. This includes:
- Checking/savings account transactions (deposits, withdrawals, ACH, wire)
- Credit card transactions (purchases, payments, refunds)
- Brokerage **cash account** transactions (ACH into/out of brokerage, interest paid to cash)

It does **not** control:
- Investment holdings depth (current snapshot — no history concept)
- Investment transaction (trade) history — `/investments/transactions/get` has its own date range parameters

### 7.3 Adding `Products.Investments` for Schwab/Robinhood

The current link-token code adds `investments` only if the account has investment-type accounts, but the comment notes AmEx **rejects** tokens with investments product. The solution is per-institution product selection:

```typescript
// For institutions that support investments:
products: [Products.Transactions, Products.Investments]

// For credit-only institutions (AmEx):  
products: [Products.Transactions]
```

However, `Products.Investments` for Schwab/Robinhood only enables **holdings** sync (current positions). The historical investment transaction product is also `Products.Investments`, but accessed via `/investments/transactions/get` — a separate API call not yet in the codebase.

**For now**: `days_requested: 730` with `products: [Products.Transactions]` is correct for all institutions. Schwab/Robinhood holdings are already synced via `investmentsHoldingsGet` (which works when `Investments` was initialized at original link time). Adding investment transaction history is a separate workstream (§7.4).

### 7.4 Investment Transaction History — What's Needed

To backfill historical investment transactions for Schwab/Robinhood:

**New call needed:** `plaidClient.investmentsTransactionsGet(access_token, start_date, end_date)` (cursor-based pagination optional; date-range based).

**New sync function:** `syncInvestmentTransactionsForItem(plaidItemDbId, startDate, endDate)` — parallel to `syncTransactionsForItem` but calls `/investments/transactions/get` and maps results to `TransactionCategory.Buy/Sell/Dividend/Split/Fee`.

**Historical depth:** Plaid's `/investments/transactions/get` supports up to 24 months of history, date-range gated (not `days_requested`). Not affected by the `transactions.days_requested` initialization cap.

**Dedup key:** `investment_transaction_id` (Plaid's stable per-transaction ID for investment activity). Add a new `plaidInvestmentTransactionId String? @unique` column to `Transaction`, or reuse `externalTransactionId` (already in schema, not yet used).

This is a non-trivial schema addition (new unique column on Transaction) and a new sync function. It should be a separate D2 slice, not bundled with the relink workflow.

---

## 8. UI Affordance Design

### 8.1 Trigger

The "Expand history" action is per-institution (PlaidItem), not per-account. One PlaidItem covers all accounts at that institution. The UI should say:

- "Expand history for Chase" — not per-account, because all three Chase accounts (checking, savings, credit card) share one PlaidItem.
- "Expand history for American Express"
- "Expand transaction history for Charles Schwab" (note: investment trade history not included — see below)
- "Expand transaction history for Robinhood" (same caveat)

### 8.2 User-Facing Copy

```
Chase was connected before 2-year history imports were enabled.
Relinking will import transactions from the past 2 years (subject
to Chase availability). Your accounts, Space links, debt profiles,
and existing transaction history are all preserved — this only
adds older transactions.

This opens Plaid Link in a fresh connection (not an update).
After you complete it, Chase will show up to 2 years of activity.
```

For Schwab/Robinhood, add:
```
Note: This expands your cash and transfer history.
Trade history (buys, sells, dividends) is a separate feature
coming soon.
```

### 8.3 Link Token for Historical Relink

The relink link-token call must **not** pass `access_token` (that triggers update mode, which doesn't re-initialize Transactions depth). It must use a fresh-link flow:

```typescript
// Historical relink — intentionally omits access_token so Plaid
// initializes a new Item with transactions.days_requested: 730.
// DO NOT pass access_token here — update mode cannot expand history.
await plaidClient.linkTokenCreate({
  user:         { client_user_id: userId },
  client_name:  "Fourth Meridian",
  country_codes: [CountryCode.Us],
  language:     "en",
  products:     [Products.Transactions],
  transactions: { days_requested: 730 },
  // redirect_uri if needed
});
```

The exchange-token route's existing fingerprint matching will handle account reconciliation when the new `public_token` arrives.

---

## 9. What Should Absolutely NOT Happen

| Risk | Mitigation |
|---|---|
| `FinancialAccount` deleted | Never. Relink only updates `plaidAccountId`, balance, `deletedAt: null` on existing rows. |
| `SpaceAccountLink` deleted | Never. Scoped to `FinancialAccount.id` which is preserved. |
| `DebtProfile` deleted | Never. `mergeArchivedDuplicateIntoCanonical` moves DebtProfile to winner only if winner has none. If winner already has one, the old profile stays on the archived loser (inert). |
| Old transactions deleted | Never. Old transactions remain. New sync only adds/updates. |
| Duplicate `FinancialAccount` created | Prevented by fingerprint matching. For Robinhood (no mask), layer 3c (old PlaidItem connection lookup) must be added to prevent this. |
| Old Item retired before new Item verified | Prevented by making step 7 (retire old) conditional on step 6 (verify new cursor). |
| New link treated as update mode | Prevented by not passing `access_token` to link-token for the "Expand history" flow. |
| AmEx relink fails from investments product | Already handled — `products: [Products.Transactions]` only, no Investments. |
| SpaceAccountLink broken by account mismatch | Cannot happen — SpaceAccountLink is keyed to `FinancialAccount.id`, which is the preserved row. |

---

## 10. Relationship to CSV Import History

This relink workflow and CSV import share the same core operations:

| Operation | Relink | CSV Import |
|---|---|---|
| Account matching | `resolveAccountByFingerprint` | Same function |
| Transaction dedup | `findByFingerprint` + `plaidTransactionId` | `findByFingerprint` + `externalTransactionId` |
| Provenance tracking | Old `plaidTransactionId` replaced with new | `externalTransactionId` from CSV |
| Batch metadata | None currently (would use `ImportBatch`) | `ImportBatch` (schema exists, pipeline not built) |
| Rollback | Not needed (additive only) | `ImportBatch.status = ROLLED_BACK` + `Transaction.deletedAt` |

The `ImportBatch` model exists (`financialAccountId`, `connectionId`, `status`, `matchedCount`, `skippedCount`). For the relink flow, an `ImportBatch`-like record of what was added vs. what was fingerprint-matched would be valuable for debugging but is not required for correctness. Consider writing a minimal `ImportBatch` row per relink sync run (source = a new `ImportSource.PLAID_RELINK` enum value, or reuse `CSV` as a placeholder temporarily).

---

## 11. Local-Dev Testing Plan for Chase

### Option A: Manual (Safest, Recommended First)

1. Deploy the `days_requested: 730` link-token change (already done in D4).
2. In Plaid Dashboard → [your Sandbox/Development environment] → Items → find Chase Item → click Remove. This calls `/item/remove` at Plaid, making the old Item's `access_token` invalid.
3. In the app DB, set `PlaidItem.status = 'REVOKED'` for the old Chase PlaidItem (so the sync job skips it).
4. Set `AccountConnection.deletedAt = now()` for all connections pointing at the old Chase PlaidItem.
5. Open the app, click "Add Account" → Chase → go through fresh Link.
6. Exchange-token runs: fingerprint matching finds the existing `FinancialAccount` rows (checking, savings, credit card — all have mask, institutionId, type, officialName).
7. Inspect DB: confirm no new `FinancialAccount` rows created; confirm `plaidAccountId` updated; confirm `SpaceAccountLink` rows still pointing at same accounts.
8. Check Banking page: verify deeper transaction history visible.

**Validation queries to run after:**

```sql
-- Confirm no duplicate FinancialAccounts for Chase
SELECT institution, type, mask, count(*) 
FROM "FinancialAccount" 
WHERE institution = 'Chase' AND "deletedAt" IS NULL 
GROUP BY institution, type, mask;
-- Expect: at most 1 row per (type, mask) combination

-- Confirm DuplicateAccountCandidate audit rows written
SELECT * FROM "DuplicateAccountCandidate" ORDER BY "detectedAt" DESC LIMIT 5;

-- Confirm old transactions preserved, new ones added
SELECT "financialAccountId", min(date), max(date), count(*) 
FROM "Transaction" 
WHERE "financialAccountId" IN (
  SELECT id FROM "FinancialAccount" WHERE institution = 'Chase' AND "deletedAt" IS NULL
)
GROUP BY "financialAccountId";
-- Expect: min(date) is older than it was before the relink
```

### Option B: Admin-Only Endpoint (For Repeated Testing / Future UI)

Build a POST `/api/admin/plaid/expand-history` endpoint:
- Auth: admin-only (userId in allowlist, or env flag).
- Body: `{ plaidItemId: string }` — the old PlaidItem to supersede.
- Steps: validate ownership → generate a fresh link token (no access_token) → return it to the frontend → frontend opens Plaid Link → on success, exchange-token handles everything.

The endpoint is thin — it just returns a link token for a fresh flow. Exchange-token's existing logic does all the matching and merging. This is the minimal safe admin interface.

---

## 12. Production-Safe Workflow

```
User action:
  Settings → Connected Accounts → Chase → "Expand history (linked before 2-year history was enabled)"
  ↓
Server: POST /api/plaid/expand-history-token
  → Validates: PlaidItem exists, belongs to user, is ACTIVE
  → Checks: PlaidItem.cursor is not null (first sync completed)
  → Creates link token: products=[Transactions], days_requested=730, NO access_token
  → Returns: { link_token }
  ↓
Client: Opens Plaid Link (fresh flow, not update mode)
  → User selects same institution (Chase)
  → User authenticates
  → Returns: public_token + institution_id + institution_name
  ↓
Client: POST /api/plaid/exchange-token (existing endpoint, unchanged)
  → exchange-token detects existing ACTIVE PlaidItem for same institution
  → Runs account matching (existing logic, paths 1–3)
  → Runs syncTransactionsForItem (imports up to 730 days)
  → Cursor set on new PlaidItem
  → Logs: "relinked for history expansion"
  ↓
Server (after successful exchange-token):
  → Old PlaidItem: soft-delete its AccountConnections
  → Call disconnectPlaidItemIfOrphaned(oldPlaidItemId)
    → 0 live connections remain → itemRemove → REVOKED
  ↓  
User: Banking/Transactions tabs now show up to 2 years of history
```

**The exchange-token endpoint requires no changes** — it already handles the "new Item for existing institution" case via duplicate-institution detection + fingerprint matching + transaction sync. The only new piece is the `expand-history-token` endpoint that generates the fresh-flow link token.

---

## 13. Implementation Slices

### Slice 1 (Current): Foundation ✅ Done
- `days_requested: 730` in `linkTokenCreate` — prevents future Items from being under-initialized.
- All new accounts linked going forward get 730-day history.

### Slice 2: Expand-History Link Token Endpoint
- `POST /api/plaid/expand-history-token` — validates ownership, returns a fresh-flow link token.
- No `access_token`, `days_requested: 730`, `products: [Transactions]`.
- Returns `{ link_token, institution_name, plaidItemId_to_supersede }`.
- Client stores `plaidItemId_to_supersede` for post-exchange cleanup.

### Slice 3: Post-Relink Old Item Retirement
- After exchange-token succeeds for a relink, the client sends a cleanup request: `POST /api/plaid/retire-superseded-item { oldPlaidItemId }`.
- Or: exchange-token itself detects the "replacing" case and queues the old item retirement.
- Calls `disconnectPlaidItemIfOrphaned` on the old Item.

### Slice 4: Robinhood No-Mask Account Match Fix
- Add Layer 3c to `resolveAccountByFingerprint` or `exchange-token`: when mask is null, look up `AccountConnection` rows for the old `PlaidItem` to identify which `FinancialAccount` to reuse.
- Required before exposing "Expand history" for Robinhood.

### Slice 5: UI Affordance
- Settings page: per-Item "Expand history" button, shown only when Item was created before the `days_requested: 730` fix (createdAt < 2026-07-01 as a heuristic, or a new `historyDepthDays Int?` column on PlaidItem).
- Copy: institution-specific, with caveat for Schwab/Robinhood about trade history.

### Slice 6 (Deferred to v2.7): Investment Transaction History
- `plaidClient.investmentsTransactionsGet` — new sync function.
- New `plaidInvestmentTransactionId String? @unique` on `Transaction` (or reuse `externalTransactionId`).
- Separate "Expand investment history for Schwab" / "Expand investment history for Robinhood" UI entry point.
- Date-range based (not `days_requested`), up to 24 months.

### Slice 7 (Deferred to v2.7): ImportBatch Provenance for Relink
- Write an `ImportBatch` row per relink sync, capturing `matchedCount`, `skippedCount`, `importedCount`.
- Converges with CSV import provenance model.

---

## 14. Summary Table

| Question | Answer |
|---|---|
| Can the same relink workflow apply to all four institutions? | Yes (banking layer). Investment trade history requires separate work. |
| Is `days_requested: 730` sufficient for Chase/AmEx? | Yes — full 2-year banking/credit history. |
| Is `days_requested: 730` sufficient for Schwab/Robinhood? | No — expands cash-layer only; trade history needs `/investments/transactions/get`. |
| Does the existing exchange-token handle relink account matching? | Yes — fingerprint matching + merge already built. Robinhood needs one addition (no-mask path). |
| Does existing dedup handle overlapping transaction history? | Yes — `findByFingerprint` covers the overlap window. Pending→posted edge case needs a cleanup pass. |
| How is old Item retired? | `disconnectPlaidItemIfOrphaned` — already exists, calls `/item/remove` + sets REVOKED. |
| What new endpoints are needed? | One: `POST /api/plaid/expand-history-token`. No changes to exchange-token. |
| Schema changes needed? | None for banking relink. `plaidInvestmentTransactionId` column for investment tx (deferred). |
| Local-dev testing path? | Manual: remove Chase Item in Plaid Dashboard → mark REVOKED locally → fresh Link → inspect DB. |
