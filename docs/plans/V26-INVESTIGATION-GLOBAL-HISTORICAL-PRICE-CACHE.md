# V26 Investigation — Global Historical Price Cache & Honest Historical Compilation

**Status:** Investigation. No code, schema, migration, or commit. Read-only against production and local.
**Repository:** `v2.6` @ `146a0dd`
**Continues from:** Historical Price Coverage · Historical Crypto Valuation · Historical Valuation Integrity · Net Worth Attribution · Financial Truth Data Model

**Marking:** **[EXISTS]** verified · **[ABSENT]** verified missing · **[INFERRED]** reasoned · **[MODELLED]** external assumption, not repository evidence · **[PROPOSED]**

---

## 1 · Executive finding

**Recommendation: do not build proactive warming yet. Build the demand-driven path correctly first — it is already 100% effective where it is wired, and the warming question cannot be answered from this platform's data.**

Production scale, measured:

| Metric | Value |
|---|---|
| Users | **2** |
| Spaces | **6** |
| Instruments (total) | **23** |
| Instruments held (`quantity > 0`) | **19** |
| Instruments with prices | **20** |
| `PriceObservation` rows | **8,632** |
| Price window | 2024-07-24 → 2026-07-29 |

**The Pareto analysis you asked for in Part 2 is not computable.** With n=2 users, "how many instruments cover 50% of portfolios" has no meaningful answer — one user's holdings *are* 50% of portfolios. Any warm-universe sizing must therefore rest on **[MODELLED]** external market-structure assumptions, and I will label every such number rather than present it as evidence.

**What the data does say, decisively:**

- The demand-driven path **already achieves complete coverage** for every equity: 505 rows each, from 2024-07-24, fetched *before* first position. Cache hit rate for equities is effectively 100% of need.
- The gap is **not** cold-cache latency. It is the three defects already identified: **no crypto trigger**, **no coverage gate**, and **`quantity > 0` scoping** that abandons sold positions.
- Warming a "top 1,000" universe today would store ~1.26M rows to serve a book of **19 instruments**. That is a 66,000× over-provision for a problem that does not exist.

**So the honest answer to the success criterion:** a globally shared, proactively warmed cache is the right *eventual* architecture, and the platform is already structurally ready for it (`PriceObservation` is global and keyed by instrument, not by Space). But **it is not preferable to demand-driven completion today** — it is the same architecture with a scheduler bolted on, and the scheduler is the least valuable part. Ship the coverage contract; add warming when a stated trigger fires (§14).

---

## 2 · Existing global cache

| Property | Finding |
|---|---|
| Rows | **8,632** |
| Distinct priced instruments | **20** of 23 |
| Oldest / newest | 2024-07-24 / 2026-07-29 |
| Density | equities ~505 rows over ~505 trading days ⇒ **near-complete**; BTC 39 rows |
| Asset classes | EQUITY, ETF, CRYPTO, CASH |
| Cross-Space reuse | **structurally guaranteed** — no `spaceId`/`userId` column exists |
| Uniqueness | `@@unique([instrumentId, date, basis])` **[EXISTS]** |

**Is it already a global cache, or a side effect of syncs?** **Both — and the distinction is the finding.** The *table* is a genuine global cache: keyed by instrument, deduplicated by construction, reusable by every Space. The *population mechanism* is a side effect of one sync path (`backgroundHistorySync.ts:243`). So the cache is well-designed and under-fed, which is a much better position than the reverse.

---

## 3 · Instrument distribution — why the Pareto is unanswerable

With 2 users and 6 Spaces:

- Every held instrument appears in essentially one portfolio.
- "Instruments appearing in many Spaces" — none, in any statistically meaningful sense.
- "Repeated API fetches" — the missing-only planner prevents them by design; a repeat fetch would be a bug, not a cost centre.

**[MODELLED] — external market structure, stated as assumption:** retail portfolios concentrate heavily. A few hundred tickers (mega-cap US equities, the dominant broad-market and sector ETFs, the top ~20 crypto assets) plausibly cover the large majority of retail holdings, with a long tail of thousands. **I am not asserting specific percentages** — doing so from n=2 would be false precision of exactly the kind these investigations keep flagging.

**The honest metric to collect before sizing anything:** cache-miss rate at instrument discovery, measured per connect. That number is free to instrument and is the only one that can size a warm universe. Today it is not measured. **[ABSENT]**

---

## 4 · Warm-universe strategies

| | **A — Demand-driven only** | **B — Warm common + demand tail** | **C — Warm everything** |
|---|---|---|---|
| Storage | ~8.6k rows today | +126k–630k rows **[MODELLED]** | millions |
| Provider calls | ~5/instrument once | +500–2,500 upfront **[MODELLED]** | tens of thousands |
| Daily maintenance | 1 batched call/provider | same + warm set | large |
| Onboarding latency | one backfill on connect (**already awaited and budgeted**) | near-zero for common assets | near-zero |
| Cache hit rate | **100% of realised need today** | higher for *future* users | ~100% |
| Complexity | **lowest — already built** | warm-set config, refresh job, drift handling | highest |

**Recommendation: A now, B later, never C.**

C is rejected outright: it pays for instruments nobody holds, and the long tail is precisely where provider coverage is worst — a large fraction of the spend would buy rows that are never read and reasons that are never resolved.

B's only real benefit is **onboarding latency**, and that benefit is currently near-zero because the existing backfill is awaited inside a background sync the user is not waiting on. Warming optimises a wait that does not exist yet.

---

## 5 · Default horizon — and why "5 years" is the wrong shape of answer

| Horizon | Rows/equity **[MODELLED]** | Rows/crypto |
|---|---|---|
| 2 years | ~504 | ~730 |
| 5 years | ~1,260 | ~1,825 |
| 10 years | ~2,520 | ~3,650 |

**Recommendation: the default window is not a fixed horizon at all — it is the ownership window** (`KNOWN ∪ POSSIBLE`, per the coverage investigation §4).

A fixed 5-year default is wrong in both directions: it over-fetches for an instrument bought three months ago (1,260 rows to serve 90 days), and under-fetches for a position held since 2015. Ownership-window scoping is already what `backfill.ts:11` attempts ("earliest defensible activity"), and it is the correct principle — it just needs the three-tier floor.

**Where a fixed horizon *does* belong is the warm set** (if B ever ships), because a warm instrument has no owner and therefore no ownership window. **For that case, 5 years is a reasonable default [MODELLED]** — long enough for meaningful trend and seasonality features, short enough that storage stays trivial (§12).

---

## 6 · Discovery pipeline

Your desired flow, checked against the repository:

| Step | Status |
|---|---|
| Instrument discovered | **[EXISTS]** — `resolveCryptoInstrumentId`, Plaid securities ingestion, imports |
| Already cached? | **[EXISTS]** — missing-only planning inside `backfillPricesForInstruments` |
| Coverage planner | **[ABSENT]** — planning is internal and returns counts, not a verdict |
| Fetch required history | **[EXISTS]** — chunked, resumable, budgeted |
| Archive globally | **[EXISTS]** — `archive.ts:112`, global by construction |
| Future users reuse | **[EXISTS]** — no per-Space dimension |

**Five of six steps exist.** The missing one is the *reportable* verdict — which is exactly why the coverage planner remains the correct first ticket.

---

## 7 · Coverage planner as single entry point — confirmed

Nothing in this investigation changes that conclusion. The planner should answer *complete / partial / missing-leading / missing-trailing / internal-gaps* **without contacting providers**, and every consumer of historical value should consult it.

One refinement this investigation adds: **the planner is also the natural warm-set driver.** If B ships, warming is just `ensureHistoricalPriceCoverage` invoked with a configured instrument list and a fixed horizon instead of an ownership window. That is a strong argument for the planner's input shape being `{ requested window, observed rows, calendar, provider limits }` and *not* taking an account or Space — it must work for instruments nobody owns.

---

## 8 · Estimation philosophy — where each estimate lives today

### Good estimates (keep)

| Estimate | Location | Why acceptable |
|---|---|---|
| Quantity reconstruction from events | `PositionReconstruction`, `reconstructAccount` | Derives from recorded evidence; carries `completeness` and `unexplainedQuantity` |
| Cash/card walk-back from transactions | `backfill.ts` `reconstructDailyCashBalances` | Anchored on a real balance, moved by real posted transactions |
| Nearest-prior market close | FX resolution; price lookup | Standard market convention; must be marked estimated |
| Carry-forward of a known quantity | position as-of resolution | A holding persists until an event changes it — an evidenced inference |

### Bad estimates (eliminate)

| Estimate | Location | Why it is fabrication |
|---|---|---|
| **Today's crypto value projected backwards** | `backfill.ts:222-223` (flat-held) + `regenerate-history.core.ts:14-16` (crypto excluded from revaluation) | Asserts a past value from a present one. Produces the flat line that steps on sync |
| **Flat investment history where backfill never ran** | same mechanism, investments branch | Same fabrication, different column |
| **Negative reconstructed investment value written unguarded** | `regenerate-history.core.ts:160` | Not an estimate at all — an impossible value (92 production rows) |
| **Today's quantity projected backwards** | **[INFERRED]** implicit wherever a position lacks observations before capture began — BTC: 9 observations vs ~3 years of ownership | Same class as the above, on the quantity axis |

**The dividing line, stated as a rule:** an estimate is legitimate when it *derives from evidence about the period in question*. It is fabrication when it *substitutes evidence from a different period*. Carry-forward of a known 2024 quantity through 2024 is derivation. Applying a 2026 price to 2024 is substitution.

---

## 9 · Honest charts without breaking UX

| Option | Usability | Trust | Complexity | Truth-compatible |
|---|---|---|---|---|
| A — break the line | poor | high | low | yes |
| B — continuous estimated line, no metadata | good | **low** — indistinguishable from observed | low | **no** |
| **C — continuous line + internal confidence metadata** | **good** | **high** | **medium** | **yes** |
| D — known subtotal only | poor | high | medium | yes |
| E — current | good | **none** — fabrication rendered as fact | — | **no** |

**Recommendation: C.**

The line stays continuous — a broken chart is a worse product and does not actually increase honesty, since the reader cannot tell a data gap from a flat period. What changes is that estimated segments are *visually distinguishable* (the conventional treatment is a lighter or dashed stroke) and the underlying points carry their tier.

**No "Honesty Toggle."** A toggle implies honesty is optional and doubles the surface to test. The default must simply be honest.

**Critically, C is nearly free:** `WealthChartPoint.isEstimated` **[EXISTS]** (`wealth-time-machine.ts:194`), and `WealthResult.basis` already exposes `hasObserved` / `hasReconstructed` (`:328-329`). The chart already receives everything it needs and does not render it.

---

## 10 · Internal quality metadata — and where it is lost

Your proposed shape is close to what already exists in places. Tracing it end to end:

| Layer | Metadata carried |
|---|---|
| `PositionObservation` | `completeness`, `unexplainedQuantity`, `origin`, `source`, `evidenceRefs` **[EXISTS]** |
| `getInvestmentValueAsOf` | valued subtotal + **unvalued remainder** + `tier` **[EXISTS]** |
| **`regenerate-history.core.ts:160`** | **LOST — first and worst hop.** Only `investmentValue` is consumed; the remainder and its reason are discarded |
| `SpaceSnapshot` | one boolean `isEstimated` for an entire day, all classes |
| `wealth-time-machine` | `isEstimated` per point + `basis` **[EXISTS]** |
| `WealthChangeLedger` | **LOST — discarded**, never read |

**The earliest loss is `regenerate-history.core.ts:160`.** Everything downstream is reconstructing a shadow of what was already known one line earlier. Fixing the chart alone would surface a boolean that has already lost the reason; fixing hop one preserves *which instrument was unpriced and why* — the difference between "partly estimated" and "your BTC has no price history before June".

**[PROPOSED] minimal shape**, reusing `CompletenessTier` rather than minting a vocabulary:

```ts
interface ValuedPoint {
  value: number;
  tier: CompletenessTier;
  estimatedFraction: number;              // 0..1 of value from non-observed inputs
  unresolved: Array<{ instrumentId: string; reason: MissingReason }>;
}
```

---

## 11 · Progressive truth

**Design: only estimated rows mutate; observed rows are frozen; provenance is recorded.**

The repository **already implements this correctly** — `regenerate-history.core.ts:20-23` FROZEN rule, enforced by a guard and a byte-identity test, with `skip-frozen` as an explicit action. That is the single strongest piece of the existing history machinery and should be preserved verbatim.

The lifecycle you sketched works as-is:

```
Day 1  estimated (no prices)        isEstimated = true
Day 3  prices imported              → recompile → still estimated (derived valuation), better value
Day 5  earlier transactions found   → window extends leading edge → recompile
Day 6  observed snapshot written    isEstimated = false → FROZEN forever
```

**Should sealed truth remain immutable? Yes — and note the FLIP rule already guarantees the right thing:** a regenerated row flips to observed *only when every component is observed* (`:27-30`), so a derived historical valuation never masquerades as an observation no matter how much evidence arrives.

**What is missing is provenance of the improvement itself:** today a recompile silently replaces a value. Under V26-F3's sealed-Truth model, the *value used* is captured in the artifact, so improvement becomes a new sealed version rather than an in-place overwrite. Until then, recording `compilerBehaviorVersion` and the coverage tier on the row is the cheap interim.

---

## 12 · Storage economics **[MODELLED]**

Row size ≈ 95 B of data; ~150–200 B with index overhead. Trading days: 252/yr equities, 365/yr crypto.

**5-year warm universe:**

| Universe | Rows | Storage | Initial calls (365-day chunks) |
|---|---|---|---|
| Top 100 | ~126k | **~25 MB** | ~500 |
| Top 500 | ~630k | **~125 MB** | ~2,500 |
| Top 1,000 | ~1.26M | **~250 MB** | ~5,000 |
| Top 5,000 | ~6.3M | **~1.2 GB** | ~25,000 |

**Daily incremental:** one batched call per provider (Tiingo supports multi-ticker; CoinGecko is per-coin, so crypto scales linearly with the warm crypto set — a reason to keep that set small, ~20 assets).

**Verdict: warming the top 100–500 is operationally trivial on storage (~25–125 MB).** Top 5,000 is not trivial on the current Micro-tier production instance, and the initial 25,000 calls would collide with free-tier rate limits.

**But storage was never the objection.** The objection is that 8,632 rows currently serve the entire platform, and warming top-500 would store ~73× more data than has ever been read.

---

## 13 · Long tail

Ideal lifecycle — and it is the flow that already exists, minus the verdict:

```
Discovery → coverage check → missing? → fetch required window → store globally → reuse forever
```

| Concern | Handling |
|---|---|
| Retries | missing-only planning resumes naturally **[EXISTS]** |
| Failures | successful chunks persist; remainder retries next trigger **[EXISTS]** |
| Provider limits | must be **reported** as `PROVIDER_LIMIT`, not silently truncated **[ABSENT]** |
| Unsupported assets | `resolveProviderId → null` ⇒ `UNSUPPORTED_INSTRUMENT`, valued as unknown, never zero |
| Delisted | history retained; trailing edge stops; the stop date is evidence, not a gap |

**The long tail is where "unknown is better than fabricated" earns its keep.** A warm universe cannot help here by definition, which is another argument that the demand-driven path is the one that must be correct.

---

## 14 · Should eager collection become an architectural law?

**Proposed law:** *"Historical prices should be eagerly collected whenever reasonably possible, so estimation becomes progressively rarer over time."*

**Recommendation: adopt a narrowed form.**

> **Price evidence is collected for the full ownership window at discovery, and never fetched at read time.**

The unrestricted form invites warming the world, and "reasonably possible" is undefined — it would justify top-5,000 warming on day one. The narrowed form captures the real intent (estimation shrinks as evidence accumulates), binds it to something measurable (the ownership window), and preserves law 7 (deterministic reads).

**Trade-offs of eagerness, honestly:** it front-loads provider cost and rate-limit exposure onto connect; it fetches history for instruments a user may hold briefly; and for the long tail it can spend calls on assets with poor provider coverage that will resolve to `UNSUPPORTED` anyway. Against that, it is the only way to make historical truth *stable* — which is the property this entire programme exists to establish.

**Trigger for revisiting warming [PROPOSED]:** instrument the cache-miss rate at discovery, and revisit when either (a) active users exceed a few hundred, or (b) measured miss-rate at connect exceeds ~30% of newly discovered instruments. Both are cheap to measure and neither is true today.

---

## 15 · Recommended architecture

Your hypothesis, with two components removed and one added:

```
Global PriceObservation cache                       ← [EXISTS], keep
        ↓
~~Warm common instruments (≈5 years)~~              ← DEFER until §14 trigger
        ↓
Demand-driven completion, ownership-window scoped   ← fix crypto trigger + drop quantity>0
        ↓
Historical coverage planner (pure)                  ← [PROPOSED] first ticket
        ↓
Provider backfill, gaps not windows                 ← [EXISTS], add truncation reporting
        ↓
Coverage verdict consulted before valuation         ← [ABSENT] — the missing contract
        ↓
Automatic recompilation of ESTIMATED periods only   ← [EXISTS] via FROZEN/FLIP rules
        ↓
Charts continuous, estimated segments distinguished ← metadata [EXISTS], rendering [ABSENT]
        ↓
Historical truth progressively more observed
```

**Removed:** the warm-universe stage (premature at n=2). **Added:** the coverage verdict as an explicit gate — the component your hypothesis assumed but the repository lacks.

---

## 16 · Implementation phases

| Phase | Objective | Depends | Numbers change? |
|---|---|---|---|
| **P0** | Non-negativity + coverage guard *(integrity investigation — still unshipped)* | — | No |
| **P1** | **Pure coverage planner** `lib/prices/coverage.core.ts` | — | **No** |
| **P2** | Provider capability + explicit truncation reporting | — | No |
| **P3** | Coverage orchestrator `ensureHistoricalPriceCoverage` | P1, P2 | No |
| **P4** | Crypto sync triggers coverage | P3 | No |
| **P5** | Ownership-window scoping; drop `quantity > 0` | P3 | No |
| **P6** | Preserve the unvalued remainder past `regenerate-history.core.ts:160` | P3 | **Yes** |
| **P7** | Chart renders estimated segments distinguishably | P6 | Presentation |
| **P8** | Historical quantity reconstruction (BTC from chain) | P4 | **Yes** |
| **P9** | *(Conditional on §14 trigger)* warm-set config + warming job | P3 | No |
| **P10** | Unified rollup; delete `excludeDigitalAssetAccounts` | P6 | **Yes** |

**Changed from your suggested order:** warm-universe config and the warming job move from Phases 2–3 to **P9, conditional on a measured trigger**. Historical quantity reconstruction moves *up* — for BTC it is a bigger gap than price (9 observations vs ~3 years of ownership), and no amount of price warming fixes it.

---

## 17 · Final answers

**Should Fourth Meridian proactively warm historical prices?**
**Not yet.** Demand-driven completion already achieves full coverage for every equity in production, and warming would provision ~73× more data than has ever been read to serve 2 users. Adopt it when the §14 trigger fires.

**If yes, approximately how many instruments?**
When the trigger fires: **top 100–500 [MODELLED]** — ~25–125 MB, ~500–2,500 initial calls. Never top-5,000: ~1.2 GB and ~25,000 calls would exceed both the current instance and free-tier rate limits.

**Should the default horizon be 5 years?**
**Not as a general default.** The default is the **ownership window** — a fixed horizon over-fetches for new positions and under-fetches for long-held ones. 5 years is the right default *only for warm-set instruments*, which have no owner.

**What should remain demand-driven?**
Everything not in a warm set — and today that is everything. Permanently demand-driven: the long tail, delisted assets, and any instrument whose provider identity is unresolved.

**Should estimates disappear automatically as evidence arrives?**
**Yes — and the mechanism already exists.** Estimated rows recompile; observed rows are FROZEN; the FLIP rule refuses to promote a derived valuation to observed. That design is correct and should be preserved exactly.

**Can charts remain continuous without fabricating values?**
**Yes.** Continuity is a rendering choice; fabrication is a data choice. Keep the line, distinguish estimated segments, and stop writing today's value into past rows. The metadata is already computed and already discarded.

**Is an "estimated vs known" toggle worth the complexity?**
**No.** It makes honesty opt-in and doubles the test surface. Distinguish estimated segments by default.

**Exact first implementation ticket?**
**Unchanged: V26-PRICE-1 — pure historical price coverage planner** (specified in the Historical Price Coverage investigation §19). This investigation strengthens the case: the planner must accept `{ requested window, observed rows, calendar, provider limits }` and take **no account or Space**, so it can serve both ownership-scoped completion today and warm-set instruments later without redesign.

*(P0 — the non-negativity guard — remains independent and should ship first regardless.)*

---

> **A globally shared price cache is the right eventual architecture and `PriceObservation` is already correctly shaped for it — but at 2 users and 19 held instruments, proactive warming would optimise a cost that does not yet exist while the actual defects are a missing crypto trigger, a missing coverage gate, and a remainder discarded one line after it is computed; fix those and history becomes progressively more observed on its own, which is what "progressive truth" was always going to mean.**
