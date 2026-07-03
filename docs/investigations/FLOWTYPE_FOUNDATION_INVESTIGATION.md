> **INVESTIGATION ONLY — no code, schema, migration, or UI changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# FlowType Foundation Investigation (Transaction Semantics Layer)

**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Baseline:** v2.5 (v2.4.5 tagged; KD-17 + KD-18 guardrail committed `3988510`)
**Initiative:** v2.5.5 Financial Intelligence — Transaction Semantics
**Status:** Investigation complete — design recommendation only. No implementation.
**Scope guard:** Financial semantics only. No Atlas, Liquid, Brief, SpaceDashboard, or visual-component work. No UI. No charts. No code.

**Supersedes-by-consolidation (does not contradict):**
- `docs/investigations/TRANSACTION_FLOW_CLASSIFICATION_INVESTIGATION.md` (flowType kind — Option C ratified)
- `docs/investigations/DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md` (KD-18 destination capability — folded in as a hard requirement)
- `docs/investigations/TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` (only the one overlapping field, `personal_finance_category.detailed`, is in scope here)

---

## 1. Executive summary

The transaction table carries one classification field, `category: TransactionCategory` (`schema.prisma:28-46, 1136`), and it is asked to answer two orthogonal questions at once: *what economic kind of movement is this* and *what merchant/spend bucket is this*. Because a row holds one value, `Transfer`, `Payment`, `Income`, `Interest`, `Fee`, and the investment values crowd out true spend taxonomy, refunds have no representation, and the direction of a movement is inferred everywhere from the sign of `amount`. Every consumer re-derives economic meaning inline, and they disagree — at least four independent, drifting definitions of "spending" exist in the code (AI assembler, assessment engine, Banking UI, data layer).

Two of those drifts have already been patched as honesty defects rather than fixed at the root: **KD-17** made category rollups debit-only against a checked `expenseTotal` invariant, and **KD-18** added a guardrail forbidding the AI from inventing per-card debt-payment attribution — because the pipeline discards account identity at the summary select (`lib/ai/assemblers/transactions.ts:235-241`) and holds no destination dimension. Both are prose/aggregation band-aids over a missing data model.

**Recommendation.** Introduce a single deterministic transaction-semantics layer, persisted additively on `Transaction`, built from three orthogonal fields — not one:

1. **`flowType`** (enum) — the economic *kind* of movement.
2. **`flowDirection`** (enum) — the economic *direction* (inflow / outflow / internal), decoupled from the per-account `amount` sign.
3. **`counterpartyAccountId`** (nullable FK → `FinancialAccount`) — the *other side* of the movement when it is a known owned account. This is the field that makes **destination-aware debt-payment attribution** deterministic and closes the KD-18 capability gap, without full double-entry pair-linking.

A single **classifier module** is the source of truth; it runs at sync/import/manual-write time and its output is persisted, queryable, and re-runnable for backfill. All read-time consumers stop re-deriving flow and read the stored fields. This is additive, reversible, and does not touch `TransactionCategory`, any existing query, or MC1 (multi-currency) row-level currency fields planned later.

**The one non-negotiable carried from KD-18:** the model must carry **destination, not just kind**. `flowType = DEBT_PAYMENT` alone rebuilds the exact gap KD-18 papered over. The per-liability rollup must be expressible as a deterministic query, which requires either the row's own account (destination-side leg) or `counterpartyAccountId` (source-side leg).

---

## 2. Current architecture — where transaction meaning is inferred ad hoc

### 2.1 The stored model

`Transaction` (`schema.prisma:1125-1168`) stores: `id`, `accountId?` / `financialAccountId?` (exactly one set; normalized on read), `date`, `merchant`, `description?`, `category`, `amount: Float`, `pending`, `plaidTransactionId?`, `importBatchId?`, `externalTransactionId?`, `deletedAt?`, timestamps.

Sign convention is a **comment, not a constraint**: positive = money in, negative = money out (`schema.prisma:1114`). There is no `flowType`, no `flowDirection`, no counterparty reference, no currency column. Indexes exist on `accountId`, `[accountId,date]`, `financialAccountId`, `[financialAccountId,date]`, `date`, `importBatchId` (`:1162-1167`).

`TransactionCategory` (16 values, `:28-46`) is three dimensions wearing one hat:

| Real dimension | Values | Problem |
|---|---|---|
| Economic flow kind | `Income, Transfer, Payment, Interest, Fee`, + investment `Buy/Sell/Dividend/Split/Fee` | These are flows, not spend buckets; they occupy slots that then can't describe a merchant. |
| Merchant / spend taxonomy | `Groceries, Dining, Shopping, Travel, Subscriptions, Utilities, Other` | The only genuine "categories"; implicitly assume the flow is discretionary spend. |
| Missing | (no `Refund`; no transfer sub-kinds; no destination) | Refunds fall through to `Other`; internal transfer vs card payment vs brokerage funding all collapse to `Transfer`. |

### 2.2 Every site that infers meaning ad hoc (investigation task 7)

1. **Plaid import — lossy at the door.** `mapPlaidCategory` (`lib/plaid/syncTransactions.ts:97-135`) collapses Plaid's `personal_finance_category` into the 16 values. **`TRANSFER_IN` and `TRANSFER_OUT` both become `Transfer`** (`:110-111`) — direction discarded. `LOAN_PAYMENTS → Payment` (`:112`), `BANK_FEES → Fee` (`:113`). `personal_finance_category.detailed` (which distinguishes account transfer vs. brokerage funding vs. credit-card payment) is read and thrown away. The sign is flipped here (`:220`): FM stores `-txn.amount`. Only 6 fields + 1 derived enum are persisted; `account_id` is used to resolve the row's own account but the *counterparty* is never captured.

2. **AI transaction assembler — the most-correct, still-inline definition.** `lib/ai/assemblers/transactions.ts` maintains private sets `INCOME_CATEGORIES` (`:98-101`), `MERCHANT_EXCLUDED_CATEGORIES` (`:110-115`), `SPENDING_CATEGORIES` (`:124-126`), and partitions by `category` + `amount` sign (`:282-315`): `Transfer` → `transferTotal`; `Payment && amount<0` → `debtPaymentTotal`; `INCOME_CATEGORIES && amount>0` → `incomeTotal`; any other `amount<0` → `expenseTotal`. `netCashFlow = incomeTotal − expenseTotal − debtPaymentTotal` (`:317`). The select fetches only `date, merchant, category, amount, pending` (`:235-241`) — **account identity is discarded**, which is the mechanical root of KD-18.

3. **AI assessment engine — a fourth definition.** `lib/ai/intelligence/annotations.ts:755`: `SPENDING_EXCLUDED = {Income, Interest, Transfer, Payment}`, plus its own discretionary/fixed sub-classing (`:757-767`).

4. **Data layer — a hard-coded category list.** `lib/data/transactions.ts:48-51` defines `BANKING_CATEGORIES` (11 values, **omits `Fee`**); `getInvestmentTransactions` filters `Buy/Sell/Dividend/Split/Fee` (`:133`). So security-level investment activity is firewalled from banking reads — but the *cash leg* funding a brokerage still lands in banking as `Transfer`.

5. **Banking UI — the genuine correctness bug.** `components/dashboard/BankingClient.tsx:162-165`: `totalSpend` correctly excludes `Payment`/`Transfer`, but `totalCredit = filteredTxs.filter(t => t.amount > 0).reduce(...)` — **every positive row summed as "In,"** so transfers-in, refunds, and investment-sale proceeds inflate the headline. Duplicated in `SpaceTransactionsPanel.tsx`.

**Orphaned enum values (KD-17 side-findings, still open):** `Fee` is mapped by Plaid but absent from both `BANKING_CATEGORIES` lists → `Fee` rows are invisible to banking reads and the AI assembler query (`category: { in: BANKING_CATEGORIES }`, `assemblers/transactions.ts:231`). `Groceries` is unreachable from `mapPlaidCategory` (no branch emits it). These are symptoms of the same conflation and should be resolved when `flowType` owns the flow dimension.

### 2.3 The KD-18 destination fact (the crux)

Every card payment is **two rows** (`DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md §2`):

| Leg | Shape | Destination attribution |
|---|---|---|
| Source (checking) | `amount<0`, `category=Payment`, on the checking account | Source known (own account). **Destination NOT on the row** — only inferable from merchant string. Deterministic attribution impossible without pair-linking. |
| Destination (card) | `amount>0`, on the **card's own `financialAccountId`**, `debtSubtype != null` | **Destination deterministically known today** — it is the row's own account. |

So "how much did I pay toward each card" is answerable **from the destination-side credit legs**, which already sit on the correct account — the pipeline just never selects `financialAccountId` into a rollup, and Plaid's inconsistent tagging (KD-17 Caveat A: Jan 2026 had $4,000 of card-side payment credits tagged `Payment` and $9,500 tagged `Other`) corrupts a category-based selector. A robust selector is `amount>0 AND account.debtSubtype != null AND flowType = DEBT_PAYMENT`.

---

## 3. Proposed enums

### 3.1 `flowType` — the economic kind (canonical)

```
enum FlowType {
  SPENDING       // discretionary/non-discretionary consumption (outflow, real cost)
  INCOME         // earnings: payroll, dividends received, interest earned that is income
  REFUND         // reversal of a prior SPENDING — reduces spend, is NOT income
  DEBT_PAYMENT   // liability reduction (card payment, loan principal) — not spend
  TRANSFER       // movement between accounts (owned or external) — not spend, not income
  INVESTMENT     // asset conversion / security activity — feeds net worth, not spend/income
  FEE            // bank/card/service fee — a real cost, kept distinct from SPENDING
  INTEREST       // interest charged (cost) or the interest-cost leg of a debt payment
  ADJUSTMENT     // balance corrections, provider artifacts, reconciled non-economic rows
  UNKNOWN        // classifier could not decide with acceptable confidence — never forced
}
```

Design notes and the doctrine behind each value are in §5. Two deliberate choices:

- **No `TRANSFER_IN`/`TRANSFER_OUT` or `CREDIT_CARD_PAYMENT` split.** Direction is carried by `flowDirection` (§3.2), and "which liability" is carried by `counterpartyAccountId` (§3.3) / the row's own account. Baking direction and destination into the kind enum is what forced today's re-derivation and would re-explode the enum. Card payment stays `DEBT_PAYMENT`.
- **`UNKNOWN` and `ADJUSTMENT` are honesty valves.** The classifier must never be forced to emit a confident wrong value. `UNKNOWN` preserves the KD-18 posture in data form: an unclassifiable row is explicitly unclassified, not silently misfiled into `SPENDING`.

### 3.2 `flowDirection` — the economic direction (do we need it separate? **Yes**)

```
enum FlowDirection {
  INFLOW     // money entering the user's world from outside (income, refund, external transfer-in)
  OUTFLOW    // money leaving the user's world (spending, fee, external transfer-out)
  INTERNAL   // both endpoints are the user's own accounts (owned-to-owned transfer, card payment)
  UNKNOWN
}
```

**Why separate from the `amount` sign.** The per-account sign already tells you in/out *relative to one account*. It does **not** tell you in/out *relative to the user's whole world*, which is what cash-flow honesty needs:

- An internal transfer is `−X` on checking and `+X` on savings. Both are `TRANSFER`; sign says "one out, one in," but the correct external-world answer is **neither** — `flowDirection = INTERNAL` on both legs lets a net-external-cash-flow query exclude them by a single predicate instead of the fragile "sum positives vs negatives and hope they cancel" that fails under `Float` (STATUS §6).
- A `REFUND` is `amount>0` like income, but `flowDirection = INFLOW` with `flowType = REFUND` keeps it out of income while still marking it as money-in.
- A debt-payment source leg is `amount<0` / `flowType=DEBT_PAYMENT` / `flowDirection=INTERNAL` (paying your own card is not money leaving your world); the interest portion, when separable, is the only genuinely `OUTFLOW` part.

`flowDirection` is derivable from `flowType` + sign + whether the counterparty is owned, but persisting it makes "money in vs out of my world" a single indexed predicate and records the classifier's *intent* (internal vs external) at write time, when the counterparty context is freshest. It is the axis the Banking `totalCredit` bug needs and cannot express today.

### 3.3 `counterpartyAccountId` — source/destination attribution (do we need it? **Yes, nullable, best-effort**)

A nullable self-relation FK on `Transaction` → `FinancialAccount`, meaning "the owned account on the *other* side of this movement, when known." Combined with the row's own account and `flowDirection`, this expresses source→destination without full double-entry:

- **Debt-payment destination leg** (card-side credit): the row's own account *is* the destination; `counterpartyAccountId` optionally points back to the funding checking account. Per-card rollup = group these by `financialAccountId`. **This is the deterministic KD-18 capability.**
- **Debt-payment source leg** (checking-side debit): `counterpartyAccountId` points to the card when resolvable (deterministic only if the two legs are paired or the card is uniquely inferable; otherwise null → honestly unknown).
- **Internal transfer**: each leg's `counterpartyAccountId` points to the other owned account; enables "how much did I move to savings vs. brokerage."

It is explicitly **best-effort and nullable** — never a hard link, never required. Full transfer-leg *pairing* (correlating the two legs into one logical object, tolerant of date skew and fees) remains deferred (Option F below); `counterpartyAccountId` is the thin, additive down-payment on it that already unlocks the destination-side rollups the product needs.

---

## 4. Proposed schema additions (design reference — not for merge)

All additive, all nullable, no existing column touched.

```prisma
model Transaction {
  // ... existing fields unchanged ...

  flowType             FlowType?       // classifier output — economic kind
  flowDirection        FlowDirection?  // classifier output — in / out / internal
  flowConfidence       Float?          // 0..1; low values gate UNKNOWN + AI honesty disclosures
  counterpartyAccountId String?        // best-effort "other side" (owned account)
  counterpartyAccount   FinancialAccount? @relation("TransactionCounterparty", fields: [counterpartyAccountId], references: [id], onDelete: SetNull)

  // Optional seam, reserved now so pair-linking later is additive, not a re-migration:
  // transferGroupId    String?        // links the two legs of one logical transfer (Option F, deferred)

  // Import-fidelity field this initiative also needs captured going forward
  // (overlaps the metadata-depth investigation — the one field worth taking now):
  pfcDetailed          String?         // Plaid personal_finance_category.detailed, raw

  @@index([financialAccountId, flowType, date])   // per-account / per-liability rollups
  @@index([flowType, date])                        // global per-flow lenses
  @@index([counterpartyAccountId])                 // reverse attribution lookups
}
```

`FinancialAccount` gains the reverse relation `counterpartyTransactions Transaction[] @relation("TransactionCounterparty")` (relation-only, no column).

**Why on `Transaction` and not a provider-detail table.** `flowType`/`flowDirection` describe the *financial nature* of the movement, exactly like `category` and `amount` already do — provider-agnostic. This satisfies the freeze doc's rule that canonical tables carry the financial fact, not provider mechanics (`PHASE_2_ARCHITECTURE_FREEZE.md §13`), and its intent that anything summed/sorted/filtered must not hide in an un-indexable shape (`§7`). `pfcDetailed` is the single Plaid-shaped string the classifier consumes; it is a raw taxonomy hint, deny-list-clean (no PII), and is the one field the metadata-depth investigation flagged as worth capturing at first opportunity.

**MC1 non-conflict.** No currency field is proposed here. `flowType`/`flowDirection`/`counterpartyAccountId` are currency-agnostic; a future row-level `isoCurrencyCode` (MC1) is orthogonal and additive alongside them. Nothing in this design assumes single-currency amounts or blocks per-row currency later.

---

## 5. Classification doctrine

The classifier is a pure, deterministic function:

```
classifyFlow({ category, amount, pfcPrimary, pfcDetailed, ownAccountType, counterpartyAccountType? })
  → { flowType, flowDirection, flowConfidence }
```

Precedence: **provider taxonomy (Plaid `pfcDetailed` → `pfcPrimary`) first, then account-type context, then `category`, then sign.** CSV/manual rows skip the first step and use category + sign + account type.

### 5.1 Sign rules (explicit — these were only ever comments before)

- Canonical sign stays: **positive = into the row's own account, negative = out of it.** Unchanged; `flowType`/`flowDirection` are added alongside, sign is never rewritten.
- `flowDirection` is **not** `sign(amount)`. It is: `INTERNAL` if the counterparty is an owned account (transfers, card payments); otherwise `INFLOW` for `amount>0`, `OUTFLOW` for `amount<0`, for economically-external flows.
- Category rollups remain **debit-only** (`amount<0`) per KD-17, now expressed as `flowType=SPENDING` (which is outflow by construction) rather than "category minus an exclusion set." The KD-17 checked invariant (`Σ SPENDING ≤ expenseTotal`) survives and becomes *stronger*: `expenseTotal := Σ|amount| WHERE flowType=SPENDING`, so the two sides are the same population by definition.

### 5.2 Per-flow doctrine

- **SPENDING** — consumption; `OUTFLOW`; the only thing budgets and spend analytics count. Refunds net against it (§ REFUND).
- **INCOME** — earnings; `INFLOW`. Includes payroll and, by doctrine decision, **dividends received** (real, taxable income) even though the security row also carries `category=Dividend`. Interest *earned* is INCOME; interest *charged* is INTEREST — disambiguated by account type (interest on a debt account = cost).
- **REFUND** — `INFLOW`, but **never INCOME**. Reverses SPENDING in its original `category`. This is the field the Banking `totalCredit` bug needs: a refund is money-in that must not read as income. (Chargebacks/reversals of a prior charge → REFUND. A statement credit that is genuinely cashback/rewards → INCOME or REFUND per provider signal; default REFUND, low confidence.)
- **DEBT_PAYMENT** — liability reduction; `INTERNAL` (paying your own card moves money within your world). Not spending — the spend already happened when the card was charged; counting a payment as spend is the classic double-count. Destination = the liability account (own account on the destination leg, `counterpartyAccountId` on the source leg). **Principal/interest split is NOT attempted** (insufficient Plaid signal — `LOAN_PAYMENTS` does not decompose; interest usually arrives as its own row → INTEREST). Deferred.
- **TRANSFER** — movement between accounts. `INTERNAL` when both endpoints owned; `INFLOW`/`OUTFLOW` when one endpoint is external and unresolvable. Never spend, never income. Plaid `TRANSFER_IN`/`TRANSFER_OUT` + `pfcDetailed` recover the sub-kind that `mapPlaidCategory` currently discards.
- **INVESTMENT** — asset conversion. The security-level `Buy/Sell/Dividend/Split/Fee` rows and the cash leg funding a brokerage both → `flowType=INVESTMENT` (except dividends received → INCOME by the doctrine above). Feeds net worth via `Holding`, never the spend/income ledger. `category` retains the buy/sell/dividend sub-signal.
- **FEE / INTEREST** — real economic costs, `OUTFLOW`, kept distinct from SPENDING so cost analysis and future tax categorization can select them directly.
- **ADJUSTMENT** — balance corrections, provider artifacts (the "provider metadata artifacts" the goal statement calls out), reconciled non-economic rows. Excluded from every economic total.
- **UNKNOWN** — confidence below threshold. Excluded from confident totals; surfaced to the AI honesty layer as an explicitly-unclassified population rather than being absorbed into SPENDING.

### 5.3 Category rollup correctness

`TransactionCategory` is **kept and unchanged** (additive-before-subtractive; investment values still drive `getInvestmentTransactions`). Post-cutover it becomes a pure *spend/merchant* taxonomy that is only meaningful when `flowType=SPENDING|REFUND`; the flow values (`Income/Transfer/Payment/Interest/Fee`) become legacy shadows of `flowType` and can be steered toward retirement later, out of scope here. `Fee` reachability and `Groceries` mapper gaps (KD-17 side-findings) are resolved as part of the classifier rewrite, not before.

---

## 6. What is computed at write time vs read time

| Concern | When | Where |
|---|---|---|
| `flowType`, `flowDirection`, `flowConfidence` | **Write** (sync/import/manual) | classifier module, persisted on the row |
| `counterpartyAccountId` (deterministic: destination-leg own account) | **Write** | classifier, from row's own account + type |
| `counterpartyAccountId` (heuristic: source-leg → card) | **Write, best-effort** | classifier; null when unresolvable |
| `pfcDetailed` capture | **Write** | `mapPlaidCategory` stops discarding it |
| Per-flow totals, `netCashFlow`, per-liability rollup, per-account income/spend | **Read** | assemblers/UI, filtering the stored fields |

Doctrine: **classify once at write, aggregate at read.** The classifier is the single source of truth; rollups are cheap `WHERE flowType = … GROUP BY financialAccountId` queries over indexed columns. This matches how `category`/`amount` are stored facts, not read-time derivations.

---

## 7. Migration plan

Additive, staged, each stage gated by its own impact map + rollback + validation checklist per project rules. Nothing below is authorized to merge from this document.

1. **Classifier module (no schema).** Extract one deterministic `classifyFlow(...)`; route the four inline definitions (§2.2) through it. Ends the drift and fixes the Banking `totalCredit` bug as a defect, before any column exists. Both paths agree before persistence lands.
2. **Import fidelity (bounded).** `mapPlaidCategory` stops discarding `personal_finance_category.detailed`; capture `pfcDetailed`. Forward rows become richly classifiable.
3. **Additive migration.** One migration (`YYYYMMDDHHMMSS_v255_flowtype_foundation`, following the existing `20260703120000_*` convention): add `FlowType` + `FlowDirection` enums; add nullable `flowType`, `flowDirection`, `flowConfidence`, `counterpartyAccountId`, `pfcDetailed`; add the three indexes; add the counterparty relation. No existing column altered. Reserve `transferGroupId` decision for the pair-linking stage (still additive later).
4. **Backfill (separate re-runnable script, not in the migration).** See §8.
5. **Read cutover.** Point the AI assembler, assessment engine, data layer, and Banking/Space UI at the stored fields; delete the scattered constants. Add the per-liability rollup (`byLiability`) and relax the KD-18 guardrail *only* for the dimension now backed by data.
6. **Validator reconciliation + new lenses (later).** Give the AI-4 output validator the canonical ledger to reconcile against; per-flow surfaces are built in the v2.5 design language (out of scope here).

**Rollback:** drop the columns/enums/indexes. No data loss — `category`, `amount`, provider lineage untouched. `TransactionCategory` and every current query keep working throughout.

---

## 8. Backfill plan — what is safe, what stays unknown

| Field | Backfill source | Safety |
|---|---|---|
| `flowType` (coarse) | `(category, sign, account type)` | **Safe, idempotent, re-runnable.** Deterministic pure function; `ADJUSTMENT`/`UNKNOWN` absorb genuine ambiguity. |
| `flowType` (fine, e.g. transfer sub-kind) | needs `pfcDetailed` | **Forward-only.** Historical rows never stored `detailed`; they backfill to coarse `TRANSFER`/`ADJUSTMENT`. Re-fetch from Plaid is a separate, later decision (cursor model resists it; interacts with KD-7 5,000-row cap). |
| `flowDirection` | `flowType` + sign + counterparty ownership | **Safe** where counterparty resolvable; `UNKNOWN` otherwise. |
| `counterpartyAccountId` (destination-side debt/transfer leg) | row's own account is already the destination | **No backfill needed** — deterministic at read time; the attribution was never actually missing from the DB, only from the rollup. |
| `counterpartyAccountId` (source-side leg) | merchant-string / uniqueness heuristic | **Best-effort, low confidence, nullable.** Left null when ambiguous — honest unknown, never guessed into a confident value. |

**Idempotence requirement:** backfill re-runs must converge — running twice yields identical output. `flowConfidence` records how sure the classifier was, so a later, better classifier can safely re-classify only the low-confidence population.

**What remains legitimately unknown (and must stay so):**
- Which specific card a *source-side* payment leg satisfied, absent pair-linking.
- Principal vs. interest inside a debt payment.
- Internal vs. external for a transfer whose counterparty is not an owned account.
- Multi-currency normalization (MC1).
These are surfaced as `UNKNOWN`/null + the existing KD-18 attribution disclosure, not fabricated.

---

## 9. Risk analysis

- **Backfill misclassification.** Historical rows without `detailed` backfill coarsely. *Mitigation:* deterministic + re-runnable; `flowConfidence` gates re-classification; `ADJUSTMENT`/`UNKNOWN` absorb ambiguity.
- **Double-count between the two debt-payment views.** Source-side `debtPaymentTotal` (checking debits) and the new destination-side per-card rollup (card credits) measure the same flow from opposite ends and **will not reconcile exactly** (timing skew, external-account payments, one leg not visible) — `DEBT_PAYMENT_ATTRIBUTION §2 Caveat B`. *Mitigation:* pick destination-side as the canonical per-card view; never sum both; document the semantic in the assembler; test the invariant.
- **KD-17 regression.** The debit-only category invariant must survive the rewrite. *Mitigation:* `expenseTotal := Σ|amount| WHERE flowType=SPENDING` makes the invariant hold by construction; keep `transactions.kd17.test.ts` green.
- **KD-18 relaxation risk.** Relaxing the guardrail before the rollup is proven re-invites fabrication. *Mitigation:* relax only for dimensions with a backing deterministic rollup; keep the generalized disclosure for all still-unbacked dimensions (transfers, per-card interest, per-account income).
- **`Float` money.** Pre-existing (STATUS §6). Internal transfers won't cancel to exactly zero under `Float`. *Mitigation:* `flowDirection=INTERNAL` predicate excludes them structurally instead of relying on sign-cancellation; tolerance-based reconciliation; not made worse here.
- **Enum churn.** Premature value set risks an additive bump. *Mitigation:* Postgres enum values are additive; start with §3.1 and grow.
- **PII surface.** `counterpartyAccountId` is an internal FK (no external identifiers); `pfcDetailed` is a taxonomy string, deny-list-clean. No new PII beyond the metadata-depth investigation's separate scope. The classifier and rollups run behind the same `TRANSACTION_DETAIL_VISIBILITY` (FULL-only) gate; `counterpartyAccountId` must be redaction-checked so a shared Space cannot learn about an owned account it can't see.
- **Scope creep toward double-entry.** *Mitigation:* pair-linking / `transferGroupId` explicitly deferred (§10).

---

## 10. Implementation phases (recommendation only — not a checklist)

Mirrors §7, framed as value increments; each needs its own checklist-first approval:

1. **P1 — Shared classifier + Banking income defect fix.** Pure function, no schema. Highest-value, lowest-risk; kills the drift and the `totalCredit` bug.
2. **P2 — Import fidelity.** Capture `pfcDetailed`; stop discarding transfer/loan subtypes.
3. **P3 — Persist flow fields + indexes.** The additive migration.
4. **P4 — Backfill.** Re-runnable script; coarse now, forward-rich.
5. **P5 — Read cutover + per-liability rollup + KD-18 relaxation** for the newly-backed dimension.
6. **P6 (deferred) — Pair-linking / double-entry (Option F)**, principal-interest split, internal-vs-external transfer typing, source-side attribution, MC1 currency. Recorded, not built.

---

## 11. Validation checklist (for whichever phase is later approved)

Standard project gates: `npx prisma generate` · `npx prisma migrate dev` (schema stages only) · `npx tsc --noEmit` · `npm run lint` · targeted route/UI testing.

Plus semantics-specific tests (investigation task: "what tests are required"):

- **Classifier unit tests** — every Plaid PFC primary+detailed → `(flowType, flowDirection)`; sign rules; CSV heuristic path; manual-entry path; low-confidence → `UNKNOWN`.
- **Backfill idempotence** — running twice yields identical rows; low-confidence re-classification is safe.
- **Invariants** — `netCashFlow = INCOME − SPENDING − FEE − INTEREST` with `TRANSFER/DEBT_PAYMENT/INVESTMENT/ADJUSTMENT` excluded; `REFUND` nets against `SPENDING` in-category, never into `INCOME`; KD-17 `Σ SPENDING ≤ expenseTotal` still checked and now equal-by-construction.
- **Per-liability rollup correctness** — destination-side card-credit legs group to the right `financialAccountId`; the observed KD-18 failure case (100%/0% split) is now deterministic; double-count guard asserts source-side and destination-side are never summed together.
- **Direction correctness** — internal transfer legs both carry `flowDirection=INTERNAL` and are excluded from external cash flow even when `Float` sums don't cancel.
- **Regression** — KD-1/KD-15 privacy suites green; AI-4 validator suite green; KD-17/KD-18 suites green; `counterpartyAccountId` respects `TRANSACTION_DETAIL_VISIBILITY` redaction.
- **Null-tolerance** — reads behave correctly against un-backfilled (`flowType = null`) rows during the dual-read window.

---

## 12. Existing code paths that change later (investigation task 13)

| Path | Change |
|---|---|
| `lib/plaid/syncTransactions.ts` (`mapPlaidCategory`, `:97-135,220`) | Emit `flowType`/`flowDirection`/`counterpartyAccountId`; capture `pfcDetailed`; stop discarding transfer/loan subtypes. |
| `lib/imports/csv.ts` (`normalizeRow`, `mapCategory`, `:462-501`) | Emit flow fields via the heuristic classifier path. |
| `lib/imports/excel.ts` / manual-entry route | Same classifier call. |
| `lib/ai/assemblers/transactions.ts` (`:98-126, 235-241, 282-317`) | Replace `INCOME_CATEGORIES`/`MERCHANT_EXCLUDED`/`SPENDING_CATEGORIES` and the sign partition with `flowType` reads; **select `financialAccountId`**; add `byLiability` rollup. |
| `lib/ai/intelligence/annotations.ts` (`:755`) | Replace `SPENDING_EXCLUDED` with `flowType` reads. |
| `lib/data/transactions.ts` (`:48-51, 133`) | `BANKING_CATEGORIES`/investment split become `flowType` filters; resolves the `Fee` orphan. |
| `components/dashboard/BankingClient.tsx` (`:162-165`), `SpaceTransactionsPanel.tsx` | `totalCredit` reads `flowType=INCOME` (+`REFUND` netting), not "all positives." (UI change — out of this thread's scope; noted for the design thread.) |
| `lib/ai/output-validator.ts` | Gains the canonical flow ledger as a reconciliation target (moves toward provenance, not just membership). |
| `app/api/ai/chat/route.ts` (KD-18 guardrail, `:581`, `ATTRIBUTION_DISCLOSURE`/`ATTRIBUTION_RULE`) | Relax for per-liability debt payments once the rollup exists; keep generalized disclosure for still-unbacked dimensions. |

---

## 13. Direct answers to the investigation questions

- **Canonical `flowType` enum?** `SPENDING, INCOME, REFUND, DEBT_PAYMENT, TRANSFER, INVESTMENT, FEE, INTEREST, ADJUSTMENT, UNKNOWN` (§3.1).
- **`flowDirection` separate from `flowType`?** **Yes** — `INFLOW/OUTFLOW/INTERNAL/UNKNOWN`; it carries the money-in/out-of-my-world axis that the per-account sign cannot, and marks internal transfers for structural exclusion (§3.2).
- **Source/destination account references?** **Yes** — a nullable best-effort `counterpartyAccountId` FK; the row's own account is the "self" side, direction says which end it is. This is the KD-18 destination requirement in data form (§3.3).
- **Debt payments represented how?** `flowType=DEBT_PAYMENT`, `flowDirection=INTERNAL`; per-card attribution from destination-side credit legs (own account) + `counterpartyAccountId` on source legs. No principal/interest split now (§5.2).
- **Transfers?** `flowType=TRANSFER`; `INTERNAL` when both endpoints owned, else external in/out; never spend or income; `counterpartyAccountId` for owned counterparties (§5.2).
- **Investments?** `flowType=INVESTMENT` for security activity and brokerage-funding cash legs; dividends received → `INCOME`; feeds net worth via `Holding`, never spend/income (§5.2).
- **Refunds/reversals/credits?** `flowType=REFUND`, `flowDirection=INFLOW`, nets against SPENDING in-category, **never INCOME** — this fixes the Banking `totalCredit` bug (§5.2).
- **Write-time vs read-time?** Classify + persist at write; aggregate at read (§6).
- **Safely backfillable?** Coarse `flowType`/`flowDirection` deterministically; destination-side attribution needs no backfill (already on the row); fine subtypes are forward-only (§8).
- **Stays unknown?** Source-side card attribution without pairing, principal/interest, internal-vs-external for unresolved counterparties, MC1 currency — held as `UNKNOWN`/null, never fabricated (§8).
- **Indexes?** `[financialAccountId, flowType, date]`, `[flowType, date]`, `[counterpartyAccountId]` (§4).
- **Migrations?** One additive migration (enums + nullable columns + indexes + relation); backfill as a separate re-runnable script (§7).
- **Tests?** Classifier, backfill idempotence, invariants, per-liability rollup + double-count guard, direction, privacy/KD regression, null-tolerance (§11).
- **Code paths changing later?** §12.

---

## 14. Evidence index

| Claim | Source |
|---|---|
| Transaction model, sign-as-comment, indexes | `prisma/schema.prisma:1113-1168` |
| 16-value category conflates flow + spend | `prisma/schema.prisma:28-46` |
| Plaid mapping lossy (`TRANSFER_IN/OUT → Transfer`, drops `detailed`), sign flip | `lib/plaid/syncTransactions.ts:97-135, 220` |
| Summary select discards account identity (KD-18 root) | `lib/ai/assemblers/transactions.ts:235-241` |
| AI assembler private flow definitions + `netCashFlow` | `lib/ai/assemblers/transactions.ts:98-126, 282-317` |
| KD-17 debit-only category invariant | `lib/ai/assemblers/transactions.ts:274-315, 668-705` |
| Fourth inline definition (`SPENDING_EXCLUDED`) | `lib/ai/intelligence/annotations.ts:755` |
| Data-layer category lists; `Fee` orphaned; investment firewall | `lib/data/transactions.ts:48-51, 133` |
| Banking income = naive positive-sum bug | `components/dashboard/BankingClient.tsx:162-165` |
| CSV normalization + sign convention | `lib/imports/csv.ts:462-501` |
| Destination attribution exists on card-side legs | `DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md §2`; `schema.prisma:747` (`debtSubtype`) |
| flowType must carry destination or KD-18 rebuilds | `STATUS.md:149` |
| KD-17 / KD-18 status (guardrail only, capability → v2.5.5) | `STATUS.md:202-203` |
| Additive-before-subtractive; canonical tables carry financial fact | `PHASE_2_ARCHITECTURE_FREEZE.md §7, §13, §15` |
| MC1 multi-currency is future, row-level currency additive | `MULTI_CURRENCY_ARCHITECTURE_INVESTIGATION.md` |
