# V26 Investigation — Final Historical Engine: Corporate Actions, Cash Replay, Crypto Replay, and the Finish Line

**Status:** Investigation only. No code written, no schema changed, no database row modified, no regeneration run, nothing committed.
**Repository:** `v2.6` @ `56f87b6`
**Evidence base:** local Postgres `fintracker` (read-only `SELECT`), the working tree, and three read-only external calls (Tiingo daily-prices, Tiingo ticker metadata, mempool.space address stats) using the app's own credentials against endpoints the app already calls.
**Continues from:** Historical Valuation Integrity · Historical Price Coverage · Historical Crypto Valuation · Quantity Arc · Pricing Arc

**Marking:** **[PROVEN]** demonstrated against real data in this session · **[EXISTS]** verified in code · **[ABSENT]** verified missing · **[PROPOSED]** · **[INFERRED]** reasoned, not demonstrated

---

## 0 · Executive findings

Six things came out of this that change the shape of the remaining work. Four of them are defects nobody had named.

**F1 — The TQQQ split ratio is not missing. We fetch it and throw it away.** **[PROVEN]**
Tiingo's `/tiingo/daily/{ticker}/prices` response — the exact HTTP call `lib/prices/providers/tiingo.ts` already makes — returns `splitFactor` and `divCash` on every row. On 2025-11-20 it returns `"splitFactor": 2.0`. The adapter reads only `date` and `close` (`tiingo.ts:40-43`). The corporate-action evidence is already inside a payload we already pay for. §1.

**F2 — Brokerage cash reconstruction is structurally incapable of being correct, and it is provably wrong on real data.** **[PROVEN]**
`routeEvents` (`reconstruction-core.ts:190-198`) routes a cash leg to the cash walk **only when `instrumentId` is null**. In the live corpus, 47 of 51 investment events carry an instrument, and **$3,480.08 of net LLC cash movement never reaches the cash walk**. The LLC cash reconstruction ran with `eventCount = 0` and asserted `openingQuantity = 3,557.72`. A replay that consumes every event's cash leg reconciles to the observed cash on **6 of 8 observation dates to the cent**, with a single constant opening of **$77.64** (the 2 deviations are one $1.50 dividend's settlement lag). §2.

**F3 — Robinhood cash is the same bug, and it already writes wrong DERIVED rows.** **[PROVEN]**
Robinhood has 4 cash-only events (the only null-instrument events in the corpus), so its cash walk *does* run — and produces four `DERIVED` `PositionObservation` rows tiered `derived`, which omit the 2026-05-21/22 option round trip worth **+$17.00**. LLC's bug is silent because its walk is empty; Robinhood's bug is *published*. One architecture fixes both. §3.

**F4 — The BTC wallet's transaction history is silently truncated, and nothing checks it.** **[PROVEN]**
On-chain, address `bc1q8kv3hyy…` has `tx_count = 28` and balance `0.24060252 BTC`. We imported **25**. `fetchAddressTxsRaw` (`btc-explorer.ts`) calls `/api/address/{addr}/txs/chain` exactly once with no `:last_seen_txid` pagination; mempool.space pages that endpoint at 25. **0.02028507 BTC (~$1,291 at the implied $63,640/BTC) of history is missing — 8.4% of the wallet — and no invariant compares Σ movements against the observed balance.** §4.

**F5 — The historical work planner cannot see investment evidence at all.** **[PROVEN]**
`resolveHistoricalWorkWindow` derives `evidenceFloorISO` from `Transaction._min.date`. The three real Plaid investment accounts have **zero `Transaction` rows** — their evidence lives in `InvestmentEvent` / `InvestmentEventCoverage`, which prove coverage back to 2025-07-31. For an investment-only account set the planner reports "no evidence floor" and plans the 30-day recent window. §11.

**F6 — The "N of M positions valued" denominator is exactly backwards.** **[PROVEN]**
`valuation.ts:562` — `if (quantity == null || quantity === 0) continue;` — **silently drops a position we know was not held** (it never becomes a component, so it leaves the denominator), while a position whose ownership we *cannot establish* is carried backward by `holdConstant`, becomes a component, and *joins* the denominator. Observed in the snapshot table: the denominator is `19` back to 2025-07-31 and drops to `10` only after the 2026-07-27 sale created explicit zeros. Known absence shrinks it; unknown presence grows it. §6.

**The single biggest architectural statement in this report:** the historical engine currently has **one replay for share quantities and no replay for cash**. Cash is treated as a security whose "quantity" happens to be dollars, walked by a routing rule that Plaid's data shape never satisfies. That asymmetry is the root of F2 and F3, and it is the smallest high-value thing left to fix.

---

## 1 · Investigation 1 — TQQQ and the Corporate Action subsystem

### 1.1 What the evidence actually is

**The event, verbatim from the database** **[PROVEN]**

```
id              cmrth642e001s5fn5wv9hak2r
type            SPLIT
date            2025-11-20
instrument      TQQQ
quantity        10
price           50.025
amount          0
ratio           NULL
source          plaid
providerType    transfer
providerSubtype split
description     PROSHARES ULTRAPRO QQQ ETF - SPLIT
```

So the "evidence a corporate action occurred" is a first-class provider fact: Plaid emitted `type=transfer / subtype=split`, which `plaid-investment-events.ts` maps to `InvestmentEventType.SPLIT`. There is no inference in *detection*. The gap is purely in *terms*: `ratio` is `NULL`.

**Why the walk stops.** `stopReasonFor` (`reconstruction-core.ts:236`) refuses `SPLIT && ratio == null` outright, before the generic `q = q − delta` branch can run. The walk therefore lands at `earliestDefensibleDate = 2025-11-20`, `openingQuantity = 20`, `reconciliation = FAILED`, `failureReason = UNSUPPORTED_CORPORATE_ACTION` — exactly what the `PositionReconstruction` row holds today.

### 1.2 Can the ratio be determined automatically? Three independent routes, all available today

**Route A — the provider's own price series.** **[PROVEN]**

```
$ GET api.tiingo.com/tiingo/daily/TQQQ/prices?startDate=2025-11-18&endDate=2025-11-21

2025-11-18  close 98.36   adjClose 48.911  divCash 0.0  splitFactor 1.0
2025-11-19  close 100.05  adjClose 49.751  divCash 0.0  splitFactor 1.0
2025-11-20  close 46.45   adjClose 46.196  divCash 0.0  splitFactor 2.0   ← the ratio, stated
2025-11-21  close 47.48   adjClose 47.220  divCash 0.0  splitFactor 1.0
```

`splitFactor` is **explicit vendor-stated evidence**, on the exact date of our event, in the exact response body we already receive. `lib/prices/providers/tiingo.ts:40-43` declares its row interface as `{ date, close }` and `:153-170` reads nothing else. This is not an inference problem. It is a **discarded-field problem**.

**Route B — the broker's stated split price against an independent close.** **[PROVEN]**
The event's `price` is `50.025`. Tiingo's independent 2025-11-19 close is `100.05`. `100.05 / 50.025 = 2.0000` exactly. A split is value-neutral by definition, so `preQty × prePrice = postQty × postPrice` gives the ratio from two numbers that came from two different companies.

**Route C — the event's own quantity as a delta.** **[PROVEN for this row, [INFERRED] as a general rule]**
The SELL of 2026-07-27 proves 20 shares were held after the split. The SPLIT row states `quantity = 10`. `20 − 10 = 10` pre-split ⇒ ratio 2.0. This agrees with A and B.

**Three independent derivations converge on 2.0.** That is a materially different epistemic situation from "we guessed."

### 1.3 Is inference acceptable, or is explicit evidence required?

This is the question that actually matters, and the answer is not "always require explicit evidence."

Route C is the dangerous one and should be treated as such. `quantity` on a corporate-action row is **not a ratified field**: `signedShareDelta()` (`quantity-event.core.ts`) deliberately returns `null` for `SPLIT`, and the V26-A4-SIGN corpus audit found exactly **one** split in the entire corpus. A single observation cannot establish whether brokers report a split as the *delta*, the *new total*, or as a paired remove/add. Treating `quantity` as a delta on the strength of n=1 is precisely the class of "right by coincidence of this wallet's data" the crypto carry investigation already caught once.

Route A is different in kind. It is a **second provider independently stating the term**, in a field whose meaning is documented and vendor-maintained across the whole universe of US listed securities. That is not inference; it is corroboration.

**Recommended rule:**

| Source of ratio | Grade | May the walk invert through it? |
|---|---|---|
| Import / manual `ratio` (user or statement stated it) | `STATED` | Yes |
| Price-vendor `splitFactor` on the event date | `CORROBORATED` | **Yes**, and record the source |
| Route B price-arithmetic (broker price ÷ independent prior close), agreeing with A | `CORROBORATED` | Yes — as a *check on* A, never alone |
| Route C event-quantity arithmetic | `INFERRED` | **No.** Compute it, record it, and use it only to *contradict* — a disagreement with A is a conflict worth surfacing |
| Nothing | `UNKNOWN` | No. Current behaviour: stop, `FAILED`. Correct. |

The one-line principle: **a corporate action may be inverted when an independent source states its terms; never when only our own arithmetic implies them.** That keeps the "refuse unsupported history" doctrine intact while unblocking every US-listed split we will ever see, because Tiingo states `splitFactor` for all of them.

### 1.4 Do other providers expose corporate actions?

| Provider | Corporate-action exposure | Cost / integration reality |
|---|---|---|
| **Tiingo** (integrated) | `splitFactor` + `divCash` **on every daily row we already fetch** **[PROVEN]**. Also `/tiingo/daily/{ticker}` metadata with `startDate`/`endDate` **[PROVEN]** | **Zero new calls, zero new cost, zero new vendor.** |
| Polygon | Dedicated `/v3/reference/splits` and `/v3/reference/dividends` with declaration/ex/record/pay dates | New vendor, paid tiers for depth **[INFERRED]** |
| Nasdaq Data Link / AlphaVantage | Corporate-action datasets exist; coverage and licensing vary sharply by plan | New vendor **[INFERRED]** |
| **Plaid** | Emits the *event* (`transfer/split`) but **not the terms** — the corpus shows `ratio = NULL` **[PROVEN]**. `relatedInstrumentId` is likewise never populated by Plaid (schema comment `:1592`) | Already integrated; will not improve |
| Broker APIs (Schwab, IBKR, Robinhood) | Where a direct API exists it generally reports the *position effect*, not the corporate-action terms — the same shape Plaid already gives us | Per-broker OAuth; large surface for one field **[INFERRED]** |
| Statement imports | A brokerage statement states the action in prose and shows before/after share counts. `importedRaw` already preserves the full original row (`schema.prisma:1600`), and the import path already accepts `ratio` + `relatedInstrumentId` | The manual-evidence escape hatch. Already modelled. |

**Conclusion: do not add a corporate-action vendor.** The one we have already answers the one question we cannot answer today, and it answers it for the entire asset class Tiingo serves. A dedicated vendor becomes worth discussing only for mergers/spin-offs (§1.6), and only after a real one occurs.

### 1.5 Recommended architecture — corporate actions as first-class historical events

**Yes, they should be first-class — but not as a new table.** They already are events (`InvestmentEventType.SPLIT | MERGER | SPIN_OFF | SYMBOL_CHANGE`). What is missing is a **terms authority**: one place that answers *"what were the terms of the action on (instrument, date), and who says so?"*

```
CorporateActionTerms  (PROPOSED — the one new concept)
  instrumentId, effectiveDate
  kind          SPLIT | REVERSE_SPLIT | MERGER | SPIN_OFF | SYMBOL_CHANGE
  ratio         Float?          -- shares out per share in
  cashPerShare  Float?          -- cash mergers
  relatedInstrumentId String?   -- acquirer / child
  grade         STATED | CORROBORATED         -- never INFERRED; INFERRED is not persisted
  source        "import" | "user" | "tiingo:splitFactor"
  evidenceRefs  Json            -- the raw vendor row, the two closes, the arithmetic
  @@unique([instrumentId, effectiveDate, kind])
```

Why a table and not a column on `InvestmentEvent`:

1. **Terms are a property of the security, not of one account's row.** Every account holding TQQQ on 2025-11-20 experienced the same 2:1. Storing it per event would write the same fact N times and let two accounts disagree about the market.
2. **It is deployment-global, exactly like `Instrument` and `PriceObservation`.** One Tiingo fetch serves every user — the same economics that made the global price archive right.
3. **A corporate action can exist with no event.** A security can split while a user holds it through a provider that never reported the action. The terms table can still license the correct quantity replay; an event column could not.
4. **It separates evidence from application.** The terms row records *what happened*; `reconstruction-core` and `quantity-replay.core` decide *whether they may invert through it*. That is the same separation `provider-capability` ↔ `coverage` ↔ `licensing` already ratifies.

**How it participates in reconstruction:**

`reconstruction-core.stopReasonFor` becomes a function of `(event, terms)` rather than `(event)`:

```
SPLIT with terms.ratio        → invert:  q_before = q_after / ratio          (branch already exists, :342)
SPLIT without terms           → stop, UNSUPPORTED_CORPORATE_ACTION           (unchanged)
MERGER, stock, terms known    → invert as a signed delta                     (corporateActionInvertible, already exists)
MERGER, cash, amount stated   → position → 0                                 (already exists)
SPIN_OFF with terms           → invert this leg; the child leg is its own walk
SYMBOL_CHANGE                 → identity, not quantity: supersededById already exists on Instrument
```

The walk's shape does not change at all. `walkInstrument` already has both the divide-by-ratio branch and the subtract-delta branch. **The only structural change is that the ratio arrives from an authority instead of from the row.**

**What else fits naturally in the same model** — this is the test of whether the model is right:

| Future action | Fits? | Why |
|---|---|---|
| Reverse split | Yes, unchanged | `ratio < 1`. Tiingo's `splitFactor` expresses it directly. |
| Stock merger | Yes | `ratio` + `relatedInstrumentId`; brokers list both legs, so no cross-instrument coupling (`corporateActionInvertible`'s existing reasoning). |
| Cash merger | Yes | `cashPerShare`; position → 0, cash leg lands in the **cash replay** (§2) — the two subsystems compose. |
| Spin-off | Yes | Parent keeps `ratio`, child is a new walk anchored at the distribution. |
| Ticker change | Yes | Identity, not quantity. `Instrument.supersededById` already exists (`schema.prisma:1445`). |
| Stock dividend / bonus issue | Yes | A split by another name; `ratio` describes it. |
| Rights issue, tender, delisting | Partly | These change *value* and *optionality*, not only share count. They need the cash replay before they mean anything. |

That table is the argument for the design: five of seven future actions need **no new concept at all**, and the two that do need the cash engine, which we should build anyway.

### 1.6 Smallest correct slice

**CA-1 — Capture what we already receive.** Extend `TiingoDailyRow` to `{ date, close, splitFactor, divCash }` and persist a `CorporateActionTerms` row whenever `splitFactor ≠ 1.0` (grade `CORROBORATED`, source `tiingo:splitFactor`). No behaviour change, no reconstruction change, no regeneration. Pure evidence accretion. **This is the whole unlock and it touches two files.**

**CA-2 — Let the walk read the authority.** `stopReasonFor` consults terms. TQQQ's walk then reaches back through 2025-11-20 to its true opening. **Requires** the residue guard to keep behaving, and **requires** a decision about what happens to the pre-split window (it becomes valuable, at 10 shares × the ~$100 unadjusted close — this is a real change to a real number and must be regenerated deliberately, not incidentally).

**CA-3 — Conflict detection.** Compute Route C independently and record a conflict when it disagrees with the stated terms. This is where the n=1 uncertainty about Plaid's quantity semantics gets *measured* instead of assumed.

**Explicit non-goals:** no corporate-action vendor; no automatic merger/spin-off inversion until one occurs in real data; no adjusted-close valuation basis (see §10, R-3).

---

## 2 · Investigation 2 — Historical brokerage cash

You asked me not to assume the current report is correct and to rebuild the evidence. I did, and the conclusion moved: **it is a real bug, but not the one described, and the mechanism is worse than the symptom.**

### 2.1 How brokerage cash is reconstructed today

There are **three** independent mechanisms, and they do not know about each other:

1. **Provider-observed cash** — Plaid returns a cash holding; `position-capture.ts` writes an `OBSERVED` `PositionObservation` against the `CUR:USD` instrument.
2. **Residual-derived cash** — `brokerage-cash.ts` computes `balance − Σ non-cash positions` and, when positive and clean, writes a `DERIVED` observation. **Only for today.** It has no historical mode.
3. **The backward walk** — `reconstruction-core.routeEvents` sends *cash-only* events (`instrumentId == null`) to the per-currency cash instrument with `delta = amount`.

Answering your specific questions:

| Question | Answer |
|---|---|
| Does replay use transactions? | **No.** Investment accounts have zero `Transaction` rows **[PROVEN]**. The banking cash walk-back (`backfill-core`) never touches them. |
| Does replay use balances? | Only as the *anchor*: `observedCurrentQuantity` = the latest observed cash. |
| Does replay use cash ledger events? | **Only events with a null `instrumentId`.** |
| Does it treat cash like securities? | **Yes — and that is the defect.** Cash is an `Instrument` (`CUR:USD`, `assetClass CASH`) walked by the same `walkInstrument` that walks NVDA, with `amount` substituted for `quantity`. |
| Do buys/sells/dividends/interest/transfers participate? | **No. None of them.** See below. |
| Does partial provider history explain it? | No. Coverage is `COMPLETE`, `paginationReconciled = true`, back to 2025-07-31 **[PROVEN]**. |

### 2.2 The mechanism — proven

Plaid attaches a `security_id` to essentially everything, including cash movements:

- **Dividends** carry the *paying security's* id (`DIVIDEND / TQQQ / quantity 0 / amount +1.71`).
- **Transfers** carry a *synthetic instrument Plaid invents for the transfer itself* — the corpus contains three, classified `assetClass = EQUITY` **[PROVEN]**:

```
cmrth646g002h5fn5e9t12hhn   "Journal to ...764"                        EQUITY
cmrth6479002l5fn534s4w362   "Journal Frm ...743"                       EQUITY
cmrth647n002p5fn5myxm6s18   "Tfr JPMORGAN CHASE BAN, CHRISTIAN HOGAN"  EQUITY
```

- **Buys and sells** carry the traded security's id.

`routeEvents` (`:191`) short-circuits on `event.instrumentId != null` and pushes `delta = event.quantity ?? 0` onto the *security* walk. **The `amount` is discarded.**

Measured across the corpus **[PROVEN]**:

```
account                 events w/ instrument AND material cash leg   Σ|amount|   Σ amount
Individual                                                       8    2,100.00       0.00
Limit Liability Company                                         36    3,664.34   3,480.08
Robinhood individual                                             2      723.00      17.00

events with instrumentId IS NULL:  Robinhood 4  ·  LLC 0  ·  Individual 0
```

**The LLC cash walk therefore consumed zero events.** Its stored reconstruction confirms it exactly:

```
PositionReconstruction  LLC / CUR:USD
  earliestDefensibleDate     2026-08-03      ← the anchor date; nothing to walk
  observedCurrentQuantity    3557.72
  openingQuantity            3557.72
  unexplainedOpeningQuantity 3557.72
  reconciliation             PARTIAL
  eventCount                 0
  derivedRows                (none — no rows, so no opening anchor either)
```

### 2.3 Is your recollection right? Yes — and the data proves it precisely

You said: *I sold stock, cash accumulated, today that cash genuinely exists.* The observations state exactly that **[PROVEN]**:

```
LLC  CUR:USD   OBSERVED / plaid
  2026-07-19    11.65
  2026-07-22    11.65
  2026-07-27  3556.22     ← nine SELLs settled this day
  2026-08-03  3557.72
```

The nine sells on 2026-07-27 sum to **$3,544.57**, and `11.65 + 3544.57 = 3556.22` **to the cent**.

### 2.4 So what is actually wrong?

**Three distinct defects, of very different severity.**

**D1 — The reconstruction asserts a false opening. [CONFIRMED, user-visible]**
`openingQuantity = 3,557.72` for LLC cash is a claim that $3,557.72 was held before history began. The account's own observation series contains `11.65` five days before the anchor, and the reconstruction never looked. `describeReconstruction` renders this as *"3557.72 shares were already held before your history begins on 2026-08-03"* — wrong number, wrong noun, wrong date.

**D2 — Robinhood publishes wrong derived cash. [CONFIRMED, reaches valuation]** — §3.

**D3 — The chart is currently *accidentally* fine, and that is the real risk. [CONFIRMED]**
Because LLC's walk produced **no derived rows**, `resolveHeldQuantity`'s `holdConstant` path carries the *earliest observation* — `11.65` — backward across all of 2025. That is roughly right. But it is right **because the reconstruction failed so completely that it published nothing**. The moment Plaid emits one null-instrument cash event for this account, the walk starts producing derived rows anchored at $3,557.72, `resolvePositionAsOf` prefers them over nothing, and the entire pre-2026-07-19 cash line jumps by ~$3,480. **We are one provider row away from a $3.5k historical error, in an account where cash is 70% of the value.**

### 2.5 Is it a bug? Verdict

**Yes. The cash reconstruction is arithmetically incapable of being correct, and its stored output is already false. It has not yet reached a chart only through the accident of producing nothing at all.**

### 2.6 The smallest correct historical cash replay engine

The proof that this works came out of the data before any code was designed **[PROVEN]**:

```
LLC — observed cash vs. cumulative Σ(event.amount), and the implied opening

date        observed    Σ amount ≤ date    implied opening
2026-07-19     11.65            -65.99             77.64
2026-07-20     11.65            -65.99             77.64
2026-07-21     11.65            -65.99             77.64
2026-07-22     11.65            -65.99             77.64
2026-07-27   3556.22           3478.58             77.64
2026-07-31   3556.22           3480.08             76.14   ← dividend booked on its event date
2026-08-01   3556.22           3480.08             76.14   ←   but posted to cash on 08-03
2026-08-03   3557.72           3480.08             77.64
```

**Six of eight observation dates imply the identical opening balance of $77.64.** A wrong model does not produce a constant. The two deviations are a single $1.50 JPM dividend dated 2026-07-31 that settled to cash on 2026-08-03 — which is not noise, it is the one real modelling subtlety (§2.7).

**Design — `CashReplay`, the mirror of `quantity-replay.core.ts`:**

```
CASH-1  A cash-effect table, in the file that already owns event semantics
        lib/investments/investment-flows-core.ts already holds an EXHAUSTIVE
        Record<InvestmentEventType, FlowCategory>. Add its twin:

            cashDelta(event) = event.amount        for every type that states one
                             = null                when amount is null (in-kind)

        The FM sign convention is already correct and already documented
        ("+ cash into account / − cash out"), and the corpus confirms it:
        SELL +1298.79, BUY -41.57, DIVIDEND +1.71, TRANSFER_OUT -50.00.
        No new sign table. No new vocabulary.

CASH-2  Route by EFFECT, not by absence of an instrument
        routeEvents currently asks "does this row lack an instrumentId?"
        It must ask "does this row state a cash effect?"  A single event
        routes to BOTH walks: its share delta to the security walk, its
        cash delta to the cash walk.  A dividend contributes 0 shares and
        +$1.71 of cash — today it contributes 0 shares and nothing else.

CASH-3  Reconcile against every observation, not just the anchor
        The walk already passes over dates for which OBSERVED cash exists.
        Compare at each one.  Agreement within tolerance ⇒ COMPLETE and a
        real opening.  Disagreement ⇒ conflicted, surfaced, never averaged.
        detectCheckpointConflicts() ALREADY DOES EXACTLY THIS for imported
        statement anchors (reconstruction-core.ts:512).  It is not used for
        provider observations.  Point it at them.

CASH-4  Publish the opening as an anchor
        The V26-A4-OPENING mechanism already exists and already refuses to
        emit before the provider floor.  A correct opening of $77.64 flows
        through it unchanged.
```

**Why this is the smallest correct engine:** it adds one pure table and one routing predicate. It creates no new persistence, no new model, no second authority. `walkInstrument`, `resolveCancels`, the ordering guarantee, the provider-floor refusal, the opening anchor, and the checkpoint reconciliation are all reused verbatim.

**What it also buys, for free:** `CASH-3` turns the cash walk into a **self-checking** engine. Unlike a share walk (where the only anchor is today), cash has frequent independent observations. A cash replay that reconciles across 8 observation dates is stronger evidence than any share replay we can currently produce.

### 2.7 Risks

- **R2a — Settlement lag.** The $1.50 dividend is dated 2026-07-31 and reaches cash on 2026-08-03. `InvestmentEvent` has both `date` and `datetime`, but no separate *cash settlement* date. **Recommendation:** do not model settlement yet. Set the reconciliation tolerance at a stated dollar amount and record every residual; if lag proves systematic, it earns a `settlementDate` later. Inventing a T+2 rule now would be exactly the kind of calendar assumption §11 warns about.
- **R2b — In-kind transfers.** An event with security units and no cash leg must contribute `null`, not `0`, and must degrade cash completeness. `investment-flows-core` already encodes this rule for external flows — reuse it, do not restate it.
- **R2c — Multi-currency.** Route by `event.currency` to the matching `CUR:{ccy}` instrument; refuse rather than convert. The `unroutableCashEvents` channel already exists.
- **R2d — Double counting with `brokerage-cash.ts`.** The residual-derived path writes `DERIVED` cash for *today*. If the replay also writes a derived row for today they will collide on the unique key `(account, instrument, date, origin, source)` only if `source` matches — it will not (`"reconstruction"` vs `"account-balance-residual"`), so **both rows would exist and `resolvePositionAsOf` would pick arbitrarily among equal-origin, equal-date rows**. This must be decided explicitly in CASH-2, not discovered afterwards.

---

## 3 · Investigation 3 — Robinhood cash

**Same underlying bug. Different visibility. One architecture fixes both.**

Robinhood is the only account in the corpus with null-instrument events — four `$0.03` SIRI cash dividends where Plaid failed to attach a security. So its cash walk **runs**, and it publishes **[PROVEN]**:

```
Robinhood  CUR:USD  DERIVED / reconstruction
  2025-08-27   471.12   completeness "incomplete"  unexplained 471.09
  2025-11-21   471.15   completeness "derived"
  2026-02-27   471.18   completeness "derived"
  2026-05-27   471.21   completeness "derived"
```

Three of those rows are tiered **`derived`** — the tier reserved for "reconstructed from your transaction history." They are wrong. The account's other two events are an option round trip on 2026-05-21/22:

```
2026-05-21  BUY   NVDA260522C00232500   1 @ 353   amount  -353.00
2026-05-21  SELL  NVDA260522C00232500   1 @ 370   amount  +370.00
                                                  net     + 17.00
```

Both carry an `instrumentId`, so **both cash legs are discarded**. True cash before 2026-05-21 was `471.21 − 17.00 = 454.21`. The engine says `471.18`. **Error: $17.00, published at `derived` confidence.**

### 3.1 Why they are the same problem, stated precisely

| | LLC | Robinhood |
|---|---|---|
| Cash-only events | 0 | 4 |
| Instrument-attached events with a cash leg | 36 (Σ $3,480.08) | 2 (Σ $17.00) |
| Walk produced derived rows? | **No** | **Yes** |
| Error in the *summary* | $3,480.08 | $17.00 |
| Error reaching a chart | $0 (fallback rescued it) | $17.00 |
| Root cause | `routeEvents` drops instrument-attached cash legs | identical |

They differ only in **how many events Plaid happened to leave unlabelled**. That is not an architectural distinction — it is provider noise. The severity ordering is the *inverse* of the visibility ordering, which is precisely why the LLC case is more dangerous: the loudest symptom is the smallest error.

**Recommendation: one engine (§2.6), no Robinhood-specific handling.** The only Robinhood-specific observation worth recording is that **option contracts are instruments whose cash legs dominate their share legs** — a 1-contract round trip moves $723 of cash and 0 net shares. Any cash model that routes by instrument-presence will always get options wrong.

---

## 4 · Investigation 4 — Historical crypto replay

### 4.0 Finding first: the current crypto history is built on a truncated ledger

Before designing anything, this must be on the record **[PROVEN]**:

```
on-chain (mempool.space/api/address/bc1q8kv3hyy…):
    tx_count            28
    confirmed balance   0.24060252 BTC

in our database (Transaction, currency = 'BTC'):
    rows                25
    Σ amount            0.22031745 BTC
    date range          2023-03-24 … 2023-09-26

    UNEXPLAINED         0.02028507 BTC   ≈ $1,291   ≈ 8.4% of the wallet
```

`fetchAddressTxsRaw` (`btc-explorer.ts`) issues **one** `GET /api/address/{addr}/txs/chain` and never follows `/txs/chain/:last_seen_txid`. mempool.space pages that endpoint at 25. The wallet's discovery cursor is `{"r":21,"c":20,"rDone":true,"cDone":true,"used":1}` — a single used address — so this is not an xpub gap; it is **unpaginated fetch**.

Two consequences:

1. **`licenseConstantQuantityCarry` evaluates against an incomplete event set.** Its module header states the licence holds because "its last quantity-changing transaction is 2023-09-26." That claim rests on a truncated ledger. It happens to survive (the missing transactions are older, since mempool returns newest-first), but the guard **cannot know that** — it is trusting a list it has no reason to believe is complete.
2. **Nothing anywhere compares Σ movements against the observed balance.** That check costs one `SUM` and would have caught this on the first sync.

There is a second, smaller defect adjacent to it: `btc-sync.ts:630` caps transaction import at `addresses.slice(0, 25)` with the comment *"history fills in across runs."* `slice(0, 25)` is deterministic — it selects the **same** 25 addresses every run. For a wallet with >25 used addresses, addresses 26+ would **never** have their transactions imported, while their balances **would** be included. The stated intent is not implemented. **[PROVEN by inspection]**

### 4.1 Layer 1 — Simple wallet (single address, BTC, native transactions, CoinGecko prices)

**What a replay engine looks like: it is ~30 lines, and every input already exists.**

```
anchor    PositionObservation (origin OBSERVED, source "wallet")   — EXISTS
deltas    Transaction.amount, currency 'BTC', signed              — EXISTS
dates     Transaction.date from block_time                         — EXISTS
prices    PriceObservation, source coingecko, 365 days             — EXISTS
walk      qty(D) = qty(anchor) − Σ amount over (D, anchor]         — the only new code
check     qty(earliest) should be ≥ 0 and Σ should equal anchor    — the only new invariant
```

**How difficult is it actually? Genuinely easy — easier than equities, for four structural reasons:**

1. **No corporate actions.** No splits, no mergers, no ratios. The entire §1 problem does not exist.
2. **Every delta is signed and unambiguous.** `normalizeBtcAddressTxs` already nets change outputs, already separates the fee as its own movement, and already emits `+` for receive and `−` for send. There is no magnitude-with-direction-in-the-type problem (the V26-A4-SIGN bug class cannot occur).
3. **The ledger is the truth, not a report of it.** A blockchain is the authoritative record. Plaid *describes* what a broker did; the chain *is* what happened.
4. **A free, exact, independent reconciliation exists.** `Σ movements == chain_stats balance` must hold identically. Nothing in the equity world offers this.

**The honest difficulty is not the replay — it is completeness of the movement set.** §4.0 is exactly that failure. So:

> **The first deliverable of a crypto replay engine is not a chart. It is the reconciliation invariant.** Build `Σ movements == observed balance`, fail loudly when it does not, and F4 is caught the moment it appears.

**One nuance worth stating:** BTC transaction dates come from `block_time`, a UTC instant. CoinGecko's series is a UTC daily close. Those already agree on timezone, which is one fewer thing to get wrong than the equity path (where broker dates are local and market closes are exchange-local).

### 4.2 Layer 2 — EVM wallets (ETH, Arbitrum, Base, Polygon…)

**Additional complexity, ranked by how much it actually hurts:**

| Complexity | Severity | Why |
|---|---|---|
| **Multiple assets per address** | **High** | A BTC address holds one asset. An EVM address holds ETH plus an unbounded set of ERC-20s. "The wallet's balance" stops being a scalar and becomes a per-token position set. Every downstream assumption that a crypto account has one `nativeBalance` breaks. |
| **Token identity** | **High** | A contract address is the only real identifier; symbols collide and are adversarial (spam tokens deliberately impersonate real ones). `Instrument` identity must key on `(chainId, contractAddress)`, not symbol — the CUSIP/ISIN doctrine applied to chains. |
| **Spam / dust airdrops** | **High** | Unsolicited worthless tokens arrive constantly. Valuing them fabricates net worth; hiding them by default hides real assets. Needs an explicit inclusion policy, and that policy is a **product** decision, not a technical one. |
| **Decimals** | Medium | Each ERC-20 declares its own `decimals` (6, 8, 18…). Wrong decimals is a 10¹²× error. Must be read from the contract, never assumed. **[Note: the DEC-0 numeric-precision audit already flagged crypto-wei as urgent.]** |
| **Gas as a separate asset** | Medium | Fees are paid in the native token, not the token transacted. Every ERC-20 transfer has an ETH cost. The BTC model (fee as its own signed movement) generalises, but the fee is in a *different* asset. |
| **Internal transactions** | Medium | Contract-initiated value transfers do not appear in the normal transaction list. Requires a trace/internal-tx endpoint. Missing them silently under-reports — the F4 failure mode, again. |
| **Provider keys** | Medium | Etherscan-family APIs are per-chain and key-gated. Unlike mempool.space, there is no keyless default. |
| **Chain diversity** | Low | Arbitrum/Base/Polygon are Etherscan-compatible; one adapter with a chain parameter covers them. |
| **Re-orgs** | Low | Use a confirmation depth; the `POSTED`/`PENDING` distinction already exists. |
| **DeFi positions** (LP, staked, lent) | **Out of scope** | These are not balances; they are claims on protocols. Deliberately excluded — see non-goals. |

**Net: Layer 2 is roughly 3–5× Layer 1**, and almost all of it is *identity and policy*, not replay. The replay math is identical.

### 4.3 Layer 3 — XPUB wallets

We already have this for BTC (`btc-address-derivation.ts`, `btc-discovery-core.ts`), which makes the difficulty concrete rather than theoretical.

- **Gap limit.** An xpub describes an infinite address sequence. You cannot enumerate it; you probe until you have seen `N` consecutive unused addresses and then declare the branch done. Ours defaults to 20 (`BTC_XPUB_GAP_LIMIT`). **The gap limit is a guess about the user's past behaviour.** A wallet that skipped 25 addresses is invisible below the limit, and no amount of correctness elsewhere recovers it.
- **Address discovery is stateful and resumable.** Our cursor is `{r, c, ur, uc, rDone, cDone, used}` persisted on `Connection.cursor`. Discovery spans runs, so *"is this wallet fully discovered?"* is a lifecycle state, not a boolean — which is why `syncStatus` is `pending` until `rDone && cDone`.
- **Change addresses (branch 1).** Sending BTC returns change to a *different* address you own. Miss the change branch and every outbound transaction looks like a total loss of the input. `normalizeBtcAddressTxs` nets across `myAddresses`, so completeness of that set is load-bearing for **correctness of amounts**, not just of balances.
- **Multiple branches / derivation paths.** BIP44 (xpub, `1…`), BIP49 (ypub, `3…`), BIP84 (zpub, `bc1q…`), BIP86 (Taproot, `bc1p…`) all derive **different addresses from the same seed**. A user who pastes the wrong descriptor gets a silent, valid-looking, empty wallet. Our sync already models this outcome honestly (`NO_USED_ADDRESSES`), which is the right shape.
- **Wallet recovery.** The general problem "reconstruct everything this seed ever controlled" means scanning every standard path × both branches × the gap limit, per chain. It is a genuinely open-ended search.
- **Why this is significantly harder than L1/L2:** in Layers 1 and 2 the *address set is given*. In Layer 3 the address set is **inferred**, and its completeness is unprovable — you can only say "no more found within the gap limit." That converts a closed arithmetic problem into an open search problem with an unfalsifiable stopping rule. **[This is also why F4 was invisible: the pipeline has a completeness story for addresses and none for transactions.]**

### 4.4 Is your proposed order correct?

**Layer 1 → Layer 2 → Layer 3 is correct as a statement of increasing difficulty. It is wrong as an implementation order, for one reason: we already shipped Layer 3 for BTC.**

The live wallet is a **zpub with completed discovery**. So the ordering that matches reality is:

```
L0   Reconciliation invariant + paginated fetch          ← fixes F4; unblocks everything
     Σ movements == observed balance, per wallet, per sync.
     Follow /txs/chain/:last_seen_txid to exhaustion.
     Advance the address cap across runs (or remove it).

L1   BTC replay over the existing single-asset model     ← the actual replay engine
     Reuses L0's now-trustworthy movement set.
     Replaces licenseConstantQuantityCarry's veto with an ANSWER:
     today the carry says "may I?"; the replay says "here is the quantity."

L2   Multi-asset position model                          ← the real prerequisite for EVM
     One crypto account → N instrument positions.
     This is the schema-shaped work, and it is independent of any chain.

L3   EVM adapter (one chain, ETH native only)            ← prove the model
L4   ERC-20 + identity + spam policy                     ← the hard, mostly-product part
L5   EVM xpub / descriptor discovery                     ← only if users ask
```

**Why L0 must come first, and why it is not a detour:** everything above it is arithmetic over a movement set. If the movement set is silently incomplete, a replay engine converts a *hidden* 8.4% error into a *confidently asserted* one. Today the constant carry accidentally protects us — it ignores the movements entirely, so it cannot be poisoned by their incompleteness. **Building the replay before the invariant would make the system measurably worse.**

**Explicit non-goals:** no DeFi/LP/staking positions; no NFTs; no cost-basis or tax lots; no exchange-account replay (an exchange is a broker — it belongs in the §2 cash/event model, not here); no L2 rollup-specific bridging semantics.

---

## 5 · Investigation 5 — Historical holdings panel

### 5.1 What already exists — more than expected

**[EXISTS]** `GET /api/spaces/[id]/investments/space-data?asOf=YYYY-MM-DD&compareTo=YYYY-MM-DD` already returns, for **any** historical date:

- per-holding rows (`ValuedHoldingRow`: symbol, name, quantity, nativePrice, nativeValue, reportingValue, `share`, `assetClass`, `sector`, `isCash`),
- the unvalued remainder with a per-position **reason string**,
- `PortfolioValuationCoverage` (valued / observed / estimated / unavailable, `coverageByCount`, `fullyObserved`),
- period flows and the change reconciliation against `compareTo`.

`assembleInvestmentsTimeMachine` composes all of it, and `getInvestmentValueForWindow` can value many dates from one read.

**So for investments and crypto, the answer to "can a chart point expose its holdings?" is: the data already exists and is already served.** What is missing is the chart→`asOf` binding.

### 5.2 What is missing

| Component | Historical composition available? | Where it lives |
|---|---|---|
| Investments (per instrument) | **Yes** | `PositionObservation` + `PriceObservation` + valuation |
| Crypto (per asset) | **Yes** (subject to §5.3) | same spine |
| **Cash (per account)** | **Derivable, not persisted, not exposed** | `reconstructDailyCashBalances` computes it **in memory** inside `backfill.ts`, aggregates to `SpaceSnapshot.cash`, and discards the per-account series |
| **Savings (per account)** | Same as cash | same |
| **Debt (per account)** | Same — `reconstructDailyLiabilityBalances` | same |
| Real assets / manual | Held flat; no history | — |

**So the honest answer to your example is: `BTC / NVDA / Cash / Debt / Savings` splits cleanly in two.** The first two are already available per-instrument. The last three exist only as Space-level totals on `SpaceSnapshot`, even though the per-account series was computed and thrown away minutes earlier.

### 5.3 The trap — two engines that will disagree

This is the most important thing in this section, and it is not obvious.

- **The chart** reads persisted `SpaceSnapshot` rows, written by regeneration with `visibilityScope: "all"`, `excludeDigitalAssetAccounts: true`, and the crypto carry licence + crypto valuation status applied.
- **The drill-down** would call `getInvestmentValueAsOf` **live**, with `visibilityScope: "detailEligible"`, **including** digital assets, and with **neither** the carry licence nor the crypto status applied — those guards exist **only** on the regeneration path **[PROVEN by grep: `licenseConstantQuantityCarry` and `crypto-valuation-status` have no callers in `lib/investments/`]**.

Worse: regeneration's honesty guards **skip** rather than write, preserving whatever is already stored. So on any skipped date the chart shows a **preserved older value** while a live drill-down shows **today's honest computation**. They are guaranteed to differ, and there is no reconciliation.

> **A holdings panel that silently disagrees with the point the user clicked is worse than no panel.** This must be designed for, not discovered.

### 5.4 Does this need new persistence?

**No — and it should not get any yet.** Two reasons:

1. Persisting a per-date holdings breakdown creates a **second financial fact store** derived from the first. The anti-`FinancialState` ruling already settled that argument: persist only what a read path must *filter or compare on*.
2. It would freeze today's answers. Every correctness fix in this report (§1, §2, §4) changes what the correct historical composition *is*. Persisted breakdowns would need migrating on every one.

**Recommendation: presentation + one contract change, no new tables.**

```
HP-1  Make the chart point carry its own asOf, and route the drill-down
      through the SAME code path that produced the point.
      The cleanest version: regeneration already computes an
      InvestmentValuationView per day.  Expose a read that RECOMPUTES that
      view with regeneration's exact arguments (visibilityScope "all",
      excludeDigitalAssetAccounts, carry licence, crypto status) and assert
      its subtotal equals the stored `stocks`.  Mismatch ⇒ show the stored
      figure and say the breakdown is unavailable.  NEVER show a breakdown
      that does not sum to the point.

HP-2  Lift the per-account cash/savings/debt series out of backfill's
      memory into the return value.  It is already computed.  Returning it
      is not new derivation.

HP-3  One composition DTO across all five components, keyed by date.
```

### 5.5 Would this be one of the strongest product features?

**Yes — and specifically because of the honesty layer, not despite it.**

Every consumer product shows a net-worth line. Almost none can answer *"why was it that number on that day?"* We already carry, per component per date: the quantity, its origin, its trust tier, the price and its as-of date, the FX rate and whether it was walked back, and a **name-free reason string for every exclusion**. A panel that says *"$46,120 on 2026-01-15 — 18 positions valued, 1 unvalued because TQQQ's history stops at a corporate action we cannot invert"* is a category of trustworthiness no aggregator offers.

That is the product. The chart is the index; the panel is the argument.

---

## 6 · Investigation 6 — The historical denominator

### 6.1 You are right, and the mechanism is exactly backwards

**Where the number comes from.** `valuePortfolioAsOf` counts `components` — every input that reached it. `valuation.ts` decides membership:

```ts
// line 512  — authority-excluded  → PUSHED to `excluded` → BECOMES a component
// line 543  — reconstruction residue → PUSHED to `excluded` → BECOMES a component
// line 562  — if (quantity == null || quantity === 0) continue;   ← SILENTLY DROPPED
```

Combined with `holdConstantBeforeEarliest: true` (which regeneration always passes), the effect is:

| Situation on date D | Reaches the denominator? | Should it? |
|---|---|---|
| Position **proven closed** (observed `0`) | **No** — dropped at :562 | Correct |
| Position **held and valued** | Yes | Correct |
| Position **held, no price** | Yes | Correct |
| **Ownership unknown**, earliest quantity carried backward | **Yes** | **No** — we do not know it was held |
| **Ownership unknown**, nothing to carry | **No** — dropped at :562 | Ambiguous |

**Confirmed in the stored data [PROVEN]:**

```
contributing / total     rows    date range
    (null)              1324    2024-07-21 … 2026-08-03    (no valuation attempted)
    8 / 19                27    2025-07-31 … 2025-08-26
   11 / 19                34    2025-08-27 … 2025-09-29
   12 / 19               268    2025-09-30 … 2026-06-24
   18 / 19                24    2026-06-25 … 2026-07-18
   19 / 19                 4    2026-07-23 … 2026-07-26
   10 / 10                 4    2026-07-28 … 2026-08-02   ← after the 2026-07-27 sale
```

The denominator drops 19 → 10 **only** because the sale wrote explicit zero observations. **Known absence shrinks the denominator; unknown presence inflates it.** Your instinct — *in 2023 I held only Bitcoin, so it should read 1 of 1* — is precisely the correct reading, and the current code cannot produce it.

### 6.2 Does the correct denominator already exist? Almost.

**[EXISTS]** `resolveOwnershipWindow` (`ownership-window.core.ts`) already produces exactly the right concept per instrument:

```
KNOWN     ownership directly evidenced on this date
POSSIBLE  the account existed and money moved — ownership may have begun
UNKNOWN   no evidence either way — never a segment; the absence of one
```

The set `{ instrument : D ∈ KNOWN ∪ POSSIBLE }` **is** the historical holdings set for date D. It is computed today, and used **only to decide which prices to buy**. It has never been offered to a display consumer.

**[ABSENT]** There is no `holdingsAsOf(D)` read that returns it, and nothing joins it to the valuation denominator.

### 6.3 Should it become a first-class historical concept? Yes — and it is the strongest primitive in this report

Proposed name: **the historical holdings set**, `H(account, D) = { instrument, quantity, ownershipConfidence }`.

It is not a new derivation. It is the *union* of three things that already exist:
1. `resolveOwnershipWindow` — when ownership is licensed,
2. `resolvePositionAsOf` / the quantity authority — what quantity is licensed,
3. the known-zero contract in `resolveHeldQuantity` — when absence is *proven*.

**Consumers, and what each gains:**

| Consumer | Today | With `H(D)` |
|---|---|---|
| **Completeness label** | `8 of 19` — denominator = "ever seen" | `8 of 8` or `8 of 11` — denominator = "held that day" |
| **Hover cards** | a total and a tier | "on this day you held N positions; here they are" |
| **Allocation charts** | today's mix only | allocation **as of** any date, with shares that sum to 1 |
| **Sector charts** | same | historical sector drift becomes expressible |
| **Attribution** | residual bundles composition change with market movement | positions entering/leaving `H` are separable from price movement — the biggest accuracy gain available to `period-attribution.core` |
| **Historical holdings list (§5, §7)** | must guess the row set | `H(D)` **is** the row set |
| **The regeneration guards** | `hasNoValuedComponents` compares two opaque counts | both counts become defined in terms of `H(D)` |
| **Price acquisition** | already uses it | unchanged — one authority, more consumers |

**Is it foundational? Yes.** The test I applied: does it *replace* existing ad-hoc logic rather than adding a layer? It does — the `:562` silent-drop, the `excluded` inflation, `hasNoValuedComponents`, `ownershipIneligible`, and every consumer's private idea of "which positions count" all collapse into one definition.

### 6.4 Smallest correct slice

```
DEN-1  holdingsAsOf(accountIds, D) → H(D), pure over already-read rows.
       No new persistence.  It is a projection of PositionObservation +
       InvestmentEvent + the ownership windows.

DEN-2  valuePortfolioAsOf takes H(D) as the denominator, and the `excluded`
       list becomes "members of H(D) we could not value" instead of
       "everything that reached us."
       ⚠ This CHANGES contributingComponentCount / totalComponentCount for
       every future regeneration.  Stored rows keep their old counts.  A
       count is not money, so this is safe — but it makes old and new rows
       incomparable, and the read authority must say so rather than plot
       them on one axis.

DEN-3  Expose H(D) as the holdings panel's row set (§5, §7).
```

**Risk DEN-a:** with correct denominators, historical coverage will look **worse**, not better — `12 of 19` becomes something like `12 of 12` on dates where 7 positions genuinely were not held, but `1 of 1` on early dates where the honest answer is "we know almost nothing." Do not let a nicer-looking ratio hide a smaller evidence base. **The tier, not the ratio, must remain the trust signal.**

---

## 7 · Investigation 7 — Historical asset drill-down

**Direct answer: for BTC and NVDA, yes, today. For Cash, Debt and Savings, only as Space-level totals.**

Taking your example literally — click 2026-01-01:

| Row | Available now? | Path |
|---|---|---|
| `BTC 0.24060252 → $21,070` | **Quantity yes; value yes if a price exists** | `PositionObservation` (carried) × CoinGecko `RAW_CLOSE`. ⚠ On 2026-01-01 a price **does** exist (archive runs 2025-08-03 → 2026-08-02). ⚠ But the drill-down path applies **neither** the carry licence **nor** the crypto valuation status (§5.3) — so it would assert a value the chart itself refuses. |
| `NVDA 2.0001 → $…` | **Yes** | reconstruction-derived quantity × Tiingo `RAW_CLOSE` |
| `Cash` | **Space total only** | `SpaceSnapshot.cash`; per-account series computed in memory and discarded |
| `Debt` | **Space total only** | `SpaceSnapshot.debt` |
| `Savings` | **Space total only** | `SpaceSnapshot.savings` |
| Brokerage cash inside investments | **Yes, but wrong** | §2 — the LLC line would be a flat carried `11.65`; the reconstruction's own claim is `3,557.72` |

**So: we have totals for three components and full composition for two.** Not "only historical totals" — the investments spine is genuinely per-instrument, all the way back.

**What must exist to make it complete:**

```
DRILL-1  H(D) as the authoritative row set                        (§6, DEN-1)
DRILL-2  Per-account cash/savings/debt series returned rather than
         discarded                                                (§5, HP-2)
DRILL-3  ONE composition read used by both the chart and the panel,
         with a sum-check against the stored point               (§5, HP-1)
DRILL-4  The crypto carry licence + crypto valuation status moved
         from the regeneration path into the VALUATION path, so both
         consumers inherit them
DRILL-5  Cash replay (§2), or the brokerage-cash row stays a flat carry
```

`DRILL-4` is worth calling out separately: it is the smallest of the five, it removes a real divergence between two engines, and it is a prerequisite for the panel telling the truth about the asset that dominates this portfolio.

---

## 8 · Investigation 8 — Cleaning the database

### 8.1 What is actually contaminated **[PROVEN]**

```
SpaceSnapshot, rows with crypto ≠ 0:

  cryptoValuationStatus   rows   crypto range          mean % of totalAssets
  supported                358   14,079 … 30,012                 63.5%
  (null, legacy)           859    2,832 … 18,516                 21.6%
  unavailable              378   15,311 … 15,516                 53.5%

  rows where crypto > 50% of totalAssets AND status = 'unavailable':   310
```

Every one of those 378 rows also carries a contaminated `total`, `totalAssets` and `netWorth` — **and those three columns have no status of their own.** `cryptoValuationStatus` authorises `crypto`; nothing authorises the aggregates that were computed from it. A consumer reading `netWorth` gets a number with no way to know a majority of it is a carried balance.

That asymmetry is the strongest argument in favour of your instinct.

### 8.2 Should `crypto = NULL` replace `crypto = 15311 / status = unavailable`?

**As a long-term ideal: yes. As a next step: no.** The reasons are specific, not conservative reflex.

**In favour of NULL:**
- `NOT NULL DEFAULT 0` genuinely cannot express "unknown," which is why the status column had to be invented. NULL expresses it natively.
- Postgres arithmetic propagates NULL: `netWorth = stocks + crypto + …` becomes NULL automatically, so the aggregates inherit the honesty **for free**, which is exactly the gap in §8.1.
- The type system stops relying on every consumer remembering to check a sibling column.

**Against, and these are load-bearing:**

1. **NULL erases evidence.** `crypto = 15311.94` is a *fact about what an old backfill did*. It is what makes the amendment system able to say "this row was wrong, here is what it said, here is what it says now." Nulling it destroys the audit trail — and the codebase's stated doctrine is append-only supersession, never destructive correction.
2. **NULL is not self-describing.** `crypto = NULL` cannot distinguish *"no crypto held"* from *"crypto held, unpriceable"* from *"never computed."* Those are three different things and `crypto-valuation-status.core` already separates them. NULL would collapse the distinction the status column was created to make — and we would end up re-adding a status column to explain the NULL.
3. **A one-way migration under an engine still changing.** §1, §2 and §4 all change what the correct historical value *is*. Nulling now, re-deriving later, and nulling again is worse than one deliberate rewrite when the engine settles.
4. **`isEstimated = false` rows are frozen observations.** Any NULL migration must provably never touch them. That invariant is currently enforced by *code paths*, not by a constraint.

**The reframe that resolves the tension:** the goal is not "make `crypto` nullable." It is **"no consumer may read a financial scalar without also reading its authorisation."** NULL is *one* way to enforce that. It is not the only one, and it is not the one that preserves evidence.

### 8.3 Recommendation — separate the horizons, as you asked

**Short-term (do these; they are cheap and they compound):**

```
DB-1  Extend the authorisation model to the AGGREGATES.
      Today `cryptoValuationStatus` authorises `crypto` alone, while
      `netWorth` / `totalAssets` / `total` silently inherit the
      contamination.  Either derive their assertability at the read
      boundary (lib/data/snapshots.ts, where cryptoAssertable is already
      resolved) or stamp it.  This is the single highest-value change in §8
      and it moves no financial number.

DB-2  ONE read boundary, no exceptions.
      `cryptoAssertable` is resolved in lib/data/snapshots.ts and honoured
      by the portfolio series and the export.  Any consumer reading
      SpaceSnapshot directly bypasses it.  Make that structurally
      impossible (a repository function, not a convention).

DB-3  A standing integrity probe.
      scripts/check-snapshot-integrity.ts already exists.  Add: rows whose
      crypto is unassertable but whose netWorth is asserted; rows whose
      stored `stocks` disagrees with a live recomputation; wallets whose
      Σ movements ≠ observed balance (§4).  Report, never repair.

DB-4  Stop the bleeding.  Every guard in regenerate-history.core.ts SKIPS,
      preserving the stored wrong value.  That was right when nothing could
      refuse the number downstream.  Now that the read boundary can, a skip
      should also be able to STAMP the row as unassertable without touching
      a scalar — which the crypto path already does (the metadata-only
      update).  Generalise that to the other guards.
```

**Long-term ideal (state it, do not schedule it):**

```
The persisted snapshot becomes a set of AUTHORISED COMPONENTS rather than
ten bare floats:

    component:  value | null
    status:     supported | unavailable | not-applicable
    basis:      how it was computed
    evidence:   what licensed it

That is not "make crypto nullable."  It is "every persisted financial
scalar carries its own licence."  netWorth then cannot be computed from an
unauthorised component, by construction, rather than by remembering to
check.
```

### 8.4 How large is the migration, and what breaks?

**[INFERRED, sized from the schema and the grep surface]**

| Work | Size |
|---|---|
| Make `crypto` (and siblings) nullable | Small migration; **large** blast radius — every `Float` becomes `Float?` in the generated client, so every consumer must handle null |
| Backfill NULL where `status = 'unavailable'` | 378 rows locally. Trivial in volume, **irreversible in evidence** unless the prior value is preserved first (which argues for a supersession row, not an UPDATE) |
| Recompute `netWorth` / `totalAssets` / `total` | Cannot be recomputed — the component is unknown. They must also become NULL, which is the point |
| Consumer fixes | Wealth hero, wealth chart, Investments series, Liquidity, Debt, AI context, CSV/JSON export, snapshot completeness, amendment system, integrity probe, brief/alerts |
| Test surface | Every fixture asserting a numeric snapshot field |

**What breaks:** every chart that plots `netWorth` gains real holes where it currently draws a confident line. **That is the correct outcome and it will look like a regression.** It must be shipped as an intentional visual change with the honesty story attached, or it will be reverted by reflex.

**Is it worth it? Eventually yes, but not on its own merits — only as part of DB-1's generalisation.** Doing the NULL migration *without* the component-authorisation model buys you a different representation of the same problem. Doing DB-1 first buys most of the benefit at a fraction of the cost, and makes the eventual NULL migration a schema formality rather than a semantic change.

---

## 9 · Investigation 9 — Historical cash vs. historical crypto

| Dimension | **Cash replay** | **Crypto replay** |
|---|---|---|
| **Source authority** | A broker's *report* of its own ledger, relayed by Plaid | The blockchain itself — the ledger, not a report |
| **Completeness provable?** | Only via `InvestmentEventCoverage` (`paginationReconciled`, `earliestReturnedDate`) — provider-attested | **Yes, arithmetically**: `Σ movements == chain balance` |
| **Sign convention** | Correct and documented (`amount` FM-signed); verified against the corpus | Correct and unambiguous (already netted, fees separated) |
| **Ambiguity** | Settlement lag; in-kind transfers; multi-currency; fee/tax attribution | Essentially none at L1 |
| **Corporate actions** | Cash mergers, rights, tenders eventually | **None ever** |
| **Independent checkpoints** | **Frequent** — 8 observed cash dates locally, and every one reconciles | **Sparse** — 2 wallet observations locally |
| **Known blocking defect** | Routing drops instrument-attached cash legs (§2) | Movement set silently truncated (§4, F4) |
| **Data needed that we lack** | **None** | **None** (after pagination) |
| **Effort** | ~1 pure table + 1 routing predicate + reconciliation | Pagination fix + invariant + ~30-line walk |
| **Blast radius** | Investments subtotal, brokerage-cash rows, Liquidity | Crypto column, net worth (53.5% of assets on affected rows) |
| **Value at stake locally** | $3,480.08 (LLC) + $17.00 (Robinhood) | $1,291 unexplained + authorises a **1.9-year** quantity history |

### Which is harder?

**Crypto's replay math is easier; crypto's *evidence completeness* is harder.**

Cash has more edge cases (settlement, in-kind, multi-currency) but its completeness is attested by a provider that reconciled its own pagination. Crypto has almost no edge cases but its completeness is **our** responsibility, and we currently get it wrong. That inversion is the whole answer to this question.

### Which has more trustworthy source data?

**Crypto, decisively — once fetched correctly.** A blockchain is authoritative, immutable and independently verifiable. A broker feed is a third party's summary of a third party's records. But *"once fetched correctly"* is doing real work: today the crypto ledger in our database is 89% complete and nothing says so, while the cash ledger is 100% complete and simply mis-routed. **Right now, cash's source data is more trustworthy in practice.**

### Which reaches correctness sooner?

**Cash.** Its correctness is provable *today*, against data already in the database — six of eight observation dates imply the identical opening (§2.6). No external call is required to demonstrate the fix works. Crypto needs the pagination fix, a re-sync, and then verification.

### Which should be built first?

**Build cash first. Build the crypto *invariant* alongside it, and the crypto *replay* second.**

1. **Cash replay (§2.6)** — highest proven error, entirely internal, self-verifying against existing observations, and it closes an active latent risk (D3: one provider row away from a $3.5k jump).
2. **Crypto L0 (§4.4)** — pagination + the reconciliation invariant. Small, urgent, and it is a *bug fix*, not a feature. It can proceed in parallel because it shares no code with cash.
3. **Crypto L1 replay** — only after L0 proves the movement set is complete.

**The ordering argument in one sentence:** cash's fix is proven correct before it is written, crypto's cannot be until its ledger is complete — so cash converts certainty into value, while crypto must first convert an unknown into certainty.

---

## 10 · Investigation 10 — Remaining architectural gaps

### 10.1 Remaining correctness bugs — history is wrong *now*

| # | Defect | Evidence | Impact | Priority |
|---|---|---|---|---|
| **C-1** | Cash legs of instrument-attached events never reach the cash walk | §2 **[PROVEN]** | LLC opening off by $3,480.08; latent $3.5k chart jump | **P0** |
| **C-2** | Robinhood publishes DERIVED cash rows missing $17.00, tiered `derived` | §3 **[PROVEN]** | Wrong number at high confidence | **P0** |
| **C-3** | BTC transaction fetch unpaginated — 3 of 28 txs missing, 0.0203 BTC (~$1,291) | §4 **[PROVEN]** | Truncated ledger; carry licence trusts it | **P0** |
| **C-4** | No `Σ movements == balance` invariant for wallets | §4 **[ABSENT]** | C-3 was invisible | **P0** |
| **C-5** | Historical work planner reads only `Transaction`; investment accounts have none | §11 **[PROVEN]** | Investment-only sets plan 30 days instead of a year | **P1** |
| **C-6** | Denominator counts unknown-ownership positions and drops known-closed ones | §6 **[PROVEN]** | Every coverage label misleading | **P1** |
| **C-7** | Crypto carry licence + crypto valuation status exist only on the regeneration path | §5.3/§7 **[PROVEN]** | Two engines, one guarded; a live drill-down asserts what the chart refuses | **P1** |
| **C-8** | `btc-sync.ts:630` `addresses.slice(0, 25)` never advances despite "fills in across runs" | §4.0 **[PROVEN]** | Wallets >25 used addresses lose history permanently | **P1** |
| **C-9** | Aggregates (`netWorth`, `totalAssets`, `total`) carry no assertability | §8.1 **[PROVEN]** | 378 rows, 53.5% mean contamination, asserted | **P1** |
| **C-10** | Reconstruction never reconciles against the account's own OBSERVED series | §2.4 D1 **[PROVEN]** | Publishes an opening its own data contradicts | **P2** |
| **C-11** | TQQQ pre-split history unreconstructable while the ratio sits in a payload we fetch | §1 **[PROVEN]** | One position's history stops at 2025-11-20 | **P2** |
| **C-12** | Wallet spot price (mempool.space) and historical price (CoinGecko) are different providers, never reconciled | §11 **[EXISTS]** | Today's crypto value and yesterday's come from different vendors | **P2** |
| **C-13** | `brokerage-cash.ts` residual-derived cash and a future replay-derived cash could both exist for the same date under different `source` values | §2.7 R2d **[INFERRED]** | `resolvePositionAsOf` would pick arbitrarily | **P2 (blocking C-1)** |

### 10.2 Missing capabilities — absent, but existing history is not wrong

| # | Capability | Notes |
|---|---|---|
| **M-1** | Corporate-action terms authority | §1.5. Unblocks C-11 and every future split |
| **M-2** | `H(D)` — the historical holdings set | §6.3. Foundational; many consumers |
| **M-3** | Per-account cash/savings/debt historical series exposed | §5, HP-2. Already computed, discarded |
| **M-4** | Crypto quantity replay | §4.4 L1 |
| **M-5** | Multi-asset crypto position model | §4.2. Prerequisite for EVM |
| **M-6** | EVM adapters | §4.4 L3–L4 |
| **M-7** | A market calendar | No trading-day authority exists anywhere. `PRICE_MAX_STALE_DAYS = 7` stands in for it |
| **M-8** | Per-instrument provider capability | §11. Tiingo's `startDate` is available per ticker; we declare a global `1990-01-01` |
| **M-9** | Plaid capability expressed in the capability model | §11. Plaid history is a hardcoded `730` |
| **M-10** | `ADJUSTED_CLOSE` acquisition | The basis exists in the enum and is deliberately unserved. Charting only — **must never enter valuation** |
| **M-11** | Cost basis / tax lots | `costBasis` exists on `PositionObservation`; nothing derives holding-period or realised gain |
| **M-12** | Settlement-date modelling for cash | §2.7 R2a. Only if residuals prove systematic |

### 10.3 Product improvements — desirable, not defects

| # | Improvement |
|---|---|
| **P-1** | Historical holdings panel bound to a chart point (§5) — **the strongest single feature available** |
| **P-2** | Historical allocation / sector charts (unlocked by M-2) |
| **P-3** | Per-position "why is this unvalued?" surfaced inline — the reason strings already exist |
| **P-4** | Attribution that separates composition change from market movement (needs M-2) |
| **P-5** | A coverage timeline: "your history is complete from X, partial from Y, absent before Z" |
| **P-6** | A corporate-action timeline on the holding detail |
| **P-7** | Wallet health: "28 on-chain transactions, 28 imported, balance reconciles" (needs C-4) |

### 10.4 Recommended order

```
WAVE 1 — stop asserting wrong numbers          C-13 → C-1 → C-2 → C-3 → C-4
         Cash replay + wallet pagination + the two invariants.
         Everything here is provable against data we already hold.

WAVE 2 — make the honesty machinery uniform    C-7 → C-9 → C-5 → C-8
         One set of guards on one valuation path; assertability on the
         aggregates; the planner sees investment evidence.

WAVE 3 — the foundational primitive            M-2 (H(D)) → C-6 → C-10
         Then the denominator, the panel row set, and the reconstruction's
         self-check all fall out of one definition.

WAVE 4 — unlock the blocked history            M-1 (CA-1, CA-2) → C-11
         Capture splitFactor; let the walk read terms.

WAVE 5 — product                               P-1 → P-2/P-4

WAVE 6 — crypto breadth                        M-4 → M-5 → M-6
```

---

## 11 · Investigation 11 — Does the provider-capability philosophy hold?

**Verdict: the philosophy is correctly *modelled* and only partially *adopted*. `lib/prices/provider-capability.core.ts` is the best-shaped module in this subsystem. It has one real consumer.**

What is genuinely right, and should not be touched:
- Capability is compared **on the declaration** (`historyDays` for ROLLING, absolute date for FIXED), never on a derived date — which is why a rolling window does not report NARROWED every day.
- Cross-kind comparison returns `incomparable` rather than inventing an ordering.
- A widening authorises **attempting**, never **asserting**; only a successful regeneration moves support.
- `planHistoricalWorkWindow` takes floors **as data** and uses `MAX` — a date is supportable only where every term reaches it.
- Only **blocking** price floors bound the plan, resolved by **asset class**, never by ticker or vendor name.

### Where it leaks

**L-1 — The planner cannot see investment evidence. [PROVEN — the most consequential leak]**

```ts
// historical-work-window.ts
const evidence = await db.transaction.aggregate({ where: { financialAccountId: { in: ids } }, _min: { date: true } });
```

The three real Plaid investment accounts have **zero `Transaction` rows** — they appear nowhere in the earliest-transaction census. Their evidence is `InvestmentEvent` + `InvestmentEventCoverage`, which prove `earliestReturnedDate = 2025-07-31`, `COMPLETE`, `paginationReconciled = true`. For an investment-only account set the planner reports *"no evidence floor — nothing deeper than the recent window exists"* and plans 30 days. **The engine has a demonstrated 12-month floor and asks for 1 month.**

**L-2 — Tiingo declares a capability it cannot prove. [PROVEN]**

```ts
const historicalDepth = opts.historicalDepth ?? "1990-01-01";   // tiingo.ts:76
capability: { kind: "FIXED", earliestSupportedISO: historicalDepth, source: "DEFAULT" }
```

That is a **global** claim standing in for a **per-instrument** fact, and the real fact is one HTTP call away:

```
GET /tiingo/daily/TQQQ  → startDate 2010-02-11    (we declare 1990-01-01)
GET /tiingo/daily/NVDA  → startDate 1999-01-22
GET /tiingo/daily/OKLO  → startDate 2021-07-08
```

This is the same class of error as declaring "CoinGecko has all of history." It does not currently cause harm, because `resolveOwnershipWindow` bounds requests by *ownership* evidence and no holding predates its Tiingo start. But the declaration is a fiction, and the philosophy you stated — *every provider defines the history it can prove* — is violated at its clearest point. **Provider capability for equities is per-instrument, and it is discoverable.**

**L-3 — Plaid has no capability declaration at all. [PROVEN]**
`730` appears as a literal in `exchangeToken.ts` and `syncTransactions.ts`. Plaid's actual reach is *demonstrated* per account via `InvestmentEventCoverage.earliestReturnedDate` — genuinely good evidence — but it is never expressed as a `CapabilityDeclaration`, never compared, and never triggers newly-available work the way `V26-CAP-1` does for prices. **There is one capability model, and half the providers are outside it.**

**L-4 — The engine still thinks in dates where it should think in capability. [EXISTS]**
- `PRICE_MAX_STALE_DAYS = 7` is a hardcoded calendar assumption standing in for a market calendar (M-7). A price miss and a market holiday are indistinguishable to every consumer.
- `recentWealthWindow()` is a fixed 30-day span, still the fallback floor inside the planner.
- `maxAvailableWealthWindow` floors on the earliest transaction — correct for cash, and the reason L-1 exists (it was designed around a table investment accounts do not populate).
- `brokerage-cash.ts`: `DEFAULT_STALE_DAYS = 4`, `DEFAULT_CASH_TOLERANCE = 1.0` — undeclared per-provider assumptions.

**L-5 — Two providers serve one asset, unreconciled. [EXISTS]**
Today's BTC value comes from **mempool.space** (`btc-explorer.fetchBtcUsdPrice`, written to `FinancialAccount.balance`); every historical BTC value comes from **CoinGecko** (`PriceObservation`). The registry's whole purpose is that exactly one provider serves an instrument — and the crypto spot path predates it and bypasses it. So the newest point on the crypto series and every prior point come from different vendors, with no capability declaration for the first.

**L-6 — The blocking price floor is read from the archive, not declared.**
`resolveBlockingPriceFloor` takes `MIN(PriceObservation.date)`. That is *demonstrated* evidence, which is the right input for planning today — the module says so explicitly, and `capabilityOverride` handles the widening case correctly. Recorded as a deliberate, sound choice, not a leak.

### Recommendations

```
PROV-1  Give the planner an evidence floor that spans EVERY evidence table.
        MIN over ( Transaction.date,
                   InvestmentEvent.date,
                   InvestmentEventCoverage.earliestReturnedDate,
                   PositionObservation.date )
        scoped to the account set.  Fixes L-1.  Small, high value, and it is
        a pure widening of an existing read.

PROV-2  Per-instrument capability for Tiingo.
        Read /tiingo/daily/{ticker} startDate on first acquisition; persist
        it as a FIXED CapabilityDeclaration scoped to (provider, instrument).
        Fixes L-2 AND gives the ownership-window planner a real ceiling on
        POSSIBLE segments.

PROV-3  Express Plaid as a capability.
        earliestReturnedDate + paginationReconciled ARE a demonstrated
        capability.  Persist them through the same CapabilityDeclaration
        pipeline so a Plaid product upgrade triggers historical work the way
        a CoinGecko tier upgrade already does.

PROV-4  Route the crypto SPOT price through the registry (fixes L-5), or
        declare mempool.space as a provider with its own capability.  One
        asset, one vendor, or an explicit statement of why not.

PROV-5  A market calendar (M-7), so staleness stops being a magic number.
        Lowest urgency, highest breadth.
```

**Does the architecture scale? Yes.** The capability model is the right shape and needs no redesign — `planHistoricalWorkWindow` already takes floors as data specifically so a new term can be added without a signature change. The work is adoption, not architecture: **three providers exist, one participates.**

---

## 12 · Investigation 12 — What "done" actually means

You asked for an honest opinion measured against a world-class engine, not against what we have built. Here it is.

### 12.1 Where the engine genuinely stands

The **honesty architecture is close to finished and is better than what commercial aggregators ship.** Refusing to assert an unpriceable day, distinguishing derived-negative residue from a real short, distinguishing a known zero from an unknown, refusing a zero subtotal nothing supports, and stamping how a row was computed — these are not common. That work is essentially done.

The **evidence architecture is roughly two-thirds finished.** Quantities have a real replay with real licensing. Prices have a real archive with a real capability model. **Cash has no replay at all, and crypto's ledger is silently incomplete.**

The **product architecture has barely started.** Almost everything the engine knows is invisible.

### 12.2 If every recommendation in this report were implemented — what remains

#### Correctness

1. **Cross-account transfer identity.** Moving $1,000 from checking to a brokerage is currently two unrelated events. Until they are one movement, "net external flow" is a guess at the boundary, and the change reconciliation's residual absorbs the error.
2. **A market calendar.** Without it, "no price on 2026-01-01" and "the market was closed on 2026-01-01" are the same fact. Every staleness rule is a magic number until this exists.
3. **Multi-currency at the position level.** FX is applied at the reporting boundary. A position quoted in a third currency inside an account denominated in a second is not fully modelled.
4. **Numeric precision.** DEC-0 already found Float where Decimal is required. Crypto at 18 decimals and share quantities at 1e-6 are both at the edge of Float. **Cash replay makes this urgent** — summing hundreds of signed dollar amounts in Float will produce cent-level drift precisely where we intend to reconcile to the cent.
5. **Time-zone semantics of a "day."** A snapshot date is UTC; broker dates are exchange-local; block times are UTC; CoinGecko closes are UTC. Mostly harmless, occasionally a whole day wrong.

#### Architecture

6. **One valuation path, not two.** Regeneration and the live time machine differ in visibility scope, digital-asset handling, and which guards apply. Every guard added to one is a divergence until it is added to the other. **This is the largest remaining structural debt** and C-7 only closes part of it.
7. **Persisted vs. recomputed must be reconcilable.** Charts read persisted rows; drill-downs recompute. There must be a first-class answer to "does the stored point still equal what the engine would compute today?" — and today, on a skipped day, it demonstrably does not.
8. **Provider capability must cover every provider** (§11) — three exist, one participates.
9. **An evidence graph, not evidence strings.** Every layer carries a `reason: string`. That is excellent for humans and useless for machines. "Why is 2026-01-01 worth $46,120?" should be answerable as a **structure** — a tree of contributions, each with its source, tier and licence.
10. **Regeneration as a first-class, resumable, observable job.** V26-STAGE-1 started this for Plaid history. It should cover all of it.

#### Product

11. **The engine's knowledge is invisible.** It computes per-position quantities, tiers, prices, FX and refusal reasons for every historical date, and the UI shows a line and a chip. §5 is the largest single value unlock in this report.
12. **Historical composition** — allocation, sector, concentration, attribution, all as-of.
13. **A coverage narrative.** "Complete from 2025-07-31, partial before, absent before 2024-07-21" is a sentence the user should never have to reverse-engineer from a chart's shape.
14. **Amendment as a user gesture.** The `SnapshotAmendment` machinery exists. Users cannot reach it.

#### Future research

15. **Multi-anchor segmented replay.** `detectCheckpointConflicts` deliberately refuses to re-anchor a walk at a conflicting checkpoint, calling it "a core rewrite the data hasn't earned." A world-class engine walks *between* anchors and treats each interval independently. **The cash replay (§2) is the first place where the data genuinely earns it** — cash has frequent independent observations, unlike shares.
16. **Confidence as a distribution, not a tier.** Five ordinal tiers cannot say "this value is within ±2%."
17. **Provider disagreement as a first-class outcome.** When two vendors state different closes, the archive records one and its source. It cannot record a dispute.
18. **Counterfactual history.** "What would my net worth have been if I had not sold on 2026-07-27?" Every input already exists.

### 12.3 Where the finish line actually is

I would call the historical engine **effectively finished** when all five of these hold:

> **1. Every persisted number can state its own licence, and no aggregate can be computed from an unlicensed component.**
> **2. Every asset class has a replay — quantity *and* cash — and every replay reconciles against at least one independent observation, with the residual reported.**
> **3. There is exactly one valuation path, and a stored point is provably equal to what that path computes today, or the difference is stated.**
> **4. Every provider — price, transaction and chain — declares what it can prove, and the engine plans only inside those declarations.**
> **5. Any point on any chart can be opened, and the answer is a structure, not a sentence.**

Measured against those five: **conditions 1 and 4 are perhaps 70% done, 2 is about 40% (quantities yes, cash no, crypto truncated), 3 is roughly 30%, and 5 is about 20% — with most of 5's inputs already computed and simply not surfaced.**

**My honest opinion on the biggest risk ahead:** it is not any bug in this report. It is that the honesty machinery is now sophisticated enough to *look* finished while resting on incomplete evidence. F4 is the exact shape of that risk — a carefully reasoned carry licence, correctly implemented, evaluating a transaction list that was silently missing 11% of its rows. The guards are excellent. **The next phase of work is not more guards; it is proving that what the guards guard is complete.**

---

## 13 · Explicit non-goals for this report

- No code, schema, migration, regeneration, or commit was produced. Nothing in the database was modified.
- No corporate-action vendor is recommended.
- No DeFi, NFT, staking, LP, cost-basis or tax-lot modelling is recommended.
- No exchange-account crypto replay — an exchange is a broker and belongs in the §2 model.
- No `ADJUSTED_CLOSE` in valuation, ever. Raw closes × actual historical quantities is the only correct pairing, and the current design is right.
- No multi-anchor segmented replay until the cash engine earns it (§12.2 item 15).
- No NULL migration ahead of the component-authorisation model (§8.3).

## 14 · Reproducing the evidence

```sql
-- F2 / §2.6  the cash replay reconciles
with ev as (select e.date, sum(e.amount) amt from "InvestmentEvent" e
            join "FinancialAccount" a on a.id=e."financialAccountId"
            where a.name='Limit Liability Company' and e.amount is not null
              and e."deletedAt" is null group by 1),
     obs as (select po.date, po.quantity from "PositionObservation" po
             join "FinancialAccount" a on a.id=po."financialAccountId"
             join "Instrument" i on i.id=po."instrumentId"
             where a.name='Limit Liability Company' and i."tickerSymbol"='CUR:USD'
               and po."deletedAt" is null)
select o.date, o.quantity,
       round((o.quantity - coalesce((select sum(amt) from ev where ev.date<=o.date),0))::numeric,2) implied_opening
from obs o order by o.date;

-- F2  cash legs that never reach the cash walk
select a.name, count(*), sum(e.amount) from "InvestmentEvent" e
  join "FinancialAccount" a on a.id=e."financialAccountId"
 where e."instrumentId" is not null and e.amount is not null and abs(e.amount)>0
 group by 1;

-- F4  the wallet ledger does not reconcile
select 0.24060252 - sum(t.amount) from "Transaction" t
  join "FinancialAccount" a on a.id=t."financialAccountId"
 where a.name='Cold Wallet BTC' and t.currency='BTC' and t."deletedAt" is null;
-- on-chain truth:  GET https://mempool.space/api/address/bc1q8kv3hyyfn9wsqm92ga0ev729zdz6qkl6pgx3ux
--                  → tx_count 28, balance 0.24060252

-- F6  the denominator
select "contributingComponentCount", "totalComponentCount", count(*), min(date), max(date)
  from "SpaceSnapshot" group by 1,2 order by 3 desc;

-- F5  investment accounts have no Transaction rows
select a.name, a.type, min(t.date) from "Transaction" t
  join "FinancialAccount" a on a.id=t."financialAccountId"
 where t."deletedAt" is null group by 1,2 order by 1;
select a.name, min(c."earliestReturnedDate") from "InvestmentEventCoverage" c
  join "FinancialAccount" a on a.id=c."financialAccountId" group by 1;

-- §8  contamination
select "cryptoValuationStatus", count(*), avg(crypto/nullif("totalAssets",0)*100)
  from "SpaceSnapshot" where crypto <> 0 group by 1;
```

```bash
# F1  the split ratio we already fetch
curl -H "Authorization: Token $TIINGO_API_KEY" \
  "https://api.tiingo.com/tiingo/daily/TQQQ/prices?startDate=2025-11-18&endDate=2025-11-21&format=json"
#   → 2025-11-20  "splitFactor": 2.0

# L-2  per-instrument capability we do not read
curl -H "Authorization: Token $TIINGO_API_KEY" "https://api.tiingo.com/tiingo/daily/TQQQ"
#   → "startDate": "2010-02-11"     (we declare 1990-01-01)
```
