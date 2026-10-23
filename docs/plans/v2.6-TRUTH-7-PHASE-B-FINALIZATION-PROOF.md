# Financial Truth Phase B — Final Proof

**Scope:** UI convergence (Part 1–2) + L8 Phase B1 reader cutover (Part 3–4).
**Corpus:** `Chris' Space`, 4,053 banking rows, measured 2026-08-05.
**Gates:** `npm run audit:ui-truth` · `npm run audit:event-cutover` ·
`audit:event-identity` · `audit:lifecycle-identity` — all PASSED.

---

## 1. Files changed

**New authorities (3)**

| File | What it settles |
|---|---|
| `lib/transactions/flow-presentation.ts` | What a row is CALLED — one map, no descriptors |
| `lib/transactions/debt-payment-authority.ts` | Which leg counts as a debt payment |
| `lib/transactions/event-projection.ts` | One row per logical event, and the refusal |

**New reads / tests / audits (6)**
`lib/data/transactions.ts::getDebtPaymentRows` · `flow-presentation.test.ts` ·
`debt-payment-authority.test.ts` · `event-projection.test.ts` ·
`scripts/audit-ui-truth-convergence.ts` · `scripts/audit-event-reader-cutover.ts`

**Migration (1)** — `20260805_l8b1_event_current_projection`: adds only the FK on
`TransactionEvent.currentTransactionId`. Reversible with one `DROP CONSTRAINT`.

**Modified (24)** — drawer, list, slice drawer, DebtClient, DebtPaymentsWidget,
SpaceDashboard, credit page, `liquidity.ts`, `liquidity-breakdown.ts`,
`cash-flow-space-data.ts`, `detail-sections.ts`, `serialize.ts`, `debt.ts`,
`export/csv.ts`, `schema.prisma`, `types/index.ts`, + 8 test files.

**38 files, +2,143 / −164.** 10 commits, `421a930` … `5ce2a37`.

---

## 2. Authority inventory — before vs after

| Question | Before | After |
|---|---|---|
| What is this row called? | **3 maps** (`FLOW_TYPE_LABEL`, `FLOW_GROUP_LABEL`, `humanize()`) + a 4th in `detail-sections` | **1** — `flow-presentation.ts` |
| What kind of income is this? | **2** (income taxonomy, and `classifyLiquidity` re-deriving `OTHER_INCOME`) | **1** — the taxonomy; liquidity consults it |
| How much went to debt? | **4 predicates**, 2 answers ($245,592.37 / $239,592.37) | **1** — `debt-payment-authority.ts` |
| Which row represents this event? | **0** (implicit in `deletedAt`) | **1** — `event-projection.ts` |

**Adoption:** `income-source` 2 → 6 consumers · `flow-presentation` 0 → 6 ·
`debt-payment-authority` 0 → 4 · `event-projection` 0 → 3 reads.

**Silent fallbacks removed: 2.**
`INCOME_REASON_BY_CLASS[…] ?? "EARNED_INCOME"` asserted salary for any income row
whose read supplied no class. `lib/debt.ts totalDebtPaid` abs-summed whatever a
caller passed. Both gone.

---

## 3. UI truth findings — before vs after

| # | Finding | Status |
|---|---|---|
| F1 | `incomeSubtype` emitted, read by nothing | ✅ read by list, drawer, slice drawer, export, detail-sections |
| F2 | Three FlowType label maps | ✅ one; a probe fails the build on a fourth |
| F3 | Two debt totals, $6,000 apart | ✅ **identical at $245,592.37** |
| F4 | `classifyLiquidity` re-derived `OTHER_INCOME` | ✅ consults the taxonomy; `ISSUER_CREDIT` is a named reason |
| F5 | List had no refund/credit vocabulary | ✅ 16 natures, neutral tone for refunds/credits |
| F6 | `DebtClient` filtered on legacy `category` | ✅ filters canonical FlowType |
| F7 | "PAYMENTS story" showed 65 transfers | ✅ renamed "Activity on debt accounts" |
| F8 | Event identity had zero readers | ✅ **B1 cutover** |
| F9 | Exports carried no taxonomy | ✅ `flow_type`, `row_nature`, `transfer_counterparty_account_id` |

**The four named credits** — verified by nature, not by hope:

| Row | Was | Now |
|---|---|---|
| MICROSOFT#G174400309 +$280.45 | Income (green, "+") | **Issuer credit** (neutral) |
| HUNGERSTATION LLC +$18.38 | Income | **Issuer credit** |
| EasyTime +$151.73 | Income | **Issuer credit** |
| Uber +$45.09 | Income | **Issuer credit** |

**Interest:** 45 rows, none render as earned income.

### A tenth finding, discovered by browser verification

`getTransactionDetail` called `serializeTransactionRow(row)` **without
`accountType`**, which the list read supplies. The serializer fell through to
`"other"`, so `liabilityInflowIsIssuerCredit` — which requires `"debt"` — was
always false on that path. **The same row was ISSUER_CREDIT in the list and
EARNED income in the drawer**, decided by which read passed the evidence. Unit
tests could not have caught it; only opening the drawer did. Fixed in `e92b9b4`.

---

## 4. Event reader inventory — before vs after

| Read | Before | After |
|---|---|---|
| `getTransactions` | no projection filter | `eventProjectionWhere()` + guard |
| `getDebtTransactions` | none | filter + guard |
| `getDebtPaymentRows` | *(new)* | filter + guard |
| `queryTransactions` (keyset) | none | inherits filter + guard |
| `countTransactions` | none | inherits filter |
| `getTransactionDetail` | none | **deliberately none** — a superseded row stays inspectable |

The filter lives in `bankingTransactionWhere`, so every population read inherits
it by composition. `INV-18` was **inverted** (not deleted): through Phase A it
asserted no behavioural reader touched event identity; it now asserts the filter
is present and singular.

---

## 5–7. Verification

**Browser** (localhost, authenticated, 5 screens)

| Screen | Verified |
|---|---|
| `/dashboard/credit` | Total Debt Paid **$245,592.37**; disclosure "To accounts not connected here: $6,000.00"; $129,485.07 + $110,107.30 + $6,000 reconciles exactly |
| Drawer — Microsoft | eyebrow "Issuer credit", chip "Issuer credit", neutral $280.45, "What: Issuer credit · Inflow", "Flow type: Income" |
| Drawer — interest | "Interest earned", green (it *is* a gain) |
| Transactions list | "Issuer credit" chip, `$280.45` with no misleading "+"; internal transfer shows ONE chip |
| Cash Flow | Net −$4,396, In +$10,579, Out −$14,975 — identical before and after the cutover |

**API** — `GET /api/transactions/[id]` returns `incomeSubtype`, `transactionEventId`
and the `eventIdentity` provenance block; the drawer renders from them.

**Corpus** — `audit:event-cutover`:

```
transaction count      4053  →  4053   ✓
Cash In         $273,702.51  →  $273,702.51   ✓
Cash Out        $247,104.41  →  $247,104.41   ✓
Net Cash Flow    $26,598.10  →   $26,598.10   ✓
Income          $274,198.40  →  $274,198.40   ✓
Spending        $215,722.86  →  $215,722.86   ✓
Refunds           $5,460.22  →    $5,460.22   ✓
Transfers       $310,922.78  →  $310,922.78   ✓
Debt paid       $245,592.37  →  $245,592.37   ✓
```

Rows removed by the filter: **0**. Rows kept with no event: **28** (wallet).
Observations preserved: **4,423**. Events: **4,379**. Multi-observation: **44**,
each projecting at most one live row.

---

## 8. Idempotence

`backfill:event-identity --apply` → `✓ IDEMPOTENT — all 4423 observations already
exist. Nothing to do.` The migration is additive; re-running `migrate deploy` is
a no-op.

## 9. Fingerprints

| Artifact | Value |
|---|---|
| Rows pre-cutover | `649efabfb251fb16` (4,053) |
| Rows post-cutover | **`649efabfb251fb16`** (4,053) — identical |
| Seeded transaction content | `50907b2123fe3a4b797b1a2b244715ab` (352) |

**Gates:** suite **470/470** · tsc **0 errors** · lint **0 errors, 22 warnings**
(pre-existing) · 4 corpus audits PASSED.

---

## 10. Remaining Financial Truth defects

1. **⚠️ The $4,000 Amex HYSA symptom was never reproduced.** The row is correctly
   classified and no debt surface counts it. The HYSA is an **American Express**
   account (`ins_10`) — same institution as `Platinum Card®` — so an
   institution-grouped surface would place it beside Amex debt. **Tell me which
   screen and I'll pin it.**
2. **Crypto scope boundary** — enforced by `walletAddress`, not
   `AccountType.crypto`. 14 observations on manually-tracked crypto *exchange*
   accounts are inside banking L8. Pre-existing; belongs with B6.
3. **`category` remains in exports** for CSV importer round-trip. No exported
   *meaning* depends on it, but the column is still a legacy string.
4. **`counterpartyAccountId` unpopulated for debt payments** (0/303, KD-18 seam),
   so `groupDebtPaymentsByCreditor` still groups by a normalized descriptor.
   Presentation-only, documented in that module.

## 11. Remaining L8 work

Unchanged from the roadmap except B1, now complete.

| Slice | Blocks | Timing |
|---|---|---|
| ~~B1 Reader cutover~~ | — | ✅ **DONE** |
| B2 Balance observations | **Assessment** | After crypto — largest slice |
| B3 Observation history APIs | none | Small; follows B1 |
| B4 Economic-date precedence | none | **Defer** — 4 rows today |
| B5 Provider latency | Attention (partial) | **Time-gated** ~1–2 months |
| B6 Cross-provider lifecycle | none yet | **Before crypto** |
| B7 Crypto event identity | none | *Is* the crypto work |
| B8a/b/c | none | Opportunistic |

**Attention is now unblocked.** Assessment still needs **B2**. Decision Engine is
blocked by nothing in L8.

**Not started, as instructed:** crypto, balance observations, provider latency,
economic-date precedence.
