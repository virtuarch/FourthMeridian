# V26-PRICE-1 — Historical Price Coverage Planner

**Phase 1 — Investigation.** No code written. No behaviour changed.

Predecessor: V26 P0 (`aa0146a`) — the A9 core now refuses to write an impossible
valuation. P0 stops corruption at the *writer*. This slice is about the layer
above: knowing, as a structured fact, **what price evidence is missing** — so a
gap becomes a statement rather than a silence.

---

## 1. What exists today

| Module | Role | Purity |
|---|---|---|
| `lib/prices/config.ts` | constants + ISO date helpers, `PRICE_MAX_STALE_DAYS = 7` | pure |
| `lib/prices/types.ts` | `PriceProviderAdapter`, `PriceArchive`, `PriceResolution` | pure types |
| `lib/prices/backfill-core.ts` | window planner (157 lines) | pure |
| `lib/prices/backfill.ts` | DB orchestration | I/O |
| `lib/prices/archive.ts` | the one Prisma touchpoint; insert-only | I/O |
| `lib/prices/fetch.ts` | registry failover, one instrument/basis/window | pure orchestration |
| `lib/prices/service.ts` | as-of resolution with walk-back | pure |
| `jobs/fetch-security-prices.ts` | daily cron, yesterday only | I/O |
| `lib/crypto/btc-price.ts` | **separate** BTC acquisition path | I/O |

`backfill-core.ts` exports four planners: `resolveBackfillWindow` (resume
forward), `resolveForceBackfillWindows` (fill behind/ahead of the covered
block), `chunkWindow`, `selectInstrumentsMissingDate` (single date).

**None of them answers "what is missing over a window."** They answer "what
should I fetch next," which is a different question with a different failure
mode: a plan that returns an empty window is indistinguishable from a window
that needs nothing.

---

## 2. Findings

### F1 — There is no calendar anywhere in the codebase

Exhaustive grep for `holiday | tradingDay | marketCalendar | isWeekend | getUTCDay`
across `lib/`, `jobs/`, `scripts/` returns only prose in comments and tests, plus
one unrelated `getUTCDay()` in `lib/perspectives/time-range.ts:68`.

Market closure is handled *exclusively* by absence + walk-back:

> `service.ts:24` — "Weekends and market holidays are ABSENT rows by design."

**Consequence:** nothing in the system can distinguish *"the market was closed"*
from *"we never fetched it."* Both are a missing row. This is the single fact
that makes a coverage planner necessary, and it is why the expected-date
calendar has to be an **input**, not something the archive can imply.

### F2 — Coverage is empirically dense and single-block

Local DB, `basis = RAW_CLOSE`:

| | instruments | rows each | span | covered dates | weekdays in span |
|---|---|---|---|---|---|
| equities/ETFs | 17 | 504 | 2024-07-22 → 2026-07-24 (733d) | 504 | 525 |
| BTC | 1 | 39 | 2026-06-18 → 2026-07-26 (39d) | 39 | — (crypto: all days) |

525 − 504 = **21 weekdays absent over two years** ≈ exactly the US market
holiday count. Every interior gap sampled (15) is Fri→Tue, 4 days, **1 weekday
missed** — weekend + a Monday holiday, or Thu→Mon around Juneteenth/Good Friday.

So: `backfill-core.ts:99`'s stated assumption —

> "Assumes a single contiguous covered interval … does not attempt to detect
> gaps WITHIN that interval."

— **holds today**. But it holds as an accident of usage (one force-backfill wrote
the whole block in one pass), not by construction. Nothing detects or reports a
violation, so the day it stops holding, the failure is silent. That is the same
shape as the 2026-07-15 bug already recorded in that file's header.

### F3 — Coverage completeness is not knowable from the archive alone

`earliestCoveredISO` / `latestCoveredISO` return block edges. Nothing computes
expected-minus-covered.

BTC makes this concrete: **39 rows over a 39-day span, zero gaps.** By every
measure the current code can express, BTC coverage is *complete*. It is also
missing years of history relative to ownership. Completeness is only meaningful
**relative to a requested window** — which is why the window must be a parameter
of the planner, not a property of the instrument.

### F4 — Four instrument classes are permanently unpriceable and are retried daily, forever

Local held instruments with **zero** price rows:

| instrument | class | why no price will ever arrive |
|---|---|---|
| `CUR:USD` | `CASH` | a cash instrument has no price series — category error |
| `NVDA260522C00232500` | `OPTION` | Tiingo serves equities only |
| 3 × (null ticker) | `EQUITY` | `tickerSymbol` is null ⇒ `providerSymbol: ""` ⇒ adapter returns `[]` |

The daily cron (`jobs/fetch-security-prices.ts:75`) selects instruments missing
yesterday's date, attempts a fetch, gets `[]`, writes nothing — so tomorrow they
are still missing and it tries again. **Indefinitely, silently, with no record
that the attempt is futile.** `backfill.ts:150` degrades a null ticker to `""`
without comment.

This is the reason `unavailable` must be a first-class state and not a flavour of
`partial`: *partial* invites a retry, *unavailable* must not.

### F5 — The crypto acquisition path bypasses the provider architecture entirely

`lib/prices/providers/coingecko.ts` exports `fetchBtcDailyClosesUsd(...)` — a
bare function. **It does not implement `PriceProviderAdapter`.** It is not in the
registry (`registry.ts` registers Tiingo only). `lib/crypto/btc-price.ts` calls
it directly and writes to `priceArchive` itself.

So there are **two acquisition paths into one archive**:

```
equities:  registry → adapter → fetch.ts → backfill.ts ─┐
                                                        ├→ priceArchive
crypto:    btc-price.ts → coingecko function ───────────┘
```

Measured against the brief's stated integration test — *"adding a Solana adapter
must require no changes outside the adapter"* — **the current architecture fails
it.** Adding Solana today means a new `lib/crypto/sol-price.ts`, a new call site
in `lib/snapshots/regenerate-history.ts` (alongside `backfillBtcPrices` at
`:200`), and a new hardcoded branch in the A9 binding.

This is diagnosis, not this slice's remit — the brief says do not rewire backfill
here. Recorded as the governing constraint for a later slice.

### F6 — `CRYPTO_DAILY` is declared and unused

`PRICE_BASES` declares five bases. **Non-`RAW_CLOSE` rows in the archive: 0.**
BTC is stored as `RAW_CLOSE`, not `CRYPTO_DAILY`. Basis therefore does *not*
discriminate asset class today, and the planner cannot use it to pick a calendar.

### F7 — Expected cadence is per-asset-class

Equities: trading days = weekdays − market holidays. Crypto: all 365 days (BTC's
39/39 density confirms crypto has no expected absences). A single global calendar
would be wrong for one of them.

### F8 — Two distinct meanings of "missing"

1. **No exact row for date D** — an acquisition gap.
2. **No row resolvable for D** under walk-back within `PRICE_MAX_STALE_DAYS = 7`
   — a valuation gap.

These differ: a Saturday has no exact row but resolves fine. If the planner
reports raw calendar-date misses it will scream `partial` on every weekend.
**Resolution:** the planner reports missing *expected* dates only. Expectedness
already excludes weekends and holidays, so an expected-date miss is a genuine
acquisition gap — and the two meanings collapse into one honest number.

---

## 3. Initial proposed shape — **superseded by §6**

New pure module `lib/prices/coverage.core.ts`. No Prisma, no network, no clock,
no calendar knowledge — the expected-date set is **injected**.

```
coverageFor(input: CoverageInput): CoverageReport
```

**Input** (all data, no I/O): instrument id; requested `[fromISO, toISO]`;
`expectedDates` (injected, already calendar-filtered); `coveredDates` (from the
archive); `providerFloorISO` (adapter `historicalDepth`, nullable);
`priceable: boolean`.

**Output**: dedicated coverage states — deliberately **not** `CompletenessTier`,
which stays the vocabulary for valuation truth:

```
type CoverageState = "complete" | "partial" | "unavailable";
```

plus deterministic merged ascending `missing` ranges, counts, and coded
`reasons`: `NOT_PRICEABLE`, `NO_PROVIDER_SYMBOL`, `BEFORE_PROVIDER_DEPTH`,
`BEFORE_FIRST_COVERAGE`, `AFTER_LAST_COVERAGE`, `INTERIOR_GAP`.

`INTERIOR_GAP` earns its own reason because it is precisely the condition that
falsifies the contiguity assumption `resolveForceBackfillWindows` depends on
(F2). Today it would never fire; the value is that it *would* fire before the
assumption silently breaks.

**Not in this slice:** no rewiring of `backfill.ts`, `backfill-core.ts`, the
daily cron, or the crypto path. The planner ships pure and fixture-tested with
no production consumer — the same posture `backfill-core.ts` itself shipped in.

---

## 4. Open questions for approval

1. **Where does `expectedDates` come from?** Recommend a separate non-core module
   holding a static US-market holiday table, with the core staying calendar-free.
   Confirms the "inject the calendar" direction — but the table itself has to
   live somewhere, and a static table needs a maintenance story past its horizon.
2. **Is `unavailable` terminal or advisory?** Recommend advisory in this slice
   (planner returns it; nothing acts on it yet), with F4's daily-retry waste
   documented as follow-up. Making it terminal means persisting it, which is a
   schema change and out of scope here.
3. **Per-instrument or per-set?** Recommend per-instrument, with set-level
   aggregation left to the caller — keeps the core small and the reasons precise.
4. **Should the planner know about `PRICE_MAX_STALE_DAYS`?** Recommend **no** —
   per F8, expectedness already handles it. Walk-back stays the resolver's
   concern. Mixing them would put valuation policy inside an acquisition planner.

---

## 5. Follow-up work recorded (not this slice)

- **`V26-PRICE-PROVIDER-UNIFICATION`** (F5) — move BTC behind
  `PriceProviderAdapter` and the registry **without changing behaviour**. The
  prerequisite for the brief's Solana integration test. Not implemented in
  PRICE-1.
- **Stop retrying permanently-unpriceable instruments** (F4).
- **Upstream position-reconstruction defect** — carried over from P0; the guard
  suppresses the symptom, the cause is unfixed.
- **92 production snapshots with negative `stocks`** remain unrepaired.

---

## 6. Final contract (approved)

Pure module `lib/prices/coverage.core.ts`. No Prisma, no network, **no clock**,
no calendar data. Scope: **one instrument, one basis, one requested window.** No
aggregation. Staleness (`PRICE_MAX_STALE_DAYS`) is deliberately absent — coverage
answers *whether evidence exists*; valuation decides *whether evidence is usable*.

### Determinism contract

Identical inputs ⇒ **byte-for-byte identical output**, provable by
`JSON.stringify`. Enforced by construction:

| Hazard | Rule |
|---|---|
| ambient clock | never call `yesterdayUTCISO()` / `assertClosedDateISO()`; the window is fully specified by input |
| caller ordering | `expectedDates` / `observedDates` are treated as **sets** — deduped and sorted ascending internally before any logic |
| `Set`/`Map` iteration | membership tests only; every ordered output comes from an explicit sort |
| conditional keys | one object literal, **all keys always present**, `null`/`[]` never omission |
| reason ordering | computed as a set, emitted in `COVERAGE_REASONS` declaration order |
| locale / float | no `Intl`, no locale formatting, no percentages — integer counts only |
| provenance leakage | no timestamps, random ids, env reads, or provider-call results in the output |

`missingRanges` ascending by `fromISO`; non-overlapping; merged over **consecutive
expected-date positions**, not calendar adjacency — a Friday and the following
Monday emit ONE range. Weekend and holiday boundaries never fragment output.

### Types

```ts
export type CoverageState = "complete" | "partial" | "unavailable";

export const COVERAGE_REASONS = [
  "NOT_PRICEABLE",          // no price series by nature (CASH), caller-supplied
  "NO_PROVIDER_SYMBOL",     // no resolvable vendor identity, caller-supplied
  "BEFORE_PROVIDER_DEPTH",  // expected dates precede providerFloorISO
  "NO_COVERAGE",            // zero observed dates in the window
  "BEFORE_FIRST_COVERAGE",  // missing dates earlier than the earliest observed
  "INTERIOR_GAP",           // missing dates inside the observed block
  "AFTER_LAST_COVERAGE",    // missing dates later than the latest observed
  "NO_EXPECTED_DATES",      // the window contains no expected market dates
  "UNEXPECTED_OBSERVATION", // an observed date the calendar did not expect
] as const;
export type CoverageReason = (typeof COVERAGE_REASONS)[number];

export type Priceability =
  | { priceable: true }
  | { priceable: false; reason: "NOT_PRICEABLE" | "NO_PROVIDER_SYMBOL" };

export interface CoverageInput {
  instrumentId:     string;
  basis:            PriceBasis;
  requestedFromISO: string;
  requestedToISO:   string;
  calendarId:       string;             // provenance of expectedDates
  expectedDates:    readonly string[];  // set semantics — normalized internally
  observedDates:    readonly string[];  // set semantics — normalized internally
  providerFloorISO: string | null;      // null ⇒ unbounded depth
  priceability:     Priceability;
}

export interface CoverageRange {
  fromISO:       string;  // first MISSING expected date in the run
  toISO:         string;  // last MISSING expected date in the run
  expectedDates: number;  // count of expected dates, never calendar span
}

export interface CoverageReport {
  instrumentId:     string;
  basis:            PriceBasis;
  calendarId:       string;
  requestedFromISO: string;
  requestedToISO:   string;
  state:            CoverageState;
  missingRanges:    CoverageRange[];
  expectedCount:    number;
  observedCount:    number;
  missingCount:     number;
  unreachableCount: number;  // expected dates before providerFloorISO
  unexpectedCount:  number;  // observed dates the calendar did not expect
  reasons:          CoverageReason[];
}

export function coverageFor(input: CoverageInput): CoverageReport;
```

The planned calendar seam (types only in PRICE-1, **zero implementations**),
added to `lib/prices/types.ts` beside the other contracts:

```ts
export interface TradingCalendar {
  readonly id: string;  // "us-equity" | "crypto-247" | …  — stamped as calendarId
  expectedDates(fromISO: string, toISO: string): readonly string[];
}
```

### Decision procedure (ordered — order is part of the contract)

1. Validate every ISO date; **throw** on malformed input or an inverted window.
2. Normalize: dedupe + sort both date sets; clip both to the requested window.
3. `!priceable` ⇒ `unavailable`, `missingRanges: []`, reason from input.
4. `expectedCount === 0` ⇒ `complete` + `NO_EXPECTED_DATES`.
5. `unreachableCount === expectedCount` ⇒ `unavailable` + `BEFORE_PROVIDER_DEPTH`.
6. `actionable = expected − unreachable`; `missing = actionable − observed`.
7. `missingCount === 0` ⇒ `complete`.
8. otherwise ⇒ `partial` + positional reasons (+ `BEFORE_PROVIDER_DEPTH` when
   `unreachableCount > 0`).
9. `UNEXPECTED_OBSERVATION` appended whenever an observed date is not expected —
   **never changes `state`**. It is the tripwire for a stale calendar.

**Invariant:** `missingRanges.length > 0` ⟺ `state === "partial"`.
An `unavailable` report never lists acquisition targets.
