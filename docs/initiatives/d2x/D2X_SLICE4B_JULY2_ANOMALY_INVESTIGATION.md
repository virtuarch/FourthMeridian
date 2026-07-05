# D2.x Slice 4B — July 2 Net-Worth/Assets Anomaly — Investigation

**Status:** Investigation only. No implementation.
**Space:** `cmr456dtb0004117fjb6qavmm` (Christian).
**Symptom:** the assets/net-worth line dips *before* July 2 and returns to normal after the July 2 payroll.

**Access note:** the dev DB is on `localhost` and this environment has no DB route/`psql`/`pg`/working `tsx`, so I cannot print the actual rows. Below are the exact queries to run, plus a code-narrowed diagnosis that already rules several candidates in and out.

---

## Queries (run on your machine — Prisma Studio, `psql`, or a tsx script)

`SpaceSnapshot` maps `spaceId → "workspaceId"` and is table `"WorkspaceSnapshot"`; `SpaceAccountLink.spaceId` is also `"workspaceId"`; `Transaction`/`FinancialAccount` are unmapped.

**Q1 — snapshot rows:**
```sql
SELECT date, cash, savings, debt, stocks, crypto, "totalAssets",
       "netWorth", "netLiquid", "isEstimated"
FROM "WorkspaceSnapshot"
WHERE "workspaceId" = 'cmr456dtb0004117fjb6qavmm'
  AND date BETWEEN '2026-06-28' AND '2026-07-04'
ORDER BY date;
```
**Q3 — included accounts:**
```sql
SELECT fa.id, fa.name, fa.institution, fa.type, fa.balance,
       fa."creditLimit", fa."debtSubtype"
FROM "FinancialAccount" fa
JOIN "SpaceAccountLink" sal ON sal."financialAccountId" = fa.id
WHERE sal."workspaceId" = 'cmr456dtb0004117fjb6qavmm'
  AND sal.status = 'ACTIVE' AND fa."deletedAt" IS NULL
ORDER BY fa.type, fa.name;
```
**Q4 — per-day sums (checking/savings/credit):**
```sql
SELECT t.date, fa.name, fa.type, SUM(t.amount) AS day_sum, COUNT(*) AS n, bool_or(t.pending) AS any_pending
FROM "Transaction" t
JOIN "FinancialAccount" fa ON fa.id = t."financialAccountId"
JOIN "SpaceAccountLink" sal ON sal."financialAccountId" = fa.id
WHERE sal."workspaceId" = 'cmr456dtb0004117fjb6qavmm' AND sal.status='ACTIVE'
  AND fa.type IN ('checking','savings','debt')
  AND t.date BETWEEN '2026-07-01' AND '2026-07-04' AND t."deletedAt" IS NULL
GROUP BY t.date, fa.name, fa.type ORDER BY fa.name, t.date;
```
**Q5 — transaction detail:** same JOINs, `SELECT t.date, fa.name, fa.type, t.merchant, t.description, t.amount, t.category, t."flowType", t.pending` (drop the GROUP BY).

**Q2 — deltas:** from Q1, compute per-adjacent-day `Δcash, Δsavings, Δdebt, ΔtotalAssets, ΔnetWorth`. Whichever component's Δ swings at the July 1→2 / 2→3 boundary is the culprit.

---

## Code-narrowed diagnosis (what the symptom already tells us)

### The anomaly is in **assets**, and investments are held flat → it is a **cash/savings** or **boundary** effect, not debt.
`totalAssets = cash + savings + stocks + crypto + realAssets` (no debt). Slice 4B reconstructs debt, which affects `netWorth`/`netLiquid` but **not** `totalAssets`. So if the **assets** line dips at July 2, debt reconstruction and the pending-asymmetry (below) are **not** the cause — look at cash/savings and the estimated↔live boundary.

### Candidate ruling (Q7):
- **Payroll sign inverted — NO.** Inverted signs make pre-payday balances *higher*. The observed *dip* (lower before payday) is what **correct** signs produce (§ "largely correct" below). Rules sign-inversion out.
- **Card payment on card side but not cash side — N/A to assets.** Debt isn't in assets.
- **Pending included on cash, excluded on debt — REAL code asymmetry, but affects DEBT only.** Confirmed: cash query has no pending filter (`backfill.ts:174`), card query uses `pending:false` (`:208`). This can distort the **debt/netWorth** curve near recent dates, but **not the assets line**. Flag for a separate consistency fix; not the assets-dip cause.
- **Transfer to investment counted in cash while investment flat — possible, but produces *higher* past assets (double-count), not a dip.** If checking→brokerage happened before July 2, past cash is reconstructed higher while flat investment already includes it → assets *inflated* before, not dipped. Direction doesn't match a dip; check Q5 for such a transfer only to exclude it.
- **Debt/cash misclassification — checkable via Q3.** If a card shows `type='checking'` (misclassified), its owed balance would be added to assets. Confirm each account's `type` in Q3.
- **Live-vs-estimated discontinuity — STRONG candidate.** Live rows (`regenerateSpaceSnapshot`) use **real current** balances for *every* class (via `getAccounts`+`classifyAccounts`); estimated rows reconstruct cash but hold **investments/crypto/manual/non-card-debt flat at TODAY's values**. If the estimated segment (≤ some date) meets the live segment (recent days) at July 2, and today's non-cash ≠ the non-cash on the live-row date, the two segments **don't line up** → a step/dip exactly at the junction. You have **3 live + ~27 estimated** rows, so this junction is right in the July 2–4 window.
- **Live-row timing — STRONG candidate.** Live rows are snapshots taken at specific moments. If a July 2 live snapshot was generated **intraday, before payroll posted**, that row legitimately holds low cash; July 3/4 live rows (post-payroll) are normal → a one-day July 2 dip that the backfill can't touch (it never overwrites live rows).
- **Timezone/date bucketing — possible.** `Transaction.date` is `@db.Date`; the reconstruction buckets by `isoDate` (UTC). If a July 2 payroll posted near midnight and bucketed to July 1 or July 3, the step lands one day off. Q5's `date` values will show this.

### The dip is *largely correct*.
Pre-payday cash is genuinely lower, and the reconstruction subtracts the payroll walking back (verified in prior investigations). So a lower assets/net-worth line **before** July 2 that recovers **at** payday is the expected, accurate shape — not necessarily a bug. The only thing to determine is whether the **shape at the exact boundary** is distorted by the two strong candidates above.

## Q6 — arithmetic template (fill from Q3 balance + Q4 sums)

For the checking account (anchor = its current `balance` `B`):
```
Jul 4 (anchor) = B
Jul 3 = B − S(Jul4)
Jul 2 = B − S(Jul4) − S(Jul3)
Jul 1 = B − S(Jul4) − S(Jul3) − S(Jul2)
```
Compare each to the Q1 `cash` value **for the ESTIMATED days only**. For any **live** day, the reconstruction does **not** apply — the stored value is whatever `regenerateSpaceSnapshot` captured at that time. A mismatch that appears **only** where `isEstimated` flips confirms the live-vs-estimated boundary.

## Decision rule

1. **Q1 `isEstimated` column:** if the dip day (July 2) is `isEstimated=false` (live) while its low neighbor July 1 is `isEstimated=true` — and the jump sits exactly on that flip — it is a **live-vs-estimated discontinuity / live-row timing** issue.
2. **Q2 component deltas:** if `Δstocks`/`Δcrypto` are non-zero across the boundary, that is the flat-vs-live non-cash mismatch (discontinuity). If only `Δcash` moves and Q4 shows a real July 2 cash outflow, it is a genuine transaction (or a mis-dated one — check Q5 `date`).
3. **Q4/Q5:** if there is **no** large July 2 cash transaction, the dip is not a transaction — it is boundary/timing.

## Conclusion (ranked, pending the query output)

Most likely: **live-vs-estimated discontinuity / live-row timing** (assets line, boundary in the July 2–4 window where 3 live rows meet estimated rows; estimated rows hold non-cash flat at today's value while live rows captured real values, and/or a July 2 live row was taken pre-payroll). The underlying pre-payday cash dip is **correct**. Classification: **live-vs-estimated discontinuity** (with a possible **transaction-date/bucketing** contributor — confirm with Q5).

Explicitly **not** the cause of the *assets* dip: sign inversion, debt reconstruction, and the pending asymmetry (that one is a real but **debt-only** code smell).

## Smallest safe fixes (candidates — not implemented)

- If **live-row timing** (a bad intraday July 2 live row): regenerate that single day's live snapshot (`regenerateSpaceSnapshot(spaceId, July2)`), or accept it as real history. No backfill change.
- If **estimated/live non-cash discontinuity** matters visually: out of Slice 4B's scope (it is the known "non-cash held flat" limitation surfaced at the junction); the honest remedy is the deferred investment/liability history work, not a cash/debt change. The estimated badge already labels these rows.
- **Separate, worth doing regardless:** align pending handling between the cash and card walks (both include or both exclude pending) — a one-line consistency fix that removes the confirmed debt-side asymmetry (does not affect the assets dip).

**Stop — investigation only. Run Q1–Q5 to confirm which of the two ranked causes it is.**
