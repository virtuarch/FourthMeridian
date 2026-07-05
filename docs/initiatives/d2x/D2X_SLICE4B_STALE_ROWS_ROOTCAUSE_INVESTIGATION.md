# D2.x Slice 4B — Debt History Still Flat — Root-Cause Investigation

**Status:** Investigation only. No implementation.
**Observed:** Christian's Space has `live rows: 3`, `estimated rows: 28`; net worth still inflated historically; Debt Space chart still flat.

## Verdict (up front)

**The failing step is PERSISTENCE, and the category is STALE ESTIMATED ROWS.** The 28 estimated rows were written by an **earlier, pre-Slice-4B backfill run** (Slice 4 held debt flat). `backfillSpaceSnapshots` is **create-if-absent** — it skips any date that already has a row and uses `createMany({ skipDuplicates: true })` — so re-running after Slice 4B writes **0 rows** for those dates. The (correct) liability reconstruction is computed but **never reaches the database**. The charts faithfully render the stale flat-debt rows.

The reconstruction, aggregation, reader, and chart are all **correct** — they are just operating on old rows.

---

## Pipeline trace + per-question answers

### Q1 — Does `reconstructDailyLiabilityBalances()` produce changing balances? **Yes.**
It ADDS daily sums walking back (`owed(d) = owed(d+1) + Σ amount(d+1)`, `backfill-core.ts:118`), proven by the unit tests. Example (Visa owed today = 600; a $120 purchase Jul 2 = FM −120; a $300 payment Jul 1 = FM +300):
```
Jul 4 (today, anchor) : 600
Jul 3 : 600 + Σ(Jul4)=0      → 600
Jul 2 : 600 + Σ(Jul3)=0      → 600
Jul 1 : 600 + Σ(Jul2)=−120   → 480     (owed less before the purchase)
Jun30 : 480 + Σ(Jul1)=+300   → 780     (owed more before the payment)
```
So the function is not the problem.

### Q2 — Are reconstructed balances replacing the balances classified? **Yes, but only for rows that get built — and none are.**
`backfill.ts:227-241`:
```
for (const [dISO, cashMap] of dailyCash) {
  if (existingDates.has(dISO)) continue;          // ← line 233: STALE DATES BAIL HERE
  const cardMap = dailyCardDebt.get(dISO);        // ← override never reached for stale dates
  const dayAccounts = accounts...map(a => cardMap?.has(a.id) ? {...a, balance: cardMap.get(a.id)!} : a);
  ...
}
```
The card override is real and correct — but the `continue` on line 233 fires for **every** date that already has a row. With 28 estimated + 3 live rows already covering the window, every reconstructed day is skipped before the override runs.

### Q3 — Does `classifyAccounts()` read reconstructed or today's balances?
For rows that are built, it reads the **overridden** `dayAccounts` (correct). For the skipped stale dates it is never called. `classifyAccounts` itself is fine.

### Q4 — Does `computeSnapshotFields()` receive changing debt?
For built rows, yes (it would). For this Space, **no rows are built**, so it is never invoked for the affected dates. The debt values that *would* enter it are correct; they simply never get there.

### Q5 — Does `SpaceSnapshot` contain changing debt? **No — the stored rows are the stale flat ones.**
Per your rubric ("flat in DB ⇒ bug before persistence"): the DB holds the **old** rows with flat debt because the new write was **skipped** (`existingDates.has → continue`, and `createMany skipDuplicates` as a second guard, `backfill.ts:258`). The correct values were computed but not persisted. This is the exact failure point.

### Q6 — Does the Debt chart render `snapshot.totalDebt`? **Yes — it reads the snapshot, not current accounts.**
`getRecentSnapshots` maps `totalDebt: r.debt` (`lib/data/snapshots.ts`), `getPortfolioHistory` returns `debt`. `NetWorthChartModal` plots the `totalDebt` series from `s.totalDebt` (`:38, :93`); `BankingChart` plots `Math.max(0, s.totalDebt)` (`:66`). So a flat `totalDebt` column ⇒ flat debt line and inflated `netWorth` (`netWorth = totalAssets − flat_debt`). The reader/chart are correct; they render stale data.

### Q7 — Account-selection gate (verify Chase card is included). **Cannot confirm from code alone — secondary risk.**
`isReconstructableCard` (`backfill.ts`) includes a debt account when `debtSubtype === "credit_card"` OR (`debtSubtype === null` AND `creditLimit != null`). Plaid never writes `debtSubtype`, so the Chase card relies on **`creditLimit != null`**. If Plaid did not return a limit for that card (some sandbox/issuer cases), `creditLimit` is null → the card is **excluded** → debt stays flat *even on a fresh run*. This is the one thing that could keep it flat after the stale rows are cleared — verify `creditLimit` on the Chase FinancialAccount.

### Q8 — Transaction selection.
Card deltas are queried with `pending: false`, `deletedAt: null`, `date ∈ (effectiveStart, today]`, summed per day (`backfill.ts`). Purchases (FM −) lower past owed; payments/refunds (FM +) raise it — correct (Q1). Can't print rows without DB access.

### Q9 — Stale estimated rows? **Yes — this is the root cause. Proof:**
1. `backfillSpaceSnapshots` never overwrites: `if (existingDates.has(dISO)) continue` (`:233`) + `createMany({ skipDuplicates: true })` (`:258`).
2. The Space already has **28 estimated + 3 live = 31 rows** covering the ~30-day window. So on the Slice-4B re-run, `existingDates` contains every reconstructable date → every day is skipped → **0 rows written**.
3. Those 28 rows were produced by the earlier dev-seed run **before Slice 4B existed**, when debt was held flat — hence flat `totalDebt` and inflated `netWorth`. The Slice-4B code path (card override) has never written a row for this Space.

---

## Deliverables

1. **Exact failing step:** persistence — `backfill.ts:233` (`existingDates` skip) and `:258` (`skipDuplicates`) prevent the Slice-4B rows from overwriting the pre-existing flat-debt estimated rows.
2. **Evidence:** the create-if-absent gate (above); charts read `snapshot.totalDebt` (`snapshots.ts`, `NetWorthChartModal:93`, `BankingChart:66`); reconstruction proven correct by unit tests; 28 estimated rows pre-exist → re-run writes 0.
3. **Bug category:** **stale estimated rows** (persistence skip). NOT reconstruction, aggregation, reader, or chart.
4. **Smallest surgical fix (operational, no code change):**
   - `npx tsx scripts/backfill-snapshots.ts --rollback --apply` → deletes all `isEstimated = true` rows (leaves the 3 live rows).
   - `npx tsx scripts/backfill-snapshots.ts --dev-seed-target-spaces-30d --apply` → rebuilds the window; now only the 3 live dates are in `existingDates`, so Slice-4B writes ~27 fresh rows **with** reconstructed card debt.
   - Then verify the Chase card's `creditLimit != null` (Q7); if null, that card also needs its signal resolved before its debt line will move.
   - (A code-level alternative — a `--regenerate-estimated` mode that deletes+rewrites in one step — is optional and not required; the rollback+reseed above already fixes it with existing tooling.)

**Stop — investigation only.**
