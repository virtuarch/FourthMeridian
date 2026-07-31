# V26 QUANTITY arc — execution ledger

Companion to `V26-QUANTITY-1-HISTORICAL-OWNERSHIP-RECONSTRUCTION.md` (the
investigation) and `V26-PRICING-ARC-EXECUTION-LEDGER.md` (the price side).

The arc's target equation:

```
Historical Value(t) = Historical Quantity(t) × Historical Price(t) × Historical FX(t)
```

PRICE solved the price term. QUANTITY must produce `Historical Quantity(t)`
**without projecting present-day holdings backward**.

---

## 1 · Slices executed

| Slice | Status | Commit | Files |
|---|---|---|---|
| QUANTITY-1A — stop resurrecting closed positions | committed | `c33ea26` | `valuation.ts`, `valuation-core.ts`, `valuation-core.test.ts` |
| QUANTITY-1B — normalized quantity-event contract | committed | `faed5eb` | `quantity-event.core.ts`, `quantity-event.core.test.ts`, `scripts/check-quantity-replay-readiness.ts` |
| QUANTITY-1C — evidence-aware replay | committed | `3d047fd` | `lib/investments/quantity-replay.core.ts`, `lib/investments/quantity-replay.core.test.ts` |
| QUANTITY-1C.1 — timeline coverage and anchor representation | committed | `c97cf2d` | same two files |
| QUANTITY-1D — reconciliation evidence and candidate explanations | committed | `c67c6f1` | `quantity-reconciliation.core.ts`, `quantity-reconciliation.core.test.ts` |
| QUANTITY-1E — event-stream completeness binding | **BLOCKED** — no ingestion-coverage record exists to bind to (§7) | — | — |
| QUANTITY-1F — quantity timeline read authority | blocked behind 1E | — | — |

No schema change, no migration, no DB binding, no valuation integration, no
snapshot regeneration, and no production mutation has occurred in any slice of
this arc.

---

## 2 · QUANTITY-1C — contracts as shipped

### Input

```ts
interface ReplayInput {
  instrumentId:  string;
  accountId:     string;
  anchors:       readonly QuantityAnchor[];           // order irrelevant, sorted internally
  events:        readonly NormalizedQuantityEvent[];  // QUANTITY-1B output, unmodified
  windowFromISO: string;   // 1C.1 — the REQUESTED interval, a caller decision
  windowToISO:   string;
  eventStream:   EventStreamCompleteness;             // 1C.1 — required, never inferred
  tolerance?:    number;                              // default 1e-6
}

interface QuantityAnchor {
  observationId:        string;
  dateISO:              string;
  effectiveDateTimeISO: string | null;   // normally null — PositionObservation.date is @db.Date
  quantity:             number;
  origin:               string;          // PositionOrigin as data; the core imports no Prisma
  completeness:         string;
}
```

`effectiveDateTimeISO` must never be synthesised from `createdAt` or a row id.
Neither is evidence of when a holding was true.

### Output

```ts
interface QuantityTimeline {
  instrumentId; accountId; windowFromISO; windowToISO: string;
  summary:     "ABSOLUTE_COMPLETE" | "ABSOLUTE_WITH_GAPS" | "RELATIVE_ONLY" | "UNREPLAYABLE";
  segments:    QuantityTimelineSegment[];
  uncovered:   UncoveredInterval[];   // 1C.1 — requested time no segment speaks for
  diagnostics: ReplayDiagnostics;
}

type EventStreamCompleteness =
  | { kind: "COMPLETE"; fromISO: string; toISO: string; source: string }
  | { kind: "PARTIAL";  coveredFromISO: string | null; coveredToISO: string | null; reason: string }
  | { kind: "UNKNOWN";  reason: string };

interface UncoveredInterval {
  fromISO: string; toISO: string;
  reason: "BEFORE_FIRST_DEFENSIBLE_ANCHOR" | "BETWEEN_INDEPENDENT_ANCHORS"
        | "AFTER_LAST_DEFENSIBLE_EVIDENCE" | "EVENT_STREAM_COMPLETENESS_UNKNOWN";
}
```

`fromISO === toISO` is a POINT: the claim holds on that date and says nothing
about the next. Only a licensed event stream widens a claim into an interval.

| Segment kind | carries | never carries |
|---|---|---|
| `ABSOLUTE` | `quantity`, `basis: OBSERVED_ANCHOR \| REPLAYED`, `derivedFrom`, `orderCertainty` | — |
| `RELATIVE` | `cumulativeDelta`, `reason: MISSING_OPENING_ANCHOR` | `quantity` |
| `UNRESOLVED` | `reason`, `blockingEventIds` | `quantity`, `cumulativeDelta` |

Unknown quantity is **structurally non-numeric**: `{ quantity: 0, basis:
"UNKNOWN" }` is unwritable by construction, not merely discouraged.

`ReplayDiagnostics`: `unsupportedEventIds`, `unattributableEventIds`,
`invalidEventIds`, `neutralEventIds`, `unresolvedTransferEventIds`,
`orderSensitiveGroups`, `missingOpeningAnchor`, `anchorRejectedReason`,
`absoluteResolvedThroughISO`, `resumedFromAnchors`, `anchorOutcomes`,
`reconciliationResidues`. All arrays deterministically sorted.

### Anchor allowlist

`PERMITTED_ANCHOR_ORIGINS = { OBSERVED, IMPORTED, USER_ASSERTED }`.

**DERIVED is rejected.** It is reconstruction *output*, so anchoring on it would
let a replay anchor on a previous replay and compound its own error invisibly;
and DERIVED rows are rewritten by a sync that records nothing in either
observability ledger, so a timeline anchored on one is not reproducible.

Every anchor gets exactly one `AnchorOutcome`, carrying its identity, date,
quantity, origin and completeness across three **orthogonal** axes (1C.1) —
collapsing them into one word made "opened", "confirmed", "resumed" and "stated
an isolated fact" indistinguishable:

| Axis | Values |
|---|---|
| `admissibility` | `PERMITTED` · `REJECTED_ORIGIN` · `OUTSIDE_WINDOW` |
| `openingRole` | `OPENING` · `RESUME` · `AMBIGUOUS_SAME_DAY` · `NONE` |
| `representation` | `INTERVAL` · `POINT` · `COVERED_BY_INTERVAL` · `NOT_REPRESENTED` |

A later anchor winning the opening does not make an earlier one untrue: an
anchor no licensed interval covers is emitted as a POINT at its own date.

### Absolute vs relative semantics

- An anchor strictly before the first event opens an absolute run; the latest
  qualifying anchor wins.
- Without a qualifying anchor the timeline is **RELATIVE only**. A first `BUY 3`
  yields `cumulativeDelta 3`, never `quantity 3`; a first `SELL 1` yields
  `cumulativeDelta −1`, never `quantity −1`.
- Explicit `0` remains an ABSOLUTE **known-closure** segment, not a gap.
  Negative (short) quantities remain valid and are never clamped.
- No segment exists before the first defensible evidence (PRICE-5A doctrine).
- Unsupported, invalid or order-sensitive evidence stops exact replay at its own
  boundary. Absolute replay resumes only from a **later permitted anchor**, at
  that anchor's own quantity — never the stale pre-gap one.
- A confirming anchor that disagrees beyond tolerance records a
  `reconciliationResidue`; replay keeps its own value and never snaps to the
  anchor.
- The summary is derived from **interval coverage over the whole requested
  window** (1C.1), not from which segment kinds are present.
  `ABSOLUTE_COMPLETE` means every date in `[windowFromISO, windowToISO]` is
  covered by a defensible absolute segment, with no relative, unresolved or
  uncovered interval anywhere. `ABSOLUTE → UNRESOLVED → ABSOLUTE` reports
  `ABSOLUTE_WITH_GAPS`; so does one late absolute point in a month-long window.
- **Point truth is not interval truth** (1C.1). An observation proves a date.
  Extending it across days is a claim that nothing happened in between, and the
  only evidence for that is a declared-complete event stream. Absence of events
  is not evidence of absence of movement, so interval width is licensed by
  `EventStreamCompleteness` — a required input the core never infers, because a
  stream with no events looks identical whether nothing happened or nothing was
  imported. Under `UNKNOWN` every absolute fact stays a point.
- Segments of the same kind never overlap. An ABSOLUTE point MAY sit inside a
  RELATIVE run — the APLD shape, where an end-of-day observation states the
  level on one date while surrounding events state only movement. Both are true
  of that day; suppressing either would discard evidence, not resolve a
  contradiction.

### Same-day ordering policy

Classified by operator algebra, not hope:

| Classification | Condition | Effect |
|---|---|---|
| `ORDERED` | every event carries a real datetime | replay in evidenced order |
| `COMMUTATIVE` | all deltas, or all ratios | tie-break provably cannot change the result |
| `ORDER_SENSITIVE_UNRESOLVED` | ≥1 ratio mixed with ≥1 delta | stops exact replay |

`(q+d)·r ≠ q·r+d`, so a mixed group has two real answers. Emitting either as
fact is the failure mode this rule exists to prevent. Tie-breaking never
upgrades `orderCertainty` to `KNOWN`.

---

## 3 · Validation record

### QUANTITY-1C (`3d047fd`)

Gates: `tsc --noEmit` byte-identical to a baseline taken with the slice's files
removed (md5 `4c8a7bfa6136125b9ba60b8ba7b67b6c`, 20 errors, **all** in the
gitignored, untracked `prototype/prototype-ops-control-plane/` and all one
pre-existing defect class — a `source` union in the prototype's own
`parts.tsx`). `npm run lint` 0 errors / 7 pre-existing warnings. `test:unit`
409/409. Fixtures 103/103.

Three defects the fixtures found, and fixed:

1. **Inverted empty segments.** Every run superseded on the day it opened — a
   second event the same day, an earlier-timestamped same-day anchor, the first
   relative event — emitted a segment running `2026-03-01 → 2026-02-28`.
2. **Intermediate anchors were never reconciled.** The confirming check ran only
   on dates that had events, so an anchor on a quiet date fell through to unused
   and a disagreement produced no residue.
3. **`NEUTRAL` events were accounted for nowhere.** A cash dividend correctly
   changes no quantity but was absent from segments and diagnostics alike, so
   "changed nothing" and "was dropped" looked identical from outside.

### QUANTITY-1C.1 (`c97cf2d`)

Gates: production TypeScript 0 errors; `tsc` output md5 unchanged at
`4c8a7bfa6136125b9ba60b8ba7b67b6c`, so the amendment introduced no error in any
path, tracked or ignored. `npm run lint` 0 errors / 7 warnings (an eighth,
`coversDate` unused, was found and removed before commit). `test:unit` 409/409.
Fixtures 116/116. QUANTITY-1A and 1B fixtures re-run green.

**No arithmetic or event normalization changed.** The event-application loop is
textually identical under `git diff`, and `quantity-event.core.ts` is untouched.

---

## 4 · Real-corpus replay (local, read-only, nothing persisted)

25 pairs · 50 events · 159 position observations. Verified unchanged after each
run: events 50, positions 159, snapshots 1679. Every pair declares
`UNKNOWN_EVENT_STREAM` — no ingestion-coverage binding exists, and inferring
completeness from the events is exactly what the contract forbids.
`windowFromISO` is the caller's choice: this report uses each pair's earliest
evidence date, `windowToISO` the corpus maximum `2026-07-31`.

| Summary | 1C | 1C.1 |
|---|---|---|
| `ABSOLUTE_COMPLETE` | 11 | **0** |
| `ABSOLUTE_WITH_GAPS` | 1 | **20** |
| `RELATIVE_ONLY` | 9 | **1** |
| `UNREPLAYABLE` | 4 | 4 |

**Zero of the 11 previously-complete timelines remain complete**, which is the
point of the amendment: with no evidence that the event stream records every
movement, no multi-day window is defensibly complete. 57 uncovered intervals and
101 isolated anchor points are now visible where before they were absent from
the output entirely.

Anchors confirmed by a licensed interval 7 · anchors disagreeing with one **0** ·
largest residue **0.00000000** · unresolved same-day groups 0 · resumptions 1 ·
rejected DERIVED anchors 44 · ambiguous same-day anchors 6 · events represented
**50/50, zero silent drops**.

### Per-pair before → after

| Pair | 1C | 1C.1 | Uncovered | Why it moved |
|---|---|---|---|---|
| Limit Liability / CUR:USD | `ABSOLUTE_COMPLETE` | `ABSOLUTE_WITH_GAPS` | 2 | 6 anchors `11.65 @ 07-19 … 3556.22 @ 07-31` now all stated; the late one no longer erases the early ones |
| Limit Liability / SPCE | `ABSOLUTE_COMPLETE` | `ABSOLUTE_WITH_GAPS` | 2 | 07-19…07-21 observations were previously uncovered *and* unstated |
| Limit Liability / NKE, TXN, JPM | `ABSOLUTE_COMPLETE` | `ABSOLUTE_WITH_GAPS` | 3 | same shape |
| Limit Liability / AMZN, TSLA | `ABSOLUTE_COMPLETE` | `ABSOLUTE_WITH_GAPS` | 2 | same shape |
| Limit Liability / TQQQ | `ABSOLUTE_WITH_GAPS` | `ABSOLUTE_WITH_GAPS` | 3 | unchanged classification; invalid split still blocks `2025-11-20 → 2026-07-18` |
| Robinhood / CUR:USD | `ABSOLUTE_COMPLETE` | `ABSOLUTE_WITH_GAPS` | 3 | anchor-only pair, no completeness evidence |
| Robinhood / SIRI, TTWO | `ABSOLUTE_COMPLETE` | `ABSOLUTE_WITH_GAPS` | 2 | anchor-only pair |
| Cold Wallet / BTC | `ABSOLUTE_COMPLETE` | `ABSOLUTE_WITH_GAPS` | 1 | **B-3 closed** — a single 07-19 observation no longer spans to 07-31 |
| NVDA, INTC, APLD, OKLO, QBTS, VST, VGT, VRT | `RELATIVE_ONLY` | `ABSOLUTE_WITH_GAPS` | 3–6 | their post-event OBSERVED rows are now stated as points; movement before them stays relative |
| Robinhood / NVDA260522C00232500 | `RELATIVE_ONLY` | `RELATIVE_ONLY` | 1 | its only anchor is DERIVED, correctly rejected — nothing absolute exists |
| 3 transfer-only pairs, 1 unattributable | `UNREPLAYABLE` | `UNREPLAYABLE` | — | unchanged |

### Named shapes

- **SPCE** — replays 1 → 0 across its sale; residue 0. The QUANTITY-1A defect
  (valuing sold positions forever) is provable end-to-end. Under 1C.1 the
  07-19…07-21 observations are stated as points rather than discarded.
- **NVDA** — 5 DERIVED anchors all rejected; events begin 2025-10-02 and every
  OBSERVED row postdates them by nine months, so movement before 2026-07-19 is
  relative and the observations after it are points. 6 uncovered intervals.
- **TQQQ** — gap `2025-11-20 → 2026-07-18` (`INVALID_EVENT`, id
  `cmrth642e001s5fn5wv9hak2r`, a SPLIT with no ratio), then resumed from a later
  OBSERVED anchor. The only resumption in the corpus.
- **APLD** — its only observation is dated on the event day with no timestamp,
  so it is `AMBIGUOUS_SAME_DAY` and never an opening. This is the
  double-counting case (buy 3 vs observation 3 "reconciling" to 6). Under 1C.1
  the observation is still emitted, as a point.
- **BTC** — the case that motivated the amendment. One observation
  `0.24060252 @ 2026-07-19`, 25 recorded inflows totalling `0.22031745`, zero
  outflows in three years, 8.43% unexplained, a known-partial import. It now
  states a point and one uncovered interval instead of claiming a complete
  history.

### Blocked pairs, with ids

| Pair | Reason | Blocking id |
|---|---|---|
| Limit Liability / TQQQ | `INVALID_EVENT` — SPLIT with null ratio | `cmrth642e001s5fn5wv9hak2r` |
| Limit Liability / `cmrth646g002…` | `UNSUPPORTED_EVENT` — transfer | `cmrth646y002k5fn51r8ryat1` |
| Individual / `cmrth6479002…` | `UNSUPPORTED_EVENT` — transfer | `cmrth647i002o5fn51lqcvas1` |
| Individual / `cmrth647n002…` | `UNSUPPORTED_EVENT` — transfer | `cmrth647w002s5fn5yr8tt4u6` |
| (no positions) / null instrument | `UNATTRIBUTABLE` — `NO_INSTRUMENT` | `cmrsfgwmn000jthho4vyn4yz4`, `cmrsfgwn6000lthhonnrdwvlz`, `cmrsfgwnc000nthho28o1s9w6`, `cmrsfgwor000vthhopubjwn0x` |

### Agreement with the QUANTITY-1B readiness audit (as of 1C)

| 1B readiness | n | 1C summary |
|---|---|---|
| `RECONCILABLE` | 6 | 6 × `ABSOLUTE_COMPLETE` |
| `PARTIAL_HISTORY` | 9 | 9 × `RELATIVE_ONLY` |
| `NO_REPLAYABLE_EVENTS` | 8 | 5 anchor-only + 3 transfer-only |
| `UNSUPPORTED_EVENTS` | 1 | TQQQ, resumed |
| `UNATTRIBUTABLE_EVENTS` | 1 | 1 × `UNREPLAYABLE` |
| `MISMATCH` | 0 | 0 |

Nothing was unexplained. The two differences were 1C being more truthful than
the 1B classifier, not disagreement: 1B conflated "has observations but no
events" with "has events we cannot use", and had no notion of resumption.

---

## 5 · Remaining blockers

**B-1 — No opening anchor exists for anything predating first connect.** The
anchor supply is 115 OBSERVED / 44 DERIVED; every OBSERVED row starts
2026-07-19, the first Plaid connect. All 44 DERIVED are rejected. So the 9
`RELATIVE_ONLY` pairs are not a normalization failure — they are the structural
consequence of provider history beginning after the events it describes.
Back-solving an opening quantity from a *later* observation is exactly
QUANTITY-1D.

**B-2 — CLOSED in QUANTITY-1C.1 (`c97cf2d`).** Every permitted anchor is now an
independent absolute fact; an anchor no licensed interval covers is emitted as a
POINT at its own date, and omitted time is reported in `uncovered`.

**B-3 — PARTIALLY CLOSED in QUANTITY-1C.1 (`c97cf2d`).** The replay no longer
treats absence of events as absence of movement: interval width is licensed by
`EventStreamCompleteness`, and under `UNKNOWN` every absolute fact stays a
point. What remains open is the **binding**: nothing in the codebase yet
determines whether a given account's event stream is COMPLETE over an interval.
That fact lives in the ingestion record — the provider's history window, cursor
reach, whether the initial import finished — and until a binding reads it, every
caller must honestly declare `UNKNOWN`, which is why the local corpus now
contains zero `ABSOLUTE_COMPLETE` timelines.

**B-4 — Two sign conventions coexist in `InvestmentEvent`** (QUANTITY-1B
finding, unchanged): BUY/SELL store magnitudes while TRANSFER_IN/OUT store
negatives. Transfers remain `UNSUPPORTED_SEMANTICS` rather than being guessed.

**B-6 — `ABSOLUTE_COMPLETE` is currently unreachable in production data.** This
is correct, not a regression: it is what the absence of a completeness binding
honestly implies. It does mean the arc cannot deliver a complete historical
quantity series until B-3's binding exists.

**B-5 — No consumer.** QUANTITY-1C produces timelines that nothing reads.
Valuation still calls `resolveHeldQuantity`. This is deliberate — see
`tx3-arc-execution`: never ship an authority without a consumer, and never wire
a consumer before the authority is trusted — but it means no user-visible
outcome is yet fixed.

---

## 6 · Confirmation of no production mutation

No slice in this arc has touched production. QUANTITY-1C specifically: no
schema, no migration, no DB binding, no valuation integration, no snapshot
regeneration, no writes, no provider calls. The real-corpus pass ran against the
**local** database from a script held outside the repository (scratchpad only,
not committed) and asserted row counts unchanged on exit: events 50, positions
159, snapshots 1679. QUANTITY-1C.1 was validated the same way, with the same
result.


---

## 7 · QUANTITY-1E is blocked: there is no ingestion record to bind to

QUANTITY-1C.1 introduced `EventStreamCompleteness` as a pure input and recorded
that "the DB binding that determines it remains later work". QUANTITY-1E was to
be that binding. **It cannot be written**, because the fact it would read is not
stored anywhere.

### Evidence

`lib/investments/investment-event-ingest.ts:52`

```ts
/** 24-month request window ending today (Plaid's supported historical depth). */
export function computeIngestWindow(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), now.getUTCDate()));
  return { start: ymd(start), end: ymd(now) };
}
```

1. **The window is derived from `now` and never persisted.** `computeIngestWindow`
   has exactly two references in the entire repository — its definition and its
   single call site at `:144`. Nothing writes the window, the outcome, or the
   earliest date any successful pull reached.
2. **No schema field records investment-event coverage.** `PlaidItem` carries
   `cursor`, `lastSyncedAt`, `syncIncompleteAt`, `completedSyncCount` — all of
   which describe the TRANSACTIONS sync. There is no investment equivalent.
3. **The window slides.** Complete over `[2024-08, 2026-08]` on one day, over
   `[2024-09, 2026-09]` the next. Rows older than 24 months are never re-fetched
   and never deleted, so the stored corpus is the union of every window ever
   pulled — and nothing records which windows those were.
4. **The corpus does not fill the nominal window.** Stored events span
   `2025-07-31 → 2026-07-27`, roughly twelve months against a nominal
   twenty-four. Either Plaid returned only that much or a pull was partial.
   **Nothing distinguishes those, and nothing records which happened.**
5. `INVESTMENT_EVENTS_ENABLED` is a kill switch. Any period during which it was
   off has no events, and nothing records that either.
6. `ImportBatch` holds **0 rows**; all 50 events are `source=plaid`.

### Why this cannot be worked around

The only two implementations available without a schema change are both wrong:

- **Infer completeness from the events.** Explicitly forbidden by the pinned
  1C.1 contract, and unsound for the reason that motivated it: a stream with no
  events looks identical whether nothing happened or nothing was imported.
- **Return UNKNOWN unconditionally.** Correct, but it ships an authority that
  can never return anything else — an elaborate constant.

### What 1E actually requires

An ingestion-coverage ledger written at ingest time, recording per (item,
account) the window requested, the window confirmed returned, the outcome, and
the flag state. That is **schema + migration + writes on the ingestion path** —
all three explicitly excluded from every slice of this arc so far, and a change
to the ingest path, which is a revision of earlier work rather than a new layer
on top of it.

QUANTITY-1F (a read authority assembling anchors, events and completeness from
the database) is blocked behind it: without 1E it could only ever produce the
UNKNOWN timelines the corpus scripts already produce.
