# V26-QUANTITY-1H — investigation: may a back-solved opening be authoritative?

**Verdict: the premise is correct. The prohibition is not required, and it is
costing us provable history. But the framing "promote back-solved openings into
anchors" is the wrong fix — the real defect is that replay is one-directional.**

No code was written. Everything below is from the committed source and a
read-only pass over the local corpus.

---

## 1 · What the prohibition actually is

Three different things are currently conflated under one rule.

| # | Thing | Correctly prohibited? |
|---|---|---|
| a | `DERIVED` as a **stored row origin** may not anchor a replay | **Yes.** These are sync output, rewritten without an observability record, so a timeline anchored on one is not reproducible. Keep. |
| b | A value computed in-memory as `closingObserved − Σdelta` may not be used | **No.** Under a COMPLETE stream this is not an estimate; it is the unique solution of a linear equation. |
| c | Replay may only run **forward** from an anchor that precedes the first event | **No — and this is the real blocker.** It was never argued for; it is an implementation shape. |

The load-bearing line is `quantity-replay.core.ts:519`:

```ts
const p = anchorPrecedes(a, firstDate, firstDayEvents);
if (p.ok) opening = a;      // latest qualifying wins
```

`anchorPrecedes` returns false for any anchor dated after the first event, and
the only other entry point (`resume`, `:580`) also requires `dateISO > blocking
day`. **There is no path by which a later observation establishes an earlier
quantity**, however completely the interval between them is recorded.

QUANTITY-1D computes exactly the right number and then makes it unusable by
typing `origin: "DERIVED"` — a literal chosen to prevent circularity. But
circularity can only arise through **persistence**, and nothing persists it.
1C, 1D, 1F and 1G are all read-only.

## 2 · The mathematics, stated properly

The user's example (deltas only) is a special case. For a fully determined
event sequence over a covered interval, the composite map is **affine**:

```
Q_T = a·Q_0 + b        a = Π(ratios)   b = accumulated deltas, scaled
Q_0 = (Q_T − b) / a    unique iff a ≠ 0
```

So back-solving is exact for **any** determined sequence, not only delta-only
ones. `a = 0` requires a ratio of zero (a total wipeout), which is degenerate
and detectable. QUANTITY-1D's blanket `NON_FINITE_ARITHMETIC` refusal whenever
*any* ratio appears is therefore also over-broad.

"Determined" is already computed upstream: a day is `ORDERED` (timestamps) or
`COMMUTATIVE` (all deltas / all ratios), or replay stops at
`ORDER_SENSITIVE_UNRESOLVED`. By the time an interval is gap-free, its map is
determined.

**Generalisation:** an anchor anywhere inside a determined, covered interval
fixes the quantity at *every* point of that interval — in both directions.
Back-solving is not a new capability. It is backward replay.

## 3 · The boundary that must not move

Backward replay may reach `max(windowFromISO, coverage.fromISO)` and **not one
day further**. Before the coverage floor, "no events" carries no information,
and PRICE-5A's prohibition on valuing unknown prehistory stands unchanged.

It establishes quantity inside the covered interval. It does **not** establish
purchase date, cost basis, or anything in 2022–2023.

## 4 · Invariants that must change

| Invariant | Change |
|---|---|
| opening anchor must precede the first event | **Relax** — any permitted anchor inside a determined covered interval may fix it |
| `basis: "OBSERVED_ANCHOR" \| "REPLAYED"` | **Extend** with a backward-replayed value so consumers can distinguish direction |
| "no segment before the first defensible evidence" | **Restate** as "before `max(windowFrom, coverage.fromISO)`" |
| 1D `NON_FINITE_ARITHMETIC` on any ratio | **Narrow** to `Π(ratios) = 0` |
| `PERMITTED_ANCHOR_ORIGINS` rejects DERIVED | **UNCHANGED** — stored DERIVED rows stay rejected |
| back-solved value may not be persisted or re-read as an anchor | **UNCHANGED** — this is the actual anti-circularity rule |

## 5 · Tests that become invalid

- 1C `"a first BUY 3 does NOT establish quantity 3"` — remains true **only under
  UNKNOWN coverage**. Must be re-scoped; under COMPLETE with a later anchor,
  it *does* establish it.
- 1C `"no segment precedes the first defensible evidence"` — must be restated
  against the coverage floor rather than the first event.
- 1C `"a first SELL 1 does NOT establish −1 holdings"` — still true, and the
  corpus shows why: back-solving gives **+1**, not −1.
- 1G `DATE_RELATIVE_ONLY` fixture — becomes conditional on coverage.
- 1D back-solve refusal fixtures — all stay valid except the ratio one.

Nothing in 1B, 1C.1's coverage model, 1E′ or 1F is invalidated.

## 6 · Real corpus (read-only, 25 pairs)

Under a *hypothetical* COMPLETE declaration over each pair's evidence span
(the ledger is empty, so this is what-if, not measurement):

- **7 pairs** reach `ABSOLUTE_COMPLETE` with the **current forward engine** —
  interval widening alone, no back-solve needed.
- **11 further pairs** pass all ten back-solve conditions but remain
  `ABSOLUTE_WITH_GAPS`, purely because their only anchor is *later* than their
  events: NKE, TXN, JPM, NVDA, INTC, APLD, OKLO, QBTS, VST, VGT, VRT.
- **1 pair** remains `RELATIVE_ONLY` (an option contract whose sole anchor is
  DERIVED — correctly rejected).
- **4 pairs** remain `UNREPLAYABLE`: 3 unresolved transfers, 1 unattributable.
- **TQQQ** is correctly refused on its invalid split.

### The finding that settles it

Back-solved openings versus the **persisted DERIVED reconstruction rows**:

| | DERIVED (stored, used by valuation) | Back-solved (refused) | Observed closing |
|---|---|---|---|
| NKE | **−4** | **+4** | 0 |
| TXN | **−1** | **+1** | 0 |
| JPM | **−1** | **+1** | 0 |
| NVDA | **−2.0058** | **+2.0001** | 0 |
| INTC | **−5** | **+4** | 0 |

Every phantom short is the **sign-inversion** of the mathematically forced
opening. These six rows are exactly the positions that produced the
$2,363.51 of fake shorts inside the $516.43 "opening value" in
`V26-INVESTMENTS-HISTORY-SEMANTICS-FIX.md`.

So the architecture is doing something worse than being conservative: it
**refuses a claim it can prove, while persisting and valuing a claim it cannot** —
and the persisted one has the wrong sign.

Simplest case, for scale: APLD was bought (3) on 2026-06-25 and observed at 3.
Back-solve gives an opening of **0** — "you held none before you bought it".
The engine currently refuses to say that.

## 7 · Crypto

**Mathematically**, for a fully-indexed address set:

| Exact | Ambiguous |
|---|---|
| Native balance from inflows − outflows − fees | **Rebasing tokens** (stETH): balance changes with no transaction; needs the rebase index per block |
| Fees (BTC: inputs−outputs; EVM: receipt gas) | **Internal transfers**: contract-mediated ETH moves are absent from normal tx lists — trace-level indexing required, or reconstruction is simply wrong |
| Swaps (two transfers, one tx) | **Bridges**: each leg exact on its own chain; linking burn↔mint is off-chain correlation |
| Staking rewards issued as on-chain transfers | **Wrapped assets / migrations**: per-token exact; asserting WBTC *is* BTC is a product decision, not chain-derived |
| Per-address balances | **Multiple wallets / xpub**: only as complete as the derivation scan; addresses past the gap limit are invisible |
| | **LP tokens**: token balance exact; underlying amounts need pool state history |

**In this codebase the question is moot**, and for a reason worth recording:

```
Cold Wallet BTC   InvestmentEvent 0 · PositionObservation 1 · Transaction 25
```

The 25 chain movements live in **`Transaction`**, which the quantity authority
does not read. `normalizeQuantityEvents` consumes `InvestmentEvent` only. So
crypto quantity cannot be back-solved today for an ingestion reason, not a
mathematical one — and BTC's known 8.43% unexplained gap cannot be closed until
the wallet's chain history reaches the replay corpus.

## 8 · Recommendation

Do **not** implement "promote back-solved openings to anchors". Implement
**bidirectional replay within a licensed interval**, which subsumes it, avoids
inventing a second anchor concept, and leaves the anti-circularity rule exactly
where it is.

Prerequisite: 1E′ coverage rows. The entire gain is gated on `COMPLETE`, and the
ledger is empty until the next investment sync runs.
