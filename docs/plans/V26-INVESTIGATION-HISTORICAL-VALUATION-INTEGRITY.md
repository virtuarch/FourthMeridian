# V26 Investigation — Historical Valuation Integrity & Snapshot Reconstruction

**Status:** Investigation only. No code, schema, or data modified. Nothing committed. All database access read-only (`SELECT` only), against **both** the local development copy and **production** (`fourth-meridian-production`, `qirfzvvaeddukjiphims`).
**Repository:** `v2.6` @ `146a0dd`
**Continues from:** `V26-INVESTIGATION-NET-WORTH-ATTRIBUTION-RECONCILIATION.md`

---

## 1 · Executive finding

**Fourth Meridian does not preserve historical financial truth. It reconstructs history after every synchronisation, and the reconstruction is currently producing impossible values.**

In production, for the only Space with data:

| Fact | Value |
|---|---|
| Total snapshots | **737** |
| `isEstimated = true` | **728** |
| `isEstimated = false` (observed) | **9** — and they are the **last 9 days only** (2026-07-22 → 2026-07-30) |
| Snapshots with **negative** `stocks` | **92**, spanning 2026-04-21 → 2026-07-21 |
| Minimum `stocks` ever recorded | **−1,810** |

An investments balance cannot be negative. 92 consecutive days of it were served to the UI as history.

**The three observations reduce to one defect,** at a single line with a missing invariant.

---

## 2 · Snapshot and historical-valuation architecture

```
SYNC (Plaid / btc-sync / import)
   └─ writes CURRENT balances onto FinancialAccount (mutable, no history — V26-F3)
         │
         ▼
BACKFILL  lib/snapshots/backfill.ts
   • cash accounts   → walked back from transactions      (reconstructDailyCashBalances)
   • revolving cards → walked back from transactions      (isReconstructableCard)
   • investments / crypto / manual assets → HELD FLAT at today's value
     (backfill.ts:222-223 — "…stays flat, as do investments/crypto/manual assets")
   • writes rows with isEstimated = true                   (backfill.ts:297)
         │
         ▼
A9 REGENERATION  lib/snapshots/regenerate-history.ts → .core.ts
   • replaces the FLAT investment component with A8 historical valuation
     (getInvestmentValueForWindow → valuedSubtotal)        (regenerate-history.ts:344)
   • FROZEN rule: isEstimated=false rows are never touched  (.core.ts:20-23)
   • NO-FABRICATION rule: no evidence ⇒ keep the flat value (.core.ts:23-26)
   • FLIP rule: stays isEstimated=true unless every component is observed (.core.ts:27-30)
         │
         ▼
SpaceSnapshot (spaceId, date) — one row per day, upserted
         │
         ▼
toState()  lib/wealth/wealth-time-machine.ts:167-182   → charts, deltas, drivers
```

**A8 historical valuation** derives investment value from `PositionObservation` + `PriceObservation` + `InvestmentEvent` reconstruction (`PositionReconstruction`). It is a *derivation*, never an observation — which is why the FLIP rule keeps regenerated rows `isEstimated = true`.

The design is thoughtful. Its honesty rules are explicit and mostly enforced. **One guard is missing.**

---

## 3 · The defect

`lib/snapshots/regenerate-history.core.ts:160`:

```ts
const investments = input.hasInvestmentEvidence ? input.investmentValue : flatInvestments;
```

`input.investmentValue` is A8's `valuedSubtotal`. **It is written unconditionally when any evidence exists — with no non-negativity clamp, no sanity bound, and no tier gate.**

The module's own header commits to *"unknown is preferable to a fabricated value"* (`.core.ts:23-26`), and enforces that when evidence is **absent**. It does not enforce it when evidence is **present but wrong**. A negative reconstructed quantity is not "unknown" — it is fabricated, and it passes straight through.

**[INFERRED — mechanism]** A negative `valuedSubtotal` implies negative reconstructed *quantities*. Position reconstruction walks today's holdings backwards through `InvestmentEvent`s. If the event history is incomplete — a BUY recorded without the offsetting prior history, or sells missing entirely — walking back drives quantity below zero. The schema anticipates exactly this: `PositionObservation.unexplainedQuantity` and `.completeness` **[EXISTS]**. The signal is captured and then not acted upon at the write boundary.

---

## 4 · Observation 1 — the "$4,000–$5,000 sync jump"

**Production, at the estimated → observed boundary:**

| Date | stocks | crypto | cash | debt | Net worth | est |
|---|---|---|---|---|---|---|
| 2026-07-19 | −1,467 | 15,552 | 6,147 | 169 | 20,064 | true |
| 2026-07-20 | −1,473 | 15,662 | 5,726 | 0 | 19,914 | true |
| **2026-07-21** | **−1,562** | 15,942 | 5,726 | 14 | **20,091** | **true** |
| **2026-07-22** | **+5,233** | 15,902 | 5,726 | 14 | **26,847** | **false** |

**Net worth jumps +6,756 in one day. `stocks` swings +6,795.** Cash is unchanged, debt is unchanged, crypto moves −40.

**The jump is none of the mechanisms you listed as candidates.** It is not market movement, not a contribution, not duplicate accounting, not delayed valuation, not missing FX. It is **an estimated reconstruction being replaced by an observed measurement** — the moment the first `isEstimated = false` row lands, three months of negative reconstruction stop being displayed and the true value appears.

The jump magnitude varies by day because the reconstruction error varies. You perceive "$4,000–$5,000"; the boundary here is $6,756.

---

## 5 · Observation 2 — the YTD chart, opening ≈ $516

**Production, 2026-01-01:** `stocks = 516`, `crypto = 15,594`, `isEstimated = true`.

**Your ≈$516 appears verbatim in the data.** It is not a rendering bug — the chart faithfully plotted a stored value that was wrong.

Series through the year:

| Date | stocks | crypto | portfolio | est |
|---|---|---|---|---|
| 2025-12-31 | 516 | 15,594 | 16,110 | true |
| 2026-01-01 | **516** | 15,594 | 16,110 | true |
| 2026-01-15 | 538 | 15,594 | 16,131 | true |
| 2026-02-01 | 431 | 15,594 | 16,025 | true |
| 2026-03-01 | 481 | 15,594 | 16,074 | true |
| 2026-04-21 | *negative from here* | | | true |
| 2026-06-01 | **−1,639** | 15,594 | 13,955 | true |
| 2026-07-01 | **−1,667** | 14,536 | 12,869 | true |
| 2026-07-22 | **+5,233** | 15,902 | 21,135 | **false** |

**Where did the rest of the portfolio go?** Nowhere. It was never reconstructed. A8 could value only a fraction of the holdings on those dates (≈$516 of a portfolio that was actually several thousand), and A9 wrote that fraction over the flat value because *some* evidence existed. The `hasInvestmentEvidence` gate is a boolean — it does not ask *how much* of the portfolio the evidence covers.

**Note on your two quoted figures.** Both appear exactly in production, but on **different bases**: ≈$516 is `stocks` alone on 2026-01-01, while ≈$12,869 is `stocks + crypto` on 2026-07-01. If both came from the same chart, that chart is mixing an investments-only series with a portfolio series — worth confirming separately, and not something I can settle from the database alone.

---

## 6 · Observation 3 — the MTD chart, +$7,870

**Production, 2026-07-01:** `stocks = −1,667`, `crypto = 14,536` → **portfolio = 12,869**. Your quoted opening matches **exactly**.

Closing on 2026-07-28: `stocks 4,968 + crypto 15,307` = **20,275**; on 2026-07-29/30 slightly higher — consistent with your ≈20,739.

So MTD change ≈ **20,7xx − 12,869 ≈ +7,8xx**. Your ≈+$7,870 reconciles.

**Was it real appreciation? No.** Decomposing the +7,870:

| Component | Δ | Cause |
|---|---|---|
| `stocks` | ≈ **+6,635** | **Reconstruction error correction** — from an impossible −1,667 to an observed +4,968 |
| `crypto` | ≈ +1,200 | Genuine market movement |

**You were right, and the earlier investigation's $6,635 is now explained.** That figure was never producible from *local* data — because it lives in **production**, where `stocks` went negative. `4,968 − (−1,667) = 6,635`. Exactly. The previous report proved the invariant `delta ≤ current balance` must hold for a non-negative component; production violates it because the component went negative. The invariant was right; the data broke it.

---

## 7 · Estimated-snapshot lifecycle

| Stage | Behaviour |
|---|---|
| **Created** | By `backfill.ts:297` for every historical day, always `isEstimated: true` |
| **Why** | Only current balances exist (no `BalanceObservation` — V26-F3); history must be inferred |
| **Contents** | Cash + revolving cards walked back from transactions; investments/crypto/manual **held flat at today's value** |
| **Refined** | A9 regeneration replaces flat investments with A8 historical valuation |
| **Survive** | **Indefinitely.** In production, 728 of 737 rows are still estimated — including days from 2024 |
| **Replaced** | Only when a live daily snapshot is written as observed. Production has **9** such days |
| **Flip to observed** | Only when *every* component is observed — historical A8 valuation never qualifies (`.core.ts:27-30`) |
| **Frozen** | Observed rows are never overwritten (`.core.ts:20-23`, `skip-frozen`) — this rule works |

**Are they suitable for historical reporting?** As currently produced, **no**. A row whose investments component is negative is not an estimate; it is an impossibility.

**Should users see them without disclosure?** **No — and today they do.** `WealthState.isEstimated` **[EXISTS]** and is carried on every state and chart point, and `WealthResult.basis` exposes `hasObserved` / `hasReconstructed` (`wealth-time-machine.ts:328-329`). The change ledger never reads any of it (established in the prior investigation). The data to disclose is present and unused.

---

## 8 · Historical valuation quality by asset class

| Class | Source | Status |
|---|---|---|
| **Cash** | walked back from posted transactions off the current balance | **Reconstructed** — anchored on a mutable current balance |
| **Investments** | A8 valuation from `PositionObservation` + `PriceObservation` + reconstruction; flat-held where no evidence | **Reconstructed, currently unsound** |
| **Crypto** | held flat at today's value; **no historical valuation path exists at all** | **Flat-held** — see §8b |
| **Liabilities** | revolving cards walked back; loans/mortgages held flat | **Mixed** — revolving reconstructed, term debt flat |

**Only 9 days in production are Observed. Everything else is Reconstructed, Interpolated, or Flat-held.**

---

## 8b · Crypto has no historical valuation at all — a second, independent defect

**Production `PriceObservation` coverage for Bitcoin:**

| Instrument | Price rows | First | Last | Range |
|---|---|---|---|---|
| BTC — Bitcoin (`CRYPTO`) | **39** | **2026-06-21** | 2026-07-29 | $58,519 – $66,257 |

**Thirty-nine days of BTC price history exist. Nothing before 2026-06-21.** For every day you held BTC prior to that — the entire 2024–2025 history and the first half of 2026 — no price was ever recorded.

This maps exactly onto the snapshot series: `crypto = 15,594` is **identical** on 2025-12-31, 2026-01-01, 2026-01-15, 2026-02-01 and 2026-03-01, and only begins moving in June 2026 — precisely when the first price rows appear.

**Two compounding causes, and the second is the more serious:**

1. **No historical price backfill for crypto.** Prices begin the day collection started, not the day you acquired the asset.
2. **Crypto is excluded from historical revaluation by design.** `regenerate-history.core.ts:14-16` states A9 keeps *"the crypto/real-asset components exactly as backfill computed them"* — and `backfill.ts:222-223` computed them **flat at today's value**. So even with a complete price history, the historical crypto component would still not be revalued. **There is no code path that values crypto as-of a past date.** **[ABSENT]**

**This is why the value "doesn't change until you sync."** A sync writes a new *current* crypto balance onto the account; the next backfill projects that single value backwards across every historical row. The chart therefore shows a flat line that steps whenever you sync — the shape of a value being *restated*, not a price moving.

**Consequence for the charts in §5–§6:** the crypto component of every historical portfolio figure is today's holding valued at today's price, retroactively. Any "portfolio change" spanning a sync boundary includes that restatement as though it were market movement.

**Scope note:** the investments defect (§3) writes an *impossible* value; the crypto defect writes a *knowable-but-not-computed* one. Different severities, same root cause (§10) — the platform infers the past rather than recording it.

## 9 · Time-travel audit

> *"What was my net worth on January 15?"*

Production answers **−10,531** for 2026-01-15, with `stocks = 538` and `isEstimated = true`.

That figure is not what the platform knew on 15 January. It is what today's reconstruction, run against today's account balances and today's position history, currently infers. Re-run the backfill after tomorrow's sync and it can change again — nothing pins it.

**So the product that exists today is the second one:**

> *"What we currently estimate your January 15 net worth probably was."*

And in production that estimate is demonstrably wrong for 92 days, by an impossible amount.

The good news: the mechanism for the first product is already designed. The FROZEN rule means an observed row is permanent. There are simply only 9 of them.

---

## 10 · Root cause analysis

**One architectural gap, not seven bugs.**

> **Fourth Meridian stores current balances and infers the past. It does not observe the past and store it.**

Every listed symptom is a manifestation:

| Symptom | Manifestation of the gap |
|---|---|
| Missing `BalanceObservation` | **The gap itself.** No per-account value history exists (V26-F3 §1) |
| Snapshot regeneration | The compensation for the gap |
| Valuation estimation | The compensation for the gap in the investments component |
| Historical reconstruction | The compensation, generalised |
| Missing `PositionObservation` coverage | Why the compensation returns partial values (≈$516) |
| Missing `PriceObservation` coverage | Why valuation gaps appear |
| Sync timing | Why the correction *appears* as a jump — it lands when observation replaces inference |

**Two independent defects sit on top of the gap and are separately fixable:**

1. **No non-negativity guard** at `regenerate-history.core.ts:160` — a fabricated value passes the module's own honesty rules.
2. **`hasInvestmentEvidence` is a boolean, not a coverage ratio** — evidence for 5% of a portfolio authorises overwriting 100% of the component.

This is also the empirical proof V26-F3 could only assert: `BalanceObservation` is not a nice-to-have for reproducibility. Its absence is why 728 of 737 production rows are inference, and why 92 of them are impossible.

---

## 11 · Architectural implication

**Snapshot generation belongs *inside* the Resolver — and should eventually disappear as a distinct concept.**

`SpaceSnapshot` today is three things fused: an observation store (9 rows), a reconstruction cache (728 rows), and a chart source. The Resolver already owns temporal resolution, so:

```
BalanceObservation + PositionObservation + PriceObservation + FxRate   ← evidence, append-only
        │
   Resolver (temporal resolution, as-of)
        │
   Financial Truth(t)   ← sealed; carries per-component observed/reconstructed provenance
        │
   Attribution Compiler (two-endpoint)  →  charts, deltas, drivers
```

Under this, "regenerate history" stops existing. You do not regenerate what you recorded. `SpaceSnapshot` becomes a *materialised view* of sealed truth — safe to rebuild precisely because rebuilding cannot change it.

**The transitional rule, available today:** a reconstructed value must never be presented with the same authority as an observed one, and a reconstruction that violates a domain invariant must not be written at all.

---

## 12 · Local vs production

The same defect class exists in both; **production is materially worse.**

| | Local dev | Production |
|---|---|---|
| Negative `stocks` rows | 0 | **92** |
| Anomalous window | 2026-06-26 → 07-18 (23 days) | 2026-04-21 → 07-21 (**92 days**) |
| Anomaly shape | dropout to ≈1,6xx (positive) | **negative**, to −1,810 |
| Observed rows | more | **9** |

Local shows the *dropout* form (partial valuation); production shows the *negative* form (invalid valuation). Same code path, different position-history completeness.

---

## 13 · Exact first implementation ticket

> **V26-HIST-1 · Refuse to write impossible reconstructions**
>
> Stop the reconstruction from producing values the domain forbids, and disclose reconstructed periods. **No schema, no migration, no backfill in this ticket.**
>
> **1. Guard the write — `lib/snapshots/regenerate-history.core.ts`**
> - At line 160, a reconstructed `investmentValue` may be used **only if** it is finite and `>= 0`. If it is negative, **do not write it** — fall back to the flat value and emit a warning tier, exactly as the NO-FABRICATION rule already does for absent evidence. A negative reconstruction is a fabrication, and the module's own doctrine already forbids fabrication.
> - Add a coverage gate: `hasInvestmentEvidence` becomes insufficient on its own. When A8's completeness tier is below the accepted threshold, keep the flat value and mark the day `incomplete` rather than overwriting the component.
> - **Do not clamp silently with `Math.max(0, …)`.** Clamping −1,810 to 0 substitutes one wrong number for another. Refuse the write and record why.
>
> **2. Pure guard tests — `regenerate-history.core.test.ts` (extend)**
> - A negative `investmentValue` with evidence present ⇒ action is not `write`, or the written value is the flat value; **never negative**.
> - Low coverage ⇒ flat retained, tier `incomplete`.
> - Existing FROZEN and MONOTONE tests must still pass unchanged.
> - Fixture pinned to the production shape: flat 4,968, reconstructed −1,667 ⇒ output must not be −1,667.
>
> **3. Disclosure — `WealthChangeLedger.tsx`**
> - `WealthResult.basis` already carries `hasObserved` / `hasReconstructed` (`wealth-time-machine.ts:328-329`), and each endpoint carries `isEstimated`. Render it: when either comparison endpoint is reconstructed, say so beside the existing `ATTRIBUTION_NOTE`.
>
> **4. Read-only integrity probe — `scripts/check-snapshot-integrity.ts`**
> - Report rows violating domain invariants (`stocks < 0`, `crypto < 0`, `cash < 0`, `totalAssets < component sum`) per Space, with date ranges. **Read-only, exits non-zero on findings.** Mirrors `check-external-id-duplicates.ts`.
> - This is what would have caught 92 bad days on the day the first one was written.
>
> **Out of scope:** `BalanceObservation`, repairing existing rows, position-history backfill, any change to A8 valuation itself.
>
> **Done when:** suite green with the new guards, `tsc` clean, lint clean, and the integrity probe reports the 92 production rows without modifying them.
>
> **Deliberately deferred to a follow-up:** repairing the 92 rows. Fix the writer before the data, or the repair will be overwritten by the next regeneration.

---

## 14 · Final answer

> **Fourth Meridian does not preserve historical financial truth. It reconstructs history after every synchronisation — and in production that reconstruction is currently producing impossible values that are shown to you as fact.**

**Repository evidence.** Account balances are mutable with no history (`FinancialAccount.balance`, V26-F3). `backfill.ts:222-223` holds investments, crypto and manual assets **flat at today's value** for every historical day. `regenerate-history.core.ts:160` then overwrites the investments component with A8's reconstructed valuation whenever *any* evidence exists — with **no non-negativity guard and no coverage threshold** — despite the same module's stated rule that *"unknown is preferable to a fabricated value."*

**Production evidence.** 737 snapshots; **728 estimated**; **9 observed, all in the last 9 days**. **92 snapshots carry a negative investments balance** (2026-04-21 → 2026-07-21, minimum **−1,810**). Your YTD opening of ≈$516 is stored verbatim on 2026-01-01. Your MTD opening of ≈$12,869 is exactly `stocks −1,667 + crypto 14,536` on 2026-07-01. The sync jump is the boundary at 2026-07-22, where `stocks` moves −1,562 → +5,233 and net worth 20,091 → 26,847 (**+6,756 in one day**) with cash and debt unchanged.

**And the previous investigation's unexplained figure now resolves:** `4,968 − (−1,667) = 6,635`. That number was never reproducible from local data because it belongs to production, where the invariant `delta ≤ current balance` is broken by a component that went negative.

**Crypto compounds it.** Only **39 days** of BTC price history exist in production (first 2026-06-21), and `regenerate-history.core.ts:14-16` excludes crypto from historical revaluation entirely — it keeps whatever backfill computed, which is **today's value held flat across all history**. There is no code path that values crypto as-of a past date. That is why the crypto line is flat and steps only on sync: it is being restated, not priced.

**None of your four observations was a misreading.** The jump is real and is a correction, not a gain. The charts are faithfully plotting stored values that are wrong. The crypto price genuinely does not change until you sync. And the root cause is single: the platform infers the past instead of recording it — with, for now, nothing stopping the inference from being impossible.
