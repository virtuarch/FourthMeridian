# KD-17 audit output — generated 2026-07-02T14:34:34.326Z

Read-only. Month: 2026-01. Mirrors lib/ai/assemblers/transactions.ts logic.


# Space: Chris's Dashboard (cmqdwrv8s00047ple3s5ytesi) — 2026-01

Rows in window: 147 (147 settled, 0 pending)

## Recomputed monthly rollup (mirrors buildMonthlyBreakdown)

| Metric | Value |
|---|---|
| expenseTotal ("Total 2026-01 spending") | $5,848.70 |
| incomeTotal | $17,907.80 |
| debtPaymentTotal | $14,500.00 |
| transferTotal | $15,795.56 |
| **Other — monthly category line (`abs(signed net)`)** | **$6,529.45** |
| Other — drilldown matchedTotal (debits only) | $2,970.55 |

## Per-category decomposition (settled rows)

Printed = `abs(debits_sum - credits_sum)` — the monthly "categories:" line.
Counted-in-expenseTotal = debits only (spending categories).

| Category | Printed total | Σ debits | Σ credits | In expenseTotal | In prompt categories line | Count |
|---|---|---|---|---|---|---|
| Income | $17,902.60 | $0.00 | $17,902.60 | — (non-spending branch) | no (name-filtered) | 3 |
| Payment | $10,500.00 | $14,500.00 | $4,000.00 | — (non-spending branch) | no (name-filtered) | 11 |
| Other | $6,529.45 | $2,970.55 | $9,500.00 | $2,970.55 | yes | 44 |
| Transfer | $4,795.56 | $10,295.56 | $5,500.00 | — (non-spending branch) | no (name-filtered) | 16 |
| Shopping | $1,095.06 | $1,119.01 | $23.95 | $1,119.01 | yes | 40 |
| Interest | $805.18 | $810.38 | $5.20 | — (non-spending branch) | no (name-filtered) | 5 |
| Dining | $756.70 | $756.70 | $0.00 | $756.70 | yes | 26 |
| Utilities | $192.06 | $192.06 | $0.00 | $192.06 | yes | 2 |

## Every settled "2026-01" Other transaction (44 rows)

Flow type is heuristic (sign + text) — category on all rows is `Other`.
Provenance: plaid = plaidTransactionId set; import = importBatchId set; manual = neither.

| Date | Merchant | Description | Amount | Flow type (heuristic) | Provenance | Account | Path | In expenseTotal | In monthly Other | In drilldown Other |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-01-01 | Uber | Uber | -$17.58 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-01 | Uber | Uber | -$12.11 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-01 | Payment Thank You-Mobile | Payment Thank You-Mobile | +$1,500.00 | payment | plaid | CREDIT CARD | FinancialAccount | **no** | yes (signed) | **no** |
| 2026-01-01 | Uber | Uber | -$10.26 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-04 | Payment Thank You-Mobile | Payment Thank You-Mobile | +$3,500.00 | payment | plaid | CREDIT CARD | FinancialAccount | **no** | yes (signed) | **no** |
| 2026-01-07 | Uber | Uber | -$5.41 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-07 | Uber | Uber | -$5.00 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-08 | Uber | Uber | -$10.23 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-10 | Corporate Filings Lls | CORPORATE FILINGS LLSHERIDAN | -$125.00 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-11 | Uber | Uber | -$7.76 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-11 | Uber | Uber | -$6.83 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-15 | Uber | Uber | -$12.21 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-15 | Uber | Uber | -$2.72 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-15 | Uber | Uber | -$17.98 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-15 | Uber | Uber | -$4.89 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-16 | Uber | Uber | -$12.78 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-16 | NBS-WGU*SERVICE FEE | NBS-WGU*SERVICE FEE | -$30.82 | fee | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-16 | Western Governors Un | WESTERN GOVERNORS UNMILLCREEK | -$1,081.25 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-16 | Payment Thank You-Mobile | Payment Thank You-Mobile | +$500.00 | payment | plaid | CREDIT CARD | FinancialAccount | **no** | yes (signed) | **no** |
| 2026-01-16 | Uber | Uber | -$9.19 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-16 | Uber | Uber | -$9.53 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-16 | Uber | Uber | -$17.33 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-18 | Uber | Uber | -$2.77 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-18 | Uber | Uber | -$2.82 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-20 | Hello Klean | SP HELLO KLEAN | -$125.00 | debit | plaid | CREDIT CARD | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-20 | Uber | Uber | -$2.15 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-21 | Uber | Uber | -$7.22 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-22 | Uber | Uber | -$14.40 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-23 | Uber | Uber | -$10.13 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-23 | Uber | Uber | -$9.86 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-24 | Uber | Uber | -$14.64 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-24 | Uber | Uber | -$10.91 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-24 | Corporate Filings Lls | CORPORATE FILINGS LLSHERIDAN | -$149.00 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-24 | Uber | Uber | -$2.15 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-25 | Uber | Uber | -$8.24 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-25 | Uber | Uber | -$7.49 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-25 | Uber | Uber | -$7.46 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-26 | Gathern | Gathern | -$852.73 | debit | plaid | CREDIT CARD | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-27 | Vercel Inc. | VERCEL INC. | -$20.00 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-27 | Gathern | Gathern | -$284.26 | debit | plaid | CREDIT CARD | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-28 | YouTube Premium | YOUTUBEPREMI G.CO/HELPPAY# | -$13.99 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-29 | Uber | Uber | -$14.51 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-29 | Uber | Uber | -$11.94 | debit | plaid | Platinum Card® | FinancialAccount | yes | yes (signed) | yes |
| 2026-01-30 | Payment Thank You-Mobile | Payment Thank You-Mobile | +$4,000.00 | payment | plaid | CREDIT CARD | FinancialAccount | **no** | yes (signed) | **no** |

## Reconciliation

| Quantity | Formula | Value |
|---|---|---|
| Other debits (D) | Σ\|amount<0\| | $2,970.55 |
| Other credits (C) | Σ amount>0 | $9,500.00 |
| Monthly "Other" printed | \|C − D\| | $6,529.45 |
| Other's contribution to expenseTotal | D | $2,970.55 |
| Drilldown Other matchedTotal | D | $2,970.55 |
| Month expenseTotal | Σ debits, spending branches | $5,848.70 |
| Excess of Other over expenseTotal | \|C − D\| − expenseTotal | $680.75 |

## Blast radius — positive rows in spending categories (all dates, this space)

| Category | Positive rows | Σ credits |
|---|---|---|
| Other | 59 | $95,797.69 |
| Travel | 12 | $4,518.58 |
| Shopping | 7 | $912.60 |
| Dining | 1 | $5.18 |


# Space: Retire by 35 (cmqm824ko0006n0pofctp6i4c) — 2026-01

Rows in window: 25 (25 settled, 0 pending)

## Recomputed monthly rollup (mirrors buildMonthlyBreakdown)

| Metric | Value |
|---|---|
| expenseTotal ("Total 2026-01 spending") | $16.32 |
| incomeTotal | $17,902.60 |
| debtPaymentTotal | $14,500.00 |
| transferTotal | $10,295.56 |
| **Other — monthly category line (`abs(signed net)`)** | **$0.00** |
| Other — drilldown matchedTotal (debits only) | $0.00 |

## Per-category decomposition (settled rows)

Printed = `abs(debits_sum - credits_sum)` — the monthly "categories:" line.
Counted-in-expenseTotal = debits only (spending categories).

| Category | Printed total | Σ debits | Σ credits | In expenseTotal | In prompt categories line | Count |
|---|---|---|---|---|---|---|
| Income | $17,902.60 | $0.00 | $17,902.60 | — (non-spending branch) | no (name-filtered) | 3 |
| Payment | $14,500.00 | $14,500.00 | $0.00 | — (non-spending branch) | no (name-filtered) | 8 |
| Transfer | $3,295.56 | $6,795.56 | $3,500.00 | — (non-spending branch) | no (name-filtered) | 13 |
| Shopping | $16.32 | $16.32 | $0.00 | $16.32 | yes | 1 |

## Every settled "2026-01" Other transaction (0 rows)

Flow type is heuristic (sign + text) — category on all rows is `Other`.
Provenance: plaid = plaidTransactionId set; import = importBatchId set; manual = neither.

| Date | Merchant | Description | Amount | Flow type (heuristic) | Provenance | Account | Path | In expenseTotal | In monthly Other | In drilldown Other |
|---|---|---|---|---|---|---|---|---|---|---|

## Reconciliation

| Quantity | Formula | Value |
|---|---|---|
| Other debits (D) | Σ\|amount<0\| | $0.00 |
| Other credits (C) | Σ amount>0 | $0.00 |
| Monthly "Other" printed | \|C − D\| | $0.00 |
| Other's contribution to expenseTotal | D | $0.00 |
| Drilldown Other matchedTotal | D | $0.00 |
| Month expenseTotal | Σ debits, spending branches | $16.32 |
| Excess of Other over expenseTotal | \|C − D\| − expenseTotal | $16.32 |

## Blast radius — positive rows in spending categories (all dates, this space)

| Category | Positive rows | Σ credits |
|---|---|---|
