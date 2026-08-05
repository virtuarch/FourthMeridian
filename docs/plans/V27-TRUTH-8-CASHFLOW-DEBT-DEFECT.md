# Financial Truth — the Cash Flow transfer / debt-payment defect

**Commits:** `9e6979f` (classification) · `4ea2645` (labels).
**Gate:** `npm run audit:cashflow-debt`.
**Corpus:** `Chris' Space`, 4,053 banking rows, 2026-08-05.

---

## 1. Root cause

`classifyLiquidity`'s DEBT_PAYMENT branch asserted `CASH_OUT / DEBT_PAYMENT` at
**confidence 1** from two inputs only: the stored `flowType` and the own
account's tier. It never looked at the destination.

```ts
if (isDebtPayment(ft)) {
  return ownTier === "liquid"
    ? make(ft, "CASH_OUT", "DEBT_PAYMENT", 1)   // ← no destination evidence
    : make(ft, "NEUTRAL", "DEBT_PAYMENT", 0.8);
}
```

`flowType` here was **the provider's category**. The row's descriptor named an
institution that also issues a card, so it arrived as
`LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` and was persisted `DEBT_PAYMENT`.

Meanwhile the canonical transfer authority had **already resolved the truth** —
and the read boundary discarded it. `contextFields` computed `a?.maturity`, fed
it into `deriveTransactionContext`, and returned only `transferDisposition`.

> **One authority was right, a second never asked it, and a provider guess won.**

## 2. Exact affected rows

| | Inbound leg | Outbound leg |
|---|---|---|
| id | `cms98o4rp005u2bihex0q0loq` | `cmsg19jov000ctjqvnmibcpaq` |
| event | `cmsg0ofe70dhldxfcarxtsoqy` | `cmsg0ofez0dirdxfcnx7h8r1e` |
| account | High Yield Savings (savings, **American Express**) | CHASE COLLEGE (checking, Chase) |
| amount / date | +$4,000.00 · 2026-07-31 | −$4,000.00 · 2026-08-03 |
| flowType | TRANSFER | **DEBT_PAYMENT** ← provider category |
| resolved counterparty | CHASE COLLEGE | **High Yield Savings Account** |
| transfer maturity | — (persisted cp) | **SAVINGS_TRANSFER** |
| liquidity (before) | NEUTRAL / INTERNAL_TRANSFER ✓ | **CASH_OUT / DEBT_PAYMENT** ✗ |
| liquidity (after) | unchanged | **NEUTRAL / INTERNAL_TRANSFER** ✓ |

**Blast radius: exactly one row.** Of 38 DEBT_PAYMENT rows lacking a persisted
counterparty, the authority resolves **37 to DEBT_PAYMENT and 1 to
SAVINGS_TRANSFER**. Only the contradicted one moves.

## 3. Why the previous convergence proof missed it

Three reasons, all mine:

1. **The probe was not faithful to the live path.** `audit-ui-truth-convergence`
   read raw rows and skipped `resolveTransferAssessments`, so it saw
   `counterparty: NONE` where the app sees `High Yield Savings Account`. It could
   not observe the contradiction. **Fixed** — both probes now run read-time
   resolution.
2. **I converged surfaces onto one authority without auditing that authority's
   membership test.** The proof showed the Debt Payments card and DebtClient
   agreeing at $245,592.37. They agreed — on a wrong number. Consistency is not
   correctness, and I reported the former as if it settled the latter.
3. **My symptom search was structural, not evidential.** I checked whether a
   `TRANSFER`-typed row entered the card. This row is `DEBT_PAYMENT`-typed, so it
   passed a test aimed at the wrong shape. I then reported "not reproduced"
   rather than widening the search.

## 4. Cash Out doctrine — what it claims, and now measures

**Cash Out = EXTERNAL household outflow.** The UI already commits to this: an
`INTERNAL_TRANSFER` reason is side `"context"`, excluded from Cash In/Out, and
the screen carries a separate **"MOVED, NOT SPENT — Between your accounts"**
figure plus **"Spent on credit (no cash moved at purchase)"**.

The wording was right; the calculation leaked. Composition now:

| Reason | Rows | Amount |
|---|---|---|
| DEBT_PAYMENT | 119 | $241,592.37 |
| REAL_COST | 159 | $1,512.04 |
| **Total** | **278** | **$243,104.41** |

**Cash Out rows whose destination is the user's own non-liability account: 0.**
No rename needed — the number now matches the words.

## 5. Debt Payments doctrine

One authority (`debt-payment-authority.ts`), one counted leg (**CASH**), and a
claim that must not be contradicted:

- ❌ counts both legs — no: 118 liability legs excluded by selection
- ❌ counts a transfer merely for leaving checking — no: destination decides
- ❌ counts because the destination institution also has a card — no: **that was
  the defect**, and probe 3 pins it
- ❌ `classifyLiquidity` as a second authority — it is the *only* one, now
  destination-aware
- ❌ stored `flowType` without evidence — a contradicted `flowType` loses
- ❌ multiple observations of one event — L8-B1 projection filter

**Every carded row by canonical maturity:** 94 persisted-counterparty · 25
`DEBT_PAYMENT`. **0 resolve to SAVINGS_TRANSFER, CASH_TRANSFER,
INTERNAL_TRANSFER or INVESTMENT_TRANSFER.**

## 6. Before / after

| | Before | After | Δ |
|---|---|---|---|
| Debt Payments | $245,592.37 (120 rows) | **$241,592.37 (119)** | −$4,000.00 |
| Cash Out | $247,104.41 (279 rows) | **$243,104.41 (278)** | −$4,000.00 |
| Cash In | $273,702.51 | $273,702.51 | 0 |
| Income / Spending / Refunds | unchanged | unchanged | 0 |
| debt-card event ids | `3e6359fb930c1010` | **`0440dbd7683a3782`** | 1 removed |
| cash-out row ids | `ecc50b5e135c80c3` | **`c4e2e9c3cff2b4eb`** | 1 removed |

Event removed: **`cmsg0ofez0dirdxfcnx7h8r1e`**.

## 7. Browser proof

Live Cash Flow screen, all-history window:

- **Debt Payments $241,592** — three creditor groups, no "Americanexpress
  Transfer" group. Card = $124,985 + $110,107 + $6,500.
- **Drawer reconciles**: "Online Transfer / Payment: Debit" → $500 + $4,500 +
  $1,500 = **$6,500**, equal to its card row.
- **`cmsg19jov…` drawer**: eyebrow **"INTERNAL TRANSFER"**, chip "Internal
  transfer", *What:* "Internal transfer · Internal".
- **`cmsg19jkj…` ($650 Chase card payment)**: still **"Debt payment"**.
- Microsoft issuer credit still reads "Issuer credit".

## 8. Tests and fingerprints

**Eight standing probes** (`debt-payment-attestation.test.ts`), including one
that feeds four descriptors — `AMERICANEXPRESS TRANSFER…`, `AMERICAN EXPRESS ACH
PMT…`, `Payment to Chase card…`, `zzzz nonsense` — through identical rows and
asserts the verdict never moves; plus source probes that the authorities read no
merchant, description or institution.

**Gates:** suite **471/471** · tsc **0** · lint **0 errors, 23 warnings** ·
`audit:ui-truth` PASSED · `audit:event-identity` PASSED · `audit:event-cutover`
PASSED · economic-date PASSED · transfer-authority fingerprints unchanged
(`154ec49697090e3f` / `9b3351e665e73cdf`).

## 9. Other cards with the same defect

**Checked, none found.** The DEBT_PAYMENT branch was the only place a claim about
a *destination* was made without destination evidence:

- Income — already destination-aware (V27-TRUTH-5/7).
- Refund / issuer credit — decided by the liability-inflow authority.
- Spending / fees — claims about the row itself, no destination.
- Transfers — `classifyTransfer` was always tier-driven; that is what the
  DEBT_PAYMENT branch now delegates to.

**Two adjacent inconsistencies fixed in passing:** the slice drawer rendered the
raw provider `category`, so a row the Debt Payments card counted displayed
"Transfer"; and `describeRowNature` had no access to the maturity, so the $4,000
still *read* "Debt payment" after its classification was corrected.

## Remaining, not fixed

**18 carded rows ($34,500) have no resolved counterparty** — the authority
attests `DEBT_PAYMENT` for them from mask/leg evidence, and they are almost all
same-day same-amount pairs (an Amex payment and a Chase payment on one date) that
leg-matching correctly refuses to pair. They are counted. If you want the card
restricted to structurally-attested destinations only, that is a separate,
measurable decision — say so and I will scope it.
