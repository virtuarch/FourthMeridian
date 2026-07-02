> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D4 — Plaid History Investigation: Chase Returns Far Less Than Expected

**Status:** Investigation only. No code changed. No implementation proposed beyond the single concrete gap identified in §7.
**Date:** 2026-07-01
**Branch:** feature/phase-2-architecture

---

## TL;DR

Fourth Meridian **is requesting the full 730 days correctly** and **is not discarding, truncating, or de-duplicating away any history**. The pipeline is behaving correctly.

The reason Chase returned only ~June is that **Plaid backfills historical transactions asynchronously *after* Link completes**, and Fourth Meridian syncs **exactly once, synchronously, at exchange time** — before Plaid has finished the historical pull. Because no `webhook` is configured on the Link token and the background scheduler is dormant, **nothing ever re-syncs the Item after that first call**, so the later-arriving history is never fetched.

**Most likely root cause: Option A/E hybrid — Plaid had not finished the historical update when the one-and-only sync ran, and there is no mechanism to sync again. Confidence: HIGH.**

---

## 1. Execution trace — the entire first-import pipeline

Fresh normal Link → import. Every function in order:

1. **Frontend `openLink()`** — `context/PlaidContext.tsx:166`. Fresh Add-Account click calls `openLink(onDone)` with **no `plaidItemId`** (`components/dashboard/ConnectAccountButton.tsx:22`).
2. **`GET /api/plaid/link-token`** — `context/PlaidContext.tsx:174` fetches `/api/plaid/link-token` with **no query string** (no `plaidItemId`, no `institutionId`).
3. **`link-token` route** — `app/api/plaid/link-token/route.ts:35`. `reconnectItemId` and `institutionId` are both `null` → `accessToken` stays `undefined` → **new-mode branch**.
4. **`plaidClient.linkTokenCreate(...)`** — `app/api/plaid/link-token/route.ts:122`. Sends `products: [Transactions]` and `transactions: { days_requested: 730 }` (`:146`). **No `webhook` field.**
5. **User completes Link → `onSuccess`** — `context/PlaidContext.tsx:64`. POSTs `public_token` + `institution_id` + `institution_name` to `/api/plaid/exchange-token`.
6. **`POST /api/plaid/exchange-token`** — `app/api/plaid/exchange-token/route.ts:40`. Resolves `getSpaceContext()` → `performPlaidTokenExchange(...)`.
7. **`performPlaidTokenExchange`** — `lib/plaid/exchangeToken.ts:93`:
   - `itemPublicTokenExchange` → `access_token`, `item_id` (`:110`)
   - encrypt + `plaidItem.upsert` (`:115`, `:118`)
   - Connection dual-write (`:138`)
   - `accountsGet` → upsert each `FinancialAccount` + `AccountConnection` + `SpaceAccountLink` (`:171`–`:335`)
   - investment holdings (`:337`)
   - **initial transaction sync — `syncTransactionsForItem(plaidItem.id)` (`:406`)**
   - snapshot regen + audit log (`:417`, `:424`)
8. **`syncTransactionsForItem`** — `lib/plaid/syncTransactions.ts:142`:
   - `cursor = item.cursor ?? undefined` → **null on a fresh Item** (`:150`)
   - `while (hasMore)` loop calling `plaidClient.transactionsSync({ access_token, ...(cursor ? {cursor} : {}) })` (`:198`–`:205`)
   - per txn: resolve `FinancialAccount`, sign-flip amount, upsert by `plaidTransactionId` → fingerprint fallback → create (`:208`–`:264`)
   - persists `next_cursor` back to `PlaidItem` **after** the loop (`:278`)

That is the whole path: `linkTokenCreate → itemPublicTokenExchange → accountsGet → transactionsSync (loop) → db writes`. There is **one** `transactionsSync` sequence, run once, inline during exchange.

---

## 2. Evidence the 730-day request WAS actually used

**Confirmed — the fresh reconnect sent `days_requested: 730` in new mode.**

- The value is hard-coded and sent on the `linkTokenCreate` call: `app/api/plaid/link-token/route.ts:146` — `transactions: { days_requested: 730 }`.
- It is only *silently ignored* in **update mode** (when `access_token` is spread in at `:129`). The fresh reconnect did **not** hit update mode, because:
  - The frontend calls `/api/plaid/link-token` with **no params** for a fresh Add-Account (`context/PlaidContext.tsx:174`; `ConnectAccountButton.tsx:22`). The only caller that passes `plaidItemId` is the Reconnect badge (`ReconnectAccountButton.tsx:30`), and the only caller that passes `institutionId` is the **admin** providers page (`app/admin/providers/page.tsx:165`) — neither was the "fresh normal Link" in the test sequence.
  - With no `plaidItemId` and no `institutionId`, both the reconnect branch (`:47`) and the institution auto-detect branch (`:57`) are skipped, so `accessToken` is `undefined` and the spread resolves to `{ products }`, **not** `{ access_token }` (`:129`). New mode. `days_requested: 730` applies.
- Corroborating: the test produced a **fresh Item / fresh cursor**, which is only possible in new mode. Update mode reuses the existing `item_id`.

**Conclusion for Option D ("days_requested not reaching Plaid"): RULED OUT.** The 730-day request reached Plaid.

> Note: The immutability caveat in the code comment (`:136`–`:145`) is real but irrelevant here — it only bites when you try to *expand* history on an already-initialized Item. This was a brand-new Item, so 730 was applied at initialization.

---

## 3. Evidence pagination IS complete

**Confirmed — pagination is correct and exhaustive.** `lib/plaid/syncTransactions.ts`:

- **Cursor used:** `item.cursor ?? undefined` (`:150`).
- **Cursor null on first sync?** Yes. Fresh Item has `cursor = null`; the spread `...(cursor ? { cursor } : {})` (`:203`) omits `cursor` entirely on the first call, which is exactly how Plaid signals "give me everything from the beginning."
- **First page size:** whatever Plaid returns in `added` (Plaid decides page size; default up to 100/page). Not capped by us.
- **`has_more` behavior:** loop condition is `while (hasMore)` (`:198`); `hasMore = has_more` reassigned each iteration (`:274`).
- **Every page fetched?** Yes. The loop continues until Plaid reports `has_more: false`. `cursor = next_cursor` advances each iteration (`:275`).
- **Where the loop exits:** when `has_more` is `false` (`:274` → loop test at `:198`). Only then does it persist `next_cursor` and mark the Item synced (`:278`).

There is **no page cap, no max-iteration guard, no early `break`**. If Plaid had more pages of older history *available at that moment*, they would all have been pulled. The limitation is that Plaid did not yet *have* the older history to page through (see §6).

**Conclusion for Option C ("sync pagination bug"): RULED OUT.**

---

## 4. Evidence of filtering (does any exist on the write/read path?)

**Confirmed — there is NO date filtering, truncation, or history-discarding on either the import (write) path or the account transactions (read) path.**

Searched for: `start_date`, `end_date`, `newer_than`, `oldestTransaction`, `cutoff`, `last 30 / 30 days`, `.slice(`, `take:`, `limit:`, `gte`, `lte`, `createdAt` filters, manual date filtering, soft-delete filtering, dedupe suppression.

Write path (`lib/plaid/syncTransactions.ts`):
- No `date` filter passed to `transactionsSync` — the request body is only `{ access_token, cursor? }` (`:200`–`:203`).
- No `slice`/`take`/`limit` on the added/modified arrays — every returned txn is iterated (`:208`).
- The only `continue` that drops a txn is `skippedMissingAccount` (`:210`) — fires only when no `FinancialAccount` maps to the Plaid `account_id`. Reported counts (26/1/107) are non-trivial, so accounts mapped fine; and this drops by *account*, not by *date*, so it cannot selectively remove older months.

Read/display path (`app/api/accounts/[id]/transactions/route.ts`):
- `findMany` with `where: { OR:[accountId, financialAccountId], deletedAt: null }`, `orderBy: date desc` (`:40`–`:50`). **No date filter, no `take`, no `limit`.** The UI shows everything stored.

The **only** date-windowing / `take` / `slice` in the codebase lives in the **AI Context Builder read layer** — `lib/ai/assemblers/transactions.ts` (`date: { gte: windowStart }` `:142`, `take: TRANSACTION_FETCH_LIMIT` `:152`, `slice` `:244`) and `lib/ai/signals/detectors/goals.ts` (30-day cutoff). These are **D4 AI-consumption reads**; they do not touch import, storage, or the transactions display, so they cannot explain missing stored history.

**Conclusion for Option B ("Fourth Meridian discarding older transactions"): RULED OUT.**

---

## 5. Dedupe — can fingerprinting reject older rows or block reimport?

**Confirmed — no. Dedupe cannot drop or block historical rows.** `lib/plaid/syncTransactions.ts:228`–`:260` + `lib/transactions/fingerprint.ts`:

- Matching is **reuse-or-create**, never reject. Order: exact `plaidTransactionId` match → update (`:235`); else fingerprint match → update in place + adopt new id (`:246`); else **create** (`:259`). There is no branch that discards a transaction because it looked like a duplicate. Module header states this explicitly: "genuinely repeated … transactions are valid data and are never blocked from being created."
- **Could matching against deleted transactions block reimport?** No. `findByFingerprint` filters `deletedAt: null` (`lib/transactions/fingerprint.ts:72`), so soft-deleted rows are never candidates and cannot "adopt"/suppress an incoming txn.
- Moreover, the test did a **hard delete** of all Chase transactions, so the table had **zero** candidates during reimport — both the exact-id lookup and the fingerprint lookup miss for every row → everything takes the **create** path. Dedupe was effectively a no-op on this import.

**Conclusion: dedupe is not the cause.**

---

## 6. Plaid documentation — why a fresh Item returns limited history first

Official Plaid docs describe exactly this behavior:

- **`days_requested`:** "The default value is 90; the maximum value is 730." "The more transaction history is requested, the longer the historical update poll will take." — [API: Transactions](https://plaid.com/docs/api/products/transactions/)
- **History is not available immediately, and arrives in two phases:** "When you first connect an Item in Link, transactions data will not immediately be available." `INITIAL_UPDATE` "fires first, after Plaid has successfully pulled **30 days** of transactions." `HISTORICAL_UPDATE` "fires next, once **all historical transactions data** is available." "`INITIAL_UPDATE` typically fires within 10 seconds, and `HISTORICAL_UPDATE` within 1 minute, although these webhooks may take **2 minutes or more** … depend[ing] on the institution." — [Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)
- **The sync-based equivalent:** "After `/transactions/sync` is called for the first time on an Item, `SYNC_UPDATES_AVAILABLE` webhooks will begin to be sent." "If at least 30 days of history is available … `initial_update_complete` … will be `true`. Similarly, `historical_update_complete` will be `true` if the full history (up to 24 months) is available." — [Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)
- **The first sync can be empty or shallow:** "if transactions data is not yet available for the Item, `/transactions/sync` will return empty transactions arrays." The first sync once history is available "will often have substantially higher latency (up to 8x)." — [API: Transactions](https://plaid.com/docs/api/products/transactions/)
- **Chase / OAuth specifics:** Chase is an OAuth institution. Plaid does not publish a Chase-specific 30-day cap; the ~30-day result is the generic **`initial_update` window (30 days)** that any institution returns before the historical backfill completes. Depth ultimately available can still vary by institution and account type, and checking/savings/credit can differ because each account's history is pulled independently — which fits the observed spread (Savings only 1 txn, Credit 107). But the dominant signal here is the 30-day initial window, not an institution hard cap.

**Interpretation:** Fourth Meridian's single sync runs **inline during `exchange-token`, seconds after Link** — i.e. in the `INITIAL_UPDATE` (~30-day) window, before `HISTORICAL_UPDATE` / `historical_update_complete`. So Plaid legitimately returned only ~30 days *at that instant*. The oldest dates (2026-06-01, i.e. ~30 days before the 2026-07-01 test) are the fingerprint of the initial-update window.

---

## 7. Most likely root cause (ranked)

### HIGH — Plaid had only completed the initial (~30-day) update when the one-and-only sync ran, and nothing re-syncs the Item afterward.

Two independent code facts make this a standing gap, not a fluke:

1. **No re-sync trigger exists.** The Link token is created with **no `webhook` parameter** (`app/api/plaid/link-token/route.ts:122`–`147` — there is no `webhook:` field), so `SYNC_UPDATES_AVAILABLE` / `HISTORICAL_UPDATE` webhooks have nowhere to be delivered. And the background scheduler is **registered but dormant** — `syncTransactions.ts:14`–`17` notes `startScheduler()` "is not invoked anywhere yet (no instrumentation.ts hook)." So after the exchange-time sync, no code path ever calls `transactionsSync` for that Item again.
2. **The one sync is synchronous with exchange**, i.e. within seconds of Link (`exchangeToken.ts:406`) — squarely inside the `INITIAL_UPDATE` window Plaid documents as ~30 days.

Result: Plaid *does* finish the 730-day backfill a minute or more later and makes it available via `SYNC_UPDATES_AVAILABLE`, but Fourth Meridian never asks for it. The history isn't lost — it's **unfetched**. This also explains why the clean re-test returned *less* than before: timing. The earlier run happened to catch a little more; the fresh run caught only the initial window, and (with no follow-up sync) that's where it froze.

This is **not a Fourth Meridian data-handling bug** in the discard/pagination/filter sense — every one of those is ruled out (§2–§5). It is a **missing re-sync mechanism** relative to Plaid's asynchronous backfill model.

### MEDIUM — Institution/account-type variation in ultimately-available depth.
Even after `historical_update_complete`, Chase may expose different depth per account (the 1-txn Savings vs 107-txn Credit split is consistent with per-account pulls). This would *modulate* final history but does not explain the uniform ~30-day floor; the timing gap does.

### LOW — Anything internal to Fourth Meridian discarding history (Options B, C, D).
Ruled out by direct code evidence: 730 is sent (§2), pagination is exhaustive (§3), no filtering exists (§4), dedupe can't reject/block (§5).

---

## 8. Direct answers to the stated options

- **A. Plaid returning only ~30 days from Chase** — **YES, at the moment of sync.** This is the ~30-day `INITIAL_UPDATE` window, correct and expected. **(Primary, HIGH.)**
- **B. Fourth Meridian discarding older transactions** — **NO.** No filter/slice/take/date-cut on write or read paths.
- **C. Sync pagination bug** — **NO.** `while(has_more)` loop is complete; null cursor on first sync; no cap/break.
- **D. `days_requested` not reaching Plaid** — **NO.** 730 is sent in new mode; the fresh link was new mode (fresh Item/cursor prove it).
- **E. Chase OAuth behavior** — **PARTIALLY / contributing.** Chase is OAuth; per-account depth varies. But the decisive factor is Plaid's async backfill timing plus FM's single inline sync, not an OAuth hard cap.

---

## 9. Is Fourth Meridian behaving correctly?

**For the import/storage/dedupe logic: yes — it is behaving correctly and losing nothing.** Given the data Plaid had available at sync time, FM stored all of it faithfully.

**The one genuine gap** (surfaced by this investigation, not a bug in the discard sense): there is **no mechanism to sync again after Plaid's historical backfill completes** — no `webhook` on the Link token and no active scheduler. Until one exists, a fresh Item will predictably stall at ~30 days regardless of `days_requested: 730`.

Per project rules, **no code change is proposed here.** If/when this is picked up as work, the minimal, standard fix is one of:
- add a `webhook` URL to `linkTokenCreate` + a `SYNC_UPDATES_AVAILABLE` handler that calls `syncTransactionsForItem` on `historical_update_complete`; **or**
- wire `startScheduler()` (already written, `jobs/scheduler.ts`) so the dormant periodic sync runs and pulls the backfill on its next tick; **or**
- as an immediate manual check, re-run "Sync Now" (`/api/plaid/sync`) a few minutes after linking and confirm older months appear — this is the fastest way to *prove* the timing hypothesis before building anything.

---

## Sources

- [Plaid Docs — Transactions webhooks](https://plaid.com/docs/transactions/webhooks/)
- [Plaid Docs — API: Transactions (`/transactions/sync`, `days_requested`, `SYNC_UPDATES_AVAILABLE`)](https://plaid.com/docs/api/products/transactions/)
- [Plaid Docs — Introduction to Transactions](https://plaid.com/docs/transactions/)

### Code references
- `context/PlaidContext.tsx` — link-token fetch (`:174`), onSuccess exchange (`:64`)
- `app/api/plaid/link-token/route.ts` — mode selection (`:47`,`:57`,`:129`), `days_requested: 730` (`:146`), no `webhook` field
- `app/api/plaid/exchange-token/route.ts` — exchange entry (`:40`)
- `lib/plaid/exchangeToken.ts` — import + single inline sync (`:406`)
- `lib/plaid/syncTransactions.ts` — cursor/pagination loop (`:150`,`:198`–`:276`), dormant scheduler note (`:14`–`:17`)
- `lib/transactions/fingerprint.ts` — reuse-not-reject dedupe, `deletedAt:null` (`:72`)
- `app/api/accounts/[id]/transactions/route.ts` — unfiltered read (`:40`–`:50`)
- `lib/ai/assemblers/transactions.ts` — date window/`take` lives ONLY in AI read path (`:142`,`:152`,`:244`)
