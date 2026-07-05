# Investigation — "Subscriptions" filter empty; subscription transactions land under "Other"

**Status:** Investigation only. No code, schema, migration, or UI changed.
**Date:** 2026-07-04
**Scope:** Transactions page (Banking) category filter vs. import-time classification.

---

## 1. Observed behavior

- The **Subscriptions** category filter on the Transactions page returns nothing.
- Obvious subscription merchants (Netflix, Spotify, Apple, Google, Microsoft, Adobe, …) appear under **Other** (and some under **Shopping**).
- Suspected either a UI filtering bug or a classification bug.

**Conclusion up front:** this is a **classification bug at import time (Root Cause A)**. The UI filter is correct and is reading the same field it displays. The Subscriptions filter is empty because the database rows for these merchants genuinely have `category = "Other"` (or `"Shopping"`), not `"Subscriptions"`.

---

## 2. End-to-end trace

### 2.1 Plaid import
`lib/plaid/syncTransactions.ts → syncTransactionsForItem()`. For each Plaid transaction it computes, in order: `amount` (sign-flipped), **`category = mapPlaidCategory(txn)`**, `date`, `merchant = txn.merchant_name ?? txn.name`, `description = txn.name`, then flow columns via `classifyFlow(...)`, then upserts.

### 2.2 Merchant "normalization"
At the **write path there is no semantic normalization** — `merchant` is stored as the raw Plaid `merchant_name` (or `name`). The real normalizer, `lib/transactions/merchant.ts → normalizeMerchant()`, is a pure grouping/display helper (uppercased key + display name) used **only by the AI assembler**, not by persistence, and it does **not** derive category or brand→subscription mapping. So merchant identity never feeds category.

### 2.3 Flow classification
`lib/transactions/flow-classifier.ts → classifyFlow()` writes `flowType`, `flowDirection`, `pfcPrimary/Detailed`, etc. **`FlowType` has no subscription concept** — its values are `SPENDING | INCOME | REFUND | DEBT_PAYMENT | TRANSFER | INVESTMENT | FEE | INTEREST | ADJUSTMENT | UNKNOWN`. Streaming/SaaS spend classifies as `SPENDING`. FlowType is therefore irrelevant to the Subscriptions filter by design.

### 2.4 Category assignment — the defect
`mapPlaidCategory()` prefers Plaid's `personal_finance_category` (PFC):

```
if (detailed.includes("INTEREST"))     return Interest;
if (detailed.includes("SUBSCRIPTION")) return Subscriptions;   // ← effectively dead

switch (pfc.primary) {
  INCOME→Income; TRANSFER_IN/OUT→Transfer; LOAN_PAYMENTS→Payment; BANK_FEES→Fee;
  FOOD_AND_DRINK→Dining; GENERAL_MERCHANDISE→Shopping; RENT_AND_UTILITIES→Utilities;
  TRAVEL→Travel; default→Other;
}
```

Two problems:

1. **The `"SUBSCRIPTION"` substring test never fires for real Plaid data.** Plaid's PFC taxonomy (16 primary / 104 detailed) has **no detailed value containing the token `SUBSCRIPTION`**. Streaming and subscription services are categorized under `ENTERTAINMENT_*` (e.g. music/TV/movies streaming) and `GENERAL_SERVICES_*`. So this branch is dead code against production Plaid payloads.
2. **The primary `switch` has no arm for the primaries these merchants actually use.** `ENTERTAINMENT` and `GENERAL_SERVICES` are not cases → they hit `default → Other`. `GENERAL_MERCHANDISE` (some Apple/Amazon charges) → `Shopping`.

Net result for the named merchants:

| Merchant | Typical Plaid PFC primary | `mapPlaidCategory` result |
|---|---|---|
| Netflix, Spotify, Disney+, Hulu | `ENTERTAINMENT` | **Other** |
| Adobe, Microsoft 365, Google (Workspace/One) | `GENERAL_SERVICES` | **Other** |
| Apple (App Store / iCloud) | `GENERAL_SERVICES` or `GENERAL_MERCHANDISE` | **Other** / **Shopping** |

The legacy fallback (`txn.category` array `.includes("subscription")`) is likewise almost never populated for these.

### 2.5 Persistence
`db.transaction.create/update` writes `category` (from the mapper above) plus the additive flow columns. The stored `category` is what everything downstream keys on. Note: on re-sync, an existing row is **updated** with freshly recomputed `fields` (including `category`), so historical Plaid rows self-heal once the mapper is fixed.

### 2.6 Transactions page query
`lib/data/transactions.ts → getTransactions()` returns rows where `category IN BANKING_CATEGORIES`. That list **includes both `"Subscriptions"` and `"Other"`**, so the query is not filtering subscriptions out — it faithfully returns whatever `category` was stored. It returns legacy `category` plus `flowType` metadata.

### 2.7 Filter implementation
`components/dashboard/BankingClient.tsx:151`:
```
if (catFilter && tx.category !== catFilter) return false;
```
The dropdown (`ALL_CATEGORIES`, incl. "Subscriptions") sets `catFilter`; the filter compares against **`tx.category`** — the legacy field.

### 2.8 Grouping / display
The row chip renders **`tx.category`** (`BankingClient.tsx:505`). The Spend/In summary strip uses `flowType`. There is no separate "grouping" taxonomy — the "Other/Uncategorized" the user sees is literally the `category` chip.

---

## 3. Per-merchant field audit

| Question | Answer |
|---|---|
| What is stored in the DB? | `merchant` (raw Plaid name), `category` = **Other/Shopping** (rarely Subscriptions), `flowType` = **SPENDING**, `pfcPrimary/Detailed` = `ENTERTAINMENT_*` / `GENERAL_SERVICES_*` (captured but not used for the Subscriptions concept) |
| What does the UI display? | `merchant` + the **`category`** chip |
| What does the filter use? | **`category`** |
| Same semantic source of truth? | **Yes** — filter and display both read `category`. Internally consistent. The defect is upstream, at classification. |

---

## 4. Root-cause classification

- **A. Incorrect classification — YES (primary root cause).** `mapPlaidCategory` cannot recognize subscriptions: its only subscription signal (`detailed.includes("SUBSCRIPTION")`) never occurs in Plaid PFC, and the primaries these merchants use (`ENTERTAINMENT`, `GENERAL_SERVICES`) fall through to `Other`.
- **B. Correct classification but wrong filtering — NO.** The filter is correct and consistent with the displayed field.
- **C. Legacy category vs FlowType mismatch — NO (not the cause of the empty filter).** The filter never consults `flowType`, and `FlowType` has no subscription value, so there is nothing to mismatch. FlowType is orthogonal (economic-flow axis) and correctly untouched by this concern.
- **D. Multiple competing taxonomies — PARTIALLY TRUE as context, not the cause.** Three taxonomies coexist (see §5), but they are not competing *for this filter*: the Subscriptions concept lives only in `TransactionCategory`, and the whole UI path uses it cleanly.

---

## 5. Sources of truth involved

1. **`TransactionCategory`** (Prisma enum incl. `Subscriptions`, `Other`) — the **category axis**. Canonical for the Subscriptions filter, the category chip, `BANKING_CATEGORIES`, and the AI assembler's discretionary-spend logic (`SPENDING_DISCRETIONARY` includes `Subscriptions`).
2. **`FlowType`** (`SPENDING`, `INCOME`, …) — the **economic-flow axis**. Canonical for Spend/In totals and debt attribution. No subscription concept; orthogonal.
3. **Plaid PFC** (`personal_finance_category.primary/detailed`) — a **provider hint / input only**. Never a UI source of truth (the schema comment itself states this).

### Which should be canonical vs presentation-only
- **Canonical for the category/subscription axis: `TransactionCategory`.** Keep it. The fix belongs in what *populates* it, not in the UI.
- **Canonical for the flow axis: `FlowType`.** Unchanged; not a subscription source.
- **Presentation/derivation input only: Plaid PFC.** It should *feed* `TransactionCategory` at import time (and can feed a future Merchant Engine), but must never be read directly by the UI.

There is **no taxonomy war to resolve for this bug.** The single canonical field is already correct in the UI; the mapper that fills it is wrong.

---

## 6. Recommended smallest fix

Change **one pure function**: `lib/plaid/syncTransactions.ts → mapPlaidCategory` (and, for parity, the CSV mapper's alias list in `lib/imports/csv.ts`). No schema, no migration, no UI change.

Add real subscription detection **before** the primary `switch`, using Plaid's actual signals rather than a nonexistent token:

1. **PFC detailed allowlist** — map the streaming/subscription detaileds Plaid really emits (the `ENTERTAINMENT_*` streaming/music/TV entries and the relevant `GENERAL_SERVICES_*` entries) to `Subscriptions`.
2. **Deterministic merchant allowlist fallback** — a small curated substring set (`netflix`, `spotify`, `hulu`, `disney+`, `adobe`, `microsoft 365`, `google (workspace/one)`, `apple.com/bill`, `youtube premium`, …) matched against the normalized merchant, for cases where PFC is coarse.
3. Optionally consult Plaid's recurring-transactions signal later; not required for the minimal fix.

Because re-sync updates existing rows' `category`, **historical Plaid rows recategorize automatically on the next sync** — no mandatory backfill migration. (A one-shot recompute script over stored `pfcPrimary/Detailed` + `merchant` is a nice-to-have to fix data ahead of the next sync, but is optional and separate.)

Keep the change **additive** (new mappings only; do not alter existing arms), consistent with the project's additive-before-subtractive rule.

---

## 7. Validation plan

1. **Unit tests** for `mapPlaidCategory` with representative PFC fixtures: Netflix/Spotify (`ENTERTAINMENT_*`), Adobe/Microsoft/Google (`GENERAL_SERVICES_*`), Apple (`GENERAL_SERVICES` and `GENERAL_MERCHANDISE`) → assert `Subscriptions`; plus regression cases asserting Dining/Shopping/Utilities/Income are unchanged. Mirror for the CSV mapper.
2. `npx prisma generate` — sanity (no schema change expected; no `migrate dev` needed).
3. `npx tsc --noEmit` — clean.
4. `npm run lint` — clean.
5. **Targeted UI check:** seed or run a synthetic sync containing the named merchants → open Transactions → apply the **Subscriptions** filter → confirm non-empty and chips read "Subscriptions".
6. **Non-regression:** confirm the **Spend / In** summary totals are unchanged (they derive from `flowType`, which is untouched); confirm only subscription merchants move out of Other/Shopping (no unrelated category deltas).
7. If a historical backfill script is added, dry-run it (report intended changes) before any write, and re-run steps 5–6.

---

## 8. One-line summary

The Subscriptions filter is empty because `mapPlaidCategory` keys subscription detection on a PFC token (`"SUBSCRIPTION"`) Plaid never emits, so Netflix/Spotify/Apple/Google/Microsoft/Adobe fall through to `Other`/`Shopping`. Filter and display are correct and consistent (both use `category`); the fix is a small, additive change to the import-time category mapper.
