# V2.6 — Cross-Surface Value Consistency

**Investigation only.** No code, no schema, no data mutation, no regeneration, no commit.
Branch `v2.6`, HEAD `ead846b`. Live corpus: local Postgres, 1,686 snapshots across 5 Spaces.

---

## 1. The headline discrepancy, decomposed

**Investments, 2025-11-03 — headline $32,820.13 vs chart/panel $30,338.00. Delta $2,482.12.**

| side | authority | value |
|---|---|---|
| headline | `getInvestmentsTimeMachine` (A10) → `portfolio.valuedSubtotal` | **32,820.13** |
| chart | `portfolio-series` → `SpaceSnapshot.stocks + .crypto` | **30,338.00** |
| panel | HistoricalNode `investments` root → stored `total` | **30,338.00** |

### Line item

| component | A10 | snapshot | delta |
|---|---|---|---|
| crypto | 26,586.46 | 26,586.46 | **0.00** |
| securities | 6,233.66 | 3,751.54 | **2,482.12** |

Crypto agrees to the cent. The entire delta is securities. Per account:

| account | A10 | ownership evidence begins |
|---|---|---|
| Limit Liability Company | 3,284.85 | 2025-07-31 |
| Robinhood individual | 466.69 | 2025-08-27 |
| **Individual** | **2,482.12** (6 positions) | **2026-05-26** |

LLC + Robinhood = **3,751.54** = the snapshot's `stocks` exactly.

**The delta IS the `Individual` account**, back-projected onto a date seven months before any
evidence says those positions were owned.

### Financial meaning

A10 answers *"today's positions, priced on 2025-11-03."*
The snapshot answers *"the positions you actually held on 2025-11-03, priced that day."*

The second is the question a historical chart asks, and the V26 arc (`ed6fb61` ownership,
`42b9cbb` holdings) exists specifically to make it answerable. A10 predates that work and was
never converged onto it.

### Structural cause

`investments-time-machine.ts:89` calls `getInvestmentValueAsOf({ …, holdConstantBeforeEarliest:
true })` **directly** — the valuation engine WITHOUT the ownership gate. The snapshot path calls
`historicalHoldingsForWindow`, which composes the *same* valuation engine *with* per-(account,
instrument) ownership licensing and returns only the HELD set.

One engine, two entry points, one of which skips the licence.

---

## 2. The second, smaller cause: frozen rows

| date | frozen | Δ total | Δ securities | Δ crypto |
|---|---|---|---|---|
| 2025-08-03 | no | 3,248.72 | 3,248.72 | 0.00 |
| 2025-11-03 | no | 2,482.12 | 2,482.12 | 0.00 |
| 2026-01-01 | no | 2,172.15 | 2,172.15 | 0.00 |
| 2026-06-25 | no | **0.00** | −0.00 | 0.00 |
| 2026-07-20 | **yes** | 145.15 | −0.00 | **145.15** |
| 2026-07-28 | no | 0.00 | 0.00 | 0.00 |
| 2026-08-04 | **yes** | 21.09 | 14.59 | 6.50 |

Two clean regimes:

- **Before 2026-05-26** (Individual's ownership floor) — large securities deltas, entirely that
  account. After it, securities agree to the cent.
- **On frozen rows** (`isEstimated=false`) — small deltas where A10 recomputes from the price
  archive while the snapshot holds the value OBSERVED that day. The snapshot is authoritative;
  recomputing an archived close against a frozen observation is the thing `a80766c` forbade.

Neither is rounding. Every figure above is a raw value; nothing is concealed by `$20.3K`
formatting.

---

## 3. Cross-lens surface matrix

| lens | headline authority | date behaviour | agrees with its chart? | labelled? |
|---|---|---|---|---|
| **Net Worth** | `computeWealthTimeMachine(snapshots)` | follows `asOf` | **yes, by construction** — hero and chart take the same `result` | n/a |
| **Assets / Liabilities / Liquid NW** | same `result`, metric-switched | follows `asOf` | yes | n/a |
| **Debt** | `computeDebtKpis(accounts)` — CURRENT balances | stays current | different question | **yes** — *"· current balances"* + *"Balances are current — the trend and verdict below reflect {asOf}"* |
| **Liquidity** | current sources | stays current | different question | **yes** — *"reachable right now"* |
| **Investments** | A10 (historical) / contract (current) | **swaps at `asOf < today`** | **NO — 8% apart at 2025-11-03** | says *"· as of {asOf}"*, so it CLAIMS the date |

**Investments is the only lens that violates the governing invariant**, and it does so in the worst
way available: Debt and Liquidity show a current number and *say so*; Investments claims the
selected date and then reports a different number than the chart beside it for that same date.

Net Worth is immune by construction — hero and chart consume one `result` object.

---

## 4. Canonical contracts (as they stand today)

| metric | current | historical point | historical series | child composition | authorisation |
|---|---|---|---|---|---|
| Net Worth | `computeWealthTimeMachine` | HistoricalNode `net-worth` | snapshots | 6 buckets | `aggregateAuthorisation.netWorth` |
| Assets | same | `assets` root | snapshots | 5 asset buckets | `.totalAssets` |
| Liquid NW | same | `liquid-net-worth` root | snapshots | cash + savings − debt | `.netLiquid` |
| **Investments** | Investments contract | **`investments` root (`total`)** | `portfolio-series` | Securities + Crypto | `.total` |
| Crypto / Cash / Savings / Debt | contract per lens | bucket root | snapshots | accounts | component |
| Liquidity | liquidity lens | `liquidity` root | snapshots | tiers | `.totalAssets` |

Chart and panel already share an authority for every metric. **The gap is the headline layer, and
only for Investments.**

---

## 5. The decision this needs

A10 does not only feed the headline — it feeds the **holdings table**, period **flows**,
**reconciliation** and the **trust envelope** on the same screen. So the fix is not one number.

**Option A — point the Investments hero at the canonical historical root.**
Smallest change; hero would match chart and panel. But the holdings table below it still comes from
A10 and would still list `Individual`'s six positions, so the hero would disagree with the list that
is supposed to explain it. *Trades one inconsistency for another.*

**Option B — converge A10 onto `historicalHoldingsForWindow`.**
Correct and complete: hero, table, panel and chart all agree, and the ownership doctrine holds
everywhere. But it changes a shipped authority whose flows, period attribution and reconciliation
carry their own V26 invariants (`a80766c`), and every one would need re-verification. *Right answer,
not a small slice.*

**Option C — make the Investments hero explicitly current, as Debt and Liquidity already are.**
Small, honest, consistent with two other lenses. Removes the historical hero rather than fixing it.
*A product decision, not a correctness one.*

**Recommendation: B, sequenced — but A is not acceptable alone**, and C is a legitimate interim if
you want the invariant satisfied this week. I have not implemented any of them: the choice between
"fix the historical view" and "stop claiming to have one" is yours, and guessing it would ship a
product decision disguised as a bug fix.

---

## 6. Suggested slices (once the option is chosen)

**If B:**

1. **A10 ownership convergence** — `investments-time-machine.ts` consumes
   `historicalHoldingsForWindow` instead of calling `getInvestmentValueAsOf` directly. Holdings,
   subtotal and counts follow the HELD set; excluded positions surface through the existing
   composition-state vocabulary. Re-verify flows, attribution and reconciliation.
2. **Frozen-row honour** — on `isEstimated=false`, A10 reports the recorded value rather than
   recomputing an archived close.
3. **Standing cross-surface probes** (below).

**If C:** relabel the hero and drop `data.historical` from the headline path; keep A10 for the
holdings table with its own explicit date label.

---

## 7. Standing consistency probes (read-only, reusable)

No second valuation engine — each probe compares two existing authorities:

1. `portfolio-series(D)` === `investments` root — **passes today**
2. `investments` root === Securities + Crypto — **passes today**
3. Net Worth chart point === `net-worth` root
4. Debt chart point === `debt` root === Σ accounts
5. Liquid NW chart point === authorised `netLiquid`
6. **headline(D) === the canonical contract for the date it CLAIMS** — *fails today for Investments*
7. no surface asserts an aggregate the authorisation refuses
8. frozen rows are never recomputed from the archive

Probes 1, 2 and 8 are already expressible against existing tests; 6 is the one that would have
caught this.

---

## 8. Production considerations

- **Code-contract defect** (A10 ownership) — fixed by deployment, no data change. Present in
  production wherever an account's ownership floor postdates a viewed date.
- **Frozen-row divergence** — code-contract, no data change.
- **Not** a case for the `86f3b74` regeneration repair: the snapshots are right; A10 is the outlier.
- Standing requirement unchanged: local repair does not imply production is repaired — deploy the
  history code, run the read-only audit, apply only what it reports, prove a zero-write second pass.

---

## 9. Database safety

Read-only throughout. Snapshot fingerprint `07b5773127558461e834d5195bb86424`; transactions 4,438;
prices 9,036; reconstructions 23 — recorded before and after, unchanged. No code committed.
