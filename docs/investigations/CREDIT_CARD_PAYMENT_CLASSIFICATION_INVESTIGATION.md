# Credit-Card Payment Classification Investigation

**Status:** Investigation + checklist only. **No implementation.**
**Date:** 2026-07-04
**Problem:** Chase credit-card payments still appear under `Other` instead of `Payment` / debt-payment semantics.
**Goal:** Represent card payments in structured data so a future AI can answer *"How much credit-card debt have I paid with Chase since March 12?"*
**Related prior work:** `DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md` (KD-18), `KD17_JANUARY_OTHER_CATEGORY_ANOMALY_INVESTIGATION.md`, `kd17-audit-output.md`, `TRANSACTION_FLOW_CLASSIFICATION_INVESTIGATION.md`. This investigation does not re-litigate them; it isolates the **classification** defect that is the prerequisite to the KD-18 capability.

---

## 0. Executive summary

A credit-card payment is **two rows** (legs). The **destination leg** — a positive credit sitting on the card's own `financialAccountId` ("Payment Thank You-Mobile") — is where per-card attribution is deterministic. The defect is a **classification inconsistency at import**: Plaid tags these identical payment credits with an inconsistent PFC, so some become `Payment` and the rest fall through `mapPlaidCategory`'s `default → Other`. Proven in the KD-17 audit: in January, of the card-side payment credits, **$4,000 carried `Payment` and $9,500 carried `Other`** for the *same* merchant string.

Two independent facts make the fix cheap and bounded:
1. **`flow-classifier.ts` already maps `Payment` → `DEBT_PAYMENT` at confidence 1.0.** Fixing the *category* fixes the flow for free — no classifier change.
2. **Every column needed for the target query already exists** on `Transaction` (`financialAccountId`, `flowType`, `flowDirection`) and `FinancialAccount` (`institution`, `institutionId`, `debtSubtype`). **No schema is required** for either the classification fix or the eventual per-card rollup.

The classification fix is this investigation's slice. The per-card *rollup capability* (the actual query) is the already-scoped **KD-18** read-side work and is called out but not designed here.

## 1. How Plaid represents Chase credit-card payments (two legs)

| Leg | Account it lands on | Sign (FM convention) | Merchant string | Plaid PFC | Attribution content |
|---|---|---|---|---|---|
| **Source** | checking | `amount < 0` | "CHASE CREDIT CRD AUTOPAY" / "Payment to Chase card" | `LOAN_PAYMENTS` / detailed `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` *when Plaid tags it* | source account known (row's own); **destination card only inferable from the merchant string — heuristic, not deterministic** |
| **Destination** | the **card's own** `financialAccountId` | `amount > 0` | "Payment Thank You-Mobile" | **inconsistent** — some rows `LOAN_PAYMENTS`, others an unmapped/absent primary | **destination card is the row's own account — deterministic**; `FinancialAccount.debtSubtype` marks it a liability, `institution` = "Chase" |

Evidence (`kd17-audit-output.md`, January): rows 46/48/62 are `+$1,500 / +$3,500 / +$500` "Payment Thank You-Mobile" credits on a `CREDIT CARD` `FinancialAccount`; the section total shows `Payment` credits of **$4,000** while another **$9,500** of the same-shaped credits landed in `Other`.

## 2. Current `Transaction.category` for these rows

Split, by leg and by Plaid's tagging luck:
- Rows Plaid tagged `LOAN_PAYMENTS` → `mapPlaidCategory` `case "LOAN_PAYMENTS": return "Payment"` (plaid-category.ts) → **`Payment`** ✓
- Rows Plaid tagged with an unmapped/absent primary → fall through the switch to **`default → "Other"`** ✗ — this is the reported defect.

`mapPlaidCategory` reads `detailed` only for `INTEREST`/`SUBSCRIPTION`; it does **not** honor `detailed = LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`, and it has **no access to account type/side or amount sign** (its input is PFC + merchant + name only). So it cannot currently rescue the `Other` legs.

## 3. Current `flowType` / `flowDirection` / `flowClassificationReason`

Because flow is derived from category (P3 Phase B persists it), the split propagates:
- **`Payment` legs →** `classifyFlow` `case 'Payment'`: **`flowType = DEBT_PAYMENT`**, `flowDirection = amount < 0 ? INTERNAL : INFLOW`, `reason = CATEGORY_FLOW_VALUE`, `confidence = 1.0`. Correct.
- **`Other` legs (positive) →** `Other` is in `SPEND_CATEGORIES`, so a positive-amount `Other` row hits the sign default: **`flowType = REFUND`**, `flowDirection = INFLOW`, `reason = SIGN_DEFAULT_INFLOW`, `confidence = 0.5`. **Wrong** — a debt payment is persisted as a refund.
- `counterpartyAccountId` is **always `null`** (buildFlowWriteFields, Phase B writes null by design) — no structured "other side" link exists on any row.

So the miscategorized legs are wrong at *two* layers (category `Other`, flow `REFUND`), both fixed by correcting the category.

## 4. Should `mapPlaidCategory` classify them as `Payment`? — Yes, but generalized and guarded

Yes for the **payment legs only** — never "all Chase rows." Two generalization-safe signals:

- **(a) `detailed` contains `CREDIT_CARD_PAYMENT`** — institution-agnostic and unambiguous. Cheap, safe, but only helps rows that *have* that detailed (which mostly already map to `Payment` via the primary). Low incremental yield, but correct and defensive if Plaid ever emits the detailed without the mapped primary.
- **(b) a guarded card-payment *descriptor* pattern** — the rows actually stuck in `Other` are the ones with a null/unmapped PFC, whose only signal is the descriptor ("payment thank you", "cardmember … payment", "credit crd autopay", "online payment … thank you"). These are near-universal card-payment acknowledgment phrases across issuers (Chase, Amex, Citi, …), i.e. **generalized, not Chase strings**.

**Guard is essential.** Descriptor (b) must not fire on a coincidental merchant. The deterministic guard is *account side + sign*: **the row is on a liability account (`debtSubtype != null`) AND `amount > 0`.** `mapPlaidCategory` as currently shaped has neither the account nor the amount — so the guarded rule belongs at the **sync seam** (`syncTransactions.ts`), where `resolveAccountMeta` already yields `debtSubtype` and the sign is known, not inside the account-blind `mapPlaidCategory`. (Signal (a) can live in `mapPlaidCategory` safely since the detailed is self-identifying.)

Do **not** put this in Merchant Intelligence: "Payment Thank You" is not a brand, and card payments were explicitly held out of the Slice-1 catalog. This is a payment-descriptor + account-side rule, not a merchant rule.

## 5. Does `flow-classifier` already map `Payment` → `DEBT_PAYMENT`? — Yes

`classifyFlow` `case 'Payment'` returns `DEBT_PAYMENT` at confidence 1.0 with direction `INTERNAL` (source leg, `amount<0`) or `INFLOW` (destination leg, `amount>0`). **No classifier change is needed.** Correcting the category is sufficient and automatic: a rescued `Other→Payment` destination leg becomes `DEBT_PAYMENT / INFLOW`, exactly the shape a per-card rollup needs.

## 6. Is counterparty / account matching needed to distinguish the three cases?

Distinguishing **payment-to-card** vs **transfer-between-own-accounts** vs **regular-merchant-payment** does **not** require counterparty pairing — the discriminators are already on the row + its account:

| Case | Deterministic signature (all present today) |
|---|---|
| Payment to a credit card | on a liability account (`debtSubtype != null`), `amount > 0`, `flowType = DEBT_PAYMENT` (once classified) |
| Transfer between own accounts | `category = Transfer` / `flowType = TRANSFER` (PFC `TRANSFER_IN`/`OUT`) — the flow *kind* itself separates it |
| Regular merchant payment | spend category / `flowType = SPENDING` on a non-liability account |

**Counterparty pairing is only needed for the *source* leg** — to say *which* card a checking debit paid, and to reconcile source-side vs destination-side totals. That is FlowType "Option F", explicitly deferred. **The user's query avoids it entirely by reading the destination (card-side) legs**, where the destination is the row's own account. Recommendation: attribute from the destination side; treat the source-side `debtPaymentTotal` as a cross-check, not the primary source.

## 7. Supporting the target query (by card / institution / date / amount)

Every dimension is deterministically available from the **destination-side legs** once classification is fixed — no schema:

- **Card account** → `Transaction.financialAccountId` (the card the credit sits on).
- **Institution ("with Chase")** → `FinancialAccount.institution` (human-readable "Chase") + `institutionId` (`ins_*`). Confirmed on the model; no separate field needed.
- **Date range ("since March 12")** → `Transaction.date`.
- **Amount paid** → `Transaction.amount` (positive credit on the card).

Selector (deterministic): `amount > 0 AND account.debtSubtype != null AND flowType = 'DEBT_PAYMENT'` (equivalently `category = 'Payment'` post-fix), grouped by `financialAccountId` (and/or `institution`) and month.

Two blockers remain, both **read-side, no schema** (these are the KD-18 capability, §8):
1. **Classification correctness** (this investigation's slice) — otherwise the `Other` legs are silently omitted and totals undercount.
2. **The AI assembler discards account identity at the door** — the summary `select` fetches only `date, merchant, category, amount, pending` (transactions.ts ~L235-241); `financialAccountId` never survives, and there is no `byLiability` rollup. Fixing this is the KD-18 read-side work.

## 8. Where does this belong — FlowType, Merchant Intelligence, or Debt lens?

- **Classification correctness (this slice)** → the **FlowType / import layer** (`mapPlaidCategory` + the guarded sync-seam rule). Output: card payments deterministically become `Payment` → `DEBT_PAYMENT`.
- **The query capability (per-card / per-institution / date-range rollup)** → the **Debt lens / AI assembler read side** (carry `financialAccountId`, add a `byLiability` destination rollup). This is **KD-18**, already ratified into v2.5.5 FlowType.
- **Merchant Intelligence** → **not** the home. Contributes nothing here beyond the descriptor pattern, which is better expressed as an account-guarded payment rule than a brand rule.

## 9. Smallest safe implementation slice (classification only)

**Slice CC-1 — Card-payment classification correctness. No schema. No UI.** (Do not bundle the KD-18 rollup — that is a separate, larger, read-side slice.)

1. `mapPlaidCategory`: add `if (detailed.includes("CREDIT_CARD_PAYMENT")) return "Payment";` alongside the existing `INTEREST` detailed check (self-identifying, account-blind-safe, sits **below** the flow-structural handling, consistent with the Slice-1 precedence).
2. Sync seam (`syncTransactions.ts`): where `resolveAccountMeta` already gives `debtSubtype`, apply a **guarded** rule — if the row is on a liability account **and** `amount > 0` **and** the descriptor matches a generalized card-payment pattern, set `category = Payment`. Pattern is a small, curated, **institution-agnostic** phrase list ("payment thank you", "cardmember … payment", "credit crd autopay", "online payment", "autopay … payment"), proven against non-Chase issuers — never raw "Chase" strings.
3. Backfill (dry-run first, `Other`-only, reversible — mirror `scripts/backfill-merchant-categories.ts` / `reclassify-subscriptions.ts`): reclassify historical **card-side** `Other` legs (`amount > 0 AND account.debtSubtype != null AND` descriptor match) → `Payment`, then let the existing P4 FlowType backfill re-derive `DEBT_PAYMENT` over the changed rows (or scope a targeted flow re-run). Snapshot `(id, 'Other')` for rollback.

Explicitly out of scope of CC-1: source-leg → card attribution, counterparty pairing, the per-card rollup, any assembler/UI change. Those are KD-18.

## 10. Validation plan

- **Generalization proof (anti-overfit):** unit tests over synthetic **non-Chase** issuers — Amex/Citi/Discover "Payment Thank You" credits on a liability account → `Payment` → `DEBT_PAYMENT/INFLOW`; a Chase `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` source debit → `Payment` → `DEBT_PAYMENT/INTERNAL`.
- **False-positive guards (must NOT flip):** a genuine merchant refund on a *non-liability* account; a merchant literally named "…Payment…" on a checking account; an ordinary Chase card purchase ("Uber", "Amazon") — proves *not all Chase rows* become payments.
- **Discriminator tests:** an own-account transfer (`TRANSFER_IN`) stays `Transfer/TRANSFER`, not `Payment` — confirms card-payment vs transfer separation.
- **Data-quantification (read-only):** run `scripts/kd-debt-attribution-audit.ts` and the CC-1 backfill in **dry-run** to count how many `Other` legs the rule rescues and confirm the rescued set is exactly card-side payment credits (no spend rows).
- **Structural:** `npx prisma generate` (sanity, no schema change), `npx tsc --noEmit`, `npm run lint`, `npx tsx lib/transactions/plaid-category.test.ts`, and the full FlowType suite (`flow-classifier`, `plaid-flow-input`, `plaid-flow-write`, `flow-row-input`) — all green, proving no drift for non-payment rows.
- **Rollback:** code = revert the mapper branch + sync-seam guard; backfill = restore snapshot `(id → 'Other')`, guarded by `category = 'Payment'` so a later user re-categorization is never clobbered.

---

### Evidence index

| Claim | Source |
|---|---|
| Card-side payment credits, some `Payment` ($4,000) / some `Other` ($9,500), same merchant | `docs/investigations/kd17-audit-output.md` (rows 46/48/62), `KD17_JANUARY_OTHER_CATEGORY_ANOMALY_INVESTIGATION.md` |
| `mapPlaidCategory` `LOAN_PAYMENTS → Payment`; `default → Other`; reads `detailed` only for INTEREST/SUBSCRIPTION; no account/amount context | `lib/transactions/plaid-category.ts` |
| `Payment → DEBT_PAYMENT` at confidence 1.0; positive `Other` → `REFUND` | `lib/transactions/flow-classifier.ts` (`case 'Payment'`, `SPEND_CATEGORIES`) |
| `counterpartyAccountId` always null on write | `lib/transactions/plaid-flow-input.ts` `buildFlowWriteFields` |
| Sync resolves `debtSubtype` via `resolveAccountMeta` before flow classify | `lib/plaid/syncTransactions.ts` (~L216-235) |
| Query dimensions exist: `financialAccountId`, `institution`, `institutionId`, `debtSubtype`, `date`, `amount`; `flowType`/`flowDirection` persisted | `prisma/schema.prisma` (FinancialAccount, Transaction) |
| Assembler summary select discards `financialAccountId`; no `byLiability` rollup | `lib/ai/assemblers/transactions.ts` ~L235-241; `DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md` §3 |
| Per-card rollup + source-leg pairing = KD-18 / FlowType Option F (deferred) | `DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md` §4-5; `TRANSACTION_FLOW_CLASSIFICATION_INVESTIGATION.md` §4 |

**Stop after investigation/checklist. No code.**
