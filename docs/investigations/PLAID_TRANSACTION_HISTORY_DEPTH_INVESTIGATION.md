# Plaid Transaction History Depth — Investigation Report

**Date:** 2026-07-01  
**Branch:** feature/phase-2-architecture  
**Baseline:** v2.3.0  
**Status:** Investigation complete. No code modified.

---

## 1. Scope

This investigation answers why observed transaction history is shallower than expected:

- Chase checking: Jun 5–Jun 29 (~24 days)
- Chase savings: Apr 9–Jun 15 (~67 days)
- Chase credit card: Mar 22–Jun 29 (~99 days)

And why clearing `PlaidItem.cursor` and triggering a refresh did **not** expand the available history.

---

## 2. Files Inspected

| File | Purpose |
|---|---|
| `app/api/plaid/link-token/route.ts` | Active link token creation endpoint |
| `app/api/plaid/create-link-token/route.ts` | Deprecated link token endpoint (never called) |
| `app/api/plaid/exchange-token/route.ts` | Post-Link Item creation + initial sync trigger |
| `lib/plaid/client.ts` | Plaid API client singleton |
| `lib/plaid/syncTransactions.ts` | Core incremental sync function |
| `lib/plaid/refresh.ts` | Full refresh pipeline (balances + holdings + transactions) |
| `context/PlaidContext.tsx` | Frontend Link context (fetches token, handles success) |
| `components/plaid/PlaidLinkButton.tsx` | UI wrapper around `usePlaidLink` |
| `node_modules/plaid/dist/api.d.ts` | Plaid TypeScript SDK type declarations |

---

## 3. Current Link Token Configuration

### Active endpoint: `app/api/plaid/link-token/route.ts`

```typescript
const products      = [Products.Transactions];
const country_codes = [CountryCode.Us];

const response = await plaidClient.linkTokenCreate({
  user:          { client_user_id: user.id },
  client_name:   "Fourth Meridian",
  country_codes,
  language:      "en",
  ...(accessToken ? { access_token: accessToken } : { products }),
  ...(redirectUri && { redirect_uri: redirectUri }),
});
```

**No `transactions` config object. No `days_requested`.**

### Deprecated endpoint: `app/api/plaid/create-link-token/route.ts`

Same pattern — no `transactions.days_requested`. This file is marked as never called and can be ignored.

### Client-level config: `lib/plaid/client.ts`

Reads `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` from env. No transaction-specific config. Nothing here affects history depth.

### Frontend: `context/PlaidContext.tsx`, `PlaidLinkButton.tsx`

No transaction config at either layer. The frontend passes only `?plaidItemId=` for reconnect mode. All Plaid product configuration is server-side.

---

## 4. Is Maximum History Requested?

**No.**

`days_requested` is not set anywhere in the codebase. Plaid defaults to **90 days** when this field is omitted.

### SDK confirmation (`LinkTokenTransactions` interface, line 34688 of `api.d.ts`):

```typescript
export interface LinkTokenTransactions {
    /**
     * The maximum number of days of transaction history to request for the
     * Transactions product. The more transaction history is requested, the
     * longer the historical update poll will take. The default value is 90
     * days. In Production, if a value under 30 is provided, a minimum of
     * 30 days of history will be requested. Once Transactions has been added
     * to an Item, this value cannot be updated.
     */
    days_requested?: number;
}
```

**Maximum possible:** 730 days (per Plaid docs).  
**Currently requested:** 90 days (implicit default).  
**Where it must be set:** in the `transactions` field of `linkTokenCreate`, not in `transactionsSync`.

### Why `transactionsSync` `days_requested` is irrelevant here

Fourth Meridian initializes the Transactions product in the `products` array of `/link/token/create`. Per the SDK docstring on `TransactionsSyncRequest.days_requested`:

> "If you are initializing your Items with transactions during the `/link/token/create` call (e.g. by including `transactions` in the `/link/token/create` `products` array), you must use the `transactions.days_requested` field in the `/link/token/create` request instead of in the `/transactions/sync` request."

`syncTransactions.ts` does not pass `days_requested` to `transactionsSync` either, but this is correct behavior — the depth limit is set once at Item initialization, not per sync call.

---

## 5. Why Cursor Reset + Refresh Did Not Help

Clearing `PlaidItem.cursor` causes the next `transactionsSync` call to omit the cursor parameter:

```typescript
// lib/plaid/syncTransactions.ts
plaidClient.transactionsSync({
  access_token,
  ...(cursor ? { cursor } : {}),
})
```

A null cursor instructs Plaid to return "the entire history of updates, starting with the first-added transactions on the Item." However, "first-added" is bounded by what was requested at Item initialization time — i.e., 90 days from when the user connected their account.

Cursor reset is a **replay within the initialized window**, not an expansion of it. If the Item was initialized requesting 90 days, a cursor reset can return at most 90 days. No more.

---

## 6. Can Existing Chase Items Be Expanded?

**No.**

SDK docstring on `LinkTokenTransactions.days_requested`:

> "Once Transactions has been added to an Item, this value cannot be updated."

SDK docstring on `TransactionsSyncRequest.days_requested`:

> "If the Item has already been initialized with the Transactions product, this field will have no effect. The maximum amount of transaction history to request on an Item cannot be updated if Transactions has already been added to the Item. **To request older transaction history on an Item where Transactions has already been added, you must delete the Item via `/item/remove` and send the user through Link to create a new Item.**"

There is no in-place upgrade path. The Item's history ceiling is permanently set at the moment the user first completes the Link flow for that institution.

---

## 7. Why Depth Varies Across Chase Accounts

All three Chase accounts share one `PlaidItem` (Plaid groups accounts from the same institution+login under one Item). The depth ceiling is per-Item, not per-account.

The variation observed (checking ~24 days, savings ~67 days, credit ~99 days) is likely explained by a combination of:

1. **Institution-specific availability**: Chase may make different amounts of history available in Plaid's system for checking vs. savings vs. credit accounts. Credit cards commonly have longer Plaid-accessible history than depository accounts.
2. **Sandbox synthetic data**: In Plaid Sandbox, transaction data is synthetic and ~30 rows regardless of institution type. Date ranges returned may be non-deterministic and do not honor `days_requested` the same way Production does.
3. **Account age / enrollment date**: Plaid can only return transactions that were available at the institution at sync time, bounded by `days_requested`.

For Production diagnosis, the Plaid Dashboard → Item Details page will show the actual history depth initialized per Item.

---

## 8. Recommended Implementation (New Items Only)

**One-line change in `app/api/plaid/link-token/route.ts`.**

Add `transactions: { days_requested: 730 }` to the `linkTokenCreate` call:

```typescript
const response = await plaidClient.linkTokenCreate({
  user:          { client_user_id: user.id },
  client_name:   "Fourth Meridian",
  country_codes,
  language:      "en",
  ...(accessToken ? { access_token: accessToken } : { products }),
  ...(redirectUri && { redirect_uri: redirectUri }),
  // Request maximum available history (up to 2 years) on new Items.
  // Has no effect on update-mode calls (accessToken path) — Plaid ignores
  // transactions config when access_token is present. Safe to include always.
  transactions:  { days_requested: 730 },
});
```

**Why 730:** Plaid's maximum. For a personal finance tool, 2 years of history is the right default — AI context, spending trend analysis, and subscription detection all benefit from it.

**Why it's safe to include on update-mode calls:** When `access_token` is passed (reconnect flow), Plaid ignores the `transactions` config entirely per their docs. The field does nothing in that path. Conditionally gating it would add complexity for no benefit.

**What this fixes:**
- All new Items linked going forward will request up to 730 days of history.
- Initial sync after exchange-token will return up to 2 years on supported institutions.

**What this does NOT fix:**
- Existing Chase Items already initialized at 90 days. Their ceiling cannot be raised without relinking.
- Plaid Sandbox behavior — synthetic data will not meaningfully change.

---

## 9. Safest Path for Existing Chase Items

To get deeper history on the existing Chase Item, the user must relink:

1. Delete the existing Plaid Item via `/item/remove` (Plaid side) + mark the `PlaidItem` as deleted in the DB.
2. Send the user through Link fresh (new Item, new `access_token`).
3. With the `days_requested: 730` fix deployed, the new Item will be initialized at 730 days.
4. Initial sync will backfill up to 2 years of history.

**Risk:** All existing transactions for that Item are associated with `PlaidItem.id` via `FinancialAccount → Transaction`. Deleting the Item without preserving transactions (or migrating them to the new Item's FinancialAccounts) would cause data loss.

**Safer variant (user-initiated relink, no DB purge):** Add a UI affordance that lets the user initiate a voluntary relink. On success in `exchange-token`, detect that the same institution already has a `PlaidItem` and offer a migration path rather than blind deletion.

This is a non-trivial workflow and should be designed separately. It is **not** the same as the existing reconnect/update-mode flow, which only refreshes credentials without re-initializing Transactions depth.

---

## 10. What to Defer

| Feature | Defer to |
|---|---|
| Automatic Item deletion + relink for existing users | v2.7 / separate design |
| CSV import UI for manual transaction backfill | v2.7 (per Phase 2 deferral list) |
| Per-institution `days_requested` tuning | v2.7 (730 days is fine as a universal default) |
| Recurring transaction detection (`/transactions/recurring/get`) | Future (requires ≥ 180 days of history; unlocked by this fix) |
| Webhook-based sync (`SYNC_UPDATES_AVAILABLE`) | Future (currently using Vercel cron daily at 06:00 UTC) |
| Surfacing initialization depth to users in Settings | v2.7 |

---

## 11. Summary

| Question | Answer |
|---|---|
| Is `days_requested` set anywhere? | **No.** Plaid defaults to 90 days. |
| Where must it be set? | `transactions.days_requested` in `linkTokenCreate` (not in `transactionsSync`) |
| Can existing Items be expanded? | **No.** Must `/item/remove` and relink. |
| Why did cursor reset not help? | Replay within the initialized window — not an expansion. |
| Why does Chase credit have more history? | Institution-level availability + Sandbox synthetic data variance. |
| Fix for new Items? | Add `transactions: { days_requested: 730 }` to `linkTokenCreate`. |
| Fix for existing Items? | Voluntary user relink (separate workflow, defer to v2.7). |
| Sandbox impact of fix? | Minimal — Sandbox returns synthetic data regardless. |
| Phase 2 impact? | One-line change. No schema changes. No migration. No breaking changes. |
