> **INVESTIGATION ONLY — no code, schema, migration, or UI changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Transaction Flow Classification Investigation

**Date:** 2026-07-02
**Branch:** `feature/phase-2-architecture`
**Baseline:** v2.4.0 (D11 complete; D3 SAL dual-write live; AI-4 shadow validator landed)
**Status:** Investigation complete — recommendation only, no implementation

---

## 1. Executive summary

Fourth Meridian's transaction history mixes fundamentally different kinds of money movement into one undifferentiated feed, then lets each consumer decide for itself what counts as "spending" or "income." The result is that headline aggregates can imply money that does not exist — the reported example (Income +$629,918 / Spend −$209,573 implying ~$420k unaccounted) is a direct symptom, not a display glitch.

The core defect is not the `TransactionCategory` enum being too small. It is that **the enum tries to answer two orthogonal questions with one field**: *what economic kind of flow is this* (spending, income, internal transfer, debt payment, investment, fee, interest, refund) and *what merchant/spending bucket is this* (Groceries, Dining, Travel…). A row can only carry one value, so `Transfer`, `Payment`, `Interest`, `Income`, and the investment values (`Buy/Sell/Dividend/Split/Fee`) crowd out true spending taxonomy, refunds have no representation at all, and internal transfers, credit-card payments, and investment funding are all collapsed into the single value `Transfer`.

Because the flow dimension is not modeled, every consumer re-derives it inline — and they **disagree**. The AI assembler correctly excludes transfers, debt payments, and inflows from spending and computes a real `netCashFlow`; the Banking page correctly excludes `Payment`/`Transfer` from *spend* but then sums **every** positive-amount row into "income," which is exactly where transfers-in, refunds, and investment-sale proceeds inflate the top-line number. There are at least four independent, drifting implementations of "what is spending."

**Recommendation:** introduce a single deterministic **flow classifier** as the source of truth, and persist its output as an **additive, normalized `flowType` field on `Transaction`**, alongside — not replacing — the existing `category`. This is the smallest change that (a) makes every surface agree, (b) removes ~four copies of ad-hoc derivation, (c) gives the AI-4 output validator a single reconcilable ledger, and (d) unlocks Spending / Income / Transfer / Investment / Debt / Capital-Flow views as one-field filters. It is additive and low-risk, but it is **new capability, not stabilization**, so it belongs in **v2.5** (behind the D3 read-cutover), with one carve-out: the naive "sum of all positives = income" behavior on the Banking page is a genuine correctness bug and should be treated as a defect regardless of when the larger model lands.

---

## 2. Current architecture assessment

### 2.1 The data model

`Transaction` (`prisma/schema.prisma:1168–1211`) stores one row per movement with:

- `amount: Float` — sign convention **positive = money in, negative = money out** (comment at `schema.prisma:1157`; the Plaid sign flip is applied at `lib/plaid/syncTransactions.ts:218–220`).
- `category: TransactionCategory` — the only classification field.
- `merchant`, `description`, `date`, `pending`, plus provider/import lineage (`plaidTransactionId`, `importBatchId`, `externalTransactionId`) and a soft-delete `deletedAt`.

`TransactionCategory` (`schema.prisma:28–46`) has 16 values:

```
Income, Transfer, Groceries, Dining, Shopping, Travel, Subscriptions,
Utilities, Interest, Payment, Other,          ← "banking" set
Buy, Sell, Dividend, Split, Fee               ← "investment" set
```

These 16 values are actually **three different dimensions wearing one hat**:

| Real dimension | Values that encode it | Problem |
|---|---|---|
| Economic flow nature | `Income`, `Transfer`, `Payment`, `Interest`, `Fee` (and investment `Buy/Sell/Dividend`) | These are *flows*, not spending buckets. They occupy enum slots that then can't also describe a merchant category. |
| Merchant / spend taxonomy | `Groceries`, `Dining`, `Shopping`, `Travel`, `Subscriptions`, `Utilities`, `Other` | These are the *only* values that are genuinely "categories," and they implicitly assume the flow is discretionary spend. |
| Missing entirely | (no `Refund`, no distinction among transfer sub-kinds) | Refunds fall through to a merchant bucket or `Other`; internal transfer vs. card payment vs. investment funding are all one value. |

### 2.2 Where classification actually happens today

Classification is **derived once at import time** and then **re-derived at read time by every consumer**, with no shared definition:

1. **Import (Plaid).** `mapPlaidCategory` (`lib/plaid/syncTransactions.ts:97–135`) collapses Plaid's rich `personal_finance_category` taxonomy into the 16 values. It is **lossy in exactly the dimension that matters**: `TRANSFER_IN` and `TRANSFER_OUT` both become `Transfer` (`:110–111`), discarding Plaid's `detailed` subtypes that already distinguish account transfers, investment/retirement funding, and credit-card payments; `LOAN_PAYMENTS → Payment` (`:112`); `BANK_FEES → Fee` (`:113`). The richer signal Fourth Meridian would need to separate "checking→savings" from "checking→brokerage" from "checking→Amex" **arrives from Plaid and is thrown away at the door.**
2. **Banking UI read.** `BankingClient.tsx:177–179`: `totalSpent` excludes `Payment` and `Transfer` (correct), but `totalCredit` sums **all** positive-amount rows (`:179`) — so transfers-in, refunds, and any positive investment/other row are counted as "income/credit." Duplicated verbatim in `SpaceTransactionsPanel.tsx:152–156`.
3. **AI transaction assembler.** `lib/ai/assemblers/transactions.ts` maintains its own `INCOME_CATEGORIES`, `MERCHANT_EXCLUDED_CATEGORIES`, and `SPENDING_CATEGORIES` sets (`:97–126`) and computes `incomeTotal`, `expenseTotal`, `debtPaymentTotal`, `transferTotal` separately, with `netCashFlow = incomeTotal − expenseTotal − debtPaymentTotal` (`:256–300`). This is the **most correct** implementation in the codebase — transfers are tracked but excluded from both income and spend.
4. **AI assessment engine.** `lib/ai/intelligence/annotations.ts:755` defines yet another set, `SPENDING_EXCLUDED = {Income, Interest, Transfer, Payment}`.
5. **Investment separation.** `lib/data/transactions.ts` splits reads by category set: banking views filter to the 11 banking categories (`:48–51`); `getInvestmentTransactions` filters to `Buy/Sell/Dividend/Split/Fee` (`:133`). So investment *security* activity is already firewalled from banking views — but the *cash leg* of funding a brokerage (checking→brokerage) still lands in banking as a `Transfer`.

**Net:** four to five independent definitions of "spending," at least one of which (the Banking income total) is wrong. The concept the product needs — a deterministic financial-flow class — already exists implicitly, scattered across the codebase as duplicated constants, rather than once as data.

---

## 3. Root cause analysis

**Primary cause — dimensional conflation.** A single `category` enum is asked to carry both *flow nature* and *spend taxonomy*. Because only one value fits per row, the model can never say "this is a **transfer** whose merchant bucket is irrelevant" and "this is **spending** in the **Groceries** bucket" in a way that a query can rely on. Every consumer must reconstruct the flow dimension by pattern-matching enum values, and each reconstructs it slightly differently.

**Mechanical cause of the specific symptom — sign-sum without flow-awareness.** With positive = in and negative = out, an **internal transfer is two rows**: −X on the source account, +X on the destination, both tagged `Transfer`. At Space scope they net to zero, so *net worth is unaffected*. But any analytic that sums the positive side into "income" and the negative side into "spend" **inflates both totals** by the gross transfer volume. The reported +$629,918 / −$209,573 is this: large capital movements (transfers between owned accounts, credit-card payments, brokerage/savings funding) are being counted as if they were consumption and earnings. The ~$420k "missing" money was never income; it was the same dollars moving between the user's own accounts, counted once on the way out and again on the way in.

**Contributing cause — lossy import.** Even a consumer that *wanted* to classify correctly cannot fully do so today, because `mapPlaidCategory` already discarded Plaid's transfer/loan subtypes. The distinction between an internal transfer and a debt payment is recoverable from Plaid but is collapsed before it is ever stored.

**Contributing cause — no refund concept.** Refunds are positive-amount rows with a merchant category (or `Other`). They therefore either inflate "income" (if summed as positive) or are silently ignored by spend totals, when their correct behavior is to *reduce* spending in their original category.

---

## 4. Alternative designs

Each option is assessed against: correctness, minimality, migration risk, and how well it serves the AI-4 validator (KD-2) and future UI.

### Option A — Status quo (keep deriving inline)
Keep the enum; leave each consumer's derivation as-is.
- **Pros:** zero work.
- **Cons:** the wrong income total persists; four definitions keep drifting; the AI-4 validator has no single ledger to reconcile against; "show me all transfers" stays impossible as a query. **Rejected** — it is the problem.

### Option B — Single shared derivation helper (derived at runtime, one source)
Extract one function, e.g. `classifyFlow(category, amount, …) → FlowType`, and route every consumer through it. No schema change.
- **Pros:** minimal; no migration; immediately kills the drift and fixes the Banking income bug; can ship fast.
- **Cons:** still recomputed on every read; cannot be indexed or queried (`WHERE flowType = 'TRANSFER'` impossible without a stored column); does not persist a value the validator/audit trail can pin to; still limited by the lossy import (can't recover transfer subtypes not stored).

### Option C — Stored normalized `flowType` column + single classifier at write time (RECOMMENDED)
Add an additive `flowType` field to `Transaction`, populated by the Option-B classifier at import/manual-entry time and backfilled for existing rows; keep `category` for merchant taxonomy.
- **Pros:** deterministic and **queryable/indexable** (powers UI filters and per-flow views directly); one source of truth for UI, AI, and the validator; additive and reversible (a nullable column + enum add); consistent with how `category` and `amount` are already stored canonical facts, not derived on read.
- **Cons:** requires a migration + backfill; classifier and column must be kept coherent; still on `Float` money (pre-existing risk, KD noted in STATUS §6); to recover transfer subtypes fully, `mapPlaidCategory` must stop discarding Plaid's `detailed` field (a bounded import change).

### Option D — AI-only concept
Let the AI own flow classification; leave the schema and UI alone.
- **Pros:** no schema work.
- **Cons:** makes core financial totals **non-deterministic** and model-dependent — the opposite of the project's "deterministic-first, provenance" doctrine (STATUS §6) and directly counterproductive to the AI-4 validator, whose job is to catch the model misquoting numbers. UI still can't build a Spending vs. Transfer view. **Rejected.**

### Option E — Split into per-flow tables
Separate `SpendingTransaction`, `TransferTransaction`, etc.
- **Pros:** maximally explicit.
- **Cons:** massive destructive migration; violates the freeze doc's "additive before subtractive"; fractures the single time-ordered feed the UI and AI both depend on; every existing query rewrites. **Rejected.**

### Option F — Full double-entry / linked-transfer ledger
Model each transfer as a linked pair (source leg ↔ destination leg) with an explicit counterparty, moving toward true accounting.
- **Pros:** the "correct" long-term model; makes transfers provably net-zero and enables true source→destination capital-flow graphs.
- **Cons:** transfer-pair matching (correlating the −X and +X legs across two accounts, tolerant of date skew and fees) is a hard, separate problem; large scope; not required to fix the reported symptom. **Defer** — record as future extensibility (§11), not now.

---

## 5. Recommended architecture

Adopt **Option C, built on Option B's classifier as its first increment**, with an explicit **two-field model**:

1. **Keep `TransactionCategory`** as the merchant/spend taxonomy. Do not delete or rename any value now (additive-before-subtractive; the investment values still drive `getInvestmentTransactions`). Over time it can be steered toward "pure spend taxonomy," but that is not part of this change.

2. **Add a normalized, deterministic flow dimension** — a small enum, additive on `Transaction`. A defensible candidate value set, derived from what the code already needs, is:

   `SPENDING, INCOME, TRANSFER, DEBT_PAYMENT, INVESTMENT, FEE, INTEREST, REFUND, ADJUSTMENT`

   These are **not** proposed as final — they are the minimum that lets today's four scattered definitions collapse into one. Notes on the ones that carry real semantics:
   - `TRANSFER` — internal movement between owned accounts; **never** counts as income or spend. (Fully separating internal transfers from third-party transfers is a later refinement; see §11.)
   - `DEBT_PAYMENT` — liability reduction (credit-card payment, loan principal). Not spending — the spending already happened when the card was charged. Counting a card payment as spend is the classic double-count this field prevents.
   - `INVESTMENT` — asset conversion (funding a brokerage / buying securities). Not spending, not income; contributes to net worth via `Holding`, not via the spend ledger.
   - `INTEREST` / `FEE` — real economic costs/inflows, kept distinct from discretionary `SPENDING` so cash-flow and cost analysis can treat them explicitly.
   - `REFUND` — reverses spending in its original category; **not** income (see §6 / Q6).
   - `ADJUSTMENT` — catch-all for balance corrections and unclassifiable rows, so the classifier never has to force a wrong flow.

3. **One classifier module is the single source of truth.** All existing derivations (`BankingClient.tsx:177–179`, `SpaceTransactionsPanel.tsx:152–156`, `assemblers/transactions.ts:97–126`, `annotations.ts:755`) are deleted and replaced by reads of `flowType`. The classifier consumes Plaid's `personal_finance_category.detailed` (recovering transfer/loan subtypes currently discarded), amount sign, account type, and category, and falls back to a deterministic heuristic for CSV/manual rows.

4. **This is a canonical fact, not a provider detail.** The freeze doc's rule that "canonical tables must never gain provider-specific columns" (`PHASE_2_ARCHITECTURE_FREEZE.md §13`) is satisfied: `flowType` describes the *financial nature* of the movement, exactly like `category` and `amount` already do, and is provider-agnostic. It belongs on `Transaction`, not in a provider detail table.

**Stored vs. derived, resolved:** the classifier (derived logic) is mandatory and comes first; the stored column is the durable form that makes it queryable and gives the validator a fixed ledger. Ship the classifier as the source of truth; persist its output as the column.

---

## 6. Answers to the specific investigation questions

**Q1 — Derived, stored, AI-only, reporting-layer, or other?** A **stored, normalized, deterministic field** fed by a **single classifier module**. Not AI-only (would make core totals non-deterministic and defeat the validator). Not purely a reporting layer (the same classification must serve UI *and* AI *and* the validator, so it belongs at the data layer, computed once). Runtime-derived is what exists today and is the failure mode.

**Q2 — Impact on each surface.**
- *Dashboard / Transaction History:* headline income/spend become correct (transfers, payments, refunds no longer inflate them); enables separate lenses.
- *AI context:* replaces ~4 duplicated definitions with one field; monthly summaries, cash flow, merchant and income rollups all read the same ledger.
- *Monthly summaries / spending analytics:* filter `flowType = SPENDING` — deterministic and consistent with the UI.
- *Cash flow:* `net = INCOME − SPENDING − FEE − INTEREST`, with `TRANSFER`/`DEBT_PAYMENT`/`INVESTMENT` explicitly excluded (this is already what `assemblers/transactions.ts:300` approximates; it just becomes canonical).
- *Net worth:* unaffected in principle (transfers already net to zero across owned accounts); the field prevents *reporting* from implying otherwise.
- *Future tax reporting:* `INTEREST`, `DIVIDEND`(investment), `FEE`, and realized `INVESTMENT` activity become directly selectable — a prerequisite the current model can't satisfy.
- *Future budgeting:* budgets can target `SPENDING` only, immune to transfer/payment noise.

**Q3 — Should transfers disappear from spending analytics?** **Yes, entirely.** `Checking→Savings`, `Checking→Brokerage`, and `Checking→Amex payment` are all capital movement or liability reduction, never discretionary spend. They move to a dedicated Transfer/Capital-Flow lens and are excluded from all spend/income totals. (The AI assembler already does this; the UI income total does not — that's the bug.)

**Q4 — Investment purchases (VOO, BTC, ETFs, stocks)?** Classify the cash movement as **INVESTMENT** (asset conversion), not spending and not income. The security-level activity already lives on the investment path (`Buy/Sell/Dividend/Split/Fee`, `lib/data/transactions.ts:133`) and feeds net worth via `Holding`; the checking-side funding leg — today a bare `Transfer` — becomes explicitly `INVESTMENT`/`TRANSFER` so it is never read as consumption.

**Q5 — Debt payments (CC payment, loan principal/interest, min/extra)?** Model as **DEBT_PAYMENT** (liability reduction), excluded from spending. The **interest** portion is a genuine cost and should be `INTEREST`/`FEE`, not principal. Plaid's `LOAN_PAYMENTS` does not reliably split principal vs. interest, and interest frequently arrives as its own row — so classify what the data supports and do **not** attempt to model minimum-vs-extra or synthetic principal/interest splits now (insufficient signal; over-engineering). Historically these appear in a Debt-payoff lens, not the spend feed.

**Q6 — Refunds?** Their own class, **REFUND**, that **reverses spending** in the original category — not income. Today a refund is a positive-amount row that either inflates "income" or is dropped by spend totals; `REFUND` lets analytics net it against the matching spend bucket, which is what users expect ("my March dining, net of the refund").

**Q7 — AI implications.** Significant simplification. The assembler and assessment engine stop re-deriving flow (`transactions.ts:97–126,256–300`; `annotations.ts:755`) and read one field; monthly summaries, cash flow, merchant summaries, spending explanations, advice, and trends all draw from the same ledger. Most valuable: it gives the **AI-4 output validator (KD-2)** a single, deterministic reconciliation target, so "the AI said a number the dashboard disagrees with" becomes structurally preventable rather than caught after the fact.

**Q8 — UI capabilities unlocked (not designed here).** A stored `flowType` turns each of these into a single-field filter rather than bespoke re-derivation: Spending view, Income view, Transfer history, Investment activity, Debt-payoff history, Capital-Flow visualization, deterministic Net cash flow, and Money-sources / Money-destinations breakdowns. No UI is proposed; only the capability is noted.

**Q9 — v2.5 or later? Schema? Additive? D2/D3? Imports? Providers?**
- *Schema:* yes — an additive enum + a nullable column on `Transaction`, plus a backfill. Reversible; no destructive change.
- *Additive:* yes, fully — consistent with the freeze doc's additive-before-subtractive rule.
- *D2/D3 interference:* none structurally. It should, however, **sequence after the D3 read-cutover (v2.5)** so consumers are migrated once on the SAL path, not dual-maintained across the WAS→SAL transition.
- *Plaid imports:* requires a bounded change to `mapPlaidCategory` to stop discarding `personal_finance_category.detailed`, so transfer/loan subtypes survive to feed the classifier.
- *CSV imports:* the classifier needs a deterministic heuristic fallback (sign + category + account type) for rows without provider taxonomy.
- *Future providers:* neutral-to-positive — a provider-agnostic canonical field is exactly the shape the Provider Adapter Layer (freeze §13) wants; each adapter maps its raw taxonomy into the one classifier.
- *Placement:* **v2.5** ("Spaces Completion + Design Foundation"), where the new Spending/Income/Transfer surfaces would be built in the new design language anyway. It does **not** belong in **v2.4.5**, which is a stabilization-only production gate (STATUS §5) — with the single exception that the Banking page's naive positive-sum income total is a correctness defect and can be fixed independently as a bug (Option B's helper) without waiting for the stored column.

---

## 7. Minimal implementation roadmap (recommendation only — not an implementation checklist)

Staged so value lands early and risk stays additive. Each stage would still require its own impact map, rollback plan, and validation checklist before any code, per project rules.

1. **Classifier module (no schema).** Extract one deterministic `classifyFlow(...)` and route the four existing definitions through it. Fixes the income bug; ends the drift. Could be treated as a defect fix.
2. **Import fidelity (bounded).** Stop discarding Plaid `personal_finance_category.detailed` so transfer/loan subtypes reach the classifier.
3. **Additive column + backfill.** Add nullable `flowType` + enum; backfill existing rows via the classifier; dual-populate on new writes. Reads still tolerate null.
4. **Read cutover.** Point UI, AI assemblers, and the AI-4 validator at the stored field; delete the scattered constants.
5. **New lenses + tax/budget readiness (later).** Per-flow UI surfaces and validator reconciliation against the canonical ledger.

Deferred by design: transfer-pair linking / double-entry (Option F), principal-vs-interest splitting, internal-vs-external transfer sub-typing.

---

## 8. Risk assessment

- **Backfill misclassification.** Historical rows lack Plaid `detailed` if it was never stored; some will backfill as `TRANSFER`/`ADJUSTMENT` rather than a precise subtype. *Mitigation:* classifier is deterministic and re-runnable; `ADJUSTMENT` absorbs the genuinely ambiguous; backfill is idempotent.
- **Definition divergence during transition.** Until every consumer is cut over, old inline logic and the new field coexist. *Mitigation:* land the shared helper (stage 1) first so both paths already agree before the column exists.
- **`Float` money.** Pre-existing (STATUS §6 known risk). Netting transfers won't perfectly cancel to zero under `Float`. *Mitigation:* tolerance-based reconciliation; not made worse by this change.
- **Enum churn.** Picking the value set prematurely risks a later additive enum bump. *Mitigation:* enum values are additive in Postgres; start minimal, grow as needed.
- **Scope creep toward accounting.** Temptation to build double-entry now. *Mitigation:* explicitly deferred (§4 Option F, §11).

---

## 9. Migration impact

Additive and staged. A nullable `flowType` column plus an additive enum; existing rows backfilled by a re-runnable script; new writes dual-populate during a dual-read window; reads cut over only after backfill validates — the same additive-before-subtractive pattern the freeze doc mandates (`§15`). No existing column is renamed or dropped. `TransactionCategory` and every current query keep working throughout. Rollback is dropping the column/enum; no data loss because `category`, `amount`, and provider lineage are untouched.

## 10. AI impact

Net reduction in AI-side complexity and risk. The assembler (`assemblers/transactions.ts`) and assessment engine (`annotations.ts`) stop maintaining private notions of income/spend/transfer/debt and read one field. Cash-flow, monthly, merchant, and income rollups become byte-for-byte consistent with the UI. Most importantly, the **AI-4 output validator (KD-2)** gains a single deterministic ledger to reconcile LLM figures against, moving numeric fidelity from "prompt obedience of gpt-4o-mini" toward "checkable against canonical data" — directly advancing the v2.4.5/v2.6 verification goals.

## 11. Analytics impact & future extensibility

**Immediate analytics:** correct income/spend/net-cash-flow; transfers and payments excluded from spend; refunds netted; investment funding separated from consumption. **Unlocked later:** deterministic tax categorization (interest, dividends, fees, realized gains), budgeting scoped to true spending, and capital-flow analysis. **Extensibility path (not now):** (a) split `TRANSFER` into internal vs. third-party once counterparty data is modeled; (b) link transfer legs into pairs (Option F) for provable net-zero and source→destination graphs; (c) evolve `TransactionCategory` toward a pure spend taxonomy once `flowType` owns the flow dimension; (d) principal/interest decomposition on debt payments when provider signal supports it.

---

## 12. Evidence index

| Claim | Source |
|---|---|
| 16-value enum conflates flow + spend taxonomy | `prisma/schema.prisma:28–46` |
| Sign convention (+in / −out); Transaction shape | `prisma/schema.prisma:1157, 1168–1211` |
| Plaid mapping is lossy (`TRANSFER_IN/OUT → Transfer`) | `lib/plaid/syncTransactions.ts:97–135`; sign flip `:218–220` |
| Banking income = naive sum of all positives (the bug) | `components/dashboard/BankingClient.tsx:177–179` |
| Same pattern duplicated in Space widget | `components/dashboard/widgets/SpaceTransactionsPanel.tsx:152–156` |
| AI assembler's separate, more-correct definitions + `netCashFlow` | `lib/ai/assemblers/transactions.ts:97–126, 256–300` |
| Fourth independent definition (`SPENDING_EXCLUDED`) | `lib/ai/intelligence/annotations.ts:755` |
| Investment activity firewalled from banking reads | `lib/data/transactions.ts:48–51, 120–148` |
| Canonical tables must not carry provider-specific columns | `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md §13` |
| Additive-before-subtractive migration rule | `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md §15` |
| v2.4.5 = stabilization-only gate; v2.5 = Spaces + design | `STATUS.md §5` |
| AI-4 validator (KD-2) needs deterministic reconciliation | `STATUS.md §3 (AI-4), §7 (KD-2)` |
