# Merchant Intelligence — Slice 1: Global Merchant→Category Rules

**Status:** Design + implementation checklist. **No implementation yet.**
**Date:** 2026-07-04
**Predecessor:** `MERCHANT_INTELLIGENCE_LAYER_INVESTIGATION.md`
**Goal:** Smallest **pure** merchant→category rule module that reduces recognizable merchants landing in `Other`, with **no schema, no UI, no user overrides, no FlowType writes, no recurring detection.**

**Guardrails honored:** rules feed `TransactionCategory` only; FlowType stays derived by `flow-classifier.ts`; recurring/cadence detection out of scope; no user-specific merchants (WGU, Georgia LLC, personal card payments) as global rules; catalog curated to universally-identifiable brands + regional brands + generic pattern families, not overfit to one user's ledger.

---

## 1. Exact category vocabulary limits

`TransactionCategory` (prisma/schema.prisma) — the **only** legal outputs, unchanged this slice:

`Income, Transfer, Groceries, Dining, Shopping, Travel, Subscriptions, Utilities, Interest, Payment, Other, Buy, Sell, Dividend, Split, Fee`

**Usable as merchant-rule targets** (spend/merchant-meaningful): `Groceries, Dining, Shopping, Travel, Subscriptions, Utilities, Fee`.
**Off-limits for merchant rules** (flow-structural — owned by PFC/flow-classifier, never set from a merchant string): `Income, Transfer, Payment, Interest`, and all investment values (`Buy, Sell, Dividend, Split`).

**Missing categories that block otherwise-obvious merchants** (decision belongs to a separate enum slice, NOT here): **Medical, Education, Auto/Vehicle-services, Entertainment, Transit, Postal/Shipping, Government/Business-fees.**

## 2. Merchants that map safely to existing categories TODAY (Slice 1 target set)

Each is universally- or regionally-identifiable and has an accurate existing target. (Note: Plaid returns `TRANSPORTATION` primary for rideshare, which `mapPlaidCategory` does **not** map → defaults to `Other` — so `Uber`/`Careem` → `Travel` is a real, correct improvement.)

| Target category | Global brands | Regional-global (locale-tagged) |
|---|---|---|
| **Travel** | Uber | Careem (MENA), Gathern (SA) |
| **Subscriptions** | Anthropic, Supabase, Claude.ai, Vercel, Hostinger | — |
| **Shopping** | Sephora, Bath & Body Works, Ace Hardware, Napa Auto Parts | Ajmal Perfumes (MENA) |
| **Fee** | Amex annual/membership fee (fee-phrase-scoped) | — |

Plus the **existing** subscription allowlist folded in unchanged: `netflix, spotify, hulu, disney, adobe, microsoft 365, google one, google workspace, apple.com/bill, youtube premium`.

## 3. Merchants BLOCKED by missing categories (do NOT force-map this slice)

Leaving these in `Other` is correct until the enum decision is made — forcing them into `Shopping`/`Travel` would be a lie the AI layer and FlowType then inherit.

| Would-be category (missing) | Merchants |
|---|---|
| Medical | pharmacies, clinics |
| Entertainment | Vox Cinema, Six Flags, Speedzone |
| Transit | trolley (arguably `Travel`, but ambiguous — hold) |
| Auto/Vehicle-services | car washes |
| Postal/Shipping | USPS |
| Education | WGU tuition *(also user-specific — see §4)* |
| Government/Business | Georgia LLC filings *(also user-specific)* |

## 3b. Merchants deliberately EXCLUDED from Slice 1 (not category-blocked, but unsafe as a flat global rule)

- **PlayStation, Amazon Prime Video rentals** — subscription-vs-one-off ambiguity. A flat `Subscriptions` rule would mislabel one-off game/rental purchases. This is **cadence detection's** job (separate slice), not a merchant rule. Exclude.
- **Namecheap** — domain purchase (one-off) vs. renewal (recurring) ambiguity; and no clean existing target (`Shopping` vs `Subscriptions`). Exclude pending cadence slice.
- **WGU tuition, Georgia LLC filings, Chase credit-card payments** — user-specific identity. Card payments are already correctly resolved by PFC `LOAN_PAYMENTS`/counterparty. **Never global.**
- **Uber Eats** — must NOT inherit the `Uber`→Travel rule; it is `Dining`. Drives the catalog **ordering** requirement in §4.

## 4. Rule classes: global vs regional-global vs pattern-family

- **Global brand rules** — universal identity: Uber, Anthropic, Supabase, Claude.ai, Vercel, Hostinger, Sephora, Bath & Body Works, Ace Hardware, Napa Auto Parts, + the folded-in subscription brands.
- **Regional-global rules** — real brands, locale-scoped: Careem, Gathern, Ajmal Perfumes. Same module, tagged `scope: 'regional', locale: 'MENA'|'SA'` (metadata only; still matched globally this slice — locale is for future gating, not behavior now).
- **Pattern-family rules** — a class, not one brand (e.g. fee phrases). Slice 1 ships **one** low-risk family: **Amex membership/annual fee** phrase → `Fee`. Broader families (pharmacy, clinic, car wash) are **deferred** because their targets (Medical/Auto) don't exist yet (§3).

**Matching semantics (critical, conservative):**
- Lowercased substring match against **both** `merchant_name` and `name` (mirrors existing `isSubscriptionMerchant`).
- Tokens must be **specific, curated phrases** (`"ace hardware"`, not `"ace"`; `"napa auto"`, not `"napa"`) to avoid false merges — same conservative-merge doctrine as `merchant.ts`.
- Catalog is **ordered; most-specific first.** `"uber eats"`→Dining must be tested **before** `"uber"`→Travel. First match wins.

## 5. Integration with `mapPlaidCategory`

- **New pure module:** `lib/transactions/merchant-rules.ts` — dependency-free, `import type { TransactionCategory }` only (identical constraints to `plaid-category.ts`, runnable under `tsx`). Exports:
  - `resolveMerchantCategory(merchantName, name?): TransactionCategory | null` — returns a category when a curated rule matches, else `null`.
  - The subscription allowlist **moves here** (single source of truth); `plaid-category.ts` imports `isKnownSubscriptionMerchant` from it (keep the exported name so `scripts/reclassify-subscriptions.ts` is untouched) — or re-export to avoid churn.
- **Call site:** `mapPlaidCategory` in `lib/transactions/plaid-category.ts` — one added branch (see §6). No other file changes.
- **Out of scope this slice:** the CSV importer's separate `mapCategory` keyword map (`lib/imports/csv.ts`). Note as a follow-up so the two paths converge later; do not touch now (keeps the diff minimal and the symptom — Plaid-synced rows — is where the value is).

## 6. Precedence — do rules run before or after Plaid PFC?

**Rules run AFTER flow-structural PFC, BEFORE PFC spend-bucket mapping.** Merchant rules are strong for the long tail PFC misses, but must never override flow-critical PFC signals.

Order inside `mapPlaidCategory` (first match wins):

1. `detailed` contains `INTEREST` → `Interest` *(existing)*
2. **Flow-structural PFC primaries win over merchant rules:** `INCOME`→Income, `TRANSFER_IN`/`TRANSFER_OUT`→Transfer, `LOAN_PAYMENTS`→Payment, `BANK_FEES`→Fee. *(existing mappings; a merchant string must not override these — e.g. a payee named like a store on a loan payment)*
3. **`resolveMerchantCategory(...)`** *(new — includes folded subscription allowlist)* → its category if non-null.
4. PFC spend-bucket switch: `FOOD_AND_DRINK`→Dining, `GENERAL_MERCHANDISE`→Shopping, `RENT_AND_UTILITIES`→Utilities, `TRAVEL`→Travel *(existing)*.
5. No-PFC path: `resolveMerchantCategory` (already applies via step 3 ordering), then legacy `category[]` fallback *(existing)*.
6. `Other` *(existing)*.

Rationale for placing step 3 above step 4: PFC frequently dumps regional/SaaS merchants into `GENERAL_MERCHANDISE`/`Other`; a curated rule is more precise there. It stays **below** step 2 so it can never corrupt income/transfer/loan/fee structure. Net effect on FlowType: unchanged except via category, exactly as required.

## 7. Test strategy (pure, `tsx`, no DB)

- **New `lib/transactions/merchant-rules.test.ts`:** table-driven — every catalog entry → expected category; assert regional entries resolve; assert subscription brands still resolve (parity with old behavior).
- **False-positive / ordering guards:** `"UBER EATS ..."`→Dining (not Travel); `"ACE HARDWARE #123"`→Shopping but a bare `"ace"` token → `null`; `"disney store"` caveat documented; a random unmatched merchant → `null`.
- **Extend `lib/transactions/plaid-category.test.ts`:** precedence cases — merchant rule overrides a `GENERAL_MERCHANDISE`/`Other` PFC; merchant rule does **NOT** override `LOAN_PAYMENTS`/`TRANSFER_OUT`/`INCOME`; existing subscription cases unchanged (regression parity).
- **Structural:** `npx tsc --noEmit`, `npm run lint`, `npx prisma generate` (no schema change, sanity only).
- No FlowType test changes expected; run the FlowType equivalence/`flow-classifier` tests to **prove** flow output is unchanged (category-only effect).

## 8. Backfill strategy (after rules land)

Plaid sync is incremental and won't revisit old rows, so historical `Other` rows need a one-shot reclass — reuse the proven shape of `scripts/reclassify-subscriptions.ts` / `scripts/backfill-flowtype.ts`.

- **Selection:** rows where `deletedAt IS NULL` **and** `category = 'Other'` whose stored `merchant` matches `resolveMerchantCategory`. (Restricting to `Other` keeps it conservative and the rollback trivial — see §9. A later pass could also correct `Shopping`/`Dining` mismatches, but not this slice.)
- **Idempotent:** re-running produces zero changes.
- **Dry-run first:** print a per-category diff table (count of rows Other→Travel, Other→Subscriptions, …) for review **before** any write.
- **Guarded write:** only update `category`; never touch `merchant`, `flowType*`, `pfc*`, or `plaidTransactionId`. (FlowType backfill, if desired, is its own existing script — out of scope here.)
- **Note:** rows re-classified to a new category may deserve a FlowType re-run later; explicitly deferred, documented, not automatic.

## 9. Rollback plan

- **Code:** pure module + one call-site branch — revert `merchant-rules.ts` and the `plaid-category.ts` branch; nothing persisted, nothing else to undo.
- **Backfill:** because it only touches rows that were `category = 'Other'`, the reverse is deterministic — snapshot `(id, oldCategory='Other')` to a JSON file at run time; rollback sets those ids back to `Other`. Run inside a batched transaction with the snapshot written first.
- **No schema, no migration, no down-migration needed.**

## 10. Exact files

**New:**
- `lib/transactions/merchant-rules.ts` — pure resolver + curated catalog (+ folded subscription allowlist).
- `lib/transactions/merchant-rules.test.ts` — catalog + false-positive + ordering tests.
- `scripts/backfill-merchant-categories.ts` — dry-run-first, idempotent, `Other`-only reclass with snapshot. *(landed with the slice but run manually, separately.)*

**Modified:**
- `lib/transactions/plaid-category.ts` — add step-3 branch; import/re-export subscription predicate from the new module.
- `lib/transactions/plaid-category.test.ts` — precedence + regression cases.

**Explicitly NOT touched:** `prisma/schema.prisma`, any `app/**` route, any `components/**`, `flow-classifier.ts`, `syncTransactions.ts` (calls `mapPlaidCategory` unchanged), `lib/imports/csv.ts`.

## 11. Proposed rule catalog (curated — for review before coding)

Ordered, most-specific-first. `scope`/`locale` are metadata only this slice.

```
# specificity guard — must precede broader tokens
"uber eats"            -> Dining        (global)   # beats "uber"

# Travel
"uber"                 -> Travel        (global)
"careem"               -> Travel        (regional: MENA)
"gathern"              -> Travel        (regional: SA)

# Subscriptions (curated new)
"anthropic"            -> Subscriptions (global)
"claude.ai"            -> Subscriptions (global)
"supabase"             -> Subscriptions (global)
"vercel"               -> Subscriptions (global)
"hostinger"            -> Subscriptions (global)
# Subscriptions (folded existing, unchanged)
"netflix","spotify","hulu","disney","adobe","microsoft 365",
"google one","google workspace","apple.com/bill","youtube premium"

# Shopping
"sephora"              -> Shopping      (global)
"bath & body works"    -> Shopping      (global)
"ace hardware"         -> Shopping      (global)
"napa auto"            -> Shopping      (global)
"ajmal"                -> Shopping      (regional: MENA)

# Fee (pattern-family, phrase-scoped)
"amex annual fee","american express annual","amex membership fee" -> Fee (global)
```

**Held out (documented, not coded):** PlayStation, Amazon Prime Video, Namecheap (cadence-ambiguous); pharmacies, clinics, car washes, Vox Cinema, Six Flags, Speedzone, USPS, trolley (no target category); WGU, Georgia LLC, card payments (user-specific/flow-structural).

## 12. Implementation checklist (execute only after approval)

1. Create `lib/transactions/merchant-rules.ts`: ordered catalog + `resolveMerchantCategory`; move subscription allowlist here; keep/`re-export isKnownSubscriptionMerchant`.
2. Create `lib/transactions/merchant-rules.test.ts`: catalog, ordering (`uber eats`), false-positive, subscription-parity cases.
3. Edit `lib/transactions/plaid-category.ts`: add step-3 branch below flow-structural PFC, above spend-bucket switch; re-point subscription import.
4. Extend `lib/transactions/plaid-category.test.ts`: precedence + regression.
5. Validate: `npx prisma generate`, `npx tsc --noEmit`, `npm run lint`, run both `tsx` test files, run FlowType tests to prove no flow drift.
6. Create `scripts/backfill-merchant-categories.ts` (dry-run default, `Other`-only, snapshot, idempotent). **Do not run in prod** as part of the code change — run separately after review of the dry-run diff.
7. Commit code slice; keep backfill run as a distinct, reviewed operation.

**Stop after checklist. Await approval before any code.**
