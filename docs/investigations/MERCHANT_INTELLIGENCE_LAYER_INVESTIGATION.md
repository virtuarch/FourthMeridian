# Merchant Intelligence Layer — Investigation

**Status:** Investigation only. No implementation, no schema changes proposed as approved.
**Date:** 2026-07-04
**Scope:** Determine what exists today vs. what is missing for a true merchant intelligence layer, and define how it should interact with category, FlowType, Plaid PFC, and overrides.

---

## 0. Executive summary

The thing called "merchant normalization" today is **string hygiene, not merchant intelligence.** It cleans up how a merchant name *looks* and *groups*, but it does not know what a merchant *is* or what category it belongs to. Category is assigned entirely by `mapPlaidCategory()` from Plaid's PFC taxonomy. Any merchant Plaid can't confidently classify — regional merchants (Careem, Gathern, Vox Cinema, Ajmal), niche SaaS (Anthropic, Supabase, Vercel, Hostinger, Namecheap), and one-offs — falls through to `Other`. That is the root cause of the "recognizable merchants under Other" symptom, and **no amount of normalization fixes it** because normalization never touches category.

There are also **two unrelated normalizers** in the codebase that are easy to confuse, and **no user override, no space override, and no merchant→category rule layer of any kind.** The `merchantEntityId` column exists as a forward seed but is written and never read.

---

## 1. Current merchant normalization code — what exists

There are **two distinct, non-interoperating** normalizers:

**A. `normalizeMerchantKey(value)` — `lib/transactions/fingerprint.ts`**
Trim → collapse whitespace → uppercase. Nothing else. Its only job is **dedup matching** during Plaid sync (`findByFingerprint`) and CSV import. Deliberately conservative — does not strip reference numbers so two genuinely different rows never merge.

**B. `normalizeMerchant(raw)` → `{ canonicalKey, canonicalName }` — `lib/transactions/merchant.ts`**
The richer one (labeled "D6.3A-1 — Merchant Intelligence foundation"). Pure/deterministic. Strips a tight allowlist of leading payment-rail prefixes (`SQ *`, `TST*`, `PAYPAL *`, `POS`, `ACH`, `CHECKCARD`, …), drops store/reference/masked-card tokens, and title-cases ALL-CAPS bank text. Produces a grouping key + a display-safe name.

Critically, **B is formatting only.** It has no brand dictionary. It does not know "Uber" is Travel or "Anthropic" is a subscription. It cannot map `AMZN MKTP` → Amazon (the header explicitly excludes brand aggregators like `GOOGLE *`, `AMZN MKTP` to avoid changing meaning).

## 2. Where normalized merchant is used today

`normalizeMerchant` (B) is imported in **exactly one place**: `lib/ai/assemblers/transactions.ts` (the AI Context Builder). It is used to:
- group transactions into merchant-spend summaries and income-source summaries for the AI context (lines ~446–562), and
- produce a cleaned display name for merchant rows fed to the model (line ~996).

Those summaries surface in the AI chat prompt via `app/api/ai/chat/route.ts` (`mrc.canonicalName`, `src.canonicalName`).

`normalizeMerchantKey` (A) is used in `syncTransactions.ts` and `lib/imports/csv.ts` for fingerprint dedup only.

## 3. Does normalization affect persistence / category / FlowType, or only AI/display?

**Only AI context.** Concretely:

- **Persistence:** `syncTransactions.ts` stores `merchant = txn.merchant_name ?? txn.name` — the **raw** Plaid string. `normalizeMerchant` is never called on the write path. The stored `merchant` column is unnormalized.
- **Display (Transactions page):** `SpaceTransactionsPanel.tsx` renders `tx.merchant` and `tx.category` **raw**, straight from the DB. The canonicalized name never reaches the UI.
- **Category:** assigned by `mapPlaidCategory()` (see §4). Merchant normalization has **zero** influence on category.
- **FlowType:** classified by `classifyFlow()` from category + amount sign + account type + Plaid PFC. Merchant text is an available input field but is **not used** by any current rule. Merchant influences FlowType only indirectly, through category.

So the merchant intelligence "foundation" today is a leaf used by one consumer (AI), invisible to the ledger the user actually looks at.

## 4. Current category mapper limitations (`plaid-category.ts`)

`mapPlaidCategory()` is driven almost entirely by Plaid's PFC `primary` bucket. Limitations:

1. **Subscription knowledge is a 10-brand hardcoded allowlist:** `netflix, spotify, hulu, disney, adobe, microsoft 365, google one, google workspace, apple.com/bill, youtube premium`. **None** of the user's SaaS (Anthropic, Supabase, Claude.ai, Vercel, Hostinger, Namecheap, PlayStation, Amazon Prime Video) are on it. They fall to whatever PFC says, usually `Shopping` or `Other`.
2. **`Groceries` is never emitted.** `FOOD_AND_DRINK` → `Dining`. The enum has `Groceries` but only the **CSV importer** (`lib/imports/csv.ts` keyword map) ever produces it. Plaid-synced grocery runs land in `Dining`.
3. **No merchant→category rules at all.** If Plaid returns no/low-confidence PFC (common for regional MENA merchants: Careem, Gathern, Vox Cinema, Ajmal; and for niche billers), the row defaults to `Other`. This is the direct cause of the reported symptom.
4. **Category vocabulary is narrow.** `TransactionCategory` has no Medical, Education, Auto, Entertainment, Transportation, or Government/Business-fees. So even a perfect merchant rule for pharmacies, clinics, WGU tuition, car washes, or Georgia LLC filings has **nowhere accurate to map** except `Other`/`Shopping`. **The category enum is a binding constraint on any merchant layer and must be part of the design conversation.**
5. **No feedback loop.** Nothing learns from corrections because corrections can't be made (§5).

## 5. How merchant rules SHOULD interact with the existing systems

The clean model is a **precedence chain that resolves category, with FlowType derived downstream** — not a second flow authority.

**Proposed resolution precedence (highest wins):**

1. **User override** (per-user, per-merchant correction) — *does not exist yet.*
2. **Space override** (a Space re-categorizes a merchant for its own context, e.g. a business Space treats Amazon as Supplies) — *does not exist yet.*
3. **User-specific rule** (learned/promoted from that user's overrides) — *does not exist yet.*
4. **Global merchant rule** (shared catalog: Uber→Travel, Anthropic→Subscriptions) — *does not exist yet.*
5. **Plaid PFC** (`mapPlaidCategory`) — exists; becomes the fallback, not the authority.
6. **Sign / category default** — exists.

Interaction rules that must hold:

- **TransactionCategory:** the merchant layer outputs a *category suggestion*; the chain above decides. Merchant rules should override PFC **only at high confidence** (PFC is genuinely good for mainstream US merchants; the merchant layer's value is the long tail PFC misses).
- **FlowType:** keep `flow-classifier.ts` as the **single source of flow truth.** Merchant rules feed *category*, and category feeds flow. Do **not** let a merchant rule write `flowType` directly, with one carefully-scoped exception class: rows whose meaning *is* a flow (Chase card **payment** → `Payment`/`DEBT_PAYMENT`, Amex **annual fee** → `Fee`). Even those should route through category so there is one classifier.
- **Plaid PFC:** treat PFC as a *signal*, persisted in `pfcPrimary/pfcDetailed` (already captured). Merchant rules layer **on top** of it; never delete or overwrite the raw PFC.
- **User overrides:** a correction should (a) fix that row, (b) optionally offer "apply to all from this merchant," and (c) become a candidate personal rule. Requires new persistence (§7).
- **Space overrides:** `SpaceAccountLink` today governs *visibility only*, not categorization. A space-level recategorization is a **separate concept** and needs its own store. Defer unless explicitly approved.
- **Recurring/subscription detection:** **keep strictly separate from merchant categorization.** "Is this merchant a subscription *business*" (Netflix) is a merchant-catalog fact. "Does this specific charge *recur* on a cadence" (any merchant billing monthly) is a time-series detection over the ledger. PlayStation and Amazon Prime Video are the trap: same merchant is a subscription *sometimes* and a one-off rental *other times* — only cadence detection, not the merchant name, can tell them apart. Conflating the two will mislabel one-offs.

## 6. Which listed merchants are global vs user-specific vs pattern-detected

| Class | Merchants | Rationale |
|---|---|---|
| **Global brand rules** (identity is universal) | Uber, Anthropic, Supabase, Claude.ai, Vercel, Hostinger, Namecheap, Sephora, Bath & Body Works, PlayStation, Amazon Prime Video, USPS, Ace Hardware, Napa Auto Parts, Six Flags, Speedzone | Same meaning for every user; belong in a shared catalog. |
| **Global-but-regional** (real brands, locale-scoped) | Careem, Gathern, Vox Cinema, Ajmal Perfumes | Universally identifiable *within* a region (MENA). Belong in the global catalog **with a locale tag**, not user-specific. Their absence is exactly why Plaid PFC misses them. |
| **Payment-rail / wrapper** (unwrap, don't categorize) | Apple Pay | A rail, not a merchant. Belongs in the prefix-strip layer (`merchant.ts`), so the *real* merchant behind it surfaces. |
| **User-specific rules** (identity depends on this user) | WGU tuition, Georgia LLC filings, Chase credit card payments, Amex annual fee | Tied to *this* user's school, *this* user's LLC/state, *this* user's specific cards/counterparty accounts. Can never be global. Card payment/fee should also resolve via the counterparty-account link, not merchant text alone. |
| **Pattern-detected families** (a class, not one brand) | pharmacies, clinics, car washes, trolley/transit | Match keyword/regex families (pharmacy, clinic, car wash, transit) → a category class. Generalize across users without enumerating brands. Blocked today by the missing Medical/Auto/Transport categories (§4.4). |

Design guardrail satisfied: this classification is **not** a dump of personal merchants into global code. Only universally-identifiable brands (incl. regional ones, locale-tagged) go global; anything tied to the user's personal context is user-specific or pattern-based.

## 7. Pure rule module first, or MerchantRule table now?

**Start with a pure rule module. Do not add a table yet.**

- A pure, in-code global catalog (mirroring the existing `merchant.ts` / `plaid-category.ts` dependency-free pattern) covers **every global, regional-global, and pattern rule** in §6 — the bulk of the reported symptom. It is deterministic, unit-testable with `tsx`, needs no migration, and is trivially reversible (delete the module, revert the one call site).
- A **`MerchantRule` table is required only for the persisted, per-user/per-space slices** (user overrides → learned personal rules; space overrides). That is real user data and must be stored. **Justify the schema only when that slice is approved** — not for the global catalog.
- Corollary: `Transaction` will eventually need an override/provenance signal (e.g. `categorySource` + a user-set category), so the UI can show "you set this" vs "auto." That is also **deferred to the override slice**, not the global catalog.

This keeps the project rule "additive before subtractive / no schema unless clearly justified" intact: Slice 1 ships value with zero schema.

## 8. How this scales to other users

- **Global catalog** scales cleanly for shared brands (Uber, Netflix) — one rule, all users benefit.
- **Regional coverage** scales via a **locale-tagged** catalog so a MENA user gets Careem/Gathern and a US user gets their equivalents, without cross-contamination. This is the main lever that makes the layer not-just-Chris's-merchants.
- **Pattern families** (pharmacy, clinic, car wash, transit) scale by *class*, covering merchants nobody enumerated.
- **User-specific merchants** (their LLC, their school) fundamentally cannot be global; they scale through the **override → personal-rule** loop. High-frequency personal patterns seen across many users become candidates for promotion into the global catalog by maintainers.
- **The learning loop** is the scaling engine: user override → personal rule → (aggregate) global catalog promotion. Without persisted overrides (§7), there is no loop and the layer stays static.

## 9. Smallest safe implementation slices

Each slice is independently shippable, additive, and reversible. **Investigation only — none are approved here.**

- **Slice 0 — Naming/clarity (no behavior):** document that `normalizeMerchantKey` (dedup) and `normalizeMerchant` (canonical) are different, to stop the confusion. Zero risk.
- **Slice 1 — Global merchant→category rule module (pure, no schema):** a deterministic catalog + resolver. Wire it into `mapPlaidCategory` (or a thin layer around it) as a signal **above PFC**. Covers most §6 global + regional + pattern merchants. This is the highest value / lowest risk slice and directly attacks the "Other" symptom.
- **Slice 1a — Category enum gap decision:** decide whether to add Medical/Education/Auto/Transport/etc. **before** relying on rules for pharmacies/clinics/WGU/car washes. Rules are capped by the enum (§4.4). This is a decision gate, not code.
- **Slice 2 — Backfill existing rows:** offline reclassify script over historical `Other`/mismatched rows using Slice 1's resolver (pattern already exists: `scripts/reclassify-subscriptions.ts`, `scripts/backfill-flowtype.ts`). Idempotent, dry-run first.
- **Slice 3 — Recurring/cadence detection (separate track):** time-series detection distinct from the merchant catalog; resolves the PlayStation / Prime Video subscription-vs-one-off case. Do **not** fold into Slice 1.
- **Slice 4 — User overrides (first schema):** `MerchantRule` (or an override column) + an edit affordance in `SpaceTransactionsPanel`. Enables the learning loop. Requires justified schema.
- **Slice 5 — Space overrides:** only if explicitly approved; separate store from visibility (`SpaceAccountLink`).

## 10. Validation & rollback plan (applies to whichever slice is approved)

**Validation:**
- `npx prisma generate` (only if a schema slice); `npx prisma migrate dev` for schema slices only.
- `npx tsc --noEmit`; `npm run lint`.
- Unit tests for the pure resolver (extend the existing `merchant.test.ts` / `plaid-category.test.ts` style; run under `tsx`, no DB). Assert every §6 merchant maps to its intended category, and assert **no unintended merges** (the conservative-merge invariant already tested in `merchant.test.ts`).
- Precedence tests: PFC-good merchants unchanged; merchant rule wins only where intended; FlowType output unchanged except via category (compare against the FlowType equivalence harness).
- For backfill: dry-run diff report (counts per category before/after) reviewed before any write; idempotency check (second run = zero changes).
- Targeted UI check: Transactions page shows corrected categories, no regressions in filtering/search.

**Rollback:**
- Pure module slices: revert the module + single call site; no data written, so nothing to undo.
- Backfill: write a reverse map or snapshot pre-values (or gate behind `classifierVersion`-style column) so rows can be restored; run backfill inside a batch that can be reverted.
- Schema slices: standard down-migration; keep changes additive (nullable columns / new table) so rollback never drops live data. Legacy tables/columns untouched.

---

## Appendix — key file references

- `lib/transactions/merchant.ts` — canonical name/key normalizer (formatting only; AI-only consumer).
- `lib/transactions/fingerprint.ts` — `normalizeMerchantKey` dedup normalizer (different function).
- `lib/transactions/plaid-category.ts` — `mapPlaidCategory` + 10-brand subscription allowlist.
- `lib/transactions/flow-classifier.ts` — FlowType authority (category/sign/PFC driven).
- `lib/plaid/syncTransactions.ts` (~L216–242) — write path; stores raw merchant + PFC category.
- `lib/ai/assemblers/transactions.ts` — sole consumer of `normalizeMerchant`.
- `components/dashboard/widgets/SpaceTransactionsPanel.tsx` — renders raw `tx.merchant` / `tx.category`; no edit affordance.
- `prisma/schema.prisma` — `Transaction.merchantEntityId` (written, never read), `TransactionCategory` enum (no Medical/Education/Auto/Transport), no `MerchantRule`, no override columns.
