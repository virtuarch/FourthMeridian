# D2.x — Slice 4B: Credit-Card / Debt Snapshot Backfill — Investigation

**Status:** Investigation only. No implementation.
**Problem:** Slice 4 reconstructs checking/savings but holds `debt` flat, so Debt Spaces show flat charts and past net worth is over-stated when a card was paid down. This also is the prime suspect for the reality-check anomaly (flat debt inflates historical `netWorth`).
**Goal:** Determine whether/how credit-card debt can be reconstructed honestly from stored card transactions.

---

## 1. Current backfill treatment of debt

`lib/snapshots/backfill.ts`: only `checking`/`savings` are reverse-walked; everything else (incl. `debt`) is passed to `classifyAccounts` at its **current** balance, i.e. **held flat** on every past day. `computeSnapshotFields` then writes today's `debt` on every backfilled row → flat debt line, and `netWorth = totalAssets − debt` uses that frozen debt.

## 2. How `FinancialAccount.balance` is stored for credit cards

**Positive = amount owed.** `exchangeToken.ts` maps `credit`/`loan` → `AccountType.debt` and stores `balance = acct.balances.current` (Plaid credit `current` is the positive amount owed). `classifyAccounts` confirms the convention: `totalLiabilities = liabilities.reduce((s,a) => s + Math.max(0, a.balance), 0)` with the comment *"Only positive balances count as owed — negative = they owe you"*. So a card at $1,200 owed is stored `balance = +1200` (NOT negative, NOT Plaid-mirrored beyond the current value).

## 3. How credit-card transactions are stored (sign)

Same universal flip as everything else — `syncTransactions.ts:215` `amount = -txn.amount` (Plaid +out/−in → FM +in/−out), written with `financialAccountId` = the card account. So, on the card account:

| Card event | Plaid amount | FM stored `amount` | Effect on amount **owed** |
|---|---|---|---|
| Purchase | + (charge/out) | **−** | **increases** owed |
| Payment | − (credit/in) | **+** | **decreases** owed |
| Refund/return | − | **+** | decreases owed |
| Fee (as a txn) | + | **−** | increases owed |
| Interest (as a txn) | + | **−** | increases owed |
| Interest/fee posted **without** a txn | — | — | **not captured** (drift) |

Key: the FM `amount` sign already encodes purchase (−) vs payment/refund (+). The mechanical reconstruction needs **only the raw amount** — no category, no flowType, no counterparty.

## 4. Correct reverse-walk formula for liabilities

For an **asset** (cash), balance rises with money-in: `A(d−1) = A(d) − Σ FM_amount(d)` — the Slice-4 core subtracts.

For a **liability** (owed, stored positive), owed rises with charges (FM −) and falls with payments (FM +). The per-day change in owed is `ΔL(d) = −Σ FM_amount(d)`, so:

```
L(d) = L(d−1) − Σ FM_amount(d)     ⇒     L(d−1) = L(d) + Σ FM_amount(d)
reverse-walk step:  owed(d) = owed(d+1) + Σ FM_amount(d+1)      ← ADD
```

**The liability walk ADDS FM amounts; the cash walk SUBTRACTS them.** It is the exact sign-flip of the existing core. (Sanity: today owed $500; yesterday a $100 purchase, FM −100 ⇒ owed before = 500 + (−100) = $400 — correct, they owed less before charging.)

## 5. Is `Transaction.amount` sign sufficient?

**Yes, for the mechanical walk.** Purchases/payments/refunds/fees-as-transactions are all correctly signed by the universal `-txn.amount` flip, and the liability recurrence uses only `Σ amount`. **What it cannot capture** is any balance movement that is *not* a transaction — chiefly **interest accrual and some fees** that post directly to the statement balance. That is the honesty gap (→ estimated).

## 6. How Payment / DEBT_PAYMENT rows should affect debt

They should be handled **implicitly by their raw amount**, not by category/flowType. A card payment on the card account is FM +; adding it in the reverse walk makes past owed higher (correct — more was owed before paying). **Do not** special-case DEBT_PAYMENT and **do not** pair with the checking-side leg: each account is walked by its own transactions, so the checking-side payment (handled by the cash walk) and the card-side payment are independent and never double-counted. This satisfies the "no counterparty pairing" rule.

## 7. Pending transactions

Real risk of drift: Plaid credit `balances.current` typically reflects **posted** activity, while a pending charge may or may not be included. The Slice-4 cash walk does **not** filter pending. For debt, mismatched pending handling shifts the recent end of the curve. **Recommendation:** for the debt walk, **exclude pending** (`pending = false`) to align with the posted `current` balance anchor, and flag as a decision. (Consistency with the cash walk is a secondary consideration; debt is more pending-sensitive.)

## 8. Limit to credit cards only?

**Yes.** Reconstruct only **revolving credit** — gate on `FinancialAccount.debtSubtype` (`credit_card`, and arguably `line_of_credit`/`heloc`). **Exclude installment loans / mortgages / auto / student** — their balances move by amortization + interest, which are largely **not** transaction-driven, so a transaction walk would drift badly. Those stay **flat** (as today). `debtSubtype` already exists (no schema).

## 9. Effect on fields

- **`debt`:** reconstructed per day for card accounts (was flat). Non-card debt stays flat.
- **`netWorth = totalAssets − debt`:** past net worth now reflects higher historical card debt when a card was paid down → **removes the upward inflation** flagged in the reality-check. Directly relevant to the hero net-worth chart.
- **`netLiquid = cash + savings − debt`:** likewise corrected.
- **Debt Space charts:** a real debt curve instead of a flat line.
- `classifyAccounts` clamps liabilities at `max(0, balance)`, so a reconstructed **negative** owed (overpayment/credit balance in the past) is treated as $0 owed — consistent with current live behavior.

## 10. Risks

- **Missing interest/fees (primary):** non-transaction balance moves aren't captured → drift, especially over a full statement cycle. Mitigate by **labeling estimated** (reuse `isEstimated`), and optionally only walking within the available transaction depth.
- **Sign inversion:** the walk must **ADD** (§4). Getting it wrong flips the whole debt curve. Must be unit-tested with worked examples.
- **Pending/posting timing:** §7 — exclude pending to match the anchor.
- **Misclassified card payments:** not a problem — the walk uses raw amount, not category/flowType, so misclassification can't corrupt the balance math.
- **Refunds/chargebacks:** FM + reduces owed correctly.
- **Non-card debt misgated:** if a loan is mislabeled `credit_card`, it would be walked and drift — gate strictly on `debtSubtype` and default to flat when unknown.

## 11. Slice 4B, or defer to Debt lens / KD-18?

**Viable as its own D2.x Slice 4B** — it is a self-contained, additive extension of the Slice-4 reverse walk, independent of KD-18 (per-liability attribution / counterparty pairing), which the rules explicitly exclude. It needs **no schema** (`debtSubtype` + `isEstimated` already exist), does not touch investments/crypto/manual/loans, and does not change cash reconstruction. Recommend implementing as Slice 4B, gated to `credit_card`, `isEstimated=true`. (The Debt-lens/KD-18 work remains separate and is not a dependency.)

## 12. Smallest safe implementation checklist (if approved)

1. **`lib/snapshots/backfill-core.ts`** — add a liability reverse-walk, either a sibling `reconstructDailyLiabilityBalances` (ADD) or a `direction: "asset" | "liability"` parameter on the existing walk (subtract vs add). Pure; unit-tested.
2. **`lib/snapshots/backfill.ts`** —
   - Select card accounts: `type === "debt" && debtSubtype ∈ {credit_card[, line_of_credit, heloc]}`.
   - Query their transactions in-window with `pending: false` (§7), `groupBy(financialAccountId, date)._sum.amount`.
   - Reverse-walk their `balance` with the liability formula; hold non-card debt (and investments/crypto/manual) flat.
   - Per day, override the card accounts' balances (like cash) before `classifyAccounts` → `computeSnapshotFields`. `isEstimated=true`. Never overwrite existing rows; exclude today (all unchanged).
3. **`lib/snapshots/backfill-core.test.ts`** — add liability-walk cases: purchase raises past-lower→ owed increases correctly; payment makes past owed higher; refund lowers; `max(0)` clamp; today excluded.
4. **No schema.** No change to cash reconstruction, investments/crypto/manual, or `isEstimated` labeling. No counterparty pairing. No UI change required (the existing estimated badge already covers these rows).
5. **Decision to confirm:** include `line_of_credit`/`heloc` or restrict to `credit_card` only; exclude-pending confirmation.

**Validation (when built):** unit tests for the liability walk; dev run on a Debt Space → card debt curve appears, moves opposite to purchases, past debt higher before a paydown; `netWorth` history drops accordingly; non-card debt stays flat; `isEstimated=true`; live/today rows untouched.

**Rollback:** additive; revert the debt branch in `backfill.ts` + core helper; `DELETE ... WHERE isEstimated=true` reruns as before.

**Stop — investigation/checklist only.**
