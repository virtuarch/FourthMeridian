# D-fix — Subscriptions Category Detection — Implementation Checklist

**Status:** Checklist only. No implementation. Awaiting approval.
**Source:** `docs/investigations/SUBSCRIPTIONS_FILTER_EMPTY_INVESTIGATION.md`
**Goal:** Obvious subscription merchants (Netflix, Spotify, Apple, Google, Microsoft, Adobe, …) must import as `TransactionCategory.Subscriptions` instead of `Other`/`Shopping`, so the Transactions page Subscriptions filter returns rows.
**Root cause:** `mapPlaidCategory` only assigns `Subscriptions` when Plaid PFC `detailed` contains the token `"SUBSCRIPTION"` — a token Plaid never emits for streaming/SaaS (those are `ENTERTAINMENT_*` / `GENERAL_SERVICES_*`).

Constraints (from request): no schema changes · no UI changes · no FlowType changes · no backfill script in this slice · historical Plaid rows self-heal on next sync (re-sync updates existing rows' `category`).

---

## 1. Exact files

**Changed:**
1. `lib/plaid/syncTransactions.ts` — the `mapPlaidCategory` logic (subscription detection added before the primary PFC switch). See §2 for the two structural options.
2. *(new)* one test file — either `lib/transactions/plaid-category.test.ts` (Option B) or `lib/plaid/mapPlaidCategory.test.ts` (Option A). See §4.

**Reviewed, likely unchanged:**
3. `lib/imports/csv.ts` — `mapCategory` / `CATEGORY_ALIASES`. Already contains a `["subscription"]` alias and keys on a **free-text category string**, not merchant. No change needed for this slice (see §5). Explicitly *not* extended with merchant detection here — that needs a signature/parse change and is deferred.

**Not touched:** `prisma/schema.prisma`, any `components/**`, `lib/transactions/flow-classifier.ts`, `lib/data/transactions.ts`, `lib/transactions/plaid-flow-input.ts`.

---

## 2. Function changes — `mapPlaidCategory`

Add subscription detection **before** the `switch (pfc.primary)` and before the current dead `detailed.includes("SUBSCRIPTION")` line (which can be kept as a harmless superset or removed — recommend keeping for defensiveness). Two deterministic signals, checked in order:

**(a) PFC-detailed allowlist** — a `Set`/array of the streaming/subscription detaileds Plaid actually emits. Match by exact value or narrow substring (e.g. `STREAMING`, `MUSIC_AND_AUDIO`, `TV_AND_MOVIES`, `VIDEO_GAMES`, relevant `GENERAL_SERVICES_*`).
> **Confirm the exact tokens against Plaid's published taxonomy CSV at implementation time** (Plaid shipped PFCv2 in Dec 2025; detailed names vary by version). Do not hardcode guessed tokens — pull the canonical list from `transactions-personal-finance-category-taxonomy.csv`.

**(b) Merchant allowlist fallback** — a small, deterministic, lower-cased substring set applied to the merchant string when PFC is coarse/absent:
`netflix`, `spotify`, `hulu`, `disney` (covers Disney+), `adobe`, `microsoft 365`, `google one`, `google workspace`, `apple.com/bill`, `youtube premium`.
- Match case-insensitively against the raw merchant (`merchant_name ?? name`).
- Keep the list as a named module constant with a comment that it is a deterministic seed, not an exhaustive registry (full brand→category mapping is the future Merchant Engine's job).

**Signature note:** `mapPlaidCategory` currently takes `Pick<PlaidTransaction, "personal_finance_category" | "category">`. The merchant fallback needs the merchant string, so **widen the pick to include `merchant_name` and `name`** (still a `Pick`, no new dependency). Update the single call site (`syncTransactions.ts:257` region) — it already has `txn`, so no data plumbing changes.

Ordering / precedence (smallest, non-regressive):
1. `detailed` INTEREST → Interest (unchanged).
2. **NEW:** PFC-detailed subscription allowlist → Subscriptions.
3. **NEW:** merchant allowlist → Subscriptions.
4. Existing `detailed.includes("SUBSCRIPTION")` (kept; now a rarely/never-hit superset).
5. Existing `switch (pfc.primary)` (unchanged).
6. Existing legacy `category[]` fallback (unchanged).
7. `Other` default (unchanged).

This is purely additive: any row that previously resolved to a non-`Other`/non-`Shopping` category is unaffected unless it is a genuine subscription merchant.

### Structural options for testability (pick one)

- **Option B (recommended) — extract a pure module.** Move `mapPlaidCategory` + the two new constant lists into a new **Prisma-free, side-effect-free** file `lib/transactions/plaid-category.ts`, and re-export it from `syncTransactions.ts` (`export { mapPlaidCategory } from "@/lib/transactions/plaid-category"`). Mirrors the established extraction pattern (`fingerprint.ts`, `merchant.ts`, `plaid-flow-input.ts`). Lets the test import the pure module with `npx tsx` — **no env vars, no `prisma generate`, no Plaid client init.** Mechanical move, zero behavior change.
- **Option A — no move.** Keep `mapPlaidCategory` in `syncTransactions.ts` and test it there. Downside: that module imports `lib/plaid/client.ts`, which **throws at module load without `PLAID_CLIENT_ID/SECRET/ENV`**, and imports `@/lib/db` (PrismaClient). The test would need those env vars set **and** `prisma generate` first, and would initialize a real Plaid client on import — contrary to the repo's "tests import only Prisma-free modules" convention (see `flow-classifier.test.ts` header).

Recommendation: **Option B.** The extraction is small and is the reason the fix stays cleanly testable.

---

## 3. Testability — current state

- `mapPlaidCategory` is **already `export`ed** (`syncTransactions.ts:110`) — reachable, but only via a module with throwing side-effect imports (client.ts) → not cleanly unit-testable today.
- `mapCategory` (csv.ts) is already exported and Prisma-free-ish (imports `@prisma/client` enum only).
- No existing test currently covers either mapper.
- Test harness: **no jest/vitest.** Tests are standalone `tsx` scripts run as `npx tsx <file>.test.ts`, exit 0 on pass / 1 on first failure (pattern: `lib/transactions/flow-classifier.test.ts`). There is no `npm test`; suites are hand-run and not CI-enforced.

---

## 4. Test strategy

New file (Option B): `lib/transactions/plaid-category.test.ts`, following the `flow-classifier.test.ts` tiny-assert pattern, run via `npx tsx lib/transactions/plaid-category.test.ts`.

Cases:
- **Positive PFC:** each allowlisted detailed (Netflix/Spotify style `ENTERTAINMENT_*`, Adobe/MS/Google style `GENERAL_SERVICES_*`) → `Subscriptions`.
- **Positive merchant fallback:** PFC absent/coarse (e.g. `GENERAL_MERCHANDISE` or empty) + merchant contains each allowlist token → `Subscriptions`. Include `Apple.com/Bill`, `YouTube Premium`, `Google One`, `Disney+`.
- **Negatives / non-regression:** ordinary `FOOD_AND_DRINK`→Dining, `GENERAL_MERCHANDISE`(non-sub merchant)→Shopping, `RENT_AND_UTILITIES`→Utilities, `INCOME`→Income, `TRANSFER_IN/OUT`→Transfer, `LOAN_PAYMENTS`→Payment, `BANK_FEES`→Fee, missing PFC + non-sub merchant→Other.
- **Boundary:** case-insensitivity (`NETFLIX.COM`), substring safety (ensure `disney` doesn't false-match an unrelated merchant — pick tokens that won't collide; document any that could).
- Optional: a couple of `mapCategory` (CSV) cases asserting the existing `"subscription"` alias still returns `Subscriptions` (guards the unchanged path).

No DB, no network, no Plaid client — pure function in, enum out.

---

## 5. CSV mapper — decision

`mapCategory(raw: string | undefined)` already maps any category string containing `"subscription"` → `Subscriptions`. It receives a **category column value, not a merchant**, so it cannot do brand detection without a signature/parse change. For this slice: **leave `csv.ts` unchanged.** Merchant-based subscription detection for CSV/Excel imports is a separate, larger change (thread merchant into the mapper) and is deferred. Note in the PR description so it isn't mistaken for an oversight.

---

## 6. Validation plan

Run in order:
1. `npx tsc --noEmit` — clean (catches the widened `Pick` / call-site type).
2. `npx tsx lib/transactions/plaid-category.test.ts` — new suite green (exit 0).
3. `npx tsx lib/transactions/flow-classifier.test.ts` — unchanged suite still green (proves no collateral).
4. `npm run lint` — clean.
5. `npx prisma generate` — sanity only (no schema change; **no `migrate dev`**).
6. **Targeted end-to-end (manual/synthetic):** run a sandbox/synthetic sync (or seed) containing the named merchants → open Transactions → select the **Subscriptions** filter → confirm non-empty and chips read "Subscriptions".
7. **Non-regression checks:** Spend/In summary totals unchanged (they derive from `flowType`, untouched); only subscription merchants move out of Other/Shopping — no unrelated category deltas.

Exit criteria: steps 1–5 green; Subscriptions filter returns the seeded/synced subscription merchants; no change to FlowType-derived totals.

---

## 7. Rollback plan

- **Code-level:** the change is a single self-contained pure function (+ its new module in Option B) and one call-site `Pick` widening. Revert is `git revert <commit>` — no schema, no migration, no data mutation to undo.
- **Data-level:** none required. No backfill runs in this slice, so there is no data migration to reverse. Rows recategorized by a *future* sync would simply revert to their prior mapping on the next sync after a code rollback (self-healing in both directions).
- **Kill-switch (optional):** if desired, gate the new detection behind an env flag (e.g. `SUBSCRIPTION_DETECTION_ENABLED`, default on) so it can be disabled without a redeploy. Not required — the revert is trivial — but available if a false-positive merchant match is discovered in production.
- **Risk surface:** worst case is an over-eager merchant substring matching a non-subscription merchant → mislabeled as Subscriptions. Mitigated by keeping the allowlist tight and token-specific; caught by the negative test cases and step 7.

---

## 8. Stop

Checklist only. No files edited. Awaiting approval to implement (Option B recommended).
