# V26 Historical Market Data — Execution Ledger

**The one authoritative record for the pricing arc.** Updated at every slice stop.

Status vocabulary (a slice may hold several; the last one reached is its real status):
`planned` → `implemented` → `validated` → `committed` → `deployed` →
`production data repaired` → `user-visible behavior verified`

> **A user-visible issue is never marked fixed because its supporting
> infrastructure exists.** Infrastructure is `committed`; the issue is fixed only
> at `user-visible behavior verified`.

---

## 0 · Epic status

**THE PRICE EPIC IS COMPLETE.** P0 · PRICE-1 · PRICE-2 · PRICE-3 ·
PRICE-PROVIDER-UNIFICATION · PRICE-4 · PRICE-5 · PRICE-5A · PRICE-5B ·
**PRICE-4C (`5fffbe0`)** — all committed and validated. Suite 406/406.

**V26-QUANTITY-1 investigation STARTED** —
`docs/plans/V26-QUANTITY-1-HISTORICAL-OWNERSHIP-RECONSTRUCTION.md`. Read-only;
no code, no schema, no migration, no data mutation.

**Not approved, and not performed:**
- production regeneration
- production quantity mutation
- production acquisition (the executed run was LOCAL only)

**Headline QUANTITY finding:** `holdConstantBeforeEarliest` resurrects CLOSED
positions forward, not merely projecting open ones backward. TSLA — sold
2026-07-27 — is valued at quantity 1 / $298.32 on 2026-07-29 under the flag the
regeneration binding actually passes. **13 (account, instrument) pairs** are
affected. Orthogonal to PRICE-5A, which only guards prehistory. Proposed first
slice: **QUANTITY-1A**, a ~5-line pure fix requiring no new architecture.

---

## 0b · QUANTITY initiative

### V26-QUANTITY-1B — Normalized quantity-event contract

| | |
|---|---|
| **Status** | **committed** — pure contract only; no replay, no valuation change |
| **Commit** | `faed5eb` |
| **Files changed** | 3 files, +986. NEW `lib/investments/quantity-event.core.ts` (381) · `quantity-event.core.test.ts` (383, **94 fixtures**) · `scripts/check-quantity-replay-readiness.ts` (222, read-only). |
| **Mapping decisions** | BUY `+qty` · SELL `−qty` (magnitude + type direction, 22/22 consistent) · SPLIT ratio-only · cash kinds NEUTRAL · MERGER/SPIN_OFF/SYMBOL_CHANGE/REINVESTMENT `CONVERSION_NOT_IMPLEMENTED` · null instrumentId `UNATTRIBUTABLE` (distinct from unsupported) · unknown/future enum reported, never silently NEUTRAL. |
| **DIVIDEND CORRECTION** | The QUANTITY-1 investigation said "24 rows, 20 with quantity" and the 1B plan mapped units-bearing dividends to a reinvestment INCREASE. **Both wrong** — that count came from `COUNT(quantity)`, which counts non-nulls **including zeros**. All 24 are `cash/dividend` with quantity 0 or null. No reinvestment exists; none was invented. All 24 → `NEUTRAL / CASH_DIVIDEND`. |
| **TRANSFER LIMITATION** | TRANSFER_IN 2/2 and TRANSFER_OUT 1/1 carry NEGATIVE quantities. Under the BUY/SELL rule TRANSFER_IN becomes negative; under the schema rule SELL becomes positive. Three rows cannot settle it → `UNSUPPORTED_SEMANTICS / SIGN_CONVENTION_UNRESOLVED`. **3 pairs blocked.** Resolution = QUANTITY-1F. |
| **ORDERING LIMITATION** | `certainty: KNOWN` only with a real datetime. Corpus: **KNOWN 2 · TIE_BROKEN 48**; 5 same-day collision groups, **only 1 with known chronology**. That the one order-sensitive collision carries datetimes is an empirical accident, pinned as such — 1C must be safe without it. |
| **Replay-operator XOR** | Structural: two private constructors make "both" and "neither" unconstructible; excluded events carry no operator so a provider ratio cannot leak. **0 violations** across the corpus. |
| **Corpus counts** | 50 in / 50 out, **0 silent drops**. REPLAYABLE 22 · NEUTRAL 20 · UNATTRIBUTABLE 4 · UNSUPPORTED_SEMANTICS 3 · INVALID 1. Reasons: CASH_DIVIDEND 20 · NO_INSTRUMENT 4 · SIGN_CONVENTION_UNRESOLVED 3 · MISSING_RATIO 1. |
| **Replay-readiness (pairs)** | 25 pairs: **RECONCILABLE 6 · PARTIAL_HISTORY 9 · UNSUPPORTED_EVENTS 1 · UNATTRIBUTABLE_EVENTS 1 · NO_REPLAYABLE_EVENTS 8 · MISMATCH 0.** 3 blocked by transfers; **9 need opening-balance reconstruction**. Event readiness (22/50) and pair readiness (6/25) are reported separately and never conflated. |
| **Classifier corrections made during Phase 4** | The readiness classifier was wrong twice before it was right: (1) it compared the residue against zero instead of against the opening quantity, flagging every correctly-closed position as MISMATCH; (2) it accepted an observation dated ON the first event day as an opening anchor, which double-counts (APLD: buy 3 vs same-day observation 3 "reconciled" to 6). The anchor must be **strictly before** the first event. MISMATCH is now 0 — the earlier count was an artefact. |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · suite **407/407** · 94 focused fixtures · QUANTITY-1A, PRICE-5A and P0 fixtures green · 3 read-only probes exit 0. |
| **Valuation behaviour** | **unchanged** — nothing imports this module yet. |
| **Provider calls / writes** | **none / none.** Audit guard: events 50 unchanged, positions 159 unchanged. |
| **Production mutation** | **none. Production regeneration remains UNAPPROVED.** |
| **Next dependency** | **QUANTITY-1C** — pure replay core over this exact contract. |

### V26-QUANTITY-1A — Preserve explicit closed-position quantities

| | |
|---|---|
| **Objective** | Stop the constant-quantity fallback resurrecting sold positions forward in time. |
| **Status** | **committed** |
| **Commit** | `c33ea26` |
| **Files changed** | 3 files, +194 −19. `lib/investments/valuation-core.ts` (+85, new pure `resolveHeldQuantity`) · `lib/investments/valuation.ts` (call site + import, −19) · `lib/investments/valuation-core.test.ts` (+97, 20 fixtures). |
| **Semantics** | `null` (uncovered) may hold constant · `0` (OBSERVED closure) never may · explicit zero returned as `0`, never normalised to `null` · pass-through is `!== null` so NEGATIVE positions survive (NVDA is −2.0058 locally) · `heldConstant` true only for a null input resolved from a positive earliest observation · the downstream `quantity == null \|\| quantity === 0` exclusion remains the final aggregation authority. |
| **Tests** | 20 DB-free fixtures incl. the TSLA regression shape; 10 focused suites re-run green; **suite 406/406**; tsc 0 production errors; lint 0 errors / 7 pre-existing warnings. |
| **Measured local impact** | Both rules run over **identical current data** to isolate the code change: **18 pair-days differ, all resurrections removed, ZERO in the opposite direction.** Three pairs stop being resurrected: **AMZN, SPCE, TSLA**. TSLA on 2026-07-29 with `holdConstant: true` → **EXCLUDED** (was qty 1 / $298.32). NVDA on 2025-10-29 still values at **−2.0058 / −415.28** — negatives unchanged. |
| **CORRECTION to the QUANTITY-1 investigation** | The investigation implied all **13** terminal-zero pairs were resurrected. Only **3** were — the other 10 have a non-positive earliest observation, so the pre-existing `earliest.quantity > 0` guard already blocked them. The investigation document overstates this and should be read with this correction. |
| **Snapshot-level before/after NOT attributable** | The local DB was mutated by a running dev server **during** the session: 49 `DERIVED` reconstruction rows created 2026-07-31T02:51 (NKE −4, TXN −1, JPM −1, NVDA −2.0058) and a new snapshot through 2026-07-31. Current dry run reads UPDATED 4 / UNCHANGED 3 / SKIPPED 728 / BLOCKED 5, representativeness 4/0/0, 1 discontinuity — but the earlier 326/4/402/5 baseline predates that drift, so the movement **must not be attributed to this fix**. The isolated 18-pair-day figure above is the defensible number. |
| **Probes — all read-only, verified** | `dry-run-regeneration` · `regeneration-delta-attribution` (own guard: prices 8,766 unchanged, snapshots 1,679 unchanged, observed 947 unchanged) · `check-snapshot-integrity` exit 0 · `check-price-coverage` exit 0 · `check-acquisition-plan` exit 0. |
| **Provider calls / writes** | **none / none** |
| **Production mutations** | **none. Production regeneration remains UNAPPROVED.** |
| **Next dependency** | **QUANTITY-1B** — pure normalized quantity-event contract. Quantity is still resolved by nearest-observation lookup; no event replay exists. |

---

## 1 · Slice register

### P0 — Invalid-valuation guard

| | |
|---|---|
| **Objective** | Stop negative / non-finite provider-derived investment and digital-asset valuations from being written to snapshots. |
| **Status** | **committed** — not deployed, no production data repaired |
| **Plan document** | `V26-INVESTIGATION-HISTORICAL-VALUATION-INTEGRITY.md` |
| **Commit** | `aa0146a` |
| **Files changed** | `lib/snapshots/regenerate-history.core.ts` · `lib/snapshots/regenerate-history.core.test.ts` · `scripts/check-snapshot-integrity.ts` (new) |
| **Tests added** | 38 assertions (section 8 of the core fixtures) |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · suite 394/394 · probe CLEAN on local |
| **Architectural decisions** | Skip-not-clamp: an unusable valuation SKIPS the day (`skip-unsupported`, code `INVALID_VALUATION_EVIDENCE`), never clamps, zeroes, or falls back to flat. Mixed validity skips the WHOLE day. Amendments cannot bypass the guard. |
| **Acceptance passed** | Impossible values cannot be written on any path, including amendment. Absent-evidence skips remain distinguishable from invalid-evidence skips. |
| **Residual risks** | Upstream position-reconstruction defect UNFIXED — the guard suppresses the symptom only. 92 production snapshots with negative `stocks` (min −1,810) remain unrepaired; the guard cannot repair retroactively. |
| **Local probes** | `scripts/check-snapshot-integrity.ts` — 1678 snapshots (732 reconstructed / 946 observed), zero findings |
| **Provider calls / credits** | none / none |
| **Production mutations** | none |
| **Awaiting approval** | Run the integrity probe against production. Repair the 92 rows (separate slice — repair before the writer is guarded would simply be overwritten; the writer is now guarded, so repair is unblocked). |
| **Next dependency** | Independent of the PRICE chain. |

### V26-PRICE-1 — Deterministic coverage planner

| | |
|---|---|
| **Objective** | Answer "what price evidence is missing" as a structured, deterministic fact. |
| **Status** | **committed** — no consumer, therefore no deployed behaviour |
| **Plan document** | `V26-PRICE-1-COVERAGE-PLANNER-INVESTIGATION.md` |
| **Commit** | `44de904` |
| **Files changed** | `lib/prices/coverage.core.ts` (new, 335) · `lib/prices/coverage.core.test.ts` (new, 402) · `lib/prices/types.ts` (+26, `TradingCalendar` contract only) |
| **Tests added** | 33 checks — 17 decision-procedure, 4 rejected-input, 4 determinism, 7 invariants, 2 purity |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · suite 395/395 · focused 33/33 |
| **Architectural decisions** | (1) Dedicated `CoverageState` rather than `CompletenessTier` — acquisition truth ≠ valuation truth. (2) `complete` = no ACTIONABLE provider-reachable evidence missing, NOT every requested date priced. (3) Pre-floor dates excluded from `missingRanges`, counted in `unreachableCount`, disclosed via `BEFORE_PROVIDER_DEPTH`. (4) Ranges merge over consecutive EXPECTED-DATE POSITIONS, never calendar adjacency. (5) `PRICE_MAX_STALE_DAYS` deliberately absent. (6) Malformed/inverted input throws rather than degrading. (7) An unpriceable instrument reports its priceability reason without provider-depth noise. (8) `UNEXPECTED_OBSERVATION` is diagnostic and never changes `state`. |
| **Acceptance passed** | Byte-for-byte determinism under shuffle, duplication, and repeat. Golden JSON derived by hand from the decision procedure BEFORE first run and matched on first execution — the fixture pins the contract, not the implementation's output. Purity proven by replacing `globalThis.Date` with a constructor that throws. Invariant `missingRanges.length > 0 ⟺ state === "partial"` holds across every case. |
| **Residual risks** | No consumer and no calendar ⇒ zero observable production behaviour; same posture `backfill-core.ts` shipped in before it grew a bug that took a DB investigation to find. Fixtures prove the logic; nothing yet proves a holiday table is right. `INTERIOR_GAP` cannot fire on current data. The source-scanned purity guard proposed in `V26-INVESTIGATION-HISTORICAL-PRICE-COVERAGE.md` §19 was NOT added — see Conflict 4 / Open Item OI-2 below. |
| **Local probes** | Coverage-shape measurement against the local archive (17 equities × 504 rows / 733-day span / 525 weekdays; BTC 39 rows / 39-day span; 15 sampled interior gaps all weekend+holiday) |
| **Provider calls / credits** | none / none |
| **Production mutations** | none |
| **Awaiting approval** | none for this slice |
| **Next dependency** | PRICE-2 supplies the calendar and the archive read that give this planner real inputs. |

### V26-PRICE-2 — Trading calendars and read-only binding

| | |
|---|---|
| **Objective** | Give `coverageFor()` real expected and observed dates, and expose a read-only production answer to what evidence is complete, missing, unreachable, unexpected, or unavailable. |
| **Status** | **committed** — read-only; no production behaviour altered |
| **Plan document** | `V26-PRICE-1-COVERAGE-PLANNER-INVESTIGATION.md` (§6) + the PRICE-2 Phase 2 plan |
| **Commit** | `6697c6c` |
| **Files changed** | NEW `lib/calendar/trading-calendar.ts` · `us-equity-calendar.ts` · `crypto-calendar.ts` · `data/us-holidays-{2024,2025,2026,2027}.ts` · `data/exceptional-closures.ts` · `lib/prices/coverage-binding.core.ts` · `lib/prices/coverage-binding.ts` · `scripts/check-price-coverage.ts` · 3 test files. MODIFIED `lib/prices/archive.ts` (+`readCoveredDates`) · `lib/prices/types.ts` (+optional reader member). 16 files, +1,749. |
| **Tests added** | 3 files — US equity calendar (43 checks), crypto calendar (24), binding core (39) |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · suite **398/398** · probe exit 0 · PRICE-1 and P0 fixtures re-run green |
| **Architectural decisions** | (1) Calendars are DATA; expected dates are never inferred from the archive. (2) `CalendarFailure` is structurally separate from `CoverageReport`; **HORIZON_EXCEEDED is not a coverage reason**. (3) Calendar selection is by MARKET IDENTITY (MIC), not asset class — absent/unrecognised MIC yields `NO_CALENDAR_FOR_MARKET`, never a US guess. (4) Quote currency enforced at the binding (OI-1 option b), keeping `coverage.core.ts` dates-only. (5) An empty registry yields a **null** provider floor — coverage is not acquisition. (6) `readCoveredDates` returns dates + currency but **not** prices. (7) Priceability is decided before calendar selection, so CASH-with-a-ticker reads as a category error rather than an identity problem. (8) Explicit holiday tables over rule-driven generation for a bounded horizon. (9) 2024 table added beyond original scope — the archive span starts 2024-07-22. |
| **Acceptance passed** | **Falsified against real data, not just fixtures.** The archive independently records 21 absent weekdays; the calendar reproduces that set exactly. All 17 priced equities/ETFs report `complete` with expected 504 = observed 504 — i.e. NOT partial merely because weekends and holidays lack rows. BTC over a 2023 ownership window reports `partial` with a 1,264-day leading gap instead of `complete`, proving dense ≠ complete. CASH and OPTION → `NOT_PRICEABLE`; three null-ticker equities → `NO_PROVIDER_SYMBOL`. Zero unexpected observations. |
| **Residual risks** | 2027 table entries are forward assertions — unfalsifiable until data arrives. No `DELISTED` instrument exists locally (all 23 `ACTIVE`), so delisted-tail behaviour ships untested. Calendar selection depends on `marketIdentifierCode`, a nullable provider-supplied field: if Plaid stops populating it, covered equities become `NO_CALENDAR_FOR_MARKET` — fail-loud, not fail-wrong, but a new dependency. Reports are still produced for no consumer; PRICE-3 is what makes them act. |
| **Local probes** | `scripts/check-price-coverage.ts` — exit 0. Incidental operational finding: **every priced instrument shows a 4-day trailing gap 2026-07-27→2026-07-30** (`AFTER_LAST_COVERAGE`); the daily `fetch-security-prices` cron has not run since 2026-07-24 locally. |
| **Provider calls / credits** | none / none — every fake adapter's `fetchDailyCloses` throws, so a provider call would fail the suite |
| **Production mutations** | none |
| **Awaiting approval** | none for this slice |
| **Next dependency** | PRICE-3 consumes these reports to plan acquisition windows, replacing the contiguity assumption. |

### V26-PRICE-3 — Replace the contiguity assumption

| | |
|---|---|
| **Objective** | Make the coverage planner the SOLE authority for actionable acquisition windows; retire block-edge inference. |
| **Status** | **committed** — planning path changed; no acquisition behaviour executed |
| **Commit** | `427ebb7` |
| **Files changed** | NEW `lib/prices/acquisition-plan.core.ts` (216) · `lib/prices/acquisition-plan.core.test.ts` (433) · `scripts/check-acquisition-plan.ts` (230). MODIFIED `lib/prices/backfill.ts` (rewired) · `lib/prices/backfill-core.ts` (−2 planners) · `lib/prices/backfill-core.test.ts` (−2 sections) · `jobs/fetch-security-prices.ts` (+priceability filter) · `scripts/check-price-coverage.ts` (window labelling). 8 files, +1,169 −297. |
| **Tests added** | 58 acquisition-plan checks; `backfill-core.test.ts` reduced to the 8 that survive |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · suite **399/399** · all 7 focused fixture files green · all 3 probes exit 0 |
| **Architectural decisions** | (1) `resolveBackfillWindow` and `resolveForceBackfillWindows` **DELETED**, not deprecated — two coverage authorities in one directory is the condition that produced the defect. (2) The plan is a **discriminated union**, never `AcquisitionWindow[]`: seven no-window causes stay distinguishable. (3) `planning-error` tripwire for a partial report yielding no windows. (4) BELOW-DEPTH is a window limitation (`no-op`); UNPRICEABLE is an instrument verdict (`unavailable`, never retry). (5) `forceWindow` demoted from "different planner" to "explicit requested window" — both paths take one route. (6) Chunk limit is an INPUT, never read from the registry. (7) `PRICE_MAX_STALE_DAYS` still absent. (8) Fri→Mon is ONE request; runs separated by a covered date never merge. |
| **Acceptance passed** | Regression fixture **inlines the deleted resume rule** and proves it would have fetched NOTHING (`oldResumeFrom > requestedTo`) while coverage-driven planning emits the ~2-year gap ending the day before the covered block. The both-ends-covered case — which edge subtraction could not represent at all — plans the interior gap. Dry run: 18 planned / 5 unavailable; BTC's 1,268-day gap chunked into 5 requests; synthetic 3-gap case replans from 3 windows to 6 under a 3-day limit without merging across covered dates. |
| **Residual risks** | **Calendar horizon now gates acquisition**: a requested window starting before 2024-01-01 yields `calendar-unavailable` and therefore zero windows, where the old code would have fetched. Zero instruments currently have pre-2024 activity, so no live regression — but it is a real narrowing, surfaced loudly (counted as `skippedCalendarUnavailable`, logged, and flagged by the dry run) rather than silently. Fix is to extend the tables. `earliestActivityByInstrument` still uses first OBSERVATION as the ownership floor, which understates true ownership (PRICE-4's remit). |
| **Local probes** | `check-acquisition-plan.ts` (new, exit 0) · `check-price-coverage.ts` (exit 0) · `check-snapshot-integrity.ts` (CLEAN) |
| **Provider calls / credits** | none / none |
| **Production mutations** | none |
| **Next dependency** | PRICE-PROVIDER-UNIFICATION, then PRICE-4 executes these windows. |

### V26-PRICE-PROVIDER-UNIFICATION — Crypto acquisition behind the registry

| | |
|---|---|
| **Objective** | Make historical acquisition provider-agnostic BEFORE any provider credits are spent. |
| **Status** | **committed** — routing architecture only; no acquisition executed |
| **Commit** | `b957f65` |
| **Files changed** | 20 files, +768 −182. NEW `lib/prices/provider-unification.test.ts` (272). MODIFIED `providers/coingecko.ts` (parameterised coin id + adapter), `providers/tiingo.ts` · `providers/fixture.ts` (+capability), `registry.ts` (+`resolveProviderForInstrument`), `fetch.ts` (resolution replaces the failover walk), `types.ts` (+`ProviderRoutingKey`, `supportsInstrument`, `ProviderResolution`, `PriceFetchRequest.assetClass`), `coverage-binding.core.ts` + `.ts` (per-instrument floor), `lib/crypto/btc-price.ts` (−`backfillBtcPrices`), `regenerate-history.ts` (shared path), `jobs/fetch-security-prices.ts`, `backfill.ts`, both probes, 5 test files. |
| **Tests added** | 33 provider-unification checks; `fetch.test.ts` sections 2–4 rewritten for capability routing; `coverage-binding.core.test.ts` §3 rewritten |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · suite **400/400** · all 12 focused fixture files green · all 3 probes exit 0 |
| **Architectural decisions** | (1) `supportsInstrument` is REQUIRED, not optional — an adapter that does not state what it serves reintroduces positional guessing. (2) `resolveProviderForInstrument` resolves ONE provider by reducing capable adapters to a sorted source list and looking the winner up by source, so registry order cannot affect routing. (3) `ambiguous` is reported, never resolved by position. (4) **Cross-adapter failover removed** — the deliberate cost of order-independence. (5) `resolveProviderFloorISO` made capability-aware and per-instrument (concrete PRICE-2 contradiction, see below). (6) Valuation reads NOT generalised — `readBtcUsdWindow` stays asset-specific until PRICE-5. |
| **Acceptance passed** | BTC routes to CoinGecko and equities to Tiingo, unchanged when the registry is reversed. Removing the crypto adapter yields a stated `unsupported` naming what was considered, never a fall-through to Tiingo. A fixture second-crypto adapter routes, fetches and returns the shared `PriceResult` shape with nothing in `lib/prices` edited. Source scans (comment-stripped) prove `fetch`/`backfill`/`registry` carry no per-coin branching, the adapter never touches the archive, and no BTC acquisition function survives. Every fake adapter throws if wrongly selected, so a provider call fails the suite. |
| **PRICE-2 contradiction found and fixed** | `resolveProviderFloorISO` took the earliest `historicalDepth` across all adapters serving the basis. Harmless with one vendor; **wrong with two** — BTC would inherit Tiingo's 1990 depth, which CoinGecko cannot serve and Tiingo would never be asked for, so coverage would treat pre-2013 crypto dates as actionable and plan windows no run could fill. Now per instrument, from the provider routing will actually choose, and surfaced as `providerFloorISO` on the report envelope. |
| **Residual risks** | Failover is gone: a vendor outage now yields no rows for that window rather than trying another source. No instrument currently has two capable providers, so nothing regressed — but resilience was traded for determinism, deliberately. The CoinGecko Demo tier serves ~365 days while the adapter declares 2013-04-28 depth; tier truncation surfaces as fewer returned rows, which coverage reports as a remaining gap rather than an error. `COINGECKO_COIN_IDS` holds one entry — a second coin is a one-line edit, unexercised in production. |
| **Provider calls / credits** | none / none |
| **Production mutations** | none |
| **Next dependency** | PRICE-4 executes the planned windows — the first slice permitted to spend credits and write rows. |

### V26-PRICE-4 — Ownership-window acquisition

| | |
|---|---|
| **Objective** | Acquire only the actionable missing evidence, bounded by real ownership windows, with confidence preserved and cost knowable in advance. |
| **Status** | **committed** — code only. **NO LIVE PROVIDER RUN PERFORMED.** |
| **Commit** | `8eb4acb` |
| **Files changed** | 15 files, +1,295 −77. NEW `ownership-window.core.ts` (204) · `ownership-window.ts` (108) · `acquisition-budget.core.ts` (173) · `provider-errors.ts` (73) · `scripts/dry-run-acquisition.ts` (202) · 2 test files (395). MODIFIED `backfill.ts` · `fetch.ts` · both adapters · `backgroundHistorySync.ts` · 3 test files. |
| **Tests added** | 40 ownership-window checks · 25 budget checks · outcome-classification assertions in `fetch.test.ts` and `tiingo.test.ts` |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · suite **402/402** · all 4 probes exit 0 · **PriceObservation unchanged at 8,607 rows** |
| **Architectural decisions** | (1) Ownership is **confidence-tagged segments**, never one collapsed window — KNOWN / POSSIBLE / UNKNOWN. (2) UNKNOWN prehistory is never requested. (3) `quantity > 0` scoping **removed** — a sold position still needs its history priced. (4) Provider failures classified into 7 outcomes; adapters throw typed errors. (5) CoinGecko no longer returns `[]` on a 429 — throttling was indistinguishable from completeness. (6) EMPTY_RESPONSE (inside depth, suspicious) separated from NO_DATA (before depth, explicable). (7) Checkpoint identity from (provider, instrument, requested window, chunk), never execution order. (8) Append-only preserved: insert-only + skipDuplicates, observed evidence never overwritten. |
| **Acceptance passed** | Ownership resolution verified against real data: BTC → POSSIBLE 1,213d + KNOWN 12d; every equity → pure KNOWN (their accounts postdate first observation, so the possible bound correctly adds nothing). Budget report: **22 requests, 22 credits, ~1,254 expected observations, KNOWN 72d vs POSSIBLE 1,182d** — 94% of the spend buys inferred history, which a single window would have hidden. Checkpoint ids proven order-independent and free of ordinal position. Budget proven invariant under input order. |
| **Residual risks** | The POSSIBLE bound uses account creation / first account transaction — proof the *container* was active, not that this instrument was held. It is an upper bound on plausible ownership and is labelled as such, but a wide POSSIBLE span buys prices for history that may never have existed. Acceptable because prices are inert evidence and the label survives; it would NOT be acceptable if downstream ever treated POSSIBLE as KNOWN. Dropping `quantity > 0` widens the instrument set on every connect — bounded by coverage, but the first run after deploy will be larger than before. |
| **Local probes** | `dry-run-acquisition.ts` (new, exit 0) · `check-acquisition-plan.ts` · `check-price-coverage.ts` · `check-snapshot-integrity.ts` |
| **Provider calls / credits** | **none / none** — no live run performed |
| **Production mutations** | none |
| **Awaiting approval** | **A live provider acquisition run.** Estimate: 22 requests / 22 credits / ~1,254 new rows; worst case 66 requests. Requires explicit approval of the dry-run figures. |
| **Next dependency** | PRICE-5 regenerates snapshots from stored evidence — and needs the KNOWN/POSSIBLE split to state completeness honestly. |

### V26-PRICE-5 — Snapshot regeneration from stored evidence

| | |
|---|---|
| **Objective** | Regenerate only affected snapshots from stored evidence, and propagate completeness as three independent axes. |
| **Status** | **committed** — code only. **NO PRODUCTION REGENERATION PERFORMED.** |
| **Commit** | `02854e3` |
| **Files changed** | 6 files, +987 −4. NEW `price-completeness.core.ts` (217) · `regeneration-candidates.core.ts` (196) · `scripts/dry-run-regeneration.ts` (175) · 2 test files (368). MODIFIED `regenerate-history.ts` (+35 −4). |
| **Tests added** | 30 price-completeness checks · 28 regeneration-candidate checks |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · suite **404/404** · all 4 read-only probes exit 0 |
| **Architectural decisions** | (1) Three axes kept independent; reduced to a `CompletenessTier` only after all three exist, with per-instrument detail surviving. (2) `observed` requires ALL THREE clean — complete prices can never promote a back-projected day. (3) "Evidence changed" defined by RECOMPUTATION DIFFERENCE, not timestamps (`SpaceSnapshot` has none, and a price can arrive and change nothing). (4) Four dispositions with BLOCKED checked before the change test. (5) Only UPDATED rows are written. (6) Discontinuities reported, never smoothed. (7) `dryRun` now suppresses ACQUISITION as well as writes. |
| **Acceptance passed** | Dry run over the local DB, Chris' Space: **705 UPDATED · 27 UNCHANGED · 0 SKIPPED · 5 BLOCKED**, largest component change 3,834.04, 2 regeneration-created discontinuities reported. Four fully-observed Spaces correctly report every row BLOCKED and zero writes. Completeness disclosure prints `tier=estimated · OWNERSHIP_INFERRED, QUANTITY_BACK_PROJECTED` and states the investment-table discrepancy is NOT fixed. |
| **INCIDENT** | While developing this slice, the first dry-run execution **made live Tiingo calls and inserted 18 `PriceObservation` rows** (8,607 → 8,625). Cause: `dryRun` suppressed only snapshot upserts, while `regenerateWealthHistory` performs acquisition before valuing. The rows are legitimate closes for 2026-07-27, written append-only, and no snapshot was mutated (distribution unchanged at 946 observed / 732 estimated). Fixed by guarding both acquisition call sites on `!args.dryRun`; re-run confirmed the archive stable at 8,625. Reported rather than absorbed — it is precisely the failure the "no provider calls during valuation" rule exists to prevent. |
| **Residual risks** | Regeneration still projects present-day quantities backwards; the `BACK_PROJECTED` axis discloses it but does not fix it (QUANTITY-1). The 705 UPDATED rows would move `stocks` substantially (e.g. 7,029.93 → 3,269.15) — a large correction that needs review before it is applied, since it substitutes a differently-derived number rather than an obviously better one. Acquisition remains embedded in `regenerateWealthHistory`; the dry-run guard makes it safe but full extraction is follow-up work. |
| **Local probes** | `dry-run-regeneration.ts` (new) · `check-snapshot-integrity` · `check-price-coverage` · `check-acquisition-plan` · `dry-run-acquisition` |
| **Provider calls / credits** | **18 rows acquired unintentionally** (see INCIDENT); none since the fix |
| **Production mutations** | none |
| **Awaiting approval** | (a) a live provider acquisition run; (b) a production regeneration run. Both separate, both after this review. |
| **Next dependency** | QUANTITY-1 — until it lands, no regenerated day may be labelled observed. |

### V26-PRICE-5A — UNKNOWN ownership prehistory must not be valued

| | |
|---|---|
| **Objective** | Close the asymmetry between PRICE-4 (never ACQUIRE for UNKNOWN periods) and PRICE-5 (still VALUED them). |
| **Status** | **committed** — code only. **NO PRODUCTION REGENERATION PERFORMED.** |
| **Commit** | `d2e8cf7` |
| **Files changed** | 7 files, +549 −29. NEW `lib/snapshots/ownership-eligibility.core.ts` (137) + test (192) · `lib/investments/ownership-windows.ts` (36). MODIFIED `regenerate-history.core.ts` (+27, the OWNERSHIP_PREHISTORY guard) + its test (+39) · `regenerate-history.ts` (+60) · `regeneration-delta-attribution.ts`. |
| **Tests added** | 34 ownership-eligibility checks + 9 core-guard checks. Suite **405/405**. |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing warnings · all 5 read-only probes exit 0 · archive and snapshots provably unchanged |
| **Architectural decisions** | (1) KNOWN include · POSSIBLE include-and-disclose · UNKNOWN exclude. (2) A dedicated `OWNERSHIP_PREHISTORY` guard in the core, between the membership and no-fabrication checks — routing to no-fabrication alone was insufficient (see the bug below). (3) Frozen and membership-changed still outrank it; amendments may not bypass it. (4) Ownership reaches the binding via `lib/investments/ownership-windows.ts`, preserving the asserted "no `lib/prices` import" boundary rather than weakening the guard test. |
| **BUG FOUND BY RUNNING THE REPORT** | Routing ineligible days into the existing NO-FABRICATION guard did **not** protect them: that guard fires only when the flat estimate exceeds `WEALTH_REGEN_EPSILON`, and on days whose accounts are floored out the flat value is already 0. All 402 prehistory days were still being written as ~$0 — silently replacing stored values with a fabricated zero, precisely the outcome the doctrine forbids. Caught only because the corrected dry run was inspected rather than assumed. |
| **Measured impact (local, Chris' Space, 737 rows)** | before → after: **UPDATED 705 → 326** · **UNCHANGED 27 → 4** · **SKIPPED 0 → 402** · **BLOCKED 5 → 5**. 3,442 holding-days excluded as UNKNOWN prehistory. Largest remaining delta 7,092.13 (netWorth). Discontinuities over $1,000: **2 → 4**. Attribution: 326 `QUANTITY_LIMITED`, 0 `UNEXPLAINED`, residual `0.00` on every day. |
| **Residual risks** | The 326 surviving UPDATED days still move violently (`stocks 7,029.93 → 11.07`, −99.8%) because a single evidenced holding plus a cash position keeps the day eligible while every other holding is excluded. Arithmetically correct under the doctrine; whether such a day should be *reported at all* is an open product question. Discontinuities rose from 2 to 4 at ownership boundaries — the chart will step where evidence begins. |
| **Provider calls / credits** | none / none |
| **Production mutations** | none |
| **Awaiting approval** | (a) live acquisition — **APPROVED and EXECUTED**, see below; (b) production regeneration — not approved. |

### V26-PRICE-5B — Representativeness assessment · **committed** `9e8dcb5`

Evidence-coverage classification (`REPRESENTATIVE` / `PARTIAL` /
`NON_REPRESENTATIVE`) derived from the existing ownership and price axes. A
materiality floor was explicitly **rejected**: magnitude and representativeness
are independent, and a value threshold would make the classification move when
prices move. Independence is asserted structurally — a source scan proves the
module reads no value/price/amount field and contains no numeric threshold. Cash
positions are excluded from every ratio. Alters no arithmetic. 34 fixtures; suite
**406/406**.

### LIVE ACQUISITION RUN — executed 2026-07-30 (LOCAL database)

| | |
|---|---|
| **Authority** | Explicit approval of the 22-request / ~22-credit / worst-case-66 budget |
| **Executor** | `scripts/run-acquisition.ts --confirm` (recomputes the plan, aborts above the approved ceiling, refuses to run without `--confirm`) |
| **Scope** | **LOCAL database only.** `PriceObservation` is a global cache with no Space/user dimension; production was not touched and would need separate credentials and approval. |
| **Requests** | 22 planned, 22 issued — exactly the approved figure |
| **Outcomes** | **OK 19 · PROVIDER_ERROR 3** |
| **Rows inserted** | **141** (8,625 → 8,766) — far below the ~1,236 estimate |
| **Append-only** | **VERIFIED** — all 8,625 pre-existing rows unchanged by count and Σ price checksum |
| **Snapshots** | untouched (1,678) |
| **MATERIAL FAILURE** | The three BTC historical chunks (2023-03-24→2026-03-22) failed with **CoinGecko HTTP 401**. This is the Demo tier's ~365-day history limit, not a credential fault: the adjacent 2026-03-23→2026-06-17 chunk succeeded with 87 rows. BTC's ownership-relative gap therefore **remains 1,177 of 1,307 expected dates**. The adapter declares `historicalDepth: "2013-04-28"`, which is correct for CoinGecko's data but WRONG for this tier — so coverage classifies those dates as actionable when no run under the current key can obtain them. |
| **Taxonomy note** | A 401 is semantically `PROVIDER_LIMIT`, not `PROVIDER_ERROR`. **RESOLVED by V26-PRICE-4C below.** |

### V26-PRICE-4C — CoinGecko tier capability alignment

| | |
|---|---|
| **Objective** | Make provider capability truthful for the configured tier, so nothing classifies history as acquirable that the deployment cannot supply. |
| **Status** | **committed** |
| **Commit** | `5fffbe0` |
| **Files changed** | 3 files, +230 −10. `lib/prices/providers/coingecko.ts` (+125) · `coingecko.test.ts` (+109) · `lib/env.ts` (+6). **No planner change, no coverage change, no schema, no migration.** |
| **Semantics settled** | `historicalDepth` = **deployment capability**: "the earliest date this configured adapter instance can currently serve" — NOT the dataset start. Both consumers require it: `resolveProviderFloorISO` (which dates are actionable) and `fetch.ts:128` (was an empty response over a servable period). |
| **Floor calculation** | `max(COINGECKO_DATASET_START, utcToday − COINGECKO_HISTORY_DAYS)`, resolved at the adapter-construction edge. `defaultPriceRegistry()` builds adapters per call, so the rolling window stays current; the planner remains pure and receives the resolved ISO floor as data. |
| **Inclusive boundary** | With 365 days and utcToday `2026-07-31`: floor = **`2025-07-31`, which IS servable** (`2025-07-31 + 365d = 2026-07-31`); `2025-07-30` is not. Fixtures pin 364/365/366-day windows plus a leap-year case (`2025-03-01 − 366d = 2024-02-29`), so no off-by-one can hide. |
| **Configuration** | `COINGECKO_HISTORY_DAYS`, optional, default **365 (Demo — the most restrictive supported tier)**. A key does not imply a paid plan; a paid deployment must declare itself. Validation requires plain decimal digits — `Number()` would accept `"1e3"`/`"0x10"`. Rejects `0`, negatives, non-integers, malformed. |
| **Taxonomy** | No new vocabulary. 401/403 below the floor → `PROVIDER_LIMIT` (permanent until the tier changes, already non-retryable); within the floor → `PROVIDER_ERROR` (credentials, retryable); 429 → `THROTTLED` regardless of position. Both branches fixtured. |
| **Before / after (measured, zero provider calls)** | `BTC before: miss=1095 unreach=0 requests=3 [BEFORE_FIRST_COVERAGE]` → `BTC after: miss=235 unreach=860 requests=1 [BEFORE_PROVIDER_DEPTH, BEFORE_FIRST_COVERAGE]`. JPM and VGT unchanged (complete, 0 requests). Dry-run acquisition budget: **22 requests → 1 request / 1 credit / ~235 rows**. |
| **Validation** | tsc 0 errors · lint 0 errors / 7 pre-existing · suite **406/406** · 36 CoinGecko fixtures · coverage, coverage-binding, acquisition-planner, provider-unification, fetch fixtures all green · coverage probe CLEAN · dry-run acquisition clean |
| **Provider calls / writes** | **none / none.** `PriceObservation` stable at 8,766. `SpaceSnapshot` moved 1,678 → 1,679 — that is **today's live observed row written by the dev server running on port 3000** (`lib/snapshots/regenerate.ts`, unreachable from anything in this slice); the attribution probe's own before/after guard confirms zero writes across its run. |
| **Residual risk** | The 365-day figure is documented, not probed — evidence brackets the true limit at 130–494 days. Too generous fails safe (`PROVIDER_LIMIT`, non-retryable, gap still reported); too conservative under-acquires silently. Tiingo still declares dataset depth (`1990-01-01`) unverified against its tier — same latent defect, not observed failing, recorded for later. |

---

## 2 · Document conflicts and supersessions

`V26-INVESTIGATION-HISTORICAL-PRICE-COVERAGE.md` (§5, §18, §19) predates the
PRICE-1 decisions taken in session. Four divergences; three superseded by
explicit approval, one OPEN.

| # | Earlier document | PRICE-1 as built | Resolution |
|---|---|---|---|
| **C1** | §5/§19: "reuses `CompletenessTier`, mints no new status vocabulary"; explicit exclusion "No new status vocabulary" | dedicated `CoverageState = complete\|partial\|unavailable` | **SUPERSEDED.** Explicit decision: "Keep CompletenessTier for valuation truth, not coverage truth. Avoid overloading the meaning of observed, derived, and estimated." Re-affirmed in the arc brief. |
| **C2** | §19: `planHistoricalPriceCoverage(CoverageInput): CoverageResult`, `MissingRange {from,to,reason}`, `expectedDays`/`coveredDays` | `coverageFor(CoverageInput): CoverageReport`, `CoverageRange {fromISO,toISO,expectedDates}`, `expectedCount`/`observedCount`/… | **SUPERSEDED** by the approved PRICE-1 contract. Naming preference only; no behavioural claim differs. |
| **C3** | §19: reasons attached PER missing range (`MissingRange.reason`), taxonomy `NOT_FETCHED`, `PROVIDER_LIMIT`, `PRE_LISTING`, `PROVIDER_FAILURE`, `UNRESOLVED_IDENTITY`, `UNSUPPORTED_INSTRUMENT`, `INVALID_OBSERVATION` | reasons are REPORT-level; ranges are pure positional facts | **SUPERSEDED, and consistent with the earlier document's own §12**, which concludes that why a range is missing "is **not** derivable from absence" and "must be recorded as attempt metadata, not as coverage". `PROVIDER_LIMIT`/`PROVIDER_FAILURE` are acquisition outcomes belonging to PRICE-4. Mapping: `UNSUPPORTED_INSTRUMENT`→`NOT_PRICEABLE`, `UNRESOLVED_IDENTITY`→`NO_PROVIDER_SYMBOL`, `PRE_LISTING`/`PROVIDER_LIMIT`→`BEFORE_PROVIDER_DEPTH`, `NOT_FETCHED`→ positional codes. |
| **C4** | §19 input `observed: Array<{date, price, currency, basis}>`; algorithm step 2 rejects `price <= 0`, non-finite, **currency or basis mismatch** into `invalidDates`, which "do not count as coverage" | input `observedDates: readonly string[]` — dates only; **no invalid-observation detection** | **OPEN — see OI-1.** |

**Numbering collision (not a conflict):** the earlier §18 phase table has its own
P0–P9 in which P1 = pure planner, P2 = provider capability, P3 = orchestrator.
The active arc is P0 + PRICE-1…PRICE-5 + PROVIDER-UNIFICATION. Earlier-§18 "P2"
≠ arc "PRICE-2". Read §18 as historical sequencing analysis, not as the queue.

---

## 3 · Open items requiring a decision

**OI-1 — RESOLVED in PRICE-2 (`6697c6c`), option (b).** `coverage.core.ts` stays
dates-only; the binding filters observations by the instrument's expected quote
currency before they count as evidence, and reports `currencyMismatchCount` on
the envelope. A wrong-currency row no longer masquerades as coverage — its date
becomes missing, which is correct. Original statement retained below.

**OI-1 (original) — Invalid stored observations (Conflict C4).** PRICE-1 accepts dates only,
so it cannot report an observation that exists but is unusable. Partial mitigation
already in place: `archive.ts` `canonicalizePriceBatch` (`:47`) drops non-finite
and `price <= 0` at WRITE time, and every archive read filters on `basis`, so
basis mixing cannot occur. **Not mitigated: currency mismatch** — a row stored in
a currency other than the expected quote currency counts as coverage today and
would be silently valued. Decision needed before PRICE-2 fixes the binding's read
shape. Options: (a) keep dates-only, handle currency at valuation; (b) have the
binding pre-filter by expected currency and report the count separately;
(c) extend the planner input to carry currency per date. Note the arc brief
prefers a dates-only archive read for efficiency.

**OI-2 — Source-scanned purity guard.** `V26-INVESTIGATION-HISTORICAL-PRICE-COVERAGE.md`
§19 proposed a test asserting the planner imports nothing from `@prisma/client`,
`lib/db`, or any provider. PRICE-1 shipped a RUNTIME purity guard (no clock) but
not the import guard, because it would fail today: `coverage.core.ts` uses a
type-only `import type { PriceBasis }` (erased, harmless) but transitively reaches
`@prisma/client` at runtime through `config.ts`, which holds a VALUE import for
`PRICE_BASES` — despite `config.ts`'s own header claiming "no Prisma". Decide
whether to add a guard scoped to direct value-imports, or to accept the runtime
guard alone.

---

## 4 · Arc end-state tracking

No user-visible outcome is verified. Recorded here so completion is never inferred.

| User-visible outcome | Status | Blocked on |
|---|---|---|
| BTC valued historically across the real ownership window | not started | PRICE-4 acquisition + PRICE-5 regeneration |
| Future crypto assets use the same architecture | not started | PROVIDER-UNIFICATION |
| Flat crypto history removed | not started | PRICE-4, PRICE-5 |
| Negative / non-finite history cannot be introduced | **infrastructure committed** (P0) | deploy + verify; 92 prod rows still unrepaired |
| Historical price gaps acquired where evidence exists | not started | PRICE-3, PRICE-4 |
| YTD / MTD charts have correct price inputs | not started | PRICE-5 |
| Sync does not cause artificial jumps from newly discovered evidence | not started | PRICE-5 |
| Estimated / incomplete history disclosed | not started | PRICE-5 |
| Investment performance table receives correct historical market values | **partially blocked outside this arc** | PRICE-5 **and** QUANTITY-1 |
| Completeness propagates into snapshot and reporting layers | not started | PRICE-5, REPORTING-1 |

**Boundary, restated so it cannot be lost:** historical pricing does not solve
historical QUANTITY reconstruction. While regeneration still projects present-day
quantities backward, the investment-table discrepancy is NOT fixed by this arc —
the arc supplies the price evidence and regenerated valuations that QUANTITY-1
and REPORTING-1 require.
