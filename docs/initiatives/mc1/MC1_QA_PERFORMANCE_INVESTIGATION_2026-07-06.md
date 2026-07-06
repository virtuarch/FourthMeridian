# MC1 QA Performance Investigation — Space page latency after Q4–Q6

**Status:** Investigation only — no code, schema, or behavior changed by this document.
**Date:** 2026-07-06, against the working tree with MC1 QA Q4b/Q5/Q5b/Q6 applied.
**Trigger:** after the QA cleanup slices, Space pages feel slow. Dev logs show `/api/spaces/[id]/transactions` application-code ~1822ms, `/api/money/view-context?target=SGD` ~967ms, `/api/spaces/[id]/snapshots` ~719ms, `/dashboard 200 in 418ms`, and "next.js ~2s" on several routes.
**Constraint:** read-only audit. Do not weaken currency conversion or the KD-15 privacy predicate. Preserve MC1 correctness.

---

## 1. Route timing breakdown — dev-mode compile vs real application latency

Two different clocks appear in the logs and must not be conflated.

| Log line | What it measures | Classification |
|---|---|---|
| `next.js ~2s (dev)` on a route's first hit | Next.js **dev compilation / HMR** of that route module graph (`○ Compiling … / ✓ Compiled`). One-time per route per dev session; absent in `next build`/prod. | **Dev overhead — not a product bug.** Ignore for perf targets. |
| `/dashboard 200 in 418ms` | Total request wall-time for the page shell. First hit folds in compile; warm hits are the server-component render + a few deduped queries. | **Mostly real but not the hotspot.** The page shell does not build the big transaction context; SpaceDashboard's heavy reads are separate client XHRs (below). |
| `/api/spaces/[id]/snapshots` **application-code ~719ms** | The handler's own measured execution (excludes compile). | **Real app latency.** |
| `/api/spaces/[id]/transactions` **application-code ~1822ms** | Handler execution, excludes compile. | **Real app latency — the primary offender.** |
| `/api/money/view-context?target=SGD` **application-code ~967ms** | Handler execution, excludes compile. | **Real app latency.** |

**Key discriminator:** lines labelled "application-code Nms" are the app's own instrumentation around the handler body, so they are genuine latency, independent of dev compile. The "next.js ~2s" entries are the compiler. The three "application-code" numbers are the real problem and they share one root cause (§2–§5).

A strong tell that this is real and not compile: all three slow routes are non-trivial **only for non-USD targets** (the example is `target=SGD`). An all-USD Space takes the identity fast path and these same routes are cheap — which points squarely at the FX conversion-context build, not compilation.

---

## 2. Why `/api/spaces/[id]/transactions` takes ~1.8s

The handler (`app/api/spaces/[id]/transactions/route.ts`) does three things:

1. `getTransactions({ spaceId })` — `lib/data/transactions.ts`. A single `findMany` with the KD-15 predicate, `orderBy date desc`, **no `take` limit** → returns *every* banking transaction the Space can see (potentially thousands of rows across multiple years).
2. `space.findUnique` for `reportingCurrency`.
3. `serializeSpaceConversionContext(space, { currencies: transactions.map(t => t.currency), dates: transactions.map(t => t.date) })` — builds a conversion context covering **every transaction's date**.

Step 3 is the cost. `serializeSpaceConversionContext → buildSpaceConversionContext → buildConversionContext` (`lib/money/context.ts`) contains:

```
for (const from of uniqueCurrencies)      // usually just ["USD"] under an SGD Space
  for (const dateISO of uniqueDates)      // ALL distinct transaction dates
    await service.getRateForDate(from, target, dateISO)   // ← sequential awaited DB read
```

Each `getRateForDate` (`lib/fx/service.ts`) resolves via USD cross-rate. For USD-stamped rows under an SGD Space the `from=USD` leg is definitional (free), but the `to=SGD` leg calls `archive.readLatestOnOrBefore(USD, SGD, dateISO, 7)` — **one indexed `findFirst` per distinct date** (`lib/fx/archive.ts`). The index `@@index([quote, date])` makes each query fast individually, but they run **strictly sequentially in an `await` loop**.

With ~2 years of activity a Space easily has **500–700 distinct transaction dates** → **500–700 sequential DB round-trips**. At a few ms each on a local dev DB that is ≈1.5–2s — matching the observed ~1822ms. The row serialization and the `findMany` itself are minor by comparison; **the sequential per-date FX prefetch dominates.**

All-USD Spaces are unaffected: `buildConversionContext` filters the target out of `currencies`, leaving an empty set → zero archive reads → empty serialized entry table.

## 3. Why `/api/money/view-context` takes ~1s

`app/api/money/view-context/route.ts` has the **same** bottleneck, slightly smaller inputs:

- It fetches `getAccounts` **and** `getTransactions` (in parallel), then builds a context over `dates: [yesterdayUTCISO(), ...transactions.map(t => t.date)]` and `currencies: [account currencies…, transaction currencies…]`.
- So it again prefetches one archive read per distinct transaction date, sequentially, for `target=SGD`. Fewer/other dates than the tx route but the same O(distinct-dates) sequential pattern → ~967ms.

Two secondary observations:
- The view-context's own header says it exists to cover **"account balances at the latest close"** for the section widgets/planner — that needs essentially **one date** (`yesterdayUTCISO()`). Threading in **every transaction date** massively over-covers what the `widgetCtx` consumer actually uses. (It was written to mirror the page's persisted-context coverage, but the SpaceDashboard consumer only aggregates account balances at the latest close.)
- It re-runs `getTransactions` — the same unbounded query the transactions route just ran.

## 4. Does Q6 cause duplicate or unnecessary refetches?

**No double-firing bug, but a pre-existing redundancy that Q6 now exercises on every currency change.**

- Q6's listener in `SpaceDashboard` sets three states together (`setSpaceTransactions(null)`, `setSpaceMoneyCtx(undefined)`, `setCurrencyNonce(n+1)`). React 18 auto-batches these, so each dependent effect (snapshots, perspectives, transactions) re-runs **exactly once**. The transactions effect is triggered both by `spaceTransactions === null` flipping true and by `currencyNonce` changing, but both land in one batch → one fetch. **Verified: no duplicate fire from the Q6 wiring itself.**
- The refetches Q6 triggers (snapshots, perspectives, transactions, plus `widgetMoneyCtx` via the `displayCurrency` change from `router.refresh()`) are each **necessary** — the currency changed, so that data must re-denominate. This is correct behavior, not waste.
- **The real redundancy is structural and predates Q6:** on the active Space with no "view as" override, `displayCurrency === Space.reportingCurrency`, so `widgetMoneyCtx` (from `/view-context`, target = displayCurrency) and `spaceMoneyCtx` (from `/transactions`, target = reportingCurrency) are built with the **same target over overlapping (currency × date) sets** — two independent `getTransactions` calls and two heavy context builds for one logical need. Q6 makes both refire on a currency change; initial mount already pays it once. See §7.

Net: Q6 is not the cause and has no refetch defect. It amplifies an existing O(distinct-dates) cost by making the expensive routes refetch together.

## 5. Does conversion-context building scan too many rows/dates?

**Yes — this is the root cause.** `buildConversionContext` prefetches **one sequential archive query per (unique currency × unique date)** pair. The date axis is unbounded because callers pass **every transaction date**. The math is honest and correct (identity fast path, USD cross-rate, ≤7-day walk-back, `RateMiss` as a value, per-request memo) — but the **shape** is O(distinct dates) sequential round-trips when it could be O(distinct quotes) range reads.

Two independent multipliers:
1. **Unbounded row/date set** — `getTransactions` has no `take`; the context covers the entire history's dates.
2. **Sequential, not batched** — the awaited `for`/`for` loop serializes every leg read; nothing is parallelized or range-fetched.

Neither the per-query index nor correctness is at fault; the **access pattern** is.

## 6. Do queries need limits, indexes, caching, memoization, or batching?

- **Indexes:** already correct. `FxRate @@index([quote, date])` serves the walk-back; `@@unique([date, base, quote])` serves exact reads. No new index needed.
- **Batching:** **yes — the highest-value fix.** Replace the per-date sequential prefetch with **one range query per needed quote** (`FxRate` rows for the quote set within `[minDate − MAX_STALE_DAYS, maxDate]`), then resolve every (currency, date) pair **in memory** with the identical walk-back rule. Turns 500–700 round-trips into 1–2. Must be byte-identical to the sequential result (same rates, `effectiveDates`, `staleness`, misses).
- **Memoization:** the fx service already memoizes within a single build; `buildConversionContext` already de-dupes dates/currencies. The gap is **cross-route** reuse (§7) and **cross-request** reuse of immutable closed-date rates.
- **Caching:** closed-date `FxRate` rows are immutable by doctrine, so a process-level or `unstable_cache`/`React.cache` layer keyed on `(quote, dateRange)` is safe and would dedupe across routes/requests. **Lower priority** once batching lands (a range read is already cheap); attractive as a follow-up.
- **Limits:** `getTransactions` returning the full history is defensible for the Transactions tab but wasteful for the Overview preview (renders 5) and for context coverage (only distinct dates matter). A `take` limit is a **behavior change** (fewer rows) → must be a product decision, not a silent perf fix. Batching (above) removes the need to touch it for the FX cost.

## 7. Should SpaceDashboard share one fetched moneyCtx instead of rebuilding per route?

**Yes, in the common case.** For the active Space with no "view as" override:
- `widgetMoneyCtx` ← `/api/money/view-context?target={displayCurrency}` and
- `spaceMoneyCtx` ← `/api/spaces/[id]/transactions` (`moneyCtx`, target = `Space.reportingCurrency`)

have the **same target** and overlapping coverage, each triggering its own `getTransactions` + context build. They can be unified to a single fetched/serialized context when `displayCurrency === Space.reportingCurrency`. The `/view-context` route must remain for the genuine **"view as {other currency}"** override (where the target differs), so this is a "reuse when targets coincide" optimization, not a route deletion. Deferred below P0/P1 because it is a client-orchestration change with more surface than the pure batching fix and should land after the batching win is measured.

---

## 8. Suspected root causes (ranked)

1. **O(distinct-dates) sequential FX prefetch** in `buildConversionContext` — the dominant cost on every non-USD route (tx, view-context, snapshots, and the debt/liquidity lenses). *(§2–§5)*
2. **Unbounded date/row coverage** — callers pass every transaction date into the context; `getTransactions` has no `take`. Multiplies (1). *(§2, §6)*
3. **Duplicated context builds across routes** — `/transactions` and `/view-context` rebuild the same-target context (and both re-run `getTransactions`) for the active Space. *(§4, §7)*
4. **No cross-request cache of immutable closed-date rates** — every request re-reads rates that can never change. *(§6)*
5. **Dev-mode compile noise** — the "next.js ~2s" lines are compilation, not latency, and should be excluded from targets to avoid chasing a non-bug. *(§1)*

---

## 9. Recommended fixes by priority

**P0 — Batch the FX prefetch inside `buildConversionContext` (pure, behavior-preserving).**
One range read per needed quote over `[minDate − MAX_STALE_DAYS, maxDate]`; resolve each pair in memory with the existing walk-back/cross-rate/miss logic. Expected: tx ~1822ms → <200ms, view-context ~967ms → <150ms, snapshots ~719ms → <150ms. Must produce a byte-identical `SerializedConversionContext`. Highest impact, smallest, lowest risk (single pure module). Also transparently speeds the perspectives lenses.

**P1 — Right-size `/view-context` date coverage to its consumer.**
The SpaceDashboard `widgetCtx` consumer aggregates account balances at the latest close, so the context only needs `yesterdayUTCISO()` (plus account currencies), not every transaction date. Narrowing the `dates` passed in is behavior-preserving **for that consumer** and removes the transaction-date fan-out from this route. (Verify no other caller of `/view-context` relies on transaction-date coverage before narrowing; if one does, keep coverage there.)

**P2 — Share one moneyCtx in SpaceDashboard when target coincides (§7).**
Reuse a single serialized context for `widgetMoneyCtx`/`spaceMoneyCtx` when `displayCurrency === Space.reportingCurrency`; keep `/view-context` for the override path. Removes a duplicate `getTransactions` + build on load and on Q6 refetch.

**P3 — Cache immutable closed-date rates.**
Add a `(quote, dateRange)`-keyed cache (process-level or `unstable_cache`) over archive range reads. Optional once P0 lands; helps cross-request warm paths.

**P4 (needs product decision, not a silent fix) — bound `getTransactions` for preview surfaces.**
Consider a `take`/window for the Overview preview (renders 5) distinct from the full Transactions tab. Behavior-affecting → out of scope for a pure perf pass.

Ordering rationale: P0 alone should resolve the reported slowness; P1–P2 remove residual duplicate work; P3–P4 are follow-ups.

---

## 10. Validation gates (for the eventual P0 implementation)

1. **Conversion equivalence (the load-bearing gate):** over a fixture archive, the batched `buildConversionContext` returns a `resolve()` table **byte-identical** to the current sequential build for every (currency, date) pair — covering: exact-date hits, ≤7-day walk-back, >7-day miss, `from`-leg-first miss attribution, unsupported-currency miss (no throw), and target/null/identity skips. Assert equal `rate`, `effectiveDates`, `staleness`, and `kind`.
2. **Serialized-payload identity:** `serializeSpaceConversionContext` emits the same JSON (same keys/order/values) before and after — so every client consumer renders identically.
3. **All-USD invariance:** a USD Space still produces an empty entry table and performs **zero** archive reads.
4. **Privacy untouched:** `getTransactions` KD-15 predicate unchanged; the KD-15 tripwire tests and `serialize.golden.test.ts` stay green (no widening, no row-shape change).
5. **Timing:** on a fixture non-USD Space with ~500 distinct dates, `/transactions` application-code drops by ≥5× (target <200ms); `/view-context` and `/snapshots` similarly. Measure the handler body, not the dev-compile first hit.
6. **Determinism:** same archive state ⇒ identical context across repeated builds (preserve the append-only determinism property).
7. `npx tsc --noEmit`, `npm run lint` (4-warning baseline), `npm test` (43/44 + kd17 sandbox baseline) all green.

---

## 11. First implementation prompt

> Implement MC1 QA performance fix **P0 only** per `docs/initiatives/mc1/MC1_QA_PERFORMANCE_INVESTIGATION_2026-07-06.md` §9. Rewrite `buildConversionContext` (`lib/money/context.ts`) so it prefetches FX rates with **one range query per distinct quote** instead of one sequential `getRateForDate` per (currency × date) pair: (1) collect the distinct non-target, non-null `from` currencies and the distinct dates; (2) for the required quotes (each `from` plus the `target`, base USD), read all `FxRate` rows in `[min(dates) − MAX_STALE_DAYS, max(dates)]` via a new **batch reader method on the `FxArchiveReader` seam** (add a range-read to `lib/fx/archive.ts` and the types; keep the existing `readLatestOnOrBefore` for other callers and tests); (3) resolve every (from, date) pair **in memory** using the identical algorithm in `lib/fx/service.ts` — USD cross-rate, per-leg exact-or-≤`MAX_STALE_DAYS` walk-back, `from`-leg-first miss attribution, unsupported-currency ⇒ miss (no throw). The returned frozen `resolve()` table and the serialized payload must be **byte-identical** to today's for the same archive state. No schema change, no new index, no behavior change, and do not touch the KD-15 `getTransactions` predicate. Add an **equivalence test** asserting the batched context matches a sequential reference over a fixture archive spanning exact/walk-back/miss/unsupported cases, plus the all-USD zero-read gate. Validate with `npx tsc --noEmit`, `npm run lint`, `npm test`, and the gates in §10. Stop after P0 and report the before/after handler timings. Do not start P1–P4.

---

*End of investigation. No code, schema, or data was modified.*
