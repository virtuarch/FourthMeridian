# D2.x — Month-Long Assets Inflation — Root-Cause Investigation

**Status:** Investigation only. No implementation. No snapshot changes. No July 2 repair.
**Space:** `cmr456dtb0004117fjb6qavmm`.
**Symptom:** Assets sit ~$16–17k all month (expected ~$10k), and a ~$5.2k July 2 paycheck barely moves the line. `derivedRealAssets = 0`, `crypto = 0`.

**Access:** local DB unreachable from here — code facts (Q3, Q5, Q6) are proven from source; Q1/Q2/Q4/Q7 have exact queries. But the *reported numbers already pin the cause* (see below).

---

## The numbers pin it (before any query)

You reported: the partial July 2 **live** row had `cash = 1152.30`; adjacent (estimated) rows have `cash = 6438.95`.
- Your real **checking** ≈ Chase $900 + Amex $252 = **$1,152** — which is *exactly* the July 2 live `cash` (1152.30).
- The estimated rows' `cash` = **6438.95**. The difference **6438.95 − 1152.30 = $5,286.65 ≈ your ~$5.2k paycheck.**

So the `cash` column (checking) on the estimated days is **your real checking + the paycheck**, and the assets add up as: `cash 6438 + savings ~3309 + stocks ~5500 + 0 + 0 ≈ $15–16k` — vs expected `1152 + 3309 + 5500 ≈ $10k`. **The entire ~$5–6k excess is the paycheck, sitting in reconstructed checking cash.** That is not a double-count and not an aggregation bug — it is the **cash reconstruction holding the paycheck in place because the payroll transaction is missing from the synced history.**

Why "the paycheck barely moves the chart": the reconstruction steps cash using transactions; with **no payroll transaction**, there is no July 2 step — the whole month is held at today's post-paycheck level.

---

## Q3 — Full aggregation path (code-proven; every addition)

```
SpaceAccountLink (ACTIVE, financialAccount.deletedAt = null)
  → getAccountsWithVisibility (lib/data/accounts.ts): links.map(link → one account)   // 1 link ⇒ 1 account
  → classifyAccounts (lib/account-classifier.ts):
       totalChecking      = Σ balance(type='checking')
       totalSavings       = Σ balance(type='savings')
       totalLiquid        = totalChecking + totalSavings
       totalInvestments   = Σ balance(type='investment')
       totalDigitalAssets = Σ balance(type='crypto')
       totalRealAssets    = Σ balance(type='other')
       totalLiabilities   = Σ max(0, balance(type='debt'))
       totalAssets        = totalLiquid + totalInvestments + totalDigitalAssets + totalRealAssets   // line 139
       netWorth           = totalAssets − totalLiabilities                                          // line 140
  → computeSnapshotFields (backfill-core.ts) / regenerate.ts (same arithmetic):
       cash=totalChecking, savings=totalSavings, stocks=totalInvestments, crypto=totalDigitalAssets,
       debt=totalLiabilities, realAssets=totalRealAssets
       totalAssets = (stocks+crypto) + cash + savings + realAssets
  → SpaceSnapshot.totalAssets
```
**Every addend is a distinct account-type sum.** There is no term that adds an account into two buckets, and `totalAssets` never includes `debt` (Q6).

## Q2 & Q5 — Double-counting: ruled out at the link level; only duplicate-FA remains (a data check)

- **`SpaceAccountLink` has `@@unique([spaceId, financialAccountId])`** (schema). So the same FinancialAccount **cannot** be linked twice in one Space — `getAccounts` returns it once, `classifyAccounts` sums it once. **Duplicate-link double-count is structurally impossible.**
- `getAccounts` reads **only** `SpaceAccountLink` (one aggregation path) — there is no separate "ownership + share" path that could add an account again.
- The **one** remaining structural double-count is **two different `FinancialAccount` rows for the same real-world account** (e.g. a reconnect that created a new FA instead of reusing — reconcile.ts guards this but a gap could leave a duplicate). Each would have its own unique link and be summed. **Check with the Q2 query below.** However, a duplicate investment FA would inflate **`stocks`**, not `cash`; your excess is in `cash` and equals the paycheck, so this is **not** the driver here — but confirm it's clean.

## Q6 — Do liabilities leak into totalAssets? **No — proven.**

`lib/account-classifier.ts:139` `totalAssets = totalLiquid + totalInvestments + totalDigitalAssets + totalRealAssets` — **liabilities are not a term.** `:140` `netWorth = totalAssets − totalLiabilities`. Debt affects **only** `totalLiabilities`/`netWorth`, never `totalAssets`. (And liabilities use `max(0, balance)`, so an overpaid card can't become a negative that subtracts from assets either.)

## Q1 / Q4 / Q7 — Confirm with these queries (the answer will be in `cash`)

**Q1 — components per day (the diagnostic already prints these):** `cash, savings, stocks, crypto, derivedRealAssets, totalAssets`. By construction `cash+savings+stocks+crypto+derivedRealAssets == totalAssets` (realAssets is the only non-stored term; it's the remainder, and you already saw it = 0). **Look at the `cash` column across the month:** if it sits ~$6,438 (≈ real checking + paycheck) rather than ~$1,152, the inflation is in reconstructed checking cash — the missing-payroll signature.

**Q7 — does the payroll transaction exist? (the decisive query):**
```sql
SELECT fa.name, fa.type, t.date, t.merchant, t.amount, t.pending
FROM "Transaction" t
JOIN "FinancialAccount" fa ON fa.id = t."financialAccountId"
JOIN "SpaceAccountLink" sal ON sal."financialAccountId" = fa.id
WHERE sal."workspaceId" = 'cmr456dtb0004117fjb6qavmm' AND sal.status='ACTIVE'
  AND fa.type='checking' AND t.amount > 3000
  AND t.date BETWEEN '2026-06-25' AND '2026-07-05'
ORDER BY t.amount DESC;
```
**If this returns no ~$5.2k deposit → the payroll transaction is missing → root cause confirmed.**

**Q4 — today's per-account running total (reveals any extra/duplicate contributor):**
```sql
SELECT fa.name, fa.institution, fa.type, fa.balance, fa."creditLimit", fa."debtSubtype"
FROM "FinancialAccount" fa
JOIN "SpaceAccountLink" sal ON sal."financialAccountId" = fa.id
WHERE sal."workspaceId"='cmr456dtb0004117fjb6qavmm' AND sal.status='ACTIVE' AND fa."deletedAt" IS NULL
ORDER BY fa.type, fa.balance DESC;
```
Sum the checking rows: if it's ≈ **$6,438** today (real checking + paycheck), that is the reconstruction anchor — correct for *today*, but the reconstruction can't lower it for prior days without the payroll transaction.

**Q2 — duplicate FinancialAccount check:**
```sql
SELECT institution, mask, type, COUNT(*) c, array_agg(id) ids, array_agg(balance) bals
FROM "FinancialAccount"
WHERE id IN (SELECT "financialAccountId" FROM "SpaceAccountLink"
             WHERE "workspaceId"='cmr456dtb0004117fjb6qavmm' AND status='ACTIVE')
GROUP BY institution, mask, type HAVING COUNT(*) > 1;
```
Any row here = a duplicated account (would inflate its type's bucket). Expected: **empty**.

---

## Root cause (evidence-backed, ranked)

1. **PRIMARY — missing payroll transaction inflates reconstructed cash (not an aggregation bug).** Today's checking balance (the reconstruction anchor) already contains the ~$5.2k paycheck. The cash walk lowers prior days by subtracting each day's transactions (`eod(d)=eod(d+1)−Σ amount(d+1)`), but the **payroll deposit has no transaction row**, so the ~$5.2k is never removed → every estimated day's `cash` is ~$5.2k too high → `totalAssets` ~$5.2k too high all month, with **no** July 2 step. The `6438.95 − 1152.30 ≈ $5,287 ≈ paycheck` arithmetic is the fingerprint. Confirm with the Q7 query.
2. **Secondary/complementary — the deeper "why" is transaction-history incompleteness on Chase checking** (likely the same partial/failed sync behind the July 2 balance issue, or the payroll posting after the last sync / outside the cursor window). This is a *data/sync completeness* issue upstream of the snapshot, not the snapshot code.
3. **Ruled out:** duplicate SpaceAccountLink (unique constraint), liabilities-in-assets (Q6 proof), and — pending the Q2 query — duplicate FA (which would show in `stocks`, not `cash`; your excess is in `cash` and matches the paycheck).

## Is there an aggregation bug? **No.** So the smallest fix is NOT in aggregation.

`classifyAccounts` / `computeSnapshotFields` are correct and single-count. The problem is a **reconstruction input**: the payroll transaction is absent, so the cash walk can't reduce today's anchor. The genuine remedies (out of scope here, listed for direction):
- **Data:** re-sync Chase checking fully so the ~$5.2k payroll transaction is present, then re-run the backfill — the reconstruction will then correctly step cash down before July 2.
- **Reconstruction hardening (future):** the cash walk is only as accurate as the transaction history; when transactions don't reconcile to the balance delta, the reconstructed series drifts. This is the known "estimated is only as good as available transactions" limitation (already labeled `isEstimated`).

## Critical implication for the July 2 repair — **do not run it yet**

Repairing July 2 by deleting the live row and re-reconstructing it would recompute July 2 with the **same** inflated cash (~$6,438), because it uses the same today's-anchor-minus-missing-payroll walk. That would **remove the visible one-day cliff but at the inflated level** — hiding the symptom while the whole month stays ~$5.2k high. **Resolve the missing-payroll transaction (Q7) first;** only then is repairing/reconstructing July 2 meaningful.

**Stop — investigation only. Run the Q7 query to confirm the missing payroll transaction; the fix is transaction completeness, not aggregation.**
