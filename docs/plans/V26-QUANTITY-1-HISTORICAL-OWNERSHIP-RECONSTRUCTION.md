# V26-QUANTITY-1 — Historical Ownership and Quantity Reconstruction

**Phase 1 — Investigation.** Read-only. No code, no schema, no migration, no data mutation.

**Continues from:** the completed PRICE arc (P0 · PRICE-1 · PRICE-2 · PRICE-3 ·
PROVIDER-UNIFICATION · PRICE-4 · PRICE-5/5A/5B · PRICE-4C `5fffbe0`).

Marking: **[EXISTS]** verified in code/data · **[ABSENT]** verified missing ·
**[INFERRED]** · **[PROPOSED]**

---

## 0 · Executive finding

**The quantity architecture is far more complete than the pricing architecture was
— and it is not being used.** The canonical event vocabulary, the reconstruction
provenance fields, and a reconciliation table all already exist. What is missing
is a *replay*: nothing computes quantity from events. Historical quantity is
resolved by **nearest-observation lookup**, and where no observation covers a
date, a single flag projects the earliest quantity backwards.

That flag has a second, undocumented effect that no prior investigation recorded:

> **`holdConstantBeforeEarliest` also resurrects CLOSED positions FORWARD.**

Proven against live local data: TSLA was sold on 2026-07-27 (a `SELL` event and
two `quantity = 0` observations), yet the flag the regeneration binding actually
passes values it at **quantity 1, $298.32, on 2026-07-29**. Thirteen
(account, instrument) pairs are currently in this state.

This is a larger and more concrete defect than "present-day quantities projected
backward", and it is the single highest-value thing QUANTITY-1 can fix.

---

## 1 · Quantity evidence inventory (Part 1)

| Source | What it proves | What it cannot prove | Can change quantity | Replay-safe |
|---|---|---|---|---|
| `PositionObservation` **[EXISTS]** | the holding *at* a date, per (account, instrument) | anything between observations; why it changed | no — it *states* a level | **anchor only** |
| `InvestmentEvent` **[EXISTS]** | a quantity-affecting movement | completeness; nothing guarantees inception coverage | **yes** — signed `quantity` | yes, if complete |
| `Transaction` (crypto accounts) **[EXISTS]** | wallet inflow/outflow | see §6 — no units column, units smuggled in `amount` | yes, indirectly | partially |
| `Transaction` (cash/card) | cash movement | securities units | no | n/a |
| `FinancialAccount.nativeBalance` **[EXISTS]** | **current** crypto units only | any historical level | no | no — a present-tense fact |
| `PositionReconstruction` **[EXISTS]** | opening quantity, unexplained residue, reconciliation | — | no | diagnostic |
| `PriceObservation` | price | quantity | no | n/a |
| `SpaceSnapshot` | a computed total | its own inputs | no | no |

### Schema facts confirmed

`PositionObservation` carries `origin` (`OBSERVED | IMPORTED | DERIVED |
USER_ASSERTED`), `source`, `completeness`, `unexplainedQuantity`,
`reconstructionVersion`, `evidenceRefs`, `supersededById`, `deletedAt`, and
`@@unique([financialAccountId, instrumentId, date, origin, source])`. **Day
precision** (`@db.Date`).

`InvestmentEvent` carries a signed `quantity`, `date` (`@db.Date`), an optional
`datetime`, `externalEventId` with `@@unique([source, externalEventId])`,
`providerType`/`providerSubtype` verbatim, `relatedInstrumentId`, `ratio`,
`supersededById`, `deletedAt`, and `mapperVersion`.

**`InvestmentEventType` already contains the canonical vocabulary** — `BUY`,
`SELL`, `TRANSFER_IN`, `TRANSFER_OUT`, `SPLIT`, `MERGER`, `SPIN_OFF`,
`SYMBOL_CHANGE`, `REINVESTMENT`, `OPENING_BALANCE`, `CANCEL`, `ADJUSTMENT`, and
more (21 members). **Part 4's event-vocabulary design work is largely already
done.** [EXISTS]

---

## 2 · The current algorithm (Part 2)

```
regenerate-history.ts:397   getInvestmentValueForWindow({ holdConstantBeforeEarliest: true })
   └─ valuation.ts:343      valuePositionRowsOverDates
        └─ reconstruction-read.ts:148  resolvePositionAsOf(rows, asOf)
              └─ nearestOnOrBefore  ← latest PositionObservation ≤ asOf,
                                       origin precedence OBSERVED > IMPORTED > DERIVED > USER_ASSERTED
        └─ valuation.ts:426  CONSTANT-QUANTITY FALLBACK
```

**Answers to the Part 2 questions, from code:**

- **Where is quantity selected?** `resolvePositionAsOf` — nearest observation ≤ date.
- **Are buys and sells replayed?** **No.** [ABSENT] `InvestmentEvent` is *never*
  read on the valuation path. It is used only to bound acquisition windows
  (`ownership-window.ts`) and by A4 reconstruction.
- **Are provider snapshots authoritative?** Yes — `OBSERVED` outranks everything.
- **Are current quantities projected backward?** **Yes**, via the fallback below.
- **Are quantities interpolated?** No. Step function, last-known-value.
- **How are sold positions represented?** A `quantity = 0` observation — which the
  fallback then discards (§2.1).
- **Re-entry / transfers / multi-account?** No special handling; aggregation is a
  plain sum over (account, instrument) components.

### 2.1 The defect — `valuation.ts:426` [EXISTS]

```ts
if ((quantity == null || quantity === 0) && holdConstant && rows.length > 0) {
  const earliest = rows.reduce((min, r) => (r.date < min.date ? r : min), rows[0]);
  if (earliest.quantity > 0) { quantity = earliest.quantity; quantityTier = "estimated"; … }
}
```

The `|| quantity === 0` clause conflates two different facts:

- **no covering row** → "we don't know" → projecting backwards is a labelled estimate
- **an explicit `quantity = 0`** → "we know it was sold" → projecting is **fabrication**

The very next comment reads *"Not held at asOf (no covering row, or an explicit
closed-zero) → excluded"* — but the fallback fires first, so that exclusion is
unreachable whenever `holdConstant` is set. And `holdConstant` is exactly what
`regenerate-history.ts:397` passes.

**Empirical proof (live local data, read-only):**

```
TSLA observations:  2026-07-19 qty=1 OBSERVED plaid
                    2026-07-22 qty=1 OBSERVED plaid
                    2026-07-27 qty=0 OBSERVED plaid   ← sold
                    2026-07-31 qty=0 OBSERVED plaid
TSLA events:        2026-07-27 SELL qty=1

holdConstantBeforeEarliest=true  → TSLA on 2026-07-29: qty=1 value=298.32
holdConstantBeforeEarliest=false → TSLA on 2026-07-29: EXCLUDED (not held)
```

**13 (account, instrument) pairs** currently have a latest observation of
`quantity = 0` and are therefore resurrected on every historical day after their
sale. [EXISTS]

PRICE-5A's ownership guard does **not** catch this: ownership is `KNOWN` after the
first observation, so the resurrected position is *eligible*. The two defects are
orthogonal — 5A fixed the backward projection into prehistory; the forward
resurrection is untouched.

---

## 3 · Local data audit (Part 3)

**Real vs seeded, partitioned:** real data is **Chris' Space only** (Plaid
institutions `ins_11`, `ins_54`). The `demo_ins_*` accounts across Jane's Space,
John's Space and Investment Club have **zero** `PositionObservation` and **zero**
`InvestmentEvent` rows — they are balance-only seeds and are excluded from every
figure below.

**Corpus:** 159 observations · **50 investment events** · 24 (account, instrument)
pairs.

Events by type: `DIVIDEND` 24 (20 with quantity) · `BUY` 12 · `SELL` 10 ·
`TRANSFER_IN` 2 · `SPLIT` 1 · `TRANSFER_OUT` 1.

| Account | Instrument | first obs | first event | obs | qty-events | current qty | reconstructible from inception? |
|---|---|---|---|---|---|---|---|
| Individual | VGT, APLD, OKLO, QBTS, VRT, VST | 2026-06-25 | 2026-06-25 | 7 each | 1 each | >0 | event coincides with first obs — **no pre-history** |
| Limit Liability | JPM | 2025-07-31 | 2025-07-31 | 11 | 1 | **0** | closed; 5 events |
| Limit Liability | NVDA | 2025-10-02 | 2025-10-02 | 11 | 5 | **0** | closed; best-evidenced instrument |
| Limit Liability | TQQQ | 2025-11-20 | **2025-09-30** | 11 | 2 | **0** | **event precedes first observation by 51 days** |
| Limit Liability | TSLA, AMZN, SPCE | 2026-07-19 | 2026-07-27 | 7 | 1 | **0** | **observations precede events** |
| Limit Liability | CUR:USD | 2026-07-19 | — | 6 | 0 | 3556.22 | cash instrument, no events |
| Robinhood | SIRI, TTWO | 2026-07-19 | — | 6 | 0 | >0 | **no events at all** |
| Cold Wallet | BTC | 2026-07-19 | — | 1 | 0 | 0.2406 | **1 observation, 0 events** |

**Concrete instances of every pattern requested:**

- **Present-day quantity projected backward** — every instrument, on every date
  before its first observation, whenever `holdConstant` is set.
- **Instrument appearing before ownership** — TSLA/AMZN/VGT valued in 2024–2025
  (measured in the delta-attribution report; now excluded by PRICE-5A).
- **Full exit** — 13 pairs with a terminal `quantity = 0`.
- **Sold position still historically present** — TSLA on 2026-07-29 (§2.1).
- **Missing transaction history** — SIRI, TTWO, CUR:USD, BTC: observations with
  zero events.
- **Observation preceding events** — TSLA, AMZN, SPCE (obs 2026-07-19, first
  event 2026-07-27).
- **Event preceding observation** — TQQQ (event 2025-09-30, obs 2025-11-20).
- **Re-entry** — **[ABSENT]** none found in local data.
- **Split** — one `SPLIT` event exists. **[EXISTS]**, un-replayed.

---

## 4 · Temporal precision (Part 5)

`InvestmentEvent.date` and `PositionObservation.date` are both `@db.Date` — **day
precision** [EXISTS]. `InvestmentEvent.datetime` exists but is optional.

Deterministic same-day ordering is therefore **not derivable from `date` alone**.
Available tie-breakers, in order of strength: `datetime` when present →
`externalEventId` (unique per source) → `type` rank → `id`. A `PROPOSED` policy
must be evidence-driven, and the corporate-action-first ordering suggested in the
brief is **not yet justified by local data** (one `SPLIT`, no same-day
collisions observed). Recommend deferring the full policy to QUANTITY-1B and
encoding only what the data demands, with explicit uncertainty preserved.

---

## 5 · Ownership states (Part 9)

PRICE-4/5A's `KNOWN` / `POSSIBLE` / `UNKNOWN` model stands and must not regress.
Quantity reconstruction refines it:

- **fully reconciled replay** → can promote `POSSIBLE` → `KNOWN`
- **replay with unexplained residue** → stays `POSSIBLE`, residue disclosed
- **before all evidence** → remains `UNKNOWN`, **never valued** (PRICE-5A doctrine)

**The 5A doctrine is the constraint most at risk during QUANTITY-1**: an event
replay that opens a position at its first *event* rather than its first
*evidence* would silently reintroduce prehistory valuation. Every replay fixture
must assert it.

---

## 6 · BTC (Part 12)

**Correcting my own earlier assumption in this investigation:** I first read
`Transaction.amount` on crypto accounts as fiat. It is **BTC units** — the
first row is `0.00530354` "Bitcoin received". There is **no** `quantity`,
`units`, `txid`, or `hash` column on `Transaction` [ABSENT]; units are carried in
`amount`, classified `category=Income`, `flowType=INCOME`.

**Reconstruction test (read-only), Cold Wallet BTC:**

```
transactions: 25  (25 inflows, 0 outflows)
span:         2023-03-24 → 2023-09-26
Σ amounts:    0.22031745 BTC
nativeBalance 0.24060252 BTC   ← observed today
unexplained:  0.02028507 BTC   (8.43% of balance)
```

**Answer: BTC cannot be reconstructed exactly.** It reconstructs to within
**8.43%**, with a well-defined residue. The gap is structural: transactions stop
2023-09-26 while the balance reflects later activity, and there are **zero
outflows** recorded — an implausible three-year history for a live wallet, so the
explorer import is a *partial* window, not a complete ledger.

What a future Solana/Ethereum adapter must supply for source-independence: signed
native-unit deltas, a stable per-transaction external id, confirmed-vs-pending
state, an effective timestamp, and an explicit statement of *window completeness*
(from-inception vs partial). None of that requires implementing those chains now.

---

## 7 · Persistence (Part 13)

**Recommend A + B: persist canonical events, materialise compressed segments.**

Daily rows are the wrong canonical artifact — 1,225 BTC dates alone, and every
downstream query is *as-of*, which interval segments answer exactly. `D` (sealed
hashed artifacts) is premature: the earlier Financial Truth decision was
**identity first, content hash only over immutable evidence**, and quantity
history is neither immutable nor reconciled yet.

Note `PositionObservation` with `origin: DERIVED` is **already** a materialised
reconstruction channel, and DERIVED rows already exist in local data. A new table
may not be needed at all — that is QUANTITY-1H's question, not this slice's.

---

## 8 · Proposed slice sequence (Part 18)

The brief's sequence is broadly right, with **one reordering justified by the
evidence**: the resurrection defect (§2.1) is a live correctness bug reachable
today, needs no new architecture, and is a ~5-line pure change. It should come
**first**, not after the whole replay engine.

| Slice | Objective | Schema | Stop |
|---|---|---|---|
| **1A** | Fix the closed-position resurrection; separate "unknown" from "known-zero" | none | ✓ |
| 1B | Pure normalized event contract over existing rows | none | ✓ |
| 1C | Pure replay core → interval segments | none | ✓ |
| 1D | Observation-anchor reconciliation + residue | none | ✓ |
| 1E | Ownership-state integration (POSSIBLE→KNOWN promotion) | none | ✓ |
| 1F | Provider bindings (Plaid investment events) | none | ✓ |
| 1G | BTC reconstruction with explicit 8.43% residue | possibly | ✓ |
| 1H | Materialisation strategy | likely | ✓ |
| 1I | Snapshot regeneration from quantity truth | none | ✓ |
| REPORTING-1 | Surface reconciliation and disclosure | — | ✓ |

---

## 9 · First implementation ticket (Part 19)

> ### QUANTITY-1A — Stop resurrecting closed positions
>
> **Problem.** `valuation.ts:426` treats an explicit `quantity = 0` identically to
> "no covering row", so `holdConstantBeforeEarliest` — which
> `regenerate-history.ts:397` always passes — resurrects sold positions at their
> earliest quantity. TSLA, sold 2026-07-27, is valued at qty 1 / $298.32 on
> 2026-07-29. Thirteen pairs are affected.
>
> **Files**
> - `lib/investments/valuation.ts` — split the two conditions
> - `lib/investments/reconstruction-read.ts` — distinguish `null` (uncovered) from
>   `0` (known-closed) in `PositionAsOf` if the type does not already permit it
> - `lib/investments/valuation-core.test.ts` (or a new focused fixture file)
>
> **Algorithm.** Hold constant **only** when no row covers the date. An explicit
> `quantity = 0` is *evidence of closure* and must exclude the holding — the
> behaviour the existing comment already claims.
>
> **Fixtures.** Sold-then-later-date → excluded · uncovered-early-date → still
> held constant (unchanged) · re-entry after closure → held again · zero opening
> observation → not resurrected · determinism · byte-identical output for
> unaffected instruments.
>
> **Exclusions.** No event replay. No schema. No new persistence. No regeneration
> run. No reporting change.
>
> **Completion.** TSLA on 2026-07-29 is excluded with `holdConstant: true`;
> all 406 existing tests stay green; a fresh regeneration dry run shows the
> expected reduction in resurrected holdings.

---

## 10 · Risks

1. **The fix will move numbers again.** Removing 13 resurrected positions changes
   historical totals a second time. That argues for doing it *before* any
   production regeneration, not after.
2. **Events are too sparse to replay from inception today** — 50 events over 24
   pairs, several with observations preceding any event. Replay will produce
   `POSSIBLE`, not `KNOWN`, for most instruments. QUANTITY-1 will improve honesty
   more than it improves completeness.
3. **The 5A doctrine is at risk** from a naive replay opening positions at first
   *event* rather than first *evidence*.
4. **Day precision** means same-day ordering is unresolvable for events lacking
   `datetime`; that uncertainty must be preserved, not guessed.
