# D2.x Slice 4 — Estimated History Reality Check — Investigation

**Status:** Investigation only. No implementation.
**Symptom:** Christian was paid ~$2,800 on July 2; pre-payday cash was much lower; the estimated chart instead shows ~$9,800 in early June (≈ today's $7,000 + one payroll). That is `today + payroll`, i.e. the payroll appears to be **added** going back, not removed.

Every claim below cites the code.

---

## 1. Starting value (anchor)

Per **account current balance** — `FinancialAccount.balance` — for cash accounts only, not Space net worth:

```
lib/snapshots/backfill.ts
  const accounts = linkRows.map(l => ({ id, type, balance: l.financialAccount.balance }));  // current balance
lib/snapshots/backfill-core.ts:70
  const running = new Map(cashAccounts.map(a => [a.id, a.balance]));   // running = eod(today) = current balance
```
So day N (today) = each cash account's live balance. Non-cash accounts are anchored at their current balance too, but held flat (§5).

## 2. Reverse walk — exact formula

`lib/snapshots/backfill-core.ts:72-79`:
```
for (let d = today-1; d >= start; d--) {
  const dPlus1 = d + 1;
  sum = Σ Transaction.amount for that account dated dPlus1;
  running[acct] = running[acct] - sum;     // ← SUBTRACT
  out[d] = running;
}
```
So: **`eod(d) = eod(d+1) − Σ amount(txns dated d+1)`**. Not `day(n) − transactions(day n)`; it's the *next* day's transactions being removed to step backward (equivalent recurrence, correct indexing).

## 3. Transaction sign

- **Plaid:** positive = debit (money **out**), negative = credit (money **in**) — `lib/plaid/syncTransactions.ts:213-214`.
- **Fourth Meridian stored sign:** `const amount = -txn.amount` (line 215) → **positive = money IN, negative = money OUT**.
- **Confirmed by every other consumer:** transactions assembler `if (INCOME && amount > 0) incomeTotal += amount; if (amount < 0) expenseTotal += |amount|`; flow-classifier `amount > 0 → INFLOW`; plaid-category "amount > 0 = money into the account". So a **payroll deposit is stored POSITIVE (+2,800)**.
- The reconstruction **assumes this same FM convention** and subtracts it. So it is internally consistent with the rest of the app **iff** the summed rows are FM-signed (which Plaid sync and CSV import both guarantee — `lib/imports/csv.ts:488`).

## 4. Account selection (exact)

`lib/snapshots/backfill.ts`:
```
const cashAccounts = accounts.filter(a => a.type === "checking" || a.type === "savings");
```
Only **checking** and **savings** are reverse-walked. Everything else is passed to `classifyAccounts` at its **current** (flat) balance:

| Type | In cash walk? | Historical treatment |
|---|---|---|
| Checking | ✅ | reconstructed from transactions |
| Savings | ✅ | reconstructed from transactions |
| Credit cards (`debt`) | ❌ | **held flat** at today's balance |
| Brokerage (`investment`) | ❌ | **held flat** |
| Retirement (`investment`) | ❌ | **held flat** |
| Crypto (`crypto`) | ❌ | **held flat** |
| Manual assets (`other`) | ❌ | **held flat** |
| Loans (`debt`) | ❌ | **held flat** |

## 5. Cash vs net worth

It reconstructs **cash history per account**, then aggregates the whole snapshot via `classifyAccounts` + `computeSnapshotFields` (identical to `regenerate.ts`). So every stored field is written per day: `cash/savings` are reconstructed; **`stocks/crypto/debt/realAssets` are today's values repeated on every past day.**
- **Investments:** frozen at today's value (no price history exists).
- **Liabilities:** frozen at today's value — **a debt paydown after the window start is not reflected; past debt is under-stated, so past net worth is over-stated.**

The chart reads either `cash` (`cashMode`) or `netWorth` from these rows (`NetWorthChart` → `s.totalCash` / `s.netWorth`). Which one Christian is viewing matters (§11).

## 6. Are today's balances simply carried backward?

No for cash — they are carried backward **minus the intervening transactions** (§2). A checking account at $7,000 today becomes $9,800 a month ago **only if** the net of the transactions removed while walking back is **−$2,800** (i.e. subtracting a net **−2,800**). With correct FM signs, a $2,800 payroll inflow is **+2,800**, and subtracting **+2,800** gives **$4,200**, not $9,800. So $9,800 requires the removed net to be negative — see §7/§10.

## 7. Missing payroll — why higher instead of lower

A $2,800 payroll on July 2 (FM **+2,800**) *should* make pre-July-2 cash **lower**: `eod(July1) = eod(July2) − (+2,800) = $4,200`. That is exactly what the code computes **when the deposit is stored +2,800**.

The chart shows **higher** (`$7,000 + $2,800 = $9,800`) only if the code subtracted **−2,800** — i.e. the deposit's summed amount is **negative** (raw-Plaid sign), so `running − (−2,800) = running + 2,800`. **The reverse walk cannot turn a correctly-signed (+) payroll into a higher past balance; it can only do so if the payroll is effectively negative in the summed data.**

## 8. Double counting / transfers

- **Double counting:** none in the cash walk — `groupBy(financialAccountId, date)._sum.amount` sums each transaction once, per its own account/day.
- **Transfers between two cash accounts:** appear as −X on one and +X on the other; reconstructed independently, they **net to zero** at the Space cash total. No inflation.
- **Transfer from checking → a non-cash account** (e.g. brokerage): checking is reduced (−X out), the brokerage side isn't in the cash walk and is held flat at a value that *already includes* that X. So at the **net-worth** level the moved money is counted twice historically (in past cash **and** in flat brokerage). This inflates **past net worth**, not cash.

## 9. Credit cards

Credit accounts are `type === "debt"` → **excluded from the cash walk**, so no card transaction directly writes cash. A card **payment** appears on the *checking* account as money **out** (FM −); walking back, `− (−X) = +X`, so pre-payment checking is correctly **higher** (you held the cash before paying). That is correct for a cash chart. The card's own balance is held flat (§5) — the real distortion cards cause is in **net worth via flat debt**, not in cash.

## 10. Worked arithmetic (illustrative — I cannot read the live rows here)

Checking today = **$7,000**; payroll **July 2**; today = July 4.

**(a) With the CORRECT FM sign (payroll = +2,800):**
| Day | Removed (txns of next day) | Balance |
|---|---|---|
| Jul 4 (today, anchor) | — | 7,000 |
| Jul 3 | − Σ(Jul 4)=0 | 7,000 |
| Jul 2 | − Σ(Jul 3)=0 | 7,000 |
| **Jul 1** | − Σ(Jul 2)=**+2,800** | **4,200** |
| Jun 30 | − Σ(Jul 1)=0 | 4,200 |
→ early June ≈ **$4,200 (LOWER)** — matches reality.

**(b) The scenario that reproduces the bug ($9,800): payroll summed as −2,800:**
| Day | Removed | Balance |
|---|---|---|
| **Jul 1** | − (**−2,800**) | **9,800** |
| Jun 30 | 0 | 9,800 |
→ early June ≈ **$9,800 (HIGHER)** — matches the symptom **only** with a negative deposit.

So the observed number is reproduced *exactly* when the deposit's stored/summed `amount` is negative.

## 11. Conclusion

**The reverse-walk cash math is mathematically correct for the codebase's FM sign convention** (`+in/−out`, verified in §3). Applied to correctly-signed data it yields **lower** balances before a payroll (§10a) — the opposite of the symptom. So the flaw is **not** the subtract-formula; do **not** flip it to addition (that would corrupt all correctly-signed data).

The `$9,800` (higher-by-one-payroll) can only come from one of two wrong assumptions:

- **Most likely, if the chart is NET WORTH:** the flaw is **holding liabilities (and investments) flat** (§5, §8). A credit-card/loan **paydown after the window start** leaves past debt under-stated, inflating past net worth — and a checking→investment move double-counts (§8). This is a real, structural limitation of the "non-cash flat" design, and it inflates *history* by roughly the amount moved/paid down (which can equal the payroll if the payroll was used to pay a card).

- **If it is genuinely CHECKING CASH showing higher:** the transactions summed for that account are **effectively negative-signed for deposits** (raw-Plaid, not FM). The reverse walk then *adds* the payroll. The wrong assumption would be "*the summed `Transaction.amount` is FM-signed*." This should be confirmed against the actual rows, not assumed.

**Cannot be settled by code alone — two targeted checks will decide it (I can't query the DB from here):**
1. Which line is wrong — `cash` (`cashMode`) or `netWorth`? If net worth → prime suspect is flat debt/investments.
2. Pull Christian's checking July 2 payroll row and confirm `amount` sign: **+2,800 ⇒ formula is correct and the data is fine (the curve is right; investigate the net-worth/flat-carry path);** **−2,800 ⇒ the summed data is raw-Plaid-signed and the reverse walk inverts it.**

**Bottom line:** the reverse-walk reconstruction is correct; the estimated-history error is not in that subtraction. The two candidate root causes are (a) flat non-cash inflating net-worth history, and (b) an inverted deposit sign in the summed transactions. Confirm with the two checks above before changing anything.

**Stop — investigation only. No implementation.**
